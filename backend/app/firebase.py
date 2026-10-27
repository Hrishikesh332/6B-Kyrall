"""Google sign-in (Firebase Auth) and the Realtime Database cloud copy of each chat.

The service account comes only from FIREBASE_SERVICE_ACCOUNT (the key JSON or its base64).
SQLite stays the authority while a run works: the Realtime Database gets a snapshot of a
chat when a run starts and again when it stops, written on one background thread so it never
slows or fails a run. A server whose SQLite lacks a chat (a fresh deploy, a lost volume) loads
it back from the copy on start and when its owner signs in, together with the workspace rules.

Realtime Database layout, flat so that listing chats never downloads their messages:
  users/{uid}/profile                        email, name, picture, last_sign_in_at
  users/{uid}/chats/{task_id}                title, status, project, spec, plan, counts, synced_at
  users/{uid}/messages/{task_id}/{id}        role, kind, content, created_at
  users/{uid}/runs/{task_id}/{run_id}        status, error, usage, timings
  users/{uid}/files/{task_id}/{artifact_id}  name, version, size, sha256, metadata (not the bytes)
  users/{uid}/tool_calls/{task_id}/{id}      name, arguments, result, status, timings
  users/{uid}/memories/{task_id}/{id}        the chat's memories: content, project, created_at
  users/{uid}/rules/{id}                     the workspace rules, as the account that may edit them left them
Chats made while nobody is signed in go under workspace/ in the same shape. Times are Unix
seconds; synced_at is the database server's clock in milliseconds.
"""
import base64
import binascii
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import json
import logging
import time
import uuid
from .db import JSON_COLUMNS, encode
from .sessions import _plain

log = logging.getLogger(__name__)

SESSION_COOKIE = '6b_session'
# Firebase's longest session cookie.
SESSION_TTL = timedelta(days=14)
# Only an ID token from a sign-in this recent becomes a session.
FRESH_SIGN_IN = 300
# Rows written this close to a snapshot are sent again next time, in case their
# transaction committed after the snapshot was read. Writes are idempotent.
SYNC_MARGIN = 5
# One update stays well under the database's 16 MB write limit; one JSON field is cut at this size.
MAX_WRITE = 4_000_000
MAX_FIELD = 200_000
SERVER_TIME = {'.sv': 'timestamp'}
# A restored run cannot still be going: its worker went with the old server.
ACTIVE = ('queued', 'running', 'awaiting_input')
RESTORED = 'The server restarted without this run; restored from the cloud copy. Retry to continue.'
RULE_COLUMNS = ('id', 'content', 'project_id', 'enabled', 'created_at', 'rule_set', 'applies_when', 'level', 'source')


class SignInError(Exception):
    pass


def service_account(raw):
    """The service account from FIREBASE_SERVICE_ACCOUNT: its JSON, or that JSON in base64."""
    raw = (raw or '').strip()
    if not raw:
        return None
    try:
        if not raw.startswith('{'):
            raw = base64.b64decode(raw, validate=True).decode()
        info = json.loads(raw)
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError('FIREBASE_SERVICE_ACCOUNT must be the service account JSON or its base64 encoding') from None
    if not isinstance(info, dict) or info.get('type') != 'service_account' or not info.get('private_key') or not info.get('project_id'):
        raise ValueError('FIREBASE_SERVICE_ACCOUNT is not a Firebase service account key')
    return info


def profile(claims):
    return {'uid': claims['uid'], 'email': claims.get('email', ''), 'email_verified': bool(claims.get('email_verified')),
            'name': claims.get('name', ''), 'picture': claims.get('picture', '')}


