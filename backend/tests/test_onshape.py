import base64
import hashlib
import hmac
import json
import os
import stat
from urllib.parse import parse_qs, urlparse

import httpx
import numpy as np
import pytest
import trimesh

from .http_client import AsyncWSGITransport

DID, WID, ASM, PS = 'a' * 24, 'b' * 24, 'c' * 24, 'd' * 24
SECRET = 'secret-key-0123456789'


def stl(size):
    return trimesh.creation.box(extents=size).export(file_type='stl')


def fake_onshape(seen):
    plate, pin = stl((40, 40, 4)), stl((4, 4, 20))

    def handler(request):
        url = request.url
        seen.append(url.path)
        # Every request, including the redirected download, carries a valid signature.
        auth = request.headers['authorization']
        assert auth.startswith('On access-key-123:HmacSHA256:')
        message = '\n'.join([request.method, request.headers['on-nonce'], request.headers['date'],
                             'application/json', url.path, url.query.decode(), '']).lower()
        expected = base64.b64encode(hmac.new(SECRET.encode(), message.encode(), hashlib.sha256).digest()).decode()
        assert auth.endswith(expected)
        path = url.path.removeprefix('/api/v17')
        if path == '/users/sessioninfo':
            return httpx.Response(200, json={'name': 'Ada Lovelace', 'email': 'ada@example.com'})
        if path == '/documents':
            assert parse_qs(url.query.decode())['q'] == ['bracket']
            return httpx.Response(200, json={'items': [{'id': DID, 'name': 'Bracket kit', 'jsonType': 'document',
                                                        'defaultWorkspace': {'id': WID}, 'owner': {'name': 'Ada'}}],
                                             'next': None})
        if path == f'/documents/{DID}':
            return httpx.Response(200, json={'name': 'Bracket kit'})
        if path == f'/documents/d/{DID}/w/{WID}/elements':
            return httpx.Response(200, json=[{'id': ASM, 'name': 'Main assembly', 'elementType': 'ASSEMBLY'},
                                             {'id': PS, 'name': 'Parts', 'elementType': 'PARTSTUDIO'},
                                             {'id': 'e' * 24, 'name': 'Drawing', 'elementType': 'DRAWING'}])
        if path == f'/assemblies/d/{DID}/w/{WID}/e/{ASM}':
            part = lambda i, pid, name: {'id': i, 'type': 'Part', 'name': name, 'partId': pid, 'documentId': DID,
                                         'documentMicroversion': 'f' * 24, 'elementId': PS, 'configuration': ''}
            moved = list(np.eye(4).ravel()); moved[3] = 0.03; moved[11] = 0.012
            return httpx.Response(200, json={'rootAssembly': {
                'instances': [part('i1', 'JHD', 'Plate <1>'), part('i2', 'JKD', 'Pin <1>'), part('i3', 'JKD', 'Pin <2>')],
                'occurrences': [{'path': ['i1'], 'transform': list(np.eye(4).ravel())},
                                {'path': ['i2'], 'transform': list(np.eye(4).ravel())},
                                {'path': ['i3'], 'transform': moved}]}, 'subAssemblies': []})
        if path == f'/parts/d/{DID}/w/{WID}/e/{PS}':
            return httpx.Response(200, json=[{'partId': 'JHD', 'name': 'Plate', 'bodyType': 'solid'},
                                             {'partId': 'JSD', 'name': 'Sketch body', 'bodyType': 'sheet'}])
        if path.startswith(f'/parts/d/{DID}/') and path.endswith('/stl'):
            assert parse_qs(url.query.decode())['units'] == ['millimeter']
            return httpx.Response(307, headers={'location': f'https://cad.onshape.com/api/v17/blob{path}?token=1'})
        if path.startswith('/blob/'):
            return httpx.Response(200, content=plate if '/JHD/' in path else pin)
        if path.startswith('/thumbnails/'):
            return httpx.Response(200, content=b'\x89PNG\r\n\x1a\nthumb', headers={'content-type': 'image/png'})
        return httpx.Response(404)
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_onshape_connect_browse_and_import_assembly(app, monkeypatch):
    monkeypatch.delenv('ONSHAPE_ACCESS_KEY', raising=False)
    seen = []
    app.state.onshape_transport = fake_onshape(seen)
    async with httpx.AsyncClient(transport=AsyncWSGITransport(app=app), base_url='http://testserver') as c:
        assert (await c.get('/api/integrations/onshape')).json() == {'configured': False}
        bad = await c.put('/api/integrations/onshape', json={'base_url': 'https://evil.example', 'access_key': 'access-key-123', 'secret_key': SECRET})
        assert bad.status_code == 422
        connected = (await c.put('/api/integrations/onshape', json={'access_key': 'access-key-123', 'secret_key': SECRET})).json()
        assert connected['user']['name'] == 'Ada Lovelace' and connected['access_key_hint'] == '…-123'
        assert SECRET not in json.dumps(connected)
        keys = app.state.settings.data_dir / 'integrations' / 'onshape.json'
        assert stat.S_IMODE(os.stat(keys).st_mode) == 0o600
        caps = (await c.get('/api/capabilities')).json()
        assert next(i for i in caps['integrations'] if i['name'] == 'Onshape')['status'] == 'connected'

        docs = (await c.get('/api/onshape/documents', params={'q': 'bracket'})).json()
        assert docs['items'][0]['workspace_id'] == WID
        elements = (await c.get(f'/api/onshape/documents/{DID}/w/{WID}/elements')).json()
        assert [e['type'] for e in elements] == ['ASSEMBLY', 'PARTSTUDIO']
        thumb = await c.get('/api/onshape/thumbnail', params={'did': DID, 'wid': WID, 'eid': ASM})
        assert thumb.headers['content-type'] == 'image/png'

        result = await c.post('/api/onshape/import', json={'document_id': DID, 'workspace_id': WID, 'element_id': ASM})
        assert result.status_code == 201, result.text
        result = result.json()
        assert result['parts'] == 3 and result['files'] == 2 and result['run_id'] is None
        task = (await c.get(f"/api/tasks/{result['task_id']}")).json()
        assert task['title'] == 'Bracket kit · Main assembly' and task['runs'] == []
        names = {a['name']: a for a in task['artifacts']}
        assert {'Plate.stl', 'Pin.stl', 'preview.mesh.json', 'onshape_import.json', 'onshape_thumbnail.png'} <= set(names)
        assert names['Pin.stl']['metadata']['source'] == 'onshape'
        mesh = (await c.get(f"/api/tasks/{task['id']}/artifacts/{names['preview.mesh.json']['id']}/content")).json()
        assert mesh['kind'] == 'onshape_import' and [p['name'] for p in mesh['parts']] == ['Plate_1', 'Pin_1', 'Pin_2']
        moved = np.array(mesh['parts'][2]['vertices'])
        assert np.allclose((moved.min(0) + moved.max(0)) / 2, [30, 0, 12])  # metres placed in mm
        manifest = (await c.get(f"/api/tasks/{task['id']}/artifacts/{names['onshape_import.json']['id']}/content")).json()
        assert manifest['quantities'] == {'Plate.stl': 1, 'Pin.stl': 2}
        assert manifest['parts'][0]['bounds_mm'] == [40, 40, 4] and manifest['parts'][0]['watertight']
        assert any(m['kind'] == 'attachment' for m in task['messages'])

        sent = await c.post(f"/api/tasks/{task['id']}/messages", json={'content': 'Design a cover for this pin',
                            'focus': {'part': 'Pin_2', 'source_artifact_id': names['onshape_import.json']['id']}})
        assert sent.status_code == 202
        content = app.state.db.all('SELECT content FROM messages WHERE task_id=? ORDER BY created_at', (task['id'],))[-1]['content']
        assert content.startswith('[Component focus: Pin_2]\nDesign a cover for this pin')
        assert 'read-only geometry imported from Onshape' in content and '4.0 x 4.0 x 20.0 mm' in content

        again = (await c.post('/api/onshape/import', json={'document_id': DID, 'workspace_id': WID, 'element_id': PS,
                                                            'task_id': task['id'], 'prompt': 'Compare the parts'})).json()
        assert again['task_id'] == task['id'] and again['run_id']

        assert (await c.delete('/api/integrations/onshape')).json() == {'configured': False}
        assert (await c.get('/api/onshape/documents')).status_code == 422
    assert any(p.startswith('/api/v17/blob/') for p in seen)


def test_redirects_outside_onshape_are_refused():
    from app.onshape import OnshapeClient, OnshapeError
    transport = httpx.MockTransport(lambda r: httpx.Response(307, headers={'location': 'https://evil.example/x'}))
    client = OnshapeClient('https://cad.onshape.com', 'access-key-123', SECRET, transport)
    with pytest.raises(OnshapeError, match='outside'):
        client.get('/users/sessioninfo')
    assert urlparse(client.base).hostname == 'cad.onshape.com'
