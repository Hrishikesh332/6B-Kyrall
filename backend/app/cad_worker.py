"""One bounded subprocess per build. Only this trusted compiler imports the CAD kernel."""
import json
import os
from pathlib import Path
import sys


def rotated(shape, xyz):
    for axis, angle in zip(((1, 0, 0), (0, 1, 0), (0, 0, 1)), xyz):
        if angle:
            shape = shape.rotate((0, 0, 0), axis, angle)
    return shape


def construct_shapes(data):
    import cadquery as cq
    from cadquery.occ_impl.shapes import setThreads
    # OCC otherwise launches many threads and exhausts the process CPU budget
    # long before its wall timeout on a complex, otherwise valid assembly.
    setThreads(1)
    shapes = {}
    for node in data.nodes:
        wp = cq.Workplane("XY")
        if node.op == 'box':
            shape = wp.box(*node.size)
        elif node.op == 'cylinder':
            shape = wp.cylinder(node.height, node.radius)
        elif node.op == 'sphere':
            shape = wp.sphere(node.radius)
        elif node.op == 'polygon_extrude':
            shape = wp.polyline(node.points).close().extrude(node.height)
        elif node.op in ('union', 'cut', 'intersect'):
            shape = shapes[node.inputs[0]]
            for ref in node.inputs[1:]:
                shape = getattr(shape, node.op)(shapes[ref])
        elif node.op in ('fillet', 'chamfer'):
            shape = shapes[node.source]
            edges = shape.edges() if node.edges == 'all' else shape.edges(node.edges)
            shape = getattr(edges, node.op)(node.radius)
        else:
            shape = rotated(shapes[node.source], node.rotation).translate(node.translation)
        shapes[node.id] = shape
    return shapes


def render_preview(meshes, out):
    """Six depth-tested review views: isometric, rear, exploded above and below (or underside and side), front, top."""
    import matplotlib
    matplotlib.use('Agg')
    from .rendering import font_discovery_guard
    with font_discovery_guard():
        import matplotlib.pyplot as plt
    import numpy as np
    from matplotlib.colors import to_rgb
    from matplotlib.patches import Patch
    from .rendering_raster import render_view
    palette=['#528ba8','#dea058','#709d70','#b28fc5','#ba6b75','#818f9a']
    parts=[(np.asarray(m['vertices'],float)[np.asarray(m['faces'])],np.asarray(to_rgb(palette[j%len(palette)])))
           for j,m in enumerate(meshes)]
    points=np.concatenate([t.reshape(-1,3) for t,_ in parts])
    lo,hi=points.min(axis=0),points.max(axis=0)
    center,span=(lo+hi)/2,float(max(hi-lo))
    # Exploded copy: parts move away from the assembly centre so internals show.
    exploded=[]
    for j,(tri,rgb) in enumerate(parts):
        direction=tri.reshape(-1,3).mean(axis=0)-center
        length=np.linalg.norm(direction)
        direction=direction/length if length>span*.04 else np.array([0,0,1.0])*(1 if j else 0)
        exploded.append((tri+direction*span*.55,rgb))
    views=[('Isometric',28,-55,parts),('Rear isometric',28,125,parts)]
    views.append(('Exploded isometric',52,-55,exploded) if len(parts)>1 else ('Underside',-30,-55,parts))
    # Assemblies swap the side view for an exploded view from below: lips, bosses and
    # undersides of covers are otherwise never visible to the reviewer.
    views+=[('Front',0,-90,parts),('Top',90,-90,parts),
            ('Exploded underside',-40,-55,exploded) if len(parts)>1 else ('Side',0,0,parts)]
    fig,axes=plt.subplots(2,3,figsize=(15,10),facecolor='#f4f6fa')
    for ax,(title,elevation,azimuth,shapes) in zip(axes.ravel(),views):
        ax.imshow(render_view(shapes,elevation,azimuth),interpolation='lanczos')
        ax.set_title(title,fontweight='bold',color='#263544');ax.set_xticks([]);ax.set_yticks([])
        for spine in ax.spines.values(): spine.set_color('#dfe3ea')
    if len(meshes) > 1:
        fig.legend(handles=[Patch(facecolor=palette[j%len(palette)],label=m['name']) for j,m in enumerate(meshes[:18])],
                   loc='lower center',ncol=min(6,len(meshes)),frameon=False,fontsize=10)
    size=' × '.join(f'{v:.1f}' for v in hi-lo)
    fig.suptitle(f'CAD geometry · assembled pose · overall {size} mm (X × Y × Z)',color='#263544',fontsize=14)
    fig.tight_layout(rect=(0,.03,1,1));fig.savefig(out/'preview.png',dpi=100);plt.close(fig)


