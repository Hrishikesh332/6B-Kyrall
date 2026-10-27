"""Keep this Mac from idle-sleeping while a model run is active.

Sleep pauses the run's timers and drops the provider's response stream, so a run that
should take minutes stalls for as long as the machine sleeps. Lid-close sleep still applies.
"""
import shutil
import subprocess
import sys


class KeepAwake:
    def __init__(self):
        self.process = None

    def start(self):
        exe = shutil.which('caffeinate') if sys.platform == 'darwin' else None
        if exe:
            try:
                self.process = subprocess.Popen([exe, '-i'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                                stderr=subprocess.DEVNULL)
            except OSError:
                self.process = None
        return self

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
        self.process = None
