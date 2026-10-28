"""Sign in with ChatGPT (hosted 6B): OAuth against a fake OpenAI, then runs on the user's plan."""
import json
from pathlib import Path
import time
from urllib.parse import parse_qs, urlparse
import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from app.chatgpt import COOKIE
from app.config import Settings
from app.main import create_app
from app.provider import ResponsesProvider

LOCAL = 'http://127.0.0.1:8765'
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
JWK = {**json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(KEY.public_key())), 'kid':'k1', 'alg':'RS256', 'use':'sig'}


class FakeOpenAI:
    """auth.openai.com and api.openai.com, enough for the documented plan-usage flow."""
    def __init__(self):
        self.nonce, self.requests, self.responses, self.refreshes, self.revoked = None, [], [], 0, []

    def id_token(self, client_id, nonce):
        now = int(time.time())
        return jwt.encode({'iss':'https://auth.openai.com', 'aud':client_id, 'sub':'user-1', 'email':'ada@example.com',
                           'nonce':nonce, 'iat':now, 'exp':now+600}, KEY, algorithm='RS256', headers={'kid':'k1'})

    def handler(self, request):
        url, form = request.url, parse_qs(request.content.decode()) if request.method == 'POST' else {}
        one = lambda k: form.get(k, [''])[0]
        if url.path == '/.well-known/openid-configuration':
            return httpx.Response(200, json={'issuer':'https://auth.openai.com', 'jwks_uri':'https://auth.openai.com/.well-known/jwks.json',
                                             'revocation_endpoint':'https://auth.openai.com/api/accounts/oauth/revoke'})
        if url.path == '/.well-known/jwks.json':
            return httpx.Response(200, json={'keys':[JWK]})
        if url.path == '/api/accounts/oauth/token':
            if one('grant_type') == 'authorization_code':
                assert one('resource') == 'https://api.openai.com/v1' and one('code_verifier') and one('client_id') == 'oaiapp_123'
                return httpx.Response(200, json={'access_token':'ACCESS-SECRET-1', 'refresh_token':'REFRESH-SECRET-1', 'expires_in':3600,
                                                 'token_type':'Bearer', 'id_token':self.id_token('oaiapp_123', self.nonce),
                                                 'scope':'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke'})
            assert one('grant_type') == 'refresh_token' and one('refresh_token') == 'REFRESH-SECRET-1' and one('client_id') == 'oaiapp_123'
            self.refreshes += 1
            return httpx.Response(200, json={'access_token':'ACCESS-SECRET-2', 'refresh_token':'REFRESH-SECRET-2', 'expires_in':3600,
                                             'scope':'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke'})
        if url.path == '/api/accounts/oauth/revoke':
            self.revoked.append(one('token')); return httpx.Response(200)
        if url.path == '/v1/models':
            assert request.headers['authorization'].startswith('Bearer ACCESS-SECRET')
            return httpx.Response(200, json={'models':[{'slug':'gpt-plan', 'display_name':'GPT Plan', 'visibility':'list'},
                                                       {'slug':'terra', 'display_name':'GPT-6.1 Terra', 'visibility':'list'},
                                                       {'slug':'gpt-6-astra', 'visibility':'list'},
                                                       {'slug':'gpt-6.1-sol', 'display_name':'GPT-6.1 Sol', 'visibility':'hide'},
                                                       {'slug':'hidden', 'visibility':'hide'}]})
        if url.path == '/v1/responses':
            self.requests.append({'auth':request.headers['authorization'], 'body':json.loads(request.content)})
            status, events = self.responses.pop(0)
            if status != 200: return httpx.Response(status, json=events)
            text = ''.join(f'event: {e["type"]}\ndata: {json.dumps(e)}\n\n' for e in events)
            return httpx.Response(200, headers={'content-type':'text/event-stream'}, content=text.encode())
        raise AssertionError(f'unexpected {request.method} {url}')


def completed(*output):
    return [{'type':'response.created'}, {'type':'response.completed',
            'response':{'id':'resp', 'status':'completed', 'output':list(output), 'usage':{'total_tokens':50}}}]


