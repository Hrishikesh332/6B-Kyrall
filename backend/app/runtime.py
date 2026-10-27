"""One persistent asyncio worker loop, independent of Flask request threads."""
import asyncio
import threading


class WorkerRuntime:
    def __init__(self, engine, scheduler):
        self.engine, self.scheduler = engine, scheduler
        self.lock = threading.Lock()
        self.thread = self.loop = self.stop_event = None
        self.ready = threading.Event()

    def start(self):
        with self.lock:
            if self.thread is not None: return
            self.thread = threading.Thread(target=self._serve, name='6b-worker', daemon=True)
            self.thread.start()
        if not self.ready.wait(10): raise RuntimeError('Worker did not start')

    def _serve(self):
        async def main():
            self.loop = asyncio.get_running_loop()
            self.stop_event = asyncio.Event()
            jobs = [asyncio.create_task(self.engine.serve()), asyncio.create_task(self.scheduler(self.stop_event))]
            self.ready.set()
            await self.stop_event.wait()
            self.engine.shutdown.set()
            for job in jobs: job.cancel()
            await asyncio.gather(*jobs, return_exceptions=True)
        asyncio.run(main())

    def close(self):
        if self.loop and self.stop_event and not self.loop.is_closed():
            self.loop.call_soon_threadsafe(self.stop_event.set)
        if self.thread: self.thread.join(timeout=15)
