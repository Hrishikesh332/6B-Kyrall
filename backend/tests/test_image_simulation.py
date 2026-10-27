import io
import json
import hashlib
import pytest
from PIL import Image
from app.models import TaskCreate
from app.image_intake import ImageSetInput, normalize_image
from app.simulation_export import DynamicBody, usda_scene, export_scene, SimulationExportInput
from app.simulation import read_isaac


def photo(client, tid, color='red', name='object.jpg'):
    stream=io.BytesIO(); Image.new('RGB',(80,60),color).save(stream,format='JPEG');stream.seek(0)
    response=client.post(f'/api/tasks/{tid}/uploads',data={'file':(stream,name)})
    assert response.status_code==201, response.json
    return response.json


def capture_payload(image):
    return {'name':'Object','views':[{'artifact_id':image['id'],'angle':'front'}],
            'width_mm':40,'dimension_notes':'Width is outside diameter'}


def test_photo_decode_and_capture_provenance(app,task):
    client=app.test_client(); image=photo(client,task)
    assert image['name']=='object.png' and image['media_type']=='image/png'
    assert image['metadata']['kind']=='reference_image'
    raw=client.get(f'/api/tasks/{task}/artifacts/{image["id"]}/content').data
    assert Image.open(io.BytesIO(raw)).size==(80,60)
    response=client.post(f'/api/tasks/{task}/image-sets',json=capture_payload(image))
    assert response.status_code==201, response.json
    content=client.get(f'/api/tasks/{task}/artifacts/{response.json["id"]}/content').json
    assert content['views'][0]['sha256']==hashlib.sha256(raw).hexdigest()
    assert content['width_mm']==40 and content['depth_mm'] is None
    assert len(content['limitations'])>=3


def test_photo_rejects_corruption_and_excessive_pixels(app,task):
    client=app.test_client()
    r=client.post(f'/api/tasks/{task}/uploads',data={'file':(io.BytesIO(b'fake photo'),'bad.png')})
    assert r.status_code==422
    with pytest.raises(ValueError): normalize_image('bad.svg',b'<svg></svg>')
    with pytest.raises(ValueError): normalize_image('tiny.png',b'not-png')
    img=io.BytesIO();Image.new('RGB',(5,5)).save(img,format='PNG')
    with pytest.raises(ValueError,match='16 pixels'): normalize_image('tiny.png',img.getvalue())


def test_capture_scale_duplicates_and_task_isolation(app,task):
    client=app.test_client(); image=photo(client,task); payload=capture_payload(image)
    with pytest.raises(ValueError): ImageSetInput.model_validate({**payload,'width_mm':None})
    with pytest.raises(ValueError): ImageSetInput.model_validate({**payload,'width_mm':float('nan')})
    with pytest.raises(ValueError): ImageSetInput.model_validate({**payload,'views':payload['views']*2})
    other=app.state.db.create_task(TaskCreate(prompt='Another task'))
    assert client.post(f'/api/tasks/{other}/image-sets',json=payload).status_code==404


@pytest.mark.asyncio
async def test_uninspected_photo_blocks_cad(app,task):
    image=photo(app.test_client(),task)
    app.test_client().post(f'/api/tasks/{task}/image-sets',json=capture_payload(image))
    run=app.state.db.claim();app.state.settings.provider='claude'
    from app.recipes import plate
    with pytest.raises(ValueError,match='Inspect every photo'):
        await app.state.engine.runner.build_cad(task,run['id'],plate())


def test_isaac_export_uses_current_assembly_and_exact_sources(app,task,tmp_path):
    from app.cad_worker import build
    from app.recipes import plate
    output=tmp_path/'cad'; report=build(plate(),output);assert report['passed']
    store=app.state.store
    source_path=next(output.glob('*.cad.json'))
    source=store.put(task,None,source_path.name,source_path.read_bytes(),{'kind':'cad_source','build_id':'verified','validation_passed':True})
    mesh=store.put(task,None,'preview.mesh.json',(output/'preview.mesh.json').read_bytes(),{'kind':'mesh_preview','build_id':'verified'})
    result=export_scene(app.state.db,store,task,None,SimulationExportInput(source_artifact_id=source['id']))
    manifest=json.loads(store.get(task,result['manifest']['id'])[1].read_text())
    assert manifest['source_sha256']==source['sha256']
    assert manifest['mesh_sha256']==mesh['sha256']
    assert manifest['status']=='prepared_not_simulated'
    assert manifest['simulation_passed'] is None
    scene=store.get(task,result['scene']['id'])[1].read_text()
    assert 'metersPerUnit = 1' in scene and 'upAxis = "Z"' in scene
    assert 'PhysicsRigidBodyAPI' not in scene
    assert 'PhysicsCollisionAPI' in scene
    with pytest.raises(ValueError,match='unique parts'):
        export_scene(app.state.db,store,task,None,SimulationExportInput(source_artifact_id=source['id'],dynamic_bodies=[DynamicBody(part='missing',mass_kg=1,static_friction=.5,dynamic_friction=.4)]))


def test_dynamic_export_scale_materials_and_read_only_boundary(app):
    mesh={'parts':[{'name':'object','vertices':[[0,0,1000],[1000,0,1000],[0,1000,1000]],'faces':[[0,1,2]]}]}
    body=DynamicBody(part='object',mass_kg=.1,static_friction=.5,dynamic_friction=.4)
    usd=usda_scene(mesh,[body])
    assert '(0,0,1),(1,0,1),(0,1,1)' in usd
    assert 'float physics:mass = 0.1' in usd and 'convexHull' in usd
    with pytest.raises(ValueError): DynamicBody(part='object',mass_kg=0,static_friction=.2,dynamic_friction=.4)
    with pytest.raises(ValueError,match='Only Isaac observation'):
        read_isaac(app.state.settings,'franka_move_joints')
    result=app.test_client().get('/api/simulation/status').json
    assert result['connected'] is False
