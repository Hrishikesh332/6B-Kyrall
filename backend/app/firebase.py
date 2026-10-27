"""Google sign-in (Firebase Auth) and the Realtime Database cloud copy of each chat.

The service account comes only from FIREBASE_SERVICE_ACCOUNT (the key JSON or its base64).
SQLite stays the authority while a run works: the Realtime Database gets a snapshot of a
chat when a run starts and again when it stops, written on one background thread so it never
slows or fails a run. A server whose SQLite lacks a chat (a fresh deploy, a lost volume) loads
it back from the copy on start and when its owner signs in, together with the workspace rules.

Realtime Database layout, flat so that listing chats never downloads their messages. Rows are
the exact SQLite row as JSON text (exact()), so a restored chat is identical to the one copied:
  users/{uid}/profile                        email, name, picture, last_sign_in_at
  users/{uid}/chats/{task_id}                title, status, project, counts, synced_at; row (the task), format
  users/{uid}/projects/{project_id}          the chat's project
  users/{uid}/{table}/{task_id}/{key}        the chat's runs, messages, events, questionnaires, approvals,
                                             files (artifact rows), tool_calls, memories, rule_checks, rule_sets
  users/{uid}/blobs/{task_id}/{artifact_id}  a file's bytes in base64 pieces c0, c1, ... of CHUNK bytes each
  users/{uid}/stored/{task_id}/{artifact_id} how many pieces the file has, written once they all are
  users/{uid}/logs/{task_id}/{run_id}        a run's raw provider log (sessions/), in pieces like a file
  users/{uid}/logged/{task_id}/{run_id}      its pieces, size and sha256, written once they all are
  users/{uid}/rules/{id}                     the workspace rules, as the account that may edit them left them
  users/{uid}/rules_deleted/{id}             when a rule was deleted; every server drops it and never sends it back
Chats copied before format 2 hold readable rows instead (long text cut); they still restore, as before.
Chats made while nobody is signed in go under workspace/ in the same shape. Times are Unix
seconds; synced_at is the database server's clock in milliseconds.
"""
import base64
import binascii
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import hashlib
import json
import logging
from pathlib import Path
import re
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
# A file's bytes go up in pieces this large, far under the database's 10 MB string limit.
CHUNK = 1_000_000
# What ArtifactStore accepts; a restored file is written only under a name and id like these.
FILE_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,149}')
FILE_ID = re.compile(r'[A-Za-z0-9_-]{1,64}')
SERVER_TIME = {'.sv': 'timestamp'}
# 2: every row is copied exactly, with the chat's events, questions, approvals and rule decisions, and
# the bytes of its files and raw provider logs. A chat whose copy is older is sent whole on start.
FORMAT = 2
# The chat's tables in the copy: node, SQLite table, key column, and for rows that never change once
# written, what says when (so a push sends only the new ones); None sends them all every time.
CHAT_TABLES = (('runs', 'runs', 'id', None), ('messages', 'messages', 'id', 'created_at'),
               ('events', 'events', 'seq', 'created_at'), ('questionnaires', 'questionnaires', 'id', None),
               ('approvals', 'approvals', 'id', None), ('files', 'artifacts', 'id', 'created_at'),
               ('tool_calls', 'tool_calls', 'id', 'COALESCE(finished_at,started_at)'),
               ('rule_checks', 'rule_checks', 'id', None), ('rule_sets', 'task_rule_sets', 'rule_set', None))
# A restored run cannot still be going: its worker went with the old server.
ACTIVE = ('queued', 'running', 'awaiting_input')
# Exact copies keep a run that waits for an answer or approval: it has no worker to lose.
RUNNING = ('queued', 'running')
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


def exact(row):
    """A SQLite row as JSON text with every value as stored, which a restore writes back unchanged."""
    return json.dumps(row, separators=(',', ':'), ensure_ascii=False)


def pieces(path, data):
    """(path/c0, base64), (path/c1, ...): data in CHUNK-byte pieces."""
    return ((f'{path}/c{i // CHUNK}', base64.b64encode(data[i:i + CHUNK]).decode()) for i in range(0, len(data), CHUNK))


def values(node):
    """A node's children. The database hands back children keyed 0, 1, 2 ... (event numbers) as a list."""
    if isinstance(node, dict):
        return list(node.values())
    return [v for v in node if v is not None] if isinstance(node, list) else []


