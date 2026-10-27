"""Provider-independent argument decoding and repairable tool failures."""
import hashlib
import json
from .db import encode


MAX_ARGUMENT_BYTES = 1_000_000


def failure(code, message, *, hint, retryable=False, **details):
    # Recoverable means the model may repair its request. Retryable means that
    # repeating the same arguments is useful; it never triggers an automatic retry.
    return {'error':message, 'code':code, 'recoverable':True,
            'retryable':retryable, 'hint':hint, **details}


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Duplicate JSON object keys are not allowed')
        value[key] = item
    return value


def _finite_constant(value):
    raise ValueError('JSON numbers must be finite')


def prepare_arguments(arguments, *, encoded=False):
    """Return audit input, decoded object, and an optional failure without throwing.

    Valid calls retain their exact object. Rejected wire input is bounded and
    fingerprinted so it can be inspected and replayed without invalid JSON in SQLite.
    """
    raw = arguments if encoded and isinstance(arguments,str) else None
    try:
        if raw is None:
            raw = encode(arguments)
        wire = raw.encode('utf-8')
        if len(wire) > MAX_ARGUMENT_BYTES:
            raise ValueError('Tool arguments exceed the 1 MB limit')
        if encoded and not isinstance(arguments,str):
            raise ValueError('Tool arguments must be a JSON-encoded object')
        value = json.loads(raw, object_pairs_hook=_unique_object, parse_constant=_finite_constant)
        # Reject overflow such as 1e999 as well as explicit NaN/Infinity literals.
        encode(value)
        if not isinstance(value,dict):
            raise ValueError('Tool arguments must be a JSON object')
        return value, value, None
    except (ValueError, TypeError, RecursionError, UnicodeError) as exc:
        if raw is None:
            # Invalid decoded input (e.g. NaN) cannot go into a JSON DB column.
            try: raw = json.dumps(arguments,ensure_ascii=True)
            except (ValueError,TypeError,RecursionError): raw = '<unserializable arguments>'
        wire = raw.encode('utf-8',errors='backslashreplace')
        audit = {'rejected_input':wire[:8192].decode('utf-8',errors='replace'),
                 'sha256':hashlib.sha256(wire).hexdigest(), 'bytes':len(wire),
                 'truncated':len(wire)>8192}
        message = 'Arguments could not be decoded: '+str(exc)[:300]
        return audit, None, failure('invalid_arguments',message,
            hint='Send one JSON object matching the tool schema, with finite numbers and distinct keys.')
