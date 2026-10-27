import asyncio
import hashlib
import json
import time
import zipfile
import httpx
from .http_client import AsyncWSGITransport
import pytest
from app.db import Conflict,encode,uid
from app.models import TaskCreate,ClarificationAnswer
from app.tools import ToolRunner,Cancelled
from app.cad_schema import CadInput
from app.recipes import marker_rack
from pydantic import ValidationError


async def run_next(app):
    run=app.state.db.claim()
    assert run
    await app.state.engine.run(run)
    return app.state.db.detail(run['task_id'])


@pytest.mark.asyncio
async def test_full_cad_flow_revision_and_package(app,task):
    first=await run_next(app)
    assert first['status']=='awaiting_input'
    q=first['questionnaires'][0]
    app.state.db.answer(task,q['id'],ClarificationAnswer(answers={'mounting':'Two screws','orientation':'Caps up','material':'PETG'}))
    done=await run_next(app)
    assert done['status']=='completed',done['runs'][-1].get('error')
    assert done['spec']['parameters']['count']==6
    report=next(a for a in done['artifacts'] if a['name']=='validation.json')
    _,path=app.state.store.get(task,report['id'])
    checks=json.loads(path.read_text())
    assert checks['passed'] and checks['parts'][0]['watertight'] and checks['step_reimport_valid']
    preview=next(a for a in done['artifacts'] if a['name']=='preview.mesh.json')
    _,path=app.state.store.get(task,preview['id'])
    assert len(json.loads(path.read_text())['parts'][0]['faces'])>100
    package=next(a for a in done['artifacts'] if a['name'].endswith('.zip'))
    _,path=app.state.store.get(task,package['id'])
    with zipfile.ZipFile(path) as z:
        manifest=json.loads(z.read('manifest.json'))
        assert 'marker_organizer.step' in z.namelist()
        for item in manifest['artifacts']:
            assert hashlib.sha256(z.read(item['name'])).hexdigest()==item['sha256']
    app.state.db.add_message(task,'Revise the organizer for eight markers. Keep the same diameter.','revision-key')
    revised=await run_next(app)
    assert revised['status']=='completed',revised['runs'][-1].get('error')
    assert revised['spec']['parameters']['count']==8
    assert len(revised['questionnaires'])==1
    assert [x['version'] for x in revised['artifacts'] if x['name']=='marker_rack.stl']==[1,2]
    events=app.state.db.all('SELECT * FROM events WHERE task_id=? ORDER BY seq',(task,))
    assert len({e['seq'] for e in events})==len(events)
    assert any(e['type']=='clarification.answered' for e in events)


def test_idempotency_and_duplicate_request_conflict(app):
    db=app.state.db; data=TaskCreate(prompt='Create a mounting plate')
    first=db.create_task(data,'once')
    assert db.create_task(data,'once')==first
    with pytest.raises(Conflict):db.create_task(TaskCreate(prompt='Different request'),'once')
    assert len(db.all('SELECT * FROM runs'))==1


def test_only_one_worker_claims_a_run(app,task):
    assert app.state.db.claim()['task_id']==task
    assert app.state.db.claim() is None


def test_expired_worker_is_interrupted_not_replayed(app,task):
    db=app.state.db; run=db.claim()
    with db.transaction() as c:c.execute('UPDATE runs SET lease_until=? WHERE id=?',(time.time()-1,run['id']))
    assert db.claim() is None
    assert db.require_task(task)['status']=='interrupted'
    rid=db.retry(task)
    assert rid!=run['id'] and db.claim()['id']==rid


@pytest.mark.asyncio
async def test_cancel_before_execution(app,task):
    app.state.db.cancel(task)
    assert app.state.db.claim() is None
    assert app.state.db.detail(task)['status']=='cancelled'
    assert app.state.db.detail(task)['artifacts']==[]


@pytest.mark.asyncio
async def test_questions_scoped_and_single_use(app,task):
    waiting=await run_next(app)
    q=waiting['questionnaires'][0]
    other=app.state.db.create_task(TaskCreate(prompt='Another task'))
    async with httpx.AsyncClient(transport=AsyncWSGITransport(app=app),base_url='http://testserver') as client:
        bad=await client.post(f'/api/tasks/{other}/questions/{q["id"]}/answer',json={'skip':True})
        assert bad.status_code==404
        good=await client.post(f'/api/tasks/{task}/questions/{q["id"]}/answer',json={'skip':True})
        assert good.status_code==202
        duplicate=await client.post(f'/api/tasks/{task}/questions/{q["id"]}/answer',json={'skip':True})
        assert duplicate.status_code==409


