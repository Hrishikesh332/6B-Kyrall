"""Model connection chosen in the app: Claude Code, the Responses API or the offline workshop.

backend/.env sets the starting provider. A connection chosen from the app is saved in
the local data folder and wins on later starts, so each deployment picks its own
account without editing files. Secrets are owner-only on disk and never returned.
"""
import asyncio
import dataclasses
import json
import os
import shlex
import shutil
import time
from typing import Literal
from pydantic import Field
from .config import MODEL_PROVIDERS, PROVIDERS
from .models import StrictModel
from .provider import ProviderError

NAMES = {'claude':'Claude Code', 'openai':'OpenAI API', 'workshop':'Local workshop'}
# CLI aliases always resolve to the newest model of each family for the signed-in account.
CLAUDE_MODELS = [{'id':'', 'name':'Account default'}, {'id':'opus', 'name':'Opus (latest)'},
                 {'id':'sonnet', 'name':'Sonnet (latest)'}, {'id':'haiku', 'name':'Haiku (latest)'}]


class ConnectionInput(StrictModel):
    provider: Literal['workshop', 'openai', 'claude']
    model: str = Field(default='', max_length=120, pattern=r'^[A-Za-z0-9._:\-\[\]/]*$')
    # Optional Anthropic Console key for Claude Code when no subscription login is used.
    anthropic_api_key: str = Field(default='', max_length=300)


class ModelChoice(StrictModel):
    model: str = Field(default='', max_length=120, pattern=r'^[A-Za-z0-9._:\-\[\]/]*$')


class ConnectionCheck(StrictModel):
    provider: Literal['workshop', 'openai', 'claude']
    # Hosted 6B checks the browser's own key; it is used for this check only.
    model: str = Field(default='', max_length=120, pattern=r'^[A-Za-z0-9._:\-\[\]/]*$')
    api_key: str = Field(default='', max_length=300)


