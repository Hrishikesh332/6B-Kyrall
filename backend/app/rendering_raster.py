"""Small z-buffer rasterizer for CAD review images (no GPU, numpy only).

Matplotlib's painter's algorithm mis-orders large flat triangles, which shows hidden
geometry through faces. Review images must not mislead the model, so each view is
rasterized per pixel with depth testing and outlined where depth or normals change.
"""
import numpy as np


def camera(elevation, azimuth):
    e, a = np.radians(elevation), np.radians(azimuth)
    eye = np.array([np.cos(e) * np.cos(a), np.cos(e) * np.sin(a), np.sin(e)])
    right = np.array([-np.sin(a), np.cos(a), 0.0])
    if np.linalg.norm(right) < 1e-9:
        right = np.array([1.0, 0, 0])
    up = np.cross(eye, right)
    return eye, right / np.linalg.norm(right), up / np.linalg.norm(up)


def _fragments(tri2d, depth, width, height):
    """Scanline fragments (pixel index, depth, triangle id); cost scales with covered area."""
    x0, y0 = tri2d[:, 0, 0], tri2d[:, 0, 1]
    v0, v1 = tri2d[:, 1] - tri2d[:, 0], tri2d[:, 2] - tri2d[:, 0]
    den = v0[:, 0] * v1[:, 1] - v1[:, 0] * v0[:, 1]
    keep = np.abs(den) > 1e-12
    tri2d, depth, x0, y0, v0, v1, den = (a[keep] for a in (tri2d, depth, x0, y0, v0, v1, den))
    ids = np.nonzero(keep)[0]
    # Depth plane z = a*x + b*y + c per triangle.
    dz1, dz2 = depth[:, 1] - depth[:, 0], depth[:, 2] - depth[:, 0]
    pa = (dz1 * v1[:, 1] - dz2 * v0[:, 1]) / den
    pb = (dz2 * v0[:, 0] - dz1 * v1[:, 0]) / den
    pc = depth[:, 0] - pa * x0 - pb * y0
    top = np.clip(np.ceil(tri2d[:, :, 1].min(axis=1) - .5), 0, height).astype(np.int64)
    bottom = np.clip(np.floor(tri2d[:, :, 1].max(axis=1) - .5), -1, height - 1).astype(np.int64)
    rows = np.maximum(bottom - top + 1, 0)
    owner = np.repeat(np.arange(len(rows)), rows)
    if not len(owner):
        return
    starts = np.cumsum(rows) - rows
    y = top[owner] + np.arange(len(owner)) - starts[owner]
    yc = y + .5
    crossings = []
    for i, j in ((0, 1), (1, 2), (2, 0)):
        p, q = tri2d[owner, i], tri2d[owner, j]
        dy = q[:, 1] - p[:, 1]
        lo, hi = np.minimum(p[:, 1], q[:, 1]), np.maximum(p[:, 1], q[:, 1])
        hit = (dy != 0) & (yc >= lo) & (yc <= hi)
        with np.errstate(divide='ignore', invalid='ignore'):
            crossings.append(np.where(hit, p[:, 0] + (yc - p[:, 1]) * (q[:, 0] - p[:, 0]) / dy, np.nan))
    crossings = np.stack(crossings, axis=1)
    valid = ~np.isnan(crossings).all(axis=1)
    owner, y, yc, crossings = owner[valid], y[valid], yc[valid], crossings[valid]
    left = np.clip(np.ceil(np.nanmin(crossings, axis=1) - .5), 0, width).astype(np.int64)
    right = np.clip(np.floor(np.nanmax(crossings, axis=1) - .5), -1, width - 1).astype(np.int64)
    spans = np.maximum(right - left + 1, 0)
    step = 4_000_000
    order = np.arange(len(spans))
    cumulative = np.cumsum(spans)
    start = 0
    while start < len(order):
        # Bound memory by expanding spans in chunks of about four million pixels.
        stop = int(np.searchsorted(cumulative, (cumulative[start - 1] if start else 0) + step, side='right'))
        stop = max(stop, start + 1)
        chunk = order[start:stop]
        counts = spans[chunk]
        frag_row = np.repeat(chunk, counts)
        offsets = np.cumsum(counts) - counts
        x = left[frag_row] + np.arange(len(frag_row)) - np.repeat(offsets, counts)
        tri = owner[frag_row]
        z = pa[tri] * (x + .5) + pb[tri] * yc[frag_row] + pc[tri]
        yield y[frag_row] * width + x, z, ids[tri]
        start = stop