@pytest.fixture
def openai():
    return FakeOpenAI()


@pytest.fixture
def hosted(tmp_path, openai):
    app = create_app(Settings(data_dir=tmp_path, hosted=True, api_token='', worker_enabled=False, allowed_hosts=('.up.railway.app',)))
    app.state.chatgpt.transport = httpx.MockTransport(openai.handler)
    app.state.engine.provider = ResponsesProvider(app.state.settings, httpx.MockTransport(openai.handler))
    return app


def sign_in(app, openai, client=None):
    client = client or app.test_client()
    start = client.post('/api/integrations/chatgpt/start', base_url=LOCAL)
    query = parse_qs(urlparse(start.get_json()['url']).query)
    openai.nonce = query['nonce'][0]
    back = client.get('/auth/callback', base_url=LOCAL, query_string={'code':'code-1', 'state':query['state'][0], 'client_id':'oaiapp_123'})
    return client, query, back


def test_sign_in_registers_6b_and_stores_tokens_only_encrypted(hosted, openai):
    client, query, back = sign_in(hosted, openai)
    assert query['client_id'] == ['dynamic_agent_client'] and query['agent_name_hint'] == ['6B']
    assert query['redirect_uri'] == [f'{LOCAL}/auth/callback'] and query['resource'] == ['https://api.openai.com/v1']
    assert query['scope'] == ['openid profile email offline_access resource.invoke chatgpt.tokens.use.direct']
    assert query['code_challenge_method'] == ['S256'] and query['ext_agent_host_id'][0].startswith('urn:uuid:')
    assert back.status_code == 302 and back.headers['location'] == '/?chatgpt=connected#integrations'
    status = client.get('/api/integrations/chatgpt', base_url=LOCAL).get_json()
    assert status['signed_in'] and status['plan_usage'] and status['email'] == 'ada@example.com'
    # Only GPT-6 Astra, GPT-6.1 Sol and GPT-6.1 Terra are offered, in that order, matched by slug or name; hidden ones stay out.
    assert client.get('/api/integrations/chatgpt/models', base_url=LOCAL).get_json()['models'] == [
        {'id':'gpt-6-astra', 'name':'GPT-6 Astra'}, {'id':'terra', 'name':'GPT-6.1 Terra'}]
    # Nothing readable on disk, and another browser sees nothing.
    for path in Path(hosted.state.settings.data_dir).rglob('*'):
        if path.is_file(): assert b'SECRET' not in path.read_bytes() and b'ada@example.com' not in path.read_bytes(), path
    assert not hosted.test_client().get('/api/integrations/chatgpt', base_url=LOCAL).get_json()['signed_in']


def test_the_session_cookie_is_httponly(hosted):
    response = hosted.test_client().post('/api/integrations/chatgpt/start', base_url=LOCAL)
    cookie = response.headers['Set-Cookie']
    assert cookie.startswith(COOKIE+'=') and 'HttpOnly' in cookie and 'SameSite=Lax' in cookie


def test_a_callback_from_another_browser_or_a_reused_state_is_refused(hosted, openai):
    client = hosted.test_client()
    query = parse_qs(urlparse(client.post('/api/integrations/chatgpt/start', base_url=LOCAL).get_json()['url']).query)
    openai.nonce = query['nonce'][0]
    stranger = hosted.test_client()
    stranger.set_cookie(COOKIE, 'someone-else', domain='127.0.0.1')
    refused = stranger.get('/auth/callback', base_url=LOCAL, query_string={'code':'c', 'state':query['state'][0], 'client_id':'oaiapp_123'})
    assert 'chatgpt_error' in refused.headers['location']
    # The state was consumed by the refused attempt, so it cannot be replayed either.
    again = client.get('/auth/callback', base_url=LOCAL, query_string={'code':'c', 'state':query['state'][0], 'client_id':'oaiapp_123'})
    assert 'chatgpt_error' in again.headers['location']


