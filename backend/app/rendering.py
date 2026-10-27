"""Narrow compatibility guard for incomplete macOS font-discovery records."""
from contextlib import contextmanager
import plistlib
import subprocess
import sys


def normalize_font_report(raw):
    records=plistlib.loads(raw)
    if not isinstance(records,list): return raw
    for record in records:
        if isinstance(record,dict):
            items=record.get('_items',[])
            record['_items']=[entry for entry in items if isinstance(entry,dict) and isinstance(entry.get('path'),str)] if isinstance(items,list) else []
    return plistlib.dumps(records)


@contextmanager
def font_discovery_guard():
    # Used only during imports in the isolated CAD child. Do not modify the user's
    # Matplotlib installation or globally replace font discovery in the server.
    if sys.platform!='darwin':
        yield
        return
    original=subprocess.check_output
    def guarded(command,*args,**kwargs):
        raw=original(command,*args,**kwargs)
        if isinstance(command,(list,tuple)) and list(command)==['system_profiler','-xml','SPFontsDataType']:
            try: return normalize_font_report(raw)
            except (ValueError,TypeError,plistlib.InvalidFileException): return raw
        return raw
    subprocess.check_output=guarded
    try: yield
    finally: subprocess.check_output=original
