"""Claude Code drives the typed engineering tools through an in-process MCP server.

The Claude Agent SDK starts the Claude Code CLI with every built-in tool removed and
no user settings, hooks, plugins, skills or MCP servers loaded. The only capabilities
are the 6b_* application tools; SQLite remains the durable source of truth.
"""
import asyncio
import base64
import json
import os
from pathlib import Path
import shutil
import time
from .agent_context import compact_result, task_context
from .db import encode, uid
from .provider import ProviderError
from .tools import review_image, tool_definitions, unresolved_error
from .completion import check_completion

SERVER = '6b'
PREFIX = f'mcp__{SERVER}__'
# Variables the CLI needs to find its login, config and network. Everything else
# inherited by the backend (API keys, Onshape secrets, the local API token) is blanked.
ENV_KEEP = {'HOME','PATH','USER','LOGNAME','TMPDIR','LANG','LC_ALL','SHELL','SSL_CERT_FILE','SSL_CERT_DIR',
            'HTTPS_PROXY','HTTP_PROXY','NO_PROXY','https_proxy','http_proxy','no_proxy'}


def find_claude(configured=''):
    """Configured path, then `claude` on PATH, then the CLI bundled with the SDK."""
    path = configured or shutil.which('claude')
    if not path:
        try:
            import claude_agent_sdk
            bundled = Path(claude_agent_sdk.__file__).parent/'_bundled'/'claude'
            if bundled.is_file(): path = str(bundled)
        except ImportError:
            raise ProviderError('Claude Agent SDK is not installed; run ./install.sh') from None
    if not path or not Path(path).is_file():
        raise ProviderError('Claude Code executable not found; install Claude Code or set 6B_CLAUDE_BINARY')
    return str(Path(path).resolve())


def claude_env(settings):
    env = {k:'' for k in os.environ if k not in ENV_KEEP and not k.startswith(('CLAUDE_','LC_','XDG_'))}
    # An empty key keeps the CLI on the signed-in subscription login.
    env.pop('ANTHROPIC_API_KEY',None)
    if settings.anthropic_api_key: env['ANTHROPIC_API_KEY'] = settings.anthropic_api_key
    elif 'ANTHROPIC_API_KEY' in os.environ: env['ANTHROPIC_API_KEY'] = ''
    if settings.claude_home:
        # Hosted: a private, throwaway home so no login or CLI state is shared between runs.
        env['HOME'] = env['CLAUDE_CONFIG_DIR'] = settings.claude_home
    return env


async def auth_status(settings):
    """Read-only sign-in check; never starts a model session or spends tokens."""
    binary = find_claude(settings.claude_binary)
    env = {**{k:v for k,v in os.environ.items() if k in ENV_KEEP or k.startswith(('CLAUDE_','LC_','XDG_'))}, **{k:v for k,v in claude_env(settings).items() if v}}
    process = await asyncio.create_subprocess_exec(binary,'auth','status','--json',stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,stdin=asyncio.subprocess.DEVNULL,env=env,start_new_session=True)
    try: out,_ = await asyncio.wait_for(process.communicate(),20)
    except asyncio.TimeoutError:
        process.kill(); await process.wait()
        raise ProviderError('Claude Code did not answer the sign-in check') from None
    try: status = json.loads(out)
    except ValueError: raise ProviderError('Claude Code returned an unreadable sign-in status') from None
    if settings.anthropic_api_key and not status.get('loggedIn'):
        # `auth status` reports OAuth logins; an API key alone is also a valid connection.
        status = {**status, 'loggedIn':True, 'authMethod':'api_key'}
    return {'binary':binary, 'logged_in':bool(status.get('loggedIn')), 'auth_method':status.get('authMethod'),
            'email':status.get('email'), 'organization':status.get('orgName') or status.get('organization'),
            'subscription':status.get('subscriptionType')}


