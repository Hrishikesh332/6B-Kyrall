"""Sign in with ChatGPT for hosted 6B: runs on the user's own ChatGPT plan.

Follows OpenAI's "ChatGPT plan usage" OAuth flow (developers.openai.com/siwc). The browser
never holds ChatGPT tokens: it holds an HttpOnly session cookie, and the tokens are stored
server-side encrypted with a key derived from that cookie, so the server cannot use them
without the browser that signed in. Without an approved client ID (6B_CHATGPT_CLIENT_ID)
OpenAI only allows loopback redirects, so sign-in then works only at http://127.0.0.1.
"""
import base64
import hashlib
import json
import logging
import os
from pathlib import Path
import secrets
import threading
import time
from urllib.parse import urlencode, urlparse
import uuid
from cryptography.fernet import Fernet, InvalidToken
import httpx
import jwt

ISSUER = 'https://auth.openai.com'
DISCOVERY = ISSUER+'/.well-known/openid-configuration'
AUTHORIZE = ISSUER+'/api/accounts/authorize'
TOKEN = ISSUER+'/api/accounts/oauth/token'
RESOURCE = 'https://api.openai.com/v1'
PLAN_SCOPE = 'chatgpt.tokens.use.direct'
SCOPES = f'openid profile email offline_access resource.invoke {PLAN_SCOPE}'
DYNAMIC_CLIENT = 'dynamic_agent_client'
AGENT_NAME = '6B'
COOKIE = '6b_chatgpt'
LOCAL_CALLBACK = '/auth/callback'
HOSTED_CALLBACK = '/api/integrations/chatgpt/callback'
USAGE_URL = 'https://chatgpt.com/settings/usage'
# Refresh well before the one-hour access token runs out, so a long run keeps a valid token.
REFRESH_MARGIN = 50*60


log = logging.getLogger(__name__)


class ChatGPTError(Exception):
    pass


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


