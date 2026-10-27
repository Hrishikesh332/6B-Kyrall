import asyncio
import os
import pytest
import claude_agent_sdk
from claude_agent_sdk import AssistantMessage, ResultMessage, SystemMessage, TextBlock, ToolUseBlock, UserMessage
from app.claude_code import MAX_STEERS, PREFIX, STEER, available_models, claude_env, count_usage, run_claude
from app.config import Settings
from app.main import create_app
from app.models import ClarificationAnswer
from app.provider import ProviderError


class FakeClaude:
    """Plays scripted turns, calling the real 6B tool handlers like the CLI would."""
    def __init__(self, scripts, tools):
        self.scripts, self.tools = iter(scripts), tools
        self.queue = asyncio.Queue(); self.prompts = []; self.interrupted = self.closed = False
        self.options = None; self.jobs = []; self.results = []

    async def connect(self):
        await self.queue.put(SystemMessage(subtype='init', data={'model':'claude-test','session_id':'session_test'}))

    async def query(self, prompt):
        self.prompts.append(prompt)
        self.jobs.append(asyncio.create_task(self.play(next(self.scripts))))

    async def play(self, script):
        for kind, *rest in script:
            if kind == 'tool':
                name, args = rest
                await self.queue.put(AssistantMessage(content=[ToolUseBlock(id='use_'+name, name=PREFIX+name, input=args)], model='claude-test', usage={'input_tokens':10,'output_tokens':5}))
                result = await self.tools[name].handler(args)
                self.results.append((name, result))
                await self.queue.put(UserMessage(content=[{'type':'tool_result','tool_use_id':'use_'+name,'content':result['content']}]))
            elif kind == 'native':
                await self.queue.put(AssistantMessage(content=[ToolUseBlock(id='use_bash', name=rest[0], input={})], model='claude-test'))
            elif kind == 'stall':
                self.stalled = True  # Reasons silently until interrupted, like a runaway response.
            elif kind == 'final':
                await self.queue.put(AssistantMessage(content=[TextBlock(text=rest[0])], model='claude-test'))
                await self.queue.put(ResultMessage(subtype='success', duration_ms=1, duration_api_ms=1, is_error=False,
                                                   num_turns=1, session_id='session_test', result=rest[0]))

    async def receive_messages(self):
        while True: yield await self.queue.get()

    async def interrupt(self):
        self.interrupted = True
        if getattr(self, 'stalled', False):
            self.stalled = False
            await self.queue.put(ResultMessage(subtype='error_during_execution', duration_ms=1, duration_api_ms=1,
                                               is_error=True, num_turns=1, session_id='session_test'))

    async def disconnect(self):
        self.closed = True
        for job in self.jobs: job.cancel()


@pytest.fixture
def claude(app, monkeypatch):
    app.state.settings.provider = 'claude'
    captured = {}
    real = claude_agent_sdk.create_sdk_mcp_server
    def capture(name, version='1.0.0', tools=None):
        captured.update({t.name:t for t in tools})
        return real(name, version, tools)
    monkeypatch.setattr(claude_agent_sdk, 'create_sdk_mcp_server', capture)
    monkeypatch.setattr('app.claude_code.find_claude', lambda configured='': '/usr/bin/true')
    def make(*scripts):
        clients = []
        def factory(options):
            client = FakeClaude(scripts, captured); client.options = options
            clients.append(client); return client
        return factory, clients
    return make


