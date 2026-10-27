"""FDM printability screening on a part in its print orientation (numpy only).

Checks: unsupported overhangs, thin walls (ray-measured local thickness), features
below what a nozzle can form, and bed fit. These are geometric screens with stated
thresholds, not slicer simulations or strength checks.
"""
import numpy as np

NOZZLE_MM = 0.4
MIN_WALL_MM = 1.2      # About three perimeters at a 0.4 mm nozzle.
MIN_FEATURE_MM = 0.8   # Two extrusion widths; thinner geometry often vanishes when sliced.
OVERHANG_DEG = 45.0    # Steeper than this from vertical usually needs support.
MAX_RAYS = 1500


def rotation_matrix(xyz):
    """Matches cad_worker.rotated: rotate about X, then Y, then Z (degrees, global axes)."""
    x, y, z = np.radians(xyz)
    rx = np.array([[1, 0, 0], [0, np.cos(x), -np.sin(x)], [0, np.sin(x), np.cos(x)]])
    ry = np.array([[np.cos(y), 0, np.sin(y)], [0, 1, 0], [-np.sin(y), 0, np.cos(y)]])
    rz = np.array([[np.cos(z), -np.sin(z), 0], [np.sin(z), np.cos(z), 0], [0, 0, 1]])
    return rz @ ry @ rx


def _thickness(origins, directions, tris, chunk=64):
    """Distance to the nearest triangle hit along each ray (Möller–Trumbore), inf if none."""
    v0, e1, e2 = tris[:, 0], tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]
    best = np.full(len(origins), np.inf)
    for start in range(0, len(origins), chunk):
        o, d = origins[start:start + chunk, None, :], directions[start:start + chunk, None, :]
        p = np.cross(d, e2[None])
        det = np.einsum('rtk,tk->rt', p, e1)
        ok = np.abs(det) > 1e-12
        inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
        s = o - v0[None]
        u = np.einsum('rtk,rtk->rt', s, p) * inv
        q = np.cross(s, e1[None])
        v = np.einsum('rtk,rtk->rt', np.broadcast_to(d, q.shape), q) * inv
        t = np.einsum('tk,rtk->rt', e2, q) * inv
        hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-4)
        best[start:start + chunk] = np.where(hit, t, np.inf).min(axis=1)
    return best


def analyse(vertices, faces, print_bed, overhang_deg=OVERHANG_DEG, min_wall=MIN_WALL_MM,
            min_feature=MIN_FEATURE_MM):
    """vertices are already in print orientation. Returns (report, face flags)."""
    v = np.asarray(vertices, float)
    f = np.asarray(faces, int)
    v = v - v.min(axis=0)  # Sit on the bed at the origin.
    tris = v[f]
    cross = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    area = np.linalg.norm(cross, axis=1) / 2
    normals = cross / (2 * area[:, None] + 1e-12)
    centroids = tris.mean(axis=1)
    total = float(area.sum()) or 1.0

    # Downward faces steeper than the limit, ignoring faces resting on the bed.
    down = -normals[:, 2]
    on_bed = centroids[:, 2] < 0.15
    overhang = (down > np.cos(np.radians(overhang_deg))) & ~on_bed & (area > 1e-6)
    # Measured from vertical: a wall is 0°, a flat ceiling (bridge) is 90°.
    worst = float(np.degrees(np.arcsin(np.clip(down[overhang].max(), -1, 1)))) if overhang.any() else None

    # Local wall thickness: cast inward from a sample of faces, weighted by area.
    usable = np.nonzero(area > 1e-5)[0]
    if len(usable) > MAX_RAYS:
        rng = np.random.default_rng(0)
        sample = rng.choice(usable, MAX_RAYS, replace=False, p=area[usable] / area[usable].sum())
    else:
        sample = usable
    depth = _thickness(centroids[sample] - normals[sample] * 1e-3, -normals[sample], tris)
    measured = np.isfinite(depth)
    thin_faces = sample[measured & (depth < min_wall)]
    tiny_faces = sample[measured & (depth < min_feature)]
    sampled_area = float(area[sample].sum()) or 1.0

    size = (v.max(axis=0)).tolist()
    fits = all(size[i] <= print_bed[i] + 0.01 for i in range(3))
    report = {
        'thresholds': {'overhang_deg': overhang_deg, 'min_wall_mm': min_wall, 'min_feature_mm': min_feature,
                       'nozzle_mm': NOZZLE_MM},
        'overhang_area_mm2': round(float(area[overhang].sum()), 1),
        'overhang_percent': round(100 * float(area[overhang].sum()) / total, 1),
        'steepest_overhang_deg': round(worst, 1) if worst is not None else None,
        'min_wall_mm': round(float(depth[measured].min()), 2) if measured.any() else None,
        'thin_wall_percent': round(100 * float(area[thin_faces].sum()) / sampled_area, 1),
        'below_min_feature_percent': round(100 * float(area[tiny_faces].sum()) / sampled_area, 1),
        'print_size_mm': [round(x, 2) for x in size],
        'fits_print_bed': fits,
    }
    issues = []
    if not fits:
        issues.append({'severity': 'problem', 'check': 'bed_fit',
                       'message': f'Part is {size[0]:.1f} × {size[1]:.1f} × {size[2]:.1f} mm; the bed is '
                                  f'{print_bed[0]:g} × {print_bed[1]:g} × {print_bed[2]:g} mm'})
    if report['below_min_feature_percent'] > 0.5:
        issues.append({'severity': 'problem', 'check': 'small_features',
                       'message': f'Some geometry is thinner than {min_feature:g} mm (min {report["min_wall_mm"]} mm) '
                                  'and may not print at all'})
    elif report['thin_wall_percent'] > 1:
        issues.append({'severity': 'review', 'check': 'thin_walls',
                       'message': f'{report["thin_wall_percent"]}% of walls are under {min_wall:g} mm '
                                  f'(min {report["min_wall_mm"]} mm); fewer than three perimeters'})
    if report['overhang_percent'] > 2:
        issues.append({'severity': 'review', 'check': 'overhang',
                       'message': f'{report["overhang_area_mm2"]} mm² ({report["overhang_percent"]}%) overhangs '
                                  f'beyond {overhang_deg:g}° need support or a different print orientation'})
    report['issues'] = issues
    report['status'] = 'problem' if any(i['severity'] == 'problem' for i in issues) else \
        'review' if issues else 'ok'
    flags = {'overhang': np.nonzero(overhang)[0].tolist(), 'thin': thin_faces.tolist(), 'tiny': tiny_faces.tolist()}
    return report, flags