def instructions_text():
    prompt_dir = Path(__file__).parent/'prompts'
    text = '\n\n'.join((prompt_dir/x).read_text() for x in ('orchestrator.md','communication.md'))
    return text+f'''\nYou are embedded in 6B. Use only the supplied 6B tools ({PREFIX}*).
Tool names in these instructions omit that prefix: update_plan means {PREFIX}update_plan.
No shell, filesystem, web or other built-in tools exist. Every action must flow through
the application tools so the UI, database and validation agree.
Use update_plan for the visible plan. Saved answered questions are binding
choices until the current user changes them. Do not repeat answered questions.
When ask_questions or request_approval succeeds, stop: the application
resumes after the user answers. A decided approval in context is binding: build exactly
the approved plan, or revise the plan when changes were requested.
Reuse artifact names on revisions so the application creates new versions. Read
the previous construction JSON to preserve unchanged geometry. Load the relevant
workflows and inspect the latest validation report before delivering a CAD build.
Package only the current valid revision. Update all checklist items on completion.
You cannot access other chats except through the explicitly scoped search tool.
'''


def default_client(options):
    from claude_agent_sdk import ClaudeSDKClient
    return ClaudeSDKClient(options)


async def available_models(settings, client_factory=default_client):
    """Models the signed-in account can use, from Claude Code's startup handshake; spends no tokens."""
    from claude_agent_sdk import ClaudeAgentOptions
    client = client_factory(ClaudeAgentOptions(tools=[], setting_sources=[], plugins=[],
                                               cli_path=find_claude(settings.claude_binary), env=claude_env(settings)))
    try:
        await asyncio.wait_for(client.connect(), 30)
        info = await client.get_server_info() or {}
    except asyncio.TimeoutError: raise ProviderError('Claude Code did not list its models') from None
    finally: await client.disconnect()
    # "default" is the account default, which 6B saves as no model at all.
    return [{'id':'', 'name':'Account default', 'description':m.get('description') or ''} if m['value']=='default' else
            {'id':m['value'], 'name':m.get('displayName') or m['value'],
             'description':m.get('description') or ''} for m in info.get('models', []) if m.get('value')]


def count_usage(state, counted, message):
    """Add one API response's usage once.

    The SDK emits an AssistantMessage per content block (thinking, each tool call), each
    repeating its response's usage, so usage is keyed by message id and only growth is added.
    The run budget counts fresh tokens; cache reads re-read context at a tenth of the price
    and are reported in the total only.
    """
    usage=message.usage or {}
    fresh=sum(usage.get(k) or 0 for k in ('input_tokens','output_tokens','cache_creation_input_tokens'))
    cached=usage.get('cache_read_input_tokens') or 0
    key=getattr(message,'message_id',None) or id(message)
    old_fresh,old_cached=counted.get(key,(0,0))
    fresh,cached=max(fresh,old_fresh),max(cached,old_cached)
    counted[key]=(fresh,cached)
    state['fresh']+=fresh-old_fresh
    state['total']+=fresh+cached-old_fresh-old_cached


MAX_STEERS = 2
STEER = ('6B interrupted your last response: it reasoned for several minutes without calling a tool. '
         'Do not work out the whole design in one pass. Make the next tool call now: build the simplest version '
         'that meets the brief, inspect it, then refine it in small steps. Put calculations in the CAD script as '
         'named parameters and checks instead of long mental arithmetic. Continue from the saved plan and files.')


