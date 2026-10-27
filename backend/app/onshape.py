"""Onshape connection: signed REST calls, imports into tasks, STEP exports back.

The only writes to Onshape are user-started exports (a new document or a new
imported Part Studio). Keys live in the local data directory (or the
environment) and are never returned to the browser.
"""
import base64
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from email.utils import formatdate
from pathlib import Path
from urllib.parse import quote, urlencode, urlparse

import httpx
import numpy as np
from pydantic import Field, field_validator

from .db import uid
from .models import StrictModel

API = '/api/v17'
JSON = 'application/json;charset=UTF-8; qs=0.09'
ID = r'^[0-9a-f]{24}$'
MAX_OCCURRENCES = 200
MAX_UNIQUE_PARTS = 80
MAX_TRIANGLES = 900_000


class OnshapeError(ValueError):
    pass


class OnshapeCredentials(StrictModel):
    base_url: str = Field(default='https://cad.onshape.com', max_length=200)
    access_key: str = Field(min_length=8, max_length=200)
    secret_key: str = Field(min_length=8, max_length=200)

    @field_validator('base_url')
    @classmethod
    def onshape_host(cls, value):
        return normalize_base(value)

    @field_validator('access_key', 'secret_key')
    @classmethod
    def plain_key(cls, value):
        value = value.strip()
        if not re.fullmatch(r'[A-Za-z0-9._~+/=-]+', value):
            raise ValueError('Paste the key exactly as Onshape shows it')
        return value


class OnshapeImport(StrictModel):
    document_id: str = Field(pattern=ID)
    workspace_id: str = Field(pattern=ID)
    element_id: str = Field(pattern=ID)
    task_id: str | None = Field(default=None, max_length=64)
    prompt: str = Field(default='', max_length=8000)


def normalize_base(value):
    # Keys are sent with every request, so only Onshape stacks are reachable.
    parsed = urlparse(value.strip().rstrip('/') or 'https://cad.onshape.com')
    host = (parsed.hostname or '').lower()
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443) \
            or parsed.path not in ('', '/') or not (host == 'onshape.com' or host.endswith('.onshape.com')):
        raise ValueError('Use your Onshape address, such as https://cad.onshape.com or https://company.onshape.com')
    return f'https://{host}'


