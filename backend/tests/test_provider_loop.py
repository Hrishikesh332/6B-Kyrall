import asyncio
import json
import pytest
from app.models import TaskCreate,ClarificationAnswer


class ScriptedProvider:
    def __init__(self,responses):self.responses=iter(responses);self.inputs=[]
    async def respond(self,instructions,tools,items,previous_response_id=None):
        self.inputs.append({'items':items,'previous':previous_response_id,'instructions':instructions})
        return next(self.responses)


def response(n,*outputs):return {'id':f'response_{n}','status':'completed','output':list(outputs),'usage':{'total_tokens':100}}
def call(name,args,cid):return {'type':'function_call','name':name,'arguments':json.dumps(args),'call_id':cid}
def message(text):return {'type':'message','content':[{'type':'output_text','text':text}]}


@pytest.mark.asyncio
async def test_live_pause_resume_preserves_tool_outputs(app):
    app.state.settings.provider='openai'
    provider=ScriptedProvider([
        response(1,call('ask_questions',{'title':'Material','questions':[{'id':'material','question':'Choose a material','options':['PLA','PETG'],'default':'PETG'}]},'q')),
        response(2,call('write_document',{'name':'brief.md','content':'Material: PETG'},'doc')),
        response(3,message('Saved the design brief.')),
    ])
    engine=app.state.engine;engine.provider=provider;db=app.state.db
    tid=db.create_task(TaskCreate(prompt='Create a design brief'))
    first=db.claim();await engine.run(first)
    task=db.detail(tid);assert task['status']=='awaiting_input'
    db.answer(tid,task['questionnaires'][0]['id'],ClarificationAnswer(answers={'material':'PETG'}))
    second=db.claim();assert second['id']==first['id'];await engine.run(second)
    done=db.detail(tid);assert done['status']=='completed'
    assert len(done['artifacts'])==1
    assert provider.inputs[1]['previous']=='response_1'
    assert provider.inputs[1]['items'][0]['type']=='function_call_output'
    assert 'PETG' in provider.inputs[1]['items'][-1]['content']
    assert done['runs'][0]['usage']['total_tokens']==300


@pytest.mark.asyncio
async def test_model_can_repair_a_tool_argument_error(app):
    app.state.settings.provider='openai'
    app.state.engine.provider=ScriptedProvider([
        response(1,call('write_document',{'name':'../../bad.txt','content':'bad'},'a')),
        response(2,call('write_document',{'name':'good.txt','content':'corrected'},'b')),
        response(3,message('Document created.')),
    ])
    tid=app.state.db.create_task(TaskCreate(prompt='Write a note'))
    await app.state.engine.run(app.state.db.claim())
    detail=app.state.db.detail(tid)
    assert detail['status']=='completed' and detail['artifacts'][0]['name']=='good.txt'
    calls=app.state.db.all('SELECT status FROM tool_calls ORDER BY started_at')
    assert [x['status'] for x in calls]==['failed','completed']


@pytest.mark.asyncio
async def test_cancel_during_provider_wait(app):
    class SlowProvider:
        async def respond(self,*args):
            await asyncio.sleep(5)
            return response(1,message('Should not be published'))
    app.state.settings.provider='openai';app.state.engine.provider=SlowProvider()
    tid=app.state.db.create_task(TaskCreate(prompt='Long task'))
    running=asyncio.create_task(app.state.engine.run(app.state.db.claim()))
    await asyncio.sleep(.05);app.state.db.cancel(tid);await running
    assert app.state.db.detail(tid)['status']=='cancelled'
    assert all(x['role']=='user' for x in app.state.db.detail(tid)['messages'])


@pytest.mark.asyncio
async def test_turn_budget_stops_loop(app):
    app.state.settings.provider='openai';app.state.settings.max_model_turns=1
    app.state.engine.provider=ScriptedProvider([response(1,call('activity',{'title':'Working','detail':'Need another step'},'a'))])
    tid=app.state.db.create_task(TaskCreate(prompt='Task'))
    await app.state.engine.run(app.state.db.claim())
    assert app.state.db.detail(tid)['status']=='failed'
    assert 'Maximum model turns' in app.state.db.detail(tid)['runs'][0]['error']