@pytest.mark.asyncio
async def test_artifact_scope_and_traversal(app,task):
    store=app.state.store
    with pytest.raises(ValueError):store.put(task,None,'../../escape.txt',b'bad')
    a=store.put(task,None,'notes.md',b'first')
    b=store.put(task,None,'notes.md',b'second')
    assert a['version']==1 and b['version']==2
    other=app.state.db.create_task(TaskCreate(prompt='Other task'))
    async with httpx.AsyncClient(transport=AsyncWSGITransport(app=app),base_url='http://testserver') as client:
        assert (await client.get(f'/api/tasks/{other}/artifacts/{a["id"]}/content')).status_code==404
        downloaded=await client.get(f'/api/tasks/{task}/artifacts/{a["id"]}/content')
        assert downloaded.content==b'first'
        assert downloaded.headers['etag']=='"'+a['sha256']+'"'


def test_context_scopes_and_project_memory_boundary(app):
    db=app.state.db; pid=uid()
    with db.transaction() as c:c.execute('INSERT INTO projects(id,name,brief,memory_scope,created_at) VALUES(?,?,?,?,?)',(pid,'Private project','Brief','project',time.time()))
    private=db.create_task(TaskCreate(prompt='Design',project_id=pid,context_scope='project'))
    public=db.create_task(TaskCreate(prompt='Design',context_scope='workspace'))
    isolated=db.create_task(TaskCreate(prompt='Design',context_scope='isolated'))
    with db.transaction() as c:c.execute('INSERT INTO memories(id,task_id,project_id,content,created_at) VALUES(?,?,?,?,?)',(uid(),private,pid,encode('Marker geometry private dimensions'),time.time()))
    runner=app.state.engine.runner
    assert runner.search_context(private,'marker')['results']
    assert runner.search_context(public,'marker')['results']==[]
    assert runner.search_context(isolated,'marker')['results']==[]
    with db.transaction() as c:c.execute("UPDATE projects SET memory_scope='workspace' WHERE id=?",(pid,))
    assert runner.search_context(public,'marker')['results']


@pytest.mark.asyncio
async def test_project_chats_share_project_memory(app):
    db=app.state.db; runner=app.state.engine.runner
    async with httpx.AsyncClient(transport=AsyncWSGITransport(app=app),base_url='http://testserver') as c:
        p=(await c.post('/api/projects',json={'name':'Drone','brief':'Carbon frame'})).json()
        first=db.create_task(TaskCreate(prompt='Design the arm',project_id=p['id'],context_scope='project'))
        await runner.dispatch(first,None,'save_memory',{'content':'Arm tube is 16 mm OD carbon.'})
        note=(await c.post(f'/api/projects/{p["id"]}/memories',json={'content':'Use M3 hardware everywhere.'})).json()
        assert note['task_id'] is None
        second=db.create_task(TaskCreate(prompt='Design the motor mount',project_id=p['id'],context_scope='project'))
        memory=db.project_memory(db.require_task(second))
        assert [n['content'] for n in memory['notes']]==['Use M3 hardware everywhere.','Arm tube is 16 mm OD carbon.']
        assert memory['other_chats'][0]['title'] and memory['notes'][0]['source']=='Project note'
        assert runner.search_context(second,'M3')['results'][0]['title']=='Project note'
        isolated=db.create_task(TaskCreate(prompt='Unrelated',project_id=p['id'],context_scope='isolated'))
        assert db.project_memory(db.require_task(isolated)) is None
        listed=(await c.get('/api/projects')).json()[0]
        assert listed['chat_count']==3 and listed['memory_count']==2
        detail=(await c.get('/api/projects/'+p['id'])).json()
        assert {x['id'] for x in detail['chats']}=={first,second,isolated} and len(detail['memories'])==2
        revised=(await c.patch('/api/memories/'+note['id'],json={'content':'Use M2.5 hardware.'})).json()
        assert revised['content']=='Use M2.5 hardware.'
        assert (await c.patch('/api/memories/missing',json={'content':'x'})).status_code==404
        assert (await c.post('/api/projects/missing/memories',json={'content':'x'})).status_code==404
        workspace=(await c.get('/api/memories')).json()
        assert {m['project_name'] for m in workspace}=={'Drone'}


