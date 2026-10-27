import json
import subprocess
import sys
from pathlib import Path

import httpx
import pytest

from app.cad_script import (CadScriptInput, ScriptError, apply_edits, apply_parameters, extract_parameters,
                            sandbox_profile, validate_script)
from app.models import ApprovalDecision, TaskCreate
from .http_client import AsyncWSGITransport
from .test_provider_loop import ScriptedProvider, call, message, response

ENCLOSURE = '''import cadquery as cq

# --- Enclosure ---
length = 70  # [50:1:120] Outer length (mm)
width = 40  # [30:1:80] Outer width (mm)
height = 20  # [10:1:40] Base height (mm)
wall = 2  # [1.2:0.2:4] Wall thickness (mm)
# --- Lid ---
lid_height = 5  # [3:0.5:10] Lid height (mm)
vented = True  # Cut a vent slot in the lid

base = (cq.Workplane("XY").box(length, width, height, centered=(True, True, False))
        .faces(">Z").shell(-wall))
lid = cq.Workplane("XY").box(length, width, lid_height, centered=(True, True, False)).translate((0, 0, height + 1))
if vented:
    lid = lid.cut(cq.Workplane("XY").box(length / 2, 3, lid_height).translate((0, 0, height + 1 + lid_height / 2)))
print("lid top", height + 1 + lid_height)
parts = {"base": base, "lid": lid}
print_rotation = {"lid": (180, 0, 0)}
'''


@pytest.mark.parametrize('source,needle', [
    ('import os\nparts={}', 'Only cadquery and math'),
    ('import cadquery.occ_impl\nparts={}', 'Only cadquery and math'),
    ('from cadquery import exporters\nparts={}', 'exporters'),
    ('parts={}\nopen("x")', 'open'),
    ('parts={}\nx = getattr(parts, "keys")', 'getattr'),
    ('import cadquery as cq\nparts={}\ncq.exporters.export(1, "x")', 'not available'),
    ('parts={}\nx = ().__class__', '__class__'),
    ('parts={}\n"{0.__class__}".format(1)', 'format'),
    ('parts={}\nclass A: pass', 'ClassDef'),
    ('parts={}\nwith x: pass', 'With'),
    ('parts={}\ndef f(_x): return _x', 'cannot start with _'),
    ('x = 1', 'parts = '),
    ('parts = {\n', 'SyntaxError'),
])
def test_static_checks_block_escapes(source, needle):
    with pytest.raises(ScriptError, match=needle):
        validate_script(source)


def test_parameters_come_from_the_script_header():
    params = {p['name']: p for p in extract_parameters(ENCLOSURE)}
    assert list(params) == ['length', 'width', 'height', 'wall', 'lid_height', 'vented']
    assert {'type': 'integer', 'min': 50, 'max': 120, 'step': 1, 'group': 'Enclosure',
            'description': 'Outer length (mm)'}.items() <= params['length'].items()
    # Whole-number defaults with fractional ranges are continuous dimensions.
    assert params['wall']['type'] == 'number' and params['wall']['step'] == 0.2
    assert params['lid_height']['type'] == 'number' and params['lid_height']['step'] == 0.5
    assert params['lid_height']['group'] == 'Lid' and params['vented']['type'] == 'boolean'
    # Values after the first computation are implementation, not parameters.
    assert 'pitch' not in {p['name'] for p in extract_parameters('import math\nw = 4.5\npitch = w * 2\nparts = {}')}
    loose = extract_parameters('gap = 0.4\nparts = {}')[0]
    assert loose['annotated'] is False and loose['min'] == 0 and loose['max'] >= 0.8

    updated = apply_parameters(ENCLOSURE, {'length': 90, 'lid_height': 6.5, 'vented': False})
    assert 'length = 90  # [50:1:120] Outer length (mm)' in updated
    assert 'lid_height = 6.5  # [3:0.5:10]' in updated and 'vented = False  # Cut a vent' in updated
    for values, error in [({'length': 200}, 'between'), ({'length': 70.5}, 'whole'), ({'depth': 3}, 'Unknown'),
                          ({'vented': 1}, 'true or false')]:
        with pytest.raises(ValueError, match=error):
            apply_parameters(ENCLOSURE, values)
    with pytest.raises(ScriptError, match='2 times'):
        apply_edits('a = 1\nb = 1\nparts = {}', [{'find': ' 1', 'replace': ' 2'}])