class ConnectionStore:
    def __init__(self, data_dir):
        self.path = data_dir/'integrations'/'model.json'

    def load(self):
        if not self.path.is_file(): return {}
        try: return json.loads(self.path.read_text())
        except ValueError: return {}

    def save(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix('.tmp')
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as f: json.dump(data, f)
        os.replace(tmp, self.path)


class Connections:
    def __init__(self, settings):
        self.settings, self.store = settings, ConnectionStore(settings.data_dir)
        # Values from backend/.env stay the fallback for anything not chosen in the app.
        self.listed = {}
        self.defaults = {'provider':settings.provider, 'model':settings.model,
                         'claude_model':settings.claude_model, 'anthropic_api_key':settings.anthropic_api_key}
        # Hosted 6B never uses a connection saved on the server: each browser brings its own.
        if not settings.hosted: self.apply(self.store.load())

    def apply(self, saved):
        s, d = self.settings, self.defaults
        provider = saved.get('provider') if saved.get('provider') in PROVIDERS else d['provider']
        models = saved.get('models', {}) if saved.get('provider') in PROVIDERS else {}
        s.provider = provider
        s.model = models.get(provider) or d['model'] if provider=='openai' else d['model']
        s.claude_model = models.get('claude') or d['claude_model']
        s.anthropic_api_key = d['anthropic_api_key'] or saved.get('anthropic_api_key', '')

    def claude_models(self):
        """Claude Code's own list for this account, kept 10 minutes; the CLI aliases when it cannot answer."""
        s = self.settings
        # Hosted lists carry no key (GET requests never send it), so they could not reflect the account.
        if s.hosted: return CLAUDE_MODELS
        hit = self.listed.get(bool(s.anthropic_api_key))
        if hit and time.time()-hit[0] < 600: return hit[1]
        from .claude_code import available_models
        try: models = asyncio.run(available_models(s))
        except Exception: return CLAUDE_MODELS
        if not models: return CLAUDE_MODELS
        self.listed[bool(s.anthropic_api_key)] = (time.time(), models)
        return models

    def choose(self, model):
        """Switch the active connection's model; the sign-in is unchanged, so no live check is needed."""
        s = self.settings
        if s.provider not in MODEL_PROVIDERS: raise ValueError('The local workshop has no model to choose')
        if s.provider=='openai' and not model: raise ValueError('Choose an OpenAI model')
        saved = self.store.load()
        saved.update(provider=s.provider, models={**saved.get('models',{}), s.provider:model}, changed_at=time.time())
        self.store.save(saved)
        self.apply(saved)
        return self.overview()

    def source(self):
        if self.settings.hosted: return 'browser'
        return 'workspace' if self.store.load().get('provider') in PROVIDERS else 'environment'

    def overview(self):
        s = self.settings
        saved = {} if s.hosted else self.store.load()
        return {'hosted':s.hosted,
                'active':{'provider':s.provider, 'name':'ChatGPT plan' if s.openai_plan else NAMES[s.provider], 'plan':s.openai_plan,
                          'source':self.source(),
                          'model':s.claude_model if s.provider=='claude' else s.model, 'changed_at':saved.get('changed_at')},
                'providers':[self.describe(p) for p in ('claude','workshop','openai')]}

    @staticmethod
    def command(binary, name, args):
        # A CLI found outside PATH (bundled in an app or package) needs its full path.
        found = shutil.which(name)
        on_path = found and os.path.realpath(found)==binary
        return (name if on_path else shlex.quote(binary))+' '+args

    def describe(self, provider):
        """Cheap local detection only; `check` performs the live sign-in check."""
        s = self.settings
        item = {'id':provider, 'name':NAMES[provider], 'active':s.provider==provider}
        if provider=='claude':
            from .claude_code import find_claude
            try:
                binary = find_claude(s.claude_binary)
                item.update(installed=True, binary=binary, sign_in=self.command(binary, 'claude', 'auth login'))
            except ProviderError as exc: item.update(installed=False, error=str(exc), sign_in='claude auth login')
            item.update(model=s.claude_model, models=CLAUDE_MODELS, api_key_saved=False if s.hosted else bool(self.store.load().get('anthropic_api_key')),
                        api_key_from_environment=bool(self.defaults['anthropic_api_key']),
                        install='https://docs.claude.com/en/docs/claude-code/setup',
                        detail='Runs Claude Code with your Anthropic Console API key, kept in this browser.' if s.hosted else
                        'Uses the Claude account signed in to Claude Code on this computer (Pro, Max, Team or Enterprise), or an Anthropic Console API key.')
        elif provider=='openai':
            item.update(installed=True, model=s.model if s.provider=='openai' else self.defaults['model'],
                        api_key_set=bool(s.api_key),
                        detail='Calls the OpenAI Responses API with your API key, kept in this browser.' if s.hosted else
                        'Calls the OpenAI Responses API with OPENAI_API_KEY and 6B_MODEL from backend/.env.')
        else:
            item.update(installed=True, detail='Built-in recipes for the marker organizer and mounting plate. No model or account.')
        return item

    async def check(self, provider, model='', api_key=''):
        s = self.settings
        if provider=='workshop':
            return {'ok':True, 'message':'The workshop runs offline; no account is needed.'}
        if provider=='openai':
            if not s.api_key: return {'ok':False, 'message':'Set OPENAI_API_KEY in backend/.env, then restart 6B.'}
            if not (model or self.defaults['model']): return {'ok':False, 'message':'Enter a Responses API model available to your OpenAI account.'}
            return {'ok':True, 'message':'API key is configured. The model is checked on the first run.'}
        from .claude_code import auth_status
        probe = dataclasses.replace(s, anthropic_api_key=api_key or s.anthropic_api_key)
        try: status = await auth_status(probe)
        except (ProviderError, OSError) as exc:
            return {'ok':False, 'message':str(exc)}
        if not status['logged_in']:
            return {'ok':False, 'message':'Claude Code is installed but not signed in. Run the sign-in command in a terminal, or paste an Anthropic API key, then check again.'}
        who = status['email'] or ('API key' if status['auth_method']=='api_key' else status['auth_method'])
        return {'ok':True, 'message':'Claude Code is signed in'+(f' as {who}' if who else '')+'.', 'account':status}

    def connect(self, data: ConnectionInput, busy):
        if busy: raise ValueError('Wait for the current run to finish before switching the model connection')
        result = asyncio.run(self.check(data.provider, data.model, data.anthropic_api_key))
        if not result['ok']: raise ValueError(result['message'])
        saved = self.store.load()
        models = {**saved.get('models',{}), data.provider:data.model}
        saved.update(provider=data.provider, models=models, changed_at=time.time())
        if data.anthropic_api_key: saved['anthropic_api_key'] = data.anthropic_api_key
        self.store.save(saved)
        self.apply(saved)
        self.listed.clear()
        return {**self.overview(), 'check':result}

    def forget_claude_key(self):
        saved = self.store.load()
        saved.pop('anthropic_api_key', None)
        self.store.save(saved)
        self.listed.clear()
        self.apply(saved)
        return self.overview()
