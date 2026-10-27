import httpx
import pytest

from app.models import TaskCreate
from .http_client import AsyncWSGITransport
from .test_cad_script import ENCLOSURE


@pytest.mark.skipif(not __import__('app.bambu', fromlist=['binary']).binary(), reason='Bambu Studio not installed')
@pytest.mark.asyncio
async def test_bambu_profiles_slice_and_agent_tool(app):
    db, runner = app.state.db, app.state.engine.runner
    async with httpx.AsyncClient(transport=AsyncWSGITransport(app=app), base_url='http://testserver') as c:
        status = (await c.get('/api/integrations/bambu')).json()
        assert status['installed'] and status['bed_mm'][0] > 150
        # Off until the user connects it: no agent tool, and slicing is refused.
        from app.tools import tool_definitions
        assert not status['connected'] and 'slice_with_bambu' not in {t['name'] for t in tool_definitions(app.state.settings)}
        caps = (await c.get('/api/capabilities')).json()
        assert next(i for i in caps['integrations'] if i['name'] == 'Bambu Studio')['status'] == 'available'
        options = (await c.get('/api/integrations/bambu/profiles', params={'machine': 'Bambu Lab A1 0.4 nozzle'})).json()
        assert 'Bambu PLA Basic @BBL A1' in options['filaments']
        bad = await c.put('/api/integrations/bambu', json={'machine': 'Bambu Lab A1 0.4 nozzle',
                          'process': '0.20mm Standard @BBL X1C', 'filament': 'Bambu PLA Basic @BBL A1'})
        assert bad.status_code == 422
        process = next(p for p in options['processes'] if p.startswith('0.20mm Standard'))
        saved = (await c.put('/api/integrations/bambu', json={'machine': 'Bambu Lab A1 0.4 nozzle', 'process': process,
                             'filament': 'Bambu PLA Basic @BBL A1'})).json()
        assert saved['settings']['filament'] == 'Bambu PLA Basic @BBL A1' and saved['connected']
        assert 'slice_with_bambu' in {t['name'] for t in tool_definitions(app.state.settings)}

        tid = db.create_task(TaskCreate(prompt='Enclosure'))
        run = db.claim()
        assert 'error' not in await runner.execute(tid, run['id'], 'b', 'build_cad_script', {'name': 'box', 'script': ENCLOSURE})
        sliced = await runner.execute(tid, run['id'], 's', 'slice_with_bambu', {})
        assert sliced['ok'] and sliced['filament_g'] > 1 and sliced['estimated_time'] and sliced['layers'] > 10
        assert {o['name'] for o in sliced['objects']} == {'base.stl', 'lid.stl'} and sliced['parts'] == ['base', 'lid']
        lid = await runner.execute(tid, run['id'], 's2', 'slice_with_bambu', {'parts': ['lid']})
        assert {o['name'] for o in lid['objects']} == {'lid.stl'}
        missing = await runner.execute(tid, run['id'], 's3', 'slice_with_bambu', {'parts': ['hinge']})
        assert 'Not in this build: hinge' in missing['error']
        names = {a['name'] for a in db.detail(tid)['artifacts']}
        assert {'bambu_slice.json', 'bambu_project.3mf'} <= names
        again = (await c.post(f'/api/tasks/{tid}/slice')).json()
        assert again['printer'] == 'Bambu Lab A1 0.4 nozzle'
        caps = (await c.get('/api/capabilities')).json()
        assert next(i for i in caps['integrations'] if i['name'] == 'Bambu Studio')['status'] == 'connected'
        off = (await c.delete('/api/integrations/bambu')).json()
        assert not off['connected'] and off['settings']['machine'] == 'Bambu Lab A1 0.4 nozzle'
        refused = await runner.execute(tid, run['id'], 's4', 'slice_with_bambu', {})
        assert refused['code'] == 'tool_unavailable'
        assert (await c.post(f'/api/tasks/{tid}/slice')).status_code == 422


def test_reference_parts_are_left_off_the_plate():
    from app.bambu import REFERENCE, _slice_error
    assert [n for n in ('tomato_ref', 'cylinder_reference', 'finger_1', 'refill_cap', 'mount_hub') if REFERENCE.search(n)] == ['tomato_ref', 'cylinder_reference']
    assert 'parts=[...]' in _slice_error('Some objects are located over the boundary of the heated bed.')
