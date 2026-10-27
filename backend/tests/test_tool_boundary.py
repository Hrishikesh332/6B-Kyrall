import asyncio
import json
import time
import pytest
from app.models import TaskCreate
from app.provider import ProviderError
from app.tools import Cancelled, tool_definitions
from .test_provider_loop import ScriptedProvider, response, call, message


@pytest.mark.asyncio
@pytest.mark.parametrize('raw',[
    '{"name":', '[]', 'null', '{"x":NaN}', '{"x":1e999}',
    '{"name":"one.txt","name":"two.txt","content":"hello"}',
])
async def test_invalid_wire_input_is_audited_and_can_be_repaired(app,task,raw):
    app.state.settings.provider='openai'
    bad=call('write_document',{},'bad');bad['arguments']=raw
    provider=ScriptedProvider([
        response(1,bad),
        response(2,call('write_document',{'name':'fixed.txt','content':'Corrected'},'fixed')),
        response(3,message('Saved')),
    ])
    app.state.engine.provider=provider
    await app.state.engine.run(app.state.db.claim())
    detail=app.state.db.detail(task)
    assert detail['status']=='completed'
    assert [a['name'] for a in detail['artifacts']]==['fixed.txt']
    error=json.loads(provider.inputs[1]['items'][0]['output'])
    assert error['code']=='invalid_arguments' and not error['retryable']
    rows=app.state.db.all('SELECT * FROM tool_calls ORDER BY started_at')
    assert [r['status'] for r in rows]==['failed','completed']
    assert rows[0]['arguments']['rejected_input']==raw
    assert rows[0]['finished_at'] is not None


@pytest.mark.asyncio
async def test_decoded_nonfinite_and_oversized_inputs_are_bounded(app,task):
    runner=app.state.engine.runner;rid=app.state.db.claim()['id']
    invalid=await runner.execute(task,rid,'nan','set_specification',{'parameters':{'x':float('nan')}})
    assert invalid['code']=='invalid_arguments'
    raw=json.dumps({'name':'large.txt','content':'x'*1_000_000})
    result=await runner.execute(task,rid,'large','write_document',raw,arguments_json=True)
    assert result['code']=='invalid_arguments'
    row=app.state.db.one("SELECT * FROM tool_calls WHERE name='write_document'")
    assert row['arguments']['truncated'] and row['arguments']['bytes']>1_000_000
    assert len(row['arguments']['rejected_input'])<=8192
    assert await runner.execute(task,rid,'large','write_document',raw,arguments_json=True)==result
    with pytest.raises(ValueError,match='reused'):
        await runner.execute(task,rid,'large','write_document',raw+' ',arguments_json=True)
    assert not app.state.db.detail(task)['artifacts']


@pytest.mark.asyncio
async def test_schema_errors_give_fields_without_echoing_document_content(app,task):
    secret='private-document-body'
    result=await app.state.engine.runner.execute(task,app.state.db.claim()['id'],'bad','write_document',
        {'name':'../../outside.txt','content':secret,'extra':secret})
    assert result['code']=='invalid_arguments'
    assert {e['path'] for e in result['fields']}=={'name','extra'}
    assert secret not in json.dumps(result)


@pytest.mark.asyncio
async def test_only_advertised_capabilities_can_execute(app,task,monkeypatch):
    app.state.settings.provider='openai';app.state.settings.reference_domains=()
    runner=app.state.engine.runner;rid=app.state.db.claim()['id']
    dispatched=[]
    async def dispatch(*args): dispatched.append(args); return {}
    monkeypatch.setattr(runner,'dispatch',dispatch)
    offered={t['name'] for t in tool_definitions(app.state.settings)}
    for name in ('inspect_image','fetch_reference','invented_tool'):
        result=await runner.execute(task,rid,name,name,{})
        assert name not in offered and result['code']=='tool_unavailable'
        assert set(result['available_tools'])==offered
    assert not dispatched
    assert [r['status'] for r in app.state.db.all('SELECT status FROM tool_calls')]==['failed']*3


@pytest.mark.asyncio
async def test_cross_task_call_is_rejected_before_side_effect(app,task):
    rid=app.state.db.claim()['id']
    other=app.state.db.create_task(TaskCreate(prompt='Another task'))
    with pytest.raises(ValueError,match='does not belong'):
        await app.state.engine.runner.execute(other,rid,'cross','write_document',{'name':'note.txt','content':'wrong task'})
    assert not app.state.db.all('SELECT * FROM tool_calls')
    assert not app.state.db.detail(other)['artifacts']


@pytest.mark.asyncio
@pytest.mark.parametrize('stop',['user','timeout','run_deadline'])
async def test_waiting_tools_stop_and_finish_cleanup(app,task,monkeypatch,stop):
    runner=app.state.engine.runner;rid=app.state.db.claim()['id']
    started=asyncio.Event();cleaned=asyncio.Event()
    async def slow(*args):
        started.set()
        try: await asyncio.sleep(60)
        finally: cleaned.set()
    monkeypatch.setattr(runner,'dispatch',slow)
    if stop=='timeout': app.state.settings.tool_timeout=.03
    deadline=time.monotonic()+.03 if stop=='run_deadline' else None
    pending=asyncio.create_task(runner.execute(task,rid,'slow','list_artifacts',{},deadline=deadline))
    await started.wait()
    if stop=='user':
        app.state.db.cancel(task)
        with pytest.raises(Cancelled): await asyncio.wait_for(pending,1)
    else:
        result=await asyncio.wait_for(pending,1)
        assert result['code']=='tool_timeout' and not result['retryable']
    assert cleaned.is_set()
    row=app.state.db.one('SELECT * FROM tool_calls')
    assert row['status']==('cancelled' if stop=='user' else 'failed')
    assert row['finished_at'] is not None
    assert not app.state.db.all("SELECT * FROM tool_calls WHERE status='running'")


@pytest.mark.asyncio
async def test_duplicate_inflight_call_does_not_dispatch_twice(app,task,monkeypatch):
    runner=app.state.engine.runner;rid=app.state.db.claim()['id']
    started=asyncio.Event();release=asyncio.Event();count=0
    async def wait(*args):
        nonlocal count
        count+=1;started.set();await release.wait();return {'saved':True}
    monkeypatch.setattr(runner,'dispatch',wait)
    first=asyncio.create_task(runner.execute(task,rid,'same','list_artifacts',{}))
    await started.wait()
    try:
        with pytest.raises(RuntimeError,match='explicit retry'):
            await runner.execute(task,rid,'same','list_artifacts',{})
    finally: release.set()
    result=await first
    assert await runner.execute(task,rid,'same','list_artifacts',{})==result
    assert count==1 and len(app.state.db.all('SELECT * FROM tool_calls'))==1
