import numpy as np
import trimesh

from app.printability import analyse, rotation_matrix

BED = (220, 220, 250)


def mesh(*boxes):
    parts = []
    for extents, centre in boxes:
        box = trimesh.creation.box(extents=extents)
        box.apply_translation(centre)
        parts.append(box)
    combined = trimesh.util.concatenate(parts)
    return combined.vertices, combined.faces


def solid(shape):
    verts, faces = shape.val().tessellate(0.1, 0.1)
    return [v.toTuple() for v in verts], [list(f) for f in faces]


def test_cantilever_overhang_is_flagged_and_flipping_removes_it():
    import cadquery as cq
    # A 20 mm post with a 30 mm shelf on top: the shelf underside is a 90° overhang.
    post = cq.Workplane('XY').box(10, 10, 20, centered=(True, True, False))
    shelf = cq.Workplane('XY').box(40, 10, 4, centered=(True, True, False)).translate((0, 0, 20))
    vertices, faces = solid(post.union(shelf))
    report, flags = analyse(vertices, faces, BED)
    assert report['overhang_percent'] > 2 and report['steepest_overhang_deg'] == 90.0
    assert report['status'] == 'review' and flags['overhang']
    flipped = np.asarray(vertices) @ rotation_matrix((180, 0, 0)).T
    report, _ = analyse(flipped, faces, BED)
    assert report['overhang_area_mm2'] == 0 and report['status'] == 'ok'


def test_wall_thickness_and_bed_fit():
    ok, _ = analyse(*mesh(((30, 30, 2.0), (0, 0, 1))), BED)
    assert ok['min_wall_mm'] == 2.0 and ok['status'] == 'ok'
    thin, flags = analyse(*mesh(((30, 30, 1.0), (0, 0, 0.5))), BED)
    assert thin['status'] == 'review' and any(i['check'] == 'thin_walls' for i in thin['issues']) and flags['thin']
    tiny, _ = analyse(*mesh(((30, 30, 0.5), (0, 0, 0.25))), BED)
    assert tiny['status'] == 'problem' and tiny['issues'][0]['check'] == 'small_features'
    big, _ = analyse(*mesh(((300, 20, 10), (0, 0, 5))), BED)
    assert not big['fits_print_bed'] and big['issues'][0]['check'] == 'bed_fit'


def test_rotation_matrix_matches_cadquery():
    import cadquery as cq
    from app.cad_worker import rotated
    shape = cq.Workplane('XY').box(10, 2, 4).translate((7, 3, 1))
    expected = np.array([v.toTuple() for v in rotated(shape, (30, -45, 60)).val().Vertices()])
    original = np.array([v.toTuple() for v in shape.val().Vertices()])
    assert np.allclose(np.sort(original @ rotation_matrix((30, -45, 60)).T, axis=0), np.sort(expected, axis=0), atol=1e-6)
