"""SQLite transactions are the authority for task/run state, never process memory."""
import json
import sqlite3
import time
import uuid
import hashlib
from contextlib import contextmanager
from pathlib import Path


def uid():
    return str(uuid.uuid4())


def encode(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


JSON_COLUMNS = {"plan", "spec", "content", "payload", "questions", "answers", "decision", "metadata", "arguments", "result", "checkpoint", "usage"}


def row_dict(row):
    if row is None:
        return None
    value = dict(row)
    for key in JSON_COLUMNS & value.keys():
        if value[key] is not None:
            value[key] = json.loads(value[key])
    return value


SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,brief TEXT NOT NULL DEFAULT '',memory_scope TEXT NOT NULL DEFAULT 'project',created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS project_files(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,path TEXT NOT NULL,size INTEGER NOT NULL,created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(
 id TEXT PRIMARY KEY,title TEXT NOT NULL,project_id TEXT REFERENCES projects(id),context_scope TEXT NOT NULL,
 status TEXT NOT NULL,plan TEXT NOT NULL DEFAULT '[]',spec TEXT NOT NULL DEFAULT '{}',archived INTEGER NOT NULL DEFAULT 0,
 created_at REAL NOT NULL,updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS messages(
 id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),run_id TEXT,role TEXT NOT NULL,kind TEXT NOT NULL,
 content TEXT NOT NULL,created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS runs(
 id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),status TEXT NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0,
 checkpoint TEXT NOT NULL DEFAULT '{}',usage TEXT NOT NULL DEFAULT '{}',error TEXT,lease_until REAL,
 created_at REAL NOT NULL,started_at REAL,finished_at REAL);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(task_id) WHERE status IN ('queued','running','awaiting_input');
CREATE TABLE IF NOT EXISTS events(
 seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES tasks(id),run_id TEXT,type TEXT NOT NULL,
 payload TEXT NOT NULL,created_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS events_task_seq ON events(task_id,seq);
CREATE TABLE IF NOT EXISTS questionnaires(
 id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),run_id TEXT NOT NULL REFERENCES runs(id),
 title TEXT NOT NULL,questions TEXT NOT NULL,answers TEXT,status TEXT NOT NULL,created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS approvals(
 id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),run_id TEXT NOT NULL REFERENCES runs(id),
 payload TEXT NOT NULL,decision TEXT,status TEXT NOT NULL,created_at REAL NOT NULL,decided_at REAL);
CREATE TABLE IF NOT EXISTS artifacts(
 id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),run_id TEXT,name TEXT NOT NULL,version INTEGER NOT NULL,
 path TEXT NOT NULL,media_type TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,metadata TEXT NOT NULL,
 created_at REAL NOT NULL,UNIQUE(task_id,name,version));
CREATE TABLE IF NOT EXISTS tool_calls(
 id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),run_id TEXT NOT NULL REFERENCES runs(id),
 name TEXT NOT NULL,arguments TEXT NOT NULL,result TEXT,status TEXT NOT NULL,started_at REAL NOT NULL,finished_at REAL);
CREATE TABLE IF NOT EXISTS memories(
 id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),content TEXT NOT NULL,created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,object_id TEXT NOT NULL,request_hash TEXT NOT NULL DEFAULT '',PRIMARY KEY(scope,key));
