"""What changed between two CAD builds of a task: parts, parameters, checks, source.

Measured from each build's saved validation, preview mesh and source; it reports
geometry and check differences, not whether the change meets the design intent.
"""
import difflib
import json

SOURCE_KINDS = ('cad_script', 'cad_source')


def build_files(db, tid, build_id):
    rows = db.all("SELECT id,name,version,metadata,created_at FROM artifacts WHERE task_id=? "
                  "AND json_extract(metadata,'$.build_id')=? ORDER BY created_at", (tid, build_id))
    return {r['metadata'].get('kind'): r for r in rows}


def builds(db, tid):
    """Builds in creation order, labelled by their source file version."""
    rows = db.all("SELECT id,name,version,metadata,created_at,run_id FROM artifacts WHERE task_id=? "
                  "AND json_extract(metadata,'$.kind') IN ('cad_script','cad_source') ORDER BY created_at", (tid,))
    return [{'build_id': r['metadata']['build_id'], 'source': r['name'], 'version': r['version'],
             'created_at': r['created_at'], 'origin': r['metadata'].get('origin') or ('assistant' if r['run_id'] else 'user'),
             'passed': r['metadata'].get('validation_passed')} for r in rows]


def previous_build(db, tid, build_id):
    """The latest earlier build of the same source file, else the latest earlier build."""
    history = builds(db, tid)
    current = next((b for b in history if b['build_id'] == build_id), None)
    if not current:
        return None
    earlier = [b for b in history if b['created_at'] < current['created_at'] and b['build_id'] != build_id]
    same = [b for b in earlier if b['source'] == current['source']]
    return (same or earlier or [None])[-1]


def _box(part):
    xs, ys, zs = zip(*part['vertices']) if part['vertices'] else ((0,), (0,), (0,))
    lo, hi = (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))
    return [round((a + b) / 2, 3) for a, b in zip(lo, hi)], [round(b - a, 3) for a, b in zip(lo, hi)]


def _load(store, tid, row):
    if not row:
        return None
    _, path = store.get(tid, row['id'])
    return path.read_text()


