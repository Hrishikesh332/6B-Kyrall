import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import json
from pathlib import Path
import re
import time
from urllib.parse import urlparse
from flask import request, jsonify, Response, send_from_directory
from werkzeug.datastructures import FileStorage
from .api import API, HTTPException, FileResponse, File, Header, Query
from .runtime import WorkerRuntime
from .config import MODEL_PROVIDERS, VISION_PROVIDERS, Settings
from .db import DB, Conflict, NotFound, encode, uid
from .artifacts import ArtifactStore
from .tools import ToolRunner, TOOL_SPECS
from .engine import Engine
from .cad_schema import part_dependencies
from .cad_script import ParameterValues, apply_parameters
from .rules import RuleSetUserDecision
from .bambu import BambuSettings
from .models import ApprovalDecision,TaskCreate,TaskPatch,MessageCreate,ClarificationAnswer,ProjectCreate,ProjectPatch,ScheduleCreate,SchedulePatch,RuleCreate,RulePatch
from .image_intake import ImageSetInput, normalize_image, save_image_set
from .simulation_export import SimulationExportInput, export_scene
from .mesh_samples import MeshSamples
from .connections import NAMES, ConnectionCheck, ConnectionInput, Connections
from .onshape import CredentialStore, OnshapeClient, OnshapeCredentials, OnshapeError, OnshapeExport, OnshapeImport, export_step, import_element, ID as ONSHAPE_ID


def focused_message(store, task_id, focus, content):
    """Scope a studio follow-up to one component so the agent patches, not rebuilds."""
    row,path=store.get(task_id,focus.source_artifact_id)
    if row['metadata'].get('kind')=='onshape_import':
        manifest=json.loads(path.read_text())
        part=next((p for p in manifest['parts'] if p['name']==focus.part),None)
        if part is None: raise ValueError('That component is not in the selected Onshape import')
        return (f"[Component focus: {focus.part}]\n{content.strip()}\n\n"
            f"Scope: `{focus.part}` is read-only geometry imported from Onshape ({manifest['document']} / {manifest['element']}; "
            f"Onshape part {part['onshape_name']}). Envelope {' x '.join(map(str,part['bounds_mm']))} mm centred at "
            f"{part['position_mm']} mm in assembly coordinates; placement and neighbours are in {row['name']} ({row['id']}). "
            "Its Onshape features cannot be edited here: design new or replacement parts with build_cad that fit this geometry, "
            "and list the exact changes to make in Onshape.")
    if row['metadata'].get('kind')=='cad_script':
        if focus.part not in row['metadata'].get('parts',[]): raise ValueError('That component is not in the selected CAD script')
        return (f"[Component focus: {focus.part}]\n{content.strip()}\n\n"
            f"Scope: change only the code that builds part `{focus.part}` in CAD script {row['id']} ({row['name']} v{row['version']}) "
            "using revise_cad_script with small find/replace edits. Keep every other part's geometry and the parameter names "
            "unchanged unless this part depends on them. Look at the returned views, then re-check validation for fits and "
            "overlaps with neighbouring parts.")
    if row['metadata'].get('kind')!='cad_source': raise ValueError('Select a component from a generated CAD build')
    nodes,shared=part_dependencies(json.loads(path.read_text()),focus.part)
    scope=(f"[Component focus: {focus.part}]\n{content.strip()}\n\n"
        f"Scope: change only part `{focus.part}` with revise_cad on CAD source {row['id']} ({row['name']} v{row['version']}). "
        f"Its nodes: {', '.join(nodes)}. Replace those nodes or this part entry; keep every other part unchanged.")
    if shared: scope+=f" Shared with other parts: {', '.join(shared)}; copy before editing so other parts stay identical."
    return scope+" Then re-check validation for fits and overlaps with neighbouring parts."


def start_job(db, c, job):
    """Open a new chat for one run of a job and queue it."""
    tid,now=uid(),time.time()
    c.execute("INSERT INTO tasks(id,title,context_scope,status,created_at,updated_at) VALUES(?,?,'isolated','queued',?,?)",(tid,job['name'],now,now))
    rid=db.queue_run(c,tid)
    db.message(c,tid,rid,'user','text',job['prompt'])
    c.execute('UPDATE schedules SET last_task_id=? WHERE id=?',(tid,job['id']))
    return tid


async def scheduler(db, stop):
    while not stop.is_set():
        # Claim a due interval atomically; an interrupted fire is not replayed blindly.
        with db.transaction() as c:
            due=c.execute('SELECT * FROM schedules WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 1',(time.time(),)).fetchone()
            if due:
                start_job(db,c,due)
                c.execute('UPDATE schedules SET next_run_at=? WHERE id=?',(time.time()+due['interval_minutes']*60,due['id']))
        try: await asyncio.wait_for(stop.wait(),timeout=5)
        except asyncio.TimeoutError: pass


