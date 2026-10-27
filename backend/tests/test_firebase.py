"""Google sign-in (Firebase Auth) and the Realtime Database cloud copy of each chat."""
import base64
import copy
import json
import pytest
from app.config import Settings
from app.firebase import SESSION_COOKIE, CloudSync, Firebase, SignInError, document, key, service_account
from app.main import create_app
from app.models import TaskCreate
from app.rules import TEMPLATES, add_template

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


def _row(node):
    """A row as the copy holds it: the exact SQLite row as JSON text."""
    assert isinstance(node, str)
    return json.loads(node)


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
    assert json.loads(_row(list(database.data['users']['a']['messages'][earlier].values())[0])['content']) == 'Made before sign-in'
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
    """Applies multi-path updates to a dict like the Realtime Database; fails every read and write while .down is set."""
    def __init__(self): self.data, self.updates, self.down = {}, [], False

    def update(self, value):
        if self.down: raise RuntimeError('Realtime Database unavailable')
        self.updates.append(list(value))
        for path, node in value.items():
            *parents, last = path.split('/')
            here = self.data
            for part in parents: here = here.setdefault(part, {})
            if node is None: here.pop(last, None)
            else: here[last] = copy.deepcopy(node)

    def child(self, path): return FakeReference(self, path)


class FakeReference:
    def __init__(self, database, path): self.database, self.path = database, path

    def get(self, shallow=False):
        if self.database.down: raise RuntimeError('Realtime Database unavailable')
        here = self.database.data
        for part in self.path.split('/'):
            if not isinstance(here, dict) or part not in here: return None
            here = here[part]
        if shallow and isinstance(here, dict): return {k: True for k in here}
        # Like the real database, children keyed 0, 1, 2 ... come back as a list (with None for gaps),
        # and a read never hands out the stored objects themselves.
        if isinstance(here, dict) and here and all(k.isdigit() for k in here) and len(here) * 2 > max(map(int, here)):
            return [copy.deepcopy(here.get(str(i))) for i in range(max(map(int, here)) + 1)]
        return copy.deepcopy(here)


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


def _signed_in(app, uid):
    client = app.test_client()
    assert client.post('/api/auth/session', json={'id_token': f'google-token-for-account-{uid}'}).status_code == 200
    return client


def test_a_fresh_server_loads_back_an_accounts_chats_and_memories(tmp_path):
    database = FakeDatabase()
    first = signed_in_app(tmp_path / 'first', required=False, database=database)
    ada = as_account(first, 'a')
    project = ada.post('/api/projects', json={'name': 'Gripper'}).json
    task = ada.post('/api/tasks', json={'prompt': 'Design a tomato gripper', 'project_id': project['id']}).json['id']
    db = first.state.db
    run = db.one('SELECT id FROM runs WHERE task_id=?', (task,))['id']
    with db.transaction() as c:
        c.execute("INSERT INTO tool_calls VALUES('call-1',?,?,'cad','{\"a.b\":1}',NULL,'running',1,NULL)", (task, run))
        c.execute("INSERT INTO memories VALUES('mem-1',?,?,'\"Iris closes evenly\"',2)", (task, project['id']))
    first.state.cloud.push(task, 'started').result()
    first.state.cloud.close()
    assert json.loads(_row(database.data['users']['a']['memories'][task]['mem-1'])['content']) == 'Iris closes evenly'

    fresh = signed_in_app(tmp_path / 'fresh', required=False, database=database)
    _signed_in(fresh, 'a')
    fresh.state.cloud.close()
    detail = as_account(fresh, 'a').get(f'/api/tasks/{task}').json
    assert detail['owner'] == 'a' and detail['title'] == 'Design a tomato gripper' and detail['project_id'] == project['id']
    assert [m['content'] for m in detail['messages']] == ['Design a tomato gripper']
    # Nothing restored is left running: its worker went with the old server.
    assert detail['status'] == 'interrupted' and [r['status'] for r in detail['runs']] == ['interrupted']
    call = fresh.state.db.one('SELECT * FROM tool_calls WHERE id=?', ('call-1',))
    assert call['status'] == 'interrupted' and call['arguments'] == {'a.b': 1}
    assert [m['content'] for m in fresh.state.db.all('SELECT content FROM memories')] == ['Iris closes evenly']
    assert fresh.state.db.one('SELECT name FROM projects WHERE id=?', (project['id'],))['name'] == 'Gripper'
    assert fresh.state.db.claim() is None
    # Another account gets none of it.
    assert as_account(fresh, 'b').get(f'/api/tasks/{task}').status_code == 404


