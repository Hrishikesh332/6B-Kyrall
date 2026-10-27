"""Read-only access to the configured Isaac MCP. No motion or stop-latch operations."""
import base64
import json
import os
import re
import select
import shlex
import subprocess
import time

READ_TOOLS = {'franka_observe', 'franka_task_status', 'franka_snapshot'}


def configured(settings):
    return bool(settings.isaac_ssh_host and settings.isaac_container and settings.isaac_python and settings.isaac_mcp_path)


def read_isaac(settings, tool):
    if tool not in READ_TOOLS:
        raise ValueError('Only Isaac observation, task status and snapshots are allowed')
    if not configured(settings):
        raise ValueError('Isaac connector is not configured')
    for value in (settings.isaac_ssh_host, settings.isaac_container):
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,100}', value):
            raise ValueError('Invalid operator-configured Isaac host or container')
    remote = shlex.join(['docker', 'exec', '-i', settings.isaac_container,
                         settings.isaac_python, settings.isaac_mcp_path])
    command = ['/usr/bin/ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
               '-o', 'ForwardAgent=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
               settings.isaac_ssh_host, remote]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    pending = bytearray()
    deadline = time.monotonic() + 25

    def send(message):
        process.stdin.write((json.dumps({'jsonrpc':'2.0', **message})+'\n').encode())
        process.stdin.flush()

    def receive(identity):
        while time.monotonic() < deadline:
            while b'\n' in pending:
                line, _, tail = pending.partition(b'\n'); pending[:] = tail
                try: message = json.loads(line)
                except ValueError: continue
                if message.get('id') == identity:
                    if 'error' in message: raise ValueError('Isaac connector rejected the read request')
                    return message['result']
            if not select.select([process.stdout], [], [], min(.5, max(0,deadline-time.monotonic())))[0]: continue
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk: raise ValueError('Isaac connector disconnected; check the running Brev instance')
            pending.extend(chunk)
            if len(pending) > 16_000_000: raise ValueError('Isaac response exceeds the read limit')
        raise ValueError('Isaac observation timed out; the scene may be busy or unreachable')

    try:
        send({'id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'6b-observer','version':'1.0'}}})
        receive(1)
        send({'method':'notifications/initialized'})
        send({'id':2,'method':'tools/call','params':{'name':tool,'arguments':{}}})
        result = receive(2)
        if result.get('isError'):
            detail = (result.get('structuredContent') or {}).get('error')
            raise ValueError('Isaac: '+str(detail)[:240] if detail else 'Isaac could not read the current scene')
        return result
    finally:
        process.terminate()
        try: process.wait(timeout=2)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
        process.stdin.close(); process.stdout.close()


def observation(settings):
    result = read_isaac(settings, 'franka_observe')
    data = result.get('structuredContent')
    if data is None:
        text = next((c['text'] for c in result.get('content',[]) if c.get('type')=='text'), '{}')
        data = json.loads(text)
    if not isinstance(data,dict) or data.get('scope') != 'simulation' or data.get('hardware_connected') is not False:
        raise ValueError('The connector did not identify a simulation-only environment')
    return {'configured': True, 'connected': True, 'observed_at': time.time(), 'state': data,
            'design_validation': 'unlinked',
            'scope': 'Existing Isaac scene only. This observation does not validate the open CAD design.'}


def snapshot(settings):
    result = read_isaac(settings, 'franka_snapshot')
    block = next((c for c in result.get('content',[]) if c.get('type')=='image'), None)
    if not block or block.get('mimeType') not in ('image/png','image/jpeg'):
        raise ValueError('Isaac did not return a supported viewport image')
    pixels = base64.b64decode(block['data'], validate=True)
    if len(pixels) > 10_000_000: raise ValueError('Viewport image exceeds 10 MB')
    return pixels, block['mimeType']