def create_app(settings=None,provider=None):
    settings=settings or Settings()
    settings.prepare()
    # A connection chosen in the app overrides the backend/.env provider on later starts.
    connections=Connections(settings)
    try: settings.prepare()
    except ValueError:
        # A saved choice that no longer validates (e.g. a removed API key) falls back to backend/.env.
        connections.apply({}); settings.prepare()
    db=DB(settings.data_dir/'workspace.sqlite3')
    store=ArtifactStore(db,settings.data_dir/'artifacts')
    runner=ToolRunner(db,store,settings)
    engine=Engine(db,runner,settings,provider)
    mesh_samples=MeshSamples()
    app=API()
    app.config['TRUSTED_HOSTS']=[*app.config['TRUSTED_HOSTS'],*settings.allowed_hosts]
    app.state.db,app.state.engine,app.state.store,app.state.settings=db,engine,store,settings
    app.state.runtime=WorkerRuntime(engine,lambda stop:scheduler(db,stop))

    @app.before_request
    def local_boundary():
        if request.path.startswith(('/api/','/openapi.json')):
            if settings.api_token and not hmac.compare_digest(request.headers.get('authorization',''),'Bearer '+settings.api_token):
                return jsonify(detail='Local API token required'),401
            origin=request.headers.get('origin')
            if origin and origin != request.host_url.rstrip('/'):
                return jsonify(detail='Cross-origin API requests are not allowed'),403
        if settings.worker_enabled: app.state.runtime.start()

    @app.after_request
    def response_headers(response):
        response.headers['X-Content-Type-Options']='nosniff'
        response.headers['Referrer-Policy']='no-referrer'
        response.headers['Content-Security-Policy']="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
        return response

    app.register_error_handler(Conflict,lambda exc:(jsonify(detail=str(exc)),409))
    app.register_error_handler(NotFound,lambda exc:(jsonify(detail=str(exc)),404))
    app.register_error_handler(ValueError,lambda exc:(jsonify(detail=str(exc)),422))

    @app.get('/api/health')
    def health(): return {'ok':True,'provider':settings.provider,'model':(settings.claude_model if settings.provider=='claude' else settings.model) or None,'worker_enabled':settings.worker_enabled,'framework':'flask'}

    @app.get('/api/simulation/status')
    def simulation_status():
        from .simulation import configured, observation
        if not configured(settings):
            return {'configured':False,'connected':False,'scope':'Configure the Isaac SSH host, container, Python path and MCP script path to observe an existing session.'}
        try: return observation(settings)
        except (ValueError,OSError) as exc:
            return {'configured':True,'connected':False,'error':str(exc),'design_validation':'unlinked'}

    @app.get('/api/simulation/snapshot')
    def simulation_snapshot():
        from .simulation import snapshot
        try: pixels,mime=snapshot(settings)
        except (ValueError,OSError) as exc: raise HTTPException(503,str(exc))
        return Response(pixels,mimetype=mime,headers={'Cache-Control':'no-store'})

    @app.post('/api/tasks/{task_id}/simulation-export',status_code=201)
    def simulation_export(task_id:str,data:SimulationExportInput):
        return export_scene(db,store,task_id,None,data)

    onshape_keys=CredentialStore(settings.data_dir)
    def onshape():
        return OnshapeClient.from_store(onshape_keys,app.state.onshape_transport)
    app.state.onshape_transport=None
    app.register_error_handler(OnshapeError,lambda exc:(jsonify(detail=str(exc)),502 if 'reached' in str(exc) else 422))

    @app.get('/api/integrations/model')
    def model_connection(): return connections.overview()

    @app.post('/api/integrations/model/check')
    def model_connection_check(data:ConnectionCheck):
        return asyncio.run(connections.check(data.provider))

    @app.put('/api/integrations/model')
    def model_connect(data:ConnectionInput):
        busy=engine.active_run or db.one("SELECT 1 FROM runs WHERE status='running'")
        return connections.connect(data,bool(busy))

    @app.delete('/api/integrations/model/anthropic-key')
    def model_forget_key():
        if connections.defaults['anthropic_api_key']:
            raise Conflict('ANTHROPIC_API_KEY is set in the environment; remove it there')
        return connections.forget_claude_key()

    @app.get('/api/integrations/onshape')
    def onshape_status(): return onshape_keys.status()

    @app.put('/api/integrations/onshape')
    def onshape_connect(data:OnshapeCredentials):
        if (onshape_keys.load() or {}).get('source')=='environment':
            raise Conflict('Onshape keys are set by environment variables; change them there')
        client=OnshapeClient(data.base_url,data.access_key,data.secret_key,app.state.onshape_transport)
        try: user=client.session()
        finally: client.close()
        onshape_keys.save(data,user)
        return onshape_keys.status()

    @app.post('/api/integrations/onshape/test')
    def onshape_test():
        client=onshape()
        try: user=client.session()
        finally: client.close()
        onshape_keys.update_user(user)
        return {**onshape_keys.status(),'user':user,'checked_at':time.time()}

    @app.delete('/api/integrations/onshape')
    def onshape_disconnect():
        if (onshape_keys.load() or {}).get('source')=='environment':
            raise Conflict('Onshape keys are set by environment variables; remove them there')
        onshape_keys.delete()
        return onshape_keys.status()

    @app.get('/api/onshape/documents')
    def onshape_documents(q:str=Query('',max_length=100),filter:int=Query(5,ge=0,le=9),offset:int=Query(0,ge=0,le=2000)):
        client=onshape()
        try: return client.documents(q,filter,offset)
        finally: client.close()

    @app.get('/api/onshape/documents/{did}/w/{wid}/elements')
    def onshape_elements(did:str,wid:str):
        if not (re.fullmatch(ONSHAPE_ID,did) and re.fullmatch(ONSHAPE_ID,wid)): raise ValueError('Invalid Onshape identifiers')
        client=onshape()
        try: return client.elements(did,wid)
        finally: client.close()

    @app.get('/api/onshape/thumbnail')
    def onshape_thumbnail(did:str,wid:str,eid:str=''):
        if not all(re.fullmatch(ONSHAPE_ID,x) for x in (did,wid,*([eid] if eid else []))): raise ValueError('Invalid Onshape identifiers')
        client=onshape()
        try: image,media=client.thumbnail(did,wid,eid or None)
        finally: client.close()
        return Response(image,mimetype=media,headers={'Cache-Control':'private, max-age=600'})

    @app.post('/api/onshape/import',status_code=201)
    def onshape_import(data:OnshapeImport):
        client=onshape()
        try: return import_element(client,store,db,data)
        finally: client.close()

    @app.post('/api/onshape/export')
    def onshape_export(data:OnshapeExport):
        client=onshape()
        try: return export_step(client,store,db,data,app.state.onshape_sleep)
        finally: client.close()
    app.state.onshape_sleep=time.sleep

    @app.get('/api/capabilities')
    def capabilities():
        model_name={'claude':settings.claude_model or 'Claude Code account default','openai':settings.model}.get(settings.provider,'Local workshop')
        provider_detail={'claude':'Signed-in Claude Code account'+(f'; model {settings.claude_model}' if settings.claude_model else '; account default model'),
                         'openai':settings.model}.get(settings.provider,'Workshop recipes run without an API key')
        return {'provider':settings.provider,'provider_name':NAMES[settings.provider],'connection_source':connections.source(),'model':model_name,'reasoning_effort':settings.reasoning_effort if settings.provider in MODEL_PROVIDERS else None,
                'tools':[{'name':name,'description':d} for name,(_,d) in TOOL_SPECS.items()],
                'reference_domains':settings.reference_domains,'limits':{'model_turns':settings.max_model_turns,'run_tokens':settings.max_run_tokens,'upload_bytes':10*1024*1024},
                'integrations':[{'name':'Bambu Studio','status':'connected' if __import__('app.bambu',fromlist=['binary']).binary() else 'not_configured','detail':'Slice CAD builds in your installed Bambu Studio with your printer, process and filament profiles: print time, filament, layers and Bambu\'s own printability warnings, plus a 3MF project to open.'},
                                {'name':'Onshape','status':'connected' if onshape_keys.load() else 'not_configured','detail':'Import Part Studios or Assemblies as STL parts with a placed 3D assembly, and send generated STEP files back into a chosen Onshape document.'},
                                {'name':'Parametric CAD','status':'available','detail':'CadQuery solid modeling, STL/STEP export and validation'},
                                {'name':'Model provider','status':'connected' if settings.provider in MODEL_PROVIDERS else 'not_configured','detail':provider_detail},
                                {'name':'Reference reader','status':'available' if settings.reference_domains else 'disabled','detail':'Allowlisted HTML and PDF references with page images and source hashes'},
                                {'name':'Mechanism evidence','status':'available','detail':'Sampled rigid-body collision and gap checks, requirement evidence, cycle review and bench-test criteria; no physical validation'},
                                {'name':'Visual review','status':'available' if settings.provider in VISION_PROVIDERS else 'preview_only','detail':'Decoded multi-angle object photos, CAD projections and PDF page pixels can be inspected by Claude Code'},
                                {'name':'NVIDIA Isaac Sim','status':'configured' if settings.isaac_ssh_host and settings.isaac_container else 'not_configured','detail':'Read-only Brev scene observations and viewport; source-linked USD collision export. CAD grasp validation requires a matching instrumented scene.'},
                                {'name':'Desktop CAD / external MCP','status':'not_implemented','detail':'Adapter interface documented; no external application control is connected'}]}

    @app.get('/api/tasks')
    def tasks(q:str='',status:str|None=None,project_id:str|None=None,archived:bool=False,limit:int=Query(50,ge=1,le=100),offset:int=Query(0,ge=0)):
        conditions,args=['archived=?'],[int(archived)]
        if q: conditions.append('title LIKE ?'); args.append('%'+q+'%')
        if status: conditions.append('status=?'); args.append(status)
        if project_id: conditions.append('project_id=?'); args.append(project_id)
        where=' AND '.join(conditions)
        return {'items':db.all(f'SELECT * FROM tasks WHERE {where} ORDER BY updated_at DESC LIMIT ? OFFSET ?',(*args,limit,offset)), 'total':db.one(f'SELECT COUNT(*) AS n FROM tasks WHERE {where}',args)['n']}

    @app.post('/api/tasks',status_code=201)
    def create_task(data:TaskCreate,idempotency_key:str|None=Header(default=None,max_length=150)):
        return db.detail(db.create_task(data,idempotency_key))

    @app.get('/api/tasks/{task_id}')
    def task(task_id:str): return db.detail(task_id)

    @app.patch('/api/tasks/{task_id}')
    def update_task(task_id:str,data:TaskPatch):
        db.require_task(task_id)
        with db.transaction() as c:
            if data.title is not None: c.execute('UPDATE tasks SET title=?,updated_at=? WHERE id=?',(data.title,time.time(),task_id))
            if data.archived is not None: c.execute('UPDATE tasks SET archived=?,updated_at=? WHERE id=?',(int(data.archived),time.time(),task_id))
            if data.approval_policy is not None: c.execute('UPDATE tasks SET approval_policy=?,updated_at=? WHERE id=?',(data.approval_policy,time.time(),task_id))
        return db.detail(task_id)

    @app.post('/api/tasks/{task_id}/messages',status_code=202)
    def send(task_id:str,data:MessageCreate,idempotency_key:str|None=Header(default=None,max_length=150)):
        if not data.content.strip(): raise ValueError('Message cannot be blank')
        content=data.content
        if data.focus: content=focused_message(store,task_id,data.focus,content)
        return {'run_id':db.add_message(task_id,content,idempotency_key)}

    @app.post('/api/tasks/{task_id}/cancel')
    def cancel(task_id:str):
        # Idempotent cancellation is useful on unreliable client connections.
        task=db.require_task(task_id)
        if task['status'] not in ('cancelled','completed','failed','interrupted'):
            db.cancel(task_id)
        return db.detail(task_id)

    @app.post('/api/tasks/{task_id}/retry',status_code=202)
    def retry(task_id:str): return {'run_id':db.retry(task_id)}

    @app.get('/api/tasks/{task_id}/session')
    def session_export(task_id:str,format:str=Query('json',max_length=8),raw:bool=False):
        from .sessions import markdown, transcript
        db.require_task(task_id)
        record=transcript(db,settings.data_dir,task_id,raw)
        if format=='md':
            return Response(markdown(record),mimetype='text/markdown',headers={'Content-Disposition':f'attachment; filename="6b-session-{task_id[:8]}.md"'})
        return record

    @app.get('/api/tasks/{task_id}/builds')
    def task_builds(task_id:str):
        from .compare import builds
        db.require_task(task_id)
        return builds(db,task_id)

    @app.get('/api/tasks/{task_id}/compare')
    def compare(task_id:str,from_build:str=Query('',max_length=64),to_build:str=Query('',max_length=64)):
        from .compare import compare_builds
        db.require_task(task_id)
        if not from_build or not to_build: raise ValueError('Choose two builds to compare')
        return compare_builds(db,store,task_id,from_build,to_build)

    @app.post('/api/tasks/{task_id}/approvals/{approval_id}',status_code=202)
    def decide(task_id:str,approval_id:str,data:ApprovalDecision):
        return {'run_id':db.decide_approval(task_id,approval_id,data)}

    rebuilding=set()
    @app.post('/api/tasks/{task_id}/artifacts/{artifact_id}/rebuild',status_code=201)
    def rebuild(task_id:str,artifact_id:str,data:ParameterValues):
        # Slider changes rebuild the saved script directly: same sandbox, no model call.
        row,path=store.get(task_id,artifact_id)
        if row['metadata'].get('kind')!='cad_script': raise ValueError('Only generated .cad.py scripts have parameters')
        if db.one("SELECT 1 FROM runs WHERE task_id=? AND status IN ('queued','running')",(task_id,)):
            raise Conflict('6B is working on this task; rebuild after the current run finishes')
        if task_id in rebuilding: raise Conflict('A rebuild is already running for this task')
        rebuilding.add(task_id)
        try:
            script=apply_parameters(path.read_text(),data.values)
            request={'name':row['name'].removesuffix('.cad.py'),'script':script,
                     'print_bed':row['metadata'].get('print_bed',[220,220,250]),'notes':row['metadata'].get('notes',[])}
            extra={'print_bed':request['print_bed'],'notes':request['notes'],'origin':'parameter_rebuild',
                   'revised_from':row['id'],'parameter_values':data.values}
            # A private loop on a worker thread works whether or not this thread already runs one.
            with ThreadPoolExecutor(1) as pool:
                result=pool.submit(asyncio.run,runner.build_cad_script(task_id,None,request,extra)).result()
        finally:
            rebuilding.discard(task_id)
        with db.transaction() as c:
            db.message(c,task_id,None,'user','parameter_change',{'source':row['name'],'values':data.values,
                       'build_id':result['build_id'],'passed':result['validation']['passed']})
        mesh=next(a for a in result['artifacts'] if a['metadata']['kind']=='mesh_preview')
        script_file=next(a for a in result['artifacts'] if a['metadata']['kind']=='cad_script')
        return {'build_id':result['build_id'],'validation':result['validation'],'preview_artifact_id':mesh['id'],
                'script_artifact_id':script_file['id'],'parameters':script_file['metadata']['parameters']}

    @app.post('/api/tasks/{task_id}/questions/{questionnaire_id}/answer',status_code=202)
    def answer(task_id:str,questionnaire_id:str,data:ClarificationAnswer):
        return {'run_id':db.answer(task_id,questionnaire_id,data)}

    @app.get('/api/tasks/{task_id}/events')
    def events(task_id:str,after:int=Query(0,ge=0),last_event_id:str|None=Header(default=None)):
        db.require_task(task_id)
        try: cursor=max(after,int(last_event_id or 0))
        except ValueError: raise HTTPException(400,'Invalid Last-Event-ID')
        def stream():
            nonlocal cursor
            heartbeat=time.monotonic()
            expires=heartbeat+30
            while time.monotonic()<expires:
                batch=db.all('SELECT * FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT 100',(task_id,cursor))
                for event in batch:
                    cursor=event['seq']
                    yield f'id: {cursor}\nevent: {event["type"]}\ndata: {encode(event)}\n\n'
                if time.monotonic()-heartbeat>10:
                    yield ': heartbeat\n\n'; heartbeat=time.monotonic()
                time.sleep(0.3)
        return Response(stream(),mimetype='text/event-stream',headers={'Cache-Control':'no-cache','X-Accel-Buffering':'no'})

    @app.get('/api/tasks/{task_id}/activity')
    def activity(task_id:str,after:int=Query(0,ge=0),limit:int=Query(200,ge=1,le=500)):
        db.require_task(task_id)
        return db.all('SELECT * FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?',(task_id,after,limit))

    @app.get('/api/tasks/{task_id}/trace')
    def trace(task_id:str):
        db.require_task(task_id)
        return db.all('SELECT id,run_id,name,arguments,result,status,started_at,finished_at FROM tool_calls WHERE task_id=? ORDER BY started_at',(task_id,))

    @app.get('/api/tasks/{task_id}/audit')
    def audit(task_id:str):
        from .audit import task_audit
        return task_audit(db,task_id)

    @app.get('/api/tasks/{task_id}/tools/{call_id}')
    def inspect_tool(task_id:str,call_id:str):
        from .audit import tool_detail
        return tool_detail(db,task_id,call_id)

    @app.get('/api/mesh-samples')
    def sample_meshes():
        return mesh_samples.items

    @app.get('/api/mesh-samples/{sample_id}/{kind}')
    def sample_mesh_content(sample_id:str,kind:str):
        path,name,digest,media=mesh_samples.content(sample_id,kind)
        return FileResponse(path,filename=name,media_type=media,headers={'ETag':'"'+digest+'"','Cache-Control':'private, no-cache'})

    @app.get('/api/files')
    def files(q:str='',task_id:str|None=None,latest:bool=True):
        where,args=['(a.name LIKE ? OR t.title LIKE ?)'],['%'+q+'%','%'+q+'%']
        if task_id: where.append('a.task_id=?'); args.append(task_id)
        if latest: where.append('a.version=(SELECT MAX(b.version) FROM artifacts b WHERE b.task_id=a.task_id AND b.name=a.name)')
        return db.all('SELECT a.id,a.task_id,a.name,a.version,a.media_type,a.size,a.sha256,a.metadata,a.created_at,t.title AS task_title FROM artifacts a JOIN tasks t ON t.id=a.task_id WHERE '+' AND '.join(where)+' ORDER BY a.created_at DESC LIMIT 300',args)

    @app.get('/api/tasks/{task_id}/artifacts/{artifact_id}')
    def artifact(task_id:str,artifact_id:str):
        row,_=store.get(task_id,artifact_id); row.pop('path'); return row

    @app.get('/api/tasks/{task_id}/artifacts/{artifact_id}/content')
    def artifact_content(task_id:str,artifact_id:str):
        row,path=store.get(task_id,artifact_id)
        # Always attachment; the UI reads trusted generated previews as blobs.
        return FileResponse(path,filename=row['name'],media_type=row['media_type'],headers={'ETag':'"'+row['sha256']+'"','Cache-Control':'private, no-cache'})

    @app.post('/api/tasks/{task_id}/uploads',status_code=201)
    def upload(task_id:str,file:FileStorage=File(...)):
        db.require_task(task_id)
        content=file.read(10*1024*1024+1)
        if len(content)>10*1024*1024: raise HTTPException(413,'Upload exceeds 10 MB')
        name=re.sub(r'[^A-Za-z0-9_.-]','_',Path(file.filename or 'attachment.bin').name)[:120]
        if not name or not name[0].isalnum(): name='file_'+name
        metadata={'kind':'upload','trust':'untrusted'}
        if Path(name).suffix.lower() in ('.png','.jpg','.jpeg','.webp') or (file.mimetype or '').startswith('image/'):
            name,content,metadata=normalize_image(name,content)
        result=store.put(task_id,None,name,content,metadata)
        with db.transaction() as c:
            db.message(c,task_id,None,'user','attachment',{'artifact_id':result['id'],'name':result['name']})
        return result

    @app.post('/api/tasks/{task_id}/image-sets',status_code=201)
    def image_set(task_id:str,data:ImageSetInput):
        db.require_task(task_id)
        return save_image_set(store,task_id,data)

    @app.get('/api/projects')
    def projects(): return db.all('SELECT * FROM projects ORDER BY created_at DESC')

    @app.post('/api/projects',status_code=201)
    def create_project(data:ProjectCreate):
        pid=uid()
        with db.transaction() as c: c.execute('INSERT INTO projects VALUES(?,?,?,?,?)',(pid,data.name,data.brief,data.memory_scope,time.time()))
        return db.one('SELECT * FROM projects WHERE id=?',(pid,))

    @app.get('/api/projects/{project_id}')
    def project(project_id:str):
        result=db.one('SELECT * FROM projects WHERE id=?',(project_id,))
        if not result: raise NotFound('Project not found')
        result['files']=db.all('SELECT id,name,size,created_at FROM project_files WHERE project_id=?',(project_id,))
        return result

    @app.patch('/api/projects/{project_id}')
    def update_project(project_id:str,data:ProjectPatch):
        project(project_id)
        with db.transaction() as c:
            for key,val in data.model_dump(exclude_none=True).items(): c.execute(f'UPDATE projects SET {key}=? WHERE id=?',(val,project_id))
        return project(project_id)

    @app.post('/api/projects/{project_id}/files',status_code=201)
    def project_upload(project_id:str,file:FileStorage=File(...)):
        project(project_id)
        content=file.read(10*1024*1024+1)
        if len(content)>10*1024*1024: raise HTTPException(413,'Upload exceeds 10 MB')
        name=re.sub(r'[^A-Za-z0-9_.-]','_',Path(file.filename or 'reference.txt').name)[:120]
        fid=uid(); rel=Path(project_id)/fid/name; path=settings.data_dir/'project_files'/rel
        path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(content)
        with db.transaction() as c: c.execute('INSERT INTO project_files VALUES(?,?,?,?,?,?)',(fid,project_id,name,str(rel),len(content),time.time()))
        return {'id':fid,'name':name,'size':len(content)}

    @app.get('/api/projects/{project_id}/files/{file_id}')
    def project_download(project_id:str,file_id:str):
        row=db.one('SELECT * FROM project_files WHERE id=? AND project_id=?',(file_id,project_id))
        if not row: raise NotFound('Project file not found')
        root=(settings.data_dir/'project_files').resolve(); path=(root/row['path']).resolve()
        if not path.is_relative_to(root): raise NotFound('Project file unavailable')
        return FileResponse(path,filename=row['name'],media_type='application/octet-stream')

    @app.get('/api/memories')
    def memories(): return db.all('SELECT m.*,t.title FROM memories m JOIN tasks t ON t.id=m.task_id ORDER BY m.created_at DESC LIMIT 100')

    @app.delete('/api/memories/{memory_id}')
    def forget(memory_id:str):
        with db.transaction() as c: c.execute('DELETE FROM memories WHERE id=?',(memory_id,))
        return {'deleted':True}

    @app.get('/api/schedules')
    def schedules(): return db.all('SELECT s.*,t.status AS last_task_status FROM schedules s LEFT JOIN tasks t ON t.id=s.last_task_id ORDER BY s.created_at DESC')

    @app.post('/api/schedules',status_code=201)
    def create_schedule(data:ScheduleCreate):
        sid=uid(); now=time.time()
        with db.transaction() as c: c.execute('INSERT INTO schedules VALUES(?,?,?,?,?,?,?,?)',(sid,data.name,data.prompt,data.interval_minutes,int(data.enabled),now+data.interval_minutes*60,None,now))
        return db.one('SELECT * FROM schedules WHERE id=?',(sid,))

    @app.patch('/api/schedules/{schedule_id}')
    def update_schedule(schedule_id:str,data:SchedulePatch):
        row=db.one('SELECT * FROM schedules WHERE id=?',(schedule_id,))
        if not row: raise NotFound('Schedule not found')
        with db.transaction() as c: c.execute('UPDATE schedules SET enabled=?,next_run_at=? WHERE id=?',(int(data.enabled),time.time()+row['interval_minutes']*60,schedule_id))
        return db.one('SELECT * FROM schedules WHERE id=?',(schedule_id,))

    @app.post('/api/schedules/{schedule_id}/run',status_code=201)
    def run_schedule(schedule_id:str):
        # Run a job once now; a paused job stays paused and an enabled one keeps its next time.
        with db.transaction() as c:
            row=c.execute('SELECT * FROM schedules WHERE id=?',(schedule_id,)).fetchone()
            if not row: raise NotFound('Schedule not found')
            tid=start_job(db,c,row)
        return db.detail(tid)

    @app.get('/api/rules')
    def rules(): return db.all('SELECT r.*,p.name AS project_name FROM rules r LEFT JOIN projects p ON p.id=r.project_id ORDER BY r.created_at')

    @app.post('/api/rules',status_code=201)
    def create_rule(data:RuleCreate):
        if data.project_id and not db.one('SELECT 1 FROM projects WHERE id=?',(data.project_id,)): raise NotFound('Project not found')
        rid=uid()
        with db.transaction() as c:
            c.execute('INSERT INTO rules(id,content,project_id,enabled,created_at,rule_set,applies_when,level) VALUES(?,?,?,?,?,?,?,?)',
                      (rid,encode(data.content.strip()),data.project_id,1,time.time(),data.rule_set.strip(),data.applies_when.strip(),data.level))
            # One applies-when description per set: the newest wording updates the whole set.
            if data.rule_set.strip() and data.applies_when.strip():
                c.execute('UPDATE rules SET applies_when=? WHERE rule_set=?',(data.applies_when.strip(),data.rule_set.strip()))
        return db.one('SELECT r.*,p.name AS project_name FROM rules r LEFT JOIN projects p ON p.id=r.project_id WHERE r.id=?',(rid,))

    @app.patch('/api/rules/{rule_id}')
    def update_rule(rule_id:str,data:RulePatch):
        if not db.one('SELECT 1 FROM rules WHERE id=?',(rule_id,)): raise NotFound('Rule not found')
        with db.transaction() as c:
            if data.enabled is not None: c.execute('UPDATE rules SET enabled=? WHERE id=?',(int(data.enabled),rule_id))
            if data.content is not None: c.execute('UPDATE rules SET content=? WHERE id=?',(encode(data.content.strip()),rule_id))
            if data.level is not None: c.execute('UPDATE rules SET level=? WHERE id=?',(data.level,rule_id))
            if data.rule_set is not None: c.execute('UPDATE rules SET rule_set=? WHERE id=?',(data.rule_set.strip(),rule_id))
            if data.applies_when is not None:
                current=db.one('SELECT rule_set FROM rules WHERE id=?',(rule_id,))['rule_set']
                c.execute('UPDATE rules SET applies_when=? WHERE id=? OR (rule_set!=\'\' AND rule_set=?)',(data.applies_when.strip(),rule_id,current))
        return db.one('SELECT r.*,p.name AS project_name FROM rules r LEFT JOIN projects p ON p.id=r.project_id WHERE r.id=?',(rule_id,))

    @app.get('/api/integrations/bambu')
    def bambu_status():
        from .bambu import Store, status
        return status(Store(settings.data_dir))

    @app.get('/api/integrations/bambu/profiles')
    def bambu_profiles(machine:str=Query('',max_length=120)):
        from .bambu import catalog
        return catalog(machine or None)

    @app.put('/api/integrations/bambu')
    def bambu_save(data:BambuSettings):
        from .bambu import Store, status
        Store(settings.data_dir).save(data)
        return status(Store(settings.data_dir))

    @app.post('/api/tasks/{task_id}/slice',status_code=201)
    def slice_task_build(task_id:str,build_id:str=Query('',max_length=64)):
        from .bambu import Store, slice_build
        db.require_task(task_id)
        return slice_build(db,store,Store(settings.data_dir),task_id,None,build_id or None,
                           settings.data_dir/'workspaces'/task_id/'slices')

    @app.post('/api/tasks/{task_id}/artifacts/{artifact_id}/open-in-bambu')
    def open_in_bambu(task_id:str,artifact_id:str):
        from .bambu import APP, binary
        row,path=store.get(task_id,artifact_id)
        if not row['name'].endswith(('.3mf','.stl')): raise ValueError('Open a 3MF project or STL in Bambu Studio')
        if not binary(): raise ValueError('Bambu Studio is not installed on this computer')
        import subprocess, sys as _sys
        if _sys.platform!='darwin': raise ValueError('Opening Bambu Studio from 6B is supported on macOS')
        subprocess.Popen(['open','-a',str(APP),str(path)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        return {'opened':row['name']}

    @app.get('/api/rules/templates')
    def rule_templates():
        from .rules import TEMPLATES
        return [{'id':k,'name':t['name'],'applies_when':t['applies_when'],'source':t['source'],'count':len(t['rules'])} for k,t in TEMPLATES.items()]

    @app.post('/api/rules/templates/{template_id}',status_code=201)
    def add_rule_template(template_id:str,project_id:str=Query('',max_length=100)):
        from .rules import add_template
        if project_id and not db.one('SELECT 1 FROM projects WHERE id=?',(project_id,)): raise NotFound('Project not found')
        return add_template(db,template_id,project_id or None)

    @app.get('/api/tasks/{task_id}/rules')
    def task_rule_sets(task_id:str):
        from .rules import task_rules
        return task_rules(db,task_id)

    @app.put('/api/tasks/{task_id}/rules')
    def decide_task_rules(task_id:str,data:RuleSetUserDecision):
        from .rules import choose, task_rules
        db.require_task(task_id)
        choose(db,task_id,None,[{'rule_set':data.rule_set,'apply':data.apply,'reason':data.reason or ('Applied by the user' if data.apply else 'Not needed, per the user')}],'user')
        return task_rules(db,task_id)

    @app.delete('/api/rules/{rule_id}')
    def delete_rule(rule_id:str):
        with db.transaction() as c: c.execute('DELETE FROM rules WHERE id=?',(rule_id,))
        return {'deleted':True}

    if settings.frontend_dir.is_dir():
        # Resolve per request so rebuilding the React client does not require a
        # backend restart. Only Vite's output directory is exposed to the browser.
        def frontend_file(filename):
            build_dir = settings.frontend_dir / 'dist'
            if not (build_dir / 'index.html').is_file():
                return Response('Frontend is not built. Run npm --prefix frontend ci && npm --prefix frontend run build.', status=503, mimetype='text/plain')
            response = send_from_directory(build_dir, filename)
            response.headers['Cache-Control'] = 'no-cache' if filename.endswith('.html') else 'public, max-age=31536000, immutable'
            return response
        app.add_url_rule('/assets/<path:filename>', 'assets', lambda filename:frontend_file('assets/' + filename))
        @app.get('/')
        def index(): return frontend_file('index.html')
        @app.get('/docs',include_in_schema=False)
        def api_docs(): return frontend_file('docs.html')
        @app.get('/docs.html',include_in_schema=False)
        def api_docs_html(): return frontend_file('docs.html')
    return app