def render_view(parts, elevation, azimuth, size=460, supersample=2, bounds=None):
    """parts: list of (triangles (N,3,3), rgb). Returns an (size, size, 3) float image."""
    eye, right, up = camera(elevation, azimuth)
    light = eye + np.array([.35, -.25, .55])
    light /= np.linalg.norm(light)
    tris = np.concatenate([p for p, _ in parts])
    part_of = np.concatenate([np.full(len(p), i) for i, (p, _) in enumerate(parts)])
    normals = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    normals /= np.linalg.norm(normals, axis=1, keepdims=True) + 1e-12
    base = np.array([rgb for _, rgb in parts])[part_of]
    shade = .42 + .58 * np.abs(normals @ light)
    colors = np.clip(base * shade[:, None], 0, 1)
    points = tris.reshape(-1, 3)
    screen = np.stack([points @ right, points @ up], axis=1)
    lo, hi = (bounds if bounds is not None else (screen.min(axis=0), screen.max(axis=0)))
    n = size * supersample
    scale = n * .92 / max(float((hi - lo).max()), 1e-9)
    offset = (np.array([n, n]) - (hi - lo) * scale) / 2
    xy = (screen - lo) * scale + offset
    xy[:, 1] = n - xy[:, 1]  # image rows grow downward
    tri2d = xy.reshape(-1, 3, 2)
    depth = (points @ eye).reshape(-1, 3)
    pixels, depths, owners = [], [], []
    for pix, z, t in _fragments(tri2d, depth, n, n):
        pixels.append(pix); depths.append(z); owners.append(t)
    image = np.ones((n * n, 3))
    zbuf = np.full(n * n, -np.inf)
    owner = np.full(n * n, -1)
    if pixels:
        pix, z, t = np.concatenate(pixels), np.concatenate(depths), np.concatenate(owners)
        order = np.argsort(-z, kind='stable')  # nearest first
        pix, z, t = pix[order], z[order], t[order]
        _, first = np.unique(pix, return_index=True)
        image[pix[first]] = colors[t[first]]
        zbuf[pix[first]] = z[first]
        owner[pix[first]] = t[first]
    image, zbuf, owner = image.reshape(n, n, 3), zbuf.reshape(n, n), owner.reshape(n, n)
    # Outlines where depth jumps, creases fold or parts meet; silhouettes against background.
    filled = owner >= 0
    pixel_normals = np.where(filled[..., None], normals[np.maximum(owner, 0)], 0)
    pixel_parts = np.where(filled, part_of[np.maximum(owner, 0)], -1)
    span = float((hi - lo).max()) or 1
    edge = np.zeros((n, n), bool)
    for shift in ((0, 1), (1, 0)):
        za, zb = zbuf, np.roll(zbuf, shift, axis=(0, 1))
        fa, fb = filled, np.roll(filled, shift, axis=(0, 1))
        na, nb = pixel_normals, np.roll(pixel_normals, shift, axis=(0, 1))
        pa, pb = pixel_parts, np.roll(pixel_parts, shift, axis=(0, 1))
        crease = (na * nb).sum(axis=-1) < np.cos(np.radians(35))
        both = fa & fb
        jump = np.abs(np.where(both, za, 0) - np.where(both, zb, 0)) > span * .015
        edge |= (fa != fb) | (fa & fb & (crease | jump | (pa != pb)))
    image[edge] = image[edge] * .35
    # Box-filter supersampled pixels down for antialiasing.
    return image.reshape(size, supersample, size, supersample, 3).mean(axis=(1, 3))


def screen_bounds(parts, elevation, azimuth):
    _, right, up = camera(elevation, azimuth)
    points = np.concatenate([p.reshape(-1, 3) for p, _ in parts])
    screen = np.stack([points @ right, points @ up], axis=1)
    return screen.min(axis=0), screen.max(axis=0)