def test_restore_only_adds_what_is_missing(tmp_path):
    database = FakeDatabase()
    app = signed_in_app(tmp_path, required=False, database=database)
    task = as_account(app, 'a').post('/api/tasks', json={'prompt': 'Kept as it is here'}).json['id']
    app.state.cloud.push(task, 'started').result()
    database.data['users']['a']['chats'][task]['title'] = 'Older title in the copy'
    assert app.state.cloud.restore('a').result() == 0
    assert app.state.db.require_task(task)['title'] == 'Kept as it is here'
    app.state.cloud.close()


def test_the_admins_rules_follow_it_to_a_fresh_server(tmp_path):
    database = FakeDatabase()
    first = signed_in_app(tmp_path / 'first', database=database, owner_email='a@example.com')
    ada = _signed_in(first, 'a')
    rule = ada.post('/api/rules', json={'content': 'Walls at least 1.2 mm'}).json
    gone = ada.post('/api/rules', json={'content': 'Forget me'}).json
    ada.delete(f"/api/rules/{gone['id']}")
    first.state.cloud.close()
    assert [r['content'] for r in database.data['users']['a']['rules'].values()] == ['Walls at least 1.2 mm']

    # A fresh server loads them on start, before anyone signs in.
    fresh = signed_in_app(tmp_path / 'fresh', database=database, owner_email='a@example.com')
    fresh.state.cloud.close()
    assert [(r['id'], r['content']) for r in fresh.state.db.all('SELECT id,content FROM rules')] == [(rule['id'], 'Walls at least 1.2 mm')]


def test_a_non_admin_never_touches_the_rules_copy(tmp_path):
    database = FakeDatabase()
    database.data = {'users': {'b': {'rules': {'r1': {'id': 'r1', 'content': 'Not the workspace rules'}}}}}
    # Hosted, so other accounts can sign in; only the admin's account carries the rules.
    app = signed_in_app(tmp_path, database=database, hosted=True, owner_email='a@example.com')
    _signed_in(app, 'b')
    app.state.cloud.close()
    assert app.state.db.all('SELECT * FROM rules') == []
    assert database.data['users']['b']['rules'] == {'r1': {'id': 'r1', 'content': 'Not the workspace rules'}}


def test_rules_are_not_overwritten_when_the_copy_cannot_be_read(tmp_path):
    database = FakeDatabase()
    database.data = {'users': {'a': {'rules': {'r1': {'id': 'r1', 'content': 'Keep me'}}}}}
    database.down = True
    app = signed_in_app(tmp_path, database=database, owner_email='a@example.com')
    ada = _signed_in(app, 'a')
    ada.post('/api/rules', json={'content': 'Made while the database was down'})
    database.down = False
    app.state.cloud.close()
    assert database.data['users']['a']['rules'] == {'r1': {'id': 'r1', 'content': 'Keep me'}}


def test_files_go_up_in_pieces_and_come_back_on_a_fresh_server(tmp_path, monkeypatch):
    monkeypatch.setattr('app.firebase.CHUNK', 4)
    database = FakeDatabase()
    first = signed_in_app(tmp_path / 'first', required=False, database=database)
    task = as_account(first, 'a').post('/api/tasks', json={'prompt': 'Design a gripper'}).json['id']
    part = first.state.store.put(task, None, 'gripper.stl', b'solid gripper\n', {'kind': 'cad', 'part.name': 'jaw'})
    empty = first.state.store.put(task, None, 'notes.txt', b'', {'kind': 'notes'})
    first.state.cloud.push(task, 'finished').result()
    first.state.cloud.close()
    copy_of = database.data['users']['a']
    assert copy_of['stored'][task] == {part['id']: 4, empty['id']: 0} and len(copy_of['blobs'][task][part['id']]) == 4

    fresh = signed_in_app(tmp_path / 'fresh', required=False, database=database)
    fresh.state.cloud.close()
    files = {a['name']: a for a in as_account(fresh, 'a').get(f'/api/tasks/{task}').json['artifacts']}
    assert files['gripper.stl']['metadata'] == {'kind': 'cad', 'part.name': 'jaw'} and files['gripper.stl']['sha256'] == part['sha256']
    assert fresh.state.store.get(task, part['id'])[1].read_bytes() == b'solid gripper\n'
    assert fresh.state.store.get(task, empty['id'])[1].read_bytes() == b''


