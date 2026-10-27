import json
from pathlib import Path
import pytest
from app.cad_schema import apply_cad_patch
from app.motion_worker import evaluate
from app.agent_context import compact_result
from app.completion import completion_errors
from app.pdf_worker import extract


def two_blocks():
    return {'name':'slider','nodes':[{'id':'block','op':'box','size':[2,2,2]}],
            'parts':[{'name':'fixed','shape':'block'},{'name':'moving','shape':'block','translation':[5,0,0]}]}


def study(end=(-10,0,0)):
    return {'source_artifact_id':'source','states':[{'name':'start'},{'name':'end','poses':[{'part':'moving','translation':end}]}],
            'transitions':[{'start':'start','end':'end','samples':5}]}


def test_motion_catches_collision_between_clear_endpoints():
    result=evaluate(two_blocks(),study())
    assert not result['passed']
    assert all('->' in c['sample'] for c in result['collisions'])
    assert any(c['overlap_mm3']==8 for c in result['collisions'])
    assert 'Joint constraints and force transmission' in result['not_tested']


def test_motion_gap_is_measured_and_bad_pose_is_rejected():
    request=study((4,0,0))
    request['gap_checks']=[{'state':'start','parts':['fixed','moving'],'minimum_mm':3,'maximum_mm':3.01}]
    report=evaluate(two_blocks(),request)
    assert report['passed'] and report['gap_checks'][0]['measured_min_surface_distance_mm']==3
    request['gap_checks'][0]['minimum_mm']=4;request['gap_checks'][0]['maximum_mm']=5
    assert not evaluate(two_blocks(),request)['passed']
    with pytest.raises(ValueError,match='At least one'):
        evaluate(two_blocks(),study((0,0,0)))
    request=study();request['states'][1]['poses'][0]['part']='unknown'
    with pytest.raises(ValueError,match='unknown'):evaluate(two_blocks(),request)


def test_patch_preserves_unchanged_geometry_and_validates_graph():
    source=two_blocks()
    result=apply_cad_patch(source,{'source_artifact_id':'x','replace_parts':[{'name':'moving','shape':'block','translation':[9,0,0]}]})
    assert json.loads(json.dumps(result['nodes']))==source['nodes']
    assert result['parts'][0]['translation']==(0,0,0)
    assert result['parts'][1]['translation']==(9,0,0)
    with pytest.raises(ValueError,match='missing references'):
        apply_cad_patch(source,{'source_artifact_id':'x','replace_nodes':[{'id':'block','op':'transform','source':'block'}]})


def test_pdf_page_bounds_and_provenance(tmp_path,monkeypatch):
    from pypdf import PdfWriter
    writer=PdfWriter();writer.add_blank_page(width=300,height=300)
    path=tmp_path/'small.pdf';writer.write(path)
    monkeypatch.setattr('app.pdf_worker.shutil.which',lambda _:None)
    result=extract(path,tmp_path/'pages',{'page_start':1,'page_count':2})
    assert result['total_pages']==1 and result['pages'][0]['page']==1
    assert 'image_unavailable' in result['pages'][0]
    with pytest.raises(ValueError,match='outside'):extract(path,tmp_path/'pages',{'page_start':2})


@pytest.mark.asyncio
async def test_measured_claims_cannot_cite_authored_prose(app,task):
    run=app.state.db.claim();store=app.state.store;runner=app.state.engine.runner
    source=store.put(task,run['id'],'test.cad.json',json.dumps(two_blocks()).encode(),{'kind':'cad_source','build_id':'a'})
    prose=store.put(task,run['id'],'claim.md',b'Passed',{'kind':'document'})
    with pytest.raises(ValueError,match='Measured evidence'):
        await runner.dispatch(task,run['id'],'record_design_review',{'source_artifact_id':source['id'],'requirements':[{'status':'measured','evidence_ids':[prose['id']]}]})


def test_packages_reject_failed_and_stale_cad(app,task):
    rid=app.state.db.claim()['id'];store=app.state.store
    first=store.put(task,rid,'part.stl',b'one',{'build_id':'a','validation_passed':True})
    last=store.put(task,rid,'part.stl',b'two',{'build_id':'b','validation_passed':False})
    with pytest.raises(ValueError,match='stale'):store.package(task,rid,'bad',[first['id']])
    with pytest.raises(ValueError,match='failed'):store.package(task,rid,'bad',[last['id']])
    doc=store.put(task,rid,'notes.md',b'notes')
    package=store.package(task,rid,'test.zip',[doc['id']])
    assert package['name']=='test.zip'


