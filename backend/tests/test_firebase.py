"""Google sign-in (Firebase Auth) and the Realtime Database cloud copy of each chat."""
import base64
import json
import pytest
from app.config import Settings
from app.firebase import SESSION_COOKIE, CloudSync, Firebase, SignInError, document, key, service_account
from app.main import create_app
from app.models import TaskCreate

ACCOUNTS = {'cookie-a': {'uid': 'a', 'email': 'a@example.com', 'email_verified': True, 'name': 'Ada', 'picture': ''},
            'cookie-b': {'uid': 'b', 'email': 'b@example.com', 'email_verified': True, 'name': 'Bo', 'picture': ''},
            'cookie-c': {'uid': 'c', 'email': 'A@example.com', 'email_verified': False, 'name': 'Not Ada', 'picture': ''}}


class FakeFirebase:
    """Stands in for Firebase Auth: token 'google-token-for-account-<uid>' signs in account <uid>."""
    sign_in, cloud_sync = True, False
    web = {'apiKey': 'web-key', 'authDomain': 'demo.firebaseapp.com', 'projectId': 'demo'}

    def __init__(self, required=True, database=None): self.required, self.root = required, database
    def config(self): return {'enabled': True, 'required': self.required, 'firebase': self.web}
    def database(self): return self.root
    def user(self, cookie): return ACCOUNTS.get(cookie)

    def start_session(self, id_token):
        cookie = 'cookie-' + id_token.removeprefix('google-token-for-account-')
        if cookie not in ACCOUNTS: raise SignInError('Google sign-in could not be verified. Try again.')
        return cookie, ACCOUNTS[cookie]


def signed_in_app(tmp_path, required=True, database=None, **settings):
    return create_app(Settings(data_dir=tmp_path, provider='workshop', model='', api_token='', worker_enabled=False, **settings),
                      firebase=FakeFirebase(required, database))


def as_account(app, uid):
    client = app.test_client()
    client.set_cookie(SESSION_COOKIE, 'cookie-' + uid)
    return client


def test_service_account_comes_from_json_or_base64_only():
    key = {'type': 'service_account', 'project_id': 'demo', 'private_key': '-----BEGIN PRIVATE KEY-----'}
    assert service_account(json.dumps(key)) == key
    assert service_account(base64.b64encode(json.dumps(key).encode()).decode()) == key
    assert service_account('') is None
    for bad in ('/Users/me/Downloads/key.json', base64.b64encode(b'{"type":"authorized_user"}').decode(), '{not json'):
        with pytest.raises(ValueError):
            service_account(bad)


def test_sign_in_cannot_be_asked_for_without_the_service_account(tmp_path):
    with pytest.raises(ValueError, match='needs both'):
        Firebase(Settings(data_dir=tmp_path, firebase_service_account='', firebase_web_api_key='web-key'))
    off = Firebase(Settings(data_dir=tmp_path, firebase_service_account='', firebase_web_api_key=''))
    assert off.config() == {'enabled': False, 'required': False, 'firebase': None} and off.database() is None


def test_without_firebase_the_workspace_stays_open(app):
    client = app.test_client()
    assert client.get('/api/auth/config').json == {'enabled': False, 'required': False, 'firebase': None, 'user': None}
    assert client.get('/api/tasks').status_code == 200
    assert "frame-src 'none'" in client.get('/api/health').headers['Content-Security-Policy']


def test_api_needs_a_google_session(tmp_path):
    app = signed_in_app(tmp_path)
    client = app.test_client()
    refused = client.get('/api/tasks')
    assert refused.status_code == 401 and refused.json['sign_in'] == 'google'
    assert client.get('/api/health').status_code == 200
    assert client.get('/api/auth/config').json == {'enabled': True, 'required': True, 'firebase': FakeFirebase.web, 'user': None}
    client.set_cookie(SESSION_COOKIE, 'forged')
    assert client.get('/api/capabilities').status_code == 401
    csp = client.get('/api/health').headers['Content-Security-Policy']
    assert 'https://apis.google.com' in csp and 'frame-src https://demo.firebaseapp.com' in csp


def test_sign_in_sets_an_http_only_session_and_sign_out_clears_it(tmp_path):
    app = signed_in_app(tmp_path)
    client = app.test_client()
    assert client.post('/api/auth/session', json={'id_token': 'google-token-for-account-zzz'}).status_code == 401
    response = client.post('/api/auth/session', json={'id_token': 'google-token-for-account-a'})
    assert response.json == {'user': {**ACCOUNTS['cookie-a'], 'admin': False}}
    cookie = response.headers['Set-Cookie']
    assert 'cookie-a' in cookie and 'HttpOnly' in cookie and 'SameSite=Lax' in cookie
    assert client.get('/api/auth/config').json['user']['uid'] == 'a'
    assert client.get('/api/tasks').status_code == 200
    client.delete('/api/auth/session')
    assert client.get('/api/tasks').status_code == 401


