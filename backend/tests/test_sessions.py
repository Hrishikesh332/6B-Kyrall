import json

import httpx
import pytest

from app.models import TaskCreate
from .http_client import AsyncWSGITransport
from .test_provider_loop import ScriptedProvider, call, message, response


@pytest.mark.asyncio
async def test_every_run_is_logged_and_exportable(app):
    app.state.settings.provider = 'openai'
    engine, db = app.state.engine, app.state.db
    engine.provider = ScriptedProvider([
        response(1, call('write_document', {'name': 'brief.md', 'content': 'Tomato gripper brief'}, 'w')),
        response(2, message('Saved the brief.')),
    ])
    tid = db.create_task(TaskCreate(prompt='Write the tomato gripper brief'))
    await engine.run(db.claim())
    folder = app.state.settings.data_dir / 'sessions' / tid
    logs = list(folder.glob('*.jsonl'))
    assert len(logs) == 1
    lines = [json.loads(line) for line in logs[0].read_text().splitlines()]
    assert [entry['kind'] for entry in lines] == ['sent', 'received', 'sent', 'received']
    assert 'Write the tomato gripper brief' in json.dumps(lines[0]['payload'])
    saved = (folder / 'transcript.md').read_text()
    assert 'Write the tomato gripper brief' in saved and 'tool **write_document**' in saved and 'Saved the brief.' in saved
    async with httpx.AsyncClient(transport=AsyncWSGITransport(app=app), base_url='http://testserver') as c:
        exported = await c.get(f'/api/tasks/{tid}/session', params={'format': 'md'})
        assert exported.headers['content-type'].startswith('text/markdown') and 'attachment' in exported.headers['content-disposition']
        record = (await c.get(f'/api/tasks/{tid}/session', params={'raw': 'true'})).json()
        assert record['tool_calls'][0]['name'] == 'write_document' and len(next(iter(record['provider_logs'].values()))) == 4
