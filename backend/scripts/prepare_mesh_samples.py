"""Rebuild the bundled CC0 sample library. Network access only with --download.

Run from the repository: .venv/bin/python backend/scripts/prepare_mesh_samples.py
The pinned originals and upstream notices are retained without modification.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import urllib.request

import numpy as np
import trimesh

COMMIT = '8f492390ddc7a2ae221a1369ef560589cf8c70fb'
ROOT = Path(__file__).resolve().parents[1] / 'assets' / 'mesh_samples'
RAW = f'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/{COMMIT}'
MODELS = [
    ('Avocado', 'avocado', 'Avocado', 'Organic shape', 'Microsoft'),
    ('WaterBottle', 'water-bottle', 'Water bottle', 'Product geometry', 'Microsoft'),
    ('Lantern', 'lantern', 'Lantern', 'Multipart object', 'Microsoft / sbtron; Frank Galligan'),
    ('BoomBox', 'boom-box', 'Radio', 'Detailed enclosure', 'Microsoft'),
    ('ToyCar', 'toy-car', 'Toy car', 'Complex assembly', 'Guido Odendahl; Eric Chadwick'),
]


def geometry_preview(scene):
    """Bake every instance's world transform, then rotate Y-up metres to Z-up mm."""
    parts = []
    total_faces = total_vertices = 0
    for index, node in enumerate(sorted(scene.graph.nodes_geometry)):
        transform, geometry = scene.graph[node]
        mesh = scene.geometry[geometry].copy()
        if not isinstance(mesh, trimesh.Trimesh):
            raise ValueError('Only triangle geometry is supported')
        mesh.apply_transform(transform)
        # Preserve handedness; glTF +Z front becomes the viewer's +Y front.
        vertices = np.asarray(mesh.vertices)[:, [0, 2, 1]] * [-1000, 1000, 1000]
        faces = np.asarray(mesh.faces)
        total_vertices += len(vertices)
        total_faces += len(faces)
        if (not len(faces) or faces.shape[1] != 3 or not np.isfinite(vertices).all()
                or np.abs(vertices).max() > 1e8 or faces.min() < 0 or faces.max() >= len(vertices)
                or total_faces > 250000 or total_vertices > 500000 or index >= 256):
            raise ValueError('Sample geometry exceeds the preview limits')
        parts.append({'name': f'{index + 1:02d}_{node}',
                      'vertices': vertices.round(6).tolist(), 'faces': faces.tolist()})
    if not parts:
        raise ValueError('Sample has no geometry')
    points = np.concatenate([part['vertices'] for part in parts])
    return {'units': 'mm', 'kind': 'reference_mesh', 'parts': parts,
            'bounds_mm': (points.max(axis=0) - points.min(axis=0)).round(3).tolist(),
            'vertex_count': total_vertices, 'triangle_count': total_faces}


def digest(content):
    return hashlib.sha256(content).hexdigest()


def prepare(download=False):
    catalogue = []
    for upstream, slug, title, description, author in MODELS:
        folder = ROOT / slug
        folder.mkdir(parents=True, exist_ok=True)
        source_url = f'{RAW}/Models/{upstream}/glTF-Binary/{upstream}.glb'
        files = [(source_url, f'{slug}.glb'),
                 (f'{RAW}/Models/{upstream}/README.md', 'SOURCE.md')]
        if download:
            for url, filename in files:
                with urllib.request.urlopen(url, timeout=60) as response:
                    content = response.read(12 * 1024 * 1024 + 1)
                if len(content) > 12 * 1024 * 1024:
                    raise ValueError('Sample download exceeds 12 MB')
                (folder / filename).write_bytes(content)
        original = (folder / f'{slug}.glb').read_bytes()
        notice = (folder / 'SOURCE.md').read_bytes()
        if b'creativecommons.org/publicdomain/zero/1.0' not in notice:
            raise ValueError('Expected upstream CC0 declaration')
        scene = trimesh.load_scene(io.BytesIO(original), file_type='glb', process=False)
        preview = geometry_preview(scene)
        content = json.dumps(preview, separators=(',', ':'), allow_nan=False).encode()
        (folder / 'preview.mesh.json').write_bytes(content)
        catalogue.append({
            'id': slug, 'name': title, 'description': description, 'author': author,
            'filename': f'{slug}.glb', 'format': 'GLB', 'license': 'CC0 1.0',
            'license_url': 'https://creativecommons.org/publicdomain/zero/1.0/',
            'source_url': f'https://github.com/KhronosGroup/glTF-Sample-Assets/tree/{COMMIT}/Models/{upstream}',
            'download_url': source_url, 'source_commit': COMMIT,
            'sha256': digest(original), 'preview_sha256': digest(content),
            'notice_sha256': digest(notice), 'size': len(original),
            'parts': len(preview['parts']), 'triangles': preview['triangle_count'],
            'bounds_mm': preview['bounds_mm'],
            'preview_note': 'Geometry preview. Original materials and textures are included in the GLB download.',
        })
        print(f'{title}: {len(preview["parts"])} parts, {preview["triangle_count"]:,} triangles')
    (ROOT / 'catalogue.json').write_text(json.dumps(catalogue, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', action='store_true', help='Fetch the pinned official originals')
    prepare(parser.parse_args().download)