class CredentialStore:
    def __init__(self, data_dir):
        self.path = Path(data_dir) / 'integrations' / 'onshape.json'

    def load(self):
        env = (os.getenv('ONSHAPE_ACCESS_KEY'), os.getenv('ONSHAPE_SECRET_KEY'))
        if all(env):
            return {'base_url': normalize_base(os.getenv('ONSHAPE_BASE_URL', '')), 'access_key': env[0],
                    'secret_key': env[1], 'source': 'environment'}
        if self.path.is_file():
            return {**json.loads(self.path.read_text()), 'source': 'workspace'}
        return None

    def save(self, credentials, user):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix('.tmp')
        # Owner-only from creation; the secret never goes through a readable file.
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump({**credentials.model_dump(), 'user': user, 'connected_at': time.time()}, f)
        os.replace(tmp, self.path)

    def update_user(self, user):
        if self.path.is_file():
            data = json.loads(self.path.read_text())
            data['user'] = user
            fd = os.open(self.path, os.O_WRONLY | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as f:
                json.dump(data, f)

    def delete(self):
        self.path.unlink(missing_ok=True)

    def status(self):
        saved = self.load()
        if not saved:
            return {'configured': False}
        return {'configured': True, 'source': saved['source'], 'base_url': saved['base_url'],
                'access_key_hint': '…' + saved['access_key'][-4:], 'user': saved.get('user'),
                'connected_at': saved.get('connected_at')}


class OnshapeClient:
    def __init__(self, base_url, access_key, secret_key, transport=None, timeout=60):
        self.base = normalize_base(base_url)
        self.access, self.secret = access_key, secret_key.encode()
        self.http = httpx.Client(transport=transport, timeout=timeout, follow_redirects=False)

    @classmethod
    def from_store(cls, store, transport=None):
        saved = store.load()
        if not saved:
            raise OnshapeError('Connect Onshape in Integrations first')
        return cls(saved['base_url'], saved['access_key'], saved['secret_key'], transport)

    def close(self):
        self.http.close()

    def _signed(self, method, url, accept, ctype='application/json'):
        # The signed content type is the exact header, multipart boundary included.
        parsed = urlparse(url)
        nonce, date = secrets.token_hex(12), formatdate(usegmt=True)
        message = f'{method}\n{nonce}\n{date}\n{ctype}\n{parsed.path}\n{parsed.query}\n'.lower()
        signature = base64.b64encode(hmac.new(self.secret, message.encode(), hashlib.sha256).digest()).decode()
        return {'Date': date, 'On-Nonce': nonce, 'Content-Type': ctype, 'Accept': accept,
                'Authorization': f'On {self.access}:HmacSHA256:{signature}'}

    def get(self, path, params=None, accept=JSON):
        url = f'{self.base}{API}{path}' + (f'?{urlencode(params)}' if params else '')
        for _ in range(4):
            try:
                response = self.http.get(url, headers=self._signed('GET', url, accept))
            except httpx.HTTPError as exc:
                raise OnshapeError(f'Onshape could not be reached: {exc.__class__.__name__}') from exc
            if response.status_code in (301, 302, 303, 307, 308):
                target = urlparse(response.headers.get('location', ''))
                host = (target.hostname or '').lower()
                if target.scheme != 'https' or not (host == 'onshape.com' or host.endswith('.onshape.com')):
                    raise OnshapeError('Onshape redirected outside its own servers; the request was stopped')
                url = target.geturl()
                continue
            if response.status_code in (401, 403):
                raise OnshapeError('Onshape rejected the API keys, or they cannot read this document')
            if response.status_code == 404:
                raise OnshapeError('That Onshape document or element was not found')
            if response.status_code == 429:
                raise OnshapeError('Onshape is rate limiting requests; try again in a minute')
            if response.status_code >= 400:
                raise OnshapeError(f'Onshape returned an error ({response.status_code})')
            return response
        raise OnshapeError('Onshape redirected too many times')

    def json(self, path, params=None):
        return self.get(path, params).json()

    def post(self, path, content, ctype='application/json'):
        url = f'{self.base}{API}{path}'
        try:
            response = self.http.post(url, content=content, headers=self._signed('POST', url, JSON, ctype))
        except httpx.HTTPError as exc:
            raise OnshapeError(f'Onshape could not be reached: {exc.__class__.__name__}') from exc
        if response.status_code in (401, 403):
            raise OnshapeError('Onshape refused the change. The API keys need Write access, and you need '
                               'edit rights on the document.')
        if response.status_code == 404:
            raise OnshapeError('That Onshape document was not found')
        if response.status_code == 429:
            raise OnshapeError('Onshape is rate limiting requests; try again in a minute')
        if response.status_code >= 400:
            raise OnshapeError(f'Onshape returned an error ({response.status_code})')
        return response.json()

    def create_document(self, name):
        info = self.post('/documents', json.dumps({'name': name, 'isPublic': False}).encode())
        return info['id'], info['defaultWorkspace']['id']

    def upload_translation(self, did, wid, filename, content, flatten):
        boundary = secrets.token_hex(16)
        fields = {'formatName': '', 'translate': 'true', 'storeInDocument': 'true', 'yAxisIsUp': 'false',
                  'flattenAssemblies': 'true' if flatten else 'false', 'notifyUser': 'false',
                  'encodedFilename': quote(filename)}
        body = b''.join(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
                        for k, v in fields.items())
        body += (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                 'Content-Type: application/octet-stream\r\n\r\n').encode() + content + f'\r\n--{boundary}--\r\n'.encode()
        return self.post(f'/translations/d/{did}/w/{wid}', body, f'multipart/form-data; boundary="{boundary}"')

    def session(self):
        info = self.json('/users/sessioninfo')
        return {'name': info.get('name') or info.get('firstName') or 'Onshape user', 'email': info.get('email')}

    def documents(self, q='', filter=5, offset=0):
        data = self.json('/documents', {'q': q, 'filter': filter, 'offset': offset, 'limit': 20,
                                        'sortColumn': 'modifiedAt', 'sortOrder': 'desc'})
        items = []
        for d in data.get('items') or []:
            workspace = (d.get('defaultWorkspace') or {}).get('id')
            if not workspace or d.get('jsonType', 'document') != 'document':
                continue
            items.append({'id': d['id'], 'name': d.get('name') or 'Untitled', 'workspace_id': workspace,
                          'modified_at': d.get('modifiedAt'), 'owner': (d.get('owner') or {}).get('name'),
                          'url': f"{self.base}/documents/{d['id']}/w/{workspace}"})
        return {'items': items, 'next': bool(data.get('next')), 'offset': offset}

    def elements(self, did, wid):
        rows = self.json(f'/documents/d/{did}/w/{wid}/elements')
        return [{'id': e['id'], 'name': e.get('name') or 'Untitled', 'type': e['elementType'],
                 'url': f'{self.base}/documents/{did}/w/{wid}/e/{e["id"]}'}
                for e in rows if e.get('elementType') in ('PARTSTUDIO', 'ASSEMBLY')]

    def thumbnail(self, did, wid, eid=None):
        path = f'/thumbnails/d/{did}/w/{wid}' + (f'/e/{eid}' if eid else '') + '/s/300x170'
        response = self.get(path, accept='image/png')
        if not response.headers.get('content-type', '').startswith('image/'):
            raise OnshapeError('Onshape has no thumbnail for this item')
        return response.content, response.headers['content-type'].split(';')[0]

    def part_stl(self, did, wvm, wvmid, eid, part_id, configuration='', link=None):
        params = {'mode': 'binary', 'units': 'millimeter', 'grouping': 'true'}
        if configuration: params['configuration'] = configuration
        if link and link != did: params['linkDocumentId'] = link
        response = self.get(f'/parts/d/{did}/{wvm}/{wvmid}/e/{eid}/partid/{quote(part_id, safe="")}/stl',
                            params, accept='application/octet-stream')
        if len(response.content) > 48 * 1024 * 1024:
            raise OnshapeError('A part mesh is larger than 48 MB; simplify it in Onshape first')
        return response.content


def safe_name(raw, used):
    name = re.sub(r'[^A-Za-z0-9]+', '_', raw or '').strip('_')[:44] or 'part'
    if not name[0].isalpha(): name = 'p_' + name
    candidate, n = name, 2
    while candidate.lower() in used:
        candidate, n = f'{name}_{n}', n + 1
    used.add(candidate.lower())
    return candidate


def read_stl(content):
    import trimesh
    try:
        mesh = trimesh.load(io.BytesIO(content), file_type='stl', force='mesh', process=True)
    except Exception as exc:
        raise OnshapeError('Onshape returned a mesh that could not be read') from exc
    if not len(mesh.faces):
        raise OnshapeError('Onshape returned an empty mesh for a part')
    return mesh


def plan_parts(client, info, element):
    """Each entry: one displayed body, its source part, and its placement (mm)."""
    did, wid, eid = info.document_id, info.workspace_id, info.element_id
    if element['type'] == 'PARTSTUDIO':
        parts = [p for p in client.json(f'/parts/d/{did}/w/{wid}/e/{eid}')
                 if p.get('bodyType', 'solid') == 'solid' and not p.get('isHidden')]
        if not parts: raise OnshapeError('This Part Studio has no visible solid parts')
        return [{'label': p.get('name') or p['partId'], 'source': (did, 'w', wid, eid, p['partId'], '', None),
                 'transform': np.eye(4), 'part_id': p['partId']} for p in parts]
    definition = client.json(f'/assemblies/d/{did}/w/{wid}/e/{eid}',
                             {'includeMateFeatures': 'false', 'includeNonSolids': 'false', 'excludeSuppressed': 'true'})
    root = definition.get('rootAssembly') or {}
    instances = {i['id']: i for a in [root, *(definition.get('subAssemblies') or [])] for i in a.get('instances') or []}
    planned = []
    for occurrence in root.get('occurrences') or []:
        leaf = instances.get((occurrence.get('path') or [''])[-1])
        if not leaf or leaf.get('type') != 'Part' or leaf.get('suppressed') or occurrence.get('hidden'):
            continue
        matrix = np.array(occurrence.get('transform') or np.eye(4).ravel(), dtype=float).reshape(4, 4)
        matrix[:3, 3] *= 1000  # Onshape placements are in metres.
        source = (leaf['documentId'], 'm', leaf['documentMicroversion'], leaf['elementId'], leaf['partId'],
                  leaf.get('configuration') or '', did)
        planned.append({'label': leaf.get('name') or leaf['partId'], 'source': source, 'transform': matrix,
                        'part_id': leaf['partId']})
    if not planned: raise OnshapeError('This assembly has no visible parts')
    return planned


def import_element(client, store, db, info):
    elements = {e['id']: e for e in client.elements(info.document_id, info.workspace_id)}
    element = elements.get(info.element_id)
    if not element:
        raise OnshapeError('Choose a Part Studio or Assembly from this document')
    document = client.json(f'/documents/{info.document_id}')
    planned = plan_parts(client, info, element)
    unique = list(dict.fromkeys(p['source'] for p in planned))
    if len(planned) > MAX_OCCURRENCES or len(unique) > MAX_UNIQUE_PARTS:
        raise OnshapeError(f'This element has {len(planned)} part instances; import up to {MAX_OCCURRENCES} '
                           f'({MAX_UNIQUE_PARTS} distinct parts) or a sub-assembly')
    with ThreadPoolExecutor(4) as pool:
        downloads = dict(zip(unique, pool.map(lambda s: client.part_stl(*s), unique)))
    meshes = {source: read_stl(content) for source, content in downloads.items()}
    if sum(len(meshes[p['source']].faces) for p in planned) > MAX_TRIANGLES:
        raise OnshapeError('The meshes are too detailed to preview here; import a smaller sub-assembly')

    used_files, used_bodies, files = set(), set(), {}
    for p in planned:
        if p['source'] not in files:
            files[p['source']] = safe_name(re.sub(r'\s*<\d+>$', '', p['label']), used_files)
    bodies, manifest_parts = [], []
    for p in planned:
        mesh = meshes[p['source']]
        vertices = mesh.vertices @ p['transform'][:3, :3].T + p['transform'][:3, 3]
        name = safe_name(p['label'], used_bodies)
        bodies.append({'name': name, 'vertices': np.round(vertices, 4).tolist(), 'faces': mesh.faces.tolist()})
        lo, hi = vertices.min(0), vertices.max(0)
        manifest_parts.append({'name': name, 'onshape_name': p['label'], 'part_id': p['part_id'],
                               'stl': files[p['source']] + '.stl', 'triangles': int(len(mesh.faces)),
                               'watertight': bool(mesh.is_watertight),
                               'volume_mm3': round(float(mesh.volume), 3) if mesh.is_watertight else None,
                               'bounds_mm': [round(float(v), 3) for v in hi - lo],
                               'position_mm': [round(float(v), 3) for v in (lo + hi) / 2],
                               'transform': [round(float(v), 6) for v in p['transform'].ravel()]})
    assembly = np.vstack([np.array(b['vertices']) for b in bodies])
    url = f'{client.base}/documents/{info.document_id}/w/{info.workspace_id}/e/{info.element_id}'
    manifest = {
        'source': 'onshape', 'document': document.get('name'), 'element': element['name'],
        'element_type': element['type'], 'url': url, 'document_id': info.document_id,
        'workspace_id': info.workspace_id, 'element_id': info.element_id, 'imported_at': time.time(),
        'units': 'mm', 'assembly_bounds_mm': [round(float(v), 3) for v in assembly.max(0) - assembly.min(0)],
        'parts': manifest_parts,
        'quantities': {f + '.stl': sum(1 for p in planned if p['source'] == s) for s, f in files.items()},
        'limitations': ['Read-only mesh snapshot of the workspace at import time; Onshape features, mates '
                        'and parameters are not imported.', 'STL files are in each part\'s Part Studio '
                        'coordinates; the 3D preview applies the assembly placements.'],
    }
    task_id = info.task_id
    if task_id:
        db.require_task(task_id)
    else:
        task_id = db.create_import_task(f"{document.get('name') or 'Onshape'} · {element['name']}")
    build = uid()
    meta = {'build_id': build, 'source': 'onshape', 'units': 'mm', 'onshape_url': url}
    saved = [store.put(task_id, None, f + '.stl', downloads[s], {**meta, 'kind': 'cad'}) for s, f in files.items()]
    mesh_json = {'units': 'mm', 'kind': 'onshape_import', 'parts': bodies}
    saved.append(store.put(task_id, None, 'preview.mesh.json',
                           json.dumps(mesh_json, separators=(',', ':')).encode(), {**meta, 'kind': 'mesh_preview'}))
    manifest_file = store.put(task_id, None, 'onshape_import.json', json.dumps(manifest, indent=2).encode(),
                              {**meta, 'kind': 'onshape_import'})
    saved.append(manifest_file)
    try:
        image, media = client.thumbnail(info.document_id, info.workspace_id, info.element_id)
        if media == 'image/png':
            saved.append(store.put(task_id, None, 'onshape_thumbnail.png', image,
                                   {**meta, 'kind': 'preview_image'}))
    except OnshapeError:
        pass  # A thumbnail is a convenience; the geometry import already succeeded.
    with db.transaction() as c:
        db.message(c, task_id, None, 'user', 'attachment',
                   {'artifact_id': manifest_file['id'], 'name': manifest_file['name']})
        db.event(c, task_id, None, 'onshape.imported',
                 {'document': manifest['document'], 'element': manifest['element'], 'parts': len(bodies),
                  'url': url})
    run_id = db.add_message(task_id, info.prompt.strip()) if info.prompt.strip() else None
    return {'task_id': task_id, 'run_id': run_id, 'build_id': build, 'parts': len(bodies),
            'files': len(files), 'artifacts': saved,
            'preview_artifact_id': next(a['id'] for a in saved if a['name'] == 'preview.mesh.json')}


class OnshapeExport(StrictModel):
    task_id: str = Field(min_length=1, max_length=64)
    artifact_id: str = Field(min_length=1, max_length=64)
    document_id: str | None = Field(default=None, pattern=ID)
    workspace_id: str | None = Field(default=None, pattern=ID)
    new_document_name: str = Field(default='', max_length=100)
    flatten: bool = True


def export_step(client, store, db, info, sleep=time.sleep, wait=150):
    """Upload a generated STEP file and let Onshape translate it into a Part Studio."""
    row, path = store.get(info.task_id, info.artifact_id)
    if path.suffix.lower() not in ('.step', '.stp'):
        raise OnshapeError('Choose a STEP file to send to Onshape')
    if bool(info.document_id) != bool(info.workspace_id):
        raise OnshapeError('Choose an Onshape document and workspace')
    created = not info.document_id
    if created:
        did, wid = client.create_document((info.new_document_name or Path(row['name']).stem).strip()[:100])
    else:
        did, wid = info.document_id, info.workspace_id
    before = {e['id'] for e in client.elements(did, wid)}
    translation = client.upload_translation(did, wid, row['name'], path.read_bytes(), info.flatten)
    state, waited, delay = translation.get('requestState'), 0, 1
    # Back off between polls; Onshape asks clients not to poll several times a second.
    while state == 'ACTIVE' and waited < wait:
        sleep(delay)
        waited += delay
        delay = min(delay * 2, 8)
        translation = client.json(f"/translations/{translation['id']}")
        state = translation.get('requestState')
    if state == 'FAILED':
        raise OnshapeError(f"Onshape could not translate {row['name']}: "
                           f"{translation.get('failureReason') or 'no reason given'}")
    document_url = f'{client.base}/documents/{did}/w/{wid}'
    new = [e for e in client.elements(did, wid) if e['id'] not in before] if state == 'DONE' else []
    result = {'state': 'done' if state == 'DONE' else 'translating', 'document_id': did, 'workspace_id': wid,
              'created_document': created, 'document_url': document_url,
              'elements': new, 'url': new[0]['url'] if new else document_url, 'file': row['name'],
              'version': row['version']}
    with db.transaction() as c:
        db.event(c, info.task_id, None, 'onshape.exported',
                 {'file': row['name'], 'version': row['version'], 'artifact_id': row['id'], **{
                     k: result[k] for k in ('state', 'document_url', 'url', 'created_document')}})
    return result