def test_old_memories_migrate_to_their_project(tmp_path):
    import sqlite3
    from app.db import DB
    path=tmp_path/'old.db'
    con=sqlite3.connect(path)
    con.executescript("""CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,brief TEXT NOT NULL DEFAULT '',memory_scope TEXT NOT NULL DEFAULT 'project',created_at REAL NOT NULL);
CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,project_id TEXT,context_scope TEXT NOT NULL,status TEXT NOT NULL,plan TEXT NOT NULL DEFAULT '[]',spec TEXT NOT NULL DEFAULT '{}',archived INTEGER NOT NULL DEFAULT 0,created_at REAL NOT NULL,updated_at REAL NOT NULL);
CREATE TABLE memories(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),content TEXT NOT NULL,created_at REAL NOT NULL);
INSERT INTO projects VALUES('p','P','','project',1);
INSERT INTO tasks(id,title,project_id,context_scope,status,created_at,updated_at) VALUES('t','T','p','project','completed',1,1);
INSERT INTO memories VALUES('m','t','"kept"',1);""")
    con.commit(); con.close()
    db=DB(path)
    assert db.one('SELECT project_id,content FROM memories WHERE id=?',('m',))=={'project_id':'p','content':'kept'}


def test_cad_language_rejects_code_cycles_and_nonfinite_values():
    with pytest.raises(ValidationError):CadInput.model_validate({'name':'bad','nodes':[{'id':'x','op':'python','code':'print(1)'}],'parts':[]})
    bad=marker_rack();bad['nodes'][0]={'id':'x','op':'transform','source':'future'}
    with pytest.raises(ValidationError):CadInput.model_validate(bad)
    bad=marker_rack();bad['nodes'][0]['size']=[float('nan'),5,5]
    with pytest.raises(ValidationError):CadInput.model_validate(bad)


@pytest.mark.asyncio
async def test_failed_cad_gate_prevents_optimistic_result(app,task):
    run=app.state.db.claim()
    spec={'name':'disconnected','nodes':[{'id':'box','op':'box','size':[5,5,5]},{'id':'other','op':'transform','source':'box','translation':[20,0,0]},{'id':'both','op':'union','inputs':['box','other']}],'parts':[{'name':'invalid_part','shape':'both'}]}
    result=await app.state.engine.runner.execute(task,run['id'],'invalid-build','build_cad',spec)
    assert not result.get('error'),result
    assert result['validation']['passed'] is False
    assert result['validation']['parts'][0]['solid_count']==2


@pytest.mark.asyncio
async def test_tool_idempotency_and_error_capture(app,task):
    run=app.state.db.claim();runner=app.state.engine.runner
    args={'name':'note.md','content':'Hello'}
    a=await runner.execute(task,run['id'],'call_a','write_document',args)
    b=await runner.execute(task,run['id'],'call_a','write_document',args)
    assert a['id']==b['id']
    invalid=await runner.execute(task,run['id'],'call_b','write_document',{'name':'/outside.txt','content':'No'})
    assert invalid['recoverable'] and invalid['error']


@pytest.mark.asyncio
async def test_reference_reader_blocks_unconfigured_and_private_urls(app):
    for url in ['file:///etc/passwd','http://127.0.0.1/','https://example.com/']:
        with pytest.raises(ValueError):await app.state.engine.runner.fetch_reference(url)


def test_followup_queued_then_processed_once(app,task):
    db=app.state.db;run=db.claim()
    db.add_message(task,'Change count to eight markers','followup')
    db.add_message(task,'Change count to eight markers','followup')
    assert len(db.all("SELECT * FROM messages WHERE kind='queued'"))==1
    db.finish(run['id'],'completed')
    assert db.require_task(task)['status']=='queued'
    next_run=db.claim();assert next_run['id']!=run['id']
    assert db.all("SELECT * FROM messages WHERE run_id=?",(next_run['id'],))[0]['content']=='Change count to eight markers'