def test_files_reach_a_chat_that_was_restored_before_them_and_bad_copies_are_skipped(tmp_path):
    database = FakeDatabase()
    first = signed_in_app(tmp_path / 'first', required=False, database=database)
    task = as_account(first, 'a').post('/api/tasks', json={'prompt': 'Design a gripper'}).json['id']
    first.state.cloud.push(task, 'started').result()
    first.state.cloud.close()
    # A server that restored the chat while its files were not in the copy yet.
    fresh = signed_in_app(tmp_path / 'fresh', required=False, database=database)
    fresh.state.cloud.pool.submit(lambda: None).result()  # its startup restore is done
    assert fresh.state.db.all('SELECT id FROM artifacts') == []

    good = first.state.store.put(task, None, 'jaw.stl', b'jaw', {'kind': 'cad'})
    bad = first.state.store.put(task, None, 'base.stl', b'base', {'kind': 'cad'})
    later = CloudSync(first.state.db, database, first.state.settings.data_dir)
    assert later.backfill(task).result() is True
    later.close()
    database.data['users']['a']['blobs'][task][bad['id']]['c0'] = base64.b64encode(b'tampered').decode()
    # Another account's copy of the same chat id is never mixed in.
    database.data['users']['b'] = copy.deepcopy(database.data['users']['a'])

    _signed_in(fresh, 'a')
    fresh.state.cloud.close()
    assert [a['id'] for a in fresh.state.db.all('SELECT id FROM artifacts')] == [good['id']]
    assert fresh.state.store.get(task, good['id'])[1].read_bytes() == b'jaw'


EXACT_TABLES = {'tasks': 'id', 'runs': 'id', 'messages': 'id', 'questionnaires': 'id', 'approvals': 'id', 'artifacts': 'id',
                'tool_calls': 'id', 'memories': 'id', 'rule_checks': 'id', 'task_rule_sets': 'rule_set'}


def _exact_rows(app, task):
    """Every row of the chat as SQLite holds it, but this server's own bookkeeping (sync time, event numbers)."""
    with app.state.db.connect() as c:
        rows = {t: [dict(r) for r in c.execute(f'SELECT * FROM {t} WHERE {"id" if t == "tasks" else "task_id"}=? ORDER BY {k}', (task,))]
                for t, k in EXACT_TABLES.items()}
        rows['events'] = [dict(r) for r in c.execute('SELECT run_id,type,payload,created_at FROM events WHERE task_id=? ORDER BY seq', (task,))]
    rows['tasks'][0].pop('cloud_synced_at')
    return rows


def _full_chat(app):
    """A chat holding every kind of row: a waiting run with its approval, a 300 KB tool result, events, rule
    decisions and checks, a memory, a file and a raw provider log."""
    task = as_account(app, 'a').post('/api/tasks', json={'prompt': 'Design a tomato gripper'}).json['id']
    db, run = app.state.db, app.state.db.one('SELECT id FROM runs WHERE task_id=?', (task,))['id']
    with db.transaction() as c:
        c.execute("UPDATE runs SET status='awaiting_input',checkpoint=?,usage='{\"total_tokens\":12345}' WHERE id=?", ('{"tool_calls":7,"total_tokens":12345}', run))
        c.execute("UPDATE tasks SET status='awaiting_input',plan='[{\"step\":\"Jaw\",\"done\":false}]' WHERE id=?", (task,))
        c.execute("INSERT INTO tool_calls VALUES('call-1',?,?,'build_cad','{\"a.b\":[1,2]}',?,'completed',1.25,2.5)", (task, run, json.dumps({'log': 'x' * 300_000})))
        c.execute("INSERT INTO questionnaires VALUES('q-1',?,?,'Size','[{\"id\":\"w\"}]','{\"w\":\"40 mm\"}','answered',3)", (task, run))
        c.execute("INSERT INTO approvals VALUES('ap-1',?,?,'{\"summary\":\"Print it?\"}',NULL,'pending',4,NULL)", (task, run))
        c.execute("INSERT INTO memories VALUES('mem-1',?,NULL,'\"Iris closes evenly\"',5)", (task,))
        c.execute("INSERT INTO rule_checks VALUES('rc-1',?,?,'r1','passed','Walls 1.4 mm','[\"a1\"]','build-1',6)", (task, run))
        c.execute("INSERT INTO task_rule_sets VALUES(?,'printing',1,'FDM part','model',7)", (task,))
        for i in range(3):
            db.event(c, task, run, 'activity', {'text': f'step {i}', '': None})
    app.state.store.put(task, run, 'jaw.stl', b'solid jaw\n' * 1000, {'kind': 'cad', 'part.name': 'jaw'})
    logs = app.state.settings.data_dir / 'sessions' / task
    logs.mkdir(parents=True)
    (logs / f'{run}.jsonl').write_text('{"kind":"request"}\n' * 500)
    return task, run


def test_a_restored_chat_is_identical_to_the_one_copied(tmp_path, monkeypatch):
    monkeypatch.setattr('app.firebase.CHUNK', 1000)
    database = FakeDatabase()
    first = signed_in_app(tmp_path / 'first', required=False, database=database)
    task, run = _full_chat(first)
    first.state.cloud.push(task, 'started').result()
    first.state.cloud.close()

    fresh = signed_in_app(tmp_path / 'fresh', required=False, database=database)
    fresh.state.cloud.close()
    assert _exact_rows(fresh, task) == _exact_rows(first, task)
    # A run waiting for an approval still waits, to be approved here.
    assert fresh.state.db.require_task(task)['status'] == 'awaiting_input'
    assert (fresh.state.settings.data_dir / 'sessions' / task / f'{run}.jsonl').read_text() == '{"kind":"request"}\n' * 500
    assert (fresh.state.settings.data_dir / 'sessions' / task / 'transcript.md').is_file()


