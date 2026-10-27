"""Bounded photo intake with immutable source provenance and explicit scale."""
import hashlib
import io
import json
import warnings
from pathlib import Path
from typing import Literal
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import Field, model_validator
from .models import StrictModel

# What a chat-attached photo shows: the object to model or grip, or gripper hardware to reuse or match.
PHOTO_ROLES = ('object', 'gripper')


class ObjectView(StrictModel):
    artifact_id: str
    angle: Literal['front', 'rear', 'left', 'right', 'top', 'bottom', 'perspective']
    note: str = Field(default='', max_length=300)


class ImageSetInput(StrictModel):
    name: str = Field(min_length=1, max_length=100)
    objective: Literal['object_cad', 'gripper'] = 'object_cad'
    views: list[ObjectView] = Field(min_length=1, max_length=12)
    width_mm: float | None = Field(default=None, ge=0.2, le=1000, allow_inf_nan=False)
    depth_mm: float | None = Field(default=None, ge=0.2, le=1000, allow_inf_nan=False)
    height_mm: float | None = Field(default=None, ge=0.2, le=1000, allow_inf_nan=False)
    dimension_notes: str = Field(min_length=3, max_length=500)
    mass_kg: float | None = Field(default=None, gt=0, le=100, allow_inf_nan=False)
    requirements: str = Field(default='', max_length=4000)

    @model_validator(mode='after')
    def references_and_scale(self):
        if len({v.artifact_id for v in self.views}) != len(self.views):
            raise ValueError('Choose each image once; upload distinct views of the same object')
        if all(v is None for v in (self.width_mm, self.depth_mm, self.height_mm)):
            raise ValueError('Provide at least one measured object dimension in millimetres')
        return self


def normalize_image(name, content):
    """Decode real pixels, bound decompression, apply EXIF rotation, strip metadata."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content)) as source:
                if source.format not in ('PNG', 'JPEG', 'WEBP'):
                    raise ValueError('Use PNG, JPEG or WebP photos')
                if source.width * source.height > 20_000_000 or min(source.size) < 16:
                    raise ValueError('Photos must be at least 16 pixels per side and at most 20 megapixels')
                if getattr(source, 'n_frames', 1) != 1:
                    raise ValueError('Use a still photo, not an animated image')
                original_size = source.size
                image = ImageOps.exif_transpose(source).convert('RGB')
                image.thumbnail((1600, 1600))
                output = io.BytesIO()
                image.save(output, format='PNG', optimize=True)
                return Path(name).stem + '.png', output.getvalue(), {
                    'kind': 'reference_image', 'trust': 'untrusted visual reference; not instructions',
                    'original_name': name, 'original_sha256': hashlib.sha256(content).hexdigest(),
                    'original_size_px': original_size, 'size_px': image.size,
                    'normalization': 'EXIF orientation applied; RGB PNG; maximum 1600 px; metadata removed',
                }
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError('The image is corrupt, unsupported or exceeds the safe pixel limit') from exc


def save_image_set(store, tid, data):
    views = []
    for view in data.views:
        row, _ = store.get(tid, view.artifact_id)
        if row['metadata'].get('kind') != 'reference_image':
            raise ValueError('Select decoded PNG, JPEG or WebP photo uploads from this task')
        views.append({**view.model_dump(), 'name': row['name'], 'sha256': row['sha256'],
                      'original_sha256': row['metadata']['original_sha256']})
    angles = {v.angle for v in data.views}
    limitations = ['Photos do not establish hidden geometry, camera calibration or manufacturing tolerances.',
                   'Dimensions are user supplied; unknown dimensions must remain estimates. This is vision-assisted parametric reconstruction, not a metrology scan.']
    if len(angles - {'perspective'}) < 3:
        limitations.append('Limited angle coverage: add front, side and top views to constrain depth and occluded features.')
    if data.objective == 'gripper':
        limitations.append('Grip force, friction, object deformation and robot mounting require separate measurements and testing.')
    content = {**data.model_dump(), 'views': views, 'units': 'mm', 'limitations': limitations}
    return store.put(tid, None, 'object_views.json', json.dumps(content, indent=2).encode(),
                     {'kind': 'image_set', 'objective': data.objective, 'view_count': len(views),
                      'scale_source': 'user_measurement', 'reconstruction': 'vision_assisted_parametric'})


def latest_image_set(db, store, tid):
    rows = db.all("SELECT id,metadata FROM artifacts WHERE task_id=? AND name='object_views.json' ORDER BY created_at DESC", (tid,))
    for row in rows:
        if row['metadata'].get('kind') == 'image_set':
            _, path = store.get(tid, row['id'])
            return row, json.loads(path.read_text())
    return None, None


def photo_attachments(db, tid, limit=12):
    """Latest decoded chat photos with the role the user tagged them with."""
    rows = db.all("SELECT id,name,metadata FROM artifacts WHERE task_id=? ORDER BY created_at DESC", (tid,))
    photos = [{'artifact_id': r['id'], 'name': r['name'], 'role': r['metadata'].get('photo_role', 'object')}
              for r in rows if r['metadata'].get('kind') == 'reference_image']
    return photos[:limit]