async def run_claude(engine, run, client_factory=default_client):
    from claude_agent_sdk import (AssistantMessage, ClaudeAgentOptions, ResultMessage, SystemMessage,
                                  TextBlock, ToolAnnotations, ToolUseBlock, create_sdk_mcp_server, tool)
    settings,db=engine.settings,engine.db
    tid,rid=run['task_id'],run['id']
    workspace=settings.data_dir/'workspaces'/tid
    workspace.mkdir(parents=True,exist_ok=True)
    checkpoint=run['checkpoint'] or {}
    unresolved=checkpoint.get('unresolved_errors',{})
    prior_tokens=checkpoint.get('total_tokens',0)
    state={'count':checkpoint.get('tool_calls',0),'total':prior_tokens,'fresh':checkpoint.get('fresh_tokens',prior_tokens),
           'pause':None,'abort':None,'calls':0,'busy':0,'progress':time.monotonic()}
    counted={}
    repairs=checkpoint.get('completion_repairs',0)
    # Each resume is a fresh provider session over saved application state.
    session_id=uid()
    deadline=time.monotonic()+settings.claude_timeout

    def make_tool(name, spec):
        async def handler(args):
            if state['pause']:
                return {'content':[{'type':'text','text':encode({'error':'Execution paused for the user; defer this call until they respond'})}],'is_error':True}
            state['count']+=1; state['calls']+=1
            if state['count']>settings.max_tool_calls:
                # A handler exception would only become a tool error; the run loop fails closed.
                state['abort']='Claude tool-call budget reached'
                return {'content':[{'type':'text','text':encode({'error':state['abort']})}],'is_error':True}
            state['busy']+=1
            try: result=await engine.runner.execute(tid,rid,f'{session_id}:{state["calls"]}',name,args,deadline=deadline)
            finally: state['busy']-=1; state['progress']=time.monotonic()
            if (error:=unresolved_error(result)): unresolved[name]=error
            else: unresolved.pop(name,None)
            content=[{'type':'text','text':encode(compact_result(result))}]
            image=review_image(name,result)
            if image:
                _,path=engine.runner.store.get(tid,image)
                content.append({'type':'image','data':base64.b64encode(path.read_bytes()).decode(),'mimeType':'image/png'})
                if name!='inspect_image': db.emit(tid,rid,'image.inspected',{'artifact_id':image,'automatic':True})
            saved={'provider':'claude','tool_calls':state['count'],'total_tokens':state['total'],'fresh_tokens':state['fresh'],'unresolved_errors':unresolved,'completion_repairs':repairs}
            if name in ('ask_questions','request_approval') and isinstance(result,dict) and (result.get('questionnaire_id') or result.get('approval_id')):
                state['pause']=True
                saved['questionnaire_id' if name=='ask_questions' else 'approval_id']=result.get('questionnaire_id') or result['approval_id']
            db.checkpoint(rid,saved)
            return {'content':content,'is_error':bool(isinstance(result,dict) and result.get('error'))}
        # Results stay inline: the model has no file tool to open a persisted preview.
        return tool(name,spec['description'],spec['parameters'],annotations=ToolAnnotations(maxResultSizeChars=400000))(handler)

    tools=[make_tool(x['name'],x) for x in tool_definitions(settings)]
    options=ClaudeAgentOptions(
        tools=[], mcp_servers={SERVER:create_sdk_mcp_server(SERVER,'0.2.0',tools)}, strict_mcp_config=True,
        allowed_tools=[PREFIX+t.name for t in tools], permission_mode='dontAsk',
        setting_sources=[], plugins=[], system_prompt=instructions_text(),
        model=settings.claude_model or None, cwd=str(workspace), cli_path=find_claude(settings.claude_binary),
        env=claude_env(settings), max_turns=settings.max_tool_calls+10,
        # Build results carry the six-view review render inline; the SDK's 1 MB default is too small.
        max_buffer_size=32*1024*1024,
        effort=settings.reasoning_effort if settings.reasoning_effort in ('low','medium','high','xhigh','max') else None)
    client=client_factory(options)
    queue=asyncio.Queue()

    async def pump():
        try:
            async for message in client.receive_messages(): await queue.put(message)
        except Exception as exc: await queue.put(exc)
        finally: await queue.put(None)

    await client.connect()
    reader=None
    try:
        reader=asyncio.create_task(pump())
        from .sessions import SessionLog
        log=SessionLog(settings.data_dir,tid,rid)
        prompt='Execute the current task using this saved application context:\n'+task_context(engine,run)
        log.write('sent',{'prompt':prompt})
        await client.query(prompt)
        model=settings.claude_model or 'Claude Code default'
        final_text=''
        steering,steers=False,0
        while time.monotonic()<deadline:
            engine.runner.check_cancel(rid)
            if state['abort']: raise ProviderError(state['abort'])
            if state['fresh']>=settings.max_run_tokens: raise ProviderError('Claude run token budget reached')
            quiet=time.monotonic()-state['progress']
            if not steering and not state['busy'] and not state['pause'] and quiet>settings.claude_stall_seconds:
                # Adaptive thinking has no per-response cap; a response that reasons for minutes
                # without acting is stopped and redirected instead of running out the deadline.
                if steers>=MAX_STEERS:
                    raise ProviderError('Claude kept reasoning without using a tool; saved work is retained for explicit retry')
                steering=True; steers+=1
                minutes=round(quiet/60)
                db.emit(tid,rid,'activity',{'title':'Long reasoning interrupted',
                    'detail':f'No tool call for {minutes} minutes. Asked Claude to build and check a first version, then refine it.'})
                log.write('interrupt',{'quiet_seconds':round(quiet)})
                await client.interrupt()
                continue
            try: message=await asyncio.wait_for(queue.get(),.3)
            except asyncio.TimeoutError: continue
            if message is None: raise ProviderError('Claude Code disconnected before task completion')
            if isinstance(message,Exception): raise ProviderError('Claude Code connection failed: '+str(message)[:500])
            log.write('received',message)
            if not isinstance(message,SystemMessage): state['progress']=time.monotonic()
            if isinstance(message,SystemMessage) and message.subtype=='init':
                model=message.data.get('model') or model
                db.emit(tid,rid,'provider.connected',{'provider':'claude','model':model,'session_id':message.data.get('session_id'),'ephemeral':True})
            elif isinstance(message,AssistantMessage):
                if message.error: raise ProviderError('Claude Code reported '+str(message.error)+'; check sign-in, plan limits or model access')
                texts=[b.text for b in message.content if isinstance(b,TextBlock) and b.text.strip()]
                uses=[b for b in message.content if isinstance(b,ToolUseBlock)]
                if any(not b.name.startswith(PREFIX) for b in uses):
                    raise ProviderError('Claude attempted an operation outside the registered engineering tools')
                if texts and uses: db.emit(tid,rid,'activity',{'title':'Claude update','detail':'\n'.join(texts)[:1500]})
                elif texts: final_text='\n'.join(texts)
                count_usage(state,counted,message)
                with db.transaction() as c:
                    c.execute('UPDATE runs SET usage=? WHERE id=?',(encode({'provider':'claude','model':message.model or model,'total_tokens':state['total'],
                                                                           'fresh_tokens':state['fresh'],'tool_calls':state['count']}),rid))
                    db.event(c,tid,rid,'usage.updated',{'total_tokens':state['total'],'tool_calls':state['count']})
            elif isinstance(message,ResultMessage):
                if state['pause']:
                    db.finish(rid,'awaiting_input')
                    return
                if steering:
                    # The interrupted turn ends here; the same session continues with the steer.
                    steering=False; final_text=''
                    log.write('sent',{'prompt':STEER})
                    await client.query(STEER)
                    state['progress']=time.monotonic()
                    continue
                if message.is_error:
                    raise ProviderError('Claude Code turn ended with '+message.subtype+'; saved artifacts remain available')
                final_text=final_text or (message.result or '')
                errors=check_completion(engine,run,unresolved,final_text,repairs)
                if errors:
                    if repairs>=3: raise ProviderError('Completion checks failed: '+'; '.join(errors))
                    repairs+=1
                    db.emit(tid,rid,'activity',{'title':'Completion checks require repair','detail':'; '.join(errors)})
                    final_text=''
                    repair='The backend has blocked completion. Repair these issues using the tools, then summarize the actual result:\n'+'\n'.join(errors)
                    log.write('sent',{'prompt':repair})
                    await client.query(repair)
                    continue
                engine.complete_message(run,final_text)
                db.finish(rid,'completed')
                return
            if state['pause']:
                # The questionnaire or approval is saved; stop the model's turn here.
                await client.interrupt()
                db.finish(rid,'awaiting_input')
                return
        raise ProviderError('Claude run deadline reached; saved work is retained for explicit retry')
    finally:
        if reader: reader.cancel(); await asyncio.gather(reader,return_exceptions=True)
        await client.disconnect()