def test_a_lossy_earlier_restore_is_brought_up_to_the_copy(tmp_path):
    database = FakeDatabase()
    first = signed_in_app(tmp_path / 'first', required=False, database=database)
    task, _ = _full_chat(first)
    first.state.cloud.push(task, 'started').result()
    first.state.cloud.close()
    fresh = signed_in_app(tmp_path / 'fresh', required=False, database=database)
    fresh.state.cloud.close()
    # What a restore from the older, readable copy left: a cut tool result, no events, no approval.
    with fresh.state.db.transaction() as c:
        c.execute("UPDATE tool_calls SET result='{\"truncated\":true}' WHERE id='call-1'")
        c.execute('DELETE FROM events WHERE task_id=?', (task,))
        c.execute('DELETE FROM approvals')
    again = signed_in_app(tmp_path / 'fresh', required=False, database=database)
    again.state.cloud.close()
    assert _exact_rows(again, task) == _exact_rows(first, task)


def test_a_chat_with_a_run_going_here_is_never_touched_by_a_restore(tmp_path):
    database = FakeDatabase()
    app = signed_in_app(tmp_path, required=False, database=database)
    task = as_account(app, 'a').post('/api/tasks', json={'prompt': 'Keep going'}).json['id']
    app.state.cloud.push(task, 'started').result()
    with app.state.db.transaction() as c:
        c.execute("UPDATE runs SET status='running' WHERE task_id=?", (task,))
    database.data['users']['a']['chats'][task]['row'] = json.dumps({**_row(database.data['users']['a']['chats'][task]['row']), 'title': 'Changed elsewhere'})
    app.state.cloud.restore('a').result()
    app.state.cloud.close()
    assert app.state.db.require_task(task)['title'] == 'Keep going'
    assert app.state.db.one('SELECT status FROM runs WHERE task_id=?', (task,))['status'] == 'running'


def test_a_rule_deleted_on_one_server_is_deleted_on_the_others(tmp_path):
    database = FakeDatabase()
    first = signed_in_app(tmp_path / 'first', database=database, owner_email='a@example.com')
    ada = _signed_in(first, 'a')
    keep = ada.post('/api/rules', json={'content': 'Walls at least 1.2 mm'}).json
    gone = ada.post('/api/rules', json={'content': 'Forget me everywhere'}).json
    first.state.cloud.pool.submit(lambda: None).result()
    other = signed_in_app(tmp_path / 'other', database=database, owner_email='a@example.com')
    other.state.cloud.pool.submit(lambda: None).result()
    assert {r['id'] for r in other.state.db.all('SELECT id FROM rules')} == {keep['id'], gone['id']}

    ada.delete(f"/api/rules/{gone['id']}")
    first.state.cloud.close()
    # The other server held the rule; on its next sign-in it drops it, and its push does not bring it back.
    _signed_in(other, 'a')
    other.state.cloud.close()
    assert [r['id'] for r in other.state.db.all('SELECT id FROM rules')] == [keep['id']]
    assert list(database.data['users']['a']['rules']) == [keep['id']]


def test_the_same_rules_applied_on_two_servers_are_not_doubled(tmp_path):
    database = FakeDatabase()
    first = signed_in_app(tmp_path / 'first', database=database, owner_email='a@example.com')
    other = signed_in_app(tmp_path / 'other', database=database, owner_email='a@example.com')
    for server in (first, other):  # the same template, applied on each before either saw the other's
        add_template(server.state.db, next(iter(TEMPLATES)))
    # One server's JSON escapes characters the other's keeps as they are; the text is the same.
    with other.state.db.transaction() as c:
        c.execute("UPDATE rules SET content=? WHERE id=(SELECT id FROM rules ORDER BY created_at LIMIT 1)", (json.dumps('Walls ≥ 1.2 mm'),))
    with first.state.db.transaction() as c:
        c.execute("UPDATE rules SET content=? WHERE id=(SELECT id FROM rules ORDER BY created_at LIMIT 1)", (json.dumps('Walls ≥ 1.2 mm', ensure_ascii=False),))
    first.state.cloud.push_rules('a').result()
    count = len(first.state.db.all('SELECT id FROM rules'))
    other.state.cloud.push_rules('a').result()
    first.state.cloud.close(); other.state.cloud.close()
    assert len(other.state.db.all('SELECT id FROM rules')) == count
