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
        options = (await c.get('/api/integrations/bambu/profiles', params={'machine': 'Bambu Lab A1 0.4 nozzle'})).json()
        assert 'Bambu PLA Basic @BBL A1' in options['filaments']
        bad = await c.put('/api/integrations/bambu', json={'machine': 'Bambu Lab A1 0.4 nozzle',
                          'process': '0.20mm Standard @BBL X1C', 'filament': 'Bambu PLA Basic @BBL A1'})
        assert bad.status_code == 422
        process = next(p for p in options['processes'] if p.startswith('0.20mm Standard'))
        saved = (await c.put('/api/integrations/bambu', json={'machine': 'Bambu Lab A1 0.4 nozzle', 'process': process,
                             'filament': 'Bambu PLA Basic @BBL A1'})).json()
        assert saved['settings']['filament'] == 'Bambu PLA Basic @BBL A1'

        tid = db.create_task(TaskCreate(prompt='Enclosure'))
        run = db.claim()
        assert 'error' not in await runner.execute(tid, run['id'], 'b', 'build_cad_script', {'name': 'box', 'script': ENCLOSURE})
        sliced = await runner.execute(tid, run['id'], 's', 'slice_with_bambu', {})
        assert sliced['ok'] and sliced['filament_g'] > 1 and sliced['estimated_time'] and sliced['layers'] > 10
        assert {o['name'] for o in sliced['objects']} == {'base.stl', 'lid.stl'}
        names = {a['name'] for a in db.detail(tid)['artifacts']}
        assert {'bambu_slice.json', 'bambu_project.3mf'} <= names
        again = (await c.post(f'/api/tasks/{tid}/slice')).json()
        assert again['printer'] == 'Bambu Lab A1 0.4 nozzle'
        caps = (await c.get('/api/capabilities')).json()
        assert next(i for i in caps['integrations'] if i['name'] == 'Bambu Studio')['status'] == 'connected'
