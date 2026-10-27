"""Portable USD collision scenes. Export is preparation, never a physics test result."""
import json
from pydantic import Field, model_validator
from .models import StrictModel
from .cad_schema import Name


class DynamicBody(StrictModel):
    part: Name
    mass_kg: float = Field(gt=0, le=100, allow_inf_nan=False)
    static_friction: float = Field(ge=0, le=2, allow_inf_nan=False)
    dynamic_friction: float = Field(ge=0, le=2, allow_inf_nan=False)
    restitution: float = Field(default=0, ge=0, le=1, allow_inf_nan=False)

    @model_validator(mode='after')
    def friction_order(self):
        if self.dynamic_friction > self.static_friction:
            raise ValueError('Dynamic friction must not exceed static friction')
        return self


class SimulationExportInput(StrictModel):
    source_artifact_id: str
    dynamic_bodies: list[DynamicBody] = Field(default_factory=list, max_length=12)
    parameter_source: str = Field(default='No dynamics configured; static collision scene only.', min_length=3, max_length=1000)


def usda_scene(mesh, bodies):
    dynamic = {b.part: b for b in bodies}
    lines = ['#usda 1.0', '(defaultPrim = "World"', ' metersPerUnit = 1', ' upAxis = "Z")', 'def Xform "World" {',
             ' def PhysicsScene "Physics" {', '  vector3f physics:gravityDirection = (0, 0, -1)', '  float physics:gravityMagnitude = 9.81', ' }']
    for part in mesh['parts']:
        name = part['name']; body = dynamic.get(name)
        # Source meshes already use assembled coordinates. Convert mm to metres once.
        api = ' (prepend apiSchemas = ["PhysicsRigidBodyAPI", "PhysicsMassAPI"])' if body else ''
        lines += [f' def Xform "{name}"{api} {{']
        if body:
            lines += [f'  float physics:mass = {body.mass_kg}', '  bool physics:rigidBodyEnabled = true',
                      '  def Material "Material" (prepend apiSchemas = ["PhysicsMaterialAPI"]) {',
                      f'   float physics:staticFriction = {body.static_friction}', f'   float physics:dynamicFriction = {body.dynamic_friction}',
                      f'   float physics:restitution = {body.restitution}', '  }']
        lines += ['  def Mesh "Geometry" (prepend apiSchemas = ["PhysicsCollisionAPI", "PhysicsMeshCollisionAPI", "MaterialBindingAPI"]) {',
                  '   bool physics:collisionEnabled = true', f'   uniform token physics:approximation = "{"convexHull" if body else "none"}"',
                  '   uniform token subdivisionScheme = "none"', '   uniform token orientation = "rightHanded"',
                  '   point3f[] points = [' + ','.join('('+','.join(f'{v/1000:.9g}' for v in vertex)+')' for vertex in part['vertices']) + ']',
                  '   int[] faceVertexCounts = [' + ','.join('3' for _ in part['faces']) + ']',
                  '   int[] faceVertexIndices = [' + ','.join(str(i) for face in part['faces'] for i in face) + ']',
                  '   color3f[] primvars:displayColor = [(0.38, 0.64, 0.77)]']
        if body: lines.append(f'   rel material:binding:physics = </World/{name}/Material>')
        lines += ['  }', ' }']
    return '\n'.join(lines + ['}']) + '\n'


def export_scene(db, store, tid, rid, data):
    source, path = store.get(tid, data.source_artifact_id)
    if source['metadata'].get('kind') not in ('cad_source', 'cad_script') or source['metadata'].get('validation_passed') is not True:
        raise ValueError('Select a CAD source whose geometry validation passed')
    build = source['metadata']['build_id']
    rows = db.all('SELECT id,metadata FROM artifacts WHERE task_id=? ORDER BY created_at DESC', (tid,))
    item = next((a for a in rows if a['metadata'].get('kind') == 'mesh_preview' and a['metadata'].get('build_id') == build), None)
    if not item: raise ValueError('The matching assembly mesh is missing')
    mesh_row, mesh_path = store.get(tid, item['id'])
    mesh = json.loads(mesh_path.read_text())
    names = {p['name'] for p in mesh['parts']}
    selected = [b.part for b in data.dynamic_bodies]
    if len(selected) != len(set(selected)) or set(selected) - names:
        raise ValueError('Dynamic body names must be unique parts in the selected CAD build')
    meta = {'build_id': build, 'source_artifact_id': source['id'], 'source_sha256': source['sha256'], 'simulation_passed': None}
    scene = store.put(tid, rid, 'isaac_scene.usda', usda_scene(mesh, data.dynamic_bodies).encode(), {'kind':'simulation_scene', **meta})
    manifest = {**meta, 'scene_artifact_id': scene['id'], 'scene_sha256': scene['sha256'], 'mesh_sha256': mesh_row['sha256'],
                'units': 'metres', 'up_axis': 'Z', 'conversion': 'assembled mm coordinates divided by 1000',
                'dynamic_bodies': [b.model_dump() for b in data.dynamic_bodies], 'parameter_source': data.parameter_source,
                'static_parts': sorted(names-set(selected)), 'status': 'prepared_not_simulated',
                'limitations': ['Dynamic bodies use a convex hull collision approximation; inspect cavities and contact patches in Isaac.',
                                'Static parts use triangle-mesh collision. No joint drives, gripper articulation or robot is inferred.',
                                'Mass and contact properties are declared inputs, not measurements verified by 6B.',
                                'The connected Franka scene is separate; exporting does not modify it or validate this design.'],
                'test_protocol': ['Inspect collision geometry and match the robot/tool frame and object scale.',
                                  'Define joints, limits, drives and force sensing for the actual gripper; calibrate mass and friction.',
                                  'Record physics timestep, solver settings, material sources, scene hash and CAD source hash.',
                                  'Measure approach clearance, per-jaw peak force, sustained lift/contact, slip, release and reset.',
                                  'Repeat across object sizes, poses and measured friction bounds; retain failures and raw traces.']}
    evidence = store.put(tid, rid, 'isaac_manifest.json', json.dumps(manifest,indent=2).encode(), {'kind':'simulation_manifest', **meta})
    return {'scene': scene, 'manifest': evidence, 'status': 'prepared_not_simulated'}