def test_compact_tool_response_preserves_evidence_ids_without_audit_noise():
    result=compact_result({'artifacts':[{'id':'a','name':'part.stl','version':2,'metadata':{'build_id':'x'},'sha256':'digest','task_id':'task','created_at':1}],
                           'content':'{\n "nodes": []\n}', 'name':'part.cad.json'})
    assert result['artifacts'][0]['id']=='a' and 'created_at' not in result['artifacts'][0]
    assert result['content']=={'nodes':[]}


def test_mechanism_completion_requires_current_motion_and_review(app,task):
    rid=app.state.db.claim();db=app.state.db;store=app.state.store
    with db.transaction() as c:
        c.execute('UPDATE tasks SET title=? WHERE id=?',('Passive gripper',task))
        c.execute('INSERT INTO tool_calls(id,task_id,run_id,name,arguments,result,status,started_at) VALUES(?,?,?,?,?,?,?,?)',('fake',task,rid['id'],'build_cad','{}','{}','completed',1))
    store.put(task,rid['id'],'validation.json',b'{}',{'kind':'validation','validation_passed':True,'build_id':'new'})
    store.put(task,rid['id'],'motion_validation.json',b'{}',{'kind':'motion_validation','motion_passed':True,'build_id':'old'})
    errors=completion_errors(app.state.engine,rid,{})
    assert any('Evaluate moving parts' in e for e in errors)
    assert any('Record a design review' in e for e in errors)


def test_whole_tool_translation_is_not_relative_closure():
    request=study((4,0,0))
    request['states'][1]['poses'].append({'part':'fixed','translation':[4,0,0]})
    result=evaluate(two_blocks(),request)
    assert result['passed'] and result['relative_motion_pairs']==[]
    relative=evaluate(two_blocks(),study((4,0,0)))
    assert relative['relative_motion_pairs']==[['fixed','moving']]


def test_closure_contract_blocks_a_rigid_cradle_review(app,task):
    rid=app.state.db.claim();db=app.state.db;store=app.state.store
    with db.transaction() as c:
        db.message(c,task,rid['id'],'user','text','The gripper must close and release, with moving jaws.')
        c.execute('INSERT INTO tool_calls(id,task_id,run_id,name,arguments,result,status,started_at) VALUES(?,?,?,?,?,?,?,?)',('built',task,rid['id'],'build_cad','{}','{}','completed',1))
    store.put(task,rid['id'],'validation.json',b'{}',{'kind':'validation','validation_passed':True,'build_id':'new'})
    store.put(task,rid['id'],'motion_validation.json',b'{}',{'kind':'motion_validation','motion_passed':True,'build_id':'new'})
    store.put(task,rid['id'],'design_review.json',b'{}',{'kind':'design_review','relative_retaining_motion_verified':False,'build_id':'new'})
    assert any('rigid cradle' in e for e in completion_errors(app.state.engine,rid,{}))


@pytest.mark.asyncio
async def test_complex_assembly_returns_geometry_diagnostics_within_cpu_budget(app,task):
    # This actual 81-node graph previously died with SIGXCPU and no result when
    # OpenCascade's unrestricted thread pool consumed 100 CPU seconds in seconds.
    candidate=json.loads((Path(__file__).parent/'fixtures/complex_gripper.json').read_text())
    run=app.state.db.claim()
    result=await app.state.engine.runner.execute(task,run['id'],'cpu-regression','build_cad',candidate)
    assert 'error' not in result,result
    assert len(result['validation']['parts'])==7
    assert all(p['watertight'] for p in result['validation']['parts'])
    assert not result['validation']['passed']  # Two genuine 72 mm³ interferences.
    assert len(result['validation']['interferences'])==2


def test_incomplete_macos_font_report_does_not_abort_cad_rendering(monkeypatch):
    import plistlib,subprocess
    from app.rendering import font_discovery_guard
    raw=plistlib.dumps([{'_name':'Fonts'}])
    def fake(*args,**kwargs):return raw
    monkeypatch.setattr('app.rendering.sys.platform','darwin')
    monkeypatch.setattr(subprocess,'check_output',fake)
    with font_discovery_guard():
        normalized=plistlib.loads(subprocess.check_output(['system_profiler','-xml','SPFontsDataType']))
        assert normalized==[{'_name':'Fonts','_items':[]}]
        assert subprocess.check_output(['unrelated-command'])==raw
    assert subprocess.check_output is fake
