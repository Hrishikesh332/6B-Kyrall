"""Stored record of every interaction: raw provider exchanges per run, plus readable transcripts.

Raw logs (data/sessions/<task>/<run>.jsonl) hold what was sent to and received from the
model provider. Transcripts are rebuilt from SQLite after each run and on export, so they
always match the durable record: messages, questions, approvals, rule decisions and
checks, tool calls with inputs and results, builds and slices.
"""
import dataclasses
import json
import time
from pathlib import Path

MAX_TEXT = 20_000


def _plain(value, depth=0):
    if depth > 12:
        return '…'
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {'type': type(value).__name__, **{f.name: _plain(getattr(value, f.name), depth + 1)
                                                 for f in dataclasses.fields(value)}}
    if isinstance(value, dict):
        return {str(k): _plain(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v, depth + 1) for v in value]
    if isinstance(value, str):
        # Inline images (base64) and huge payloads are summarised, not stored twice.
        return value if len(value) <= MAX_TEXT else value[:MAX_TEXT] + f'… [{len(value) - MAX_TEXT} more characters]'
    if value is None or isinstance(value, (int, float, bool)):
        return value
    return repr(value)[:MAX_TEXT]


class SessionLog:
    def __init__(self, data_dir, task_id, run_id):
        self.path = Path(data_dir) / 'sessions' / task_id / f'{run_id}.jsonl'
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def write(self, kind, payload):
        try:
            with self.path.open('a') as handle:
                handle.write(json.dumps({'at': time.time(), 'kind': kind, 'payload': _plain(payload)},
                                        default=str) + '\n')
        except OSError:
            pass  # Logging must never break a run.


def _when(ts):
    return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(ts)) if ts else ''


def transcript(db, data_dir, task_id, raw=False):
    from .rules import task_rules
    task = db.detail(task_id)
    calls = db.all('SELECT id,run_id,name,arguments,result,status,started_at,finished_at FROM tool_calls '
                   'WHERE task_id=? ORDER BY started_at', (task_id,))
    events = db.all("SELECT seq,run_id,type,payload,created_at FROM events WHERE task_id=? AND type IN "
                    "('activity','completion.checked','changes.recorded','print.sliced','rules.decided','rules.checked',"
                    "'provider.connected') ORDER BY seq", (task_id,))
    record = {'exported_at': time.time(), 'task': {k: task[k] for k in ('id', 'title', 'status', 'created_at', 'spec', 'plan')},
              'runs': [{k: r.get(k) for k in ('id', 'status', 'created_at', 'started_at', 'finished_at', 'usage', 'error')}
                       for r in task['runs']],
              'messages': task['messages'], 'questions': task['questionnaires'], 'approvals': task['approvals'],
              'rules': task_rules(db, task_id), 'tool_calls': calls, 'events': events,
              'files': [{k: a[k] for k in ('id', 'name', 'version', 'metadata', 'created_at')} for a in task['artifacts']]}
    if raw:
        logs = {}
        for path in sorted((Path(data_dir) / 'sessions' / task_id).glob('*.jsonl')):
            logs[path.stem] = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        record['provider_logs'] = logs
    return record


