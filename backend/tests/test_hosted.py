"""Hosted 6B (6B_HOSTED=1): every browser brings its own model and Onshape keys."""
import json
import os
from pathlib import Path
import httpx
import pytest
from app.claude_code import claude_env
from app.config import CONNECTION, Settings
from app.credentials import Connection, using
from app.main import create_app
from app.models import TaskCreate
from .test_onshape import SECRET, fake_onshape

PROMPT = {'prompt':'Write a short design note'}


def browser(provider='openai', model='gpt-test', key=''):
    headers = {'X-6B-Provider':provider, 'X-6B-Model':model}
    if key: headers['X-6B-Key'] = key
    return headers


@pytest.fixture
def hosted(tmp_path):
    # A connection saved by an earlier single-user install must not leak into hosted mode.
    (tmp_path/'integrations').mkdir()
    (tmp_path/'integrations'/'model.json').write_text(json.dumps({'provider':'claude','anthropic_api_key':'SAVED-SECRET'}))
    return create_app(Settings(data_dir=tmp_path, hosted=True, provider='openai', model='server-model', api_key='SERVER-SECRET',
                               anthropic_api_key='SERVER-ANTHROPIC', api_token='', worker_enabled=False))


class Recorder:
    """Records which connection the engine used for each model call."""
    def __init__(self, settings): self.settings, self.seen = settings, []
    async def respond(self, instructions, tools, items, previous_response_id=None):
        s = self.settings
        self.seen.append((s.provider, s.model, s.api_key))
        if previous_response_id is None:
            call = {'type':'function_call','name':'write_document','call_id':'c1',
                    'arguments':json.dumps({'name':'note.md','content':'Hosted note'})}
            return {'id':'r1','status':'completed','output':[call],'usage':{'total_tokens':10}}
        text = {'type':'message','content':[{'type':'output_text','text':'Saved the note.'}]}
        return {'id':'r2','status':'completed','output':[text],'usage':{'total_tokens':10}}


def test_server_keys_and_saved_connections_are_ignored(hosted):
    s = hosted.state.settings
    assert (s.provider, s.model, s.api_key, s.anthropic_api_key) == ('workshop', '', '', '')
    client = hosted.test_client()
    overview = client.get('/api/integrations/model').get_json()
    assert overview['hosted'] and overview['active']['provider'] == 'workshop' and overview['active']['source'] == 'browser'
    assert not next(p for p in overview['providers'] if p['id'] == 'claude')['api_key_saved']


def test_answers_follow_each_browser_and_never_leak(hosted):
    client = hosted.test_client()
    mine = client.get('/api/integrations/model', headers=browser('claude', 'sonnet')).get_json()['active']
    assert (mine['provider'], mine['model']) == ('claude', 'sonnet')
    caps = client.get('/api/capabilities', headers=browser('openai', 'gpt-x')).get_json()
    assert caps['provider'] == 'openai' and caps['model'] == 'gpt-x' and caps['connection_source'] == 'browser'
    assert client.get('/api/capabilities').get_json()['provider'] == 'workshop'
    # Nothing from a request survives it.
    assert CONNECTION.get() is None and hosted.state.settings.provider == 'workshop'


def test_server_wide_settings_and_schedules_are_off(hosted):
    client = hosted.test_client()
    assert client.put('/api/integrations/model', json={'provider':'claude','anthropic_api_key':'x'*20}).status_code == 403
    assert client.delete('/api/integrations/model/anthropic-key').status_code == 403
    assert client.post('/api/schedules', json={'name':'Nightly','prompt':'Check','interval_minutes':60}).status_code == 403
    saved = json.loads((Path(hosted.state.settings.data_dir)/'integrations'/'model.json').read_text())
    assert saved == {'provider':'claude','anthropic_api_key':'SAVED-SECRET'}


def test_check_validates_the_browser_key_live(hosted):
    seen = []
    def handler(request):
        seen.append(str(request.url))
        if request.url.host == 'api.anthropic.com':
            return httpx.Response(200 if request.headers['x-api-key'] == 'sk-ant-good' else 401, json={})
        return httpx.Response(200 if request.url.path.endswith('/gpt-ok') else 404, json={})
    hosted.state.model_transport = httpx.MockTransport(handler)
    client = hosted.test_client()
    check = lambda body: client.post('/api/integrations/model/check', json=body).get_json()
    assert check({'provider':'claude','api_key':'sk-ant-good'})['ok']
    assert 'rejected' in check({'provider':'claude','api_key':'sk-ant-bad'})['message']
    assert check({'provider':'openai','model':'gpt-ok','api_key':'sk-x'})['ok']
    assert 'cannot use the model' in check({'provider':'openai','model':'gpt-missing','api_key':'sk-x'})['message']
    assert not check({'provider':'openai','model':'gpt-ok'})['ok']
    # A missing key is refused before any network call.
    assert len(seen) == 4 and seen[0] == 'https://api.anthropic.com/v1/models' and seen[2].endswith('/v1/models/gpt-ok')


