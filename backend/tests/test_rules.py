import httpx
import pytest

from app.models import TaskCreate
from .http_client import AsyncWSGITransport
from .test_cad_script import ENCLOSURE


@pytest.mark.asyncio
async def test_rule_sets_are_decided_checked_and_gated(app):
    db, runner = app.state.db, app.state.engine.runner
    async with httpx.AsyncClient(transport=AsyncWSGITransport(app=app), base_url='http://testserver') as c:
        templates = (await c.get('/api/rules/templates')).json()
        assert {t['id'] for t in templates} >= {'kyrall_gripper', 'fdm_printing'}
        added = (await c.post('/api/rules/templates/kyrall_gripper')).json()
        assert added['added'] >= 10
        assert (await c.post('/api/rules/templates/kyrall_gripper')).status_code == 422
        general = (await c.post('/api/rules', json={'content': 'Use millimetres'})).json()
        assert general['level'] == 'must' and general['rule_set'] == ''
        rules = (await c.get('/api/rules')).json()
        assert any(r['rule_set'] == 'Kyrall robot gripper challenge' and r['applies_when'] for r in rules)

        tid = db.create_task(TaskCreate(prompt='Tomato gripper for the hackathon'))
        sets = (await c.get(f'/api/tasks/{tid}/rules')).json()
        assert {s['rule_set']: s['status'] for s in sets} == {'': 'always', 'Kyrall robot gripper challenge': 'skipped'}
        assert next(s for s in sets if s['rule_set'])['decision']['decided_by'] == 'default'

        app.state.settings.provider = 'openai'
        run = db.claim()
        script = {'name': 'box', 'script': ENCLOSURE}
        chosen = await runner.execute(tid, run['id'], 'c1', 'choose_rules', {'decisions': [
            {'rule_set': 'Kyrall robot gripper challenge', 'apply': True, 'reason': 'The brief is the hackathon tomato gripper'}]})
        must = [r for r in chosen['applied'][0]['rules'] if r['level'] == 'must']
        assert len(must) >= 8
        built = await runner.execute(tid, run['id'], 'b1', 'build_cad_script', script)
        assert 'error' not in built, built

        from app.rules import unchecked_must_rules, agent_view
        assert len(unchecked_must_rules(db, tid, run['id'])) == len(must) + 1  # plus the general rule
        view = agent_view(db, tid)
        assert not view['undecided'] and len(view['binding']) == 2
        ids = [r['id'] for r in must] + [general['id']]
        recorded = await runner.execute(tid, run['id'], 'k1', 'record_rule_checks', {'checks': [
            {'rule_id': rid, 'status': 'unverified', 'evidence': 'Needs a physical test'} for rid in ids]})
        assert recorded['recorded'] == len(ids) and not recorded['must_rules_still_unchecked_in_this_call']
        assert unchecked_must_rules(db, tid, run['id']) == []
        bad = await runner.execute(tid, run['id'], 'k2', 'record_rule_checks', {'checks': [
            {'rule_id': 'nope', 'status': 'met', 'evidence': 'x y z'}]})
        assert 'not a binding rule' in bad['error']

        # The user can override the agent's decision from the task page.
        sets = (await c.put(f'/api/tasks/{tid}/rules', json={'rule_set': 'Kyrall robot gripper challenge', 'apply': False})).json()
        kyrall = next(s for s in sets if s['rule_set'] == 'Kyrall robot gripper challenge')
        assert kyrall['status'] == 'skipped' and kyrall['decision']['decided_by'] == 'user'
        assert kyrall['rules'][0]['check']['status'] == 'unverified'


@pytest.mark.asyncio
async def test_fdm_applies_by_default_without_a_decision(app):
    db = app.state.db
    async with httpx.AsyncClient(transport=AsyncWSGITransport(app=app), base_url='http://testserver') as c:
        await c.post('/api/rules/templates/fdm_printing')
        await c.post('/api/rules/templates/kyrall_gripper')
        tid = db.create_task(TaskCreate(prompt='A gripper finger'))
        sets = {s['rule_set']: s for s in (await c.get(f'/api/tasks/{tid}/rules')).json()}
        assert sets['FDM 3D printing']['status'] == 'applied'
        assert sets['Kyrall robot gripper challenge']['status'] == 'skipped'
        from app.rules import agent_view, undecided
        assert undecided(db, tid) == [] and not agent_view(db, tid)['undecided']
        # Turning Kyrall on for one chat is the user's choice.
        sets = {s['rule_set']: s for s in (await c.put(f'/api/tasks/{tid}/rules', json={
            'rule_set': 'Kyrall robot gripper challenge', 'apply': True})).json()}
        assert sets['Kyrall robot gripper challenge']['status'] == 'applied'
