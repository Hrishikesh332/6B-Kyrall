"""Read-only, offline library of pinned web models; no user-controlled fetching."""
import hashlib
import json
from pathlib import Path

from .db import NotFound

ROOT = Path(__file__).resolve().parents[1] / 'assets' / 'mesh_samples'


class MeshSamples:
    def __init__(self, root=ROOT):
        self.root = Path(root)
        self.items = json.loads((self.root / 'catalogue.json').read_text())

    def content(self, sample_id, kind):
        item = next((item for item in self.items if item['id'] == sample_id), None)
        if item is None or kind not in ('original', 'preview', 'notice'):
            raise NotFound('Sample mesh not found')
        filename, digest, media = {
            'original': (item['filename'], item['sha256'], 'model/gltf-binary'),
            'preview': ('preview.mesh.json', item['preview_sha256'], 'application/json'),
            'notice': ('SOURCE.md', item['notice_sha256'], 'text/plain'),
        }[kind]
        path = self.root / item['id'] / filename
        if not path.is_file():
            raise NotFound('Sample file is unavailable')
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError('Sample integrity check failed. Restore the bundled sample files.')
        return path, filename, digest, media
