"""Sandboxed runner for model-written CadQuery scripts (see cad_script.py)."""
import io
import json
import os
from pathlib import Path
import sys
import traceback
import zipfile


def run_script(source):
    """Execute a validated script with restricted builtins; return parts and printed log."""
    import math
    import cadquery as cq
    from cadquery.occ_impl.shapes import setThreads
    from .cad_script import ALLOWED_MODULES, SAFE_BUILTINS, ScriptError, validate_script
    setThreads(1)
    tree = validate_script(source)
    modules = {'cadquery': cq, 'math': math}
    log = []

    def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
        if level or name not in ALLOWED_MODULES:
            raise ImportError(f'Only cadquery and math can be imported, not {name}')
        return modules[name]

    def capture(*values, sep=' ', end='\n'):
        if len(log) < 200:
            log.append(sep.join(map(str, values))[:500])

    env = {'__builtins__': {**SAFE_BUILTINS, '__import__': guarded_import, 'print': capture}, '__name__': '6b_cad'}
    sys.setrecursionlimit(400)
    try:
        exec(compile(tree, '<cad-script>', 'exec'), env)
    except ScriptError:
        raise
    except RecursionError:
        raise ScriptError('Recursion is too deep') from None
    except Exception as exc:
        frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename == '<cad-script>']
        line = frames[-1].lineno if frames else None
        text = f'{type(exc).__name__}: {str(exc)[:600] or "the CAD kernel could not build this feature"}'
        if line:
            text += f'\n    {source.splitlines()[line - 1].strip()[:200]}'
        raise ScriptError(text, line) from None
    return env, log


def as_workplane(name, value):
    import cadquery as cq
    if isinstance(value, cq.Workplane):
        shapes = [v for v in value.vals() if isinstance(v, cq.Shape)]
    elif isinstance(value, cq.Shape):
        shapes = [value]
    else:
        raise ValueError(f'parts["{name}"] must be a CadQuery Workplane or Shape, not {type(value).__name__}')
    solids = [s for shape in shapes for s in shape.Solids()]
    if not solids:
        raise ValueError(f'parts["{name}"] contains no solid; close sketches and extrude, revolve or loft them')
    single = solids[0] if len(solids) == 1 else cq.Compound.makeCompound(solids)
    return cq.Workplane('XY').newObject([single])


def build(request, out: Path):
    from .cad_script import extract_parameters
    from .cad_worker import export_build
    source, name = request['script'], request['name']
    out.mkdir(parents=True, exist_ok=True)
    env, log = run_script(source)
    parts, rotations = env.get('parts'), env.get('print_rotation') or {}
    if not isinstance(parts, dict) or not 1 <= len(parts) <= 24:
        raise ValueError('parts must be a dict of 1-24 named shapes')
    import re
    placements = []
    for part_name, value in parts.items():
        if not isinstance(part_name, str) or not re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_]{0,49}', part_name):
            raise ValueError(f'Part name {part_name!r} must start with a letter and use letters, digits or _')
        rotation = tuple(float(x) for x in rotations.get(part_name, (0, 0, 0)))
        if len(rotation) != 3:
            raise ValueError(f'print_rotation["{part_name}"] needs three angles')
        placed = as_workplane(part_name, value)
        placements.append({'name': part_name, 'base': placed, 'placed': placed, 'print_rotation': rotation})
    (out / f'{name}.cad.py').write_text(source)
    report = export_build(name, placements, request['print_bed'], request.get('notes', []), out)
    report['source'] = 'cad_script'
    # Exact solids let motion and fit checks reuse geometry without re-running code.
    with zipfile.ZipFile(out / f'{name}.geometry.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        for item in placements:
            stream = io.BytesIO()
            item['placed'].val().exportBrep(stream)
            archive.writestr(f'{item["name"]}.brep', stream.getvalue())
        archive.writestr('index.json', json.dumps({'parts': [p['name'] for p in placements], 'units': 'mm'}))
    meta = {'parameters': [{k: v for k, v in p.items() if k not in ('col', 'end_col')} for p in extract_parameters(source)],
            'parts': [p['name'] for p in placements], 'log': log}
    (out / 'script.json').write_text(json.dumps(meta))
    (out / 'validation.json').write_text(json.dumps(report, indent=2))
    return report, meta


def main():
    if os.name == 'posix':
        import resource
        # CPU time sums across threads and OCC meshing is parallel; the parent's wall
        # timeout is the real bound, so scale this backstop with the core count.
        cpu = min(1600, 100 * (os.cpu_count() or 1))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 5))
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
        try:
            resource.setrlimit(resource.RLIMIT_AS, (6 * 1024 ** 3, 6 * 1024 ** 3))
        except (ValueError, OSError):
            pass  # macOS does not enforce address-space limits.
    src, dest = Path(sys.argv[1]), Path(sys.argv[2])
    try:
        report, meta = build(json.loads(src.read_text()), dest)
        print(json.dumps({'ok': True, 'report': report, 'script': meta}))
    except Exception as exc:
        from .cad_script import ScriptError
        traceback.print_exc(file=sys.stderr)
        line = exc.line if isinstance(exc, ScriptError) else None
        message = str(exc) if isinstance(exc, ScriptError) else f'{type(exc).__name__}: {str(exc)[:1200]}'
        print(json.dumps({'ok': False, 'error': message[:1600], 'line': line}))
        sys.exit(1)


if __name__ == '__main__':
    main()