@pytest.mark.asyncio
async def test_claude_questions_resume_from_application_state(app, task, claude):
    engine, db = app.state.engine, app.state.db
    q = {'title':'Mounting','questions':[{'id':'mounting','question':'How to mount?','options':['Two screws','Adhesive'],'default':'Two screws'}]}
    factory, clients = claude([('tool','ask_questions',q)])
    run = db.claim(); await run_claude(engine, run, factory)
    waiting = db.detail(task); assert waiting['status'] == 'awaiting_input'
    assert clients[0].interrupted and clients[0].closed
    options = clients[0].options
    # Only 6B tools: no built-ins, user settings, plugins or outside MCP servers.
    assert options.tools == [] and options.setting_sources == [] and options.strict_mcp_config
    assert options.permission_mode == 'dontAsk' and list(options.mcp_servers) == ['6b']
    assert options.allowed_tools and all(t.startswith(PREFIX) for t in options.allowed_tools)
    assert PREFIX+'inspect_image' in options.allowed_tools
    assert options.max_buffer_size >= 8*1024*1024  # inline review renders exceed the 1 MB default
    db.answer(task, waiting['questionnaires'][0]['id'], ClarificationAnswer(answers={'mounting':'Two screws'}))
    factory, clients = claude([('tool','write_document',{'name':'notes.md','content':'Two screws'}),('final','Notes saved')])
    resumed = db.claim(); assert resumed['id'] == run['id']
    await run_claude(engine, resumed, factory)
    detail = db.detail(task)
    assert detail['status'] == 'completed'
    assert [a['name'] for a in detail['artifacts']] == ['notes.md']
    assert 'answered_questions' in clients[0].prompts[0] and 'Two screws' in clients[0].prompts[0]
    assert '18 mm in diameter' not in options.system_prompt
    assert any(e['type'] == 'provider.connected' and e['payload']['provider'] == 'claude' for e in db.all('SELECT type,payload FROM events WHERE task_id=?',(task,)))


@pytest.mark.asyncio
async def test_claude_completion_repairs_unfinished_plan(app, task, claude):
    plan = [{'id':'design','title':'Create design','status':'in_progress'}]
    factory, clients = claude([('tool','update_plan',{'steps':plan}),('final','Premature')],
                              [('tool','update_plan',{'steps':[{**plan[0],'status':'completed'}]}),('final','Actually complete')])
    await run_claude(app.state.engine, app.state.db.claim(), factory)
    detail = app.state.db.detail(task)
    assert detail['status'] == 'completed'
    assert [x['content'] for x in detail['messages'] if x['role'] == 'assistant'] == ['Actually complete']
    assert len(clients[0].prompts) == 2 and 'blocked completion' in clients[0].prompts[1]


@pytest.mark.asyncio
async def test_claude_long_silent_reasoning_is_interrupted_and_steered(app, task, claude):
    app.state.settings.claude_stall_seconds = 1
    factory, clients = claude([('stall',)], [('tool','write_document',{'name':'notes.md','content':'First version'}),('final','Notes saved')])
    await run_claude(app.state.engine, app.state.db.claim(), factory)
    detail = app.state.db.detail(task)
    assert detail['status'] == 'completed' and clients[0].interrupted
    assert clients[0].prompts[1] == STEER
    titles = [e['payload'].get('title') for e in app.state.db.all("SELECT payload FROM events WHERE task_id=? AND type='activity'",(task,))]
    assert 'Long reasoning interrupted' in titles


@pytest.mark.asyncio
async def test_claude_repeated_silent_reasoning_fails_with_work_kept(app, task, claude):
    app.state.settings.claude_stall_seconds = 1
    factory, clients = claude(*[[('stall',)]] * (MAX_STEERS + 1))
    with pytest.raises(ProviderError, match='kept reasoning'):
        await run_claude(app.state.engine, app.state.db.claim(), factory)
    assert clients[0].prompts.count(STEER) == MAX_STEERS


@pytest.mark.asyncio
async def test_claude_native_tool_use_fails_closed(app, task, claude):
    factory, clients = claude([('native','Bash')])
    with pytest.raises(ProviderError, match='outside the registered'):
        await run_claude(app.state.engine, app.state.db.claim(), factory)
    assert clients[0].closed


@pytest.mark.asyncio
async def test_claude_cancellation_disconnects(app, task, claude):
    factory, clients = claude([])
    run = app.state.db.claim()
    job = asyncio.create_task(run_claude(app.state.engine, run, factory))
    await asyncio.sleep(.05); app.state.db.cancel(task)
    from app.tools import Cancelled
    with pytest.raises(Cancelled): await job
    assert clients[0].closed