def compare_builds(db, store, tid, old_build, new_build):
    old, new = build_files(db, tid, old_build), build_files(db, tid, new_build)
    if 'validation' not in old or 'validation' not in new:
        raise ValueError('Both builds need a saved validation report to compare')
    report = {name: json.loads(_load(store, tid, files['validation'])) for name, files in (('old', old), ('new', new))}
    meshes = {name: {p['name']: p for p in json.loads(_load(store, tid, files['mesh_preview']))['parts']}
              if 'mesh_preview' in files else {} for name, files in (('old', old), ('new', new))}
    checks = {name: {p['part']: p for p in report[name]['parts']} for name in report}
    names = list(dict.fromkeys([*checks['old'], *checks['new']]))
    parts = []
    for name in names:
        a, b = checks['old'].get(name), checks['new'].get(name)
        entry = {'part': name, 'status': 'added' if not a else 'removed' if not b else 'unchanged'}
        if a and b:
            ca, sa = _box(meshes['old'][name]) if name in meshes['old'] else (None, a['bounds_mm'])
            cb, sb = _box(meshes['new'][name]) if name in meshes['new'] else (None, b['bounds_mm'])
            volume = b['volume_mm3'] - a['volume_mm3']
            moved = [round(y - x, 3) for x, y in zip(ca, cb)] if ca and cb else [0, 0, 0]
            resized = [round(y - x, 3) for x, y in zip(sa, sb)]
            entry.update(volume_mm3=[a['volume_mm3'], b['volume_mm3']], volume_delta_mm3=round(volume, 3),
                         volume_delta_percent=round(100 * volume / a['volume_mm3'], 2) if a['volume_mm3'] else None,
                         size_mm=[sa, sb], size_delta_mm=resized, moved_mm=moved,
                         passed=[a['passed'], b['passed']],
                         printability=[(a.get('printability') or {}).get('status'), (b.get('printability') or {}).get('status')])
            if abs(volume) > max(0.5, 1e-4 * a['volume_mm3']) or any(abs(x) > 0.01 for x in resized + moved):
                entry['status'] = 'changed'
        elif b or a:
            row = b or a
            entry.update(volume_mm3=row['volume_mm3'], size_mm=row['bounds_mm'], passed=row['passed'])
        parts.append(entry)

    sources = {name: next((files[k] for k in SOURCE_KINDS if k in files), None) for name, files in (('old', old), ('new', new))}
    parameters = []
    if all(s and s['metadata'].get('kind') == 'cad_script' for s in sources.values()):
        before = {p['name']: p['value'] for p in sources['old']['metadata'].get('parameters', [])}
        after = {p['name']: p['value'] for p in sources['new']['metadata'].get('parameters', [])}
        for key in dict.fromkeys([*before, *after]):
            if before.get(key) != after.get(key):
                parameters.append({'name': key, 'old': before.get(key), 'new': after.get(key)})
    texts = [(_load(store, tid, sources[n]) or '').splitlines() for n in ('old', 'new')]
    diff = list(difflib.unified_diff(texts[0], texts[1], 'before', 'after', lineterm='', n=2))
    added = sum(1 for line in diff if line.startswith('+') and not line.startswith('+++'))
    removed = sum(1 for line in diff if line.startswith('-') and not line.startswith('---'))

    def status(name):
        return {'passed': report[name]['passed'], 'interferences': len(report[name]['interferences']),
                'printability': (report[name].get('printability') or {}).get('status'),
                'assembly_bounds_mm': report[name]['assembly_bounds_mm']}

    counts = {k: sum(1 for p in parts if p['status'] == k) for k in ('changed', 'added', 'removed', 'unchanged')}
    lines = [', '.join(f'{v} part{"s" if v != 1 else ""} {k}' for k, v in counts.items() if v and k != 'unchanged')
             or 'No geometry changes']
    for p in parts:
        if p['status'] == 'changed':
            bits = []
            if p['volume_delta_percent'] is not None and abs(p['volume_delta_percent']) >= 0.05:
                bits.append(f'volume {p["volume_delta_percent"]:+.1f}%')
            if any(abs(x) > 0.01 for x in p['size_delta_mm']):
                bits.append('size ' + ' × '.join(f'{x:.1f}' for x in p['size_mm'][0]) + ' → ' +
                            ' × '.join(f'{x:.1f}' for x in p['size_mm'][1]) + ' mm')
            if any(abs(x) > 0.01 for x in p['moved_mm']):
                bits.append('moved ' + ', '.join(f'{x:+.1f}' for x in p['moved_mm']) + ' mm')
            lines.append(f'{p["part"]}: ' + ('; '.join(bits) or 'shape changed'))
    def change(p):
        if p['old'] is None: return f'{p["name"]} added ({p["new"]})'
        if p['new'] is None: return f'{p["name"]} removed'
        return f'{p["name"]} {p["old"]} → {p["new"]}'
    if parameters:
        lines.append('Parameters: ' + ', '.join(change(p) for p in parameters[:8]) +
                     (f' and {len(parameters) - 8} more' if len(parameters) > 8 else ''))
    before, after = status('old'), status('new')
    for key, text in (('passed', 'Validation'), ('printability', 'Printability'), ('interferences', 'Overlaps')):
        if before[key] != after[key]:
            lines.append(f'{text}: {before[key]} → {after[key]}')
    return {'from_build': old_build, 'to_build': new_build,
            'from': {'source': sources['old'] and sources['old']['name'], 'version': sources['old'] and sources['old']['version']},
            'to': {'source': sources['new'] and sources['new']['name'], 'version': sources['new'] and sources['new']['version']},
            'summary': lines, 'counts': counts, 'parts': parts, 'parameters': parameters,
            'checks': {'before': before, 'after': after},
            'source_diff': {'added_lines': added, 'removed_lines': removed, 'text': '\n'.join(diff)[:12000],
                            'truncated': len('\n'.join(diff)) > 12000},
            'note': 'Measured differences between saved builds; whether they meet the intent still needs review.'}