def markdown(record):
    lines = [f"# {record['task']['title']}", '', f"Exported {_when(record['exported_at'])} · status {record['task']['status']}", '']
    sets = [s for s in record['rules'] if s['rules']]
    if sets:
        lines += ['## Rules', '']
        for s in sets:
            reason = f" — {s['decision']['reason']} ({s['decision']['decided_by']})" if s.get('decision') else ''
            lines.append(f"- **{s['rule_set'] or 'General rules'}**: {s['status']}{reason}")
            for r in s['rules']:
                check = f" → {r['check']['status']}: {r['check']['evidence']}" if r.get('check') else ''
                lines.append(f"  - [{r['level']}] {r['text']}{check}")
        lines.append('')
    timeline = []
    for m in record['messages']:
        timeline.append((m['created_at'], 'message', m))
    for c in record['tool_calls']:
        timeline.append((c['started_at'], 'tool', c))
    for e in record['events']:
        timeline.append((e['created_at'], 'event', e))
    for q in record['questions']:
        timeline.append((q['created_at'], 'questions', q))
    timeline.sort(key=lambda item: item[0])
    lines += ['## Conversation and work', '']
    for at, kind, item in timeline:
        stamp = _when(at)[11:]
        if kind == 'message':
            content = item['content'] if isinstance(item['content'], str) else json.dumps(item['content'])[:1500]
            who = 'You' if item['role'] == 'user' else '6B'
            if item['kind'] in ('approval', 'approval_decision', 'clarification', 'clarification_answer', 'parameter_change'):
                lines.append(f"**{stamp} · {who} · {item['kind'].replace('_', ' ')}**: `{content[:600]}`")
            else:
                lines.append(f"**{stamp} · {who}**\n\n{content}")
        elif kind == 'tool':
            if item['name'] in ('activity', 'update_plan'):
                continue
            result = item['result'] or {}
            outcome = result.get('error') if isinstance(result, dict) and result.get('error') else item['status']
            args = json.dumps(item['arguments'])
            lines.append(f"- `{stamp}` tool **{item['name']}** ({outcome}) — input: `{args[:300]}{'…' if len(args) > 300 else ''}`")
        elif kind == 'event':
            payload = item['payload']
            if item['type'] == 'activity':
                lines.append(f"- `{stamp}` note — **{payload.get('title', '')}**: {payload.get('detail', '')[:600]}")
            elif item['type'] == 'changes.recorded':
                lines.append(f"- `{stamp}` changes — " + '; '.join(payload.get('summary', [])))
            elif item['type'] == 'print.sliced':
                lines.append(f"- `{stamp}` Bambu slice — {payload.get('estimated_time')}, {payload.get('filament_g')} g, "
                             f"warnings: {'; '.join(payload.get('warnings') or []) or 'none'}")
            elif item['type'] == 'completion.checked':
                lines.append(f"- `{stamp}` delivery checks — {'passed' if payload.get('passed') else '; '.join(payload.get('errors', []))}")
            elif item['type'] == 'rules.decided':
                lines.append(f"- `{stamp}` rule set **{payload.get('rule_set')}** {'applied' if payload.get('apply') else 'skipped'} "
                             f"by {payload.get('decided_by')}: {payload.get('reason')}")
            elif item['type'] == 'rules.checked':
                lines.append(f"- `{stamp}` rule checks recorded ({payload.get('count')}, {payload.get('not_met')} not met)")
            elif item['type'] == 'provider.connected':
                lines.append(f"- `{stamp}` model — {payload.get('provider')} {payload.get('model')}")
        lines.append('')
    lines += ['## Runs', '']
    for r in record['runs']:
        usage = r.get('usage') or {}
        lines.append(f"- {r['id'][:8]} · {r['status']} · {usage.get('total_tokens', 0)} tokens · "
                     f"{usage.get('tool_calls', '?')} tool calls{' · ' + r['error'] if r.get('error') else ''}")
    lines += ['', '## Files', ''] + [f"- {f['name']} v{f['version']} ({f['metadata'].get('kind', '')})" for f in record['files']]
    return '\n'.join(lines) + '\n'


def save(db, data_dir, task_id):
    """Rewrite the stored transcript for a task; called after every run."""
    try:
        folder = Path(data_dir) / 'sessions' / task_id
        folder.mkdir(parents=True, exist_ok=True)
        record = transcript(db, data_dir, task_id)
        (folder / 'transcript.json').write_text(json.dumps(record, indent=1, default=str))
        (folder / 'transcript.md').write_text(markdown(record))
    except Exception:  # noqa: BLE001 - storing a transcript must never fail a run
        pass