class ChatGPT:
    def __init__(self, settings, transport=None):
        self.settings, self.transport = settings, transport
        self.root = Path(settings.data_dir)/'integrations'/'chatgpt'
        self.pending, self.locks, self.lock = {}, {}, threading.Lock()
        self._discovery = None

    # Configuration -------------------------------------------------------------------

    def client_id(self):
        return self.settings.chatgpt_client_id or DYNAMIC_CLIENT

    def redirect_uri(self, host_url):
        """None when this deployment cannot receive OpenAI's callback."""
        if self.settings.chatgpt_client_id:
            return self.settings.chatgpt_redirect_uri or host_url.rstrip('/')+HOSTED_CALLBACK
        url = urlparse(host_url)
        # Self-serve registration only accepts http://127.0.0.1:<port>/auth/callback.
        if url.scheme == 'http' and url.hostname == '127.0.0.1' and url.port:
            return f'http://127.0.0.1:{url.port}{LOCAL_CALLBACK}'
        return None

    def availability(self, host_url):
        if not self.settings.hosted:
            return 'Sign in with ChatGPT is available on hosted 6B (6B_HOSTED=1).'
        if self.redirect_uri(host_url): return None
        return ('Sign in with ChatGPT needs OpenAI’s approval for this website. The site owner can apply through '
                'OpenAI’s interest form, then set 6B_CHATGPT_CLIENT_ID. Until then, use an OpenAI API key.')

    def host_id(self):
        """Stable, opaque ext_agent_host_id for this deployment (OpenAI requires one per host)."""
        path = self.root.parent/'chatgpt-host.json'
        try: return json.loads(path.read_text())['ext_agent_host_id']
        except (OSError, ValueError, KeyError):
            value = f'urn:uuid:{uuid.uuid4()}'
            self._write(path, json.dumps({'ext_agent_host_id':value}).encode())
            return value

    # Encrypted per-browser records -----------------------------------------------------

    def _paths(self, cookie):
        digest = hashlib.sha256(('6b-chatgpt-file:'+cookie).encode()).hexdigest()
        key = base64.urlsafe_b64encode(hashlib.sha256(('6b-chatgpt-key:'+cookie).encode()).digest())
        return self.root/f'{digest}.bin', Fernet(key)

    @staticmethod
    def _write(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix('.tmp')
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'wb') as f: f.write(data)
        os.replace(tmp, path)

    def load(self, cookie):
        if not cookie: return None
        path, box = self._paths(cookie)
        try: return json.loads(box.decrypt(path.read_bytes()))
        except (OSError, InvalidToken, ValueError): return None

    def save(self, cookie, record):
        path, box = self._paths(cookie)
        self._write(path, box.encrypt(json.dumps(record).encode()))

    def forget(self, cookie):
        path, _ = self._paths(cookie)
        path.unlink(missing_ok=True)

    # OAuth ---------------------------------------------------------------------------

    def http(self):
        return httpx.Client(transport=self.transport, timeout=httpx.Timeout(20, connect=10), trust_env=False, follow_redirects=False)

    def discovery(self):
        if self._discovery is None:
            with self.http() as client:
                response = client.get(DISCOVERY)
            if response.is_error: raise ChatGPTError('Could not reach OpenAI sign-in; try again.')
            self._discovery = response.json()
        return self._discovery

    def start(self, cookie, host_url):
        redirect = self.redirect_uri(host_url)
        if not redirect: raise ChatGPTError(self.availability(host_url))
        saved = self.load(cookie) or {}
        verifier, state, nonce = secrets.token_urlsafe(48), secrets.token_urlsafe(24), secrets.token_urlsafe(24)
        # Reuse this browser's issued client so a returning sign-in does not register a new one.
        client_id = saved.get('client_id') if not self.settings.chatgpt_client_id and saved.get('client_id') else self.client_id()
        params = {'client_id':client_id, 'response_type':'code', 'redirect_uri':redirect, 'scope':SCOPES, 'resource':RESOURCE,
                  'state':state, 'nonce':nonce, 'code_challenge_method':'S256',
                  'code_challenge':_b64(hashlib.sha256(verifier.encode()).digest()), 'ext_agent_host_id':self.host_id()}
        if client_id == DYNAMIC_CLIENT: params['agent_name_hint'] = AGENT_NAME
        if saved.get('email'): params['login_hint'] = saved['email']
        with self.lock:
            now = time.time()
            self.pending = {k:v for k,v in self.pending.items() if v['created'] > now-600}
            self.pending[state] = {'cookie':cookie, 'verifier':verifier, 'nonce':nonce, 'client_id':client_id,
                                   'redirect_uri':redirect, 'created':now}
        return AUTHORIZE+'?'+urlencode(params)

    def finish(self, cookie, args):
        """Handle OpenAI's redirect back; returns the saved record."""
        with self.lock: attempt = self.pending.pop(args.get('state', ''), None)
        # One-time state, bound to the browser that started sign-in.
        if not attempt or not cookie or not secrets.compare_digest(attempt['cookie'], cookie):
            raise ChatGPTError('This sign-in link expired or belongs to another browser. Start again from Integrations.')
        if args.get('error'):
            raise ChatGPTError('ChatGPT sign-in was cancelled.' if args['error'] == 'access_denied' else 'ChatGPT sign-in failed; try again.')
        client_id = attempt['client_id']
        issued = args.get('client_id')
        if client_id == DYNAMIC_CLIENT:
            if not issued or issued == DYNAMIC_CLIENT: raise ChatGPTError('ChatGPT did not finish registering 6B; try again.')
            client_id = issued
        elif issued and issued != client_id:
            raise ChatGPTError('ChatGPT returned a different app registration; try again.')
        form = {'grant_type':'authorization_code', 'client_id':client_id, 'code':args.get('code', ''),
                'code_verifier':attempt['verifier'], 'redirect_uri':attempt['redirect_uri'], 'resource':RESOURCE}
        tokens = self._token(form)
        claims = self.verify_id_token(tokens.get('id_token', ''), client_id, attempt['nonce'])
        record = {**(self.load(cookie) or {}), 'client_id':client_id, 'issuer':ISSUER, 'subject':claims['sub'],
                  'email':claims.get('email', ''), 'name':claims.get('name', '')}
        record.update(self._credentials(tokens))
        self.save(cookie, record)
        return record

    def _token(self, form):
        auth = (self.settings.chatgpt_client_id, self.settings.chatgpt_client_secret) if self.settings.chatgpt_client_secret else None
        try:
            with self.http() as client:
                response = client.post(TOKEN, data=form, auth=auth, headers={'Accept':'application/json'})
        except httpx.HTTPError:
            raise ChatGPTError('Could not reach OpenAI sign-in; try again.') from None
        try: body = response.json()
        except ValueError: body = {}
        if response.is_error:
            body = body if isinstance(body, dict) else {}
            code, about = body.get('error'), str(body.get('error_description') or '')[:300]
            if isinstance(code, dict):
                # Some OpenAI auth routes answer with an API-style error object instead of OAuth fields.
                code, about = code.get('code'), str(code.get('message') or about)[:300]
            request_id = response.headers.get('openai-request-id') or response.headers.get('x-request-id')
            # OAuth error fields carry no secrets; the request id lets OpenAI support trace a failure.
            log.warning('ChatGPT token endpoint returned HTTP %s (%s): %s | request id %s', response.status_code, code, about, request_id)
            message = {'invalid_grant':'OpenAI did not accept this sign-in (invalid_grant). Try again, or use an API key.',
                       'invalid_client':'OpenAI rejected 6B’s client configuration.'}.get(code, 'ChatGPT sign-in failed; try again.')
            raise ChatGPTError(message+(f' OpenAI: {about}' if about else '')+(f' (request {request_id})' if request_id else ''))
        return body

    @staticmethod
    def _credentials(tokens):
        now = time.time()
        return {'access_token':tokens['access_token'], 'refresh_token':tokens.get('refresh_token', ''),
                'id_token':tokens.get('id_token', ''), 'expires_at':now+int(tokens.get('expires_in', 3600)),
                'earliest_refresh_at':float(tokens.get('earliest_refresh_at') or 0),
                'scopes':sorted(str(tokens.get('scope', '')).split()), 'saved_at':now}

    def verify_id_token(self, token, client_id, nonce):
        meta = self.discovery()
        with self.http() as client:
            keys = jwt.PyJWKSet.from_dict(client.get(meta['jwks_uri']).json())
        try:
            kid = jwt.get_unverified_header(token).get('kid')
            key = next(k for k in keys.keys if k.key_id == kid)
            claims = jwt.decode(token, key.key, algorithms=['RS256'], audience=client_id, issuer=meta['issuer'],
                                leeway=5, options={'require':['sub', 'exp', 'iat']})
        except (StopIteration, jwt.PyJWTError):
            raise ChatGPTError('ChatGPT returned an identity that could not be verified.') from None
        if not secrets.compare_digest(str(claims.get('nonce', '')), nonce) or not claims.get('sub'):
            raise ChatGPTError('ChatGPT returned an identity that could not be verified.')
        return claims

    def fresh(self, cookie):
        """This browser's record with an access token valid for a while; refreshes (serialized) if needed."""
        record = self.load(cookie)
        if not record or not record.get('access_token'): return None
        with self.lock: lock = self.locks.setdefault(self._paths(cookie)[0].name, threading.Lock())
        with lock:
            record = self.load(cookie)
            now = time.time()
            if record['expires_at']-now > REFRESH_MARGIN or not record.get('refresh_token'): return record
            if now < record.get('earliest_refresh_at', 0) and record['expires_at'] > now+60: return record
            try:
                tokens = self._token({'grant_type':'refresh_token', 'client_id':record['client_id'],
                                      'refresh_token':record['refresh_token'], 'resource':RESOURCE})
            except ChatGPTError:
                if record['expires_at'] > now+60: return record
                # An unusable refresh token: sign in again (the client registration is kept).
                self.save(cookie, {k:record[k] for k in ('client_id', 'email', 'name') if k in record})
                raise ChatGPTError('Your ChatGPT sign-in expired. Continue with ChatGPT again in Integrations.')
            record.update(self._credentials({**tokens, 'id_token':tokens.get('id_token') or record.get('id_token', '')}))
            self.save(cookie, record)
            return record

    def models(self, cookie):
        record = self.fresh(cookie)
        if not record: raise ChatGPTError('Continue with ChatGPT first.')
        with httpx.Client(transport=self.transport, timeout=20, trust_env=False) as client:
            response = client.get(RESOURCE+'/models', headers={'Authorization':'Bearer '+record['access_token']})
        if response.is_error: raise ChatGPTError(f'ChatGPT returned HTTP {response.status_code} for the model list.')
        return [{'id':m['slug'], 'name':m.get('display_name') or m['slug']}
                for m in response.json().get('models', []) if m.get('visibility', 'list') == 'list' and m.get('slug')]

    def sign_out(self, cookie):
        record = self.load(cookie)
        if not record: return
        revoked = True
        if record.get('refresh_token'):
            try:
                endpoint = self.discovery().get('revocation_endpoint')
                with self.http() as client:
                    response = client.post(endpoint, data={'token':record['refresh_token'], 'token_type_hint':'refresh_token',
                                                           'client_id':record['client_id']})
                revoked = response.status_code == 200
            except (ChatGPTError, httpx.HTTPError, TypeError): revoked = False
        # Keep the client registration so signing in again reuses it.
        self.save(cookie, {k:record[k] for k in ('client_id', 'email', 'name') if k in record})
        return revoked

    def status(self, cookie, host_url):
        record = self.load(cookie) or {}
        signed_in = bool(record.get('access_token'))
        return {'available':self.availability(host_url) is None, 'reason':self.availability(host_url),
                'signed_in':signed_in, 'email':record.get('email') if signed_in else None,
                'plan_usage':signed_in and PLAN_SCOPE in record.get('scopes', []), 'usage_url':USAGE_URL}