def test_a_forged_id_token_is_refused(hosted, openai):
    client = hosted.test_client()
    query = parse_qs(urlparse(client.post('/api/integrations/chatgpt/start', base_url=LOCAL).get_json()['url']).query)
    openai.nonce = 'not-the-nonce-we-sent'
    back = client.get('/auth/callback', base_url=LOCAL, query_string={'code':'c', 'state':query['state'][0], 'client_id':'oaiapp_123'})
    assert 'could+not+be+verified' in back.headers['location']
    assert not client.get('/api/integrations/chatgpt', base_url=LOCAL).get_json()['signed_in']


def test_a_hosted_site_needs_an_approved_client(hosted, tmp_path):
    site = 'https://6b.up.railway.app'
    status = hosted.test_client().get('/api/integrations/chatgpt', base_url=site).get_json()
    assert not status['available'] and 'approval' in status['reason']
    assert hosted.test_client().post('/api/integrations/chatgpt/start', base_url=site).status_code == 422
    approved = create_app(Settings(data_dir=tmp_path/'approved', hosted=True, api_token='', worker_enabled=False, chatgpt_client_id='oaiapp_site',
                                       allowed_hosts=('.up.railway.app',)))
    query = parse_qs(urlparse(approved.test_client().post('/api/integrations/chatgpt/start', base_url=site).get_json()['url']).query)
    assert query['client_id'] == ['oaiapp_site'] and 'agent_name_hint' not in query
    assert query['redirect_uri'] == [f'{site}/api/integrations/chatgpt/callback']


@pytest.mark.asyncio
async def test_runs_use_the_plan_statelessly(hosted, openai):
    client, _, _ = sign_in(hosted, openai)
    openai.responses = [
        (200, completed({'type':'reasoning', 'id':'rs_1', 'summary':[]},
                        {'type':'function_call', 'id':'fc_1', 'call_id':'c1', 'name':'sixb.write_document',
                         'arguments':json.dumps({'name':'note.md', 'content':'On the plan'})})),
        (200, completed({'type':'message', 'id':'msg_1', 'role':'assistant', 'content':[{'type':'output_text', 'text':'Saved the note.'}]})),
    ]
    headers = {'X-6B-Provider':'chatgpt', 'X-6B-Model':'gpt-plan'}
    tid = client.post('/api/tasks', json={'prompt':'Design a 40 mm bracket'}, headers=headers, base_url=LOCAL).get_json()['id']
    await hosted.state.engine.run(hosted.state.db.claim())
    task = hosted.state.db.detail(tid)
    assert task['status'] == 'completed' and [a['name'] for a in task['artifacts']] == ['note.md']
    first, second = (r['body'] for r in openai.requests)
    assert all(r['auth'] == 'Bearer ACCESS-SECRET-1' for r in openai.requests)
    for body in (first, second):
        assert body['store'] is False and body['stream'] is True and body['model'] == 'gpt-plan'
        assert 'previous_response_id' not in body and 'max_output_tokens' not in body
        assert body['tools'][0]['type'] == 'namespace' and body['tools'][0]['name'] == 'sixb'
    # Full history is resent: earlier input, the call (without ids or reasoning), and its output.
    assert second['input'][:len(first['input'])] == first['input']
    replayed = second['input'][len(first['input']):]
    assert replayed[0] == {'type':'function_call', 'call_id':'c1', 'name':'write_document', 'arguments':json.dumps({'name':'note.md', 'content':'On the plan'})}
    assert replayed[1]['type'] == 'function_call_output' and replayed[1]['call_id'] == 'c1'
    db_file = Path(hosted.state.settings.data_dir)/'workspace.sqlite3'
    assert b'ACCESS-SECRET' not in db_file.read_bytes()