def test_claude_env_withholds_backend_secrets(monkeypatch, tmp_path):
    monkeypatch.setenv('OPENAI_API_KEY', 'sk-test'); monkeypatch.setenv('ONSHAPE_SECRET_KEY', 'secret')
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'from-shell')
    env = claude_env(Settings(data_dir=tmp_path, anthropic_api_key=''))
    assert env['OPENAI_API_KEY'] == '' and env['ONSHAPE_SECRET_KEY'] == '' and env['ANTHROPIC_API_KEY'] == ''
    assert 'HOME' not in env and 'PATH' not in env
    assert claude_env(Settings(data_dir=tmp_path, anthropic_api_key='sk-ant-test'))['ANTHROPIC_API_KEY'] == 'sk-ant-test'


def test_connection_choice_is_checked_saved_and_survives_restart(tmp_path, monkeypatch):
    settings = lambda: Settings(data_dir=tmp_path, provider='workshop', model='', api_token='', worker_enabled=False, anthropic_api_key='')
    app = create_app(settings())
    c = app.test_client()
    assert c.get('/api/capabilities').json['provider'] == 'workshop'
    overview = c.get('/api/integrations/model').json
    assert overview['active']['provider'] == 'workshop' and overview['active']['source'] == 'environment'
    assert [p['id'] for p in overview['providers']] == ['claude','workshop','openai']

    async def refused(self, provider, model='', api_key=''): return {'ok':False, 'message':'Claude Code is installed but not signed in.'}
    monkeypatch.setattr('app.connections.Connections.check', refused)
    failed = c.put('/api/integrations/model', json={'provider':'claude'})
    assert failed.status_code == 422 and 'not signed in' in failed.json['detail']
    assert c.get('/api/capabilities').json['provider'] == 'workshop'

    async def accepted(self, provider, model='', api_key=''): return {'ok':True, 'message':'Signed in.'}
    monkeypatch.setattr('app.connections.Connections.check', accepted)
    switched = c.put('/api/integrations/model', json={'provider':'claude','model':'sonnet','anthropic_api_key':'sk-ant-secret'})
    assert switched.status_code == 200 and switched.json['active']['provider'] == 'claude'
    assert 'sk-ant-secret' not in switched.get_data(as_text=True)
    cap = c.get('/api/capabilities').json
    assert cap['provider'] == 'claude' and cap['provider_name'] == 'Claude Code' and cap['connection_source'] == 'workspace'
    saved = tmp_path/'integrations'/'model.json'
    assert oct(os.stat(saved).st_mode & 0o777) == '0o600'
    assert app.state.settings.claude_model == 'sonnet' and app.state.settings.anthropic_api_key == 'sk-ant-secret'

    restarted = create_app(settings())
    assert restarted.state.settings.provider == 'claude'
    gone = restarted.test_client().delete('/api/integrations/model/anthropic-key')
    assert gone.status_code == 200 and restarted.state.settings.anthropic_api_key == ''
    back = restarted.test_client().put('/api/integrations/model', json={'provider':'workshop'})
    assert back.status_code == 200 and restarted.state.settings.provider == 'workshop'


@pytest.mark.asyncio
async def test_available_models_come_from_the_claude_code_handshake(tmp_path):
    class Handshake:
        def __init__(self, options): self.options, self.closed = options, False
        async def connect(self): pass
        async def get_server_info(self):
            return {'models':[{'value':'default', 'displayName':'Default (recommended)', 'description':'Sonnet'},
                              {'value':'opus', 'displayName':'Opus', 'description':'Complex work'}, {'displayName':'No value'}]}
        async def disconnect(self): self.closed = True
    made = []
    factory = lambda options: made.append(Handshake(options)) or made[-1]
    models = await available_models(Settings(data_dir=tmp_path, anthropic_api_key=''), factory)
    assert models == [{'id':'', 'name':'Account default', 'description':'Sonnet'}, {'id':'opus', 'name':'Opus', 'description':'Complex work'}]
    assert made[0].closed and made[0].options.tools == [] and made[0].options.setting_sources == []