def build(spec, out: Path):
    from .cad_schema import CadInput
    data = CadInput.model_validate(spec)
    out.mkdir(parents=True, exist_ok=True)
    shapes = construct_shapes(data)
    placements = [{'name': part.name, 'base': shapes[part.shape],
                   'placed': rotated(shapes[part.shape], part.rotation).translate(part.translation),
                   'print_rotation': part.print_rotation,
                   # Placed coordinates back to the unplaced shape the STL is oriented from.
                   'unplace': (part.rotation, part.translation)} for part in data.parts]
    (out / f'{data.name}.cad.json').write_text(data.model_dump_json(indent=2))
    return export_build(data.name, placements, data.print_bed, data.notes, out)


def export_build(name, placements, print_bed, notes, out: Path):
    """Shared exports and checks. `base` is the shape checked and oriented for printing."""
    import cadquery as cq
    import numpy as np
    import trimesh
    from .printability import analyse, rotation_matrix
    # CadQuery requires unique names across both the root and all child parts.
    # A single-part model commonly shares its model and part name.
    assembly_name = name
    part_names = {p['name'] for p in placements}
    while assembly_name in part_names:
        assembly_name += '_assembly'
    assembly = cq.Assembly(name=assembly_name)
    results, meshes, solids, files = [], [], [], []
    for item in placements:
        part_name, shape, placed = item['name'], item['base'], item['placed']
        solids.append((part_name, placed.val()))
        assembly.add(placed, name=part_name, color=cq.Color(0.55, 0.65, 0.8))
        printable = rotated(shape, item['print_rotation'])
        bb = printable.val().BoundingBox()
        printable = printable.translate((-bb.xmin, -bb.ymin, -bb.zmin))
        path = out / f"{part_name}.stl"
        cq.exporters.export(printable, str(path), tolerance=0.08, angularTolerance=0.12)
        mesh = trimesh.load_mesh(path, process=True)
        bounds = [round(float(x), 4) for x in mesh.extents]
        fits = all(bounds[i] <= print_bed[i] + 0.01 for i in range(3))
        checks = {
            'part': part_name, 'valid_brep': bool(shape.val().isValid()),
            'solid_count': len(shape.solids().vals()), 'watertight': bool(mesh.is_watertight),
            'winding_consistent': bool(mesh.is_winding_consistent), 'positive_volume': bool(mesh.volume > 0),
            'volume_mm3': round(float(mesh.volume), 3), 'bounds_mm': bounds,
            'fits_print_bed': fits, 'triangles': len(mesh.faces),
        }
        checks['passed'] = all(checks[k] for k in ('valid_brep','watertight','winding_consistent','positive_volume','fits_print_bed')) and checks['solid_count'] == 1
        results.append(checks)
        files.append(path.name)
        # Assembly-space triangulation for a real 3-D frontend preview.
        verts, faces = placed.val().tessellate(0.2, 0.15)
        mesh_entry = {'name': part_name, 'vertices': [[v.x, v.y, v.z] for v in verts], 'faces': [list(f) for f in faces]}
        # Printability is judged on the preview faces in print orientation, so the
        # studio can colour exactly the faces each check flagged.
        points = np.asarray(mesh_entry['vertices'], float)
        rotation, translation = item.get('unplace', ((0, 0, 0), (0, 0, 0)))
        points = (points - np.asarray(translation, float)) @ rotation_matrix(rotation)
        points = points @ rotation_matrix(item['print_rotation']).T
        printing, flags = analyse(points, mesh_entry['faces'], print_bed)
        checks['printability'] = printing
        mesh_entry['print_flags'] = flags
        meshes.append(mesh_entry)

    collisions = []
    for i, (name_a, solid_a) in enumerate(solids):
        for name_b, solid_b in solids[i+1:]:
            overlap = solid_a.intersect(solid_b).Volume()
            if overlap > 0.01:
                collisions.append({'parts': [name_a, name_b], 'overlap_mm3': round(overlap, 4)})
    step_path = out / f"{name}.step"
    assembly.save(str(step_path))
    reimport = cq.importers.importStep(str(step_path))
    compound = cq.Compound.makeCompound([s for _, s in solids])
    bb = compound.BoundingBox()
    report = {
        'units': 'mm', 'engine': f'CadQuery {cq.__version__}', 'parts': results,
        'assembly_bounds_mm': [round(bb.xlen, 3), round(bb.ylen, 3), round(bb.zlen, 3)],
        'interferences': collisions, 'step_reimport_valid': bool(reimport.val().isValid()),
        'printability': {'status': max((r['printability']['status'] for r in results),
                                       key=['ok', 'review', 'problem'].index),
                         'issues': [{'part': r['part'], **i} for r in results for i in r['printability']['issues']],
                         'method': 'Preview-mesh screening in each STL print orientation: overhangs beyond 45°, '
                                   'ray-measured wall thickness under 1.2 mm (review) or 0.8 mm (problem), bed fit. '
                                   'Not a slicer simulation.'},
        'passed': all(r['passed'] for r in results) and not collisions and bool(reimport.val().isValid()),
        'not_tested': ['Physical fit', 'Load capacity', 'Material fatigue', 'Kinematics', 'Printer-specific tolerances', 'Slicer support generation and bridging'],
        'notes': list(notes),
    }
    (out / 'validation.json').write_text(json.dumps(report, indent=2))
    (out / 'preview.mesh.json').write_text(json.dumps({'units': 'mm', 'parts': meshes}, separators=(',', ':')))
    render_preview(meshes,out)
    # SVGs are kernel projections, not decorative stand-ins.
    for view, direction in [('isometric',(1,-1,0.8)), ('front',(0,-1,0)), ('top',(0,0,1)), ('side',(1,0,0))]:
        cq.exporters.export(cq.Workplane('XY').newObject([compound]), str(out / f'view_{view}.svg'), opt={
            'width': 800, 'height': 520, 'projectionDir': direction,
            'strokeColor': (170,185,215), 'hiddenColor': (75,80,95), 'showHidden': False,
            'strokeWidth': 1.2, 'showAxes': False,
        })
    return report


def main():
    # Bound CPU and file output. This is a trusted finite compiler, not a Python sandbox.
    if os.name == 'posix':
        import resource
        # CPU time sums across threads and OCC meshing is parallel; the parent's wall
        # timeout is the real bound, so scale this backstop with the core count.
        cpu = min(1600, 100 * (os.cpu_count() or 1))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 5))
        resource.setrlimit(resource.RLIMIT_FSIZE, (64*1024*1024, 64*1024*1024))
    src, dest = Path(sys.argv[1]), Path(sys.argv[2])
    try:
        result = build(json.loads(src.read_text()), dest)
        print(json.dumps({'ok': True, 'report': result}))
    except Exception as exc:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({'ok': False, 'error': f'{type(exc).__name__}: {str(exc)[:1200]}'}))
        sys.exit(1)


if __name__ == '__main__':
    main()
