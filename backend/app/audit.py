"""Inspectable execution evidence, reconstructed from durable task records."""
import json
from .db import NotFound


PHASES = {
    'ask_questions':'clarify', 'fetch_reference':'research', 'search_context':'research',
    'build_cad':'build', 'revise_cad':'revise', 'inspect_validation':'inspect',
    'inspect_image':'inspect', 'evaluate_motion':'inspect', 'record_design_review':'inspect',
    'package_artifacts':'package', 'write_document':'package',
}


def record_decision(runner, tid, rid, args):
    evidence=[]
    for aid in args['evidence_ids']:
        row,_=runner.store.get(tid,aid)
        kind=row['metadata'].get('kind')
        if args['basis']=='source' and kind!='reference':
            raise ValueError('Source claims require fetched reference artifacts')
        if args['basis']=='measurement':
            if kind not in ('validation','motion_validation'):
                raise ValueError('Measurement claims require numeric validation evidence')
            if row['metadata'].get('validation_passed') is False or row['metadata'].get('motion_passed') is False:
                raise ValueError('Failed validation cannot support a passed measurement; record an unresolved design finding instead')
        evidence.append({k:row[k] for k in ('id','name','version','sha256','metadata')})
    builds={e['metadata']['build_id'] for e in evidence if e['metadata'].get('build_id')}
    if len(builds)>1:
        raise ValueError('A decision cannot combine evidence from different CAD builds')
    latest=runner.db.one("SELECT metadata FROM artifacts WHERE task_id=? AND name='validation.json' ORDER BY created_at DESC LIMIT 1",(tid,))
    build_id=next(iter(builds),None)
    if build_id and latest and build_id!=latest['metadata'].get('build_id'):
        raise ValueError('Use evidence from the latest CAD build')
    record={**args,'evidence':evidence,'build_id':build_id,
            'assessment':'Model-authored summary. Evidence identity is verified; its interpretation requires review.'}
    artifact=runner.store.put(tid,rid,'decision_'+args['key']+'.json',json.dumps(record,indent=2).encode(),
                              {'kind':'decision','build_id':build_id,'decision':record})
    runner.db.emit(tid,rid,'decision.recorded',{'artifact_id':artifact['id'],**record})
    return {'artifact':artifact,'decision':record}


def tool_summary(row):
    item={k:row[k] for k in ('id','run_id','name','status','started_at','finished_at')}
    item['phase']=PHASES.get(row['name'],'interpret')
    item['duration_ms']=round(max(0,row['finished_at']-row['started_at'])*1000) if row['finished_at'] else None
    return item


def task_audit(db, tid):
    db.require_task(tid)
    artifacts=db.all('SELECT id,run_id,name,version,sha256,metadata,created_at FROM artifacts WHERE task_id=? ORDER BY created_at',(tid,))
    latest={a['name']:a for a in artifacts}
    build=latest.get('validation.json',{}).get('metadata',{}).get('build_id')
    # Read legacy reference provenance from its persisted tool result, without opening
    # arbitrary files or exposing entire extracted manuals in every refresh.
    references={}
    for call in db.all("SELECT result FROM tool_calls WHERE task_id=? AND name='fetch_reference' AND status='completed' ORDER BY started_at",(tid,)):
        result=call['result'] or {}
        references[result.get('evidence_artifact_id')]=result
    sources=[]
    decisions=[]
    for artifact in artifacts:
        meta=artifact['metadata']
        if meta.get('kind')=='reference':
            old=references.get(artifact['id'],{})
            sources.append({**{k:artifact[k] for k in ('id','run_id','name','version','created_at')},
                'url':meta.get('url',old.get('url')),
                'document_sha256':meta.get('document_sha256',old.get('sha256')),
                'fetched_at':meta.get('fetched_at',old.get('fetched_at')),
                'media_type':meta.get('media_type',old.get('media_type')),
                'pages':meta.get('pages',[p['page'] for p in old.get('pages',[])]),
                'truncated':meta.get('truncated',old.get('truncated',False))})
        if meta.get('kind')=='decision':
            decisions.append({**meta['decision'],'id':artifact['id'],'run_id':artifact['run_id'],
                'version':artifact['version'],'created_at':artifact['created_at'],
                'superseded':latest[artifact['name']]['id']!=artifact['id'],
                'stale':bool(meta.get('build_id') and meta['build_id']!=build)})
    calls=db.all('SELECT id,run_id,name,status,started_at,finished_at FROM tool_calls WHERE task_id=? ORDER BY started_at',(tid,))
    checks=db.all("SELECT run_id,payload,created_at FROM events WHERE task_id=? AND type='completion.checked' ORDER BY seq",(tid,))
    return {'tools':[tool_summary(c) for c in calls],'sources':sources,'decisions':decisions,'checks':checks}


def tool_detail(db, tid, cid):
    db.require_task(tid)
    row=db.one('SELECT id,run_id,name,arguments,result,status,started_at,finished_at FROM tool_calls WHERE task_id=? AND id=?',(tid,cid))
    if not row:
        raise NotFound('Tool call not found in this task')
    return {**row,**tool_summary(row)}
