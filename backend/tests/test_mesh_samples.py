import hashlib
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import pytest
import trimesh

from app.mesh_samples import MeshSamples, ROOT

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from prepare_mesh_samples import geometry_preview


@pytest.mark.parametrize('sample', MeshSamples().items, ids=lambda item: item['id'])
def test_samples_are_complete_and_download_originals_offline(app, sample):
    client = app.test_client()
    listed = client.get('/api/mesh-samples').get_json()
    assert sample in listed
    response = client.get(f'/api/mesh-samples/{sample["id"]}/original')
    assert response.status_code == 200
    assert response.mimetype == 'model/gltf-binary'
    assert response.data[:4] == b'glTF'
    assert len(response.data) == sample['size']
    assert hashlib.sha256(response.data).hexdigest() == sample['sha256']
    assert response.headers['ETag'] == f'"{sample["sha256"]}"'
    assert 'attachment' in response.headers['Content-Disposition']
    notice = client.get(f'/api/mesh-samples/{sample["id"]}/notice')
    assert notice.status_code == 200
    assert b'creativecommons.org/publicdomain/zero/1.0' in notice.data
    preview_response = client.get(f'/api/mesh-samples/{sample["id"]}/preview')
    assert hashlib.sha256(preview_response.data).hexdigest() == sample['preview_sha256']
    preview = preview_response.get_json()
    assert preview['kind'] == 'reference_mesh' and preview['units'] == 'mm'
    assert len(preview['parts']) == sample['parts']
    assert len({part['name'] for part in preview['parts']}) == sample['parts']
    assert sum(len(part['faces']) for part in preview['parts']) == sample['triangles']
    for part in preview['parts']:
        vertices, faces = np.array(part['vertices']), np.array(part['faces'])
        assert vertices.shape[1] == faces.shape[1] == 3
        assert np.isfinite(vertices).all()
        assert faces.min() >= 0 and faces.max() < len(vertices)
    # Browsing the catalogue never starts model generation or creates sample tasks.
    assert app.state.db.all('SELECT id FROM tasks') == []
    assert app.state.db.all('SELECT id FROM runs') == []


def test_unknown_samples_and_file_kinds_are_rejected(app):
    client = app.test_client()
    for route in ('missing/preview', 'avocado/catalogue.json', 'avocado/original.glb', '../.env'):
        assert client.get('/api/mesh-samples/' + route).status_code == 404
    app.state.settings.api_token = 'test-token'
    assert client.get('/api/mesh-samples').status_code == 401
    assert client.get('/api/mesh-samples/avocado/original').status_code == 401
    assert client.get('/api/mesh-samples', headers={'Authorization': 'Bearer test-token'}).status_code == 200
    assert client.get('/api/mesh-samples', headers={'Authorization': 'Bearer test-token', 'Origin': 'https://example.com'}).status_code == 403


def test_tampered_sample_fails_integrity_check(tmp_path):
    shutil.copy(ROOT / 'catalogue.json', tmp_path / 'catalogue.json')
    (tmp_path / 'avocado').mkdir()
    (tmp_path / 'avocado' / 'preview.mesh.json').write_text('{}')
    with pytest.raises(ValueError, match='integrity check failed'):
        MeshSamples(tmp_path).content('avocado', 'preview')


def test_scene_instances_transforms_and_units_are_preserved():
    triangle = trimesh.Trimesh(vertices=[[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces=[[0, 1, 2]], process=False)
    scene = trimesh.Scene()
    scene.add_geometry(triangle, node_name='first', geom_name='shared')
    transform = np.eye(4)
    transform[:3, 3] = [2, 3, 4]
    scene.graph.update(frame_to='second', matrix=transform, geometry='shared')
    preview = geometry_preview(scene)
    assert len(preview['parts']) == 2
    assert preview['triangle_count'] == 2
    assert preview['parts'][0]['vertices'][2] == [0, 0, 1000]
    assert preview['parts'][1]['vertices'][0] == [-2000, 4000, 3000]
    assert preview['bounds_mm'] == [3000, 4000, 4000]


def test_empty_geometry_is_rejected():
    with pytest.raises(ValueError, match='no geometry'):
        geometry_preview(trimesh.Scene())
