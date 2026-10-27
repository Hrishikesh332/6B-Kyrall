"""Provider-independent delivery checks; no final answer precedes these gates."""
from .config import VISION_PROVIDERS
from .db import encode


def mechanism_requested(db,tid):
    task=db.require_task(tid)
    texts=[task['title'],encode(task['spec'])]
    texts += [encode(m['content']) for m in db.all("SELECT content FROM messages WHERE task_id=? AND role='user'",(tid,))]
    text=' '.join(texts).lower()
    return any(word in text for word in ('gripper','mechanism','moving jaws','linkage','pawl'))


def closure_requested(db,tid):
    text=' '.join(encode(m['content']) for m in db.all("SELECT content FROM messages WHERE task_id=? AND role='user'",(tid,))).lower()
    return any(phrase in text for phrase in ('close and release','moving jaws','opening and closing','closing gripper'))


def completion_errors(engine, run, unresolved):
    errors = ['Unresolved tool error: '+name for name in unresolved]
    db,tid,rid=engine.db,run['task_id'],run['id']
    task=db.require_task(tid)
    calls=db.all('SELECT name,arguments,result,status FROM tool_calls WHERE run_id=? ORDER BY started_at',(rid,))
    artifacts=db.all('SELECT id,name,metadata FROM artifacts WHERE task_id=? AND run_id=? ORDER BY created_at',(tid,rid))
    latest={a['name']:a for a in artifacts}
    cad_calls=[c for c in calls if c['name'] in ('build_cad','revise_cad','build_cad_script','revise_cad_script')]
    requested=' '.join(str(x) for x in task['spec'].get('deliverables',[])).lower()
    if any(x in requested for x in ('stl','step','cad','3d model')) and not cad_calls:
        errors.append('The requested CAD deliverables have not been built in this run')
    if cad_calls:
        report=db.one("SELECT id,metadata FROM artifacts WHERE task_id=? AND run_id=? AND name='validation.json' ORDER BY created_at DESC LIMIT 1",(tid,rid))
        if not report or not report['metadata'].get('validation_passed'):
            errors.append('The latest CAD build must pass numeric validation')
        elif not any(c['name']=='inspect_validation' and c['status']=='completed' and c['arguments'].get('artifact_id')==report['id'] for c in calls):
            errors.append('Inspect the latest validation.json using inspect_validation')
        current_build=report['metadata'].get('build_id') if report else None
        for suffixes in (('.stl',),('.step',),('.cad.json','.cad.py')):
            if not any(a['name'].endswith(suffixes) and a['metadata'].get('build_id')==current_build for a in latest.values()):
                errors.append('Missing current CAD export '+' or '.join(suffixes))
        if not any(a['metadata'].get('kind')=='package' for a in artifacts): errors.append('Package the final artifacts into a ZIP')
        if not any(a['name'].endswith('.md') for a in artifacts): errors.append('Write assembly/manufacturing notes')
        if report:
            build_id=report['metadata'].get('build_id')
            if not any(a['metadata'].get('kind')=='decision' and a['metadata'].get('build_id')==build_id for a in latest.values()):
                errors.append('Use record_decision to summarize the final design and limits, citing the latest validation artifact')
            if engine.settings.provider in VISION_PROVIDERS:
                images={a['id'] for a in artifacts if a['metadata'].get('kind')=='preview_image' and a['metadata'].get('build_id')==build_id}
                # Script builds return their rendered views to the model automatically.
                seen={c['arguments'].get('artifact_id') for c in calls if c['name']=='inspect_image' and c['status']=='completed'}
                seen|={(c['result'] or {}).get('review_image_artifact_id') for c in calls if c['name'] in ('build_cad_script','revise_cad_script') and c['status']=='completed'}
                if not seen&images:
                    errors.append('Visually inspect preview.png from the latest CAD build using inspect_image')
            if mechanism_requested(db,tid):
                motion=list({a['name']:a for a in artifacts if a['metadata'].get('kind')=='motion_validation' and a['metadata'].get('build_id')==build_id}.values())
                if not motion or not all(m['metadata'].get('motion_passed') for m in motion):
                    errors.append('Evaluate moving parts in at least two states with evaluate_motion on the latest CAD source; repair sampled collisions and failed gap checks')
                if not any(a['metadata'].get('kind')=='design_review' and a['metadata'].get('build_id')==build_id for a in artifacts):
                    errors.append('Record a design review for the latest CAD source: evidence per requirement, alternatives, six cycle phases, hardware and bench tests')
                elif closure_requested(db,tid):
                    review=[a for a in artifacts if a['metadata'].get('kind')=='design_review' and a['metadata'].get('build_id')==build_id][-1]
                    if not review['metadata'].get('relative_retaining_motion_verified'):
                        errors.append('The user requested closing retention. A rigid cradle is not equivalent. In record_design_review identify base_part and retaining_parts; evaluate_motion must demonstrate their relative motion in the latest CAD, not only whole-tool travel')
            packages=[a for a in artifacts if a['metadata'].get('kind')=='package']
            if packages:
                included={a['id'] for a in packages[-1]['metadata'].get('manifest',[])}
                current={a['name']:a for a in latest.values() if a['metadata'].get('build_id')==build_id}
                required=[a for a in current.values() if a['metadata'].get('kind') in ('validation','cad_source','cad_script','motion_validation','motion_source','design_review','decision','reconstruction_evidence','simulation_scene','simulation_manifest') or a['name'].endswith(('.step','.stl'))]
                decisions={a['name']:a for a in artifacts if a['metadata'].get('kind')=='decision'}
                required.extend(a for a in decisions.values() if a['metadata'].get('build_id') is None)
                if not {a['id'] for a in required}.issubset(included):
                    errors.append('Package every current STL, STEP, construction source, decision summary and validation report from the same latest build')
                notes={a['name']:a for a in artifacts if a['name'].endswith('.md')}
                if not any(a['id'] in included for a in notes.values()):
                    errors.append('Include the latest assembly/manufacturing notes in the final ZIP')
                cited={aid for a in required if a['metadata'].get('kind')=='decision' for aid in a['metadata']['decision']['evidence_ids']}
                if not cited.issubset(included):
                    errors.append('Include the evidence cited by the current decision summaries in the final ZIP')
    from .rules import undecided, unchecked_must_rules
    if cad_calls and (pending := undecided(db,tid)):
        errors.append('Decide whether these rule sets apply with choose_rules: '+', '.join(pending))
    if cad_calls and (unchecked := unchecked_must_rules(db,tid,rid)):
        errors.append('Record rule checks (record_rule_checks) against the latest build for: '+'; '.join(t[:80] for t in unchecked[:6]))
    if task['plan'] and any(step['status']!='completed' for step in task['plan']):
        errors.append('Finish the visible checklist or report why the task cannot complete')
    return errors


def check_completion(engine, run, unresolved, final_text, attempt=0):
    errors=completion_errors(engine,run,unresolved)
    if not final_text.strip():
        errors.append('Provide a final result summary grounded in the generated artifacts')
    engine.db.emit(run['task_id'],run['id'],'completion.checked',{
        'passed':not errors,'errors':errors,'attempt':attempt+1,
        'title':'Delivery checks passed' if not errors else 'Delivery checks require repair',
    })
    return errors


