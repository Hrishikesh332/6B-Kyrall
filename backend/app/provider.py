"""Responses API adapter; provider secrets never enter task events or CAD subprocesses."""
import asyncio
import json
import httpx

RESPONSES = 'https://api.openai.com/v1/responses'
# ChatGPT plan requests group function tools in one namespace.
NAMESPACE = 'sixb'
USAGE_URL = 'https://chatgpt.com/settings/usage'


class ProviderError(Exception):
    pass


def plan_error(status, body):
    """A user-facing message for a ChatGPT plan failure (never the raw body, which may echo input)."""
    error = body.get('error') if isinstance(body, dict) and isinstance(body.get('error'), dict) else {}
    code, param = error.get('code'), error.get('param')
    known = {
        'subscription_sharing_usage_limit_exceeded':f'Your ChatGPT plan has reached its usage limit for 6B. Check {USAGE_URL}, then retry.',
        'subscription_sharing_user_not_eligible':'ChatGPT plan usage is not available for this ChatGPT account or workspace; use an API key instead.',
        'subscription_sharing_usage_unavailable':'ChatGPT could not check your plan usage right now; retry in a few minutes.',
        'subscription_sharing_user_unavailable':'ChatGPT account information is temporarily unavailable; retry in a few minutes.',
        'subscription_sharing_unsupported_capability':f'The ChatGPT plan does not support part of this request{f" ({param})" if param else ""}.',
        'subscription_sharing_invalid_user':'ChatGPT could not validate your sign-in. Continue with ChatGPT again in Integrations.',
    }
    if code in known: return known[code]
    if status == 401: return 'ChatGPT did not accept your sign-in. Continue with ChatGPT again in Integrations.'
    if status == 403: return 'ChatGPT refused this request for your account or region'+(f' ({code})' if code else '')+'.'
    return f'ChatGPT plan request failed with HTTP {status}'+(f' ({code})' if code else '')+'.'


def unprefixed(item):
    # Calls to namespaced tools may come back as "<namespace>.<name>"; 6B runs tools by plain name.
    name = item.get('name', '')
    for sep in ('.', '__'):
        if name.startswith(NAMESPACE+sep): return {**item, 'name':name[len(NAMESPACE+sep):]}
    return item


class ResponsesProvider:
    def __init__(self,settings,transport=None):
        self.settings,self.transport=settings,transport

    async def respond(self,instructions,tools,items,previous_response_id=None):
        if self.settings.openai_plan: return await self.respond_on_plan(instructions,tools,items)
        body={'model':self.settings.model,'instructions':instructions,'tools':tools,'input':items,
              'max_output_tokens':self.settings.max_output_tokens,'store':True,'parallel_tool_calls':False}
        if self.settings.reasoning_effort:
            body['reasoning']={'effort':self.settings.reasoning_effort}
        if previous_response_id:
            body['previous_response_id']=previous_response_id
        # Retry only explicit throttling/service-unavailable responses. Ambiguous transport
        # errors are surfaced; silently resubmitting could spend twice.
        async with httpx.AsyncClient(timeout=httpx.Timeout(180,connect=15),trust_env=False,transport=self.transport) as client:
            for attempt in range(3):
                try:
                    response=await client.post(RESPONSES,json=body,headers={'Authorization':'Bearer '+self.settings.api_key})
                except httpx.HTTPError as exc:
                    raise ProviderError('Model request transport failed; retry explicitly') from exc
                if response.status_code in (429,503) and attempt<2:
                    await asyncio.sleep(2**attempt)
                    continue
                if response.is_error:
                    # Do not store response bodies, which may echo sensitive input.
                    raise ProviderError(f'Model service returned HTTP {response.status_code}; check model access, quota, and API configuration')
                data=response.json()
                if data.get('status') not in ('completed',None):
                    raise ProviderError('Model response was incomplete; reduce scope or raise the output-token limit')
                return data
        raise ProviderError('Model request did not complete')

    async def respond_on_plan(self,instructions,tools,items):
        """One turn on the user's ChatGPT plan: stateless, streamed, and only supported fields."""
        body={'model':self.settings.model,'instructions':instructions,'input':items,'store':False,'stream':True,
              'parallel_tool_calls':False,
              'tools':[{'type':'namespace','name':NAMESPACE,'description':'6B engineering and CAD tools','tools':tools}]}
        if self.settings.reasoning_effort:
            body['reasoning']={'effort':self.settings.reasoning_effort}
        async with httpx.AsyncClient(timeout=httpx.Timeout(300,connect=15),trust_env=False,transport=self.transport) as client:
            for attempt in range(3):
                try:
                    async with client.stream('POST',RESPONSES,json=body,headers={'Authorization':'Bearer '+self.settings.api_key}) as response:
                        if response.is_error:
                            try: detail=json.loads(await response.aread())
                            except ValueError: detail={}
                            # Only "temporarily unavailable" is retried; a usage limit must not be.
                            if response.status_code==503 and attempt<2:
                                await asyncio.sleep(2**attempt); continue
                            # OpenAI asks integrations to keep the request id for support.
                            request_id=response.headers.get('x-request-id') or response.headers.get('openai-request-id')
                            raise ProviderError(plan_error(response.status_code,detail)+(f' (OpenAI request {request_id})' if request_id else ''))
                        return await self.completed(response)
                except httpx.HTTPError as exc:
                    raise ProviderError('ChatGPT plan request was interrupted; retry explicitly') from exc
        raise ProviderError('ChatGPT plan request did not complete')

    @staticmethod
    async def completed(response):
        """Read server-sent events through the terminal one; success only on response.completed."""
        data=[]
        async for line in response.aiter_lines():
            if line.startswith('data:'):
                data.append(line[5:].strip()); continue
            if line or not data: continue
            raw,data='\n'.join(data),[]
            if raw=='[DONE]': break
            try: event=json.loads(raw)
            except ValueError: continue
            kind=event.get('type','')
            if kind=='response.completed':
                result=event['response']
                result['output']=[unprefixed(x) if x.get('type')=='function_call' else x for x in result.get('output',[])]
                return result
            if kind in ('response.failed','error'):
                raise ProviderError(plan_error(200,{'error':(event.get('response') or {}).get('error') or event.get('error') or {}}))
            if kind=='response.incomplete':
                raise ProviderError('The ChatGPT plan response was incomplete; narrow the request and retry.')
        raise ProviderError('The ChatGPT plan response ended before it completed; retry explicitly.')