@pytest.mark.skipif(sys.platform != 'darwin' or not Path('/usr/bin/sandbox-exec').exists(), reason='macOS sandbox')
def test_os_sandbox_blocks_network_and_outside_writes(tmp_path):
    work = (tmp_path / 'work').resolve(); work.mkdir()
    probe = ('import pathlib, socket\n'
             f'pathlib.Path({str(work / "inside.txt")!r}).write_text("ok")\n'
             'results = []\n'
             f'for action in (lambda: pathlib.Path({str(tmp_path / "outside.txt")!r}).write_text("x"),\n'
             '               lambda: socket.create_connection(("1.1.1.1", 443), timeout=3)):\n'
             '    try: action(); results.append("allowed")\n'
             '    except OSError: results.append("blocked")\n'
             'print(results)')
    out = subprocess.run(['/usr/bin/sandbox-exec', '-p', sandbox_profile(work, Path.home()), sys.executable, '-I', '-c', probe],
                         capture_output=True, text=True, timeout=60)
    assert out.stdout.strip() == "['blocked', 'blocked']", out.stderr
    assert (work / 'inside.txt').read_text() == 'ok' and not (tmp_path / 'outside.txt').exists()


@pytest.mark.asyncio
async def test_script_build_revise_rebuild_motion_and_approval(app):
    db, runner = app.state.db, app.state.engine.runner
    tid = db.create_task(TaskCreate(prompt='Two-part enclosure'))
    run = db.claim()
    built = await runner.execute(tid, run['id'], 'b1', 'build_cad_script',
                                 CadScriptInput(name='box', script=ENCLOSURE).model_dump())
    assert 'error' not in built, built
    assert built['validation']['passed'] and built['log'] == ['lid top 26']
    names = {a['name']: a for a in built['artifacts']}
    assert {'box.cad.py', 'box.geometry.zip', 'box.step', 'base.stl', 'lid.stl', 'preview.png'} <= set(names)
    script = names['box.cad.py']
    assert script['metadata']['kind'] == 'cad_script' and script['metadata']['parts'] == ['base', 'lid']
    assert built['review_image_artifact_id'] == names['preview.png']['id']

    bad = await runner.execute(tid, run['id'], 'b2', 'build_cad_script', {'name': 'bad', 'script': ENCLOSURE.replace(
        'parts = {', 'oops = lid.faces(">Q").val()\nparts = {')})
    assert bad['code'] == 'tool_failed' and 'Line 18' in bad['error'] and 'oops = lid.faces' in bad['error']

    motion = await runner.execute(tid, run['id'], 'm1', 'evaluate_motion', {
        'name': 'lid_open', 'source_artifact_id': script['id'],
        'states': [{'name': 'closed', 'poses': []}, {'name': 'open', 'poses': [{'part': 'lid', 'translation': [0, 0, 15]}]}],
        'transitions': [{'start': 'closed', 'end': 'open', 'samples': 3}]})
    assert 'error' not in motion, motion
    assert motion['report']['passed']

    readable = await runner.execute(tid, run['id'], 'read', 'read_artifact', {'artifact_id': script['id']})
    assert readable['content'] == ENCLOSURE
    revised = await runner.execute(tid, run['id'], 'r1', 'revise_cad_script', {
        'source_artifact_id': script['id'], 'edits': [{'find': 'lid_height = 5 ', 'replace': 'lid_height = 8 '}]})
    assert 'error' not in revised, revised
    lid = next(p for p in revised['validation']['parts'] if p['part'] == 'lid')
    assert lid['bounds_mm'][2] == 8 and revised['parameters'][4]['value'] == 8
    db.finish(run['id'], 'completed')

    async with httpx.AsyncClient(transport=AsyncWSGITransport(app=app), base_url='http://testserver') as c:
        latest = next(a for a in revised['artifacts'] if a['name'] == 'box.cad.py')
        out_of_range = await c.post(f'/api/tasks/{tid}/artifacts/{latest["id"]}/rebuild', json={'values': {'length': 500}})
        assert out_of_range.status_code == 422 and 'between' in out_of_range.json()['detail']
        rebuilt = await c.post(f'/api/tasks/{tid}/artifacts/{latest["id"]}/rebuild', json={'values': {'length': 100, 'vented': False}})
        assert rebuilt.status_code == 201, rebuilt.text
        rebuilt = rebuilt.json()
        assert rebuilt['validation']['assembly_bounds_mm'][0] == 100
        assert {p['name']: p['value'] for p in rebuilt['parameters']}['vented'] is False
        detail = (await c.get(f'/api/tasks/{tid}')).json()
        source = [a for a in detail['artifacts'] if a['name'] == 'box.cad.py'][-1]
        assert source['version'] == 3 and source['metadata']['origin'] == 'parameter_rebuild' and source['run_id'] is None
        assert detail['messages'][-1]['kind'] == 'parameter_change'

        focused = await c.post(f'/api/tasks/{tid}/messages', json={'content': 'Make the lid thicker',
                               'focus': {'part': 'lid', 'source_artifact_id': source['id']}})
        assert focused.status_code == 202
        scoped = db.all('SELECT content FROM messages WHERE task_id=? AND kind=? ORDER BY created_at', (tid, 'text'))[-1]['content']
        assert 'revise_cad_script' in scoped and source['id'] in scoped

        # A design now exists, so model-driven changes wait for an approved plan.
        app.state.settings.provider = 'openai'
        second = db.claim()
        edit = {'source_artifact_id': source['id'], 'edits': [{'find': 'wall = 2 ', 'replace': 'wall = 3 '}]}
        blocked = await runner.execute(tid, second['id'], 'r2', 'revise_cad_script', edit)
        assert blocked['code'] == 'approval_required'
        plan = {'title': 'Thicker lid walls', 'summary': 'Increase wall to 3 mm.',
                'changes': [{'target': 'wall', 'change': '2 → 3 mm'}], 'preserved': ['Outer size'], 'checks': ['Validation']}
        asked = await runner.execute(tid, second['id'], 'a1', 'request_approval', plan)
        assert asked['status'] == 'awaiting_input'
        db.finish(second['id'], 'awaiting_input')
        approval = (await c.get(f'/api/tasks/{tid}')).json()['approvals'][-1]
        assert (await c.post(f'/api/tasks/{tid}/approvals/{approval["id"]}', json={'decision': 'changes'})).status_code == 422
        assert (await c.post(f'/api/tasks/{tid}/approvals/{approval["id"]}', json={'decision': 'approve'})).status_code == 202
        assert (await c.post(f'/api/tasks/{tid}/approvals/{approval["id"]}', json={'decision': 'approve'})).status_code == 409
        resumed = db.claim()
        assert resumed['id'] == second['id']
        allowed = await runner.execute(tid, resumed['id'], 'r3', 'revise_cad_script', edit)
        assert 'error' not in allowed, allowed
        db.finish(resumed['id'], 'completed')

        assert (await c.patch(f'/api/tasks/{tid}', json={'approval_policy': 'auto'})).json()['approval_policy'] == 'auto'
        db.add_message(tid, 'One more tweak')
        third = db.claim()
        assert runner.approval_needed(tid, third['id']) is None


