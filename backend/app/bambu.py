"""Bambu Studio integration: headless slicing of a CAD build with the user's profiles.

Runs the locally installed Bambu Studio CLI on the build's STL parts (one plate,
auto-arranged, each part in its saved print orientation) and reads back Bambu's
own estimate, filament use and warnings, such as floating cantilevers that need
support. Profiles come from the app's bundled BBL system presets.
"""
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import time

from pydantic import Field

from .models import StrictModel

APP = Path(os.getenv('6B_BAMBU_STUDIO', '/Applications/BambuStudio.app'))
DEFAULTS = {'machine': 'Bambu Lab X1 Carbon 0.4 nozzle', 'process': '0.20mm Standard @BBL X1C',
            'filament': 'Bambu PETG HF @BBL X1C'}
_index = {}


class BambuSettings(StrictModel):
    machine: str = Field(min_length=1, max_length=120)
    process: str = Field(min_length=1, max_length=120)
    filament: str = Field(min_length=1, max_length=120)
    # Saving profiles connects Bambu Studio; until then 6B and its agent never slice with it.
    enabled: bool = True


def binary():
    exe = APP / 'Contents' / 'MacOS' / 'BambuStudio'
    if exe.is_file():
        return exe
    found = shutil.which('bambu-studio')
    return Path(found) if found else None


def profiles_dir():
    return APP / 'Contents' / 'Resources' / 'profiles' / 'BBL'


def version():
    try:
        return plistlib.loads((APP / 'Contents' / 'Info.plist').read_bytes()).get('CFBundleShortVersionString')
    except OSError:
        return None


def _profiles(kind):
    """name -> (path, json) for every profile of a kind; cached per process."""
    if kind not in _index:
        entries = {}
        for path in (profiles_dir() / kind).glob('*.json'):
            try:
                data = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            if data.get('name'):
                entries[data['name']] = (path, data)
        _index[kind] = entries
    return _index[kind]


def resolved(kind, name, key):
    """Follow `inherits` until a profile defines key."""
    seen = set()
    while name and name not in seen:
        seen.add(name)
        entry = _profiles(kind).get(name)
        if not entry:
            return None
        if key in entry[1]:
            return entry[1][key]
        name = entry[1].get('inherits')
    return None


def catalog(machine=None):
    """Printers, and the processes and filaments compatible with the chosen printer."""
    machines = sorted(n for n, (_, d) in _profiles('machine').items()
                      if d.get('instantiation') == 'true' and 'nozzle' in n)
    machine = machine if machine in machines else DEFAULTS['machine']

    def compatible(kind):
        return sorted(n for n, (_, d) in _profiles(kind).items()
                      if d.get('instantiation') == 'true' and machine in (d.get('compatible_printers') or []))
    return {'machines': machines, 'machine': machine, 'processes': compatible('process'),
            'filaments': compatible('filament')}


class Store:
    def __init__(self, data_dir):
        self.path = Path(data_dir) / 'integrations' / 'bambu.json'

    def load(self):
        try:
            return {**DEFAULTS, 'enabled': False, **json.loads(self.path.read_text())}
        except (OSError, ValueError):
            return {**DEFAULTS, 'enabled': False}

    def connected(self):
        """Installed and switched on by the user; off by default."""
        return bool(binary()) and bool(self.load().get('enabled'))

    def disconnect(self):
        if self.path.exists():
            self.path.write_text(json.dumps({**self.load(), 'enabled': False}, indent=2))
        return self.load()

    def save(self, settings):
        options = catalog(settings.machine)
        if settings.machine not in options['machines']:
            raise ValueError('Choose a printer from the Bambu Studio list')
        if settings.process not in options['processes'] or settings.filament not in options['filaments']:
            raise ValueError('That process or filament is not compatible with the chosen printer')
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(settings.model_dump(), indent=2))
        return self.load()


