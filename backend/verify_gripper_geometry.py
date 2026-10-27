"""Independent acceptance measurements from delivered STEP/STL/ZIP, not model prose."""
import hashlib
import json
from math import hypot, isclose
from pathlib import Path
import zipfile
import cadquery as cq
import trimesh


def main():
    root=Path(__file__).resolve().parent
    files=root/'examples/gripper-final'
    step=cq.importers.importStep(str(files/'FR3_passive_moving_fingers.step'))
    solids=step.solids().vals()
    holes=[]
    for index,solid in enumerate(solids):
        candidates=[]
        for face in solid.Faces():
            if face.geomType()!='CYLINDER':continue
            cylinder=face._geomAdaptor().Cylinder();axis=cylinder.Axis().Direction();p=cylinder.Location()
            if abs(cylinder.Radius()-3.3)<1e-4 and abs(axis.Z())>.9999:
                candidates.append((p.X(),p.Y(),p.Z()))
        if len(candidates)==4: holes=candidates;break
    center=[sum(p[i] for p in holes)/4 for i in range(2)] if holes else []
    radii=[hypot(p[0]-center[0],p[1]-center[1]) for p in holes]
    checks={'step_has_seven_valid_solids':len(solids)==7 and all(s.isValid() for s in solids),
            'four_6_6_mm_mount_holes_on_50_mm_pcd':len(holes)==4 and all(isclose(r,25,abs_tol=.001) for r in radii)}
    # The exported solid order follows the seven named assembly components.
    # Probe the supporting finger material and the central 36 mm opening directly.
    checks['closed_finger_supports_and_clear_center']=all([
        solids[1].isInside(cq.Vector(0,-19,-3)),solids[2].isInside(cq.Vector(0,19,-3)),
        not solids[1].isInside(cq.Vector(0,-17.9,-3)),not solids[2].isInside(cq.Vector(0,17.9,-3))])
    meshes={p.name:trimesh.load_mesh(p,process=True) for p in files.glob('*.stl')}
    checks['seven_watertight_stls']=len(meshes)==7 and all(m.is_watertight and m.is_winding_consistent and m.volume>0 for m in meshes.values())
    checks['five_printable_parts_fit_assumed_bed']=sum('NONPRINT' not in name for name in meshes)==5 and all(all(m.extents[i]<=[220,220,250][i]+.01 for i in range(3)) for name,m in meshes.items() if 'NONPRINT' not in name)
    motion=[]
    for name in ('moving_fingers_pickup','moving_fingers_release_reset'):
        report=json.loads((files/(name+'_validation.json')).read_text())
        study=json.loads((files/(name+'_study.json')).read_text())
        gaps=[]
        for state in study['states']:
            translations={p['part']:p.get('translation',[0,0,0]) for p in state['poses']}
            if 'left_finger' in translations and 'right_finger' in translations:
                gaps.append(36+translations['right_finger'][1]-translations['left_finger'][1])
        motion.append({'study':name,'samples':len(report['samples']),'passed':report['passed'],
                       'collisions':report['collision_count'],'declared_tip_gap_range_mm':[min(gaps),max(gaps)]})
    checks['motion_evidence_passes']=all(m['passed'] and m['collisions']==0 for m in motion)
    checks['study_includes_36_to_80_mm_opening']=all(m['declared_tip_gap_range_mm']==[36,80] for m in motion)
    with zipfile.ZipFile(files/'FR3_passive_moving_fingers_prototype.zip') as archive:
        manifest=json.loads(archive.read('manifest.json'))
        checks['all_package_hashes_match']=all(hashlib.sha256(archive.read(item['name'])).hexdigest()==item['sha256'] for item in manifest['artifacts'])
        checks['corrected_notes_packaged']='Ø63 h8' in archive.read('ASSEMBLY_AND_TESTING.md').decode() and 'SIGXCPU' in archive.read('ASSEMBLY_AND_TESTING.md').decode()
        checks['no_superseded_cradle_or_pending_files']=not any('cradle' in name.lower() or 'PENDING' in name or 'UNCOMPILED' in name for name in archive.namelist())
    result={'passed':all(checks.values()),'checks':checks,'flange_hole_centers_mm':holes,
            'measured_pitch_circle_diameter_mm':round(2*sum(radii)/4,5) if radii else None,
            'motion':motion,'total_sampled_poses':sum(m['samples'] for m in motion),
            'limit':'STEP/STL/package measurements and inspection of reported sampled motion. No new motion solver, force, fruit-contact, fit or physical test is implied.'}
    output=root/'docs/evaluations/gripper-independent-geometry.json';output.write_text(json.dumps(result,indent=2))
    print(json.dumps(result,indent=2))
    return 0 if result['passed'] else 1


if __name__=='__main__':raise SystemExit(main())