@pytest.mark.asyncio
async def test_a_usage_limit_stops_the_run_with_a_clear_message(hosted, openai):
    client, _, _ = sign_in(hosted, openai)
    openai.responses = [(429, {'error':{'code':'subscription_sharing_usage_limit_exceeded', 'message':'limit'}})]
    tid = client.post('/api/tasks', json={'prompt':'Design a wall hook'}, headers={'X-6B-Provider':'chatgpt', 'X-6B-Model':'gpt-plan'},
                      base_url=LOCAL).get_json()['id']
    await hosted.state.engine.run(hosted.state.db.claim())
    task = hosted.state.db.detail(tid)
    assert task['status'] == 'failed' and 'usage limit' in task['runs'][0]['error'] and len(openai.requests) == 1


def test_a_plan_run_needs_this_browsers_sign_in(hosted):
    response = hosted.test_client().post('/api/tasks', json={'prompt':'Design a hinge'}, headers={'X-6B-Provider':'chatgpt', 'X-6B-Model':'gpt-plan'})
    assert response.status_code == 422 and 'Continue with ChatGPT' in response.get_json()['detail']


def test_tokens_refresh_before_they_expire_and_sign_out_revokes(hosted, openai):
    client, _, _ = sign_in(hosted, openai)
    chatgpt, cookie = hosted.state.chatgpt, client.get_cookie(COOKIE, domain='127.0.0.1').value
    record = chatgpt.load(cookie); record['expires_at'] = time.time()+600; chatgpt.save(cookie, record)
    assert chatgpt.fresh(cookie)['access_token'] == 'ACCESS-SECRET-2' and openai.refreshes == 1
    assert chatgpt.fresh(cookie)['access_token'] == 'ACCESS-SECRET-2' and openai.refreshes == 1  # fresh again: no second refresh
    signed_out = client.delete('/api/integrations/chatgpt', base_url=LOCAL).get_json()
    assert openai.revoked == ['REFRESH-SECRET-2'] and signed_out['revoked'] and not signed_out['signed_in']
    # The registration is kept so the next sign-in reuses it instead of registering again.
    query = parse_qs(urlparse(client.post('/api/integrations/chatgpt/start', base_url=LOCAL).get_json()['url']).query)
    assert query['client_id'] == ['oaiapp_123'] and query['login_hint'] == ['ada@example.com']


@pytest.mark.asyncio
async def test_with_a_site_key_visitors_can_still_run_on_their_own_plan(tmp_path, openai):
    site = 'https://6b.up.railway.app'
    def openai_item(app, base_url=site):
        return next(p for p in app.test_client().get('/api/integrations/model', base_url=base_url).get_json()['providers'] if p['id'] == 'openai')
    # Not approved by OpenAI yet: only the site's key is offered.
    unapproved = create_app(Settings(data_dir=tmp_path/'a', hosted=True, api_key='SITE-KEY', api_token='', worker_enabled=False,
                                     allowed_hosts=('.up.railway.app',)))
    assert openai_item(unapproved)['site_key'] and openai_item(unapproved)['chatgpt_sign_in'] is False
    app = create_app(Settings(data_dir=tmp_path/'b', hosted=True, api_key='SITE-KEY', api_token='', worker_enabled=False,
                              chatgpt_client_id='oaiapp_123', allowed_hosts=('.up.railway.app',)))
    app.state.chatgpt.transport = httpx.MockTransport(openai.handler)
    app.state.engine.provider = ResponsesProvider(app.state.settings, httpx.MockTransport(openai.handler))
    assert openai_item(app)['chatgpt_sign_in'] is True
    client, _, _ = sign_in(app, openai)
    openai.responses = [(200, completed({'type':'message', 'id':'msg_1', 'role':'assistant', 'content':[{'type':'output_text', 'text':'Done.'}]}))]
    made = client.post('/api/tasks', json={'prompt':'Design a 40 mm bracket'}, headers={'X-6B-Provider':'chatgpt', 'X-6B-Model':'gpt-plan'}, base_url=LOCAL)
    assert made.status_code == 201, made.get_json()
    await app.state.engine.run(app.state.db.claim())
    # The visitor's plan pays, never the site's key.
    assert openai.requests and all(r['auth'] == 'Bearer ACCESS-SECRET-1' for r in openai.requests)