def test_model_picker_lists_and_switches_the_claude_model(tmp_path, monkeypatch):
    app = create_app(Settings(data_dir=tmp_path, provider='claude', model='', api_token='', worker_enabled=False, anthropic_api_key=''))
    c = app.test_client()
    calls = []
    async def listed(settings): calls.append(1); return [{'id':'', 'name':'Default', 'description':''}, {'id':'opus', 'name':'Opus', 'description':''}]
    monkeypatch.setattr('app.claude_code.available_models', listed)
    first = c.get('/api/integrations/model/models').json
    assert first['provider'] == 'claude' and [m['id'] for m in first['models']] == ['', 'opus']
    c.get('/api/integrations/model/models')
    assert len(calls) == 1
    chosen = c.put('/api/integrations/model/choice', json={'model':'opus'})
    assert chosen.status_code == 200 and chosen.json['active']['model'] == 'opus'
    assert app.state.settings.claude_model == 'opus' and c.get('/api/integrations/model/models').json['model'] == 'opus'
    assert create_app(Settings(data_dir=tmp_path, provider='workshop', model='', api_token='', worker_enabled=False, anthropic_api_key='')).state.settings.claude_model == 'opus'


def test_model_picker_falls_back_to_aliases_when_claude_code_cannot_answer(tmp_path, monkeypatch):
    app = create_app(Settings(data_dir=tmp_path, provider='claude', model='', api_token='', worker_enabled=False, anthropic_api_key=''))
    async def broken(settings): raise ProviderError('Claude Code executable not found')
    monkeypatch.setattr('app.claude_code.available_models', broken)
    assert [m['id'] for m in app.test_client().get('/api/integrations/model/models').json['models']] == ['', 'opus', 'sonnet', 'haiku']
    workshop = create_app(Settings(data_dir=tmp_path/'w', provider='workshop', model='', api_token='', worker_enabled=False, anthropic_api_key=''))
    assert workshop.test_client().put('/api/integrations/model/choice', json={'model':'opus'}).status_code == 422


def test_removed_provider_is_rejected_and_old_choice_falls_back(tmp_path):
    saved = tmp_path/'integrations'/'model.json'
    saved.parent.mkdir(parents=True); saved.write_text('{"provider":"retired","models":{"retired":"old-model"}}')
    app = create_app(Settings(data_dir=tmp_path, provider='workshop', model='', api_token='', worker_enabled=False, anthropic_api_key=''))
    assert app.state.settings.provider == 'workshop'
    assert app.test_client().put('/api/integrations/model', json={'provider':'retired'}).status_code == 422


@pytest.mark.asyncio
async def test_claude_receives_actual_png_pixels(app, task, claude):
    run = app.state.db.claim()
    artifact = app.state.store.put(task, run['id'], 'preview.png', b'\x89PNG\r\n\x1a\n', {'kind':'preview_image'})
    factory, clients = claude([('tool','inspect_image',{'artifact_id':artifact['id']}),('final','Image inspected')])
    await run_claude(app.state.engine, run, factory)
    name, result = clients[0].results[0]
    image = next(item for item in result['content'] if item['type'] == 'image')
    assert name == 'inspect_image' and image['mimeType'] == 'image/png' and image['data'].startswith('iVBOR')


@pytest.mark.asyncio
async def test_photos_reach_claude_as_real_pixels(app, task, claude):
    from app.agent_context import task_context
    from .test_image_simulation import photo, capture_payload
    image = photo(app.test_client(), task)
    app.test_client().post(f'/api/tasks/{task}/image-sets', json=capture_payload(image))
    run = app.state.db.claim()
    assert 'object_image_set' in task_context(app.state.engine, run)
    factory, clients = claude([('tool','inspect_image',{'artifact_id':image['id']}),('final','Photo inspected; geometry is not yet requested.')])
    await run_claude(app.state.engine, run, factory)
    assert any(item['type'] == 'image' for item in clients[0].results[0][1]['content'])