CREATE TABLE IF NOT EXISTS schedules(
 id TEXT PRIMARY KEY,name TEXT NOT NULL,prompt TEXT NOT NULL,interval_minutes INTEGER NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 0,next_run_at REAL NOT NULL,last_task_id TEXT,created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS rules(
 id TEXT PRIMARY KEY,content TEXT NOT NULL,project_id TEXT REFERENCES projects(id),
 enabled INTEGER NOT NULL DEFAULT 1,created_at REAL NOT NULL);
"""


class Conflict(Exception):
    pass


class NotFound(Exception):
    pass


class DB:
    def __init__(self, path: Path):
        self.path = path
        with self.connect() as c:
            c.executescript(SCHEMA)
            # Forward-compatible migration for early local workspaces.
            columns={row[1] for row in c.execute('PRAGMA table_info(idempotency)')}
            if 'request_hash' not in columns:
                c.execute("ALTER TABLE idempotency ADD COLUMN request_hash TEXT NOT NULL DEFAULT ''")
            columns={row[1] for row in c.execute('PRAGMA table_info(projects)')}
            if 'brief' not in columns:
                c.execute("ALTER TABLE projects ADD COLUMN brief TEXT NOT NULL DEFAULT ''")
            if 'memory_scope' not in columns:
                c.execute("ALTER TABLE projects ADD COLUMN memory_scope TEXT NOT NULL DEFAULT 'project'")
            if 'approval_policy' not in {row[1] for row in c.execute('PRAGMA table_info(tasks)')}:
                c.execute("ALTER TABLE tasks ADD COLUMN approval_policy TEXT NOT NULL DEFAULT 'ask'")
            from .rules import migrate as migrate_rules
            migrate_rules(c)
            c.execute('PRAGMA user_version=1')

    def active_rules(self, project_id):
        """Enabled user rules for a task: workspace-wide ones plus its project's."""
        rows=self.all('SELECT content FROM rules WHERE enabled=1 AND (project_id IS NULL OR project_id=?) ORDER BY created_at',(project_id,))
        return [r['content'] for r in rows]

    def connect(self):
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        c.execute("PRAGMA busy_timeout=10000")
        return c

    @contextmanager
    def transaction(self):
        c = self.connect()
        try:
            c.execute("BEGIN IMMEDIATE")
            yield c
            c.commit()
        except BaseException:
            c.rollback()
            raise
        finally:
            c.close()

    def all(self, sql, args=()):
        with self.connect() as c:
            return [row_dict(x) for x in c.execute(sql, args).fetchall()]

    def one(self, sql, args=()):
        with self.connect() as c:
            return row_dict(c.execute(sql, args).fetchone())

    def require_task(self, task_id):
        task = self.one("SELECT * FROM tasks WHERE id=?", (task_id,))
        if not task:
            raise NotFound("Task not found")
        return task

    def event(self, c, task_id, run_id, kind, payload):
        cur = c.execute("INSERT INTO events(task_id,run_id,type,payload,created_at) VALUES(?,?,?,?,?)", (task_id, run_id, kind, encode(payload), time.time()))
        return cur.lastrowid

    def emit(self, task_id, run_id, kind, payload):
        with self.transaction() as c:
            return self.event(c, task_id, run_id, kind, payload)

    def message(self, c, task_id, run_id, role, kind, content):
        mid = uid()
        c.execute("INSERT INTO messages VALUES(?,?,?,?,?,?,?)", (mid, task_id, run_id, role, kind, encode(content), time.time()))
        self.event(c, task_id, run_id, "message.created", {"id": mid, "role": role, "kind": kind, "content": content})
        return mid

    def queue_run(self, c, task_id):
        rid = uid()
        c.execute("INSERT INTO runs(id,task_id,status,created_at) VALUES(?,?,?,?)", (rid, task_id, "queued", time.time()))
        c.execute("UPDATE tasks SET status='queued',updated_at=? WHERE id=?", (time.time(), task_id))
        self.event(c, task_id, rid, "run.queued", {"status": "queued"})
        return rid

    def create_task(self, data, key=None, task_id=None):
        request_hash=hashlib.sha256(encode(data.model_dump()).encode()).hexdigest()
        with self.transaction() as c:
            if key:
                old = c.execute("SELECT object_id,request_hash FROM idempotency WHERE scope='create_task' AND key=?", (key,)).fetchone()
                if old:
                    if old['request_hash'] != request_hash:
                        raise Conflict('Idempotency key was used for a different request')
                    return old[0]
            if data.project_id and not c.execute("SELECT 1 FROM projects WHERE id=?", (data.project_id,)).fetchone():
                raise NotFound("Project not found")
            tid, now = task_id or uid(), time.time()
            title = data.title or " ".join(data.prompt.split())[:76]
            c.execute("INSERT INTO tasks(id,title,project_id,context_scope,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", (tid, title, data.project_id, data.context_scope, "queued", now, now))
            rid = self.queue_run(c, tid)
            self.message(c, tid, rid, "user", "text", data.prompt)
            if key:
                c.execute("INSERT INTO idempotency VALUES('create_task',?,?,?)", (key, tid,request_hash))
            return tid

    def create_import_task(self, title):
        """A task holding imported files; no run starts until the user writes."""
        with self.transaction() as c:
            tid, now = uid(), time.time()
            c.execute("INSERT INTO tasks(id,title,project_id,context_scope,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", (tid, title[:100], None, 'isolated', 'completed', now, now))
            return tid

    def add_message(self, task_id, content, key=None):
        self.require_task(task_id)
        request_hash=hashlib.sha256(content.encode()).hexdigest()
        with self.transaction() as c:
            if key:
                old = c.execute("SELECT object_id,request_hash FROM idempotency WHERE scope=? AND key=?", (task_id, key)).fetchone()
                if old:
                    if old['request_hash'] != request_hash:
                        raise Conflict('Idempotency key was used for a different message')
                    return old[0]
            active = c.execute("SELECT * FROM runs WHERE task_id=? AND status IN ('queued','running','awaiting_input')", (task_id,)).fetchone()
            if active:
                if active['status'] == 'awaiting_input':
                    raise Conflict("Answer the pending questions before sending another message")
                self.message(c, task_id, None, 'user', 'queued', content)
                self.event(c, task_id, active['id'], 'message.queued', {'detail':'This message will be processed after the active turn'})
                if key:
                    c.execute('INSERT INTO idempotency VALUES(?,?,?,?)',(task_id,key,active['id'],request_hash))
                return active['id']
            rid = self.queue_run(c, task_id)
            self.message(c, task_id, rid, "user", "text", content)
            if key:
                c.execute("INSERT INTO idempotency VALUES(?,?,?,?)", (task_id, key, rid,request_hash))
            return rid

    def claim(self):
        with self.transaction() as c:
            # Never silently replay a tool after an unclean shutdown.
            for r in c.execute("SELECT * FROM runs WHERE status='running' AND lease_until < ?", (time.time(),)).fetchall():
                self.close_tools(c,r['task_id'],r['id'],'interrupted','Worker lease expired; tool outcome may be incomplete')
                c.execute("UPDATE runs SET status='interrupted',finished_at=?,error='Worker lease expired; retry explicitly' WHERE id=?", (time.time(), r['id']))
                c.execute("UPDATE tasks SET status='interrupted' WHERE id=?", (r['task_id'],))
                self.event(c, r['task_id'], r['id'], "run.interrupted", {"status": "interrupted", "error": "Worker stopped; retry to continue"})
            row = c.execute("SELECT * FROM runs WHERE status='queued' ORDER BY created_at LIMIT 1").fetchone()
            if not row:
                return None
            c.execute("UPDATE runs SET status='running',started_at=COALESCE(started_at,?),lease_until=? WHERE id=?", (time.time(), time.time()+90, row['id']))
            c.execute("UPDATE tasks SET status='running',updated_at=? WHERE id=?", (time.time(), row['task_id']))
            self.event(c, row['task_id'], row['id'], "run.started", {"status": "running"})
            return row_dict(c.execute("SELECT * FROM runs WHERE id=?", (row['id'],)).fetchone())

    def checkpoint(self, run_id, value):
        with self.transaction() as c:
            c.execute("UPDATE runs SET checkpoint=?,lease_until=? WHERE id=?", (encode(value), time.time()+90, run_id))

    def close_tools(self, c, tid, rid, status, error):
        for call in c.execute("SELECT id,name,started_at FROM tool_calls WHERE run_id=? AND status='running'",(rid,)).fetchall():
            now=time.time(); result={'error':error}
            c.execute('UPDATE tool_calls SET status=?,result=?,finished_at=? WHERE id=?',(status,encode(result),now,call['id']))
            self.event(c,tid,rid,'tool.'+status,{'id':call['id'],'name':call['name'],'result':result,'duration_ms':round(max(0,now-call['started_at'])*1000)})

    def finish(self, run_id, status, error=None):
        with self.transaction() as c:
            run = c.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            if not run or run['status'] not in ('running','queued','awaiting_input'):
                return
            if run['cancel_requested']:
                status, error = "cancelled", None
            if status not in ('awaiting_input','completed'):
                self.close_tools(c,run['task_id'],run_id,'cancelled' if status=='cancelled' else 'interrupted',error or 'Run stopped')
            c.execute("UPDATE runs SET status=?,error=?,finished_at=?,lease_until=NULL WHERE id=?", (status, error, time.time(), run_id))
            c.execute("UPDATE tasks SET status=?,updated_at=? WHERE id=?", (status, time.time(), run['task_id']))
            if status != 'awaiting_input':
                c.execute("UPDATE questionnaires SET status='cancelled' WHERE run_id=? AND status='pending'", (run_id,))
            self.event(c, run['task_id'], run_id, f"run.{status}", {"status": status, "error": error})
            if status == 'completed' and c.execute("SELECT 1 FROM messages WHERE task_id=? AND run_id IS NULL AND kind='queued'",(run['task_id'],)).fetchone():
                next_run = self.queue_run(c,run['task_id'])
                c.execute("UPDATE messages SET run_id=?,kind='text' WHERE task_id=? AND run_id IS NULL AND kind='queued'",(next_run,run['task_id']))

    def cancel(self, task_id):
        self.require_task(task_id)
        with self.transaction() as c:
            run = c.execute("SELECT * FROM runs WHERE task_id=? AND status IN ('queued','running','awaiting_input')", (task_id,)).fetchone()
            if not run:
                raise Conflict("No active run to stop")
            c.execute("UPDATE runs SET cancel_requested=1 WHERE id=?", (run['id'],))
            self.event(c, task_id, run['id'], "run.stopping", {"status": "stopping"})
        if run['status'] != 'running':
            self.finish(run['id'], 'cancelled')

    def retry(self, task_id):
        task = self.require_task(task_id)
        if task['status'] not in ('failed','cancelled','interrupted'):
            raise Conflict("Only failed, cancelled, or interrupted tasks can be retried")
        with self.transaction() as c:
            if c.execute("SELECT 1 FROM runs WHERE task_id=? AND status IN ('queued','running','awaiting_input')", (task_id,)).fetchone():
                raise Conflict("A run is already active")
            rid=self.queue_run(c, task_id)
            c.execute("UPDATE messages SET run_id=?,kind='text' WHERE task_id=? AND run_id IS NULL AND kind='queued'",(rid,task_id))
            return rid

    def ask(self, task_id, run_id, payload):
        qid = uid()
        with self.transaction() as c:
            c.execute("INSERT INTO questionnaires VALUES(?,?,?,?,?,?,?,?)", (qid, task_id, run_id, payload['title'], encode(payload['questions']), None, 'pending', time.time()))
            self.message(c, task_id, run_id, 'assistant', 'clarification', {"id": qid, **payload})
            self.event(c, task_id, run_id, 'clarification.requested', {"id": qid, **payload})
        return {"questionnaire_id": qid, "status": "awaiting_input"}

    def request_approval(self, task_id, run_id, payload):
        aid = uid()
        with self.transaction() as c:
            c.execute("INSERT INTO approvals(id,task_id,run_id,payload,status,created_at) VALUES(?,?,?,?,?,?)",
                      (aid, task_id, run_id, encode(payload), 'pending', time.time()))
            self.message(c, task_id, run_id, 'assistant', 'approval', {"id": aid, **payload})
            self.event(c, task_id, run_id, 'approval.requested', {"id": aid, **payload})
        return {"approval_id": aid, "status": "awaiting_input",
                "next": "Stop now. The run resumes after the user approves or requests changes."}

    def decide_approval(self, task_id, aid, data):
        with self.transaction() as c:
            a = row_dict(c.execute("SELECT * FROM approvals WHERE id=? AND task_id=?", (aid, task_id)).fetchone())
            if not a:
                raise NotFound("Approval request not found")
            if a['status'] != 'pending':
                raise Conflict("This plan was already approved or sent back")
            run = c.execute("SELECT * FROM runs WHERE id=?", (a['run_id'],)).fetchone()
            if run['status'] != 'awaiting_input':
                raise Conflict("Run is not waiting for approval yet")
            status = 'approved' if data.decision == 'approve' else 'changes_requested'
            questions = a['payload'].get('questions') or []
            if set(data.answers) - {q['id'] for q in questions}:
                raise Conflict("Answers must match the plan's questions")
            # Unanswered questions take their stated recommended default.
            answers = {q['id']: data.answers.get(q['id'], q['default']).strip() for q in questions}
            if any(not v or len(v) > 2000 for v in answers.values()):
                raise Conflict("Answers must contain 1–2000 characters")
            result = {"approval_id": aid, "decision": data.decision, "note": data.note.strip(), "title": a['payload']['title'],
                      "answers": {q['question']: answers[q['id']] for q in questions}}
            c.execute("UPDATE approvals SET status=?,decision=?,decided_at=? WHERE id=?", (status, encode(result), time.time(), aid))
            self.message(c, task_id, a['run_id'], 'user', 'approval_decision', result)
            c.execute("UPDATE runs SET status='queued',finished_at=NULL WHERE id=?", (a['run_id'],))
            c.execute("UPDATE tasks SET status='queued',updated_at=? WHERE id=?", (time.time(), task_id))
            self.event(c, task_id, a['run_id'], 'approval.decided', result)
            return a['run_id']

    def answer(self, task_id, qid, data):
        with self.transaction() as c:
            q = row_dict(c.execute("SELECT * FROM questionnaires WHERE id=? AND task_id=?", (qid, task_id)).fetchone())
            if not q:
                raise NotFound("Questionnaire not found")
            if q['status'] != 'pending':
                raise Conflict("These questions are already answered or cancelled")
            run = c.execute("SELECT * FROM runs WHERE id=?", (q['run_id'],)).fetchone()
            if run['status'] != 'awaiting_input':
                raise Conflict("Run is not waiting for input yet")
            keys = {x['id'] for x in q['questions']}
            if set(data.answers) - keys or (not data.skip and keys - set(data.answers)):
                raise Conflict("Answer every question, or explicitly skip to use the stated defaults")
            answers = {x['id']: data.answers.get(x['id'], x['default']) for x in q['questions']}
            if any(not v.strip() or len(v) > 2000 for v in answers.values()):
                raise Conflict("Answers must contain 1–2000 characters")
            result = {"answers": answers, "notes": data.notes, "used_defaults": data.skip}
            c.execute("UPDATE questionnaires SET answers=?,status='answered' WHERE id=?", (encode(result), qid))
            self.message(c, task_id, q['run_id'], 'user', 'clarification_answer', result)
            c.execute("UPDATE runs SET status='queued',finished_at=NULL WHERE id=?", (q['run_id'],))
            c.execute("UPDATE tasks SET status='queued',updated_at=? WHERE id=?", (time.time(), task_id))
            self.event(c, task_id, q['run_id'], 'clarification.answered', {"id": qid, **result})
            return q['run_id']

    def detail(self, task_id):
        task = self.require_task(task_id)
        for key, table in [('messages','messages'), ('runs','runs'), ('artifacts','artifacts'), ('questionnaires','questionnaires'), ('approvals','approvals')]:
            task[key] = self.all(f"SELECT * FROM {table} WHERE task_id=? ORDER BY created_at", (task_id,))
        for a in task['artifacts']:
            a.pop('path', None)
        for r in task['runs']:
            r.pop('checkpoint', None)
        task['last_event_id'] = (self.one("SELECT MAX(seq) AS seq FROM events WHERE task_id=?", (task_id,)) or {}).get('seq') or 0
        return task