@pytest.mark.asyncio
async def test_approval_pause_resume_and_build_renders_reach_the_model(app):
    app.state.settings.provider = 'openai'
    engine, db = app.state.engine, app.state.db
    plan = {'title': 'Add vents', 'summary': 'Cut a vent slot.', 'changes': [{'target': 'lid', 'change': 'Add slot'}]}
    provider = ScriptedProvider([
        response(1, call('build_cad_script', {'name': 'box', 'script': ENCLOSURE}, 'b'),
                 call('request_approval', plan, 'a')),
        response(2, message('Plan noted; waiting for a revised brief.')),
    ])
    engine.provider = provider
    tid = db.create_task(TaskCreate(prompt='Plan a vent change'))
    first = db.claim()
    await engine.run(first)
    detail = db.detail(tid)
    assert detail['status'] == 'awaiting_input' and detail['approvals'][0]['status'] == 'pending'
    assert any(m['kind'] == 'approval' for m in detail['messages'])
    db.decide_approval(tid, detail['approvals'][0]['id'], ApprovalDecision(decision='changes', note='Use two smaller slots'))
    resumed = db.claim()
    try:
        await engine.run(resumed)
    except ValueError:
        pass  # The scripted model stops early; delivery gates are covered elsewhere.
    items = provider.inputs[1]['items']
    image = next(i for i in items if isinstance(i.get('content'), list))
    assert image['content'][1]['image_url'].startswith('data:image/png;base64,')
    assert 'Use two smaller slots' in items[-1]['content'] and 'changes' in items[-1]['content']
    assert db.detail(tid)['approvals'][0]['status'] == 'changes_requested'


