"""Browser-held model connections for hosted 6B (6B_HOSTED=1).

Each browser keeps its provider, model and API key and sends them as headers. The key
travels only with requests that queue a run; the server holds it in memory, keyed by
task, until that task has no queued or running work. It is never written to SQLite,
events, session files or logs, and a restart forgets it.
"""
from contextlib import contextmanager
from dataclasses import dataclass
import re
import threading
import time
from urllib.parse import quote
import httpx
from .config import CONNECTION, PROVIDERS

PROVIDER_HEADER, MODEL_HEADER, KEY_HEADER = 'X-6B-Provider', 'X-6B-Model', 'X-6B-Key'
MODEL_PATTERN = re.compile(r'^[A-Za-z0-9._:\-\[\]/]{0,120}$')
NO_KEY = 'Add your API key in Integrations → Model provider, then try again.'


@dataclass(frozen=True)
class Connection:
    provider: str
    model: str = ''
    key: str = ''

    def __repr__(self):
        # Never let a key reach a log line or traceback through repr().
        return f'Connection(provider={self.provider!r}, model={self.model!r}, key={"set" if self.key else "none"})'

    def fields(self, with_key=True):
        key = self.key if with_key else ''
        if self.provider == 'claude':
            return {'provider':'claude', 'claude_model':self.model, 'anthropic_api_key':key, 'model':'', 'api_key':'', 'openai_plan':False}
        if self.provider in ('openai', 'chatgpt'):
            # "chatgpt" is the OpenAI Responses API paid by the user's ChatGPT plan (OAuth token as key).
            return {'provider':'openai', 'model':self.model, 'api_key':key, 'claude_model':'', 'anthropic_api_key':'',
                    'openai_plan':self.provider == 'chatgpt'}
        return {'provider':'workshop', 'model':'', 'api_key':'', 'claude_model':'', 'anthropic_api_key':'', 'openai_plan':False}


WORKSHOP = Connection('workshop')


def from_headers(headers, with_key=False):
    """The browser's connection, or the workshop when it sends none."""
    provider = headers.get(PROVIDER_HEADER, '').strip()
    if not provider: return WORKSHOP
    if provider not in (*PROVIDERS, 'chatgpt'): raise ValueError('Unknown model provider')
    if provider == 'workshop': return WORKSHOP
    model = headers.get(MODEL_HEADER, '').strip()
    if not MODEL_PATTERN.fullmatch(model): raise ValueError('Invalid model name')
    if provider == 'chatgpt':
        # The token stays on the server; the caller resolves it from the browser's sign-in cookie.
        if with_key and not model: raise ValueError('Choose a ChatGPT model in Integrations, then try again.')
        return Connection('chatgpt', model)
    key = headers.get(KEY_HEADER, '').strip() if with_key else ''
    if len(key) > 300: raise ValueError('API key is too long')
    if with_key and not key: raise ValueError(NO_KEY)
    if with_key and provider == 'openai' and not model: raise ValueError('Choose an OpenAI model in Integrations, then try again.')
    return Connection(provider, model, key)


@contextmanager
def using(connection, with_key=True):
    token = CONNECTION.set(connection.fields(with_key))
    try: yield
    finally: CONNECTION.reset(token)


class KeyVault:
    """task id -> Connection, in process memory only."""
    # A safety net: entries are normally dropped as soon as a task goes idle.
    TTL = 6*3600

    def __init__(self):
        self.lock, self.items = threading.Lock(), {}

    def put(self, task_id, connection):
        with self.lock:
            now = time.monotonic()
            self.items = {k:v for k,v in self.items.items() if v[1] > now}
            self.items[task_id] = (connection, now+self.TTL)

    def get(self, task_id):
        with self.lock:
            item = self.items.get(task_id)
            return item[0] if item and item[1] > time.monotonic() else None

    def forget(self, task_id):
        with self.lock: self.items.pop(task_id, None)


async def verify(provider, model='', key='', transport=None):
    """Live key check that costs no tokens: list the account's models."""
    if provider == 'workshop':
        return {'ok':True, 'message':'The workshop runs offline; no account is needed.'}
    if not key.strip(): return {'ok':False, 'message':'Paste your API key first.'}
    if provider == 'openai' and not model.strip():
        return {'ok':False, 'message':'Enter a Responses API model available to your OpenAI account.'}
    if provider == 'claude':
        url, headers = 'https://api.anthropic.com/v1/models', {'x-api-key':key.strip(), 'anthropic-version':'2023-06-01'}
    else:
        url, headers = 'https://api.openai.com/v1/models/'+quote(model.strip(), safe=''), {'Authorization':'Bearer '+key.strip()}
    try:
        async with httpx.AsyncClient(transport=transport, timeout=httpx.Timeout(20, connect=10), trust_env=False) as client:
            response = await client.get(url, headers=headers)
    except httpx.HTTPError:
        return {'ok':False, 'message':'Could not reach the model service; try again.'}
    name = 'Anthropic' if provider == 'claude' else 'OpenAI'
    if response.status_code in (401, 403):
        return {'ok':False, 'message':f'{name} rejected this API key.'}
    if response.status_code == 404 and provider == 'openai':
        return {'ok':False, 'message':f'This key cannot use the model “{model.strip()}”.'}
    if response.is_error:
        return {'ok':False, 'message':f'{name} returned HTTP {response.status_code}; try again later.'}
    return {'ok':True, 'message':f'{name} accepted the key. It stays in this browser and is sent only when a task runs.'}
