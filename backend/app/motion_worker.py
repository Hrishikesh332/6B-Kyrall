"""Sample prescribed rigid-body poses against exact CAD solids.

This is collision/clearance evidence, not a joint solver or a dynamics simulation.
"""
import json
import os
from pathlib import Path
import sys
from .cad_schema import CadInput
from .engineering_schema import MotionInput, Pose
from .cad_worker import rotated


def transformed(shape, pose):
    inverse=tuple(-x for x in pose.pivot)
    return rotated(shape.translate(inverse),pose.rotation).translate(pose.pivot).translate(pose.translation)


def load_geometry(path):
    import io
    import json as jsonlib
    import zipfile
    import cadquery as cq
    with zipfile.ZipFile(path) as archive:
        names=jsonlib.loads(archive.read('index.json'))['parts']
        return {name:cq.Shape.importBrep(io.BytesIO(archive.read(name+'.brep'))) for name in names}


def evaluate(spec, request, geometry=None):
    import numpy as np
    motion=MotionInput.model_validate(request)
    if geometry:
        assembled=load_geometry(geometry)
    else:
        from .cad_worker import construct_shapes
        data=CadInput.model_validate(spec)
        shapes=construct_shapes(data)
        assembled={p.name:rotated(shapes[p.shape],p.rotation).translate(p.translation).val() for p in data.parts}
    if sum(t.samples for t in motion.transitions)*len(assembled)*(len(assembled)-1)//2>12000:
        raise ValueError('Study exceeds 12000 part-pair checks; reduce samples or split into named studies')
    states={s.name:{p.part:p for p in s.poses} for s in motion.states}
    for poses in states.values():
        if set(poses)-set(assembled): raise ValueError('Motion references an unknown CAD part')
    for gap in motion.gap_checks:
        if set(gap.parts)-set(assembled): raise ValueError('Gap check references an unknown CAD part')
    sampled=[];collisions=[];gap_results=[];moved=set();cache={}

    def pose_at(state,name):
        return states[state].get(name,Pose(part=name))

    def geometry(poses):
        solids={}
        for name,shape in assembled.items():
            pose=poses.get(name,Pose(part=name))
            key=(name,*pose.translation,*pose.rotation,*pose.pivot)
            if key not in cache: cache[key]=transformed(shape,pose)
            solids[name]=cache[key]
        return solids

    pair_cache={}
    def check(poses,label):
        solids=geometry(poses)
        entries=list(solids.items())
        for i,(a,shape_a) in enumerate(entries):
            for b,shape_b in entries[i+1:]:
                pa,pb=poses[a],poses[b]
                key=(pa.model_dump_json(),pb.model_dump_json())
                if key not in pair_cache:
                    # Exact B-rep intersection; touching surfaces are allowed.
                    pair_cache[key]=float(shape_a.intersect(shape_b).Volume())
                volume=pair_cache[key]
                if volume>0.01: collisions.append({'sample':label,'parts':[a,b],'overlap_mm3':round(volume,4)})
        sampled.append(label)
        return solids

    # Include all endpoints independently, then all interior samples.
    for state in states:
        solids=check({name:pose_at(state,name) for name in assembled},state)
        for gap in (g for g in motion.gap_checks if g.state==state):
            actual=float(solids[gap.parts[0]].distance(solids[gap.parts[1]]))
            gap_results.append({'state':state,'parts':gap.parts,'measured_min_surface_distance_mm':round(actual,4),
                                'requested_range_mm':[gap.minimum_mm,gap.maximum_mm],
                                'passed':gap.minimum_mm-1e-5<=actual<=gap.maximum_mm+1e-5})
    for transition in motion.transitions:
        for name in assembled:
            a,b=pose_at(transition.start,name),pose_at(transition.end,name)
            if a.pivot!=b.pivot: raise ValueError('Keep the same world-space rotation pivot across a transition')
            if a.translation!=b.translation or a.rotation!=b.rotation: moved.add(name)
        for index in range(1,transition.samples-1):
            alpha=index/(transition.samples-1)
            poses={}
            for name in assembled:
                a,b=pose_at(transition.start,name),pose_at(transition.end,name)
                mix=lambda x,y:tuple(u+(v-u)*alpha for u,v in zip(x,y))
                poses[name]=Pose(part=name,translation=mix(a.translation,b.translation),rotation=mix(a.rotation,b.rotation),pivot=a.pivot)
            check(poses,f'{transition.start}->{transition.end}@{alpha:.3f}')
    if not moved: raise ValueError('At least one part must move between states')
    def matrix(pose):
        from math import sin,cos,radians
        x,y,z=map(radians,pose.rotation)
        rx=np.array([[1,0,0],[0,cos(x),-sin(x)],[0,sin(x),cos(x)]])
        ry=np.array([[cos(y),0,sin(y)],[0,1,0],[-sin(y),0,cos(y)]])
        rz=np.array([[cos(z),-sin(z),0],[sin(z),cos(z),0],[0,0,1]])
        rotation=rz@ry@rx;transform=np.eye(4);transform[:3,:3]=rotation
        pivot=np.array(pose.pivot);transform[:3,3]=pivot-rotation@pivot+np.array(pose.translation)
        return transform
    relative=[]
    names=list(assembled)
    for i,a in enumerate(names):
        for b in names[i+1:]:
            transforms=[np.linalg.inv(matrix(pose_at(state,a)))@matrix(pose_at(state,b)) for state in states]
            if any(not np.allclose(transforms[0],t,atol=1e-6,rtol=0) for t in transforms[1:]):relative.append([a,b])
    return {'passed':not collisions and all(g['passed'] for g in gap_results),
            'method':'Prescribed rigid-body poses; linear interpolation of world translations and Euler angles; exact B-rep intersections at discrete samples.',
            'source_artifact_id':motion.source_artifact_id,'states':list(states),'samples':sampled,
            'moving_parts':sorted(moved),'relative_motion_pairs':relative,'collisions':collisions[:100],'collision_count':len(collisions),'gap_checks':gap_results,
            'not_tested':['Continuous swept-volume collision freedom','Joint constraints and force transmission','Spring, friction and contact dynamics','Tomato deformation or bruising','Retention under load','Robot reachability and station collisions unless modeled','Physical operation'],
            'claim':'Sampled geometry only. A pass does not establish that the mechanism can move itself or grip and release.'}


if __name__=='__main__':
    import resource
    # Summed across OCC's parallel threads; the parent's 120 s wall timeout is the real bound.
    cpu=min(1600,110*(os.cpu_count() or 1))
    resource.setrlimit(resource.RLIMIT_CPU,(cpu,cpu+5))
    try:
        payload=json.loads(Path(sys.argv[1]).read_text())
        report=evaluate(payload.get('cad'),payload['motion'],payload.get('geometry'))
        print(json.dumps({'ok':True,'report':report}))
    except Exception as exc:
        print(json.dumps({'ok':False,'error':f'{type(exc).__name__}: {str(exc)[:1200]}'}))
        sys.exit(1)