class Firebase:
    """The project's Admin SDK app: verifies Google sign-ins and opens the Realtime Database."""

    def __init__(self, settings):
        self.info = service_account(settings.firebase_service_account)
        self.app = None
        if settings.firebase_web_api_key and not self.info:
            # Fail closed: a deployment that asked for sign-in must never start open.
            raise ValueError('FIREBASE_WEB_API_KEY is set without FIREBASE_SERVICE_ACCOUNT; Google sign-in needs both')
        project = (self.info or {}).get('project_id', '')
        self.database_url = settings.firebase_database_url or (f'https://{project}-default-rtdb.firebaseio.com' if project else '')
        if self.info:
            import firebase_admin
            from firebase_admin import credentials
            # Its own named app, so several workspaces in one process never share one.
            self.app = firebase_admin.initialize_app(credentials.Certificate(self.info), {'projectId': project, 'databaseURL': self.database_url},
                                                     name=f'6b-{uuid.uuid4().hex}')
        self.web = {'apiKey': settings.firebase_web_api_key, 'projectId': project, 'appId': settings.firebase_app_id,
                    'authDomain': settings.firebase_auth_domain or (f'{project}.firebaseapp.com' if project else '')}
        self.sign_in = bool(self.app and settings.firebase_web_api_key)
        # Hosted workspaces always need an account; a personal one works signed out too.
        self.required = self.sign_in and (settings.hosted or settings.require_sign_in)
        self.cloud_sync = bool(self.app and settings.cloud_sync)

    def config(self):
        """What the browser needs to show Google sign-in; all of it is public by design."""
        return {'enabled': self.sign_in, 'required': self.required,
                'firebase': {k: v for k, v in self.web.items() if v} if self.sign_in else None}

    def database(self):
        from firebase_admin import db
        return db.reference('/', app=self.app, url=self.database_url) if self.cloud_sync else None

    def start_session(self, id_token):
        """Exchange a fresh Google sign-in's ID token for a session cookie and its profile."""
        from firebase_admin import auth
        from firebase_admin.exceptions import FirebaseError
        try:
            claims = auth.verify_id_token(id_token, app=self.app, clock_skew_seconds=10)
            fresh = claims.get('firebase', {}).get('sign_in_provider') == 'google.com' and time.time() - claims.get('auth_time', 0) <= FRESH_SIGN_IN
            cookie = auth.create_session_cookie(id_token, expires_in=SESSION_TTL, app=self.app) if fresh else None
        except (ValueError, FirebaseError) as exc:
            raise SignInError('Google sign-in could not be verified. Try again.') from exc
        if not cookie:
            raise SignInError('Sign in with Google again to continue.')
        return cookie, profile(claims)

    def user(self, cookie):
        """The Google account behind a session cookie, or None when it is missing, expired or forged."""
        if not (self.sign_in and cookie):
            return None
        from firebase_admin import auth
        from firebase_admin.exceptions import FirebaseError
        try:
            return profile(auth.verify_session_cookie(cookie, app=self.app, clock_skew_seconds=10))
        except (ValueError, FirebaseError):
            return None

    def close(self):
        if self.app:
            import firebase_admin
            firebase_admin.delete_app(self.app)
            self.app = None


def key(name):
    """A Realtime Database key: the characters it forbids (. $ # [ ] /) percent-encoded, never empty."""
    name = ''.join(f'%{ord(c):02X}' if c in '.$#[]/%' or ord(c) < 32 or ord(c) == 127 else c for c in str(name))
    return name[:700] or '_'


def unkey(name):
    """The name a key() was made from (apart from its 700-character cut)."""
    out, i = [], 0
    while i < len(name):
        if name[i] == '%' and i + 2 < len(name) and all(c in '0123456789ABCDEF' for c in name[i + 1:i + 3]):
            out.append(chr(int(name[i + 1:i + 3], 16)))
            i += 3
        else:
            out.append(name[i])
            i += 1
    return ''.join(out)


