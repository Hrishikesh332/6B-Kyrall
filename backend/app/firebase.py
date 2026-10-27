"""Google sign-in (Firebase Auth) and the Realtime Database cloud copy of each chat.

The service account comes only from FIREBASE_SERVICE_ACCOUNT (the key JSON or its base64).
SQLite stays the authority while a run works: the Realtime Database gets a snapshot of a
chat when a run starts and again when it stops, written on one background thread so it never
slows or fails a run.

Realtime Database layout, flat so that listing chats never downloads their messages:
  users/{uid}/profile                        email, name, picture, last_sign_in_at
  users/{uid}/chats/{task_id}                title, status, project, spec, plan, counts, synced_at
  users/{uid}/messages/{task_id}/{id}        role, kind, content, created_at
  users/{uid}/runs/{task_id}/{run_id}        status, error, usage, timings
  users/{uid}/files/{task_id}/{artifact_id}  name, version, size, sha256, metadata (not the bytes)
  users/{uid}/tool_calls/{task_id}/{id}      name, arguments, result, status, timings
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


def native(value):
    if isinstance(value, dict):
        return {key(k): native(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [native(v) for v in value]
    return value


def document(row):
    """One SQLite row as a database node: long text shortened, keys made valid."""
    row = _plain(row)
    for name in JSON_COLUMNS & row.keys():
        text = encode(row[name])
        if len(text) > MAX_FIELD:
            row[name] = {'truncated': True, 'json': text[:MAX_FIELD]}
    return native(row)


class CloudSync:
    """Pushes a chat to the Realtime Database when a run starts and when it stops.

    Pushes run one at a time on a background thread, in the order they were made: each reads the
    chat then writes it as one multi-path update. Only rows added or finished since the chat's
    last successful push (tasks.cloud_synced_at) are written; a failed push leaves them for the next.
    """

    def __init__(self, db, root=None):
        self.db, self.root = db, root
        self.pool = ThreadPoolExecutor(1, thread_name_prefix='6b-cloud') if root is not None else None

    def push(self, task_id, moment):
        return None if self.pool is None else self.pool.submit(self.sync, task_id, moment)

    def save_user(self, user):
        return None if self.pool is None else self.pool.submit(self._save_user, user)

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
        }

    def write(self, snapshot):
        task_id = snapshot['task_id']
        base, tid = (f"users/{key(snapshot['owner'])}" if snapshot['owner'] else 'workspace'), key(task_id)
        updates = {f'{base}/{name}/{tid}/{key(row["id"])}': document(row)
                   for name in ('runs', 'messages', 'files', 'tool_calls') for row in snapshot[name]}
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

    def close(self, wait=True):
        if self.pool is not None:
            self.pool.shutdown(wait=wait)
