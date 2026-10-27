import asyncio
import json
import time
import pytest
from app.audit import task_audit
from app.completion import completion_errors
from app.db import encode
from app.models import TaskCreate
from .test_provider_loop import ScriptedProvider, response, call, message


@pytest.mark.asyncio
async def test_api_completion_repairs_before_publishing(app, task):
    settings=app.state.settings; settings.provider='openai'
    plan=[{'id':'review','title':'Review deliverables','status':'in_progress'}]
    fixed=[{**plan[0],'status':'completed'}]
    app.state.engine.provider=ScriptedProvider([
        response(1,call('update_plan',{'steps':plan},'plan')),
        response(2,message('Premature success')),
        response(3,call('update_plan',{'steps':fixed},'repair')),
        response(4,message('Reviewed and complete')),
    ])
    await app.state.engine.run(app.state.db.claim())
    detail=app.state.db.detail(task)
    assert detail['status']=='completed'
    assert [m['content'] for m in detail['messages'] if m['role']=='assistant']==['Reviewed and complete']
    checks=task_audit(app.state.db,task)['checks']
    assert [c['payload']['passed'] for c in checks]==[False,True]


@pytest.mark.asyncio
async def test_completion_failure_is_bounded_and_never_publishes_claim(app,task):
    app.state.settings.provider='openai'
    with app.state.db.transaction() as c:
        c.execute('UPDATE tasks SET spec=? WHERE id=?',(encode({'deliverables':['STL','STEP']}),task))
    provider=ScriptedProvider([response(i,message('Files are complete')) for i in range(4)])
    app.state.engine.provider=provider
    await app.state.engine.run(app.state.db.claim())
    detail=app.state.db.detail(task)
    assert detail['status']=='failed' and 'Completion checks failed' in detail['runs'][0]['error']
    assert len(provider.inputs)==4 and not [m for m in detail['messages'] if m['role']=='assistant']


@pytest.mark.asyncio
async def test_api_enforces_tool_budget_even_with_batched_calls(app,task):
    app.state.settings.provider='openai'; app.state.settings.max_tool_calls=1
    app.state.engine.provider=ScriptedProvider([response(1,
        call('write_document',{'name':'one.txt','content':'one'},'1'),
        call('write_document',{'name':'two.txt','content':'two'},'2'),message('Done'))])
    await app.state.engine.run(app.state.db.claim())
    task=app.state.db.detail(task)
    assert task['status']=='failed' and 'tool-call budget' in task['runs'][0]['error']
    assert [a['name'] for a in task['artifacts']]==['one.txt']
    assert not [m for m in task['messages'] if m['role']=='assistant']


@pytest.mark.asyncio
async def test_replayed_id_cannot_change_action(app,task):
    db=app.state.db; run=db.claim(); runner=app.state.engine.runner
    args={'name':'notes.txt','content':'original'}
    first=await runner.execute(task,run['id'],'same','write_document',args)
    assert await runner.execute(task,run['id'],'same','write_document',args)==first
    with pytest.raises(ValueError,match='reused'):
        await runner.execute(task,run['id'],'same','write_document',{**args,'content':'different'})
    assert len(db.detail(task)['artifacts'])==1


@pytest.mark.asyncio
async def test_decision_evidence_scope_versions_and_staleness(app,task):
    db,store,runner=app.state.db,app.state.store,app.state.engine.runner
    run=db.claim(); rid=run['id']
    other=db.create_task(TaskCreate(prompt='Unrelated design'))
    foreign=store.put(other,None,'reference.json',b'{}',{'kind':'reference'})
    decision={'key':'interface','title':'Interface dimension','summary':'Nominal dimension from the manual.','basis':'source','evidence_ids':[foreign['id']]}
    result=await runner.execute(task,rid,'foreign','record_decision',decision)
    assert 'not found in this task' in result['error']
    result=await runner.execute(task,rid,'missing','record_decision',{**decision,'evidence_ids':[]})
    assert 'require evidence' in result['error']
    ref=store.put(task,rid,'reference.json',b'{}',{'kind':'reference','url':'https://example.com/manual','document_sha256':'abc','pages':[4],'fetched_at':123})
    result=await runner.execute(task,rid,'source','record_decision',{**decision,'evidence_ids':[ref['id']]})
    assert result['decision']['evidence'][0]['id']==ref['id']
    v1=store.put(task,rid,'validation.json',b'{}',{'kind':'validation','validation_passed':True,'build_id':'one'})
    measured={**decision,'basis':'measurement','evidence_ids':[v1['id']]}
    good=await runner.execute(task,rid,'measurement','record_decision',measured)
    assert good['artifact']['version']==2
    store.put(task,rid,'validation.json',b'{}',{'kind':'validation','validation_passed':True,'build_id':'two'})
    stale=await runner.execute(task,rid,'stale','record_decision',measured)
    assert 'latest CAD build' in stale['error']
    audit=task_audit(db,task)
    assert audit['decisions'][0]['superseded']
    assert audit['decisions'][1]['stale']
    assert audit['sources'][0]['pages']==[4]
    assert 'arguments' not in audit['tools'][0]  # full payload is fetched only on expansion
    client=app.test_client()
    cid=audit['tools'][0]['id']
    assert client.get(f'/api/tasks/{task}/tools/{cid}').json['status']=='failed'
    assert client.get(f'/api/tasks/{other}/tools/{cid}').status_code==404
    assert client.get(f'/api/tasks/{task}/audit').status_code==200
    assert client.get('/api/tasks/missing/audit').status_code==404