def test_review_raster_shows_the_nearest_surface():
    import numpy as np
    import trimesh
    from app.rendering_raster import render_view
    plate = trimesh.creation.box(extents=(40, 40, 2))
    cube = trimesh.creation.box(extents=(10, 10, 10)); cube.apply_translation((0, 0, 8))
    parts = [(plate.vertices[plate.faces], np.array([1.0, 0, 0])), (cube.vertices[cube.faces], np.array([0, 0, 1.0]))]
    top = render_view(parts, 90, -90, size=120)
    centre, corner = top[60, 60], top[18, 18]
    assert centre[2] > centre[0] and corner[0] > corner[2]  # cube occludes plate; plate shows at the corner
    below = render_view(parts, -90, -90, size=120)
    assert below[60, 60][0] > below[60, 60][2]  # from underneath only the plate is visible


@pytest.mark.asyncio
async def test_plan_questions_are_answered_with_the_approval(app):
    db, runner = app.state.db, app.state.engine.runner
    tid = db.create_task(TaskCreate(prompt='Add a lid lip'))
    run = db.claim()
    plan = {'title': 'Add a lip', 'summary': 'Add a locating lip.', 'changes': [{'target': 'lid', 'change': 'Add lip'}],
            'questions': [{'id': 'fit', 'question': 'Lip clearance per side?', 'options': ['0.2 mm', '0.3 mm', '0.4 mm'], 'default': '0.3 mm'},
                          {'id': 'height', 'question': 'Tallest part near the edge?', 'options': ['Under 8 mm', 'Up to 12 mm'], 'default': 'Up to 12 mm'}]}
    asked = await runner.execute(tid, run['id'], 'a', 'request_approval', plan)
    assert asked['status'] == 'awaiting_input'
    db.finish(run['id'], 'awaiting_input')
    aid = asked['approval_id']
    async with httpx.AsyncClient(transport=AsyncWSGITransport(app=app), base_url='http://testserver') as c:
        bad = await c.post(f'/api/tasks/{tid}/approvals/{aid}', json={'decision': 'approve', 'answers': {'colour': 'red'}})
        assert bad.status_code == 409
        ok = await c.post(f'/api/tasks/{tid}/approvals/{aid}', json={'decision': 'approve', 'answers': {'fit': '0.4 mm'}})
        assert ok.status_code == 202
    decision = db.detail(tid)['approvals'][0]['decision']
    assert decision['answers'] == {'Lip clearance per side?': '0.4 mm', 'Tallest part near the edge?': 'Up to 12 mm'}


@pytest.mark.asyncio
async def test_revisions_record_what_changed_and_builds_compare(app):
    db, runner = app.state.db, app.state.engine.runner
    tid = db.create_task(TaskCreate(prompt='Enclosure revisions'))
    run = db.claim()
    first = await runner.execute(tid, run['id'], 'b1', 'build_cad_script', CadScriptInput(name='box', script=ENCLOSURE).model_dump())
    assert 'changes_since_previous_build' not in first
    script = next(a for a in first['artifacts'] if a['name'] == 'box.cad.py')
    second = await runner.execute(tid, run['id'], 'r1', 'revise_cad_script', {
        'source_artifact_id': script['id'], 'edits': [{'find': 'lid_height = 5 ', 'replace': 'lid_height = 8 '}]})
    summary = second['changes_since_previous_build']
    assert summary[0] == '1 part changed' and any(line.startswith('lid: ') and '→' in line for line in summary)
    assert 'Parameters: lid_height 5 → 8' in summary
    assert any(a['name'] == 'change_report.json' for a in db.detail(tid)['artifacts'])
    async with httpx.AsyncClient(transport=AsyncWSGITransport(app=app), base_url='http://testserver') as c:
        history = (await c.get(f'/api/tasks/{tid}/builds')).json()
        assert [b['version'] for b in history] == [1, 2] and history[0]['origin'] == 'assistant'
        report = (await c.get(f'/api/tasks/{tid}/compare', params={'from_build': history[0]['build_id'],
                                                                    'to_build': history[1]['build_id']})).json()
        status = {p['part']: p['status'] for p in report['parts']}
        assert status == {'base': 'unchanged', 'lid': 'changed'}
        lid = next(p for p in report['parts'] if p['part'] == 'lid')
        assert lid['size_delta_mm'][2] == 3 and lid['volume_delta_mm3'] > 0
        assert report['source_diff']['added_lines'] == 1 and '+lid_height = 8' in report['source_diff']['text']
        assert (await c.get(f'/api/tasks/{tid}/compare', params={'from_build': 'x'})).status_code == 422