def test_chats_projects_and_files_belong_to_their_account(tmp_path):
    app = signed_in_app(tmp_path)
    ada, bo = as_account(app, 'a'), as_account(app, 'b')
    project = ada.post('/api/projects', json={'name': 'Gripper'}).json
    task = ada.post('/api/tasks', json={'prompt': 'Design a marker rack', 'project_id': project['id']}).json
    assert task['owner'] == 'a'
    app.state.store.put(task['id'], None, 'notes.txt', b'hello', {'kind': 'upload'})
    assert [t['id'] for t in ada.get('/api/tasks').json['items']] == [task['id']]
    assert [p['id'] for p in ada.get('/api/projects').json] == [project['id']]
    assert [f['name'] for f in ada.get('/api/files').json] == ['notes.txt']
    # Another account sees none of it, and cannot open or add to it by id.
    assert bo.get('/api/tasks').json == {'items': [], 'total': 0}
    assert bo.get('/api/projects').json == [] and bo.get('/api/files').json == []
    for path in (f'/api/tasks/{task["id"]}', f'/api/tasks/{task["id"]}/events', f'/api/projects/{project["id"]}'):
        assert bo.get(path).status_code == 404
    assert bo.post(f'/api/tasks/{task["id"]}/messages', json={'content': 'mine now'}).status_code == 404
    assert bo.post('/api/tasks', json={'prompt': 'Join in', 'project_id': project['id']}).status_code == 404
    assert ada.get(f'/api/tasks/{task["id"]}').status_code == 200


def test_a_personal_workspace_works_signed_out_and_keeps_its_chats_apart(tmp_path):
    app = signed_in_app(tmp_path, required=False)
    guest, ada = app.test_client(), as_account(app, 'a')
    local = guest.post('/api/tasks', json={'prompt': 'Made while signed out'}).json
    mine = ada.post('/api/tasks', json={'prompt': 'Made by Ada'}).json
    assert local['owner'] is None and mine['owner'] == 'a'
    assert [t['id'] for t in guest.get('/api/tasks').json['items']] == [local['id']]
    assert [t['id'] for t in ada.get('/api/tasks').json['items']] == [mine['id']]
    assert guest.get(f'/api/tasks/{mine["id"]}').status_code == 404
    assert ada.get(f'/api/tasks/{local["id"]}').status_code == 404


def test_the_owner_takes_a_personal_workspace_and_backs_it_up_on_sign_in(tmp_path):
    database = FakeDatabase()
    app = signed_in_app(tmp_path, required=False, database=database, owner_email='a@example.com')
    earlier = app.state.db.create_task(TaskCreate(prompt='Made before sign-in'))
    # Another account cannot sign in here, so takes nothing.
    assert app.test_client().post('/api/auth/session', json={'id_token': 'google-token-for-account-b'}).status_code == 403
    assert app.state.db.require_task(earlier)['owner'] is None
    app.test_client().post('/api/auth/session', json={'id_token': 'google-token-for-account-a'})
    app.state.cloud.close()
    assert app.state.db.require_task(earlier)['owner'] == 'a'
    assert database.data['users']['a']['profile']['email'] == 'a@example.com'
    chat = database.data['users']['a']['chats'][earlier]
    assert chat['title'] == 'Made before sign-in' and chat['synced_on'] == 'sign-in'
    assert list(database.data['users']['a']['messages'][earlier].values())[0]['content'] == 'Made before sign-in'
    assert app.state.db.require_task(earlier)['cloud_synced_at']


def test_a_hosted_workspace_never_hands_out_earlier_chats(tmp_path):
    hosted = signed_in_app(tmp_path, hosted=True)
    earlier = hosted.state.db.create_task(TaskCreate(prompt='A visitor before sign-in'))
    hosted.test_client().post('/api/auth/session', json={'id_token': 'google-token-for-account-a'})
    assert hosted.state.db.require_task(earlier)['owner'] is None


def test_only_the_verified_owner_is_admin_and_its_email_stays_private(tmp_path):
    hosted = signed_in_app(tmp_path, hosted=True, owner_email='a@example.com')
    ada, bo, lookalike = as_account(hosted, 'a'), as_account(hosted, 'b'), as_account(hosted, 'c')
    assert ada.get('/api/auth/config').json['user']['admin'] is True
    for client in (bo, lookalike):
        config = client.get('/api/auth/config')
        assert config.json['user']['admin'] is False and b'a@example.com' not in config.data
    rule = {'content': 'Fillet every edge'}
    refused = bo.post('/api/rules', json=rule)
    assert refused.status_code == 403 and 'admin' in refused.json['detail'] and 'a@example.com' not in refused.json['detail']
    assert lookalike.post('/api/rules', json=rule).status_code == 403
    assert bo.put('/api/integrations/bambu', json={'machine': 'X1C', 'process': 'Standard', 'filament': 'PLA'}).status_code == 403
    assert bo.delete('/api/integrations/bambu').status_code == 403
    created = ada.post('/api/rules', json=rule)
    assert created.status_code == 201
    assert bo.patch(f"/api/rules/{created.json['id']}", json={'enabled': False}).status_code == 403
    assert bo.delete(f"/api/rules/{created.json['id']}").status_code == 403
    assert bo.get('/api/simulation/status').json['configured'] is False
    assert bo.get('/api/simulation/snapshot').status_code == 403


