"""Async test adapter exercising the actual Flask WSGI boundary."""
import httpx


class AsyncWSGITransport(httpx.AsyncBaseTransport):
    def __init__(self, app): self.inner=httpx.WSGITransport(app=app)
    async def handle_async_request(self, request):
        await request.aread()
        response=self.inner.handle_request(request)
        body=response.read()
        return httpx.Response(response.status_code,headers=response.headers,content=body)
    async def aclose(self): self.inner.close()