@pytest.mark.asyncio
async def test_failed_or_non_numeric_evidence_cannot_support_measurement(app,task):
    db,store,runner=app.state.db,app.state.store,app.state.engine.runner
    rid=db.claim()['id']
    args={'key':'fit','title':'Fit','summary':'Fit passed','basis':'measurement'}
    for i,metadata in enumerate(({'kind':'document'},{'kind':'motion_validation','motion_passed':False})):
        artifact=store.put(task,rid,f'evidence{i}.json',b'{}',metadata)
        result=await runner.execute(task,rid,str(i),'record_decision',{**args,'evidence_ids':[artifact['id']]})
        assert 'error' in result


@pytest.mark.asyncio
async def test_cancelled_worker_finalizes_tool_trace(app,task,monkeypatch):
    db,runner=app.state.db,app.state.engine.runner; run=db.claim()
    started=asyncio.Event()
    async def wait(*args):
        started.set(); await asyncio.sleep(60)
    monkeypatch.setattr(runner,'dispatch',wait)
    pending=asyncio.create_task(runner.execute(task,run['id'],'wait','activity',{'title':'Working','detail':'Waiting'}))
    await started.wait(); pending.cancel()
    with pytest.raises(asyncio.CancelledError): await pending
    row=db.one('SELECT * FROM tool_calls WHERE run_id=?',(run['id'],))
    assert row['status']=='interrupted' and row['finished_at'] is not None
    event=db.one("SELECT payload FROM events WHERE type='tool.interrupted'")
    assert event['payload']['duration_ms']>=0


def test_expired_lease_finalizes_running_tools(app,task):
    db=app.state.db; run=db.claim()
    with db.transaction() as c:
        c.execute('UPDATE runs SET lease_until=? WHERE id=?',(time.time()-1,run['id']))
        c.execute('INSERT INTO tool_calls(id,task_id,run_id,name,arguments,status,started_at) VALUES(?,?,?,?,?,?,?)',('unfinished',task,run['id'],'build_cad','{}','running',time.time()-5))
    assert db.claim() is None
    assert db.one("SELECT status FROM tool_calls WHERE id='unfinished'")['status']=='interrupted'
    assert db.detail(task)['status']=='interrupted'


def test_package_verifies_bytes_and_rejects_mixed_builds(app,task):
    store=app.state.store; rid=app.state.db.claim()['id']
    a=store.put(task,rid,'part.stl',b'one',{'build_id':'a','validation_passed':True})
    b=store.put(task,rid,'other.stl',b'two',{'build_id':'b','validation_passed':True})
    with pytest.raises(ValueError,match='different CAD builds'): store.package(task,rid,'mixed',[a['id'],b['id']])
    _,path=store.get(task,a['id']); path.write_bytes(b'tampered')
    with pytest.raises(ValueError,match='integrity'): store.package(task,rid,'bad',[a['id']])
    manifest=store.put(task,rid,'manifest.json',b'{}')
    with pytest.raises(ValueError,match='reserved'): store.package(task,rid,'bad',[manifest['id']])


def test_legacy_reference_details_are_preserved(app,task):
    db=app.state.db; run=db.claim(); rid=run['id']
    source=app.state.store.put(task,rid,'ref.json',b'{}',{'kind':'reference','url':'https://example.com/manual','document_sha256':'abc'})
    with db.transaction() as c:
        c.execute('INSERT INTO tool_calls VALUES(?,?,?,?,?,?,?,?,?)',('old',task,rid,'fetch_reference','{}',encode({'evidence_artifact_id':source['id'],'fetched_at':42,'pages':[{'page':46}]}),'completed',1,2))
    assert task_audit(db,task)['sources'][0]['pages']==[46]
    assert task_audit(db,task)['sources'][0]['fetched_at']==42


@pytest.mark.asyncio
async def test_delivery_requires_current_exports_notes_and_cited_sources(app,task):
    db,store,runner=app.state.db,app.state.store,app.state.engine.runner
    run=db.claim();rid=run['id']
    with db.transaction() as c:
        c.execute('INSERT INTO tool_calls VALUES(?,?,?,?,?,?,?,?,?)',('built',task,rid,'build_cad','{}','{}','completed',1,2))
    report=store.put(task,rid,'validation.json',b'{}',{'kind':'validation','validation_passed':True,'build_id':'new'})
    await runner.execute(task,rid,'inspect','inspect_validation',{'artifact_id':report['id']})
    reference=store.put(task,rid,'reference.json',b'{}',{'kind':'reference'})
    source=await runner.execute(task,rid,'source','record_decision',{'key':'formats','title':'Formats','summary':'Format selection','basis':'source','evidence_ids':[reference['id']]})
    decision=await runner.execute(task,rid,'measure','record_decision',{'key':'geometry','title':'Geometry','summary':'Measured envelope','basis':'measurement','evidence_ids':[report['id']]})
    notes=store.put(task,rid,'assembly.md',b'Prototype assembly instructions',{'kind':'document'})
    exports=[store.put(task,rid,'plate'+suffix,b'geometry',{'kind':kind,'validation_passed':True,'build_id':'new'}) for suffix,kind in (('.stl','cad'),('.step','cad'),('.cad.json','cad_source'))]
    ids=[report['id'],decision['artifact']['id'],source['artifact']['id']]+[a['id'] for a in exports]
    store.package(task,rid,'delivery',ids)
    errors=completion_errors(app.state.engine,run,{})
    assert any('latest assembly' in e for e in errors)
    assert any('evidence cited' in e for e in errors)
    store.package(task,rid,'delivery',ids+[notes['id'],reference['id']])
    assert completion_errors(app.state.engine,run,{})==[]
    store.put(task,rid,'plate.step',b'other build',{'kind':'cad','validation_passed':True,'build_id':'other'})
    assert any('Missing current CAD export .step' in e for e in completion_errors(app.state.engine,run,{}))