def test_a_personal_workspace_with_an_admin_is_private_to_it(tmp_path):
    app = signed_in_app(tmp_path, required=False, owner_email='a@example.com')
    ada, bo, guest = as_account(app, 'a'), as_account(app, 'b'), app.test_client()
    # Another account's session counts as signed out, and cannot change the workspace's settings.
    assert bo.get('/api/auth/config').json['user'] is None
    assert guest.post('/api/auth/session', json={'id_token': 'google-token-for-account-c'}).status_code == 403
    for client in (bo, guest):
        assert client.put('/api/integrations/model/choice', json={'model': 'x'}).status_code == 403
        assert client.delete('/api/integrations/onshape').status_code == 403
        assert client.post('/api/schedules', json={'name': 'Nightly', 'prompt': 'Check', 'interval_minutes': 60}).status_code == 403
    job = ada.post('/api/schedules', json={'name': 'Nightly', 'prompt': 'Check', 'interval_minutes': 60})
    assert job.status_code == 201 and job.json['owner'] == 'a'
    assert [s['id'] for s in ada.get('/api/schedules').json] == [job.json['id']]
    assert guest.get('/api/schedules').json == []


class FakeDatabase:
    """Applies multi-path updates to a dict like the Realtime Database; fails every write while .down is set."""
    def __init__(self): self.data, self.updates, self.down = {}, [], False

    def update(self, value):
        if self.down: raise RuntimeError('Realtime Database unavailable')
        self.updates.append(list(value))
        for path, node in value.items():
            *parents, last = path.split('/')
            here = self.data
            for part in parents: here = here.setdefault(part, {})
            here[last] = node


@pytest.mark.asyncio
async def test_a_run_is_copied_to_the_database_when_it_starts_and_when_it_stops(app, task):
    database = FakeDatabase()
    app.state.engine.cloud = cloud = CloudSync(app.state.db, database)
    with app.state.db.transaction() as c:  # history from before this run
        c.execute('UPDATE messages SET created_at=created_at-60 WHERE task_id=?', (task,))
    await app.state.engine.run(app.state.db.claim())
    cloud.close()
    started, finished = database.updates
    assert started[-1] == f'workspace/chats/{task}' and any(p.startswith(f'workspace/messages/{task}/') for p in started)
    chat = database.data['workspace']['chats'][task]
    assert chat['status'] == app.state.db.require_task(task)['status'] and chat['synced_on'] == 'finished'
    assert chat['synced_at'] == {'.sv': 'timestamp'} and chat['counts']['runs'] == 1
    # The finish push sends what the run added (here its questions), not the prompt it already sent.
    prompt = next(p for p in started if '/messages/' in p)
    assert prompt not in finished and any('/messages/' in path for path in finished)
    assert any('/runs/' in path for path in finished)
    assert app.state.db.require_task(task)['cloud_synced_at']


def test_a_failed_push_is_sent_again_by_the_next(app, task):
    database = FakeDatabase()
    cloud = CloudSync(app.state.db, database)
    database.down = True
    assert cloud.push(task, 'started').result() is False
    assert app.state.db.require_task(task)['cloud_synced_at'] is None
    database.down = False
    assert cloud.push(task, 'finished').result() is True
    assert any('/messages/' in path for path in database.updates[0])
    cloud.close()


def test_documents_fit_the_realtime_database():
    doc = document({'id': 'x', 'created_at': 1.5, 'metadata': {'part.stl': [[0, 0]], 'a/b': 1, '': 2}, 'result': {'big': ['y' * 19_000] * 20}})
    # Keys may not hold . $ # [ ] /; they are percent-encoded instead of lost.
    assert doc['metadata'] == {'part%2Estl': [[0, 0]], 'a%2Fb': 1, '_': 2}
    assert key('100%.done') == '100%25%2Edone'
    assert doc['created_at'] == 1.5 and doc['result']['truncated'] is True


def test_chats_whose_copy_never_arrived_are_sent_when_the_server_starts(tmp_path):
    first = signed_in_app(tmp_path, required=False)
    mine = as_account(first, 'a').post('/api/tasks', json={'prompt': 'Made while the database was missing'}).json['id']
    unclaimed = first.state.db.create_task(TaskCreate(prompt='Waits for its owner to sign in'))
    database = FakeDatabase()
    restarted = signed_in_app(tmp_path, required=False, database=database)
    restarted.state.cloud.close()
    assert database.data['users']['a']['chats'][mine]['synced_on'] == 'startup'
    assert restarted.state.db.require_task(mine)['cloud_synced_at']
    assert 'workspace' not in database.data and restarted.state.db.require_task(unclaimed)['cloud_synced_at'] is None