def native(value):
    if isinstance(value, dict):
        return {key(k): native(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [native(v) for v in value]
    return value


def restored(value):
    """A node read back from the database, its keys as they were before key()."""
    if isinstance(value, dict):
        return {unkey(k): restored(v) for k, v in value.items()}
    if isinstance(value, list):
        return [restored(v) for v in value]
    return value


def base_path(owner):
    return f'users/{key(owner)}' if owner else 'workspace'


def as_json(value, default):
    # The database drops empty objects, empty lists and nulls, so a missing field had one of those.
    return encode(default if value is None else value)


def document(row):
    """One SQLite row as a database node: long text shortened, keys made valid."""
    row = _plain(row)
    for name in JSON_COLUMNS & row.keys():
        text = encode(row[name])
        if len(text) > MAX_FIELD:
            row[name] = {'truncated': True, 'json': text[:MAX_FIELD]}
    return native(row)


class CloudSync:
    """Pushes a chat to the Realtime Database when a run starts and when it stops, and loads back
    the chats and rules this server's SQLite is missing.

    Work runs one at a time on a background thread, in the order it was asked for: each push reads
    the chat then writes it as one multi-path update. Only rows added or finished since the chat's
    last successful push (tasks.cloud_synced_at) are written; a failed push leaves them for the next.
    Restores only ever add what is missing locally, so they never overwrite newer work here.
    """

    def __init__(self, db, root=None):
        self.db, self.root = db, root
        self.pool = ThreadPoolExecutor(1, thread_name_prefix='6b-cloud') if root is not None else None
        # Rule copies loaded back in this process: only these are safe to overwrite with ours.
        self.rules_loaded = set()

    def _submit(self, fn, *args):
        return None if self.pool is None else self.pool.submit(fn, *args)

    def push(self, task_id, moment):
        return self._submit(self.sync, task_id, moment)

    def save_user(self, user):
        return self._submit(self._save_user, user)

    def push_rules(self, owner):
        """Replace the account's copy of the workspace rules with this server's."""
        return self._submit(self._push_rules, owner)

    def restore(self, owner, rules=False):
        """Load back the account's chats missing here, and its rules when it may edit them."""
        return self._submit(self._restore, owner, rules)

    def restore_all(self, rules_email=None, workspace_rules=False):
        """On start: every account's missing chats, and the rules of the admin (by email) or of the
        signed-out workspace."""
        return self._submit(self._restore_all, rules_email, workspace_rules)

    def sync(self, task_id, moment):
        try:
            snapshot = self.snapshot(task_id, moment)
        except Exception:  # noqa: BLE001 - the cloud copy must never fail a run
            log.exception('Could not read chat %s for the cloud copy', task_id)
            return False
        return self.write(snapshot)

    def snapshot(self, task_id, moment):
        at = time.time()
        task = self.db.require_task(task_id)
        since = task.get('cloud_synced_at') or 0
        rows = lambda sql: self.db.all(sql, (task_id, since))
        project = self.db.one('SELECT name FROM projects WHERE id=?', (task['project_id'],)) if task['project_id'] else None
        counts = self.db.one('SELECT (SELECT COUNT(*) FROM runs WHERE task_id=:t) AS runs,(SELECT COUNT(*) FROM messages WHERE task_id=:t) AS messages,'
                             '(SELECT COUNT(*) FROM artifacts WHERE task_id=:t) AS files,(SELECT COUNT(*) FROM tool_calls WHERE task_id=:t) AS tool_calls',
                             {'t': task_id})
        chat = {k: task[k] for k in ('id', 'title', 'status', 'project_id', 'context_scope', 'approval_policy', 'spec', 'plan', 'created_at', 'updated_at')}
        chat.update(project_name=project and project['name'], archived=bool(task['archived']), counts=counts)
        return {
            'task_id': task_id, 'owner': task.get('owner'), 'at': at, 'moment': moment, 'chat': chat,
            'runs': self.db.all('SELECT id,status,error,usage,created_at,started_at,finished_at FROM runs WHERE task_id=? ORDER BY created_at', (task_id,)),
            'messages': rows('SELECT id,run_id,role,kind,content,created_at FROM messages WHERE task_id=? AND created_at>? ORDER BY created_at'),
            'files': rows('SELECT id,run_id,name,version,media_type,size,sha256,metadata,created_at FROM artifacts WHERE task_id=? AND created_at>?'),
            'tool_calls': rows('SELECT id,run_id,name,arguments,result,status,started_at,finished_at FROM tool_calls '
                               'WHERE task_id=? AND COALESCE(finished_at,started_at)>?'),
            # Memories can be edited or forgotten later, so the chat's whole set is sent each time.
            'memories': self.db.all('SELECT id,project_id,content,created_at FROM memories WHERE task_id=? ORDER BY created_at', (task_id,)),
        }

    def write(self, snapshot):
        task_id = snapshot['task_id']
        base, tid = base_path(snapshot['owner']), key(task_id)
        updates = {f'{base}/{name}/{tid}/{key(row["id"])}': document(row)
                   for name in ('runs', 'messages', 'files', 'tool_calls') for row in snapshot[name]}
        updates[f'{base}/memories/{tid}'] = {key(m['id']): document(m) for m in snapshot['memories']} or None
        # The chat's summary goes last, so it is marked synced only once its rows are in.
        updates[f'{base}/chats/{tid}'] = {**document(snapshot['chat']), 'synced_at': SERVER_TIME, 'synced_on': snapshot['moment']}
        try:
            part, size = {}, 0
            for path, value in updates.items():
                length = len(encode(value))
                if part and size + length > MAX_WRITE:
                    self.root.update(part)
                    part, size = {}, 0
                part[path], size = value, size + length
            self.root.update(part)
        except Exception as exc:  # noqa: BLE001 - logged; the next push sends these rows again
            log.warning('Cloud copy of chat %s (%s) failed: %s', task_id, snapshot['moment'], exc)
            return False
        with self.db.transaction() as c:
            c.execute('UPDATE tasks SET cloud_synced_at=MAX(COALESCE(cloud_synced_at,0),?) WHERE id=?', (snapshot['at'] - SYNC_MARGIN, task_id))
        return True

    def _save_user(self, user):
        try:
            self.root.update({f"users/{key(user['uid'])}/profile": {'email': user['email'], 'name': user['name'],
                                                                    'picture': user['picture'], 'last_sign_in_at': SERVER_TIME}})
        except Exception as exc:  # noqa: BLE001 - signing in never waits on the cloud copy
            log.warning('Cloud copy of user %s failed: %s', user['uid'], exc)
            return False
        return True

    def _push_rules(self, owner):
        base = base_path(owner)
        # Never replace a copy this server has not read: a fresh server would wipe it with nothing.
        if base not in self.rules_loaded and not self._restore_rules(base):
            return False
        rules = self.db.all(f"SELECT {','.join(RULE_COLUMNS)} FROM rules ORDER BY created_at")
        try:
            self.root.update({f'{base}/rules': {key(r['id']): document(r) for r in rules} or None})
        except Exception as exc:  # noqa: BLE001 - the next rule change or sign-in sends them again
            log.warning('Cloud copy of the rules for %s failed: %s', base, exc)
            return False
        return True

    def _restore_all(self, rules_email, workspace_rules):
        try:
            owners = [unkey(k) for k in (self.root.child('users').get(shallow=True) or {})]
        except Exception as exc:  # noqa: BLE001 - each account is loaded again when it signs in
            log.warning('Could not list the cloud copy to restore it: %s', exc)
            return 0
        restored_count = self._restore(None, workspace_rules)
        for owner in owners:
            rules = False
            if rules_email:
                try:
                    email = (self.root.child(f'{base_path(owner)}/profile/email').get() or '').lower()
                except Exception:  # noqa: BLE001
                    email = ''
                rules = email == rules_email
            restored_count += self._restore(owner, rules)
        return restored_count

    def _restore(self, owner, rules):
        base, count = base_path(owner), 0
        try:
            chats = self.root.child(f'{base}/chats').get() or {}
        except Exception as exc:  # noqa: BLE001 - logged; the next sign-in or start tries again
            log.warning('Could not read the cloud copy of %s: %s', base, exc)
            chats = {}
        local = {r['id'] for r in self.db.all('SELECT id FROM tasks')}
        for tid, chat in chats.items():
            task_id = unkey(tid)
            if task_id in local or not isinstance(chat, dict):
                continue
            try:
                rows = {name: self.root.child(f'{base}/{name}/{tid}').get() or {}
                        for name in ('runs', 'messages', 'tool_calls', 'memories')}
                self._insert_chat(task_id, owner, restored(chat), {n: list(restored(v).values()) for n, v in rows.items()})
                count += 1
            except Exception:  # noqa: BLE001 - one damaged chat must not stop the others
                log.exception('Could not restore chat %s from the cloud copy', task_id)
        if rules:
            self._restore_rules(base)
        if count:
            log.info('Restored %d chat(s) from the cloud copy of %s', count, base)
        return count

    def _insert_chat(self, task_id, owner, chat, rows):
        now = time.time()
        with self.db.transaction() as c:
            project = chat.get('project_id')
            if project and not c.execute('SELECT 1 FROM projects WHERE id=?', (project,)).fetchone():
                # Projects are not copied; the chat brings back a project of the same id and name.
                c.execute('INSERT INTO projects(id,name,created_at,owner) VALUES(?,?,?,?)',
                          (project, chat.get('project_name') or 'Restored project', chat.get('created_at') or now, owner))
            status = chat.get('status') or 'completed'
            c.execute('INSERT OR IGNORE INTO tasks(id,title,project_id,context_scope,status,plan,spec,archived,approval_policy,'
                      'owner,created_at,updated_at,cloud_synced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                      (task_id, chat.get('title') or 'Restored chat', project, chat.get('context_scope') or 'isolated',
                       'interrupted' if status in ACTIVE else status, as_json(chat.get('plan'), []), as_json(chat.get('spec'), {}),
                       int(bool(chat.get('archived'))), chat.get('approval_policy') or 'ask', owner,
                       chat.get('created_at') or now, chat.get('updated_at') or now, now))
            runs = set()
            for r in rows['runs']:
                active = r.get('status') in ACTIVE
                c.execute('INSERT OR IGNORE INTO runs(id,task_id,status,usage,error,created_at,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?)',
                          (r['id'], task_id, 'interrupted' if active else r.get('status') or 'completed', as_json(r.get('usage'), {}),
                           RESTORED if active else r.get('error'), r.get('created_at') or now, r.get('started_at'),
                           (r.get('finished_at') or now) if active else r.get('finished_at')))
                runs.add(r['id'])
            for m in rows['messages']:
                c.execute('INSERT OR IGNORE INTO messages(id,task_id,run_id,role,kind,content,created_at) VALUES(?,?,?,?,?,?,?)',
                          (m['id'], task_id, m.get('run_id'), m.get('role') or 'assistant', m.get('kind') or 'text',
                           as_json(m.get('content'), ''), m.get('created_at') or now))
            for t in rows['tool_calls']:
                if t.get('run_id') not in runs:
                    continue
                active = t.get('status') in ('running', 'queued')
                c.execute('INSERT OR IGNORE INTO tool_calls(id,task_id,run_id,name,arguments,result,status,started_at,finished_at) '
                          'VALUES(?,?,?,?,?,?,?,?,?)',
                          (t['id'], task_id, t['run_id'], t.get('name') or 'tool', as_json(t.get('arguments'), {}),
                           None if t.get('result') is None else encode(t['result']), 'interrupted' if active else t.get('status') or 'completed',
                           t.get('started_at') or now, t.get('finished_at')))
            for m in rows['memories']:
                c.execute('INSERT OR IGNORE INTO memories(id,task_id,project_id,content,created_at) VALUES(?,?,?,?,?)',
                          (m['id'], task_id, project, as_json(m.get('content'), ''), m.get('created_at') or now))

    def _restore_rules(self, base):
        try:
            rules = restored(self.root.child(f'{base}/rules').get() or {})
        except Exception as exc:  # noqa: BLE001 - logged; the rules stay as they are here
            log.warning('Could not read the cloud copy of the rules for %s: %s', base, exc)
            return False
        with self.db.transaction() as c:
            for r in rules.values():
                project = r.get('project_id')
                # A project rule whose project is not here would otherwise apply everywhere.
                if project and not c.execute('SELECT 1 FROM projects WHERE id=?', (project,)).fetchone():
                    continue
                c.execute(f"INSERT OR IGNORE INTO rules({','.join(RULE_COLUMNS)}) VALUES(?,?,?,?,?,?,?,?,?)",
                          (r['id'], as_json(r.get('content'), ''), project, int(r.get('enabled', 1)), r.get('created_at') or time.time(),
                           r.get('rule_set') or '', r.get('applies_when') or '', r.get('level') or 'must', r.get('source') or ''))
        self.rules_loaded.add(base)
        return True

    def close(self, wait=True):
        if self.pool is not None:
            self.pool.shutdown(wait=wait)
