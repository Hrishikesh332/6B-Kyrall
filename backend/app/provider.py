"""Responses API adapter; provider secrets never enter task events or CAD subprocesses."""
import asyncio
import httpx


class ProviderError(Exception):
    pass


class ResponsesProvider:
    def __init__(self,settings):
        self.settings=settings

    async def respond(self,instructions,tools,items,previous_response_id=None):
        body={'model':self.settings.model,'instructions':instructions,'tools':tools,'input':items,
              'max_output_tokens':self.settings.max_output_tokens,'store':True,'parallel_tool_calls':False}
        if self.settings.reasoning_effort:
            body['reasoning']={'effort':self.settings.reasoning_effort}
        if previous_response_id:
            body['previous_response_id']=previous_response_id
        # Retry only explicit throttling/service-unavailable responses. Ambiguous transport
        # errors are surfaced; silently resubmitting could spend twice.
        async with httpx.AsyncClient(timeout=httpx.Timeout(180,connect=15),trust_env=False) as client:
            for attempt in range(3):
                try:
                    response=await client.post('https://api.openai.com/v1/responses',json=body,headers={'Authorization':'Bearer '+self.settings.api_key})
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
