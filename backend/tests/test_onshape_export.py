import base64
import hashlib
import hmac
import json

import httpx
import pytest

from .http_client import AsyncWSGITransport

DID, WID, NEW_DID, NEW_WID, PS = 'a' * 24, 'b' * 24, '1' * 24, '2' * 24, '3' * 24
SECRET = 'secret-key-0123456789'


def onshape_with_uploads(state):
    def handler(request):
        message = '\n'.join([request.method, request.headers['on-nonce'], request.headers['date'],
                             request.headers['content-type'], request.url.path, request.url.query.decode(), '']).lower()
        expected = base64.b64encode(hmac.new(SECRET.encode(), message.encode(), hashlib.sha256).digest()).decode()
        assert request.headers['authorization'].endswith(expected)
        path = request.url.path.removeprefix('/api/v17')
        if path == '/users/sessioninfo':
            return httpx.Response(200, json={'name': 'Ada'})
        if request.method == 'POST' and path == '/documents':
            assert json.loads(request.content) == {'name': 'Gripper R07', 'isPublic': False}
            return httpx.Response(200, json={'id': NEW_DID, 'defaultWorkspace': {'id': NEW_WID}})
        if request.method == 'POST' and path.startswith('/translations/d/'):
            assert request.headers['content-type'].startswith('multipart/form-data; boundary="')
            body = request.content
            assert b'ISO-10303-21;' in body and b'filename="gripper.step"' in body
            assert b'name="translate"\r\n\r\ntrue' in body
            state['flatten'] = b'name="flattenAssemblies"\r\n\r\ntrue' in body
            state['uploaded'] = path
            return httpx.Response(200, json={'id': 'tr1', 'requestState': 'ACTIVE'})
        if path == '/translations/tr1':
            state['polls'] += 1
            if state['polls'] < 2:
                return httpx.Response(200, json={'id': 'tr1', 'requestState': 'ACTIVE'})
            return httpx.Response(200, json={'id': 'tr1', 'requestState': state.get('final', 'DONE'),
                                             'failureReason': 'Bad geometry'})
        if path.endswith('/elements'):
            rows = [{'id': '9' * 24, 'name': 'Part Studio 1', 'elementType': 'PARTSTUDIO'}]
            if state.get('uploaded') and state['polls'] >= 2:
                rows.append({'id': PS, 'name': 'gripper', 'elementType': 'PARTSTUDIO'})
            return httpx.Response(200, json=rows)
        return httpx.Response(404)
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_exports_step_to_new_and_existing_documents(app, task, monkeypatch):
    monkeypatch.delenv('ONSHAPE_ACCESS_KEY', raising=False)
    state = {'polls': 0}
    app.state.onshape_transport = onshape_with_uploads(state)
    naps = []
    app.state.onshape_sleep = naps.append
    step = app.state.store.put(task, None, 'gripper.step', b'ISO-10303-21;\nHEADER;ENDSEC;', {'kind': 'cad'})
    stl = app.state.store.put(task, None, 'gripper.stl', b'solid x', {'kind': 'cad'})
    async with httpx.AsyncClient(transport=AsyncWSGITransport(app=app), base_url='http://testserver') as c:
        assert (await c.put('/api/integrations/onshape', json={'access_key': 'access-key-123', 'secret_key': SECRET})).status_code == 200
        wrong = await c.post('/api/onshape/export', json={'task_id': task, 'artifact_id': stl['id']})
        assert wrong.status_code == 422 and 'STEP' in wrong.json()['detail']

        made = await c.post('/api/onshape/export', json={'task_id': task, 'artifact_id': step['id'],
                                                         'new_document_name': 'Gripper R07'})
        assert made.status_code == 200, made.text
        made = made.json()
        assert made['state'] == 'done' and made['created_document']
        assert state['uploaded'] == f'/translations/d/{NEW_DID}/w/{NEW_WID}' and state['flatten']
        assert [e['id'] for e in made['elements']] == [PS]
        assert made['url'].endswith(f'/documents/{NEW_DID}/w/{NEW_WID}/e/{PS}')
        assert naps == [1, 2]  # exponential backoff between polls

        state.update(polls=0, uploaded=None, final='FAILED')
        failed = await c.post('/api/onshape/export', json={'task_id': task, 'artifact_id': step['id'],
                                                           'document_id': DID, 'workspace_id': WID, 'flatten': False})
        assert failed.status_code == 422 and 'Bad geometry' in failed.json()['detail']
        assert state['uploaded'] == f'/translations/d/{DID}/w/{WID}' and not state['flatten']
    events = app.state.db.all("SELECT * FROM events WHERE task_id=? AND type='onshape.exported'", (task,))
    assert len(events) == 1