@pytest.mark.asyncio
async def test_local_auth_and_origin_boundary(tmp_path):
    from app.main import create_app
    from app.config import Settings
    app=create_app(Settings(data_dir=tmp_path,provider='workshop',worker_enabled=False,api_token='local-test-token'))
    async with httpx.AsyncClient(transport=AsyncWSGITransport(app=app),base_url='http://testserver') as c:
        assert (await c.get('/api/tasks')).status_code==401
        headers={'Authorization':'Bearer local-test-token'}
        assert (await c.get('/api/tasks',headers=headers)).status_code==200
        headers['Origin']='https://unrelated.example'
        assert (await c.post('/api/tasks',headers=headers,json={'prompt':'Hello'})).status_code==403


@pytest.mark.asyncio
async def test_project_and_schedule_roundtrip(app):
    async with httpx.AsyncClient(transport=AsyncWSGITransport(app=app),base_url='http://testserver') as c:
        p=(await c.post('/api/projects',json={'name':'Product','brief':'Use millimetres'})).json()
        assert p['memory_scope']=='project'
        assert (await c.post(f'/api/projects/{p["id"]}/files',files={'file':('brief.txt',b'Material: PETG')})).status_code==201
        detail=(await c.get('/api/projects/'+p['id'])).json();assert detail['files'][0]['name']=='brief.txt'
        s=(await c.post('/api/schedules',json={'name':'Review','prompt':'Check design','interval_minutes':60})).json()
        assert not s['enabled']
        updated=await c.patch('/api/schedules/'+s['id'],json={'enabled':True})
        assert updated.json()['enabled']==1
        before=updated.json()['next_run_at']
        task=(await c.post(f'/api/schedules/{s["id"]}/run')).json()
        assert task['title']=='Review' and task['status']=='queued' and task['messages'][0]['content']=='Check design'
        job=(await c.get('/api/schedules')).json()[0]
        assert job['last_task_id']==task['id'] and job['last_task_status']=='queued' and job['next_run_at']==before
        assert (await c.post('/api/schedules/missing/run')).status_code==404


@pytest.mark.asyncio
async def test_mounting_plate_with_identical_model_and_part_names(app):
    task_id = app.state.db.create_task(TaskCreate(prompt='Create an 80 x 50 x 5 mm mounting plate with four 4.5 mm corner holes. Export STL and STEP.'))
    done = await run_next(app)
    assert done['id'] == task_id
    assert done['status'] == 'completed', done['runs'][-1].get('error')
    names = {artifact['name'] for artifact in done['artifacts']}
    assert {'mounting_plate.stl', 'mounting_plate.step', 'validation.json'} <= names
    report = next(artifact for artifact in done['artifacts'] if artifact['name'] == 'validation.json')
    _, report_path = app.state.store.get(task_id, report['id'])
    checks = json.loads(report_path.read_text())
    assert checks['passed'] and checks['step_reimport_valid']
    assert checks['assembly_bounds_mm'] == pytest.approx([80.0, 50.0, 5.0], abs=0.01)


@pytest.mark.asyncio
async def test_component_focus_scopes_follow_up(app,task):
    source={'name':'kit','nodes':[{'id':'plate','op':'box','size':[40,40,4]},{'id':'post','op':'cylinder','radius':4,'height':20},
        {'id':'post_up','op':'transform','source':'post','translation':[0,0,4]}],
        'parts':[{'name':'base','shape':'plate'},{'name':'pin','shape':'post_up'}]}
    cad=app.state.store.put(task,None,'kit.cad.json',json.dumps(source).encode(),{'kind':'cad_source','build_id':'b1'})
    async with httpx.AsyncClient(transport=AsyncWSGITransport(app=app),base_url='http://testserver') as c:
        sent=await c.post(f'/api/tasks/{task}/messages',json={'content':'Make it 2 mm taller','focus':{'part':'pin','source_artifact_id':cad['id']}})
        assert sent.status_code==202
        missing=await c.post(f'/api/tasks/{task}/messages',json={'content':'x','focus':{'part':'lid','source_artifact_id':cad['id']}})
        assert missing.status_code==422
    content=app.state.db.all("SELECT content FROM messages WHERE task_id=? ORDER BY created_at",(task,))[-1]['content']
    assert content.startswith('[Component focus: pin]\nMake it 2 mm taller')
    assert 'Its nodes: post, post_up.' in content and 'plate' not in content and cad['id'] in content