def status(store):
    exe = binary()
    settings = store.load()
    area = resolved('machine', settings['machine'], 'printable_area')
    height = resolved('machine', settings['machine'], 'printable_height')
    bed = None
    if area:
        xs, ys = zip(*(tuple(float(v) for v in p.split('x')) for p in area))
        bed = [max(xs) - min(xs), max(ys) - min(ys), float(height) if height else None]
    return {'installed': bool(exe), 'connected': bool(exe) and bool(settings.get('enabled')),
            'version': version() if exe else None, 'path': str(APP) if exe else None,
            'settings': {k: settings[k] for k in DEFAULTS}, 'bed_mm': bed}


def _gcode_stats(path):
    stats = {}
    with open(path, errors='replace') as handle:
        for line in handle:
            if not line.startswith(';'):
                if len(stats) >= 4:
                    break
                continue
            if (m := re.search(r'total estimated time: ([^;]+)', line)):
                stats['estimated_time'] = m.group(1).strip()
            elif (m := re.match(r'; total filament length \[mm\] : ([\d.]+)', line)):
                stats['filament_mm'] = float(m.group(1))
            elif (m := re.match(r'; total filament volume \[cm\^3\] : ([\d.]+)', line)):
                stats['filament_volume_mm3'] = float(m.group(1))  # Bambu labels mm³ as cm³.
            elif (m := re.match(r'; total layer number: (\d+)', line)):
                stats['layers'] = int(m.group(1))
    return stats


def _slice_error(message):
    message = message or 'Slicing failed'
    if 'boundary' in message:
        # Bambu arranges everything on one plate; a split into plates is the caller's choice.
        message += ' The parts do not fit on one plate together: slice them in smaller groups with parts=[...].'
    return message


def slice_parts(store, stls, work, timeout=240):
    """Slice the given STL files on one plate; returns (summary, project_3mf_path)."""
    exe = binary()
    if not exe:
        raise ValueError('Bambu Studio is not installed; install it or set 6B_BAMBU_STUDIO')
    settings = store.load()
    profile = lambda kind, name: str(_profiles(kind)[name][0])
    try:
        machine, process = profile('machine', settings['machine']), profile('process', settings['process'])
        filament = profile('filament', settings['filament'])
    except KeyError:
        raise ValueError('The saved Bambu printer, process or filament profile was not found; choose them again')
    work.mkdir(parents=True, exist_ok=True)
    local = []
    for stl in stls:
        target = work / Path(stl).name
        shutil.copyfile(stl, target)
        local.append(str(target))
    command = [str(exe), '--orient', '0', '--arrange', '1', '--load-settings', f'{machine};{process}',
               '--load-filaments', filament, '--slice', '0', '--export-3mf', 'bambu_project.3mf',
               '--outputdir', str(work), *local]
    started = time.monotonic()
    try:
        done = subprocess.run(command, cwd=work, capture_output=True, text=True, timeout=timeout,
                              env={k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'TMPDIR', 'LANG')})
    except subprocess.TimeoutExpired:
        raise ValueError(f'Bambu Studio did not finish slicing within {timeout} s')
    result_path = work / 'result.json'
    if not result_path.exists():
        raise ValueError('Bambu Studio exited without a result: ' + (done.stderr or done.stdout)[-400:])
    result = json.loads(result_path.read_text())
    plate = (result.get('sliced_plates') or [{}])[0]
    gcode = next(work.glob('plate_*.gcode'), None)
    stats = _gcode_stats(gcode) if gcode else {}
    density = resolved('filament', settings['filament'], 'filament_density')
    density = float(density[0] if isinstance(density, list) else density) if density else None
    grams = round(stats['filament_volume_mm3'] / 1000 * density, 1) if density and 'filament_volume_mm3' in stats else None
    times = plate.get('feature_type_times') or {}
    warnings = [w.strip() for w in re.split(r'\n+', plate.get('warning_message') or '') if w.strip()]
    summary = {
        'ok': bool(gcode) and result.get('return_code', 0) in (0, -13),  # -13: only the project export failed
        'error': None if gcode else _slice_error(result.get('error_string')),
        'printer': settings['machine'], 'process': settings['process'], 'filament': settings['filament'],
        'estimated_time': stats.get('estimated_time'),
        'estimated_seconds': round(plate.get('total_predication') or 0),
        'filament_m': round(stats['filament_mm'] / 1000, 2) if 'filament_mm' in stats else None,
        'filament_g': grams, 'layers': stats.get('layers'),
        'supports_enabled': False,
        'overhang_wall_s': round(times.get('Overhang wall', 0)), 'bridge_s': round(times.get('Bridge', 0)),
        'objects': [{'name': o.get('name'), 'size_mm': [round(o['bbox'][k], 1) for k in ('width', 'depth', 'height')]}
                    for o in plate.get('objects') or [] if o.get('bbox')],
        'warnings': warnings,
        'seconds': round(time.monotonic() - started, 1),
        'note': "Bambu Studio's own slice of the saved STLs with the chosen profiles, supports off. Warnings come "
                'from Bambu Studio; the estimate assumes this printer and filament.',
    }
    project = work / 'bambu_project.3mf'
    return summary, (project if project.exists() else None), gcode