def joined(parts, count):
    return b''.join(base64.b64decode(parts[f'c{i}']) for i in range(count))


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
    the chat then writes it as multi-path updates. Rows are copied exactly (exact()), so a restored
    chat is the same row for row. Rows that can still change are sent on every push; the others only
    when added or finished since the chat's last successful push (tasks.cloud_synced_at), so a failed
    push leaves them for the next. With the data folder given, the bytes of the chat's files and its
    raw provider logs are copied too, each listed under stored/ or logged/ once all its pieces are in.
    Restores add what is missing here and bring rows up to the copy, but never touch a chat changed
    here after its copy was made.
    """

    def __init__(self, db, root=None, data_dir=None):
        self.db, self.root = db, root
        self.data_dir = Path(data_dir).resolve() if data_dir is not None else None
        self.files = self.data_dir / 'artifacts' if self.data_dir else None
        self.logs = self.data_dir / 'sessions' if self.data_dir else None
        self.pool = ThreadPoolExecutor(1, thread_name_prefix='6b-cloud') if root is not None else None
        self.columns = {}

    def _submit(self, fn, *args):
        return None if self.pool is None else self.pool.submit(fn, *args)

    def push(self, task_id, moment):
        return self._submit(self.sync, task_id, moment)

    def backfill(self, task_id):
        """On start: send the whole chat when its copy is missing or older than FORMAT, then any file
        or log bytes the copy does not hold yet."""
        return self._submit(self._backfill, task_id)

    def save_user(self, user):
        return self._submit(self._save_user, user)

    def push_rules(self, owner, deleted=()):
        """Replace the account's copy of the workspace rules with this server's. Deleted rules are
        remembered in the copy (rules_deleted/), so no other server brings them back."""
        return self._submit(self._push_rules, owner, tuple(deleted))

    def restore(self, owner, rules=False):
        """Load back the account's chats missing here, and its rules when it may edit them."""
        return self._submit(self._restore, owner, rules)

    def restore_all(self, rules_email=None, workspace_rules=False):
        """On start: every account's missing chats, and the rules of the admin (by email) or of the
        signed-out workspace."""
        return self._submit(self._restore_all, rules_email, workspace_rules)

    def sync(self, task_id, moment, full=False):
        try:
            snapshot = self.snapshot(task_id, moment, full)
        except Exception:  # noqa: BLE001 - the cloud copy must never fail a run
            log.exception('Could not read chat %s for the cloud copy', task_id)
            return False
        return self.write(snapshot) and self._push_bytes(task_id)

    def _raw(self, sql, args=()):
        """Rows exactly as SQLite holds them: JSON columns stay text, nothing is decoded."""
        with self.db.connect() as c:
            return [dict(r) for r in c.execute(sql, args).fetchall()]

    def _tables(self):
        return {r['name'] for r in self._raw("SELECT name FROM sqlite_master WHERE type='table'")}

    def snapshot(self, task_id, moment, full=False):
        at = time.time()
        task = self.db.require_task(task_id)
        since = 0 if full else task.get('cloud_synced_at') or 0
        row = self._raw('SELECT * FROM tasks WHERE id=?', (task_id,))[0]
        row.pop('cloud_synced_at', None)  # this server's own bookkeeping
        project = self._raw('SELECT * FROM projects WHERE id=?', (task['project_id'],)) if task['project_id'] else []
        counts = self.db.one('SELECT (SELECT COUNT(*) FROM runs WHERE task_id=:t) AS runs,(SELECT COUNT(*) FROM messages WHERE task_id=:t) AS messages,'
                             '(SELECT COUNT(*) FROM artifacts WHERE task_id=:t) AS files,(SELECT COUNT(*) FROM tool_calls WHERE task_id=:t) AS tool_calls',
                             {'t': task_id})
        chat = {k: task[k] for k in ('id', 'title', 'status', 'project_id', 'context_scope', 'approval_policy', 'spec', 'plan', 'created_at', 'updated_at')}
        chat.update(project_name=project[0]['name'] if project else None, archived=bool(task['archived']), counts=counts)
        tables, rows = self._tables(), {}
        for name, table, column, changed in CHAT_TABLES:
            if table not in tables:
                rows[name] = []
            elif changed:
                rows[name] = self._raw(f'SELECT * FROM {table} WHERE task_id=? AND {changed}>? ORDER BY {column}', (task_id, since))
            else:
                rows[name] = self._raw(f'SELECT * FROM {table} WHERE task_id=? ORDER BY {column}', (task_id,))
        return {'task_id': task_id, 'owner': task.get('owner'), 'at': at, 'moment': moment, 'chat': chat, 'row': row,
                'project': project[0] if project else None, 'rows': rows,
                # Memories can be edited or forgotten later, so the chat's whole set is sent each time.
                'memories': self._raw('SELECT * FROM memories WHERE task_id=? ORDER BY created_at', (task_id,))}

    def write(self, snapshot):
        task_id = snapshot['task_id']
        base, tid = base_path(snapshot['owner']), key(task_id)
        updates = [(f'{base}/{name}/{tid}/{key(row[column])}', exact(row))
                   for name, _, column, _ in CHAT_TABLES for row in snapshot['rows'][name]]
        updates.append((f'{base}/memories/{tid}', {key(m['id']): exact(m) for m in snapshot['memories']} or None))
        if snapshot['project']:
            updates.append((f"{base}/projects/{key(snapshot['project']['id'])}", exact(snapshot['project'])))
        # The chat's summary goes last, so it is marked synced only once its rows are in.
        updates.append((f'{base}/chats/{tid}', {**document(snapshot['chat']), 'row': exact(snapshot['row']), 'format': FORMAT,
                                                'synced_at': SERVER_TIME, 'synced_on': snapshot['moment']}))
        try:
            self._send(updates)
        except Exception as exc:  # noqa: BLE001 - logged; the next push sends these rows again
            log.warning('Cloud copy of chat %s (%s) failed: %s', task_id, snapshot['moment'], exc)
            return False
        with self.db.transaction() as c:
            c.execute('UPDATE tasks SET cloud_synced_at=MAX(COALESCE(cloud_synced_at,0),?) WHERE id=?', (snapshot['at'] - SYNC_MARGIN, task_id))
        return True

    def _send(self, updates):
        """Write (path, value) pairs in order, as multi-path updates of at most MAX_WRITE bytes."""
        part, size = {}, 0
        for path, value in updates:
            length = len(encode(value))
            if part and size + length > MAX_WRITE:
                self.root.update(part)
                part, size = {}, 0
            part[path], size = value, size + length
        if part:
            self.root.update(part)

    def _backfill(self, task_id):
        try:
            task = self.db.require_task(task_id)
            copied = self.root.child(f"{base_path(task.get('owner'))}/chats/{key(task_id)}/format").get()
        except Exception as exc:  # noqa: BLE001 - logged; the next start tries again
            log.warning('Could not check the cloud copy of chat %s: %s', task_id, exc)
            return False
        if copied != FORMAT:
            return self.sync(task_id, 'startup', full=True)
        return self._push_bytes(task_id)

    def _push_bytes(self, task_id):
        """Send the chat's files the copy does not list under stored/, and its raw provider logs
        that grew since they were last sent; the pieces always before the entry that lists them."""
        if self.data_dir is None:
            return True
        try:
            task = self.db.require_task(task_id)
            base, tid = base_path(task.get('owner')), key(task_id)
            stored = self.root.child(f'{base}/stored/{tid}').get(shallow=True) or {}
            for row in self._raw('SELECT * FROM artifacts WHERE task_id=? ORDER BY created_at', (task_id,)):
                aid, path = key(row['id']), (self.files / row['path']).resolve()
                if aid in stored or not path.is_relative_to(self.files) or not path.is_file():
                    continue
                data = path.read_bytes()
                if hashlib.sha256(data).hexdigest() != row['sha256']:
                    log.warning('Not copying file %s of chat %s: it no longer matches its checksum', row['id'], task_id)
                    continue
                self._send([*pieces(f'{base}/blobs/{tid}/{aid}', data), (f'{base}/files/{tid}/{aid}', exact(row)),
                            (f'{base}/stored/{tid}/{aid}', -(-len(data) // CHUNK))])
            folder = self.logs / task_id
            if folder.is_dir():
                logged = self.root.child(f'{base}/logged/{tid}').get() or {}
                for path in sorted(folder.glob('*.jsonl')):
                    rk = key(path.stem)
                    if (logged.get(rk) or {}).get('size') == path.stat().st_size:
                        continue
                    data = path.read_bytes()
                    self._send([*pieces(f'{base}/logs/{tid}/{rk}', data),
                                (f'{base}/logged/{tid}/{rk}', {'pieces': -(-len(data) // CHUNK), 'size': len(data),
                                                               'sha256': hashlib.sha256(data).hexdigest()})])
        except Exception as exc:  # noqa: BLE001 - logged; the next push or start sends the rest
            log.warning('Cloud copy of the files of chat %s failed: %s', task_id, exc)
            return False
        return True

    def _save_user(self, user):
        try:
            self.root.update({f"users/{key(user['uid'])}/profile": {'email': user['email'], 'name': user['name'],
                                                                    'picture': user['picture'], 'last_sign_in_at': SERVER_TIME}})
        except Exception as exc:  # noqa: BLE001 - signing in never waits on the cloud copy
            log.warning('Cloud copy of user %s failed: %s', user['uid'], exc)
            return False
        return True

    def _push_rules(self, owner, deleted=()):
        base = base_path(owner)
        try:
            if deleted:
                self.root.update({f'{base}/rules_deleted/{key(r)}': time.time() for r in deleted})
        except Exception as exc:  # noqa: BLE001 - the copy keeps the rule until the next delete or sign-in
            log.warning('Cloud copy of the rules for %s failed: %s', base, exc)
            return False
        # Never replace a copy this server has not read: a fresh server would wipe it with nothing.
        # Reading it first also drops the rules other servers deleted since.
        if not self._restore_rules(base):
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
        base, count, copied, files = base_path(owner), 0, 0, 0
        try:
            chats = self.root.child(f'{base}/chats').get() or {}
        except Exception as exc:  # noqa: BLE001 - logged; the next sign-in or start tries again
            log.warning('Could not read the cloud copy of %s: %s', base, exc)
            chats = {}
        local = {r['id']: r for r in self._raw('SELECT id,owner,updated_at FROM tasks')}
        busy = {r['task_id'] for r in self._raw(f"SELECT task_id FROM runs WHERE status IN ({','.join('?' * len(RUNNING))})", RUNNING)}
        for tid, chat in chats.items():
            task_id = unkey(tid)
            here = local.get(task_id)
            # A chat with a run going here is this server's to write; another's copy must not touch it.
            if not isinstance(chat, dict) or (here and (here['owner'] != owner or task_id in busy)):
                continue
            changed = 0
            try:
                if isinstance(chat.get('row'), str):
                    changed = self._apply(base, tid, task_id, owner, chat, here)
                elif not here:
                    rows = {name: self.root.child(f'{base}/{name}/{tid}').get() or {}
                            for name in ('runs', 'messages', 'tool_calls', 'memories')}
                    self._insert_chat(task_id, owner, restored(chat), {n: list(restored(v).values()) for n, v in rows.items()})
                if not here:
                    count += 1
            except Exception:  # noqa: BLE001 - one damaged chat must not stop the others
                log.exception('Could not restore chat %s from the cloud copy', task_id)
                continue
            # Also for chats already here: an earlier restore may have come before their files did.
            added = self._restore_bytes(base, tid, task_id)
            files, copied = files + added, copied + changed
            if self.data_dir and (added or changed or not here):
                from .sessions import save
                save(self.db, self.data_dir, task_id)  # the stored transcript, rebuilt from the restored rows
        if rules:
            self._restore_rules(base)
        if count or copied or files:
            log.info('Restored %d chat(s), %d row(s) and %d file(s) from the cloud copy of %s', count, copied, files, base)
        return count

    def _columns(self, c, table):
        if table not in self.columns:
            self.columns[table] = [r[1] for r in c.execute(f'PRAGMA table_info({table})')]
        return self.columns[table]

    def _put(self, c, table, row, keys, replace):
        """Insert the row, or with replace bring the row here up to it; 1 when anything changed."""
        names = [n for n in self._columns(c, table) if n in row]
        where = ' AND '.join(f'{k}=?' for k in keys)
        here = c.execute(f"SELECT {','.join(names)} FROM {table} WHERE {where}", [row[k] for k in keys]).fetchone()
        if here is None:
            c.execute(f"INSERT INTO {table}({','.join(names)}) VALUES({','.join('?' * len(names))})", [row[n] for n in names])
            return 1
        if not replace or tuple(here) == tuple(row[n] for n in names):
            return 0
        c.execute(f"UPDATE {table} SET {','.join(f'{n}=?' for n in names)} WHERE {where}", [row[n] for n in names] + [row[k] for k in keys])
        return 1

    def _apply(self, base, tid, task_id, owner, chat, here):
        """Bring this server's copy of the chat to the cloud's, row for row, from its exact rows. A chat
        changed here after the copy was made keeps what it has and only gains the rows it lacks."""
        task = json.loads(chat['row'])
        replace = not here or here['updated_at'] <= task['updated_at']
        nodes = {name: self.root.child(f'{base}/{name}/{tid}').get() or {} for name, *_ in CHAT_TABLES if name != 'files'}
        nodes['memories'] = self.root.child(f'{base}/memories/{tid}').get() or {}
        rows = {name: sorted((json.loads(v) for v in values(node) if isinstance(v, str)), key=lambda r: r.get('seq') or 0)
                for name, node in nodes.items()}
        project = None
        if task.get('project_id'):
            node = self.root.child(f"{base}/projects/{key(task['project_id'])}").get()
            project = json.loads(node) if isinstance(node, str) else {'id': task['project_id'], 'name': chat.get('project_name') or 'Restored project',
                                                                       'created_at': task.get('created_at') or time.time()}
        now, changed = time.time(), 0
        with self.db.transaction() as c:
            if project and not c.execute('SELECT 1 FROM projects WHERE id=?', (project['id'],)).fetchone():
                changed += self._put(c, 'projects', {**project, 'owner': owner}, ('id',), False)
            # A run that was going cannot still be: its worker went with the server that ran it. A run
            # waiting for an answer or approval stays waiting, to be answered here.
            task['owner'] = owner
            if here is None:
                task['cloud_synced_at'] = now  # this server's own bookkeeping: the copy already has it all
            if task.get('status') in RUNNING:
                task['status'] = 'interrupted'
            changed += self._put(c, 'tasks', task, ('id',), replace)
            runs = set()
            for r in rows['runs']:
                if r.get('status') in RUNNING:
                    r.update(status='interrupted', error=RESTORED, lease_until=None, finished_at=r.get('finished_at') or now)
                changed += self._put(c, 'runs', r, ('id',), replace)
                runs.add(r['id'])
            runs |= {r[0] for r in c.execute('SELECT id FROM runs WHERE task_id=?', (task_id,))}
            for name, table, column, _ in CHAT_TABLES:
                if name in ('runs', 'files', 'events'):
                    continue
                for r in rows[name]:
                    if table in ('questionnaires', 'approvals', 'tool_calls') and r.get('run_id') not in runs:
                        continue
                    if table == 'tool_calls' and r.get('status') in RUNNING:
                        r['status'] = 'interrupted'
                    changed += self._put(c, table, r, ('task_id', column) if table == 'task_rule_sets' else (column,), replace)
            memories = {m['id'] for m in rows['memories']}
            for m in rows['memories']:
                changed += self._put(c, 'memories', m, ('id',), replace)
            if replace:
                # Memories forgotten in the copy's chat are forgotten here too.
                gone = [r[0] for r in c.execute('SELECT id FROM memories WHERE task_id=?', (task_id,)) if r[0] not in memories]
                c.executemany('DELETE FROM memories WHERE id=?', [(g,) for g in gone])
                changed += len(gone)
            # Events get this server's own sequence numbers, in the copy's order.
            seen = {tuple(r) for r in c.execute('SELECT type,created_at,run_id FROM events WHERE task_id=?', (task_id,))}
            for e in rows['events']:
                if (e['type'], e['created_at'], e.get('run_id')) not in seen:
                    c.execute('INSERT INTO events(task_id,run_id,type,payload,created_at) VALUES(?,?,?,?,?)',
                              (task_id, e.get('run_id'), e['type'], e['payload'], e['created_at']))
                    changed += 1
        return changed

    def _restore_bytes(self, base, tid, task_id):
        """The chat's files and raw provider logs that the copy holds and this server does not."""
        if self.data_dir is None:
            return 0
        try:
            stored = self.root.child(f'{base}/stored/{tid}').get() or {}
            logged = self.root.child(f'{base}/logged/{tid}').get() or {}
        except Exception as exc:  # noqa: BLE001 - logged; the next sign-in or start tries again
            log.warning('Could not read the cloud copy of the files of chat %s: %s', task_id, exc)
            return 0
        local, count = {r['id'] for r in self._raw('SELECT id FROM artifacts WHERE task_id=?', (task_id,))}, 0
        for aid, parts in stored.items():
            artifact_id = unkey(aid)
            if artifact_id in local:
                continue
            try:
                node = self.root.child(f'{base}/files/{tid}/{aid}').get()
                row = json.loads(node) if isinstance(node, str) else restored(node or {})
                name, folder = row.get('name') or '', (self.files / task_id / artifact_id).resolve()
                if not (FILE_NAME.fullmatch(name) and FILE_ID.fullmatch(artifact_id) and isinstance(parts, int)
                        and folder.is_relative_to(self.files)):
                    log.warning('Skipped file %s of chat %s: its cloud copy is not a valid file', artifact_id, task_id)
                    continue
                data = joined((self.root.child(f'{base}/blobs/{tid}/{aid}').get() or {}) if parts else {}, parts)
                if hashlib.sha256(data).hexdigest() != row.get('sha256'):
                    log.warning('Skipped file %s of chat %s: its cloud copy does not match its checksum', artifact_id, task_id)
                    continue
                folder.mkdir(parents=True, exist_ok=True)
                (folder / name).write_bytes(data)
                metadata = row.get('metadata')
                with self.db.transaction() as c:
                    added = c.execute('INSERT OR IGNORE INTO artifacts(id,task_id,run_id,name,version,path,media_type,size,sha256,metadata,created_at) '
                                      'VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                                      (artifact_id, task_id, row.get('run_id'), name, int(row.get('version') or 1),
                                       str((folder / name).relative_to(self.files)), row.get('media_type') or 'application/octet-stream',
                                       len(data), row['sha256'], metadata if isinstance(metadata, str) else as_json(metadata, {}),
                                       row.get('created_at') or time.time())).rowcount
                if added:
                    count += 1
                else:  # a file of the same name and version is already here
                    (folder / name).unlink(missing_ok=True)
            except Exception:  # noqa: BLE001 - one damaged file must not stop the others
                log.exception('Could not restore file %s of chat %s from the cloud copy', artifact_id, task_id)
        folder = (self.logs / task_id).resolve()
        for rk, entry in logged.items():
            run = unkey(rk)
            try:
                if not (FILE_ID.fullmatch(run) and isinstance(entry, dict) and folder.is_relative_to(self.logs)):
                    continue
                path = folder / f'{run}.jsonl'
                # Logs only ever grow, so a shorter one here is an older one.
                if path.is_file() and path.stat().st_size >= entry.get('size', 0):
                    continue
                data = joined(self.root.child(f'{base}/logs/{tid}/{rk}').get() or {}, entry.get('pieces', 0))
                if hashlib.sha256(data).hexdigest() != entry.get('sha256'):
                    log.warning('Skipped the provider log of run %s: its cloud copy does not match its checksum', run)
                    continue
                folder.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            except Exception:  # noqa: BLE001 - one damaged log must not stop the others
                log.exception('Could not restore the provider log of run %s from the cloud copy', run)
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
            deleted = {unkey(k) for k in (self.root.child(f'{base}/rules_deleted').get(shallow=True) or {})}
        except Exception as exc:  # noqa: BLE001 - logged; the rules stay as they are here
            log.warning('Could not read the cloud copy of the rules for %s: %s', base, exc)
            return False
        added = removed = 0
        with self.db.transaction() as c:
            for rule_id in deleted:
                removed += c.execute('DELETE FROM rules WHERE id=?', (rule_id,)).rowcount
            # The same rule under another id (a template applied on two servers) is not added twice;
            # compared as text, since the stored JSON may escape characters differently.
            here = {(json.loads(text), rule_set, project) for text, rule_set, project in c.execute('SELECT content,rule_set,project_id FROM rules')}
            for r in values(rules):
                project, content, rule_set = r.get('project_id'), as_json(r.get('content'), ''), r.get('rule_set') or ''
                # A project rule whose project is not here would otherwise apply everywhere.
                if r.get('id') in deleted or (project and not c.execute('SELECT 1 FROM projects WHERE id=?', (project,)).fetchone()):
                    continue
                if c.execute('SELECT 1 FROM rules WHERE id=?', (r['id'],)).fetchone() or (json.loads(content), rule_set, project) in here:
                    continue
                added += c.execute(f"INSERT OR IGNORE INTO rules({','.join(RULE_COLUMNS)}) VALUES(?,?,?,?,?,?,?,?,?)",
                                   (r['id'], content, project, int(r.get('enabled', 1)), r.get('created_at') or time.time(),
                                    rule_set, r.get('applies_when') or '', r.get('level') or 'must', r.get('source') or '')).rowcount
        if added or removed:
            log.info('Rules from the cloud copy of %s: %d added, %d removed', base, added, removed)
        return True

    def close(self, wait=True):
        if self.pool is not None:
            self.pool.shutdown(wait=wait)