def test_connection_switch_waits_for_running_work(app, task, monkeypatch):
    async def accepted(self, provider, model='', api_key=''): return {'ok':True, 'message':'Signed in.'}
    monkeypatch.setattr('app.connections.Connections.check', accepted)
    app.state.db.claim()
    response = app.test_client().put('/api/integrations/model', json={'provider':'claude'})
    assert response.status_code == 422 and 'current run' in response.json['detail']
    assert app.state.settings.provider == 'workshop'


def test_usage_counts_each_response_once_and_budgets_fresh_tokens():
    usage = {'input_tokens': 2, 'output_tokens': 8, 'cache_creation_input_tokens': 90, 'cache_read_input_tokens': 900}
    blocks = [AssistantMessage(content=[TextBlock(text='x')], model='m', usage=usage, message_id='msg_1') for _ in range(3)]
    final = AssistantMessage(content=[TextBlock(text='y')], model='m', usage={**usage, 'output_tokens': 40}, message_id='msg_1')
    state, counted = {'fresh': 0, 'total': 0}, {}
    for message in [*blocks, final]: count_usage(state, counted, message)
    assert state == {'fresh': 132, 'total': 1032}
    count_usage(state, counted, AssistantMessage(content=[], model='m', usage=usage, message_id='msg_2'))
    assert state == {'fresh': 232, 'total': 2032}


def test_saved_context_drops_duplicates_and_trims_instead_of_failing(app, task, monkeypatch):
    import json
    from app import agent_context as ac
    rows = [{'name':'list_artifacts','result':{'artifacts':['x']*10}}, {'name':'build_cad_script','result':{'log':'y'*9000}},
            {'name':'activity','result':{'ok':True}}]
    out = ac._recent_results(rows)
    assert out[0]['result'].startswith('Listed artifacts') and 'omitted' in out[1]['result'] and out[2] == rows[2]
    versions = [{'id':'2','name':'g.cad.py','version':2,'metadata':{'kind':'cad_script','parameters':{'a':1}}},
                {'id':'1','name':'g.cad.py','version':1,'metadata':{'kind':'cad_script','parameters':{'a':1},'build_id':'b1'}}]
    index = ac._artifact_index(versions)
    assert index[0] == versions[0] and index[1]['metadata'] == {'kind':'cad_script','build_id':'b1'}
    run = app.state.db.claim()
    full = ac.task_context(app.state.engine, run)
    monkeypatch.setattr(ac, 'CONTEXT_LIMIT', len(full) - 1)
    assert 'recent_tool_results' not in json.loads(ac.task_context(app.state.engine, run))
    monkeypatch.setattr(ac, 'CONTEXT_LIMIT', 10)
    with pytest.raises(ValueError, match='context budget'):
        ac.task_context(app.state.engine, run)


def test_keep_awake_holds_caffeinate_only_while_running(monkeypatch):
    import subprocess
    from app import awake
    started = []
    class Proc:
        def __init__(self, args, **kw): started.append(args); self.alive = True
        def poll(self): return None if self.alive else 0
        def terminate(self): self.alive = False
        def wait(self, timeout=None): return 0
    monkeypatch.setattr(awake.sys, 'platform', 'darwin')
    monkeypatch.setattr(awake.shutil, 'which', lambda name: '/usr/bin/caffeinate')
    monkeypatch.setattr(subprocess, 'Popen', Proc)
    hold = awake.KeepAwake().start()
    assert started == [['/usr/bin/caffeinate', '-i']] and hold.process.alive
    proc = hold.process; hold.stop()
    assert not proc.alive and hold.process is None
    monkeypatch.setattr(awake.sys, 'platform', 'linux')
    assert awake.KeepAwake().start().process is None  # hosted servers never try