@pytest.mark.asyncio
async def test_each_browser_runs_with_its_own_key(hosted):
    engine, db, client = hosted.state.engine, hosted.state.db, hosted.test_client()
    engine.provider = recorder = Recorder(hosted.state.settings)
    a = client.post('/api/tasks', json=PROMPT, headers=browser('openai', 'model-a', 'KEY-ALICE-123')).get_json()['id']
    b = client.post('/api/tasks', json=PROMPT, headers=browser('openai', 'model-b', 'KEY-BOB-456')).get_json()['id']
    for _ in range(2): await engine.run(db.claim())
    assert db.detail(a)['status'] == db.detail(b)['status'] == 'completed'
    assert recorder.seen == [('openai','model-a','KEY-ALICE-123')]*2 + [('openai','model-b','KEY-BOB-456')]*2
    # Keys are dropped once a task is idle, and nothing durable ever held them.
    assert engine.keys.get(a) is None and engine.keys.get(b) is None and hosted.state.settings.api_key == ''
    for path in Path(hosted.state.settings.data_dir).rglob('*'):
        if path.is_file():
            data = path.read_bytes()
            assert b'KEY-ALICE' not in data and b'KEY-BOB' not in data, path


@pytest.mark.asyncio
async def test_follow_up_message_brings_the_key_again(hosted):
    engine, db, client = hosted.state.engine, hosted.state.db, hosted.test_client()
    engine.provider = recorder = Recorder(hosted.state.settings)
    tid = client.post('/api/tasks', json=PROMPT, headers=browser(key='KEY-ONE-1234')).get_json()['id']
    await engine.run(db.claim())
    assert client.post(f'/api/tasks/{tid}/messages', json={'content':'Again'}, headers=browser()).status_code == 422
    assert client.post(f'/api/tasks/{tid}/messages', json={'content':'Again'}, headers=browser(key='KEY-TWO-5678')).status_code == 202
    await engine.run(db.claim())
    assert recorder.seen[-1][2] == 'KEY-TWO-5678'


def test_a_model_without_its_key_is_refused(hosted):
    client = hosted.test_client()
    response = client.post('/api/tasks', json=PROMPT, headers=browser('claude', ''))
    assert response.status_code == 422 and 'Integrations' in response.get_json()['detail']
    assert client.post('/api/tasks', json=PROMPT, headers=browser('openai', '', 'sk-x')).status_code == 422
    assert hosted.state.db.one('SELECT COUNT(*) AS n FROM tasks')['n'] == 0


def test_no_connection_means_the_workshop(hosted):
    client = hosted.test_client()
    tid = client.post('/api/tasks', json=PROMPT).get_json()['id']
    assert hosted.state.engine.keys.get(tid).provider == 'workshop'


@pytest.mark.asyncio
async def test_a_run_without_a_held_key_fails_without_borrowing_one(hosted):
    db = hosted.state.db
    tid = db.create_task(TaskCreate(**PROMPT))  # queued while no browser connection is held (e.g. after a restart)
    await hosted.state.engine.run(db.claim())
    task = db.detail(tid)
    assert task['status'] == 'failed' and 'Integrations' in task['runs'][0]['error']


@pytest.mark.asyncio
async def test_claude_runs_get_the_key_and_a_private_home(hosted, monkeypatch):
    seen = {}
    async def fake_run_claude(engine, run):
        s = engine.settings
        seen.update(key=s.anthropic_api_key, model=s.claude_model, home=s.claude_home, exists=os.path.isdir(s.claude_home),
                    env=claude_env(s))
        engine.db.finish(run['id'], 'completed')
    monkeypatch.setattr('app.claude_code.run_claude', fake_run_claude)
    client = hosted.test_client()
    client.post('/api/tasks', json=PROMPT, headers=browser('claude', 'opus', 'sk-ant-PRIVATE'))
    await hosted.state.engine.run(hosted.state.db.claim())
    assert seen['key'] == 'sk-ant-PRIVATE' and seen['model'] == 'opus' and seen['exists']
    assert seen['env']['ANTHROPIC_API_KEY'] == 'sk-ant-PRIVATE'
    assert seen['env']['HOME'] == seen['env']['CLAUDE_CONFIG_DIR'] == seen['home']
    assert not os.path.exists(seen['home']) and hosted.state.settings.claude_home == ''


def test_claude_env_without_a_private_home_is_unchanged(tmp_path):
    settings = Settings(data_dir=tmp_path, anthropic_api_key='')
    with using(Connection('claude', '', 'sk-ant-x')):
        env = claude_env(settings)
    assert env['ANTHROPIC_API_KEY'] == 'sk-ant-x' and 'CLAUDE_CONFIG_DIR' not in env
    assert claude_env(settings).get('ANTHROPIC_API_KEY', '') == ''


def test_onshape_keys_stay_in_the_browser(hosted, monkeypatch):
    monkeypatch.setenv('ONSHAPE_ACCESS_KEY', 'server-access-key')
    monkeypatch.setenv('ONSHAPE_SECRET_KEY', 'server-secret-key')
    hosted.state.onshape_transport = fake_onshape([])
    client = hosted.test_client()
    creds = {'base_url':'https://cad.onshape.com', 'access_key':'access-key-123', 'secret_key':SECRET}
    connected = client.put('/api/integrations/onshape', json=creds).get_json()
    assert connected['configured'] and connected['source'] == 'browser' and connected['user']['name'] == 'Ada Lovelace'
    assert not (Path(hosted.state.settings.data_dir)/'integrations'/'onshape.json').exists()
    # Server environment keys are not offered to visitors.
    assert client.get('/api/integrations/onshape').get_json() == {'configured':False, 'hosted':True}
    headers = {'X-6B-Onshape-Url':creds['base_url'], 'X-6B-Onshape-Access':creds['access_key'], 'X-6B-Onshape-Secret':SECRET}
    status = client.get('/api/integrations/onshape', headers=headers).get_json()
    assert status['configured'] and status['access_key_hint'] == '…-123'
    assert client.post('/api/integrations/onshape/test', headers=headers).get_json()['user']['name'] == 'Ada Lovelace'
    assert client.post('/api/integrations/onshape/test').status_code == 422