REFERENCE = re.compile(r'(^|_)(ref|reference)$')


def slice_build(db, store, settings_store, tid, rid, build_id=None, work_root=None, parts=None):
    """Slice a build's printed STLs (latest build by default) and save the summary and 3MF project."""
    if not settings_store.connected():
        raise ValueError('Bambu Studio is not connected. Connect it in Integrations to slice with it.')
    row = db.one("SELECT metadata FROM artifacts WHERE task_id=? AND json_extract(metadata,'$.kind')='validation' "
                 + ("AND json_extract(metadata,'$.build_id')=? " if build_id else '') + 'ORDER BY created_at DESC LIMIT 1',
                 (tid, build_id) if build_id else (tid,))
    if not row:
        raise ValueError('There is no CAD build to slice yet')
    build_id = row['metadata']['build_id']
    files = db.all("SELECT id,name FROM artifacts WHERE task_id=? AND json_extract(metadata,'$.build_id')=? "
                   "AND name LIKE '%.stl' ORDER BY name", (tid, build_id))
    stem = lambda f: f['name'][:-4]
    if parts:
        missing = sorted(set(parts) - {stem(f) for f in files})
        if missing:
            raise ValueError(f'Not in this build: {", ".join(missing)}. Parts: {", ".join(stem(f) for f in files)}')
        files = [f for f in files if stem(f) in parts]
    else:
        files = [f for f in files if not REFERENCE.search(stem(f))]
    if not files:
        raise ValueError('This build has no STL parts to slice')
    from .db import uid
    work = Path(work_root) / uid()
    summary, project, _ = slice_parts(settings_store, [store.get(tid, f['id'])[1] for f in files], work)
    summary['parts'] = [stem(f) for f in files]
    meta = {'build_id': build_id, 'printer': summary['printer'], 'filament': summary['filament']}
    saved = store.put(tid, rid, 'bambu_slice.json', json.dumps(summary, indent=2).encode(),
                      {**meta, 'kind': 'print_slice', 'slice_ok': summary['ok'], 'warnings': len(summary['warnings'])})
    summary['artifact_id'] = saved['id']
    if project:
        summary['project_artifact_id'] = store.put(tid, rid, 'bambu_project.3mf', project.read_bytes(),
                                                   {**meta, 'kind': 'print_project'})['id']
    db.emit(tid, rid, 'print.sliced', {'build_id': build_id, 'ok': summary['ok'], 'warnings': summary['warnings'],
                                        'estimated_time': summary['estimated_time'], 'filament_g': summary['filament_g']})
    return summary
