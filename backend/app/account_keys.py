"""Hosted 6B: a Claude API key saved to the user's Google account, so it follows them to every device.

The key is encrypted with a key derived from this deployment's secret (6B_ACCOUNT_KEY_SECRET,
else the Firebase service account's private key) and the account's uid, and stored in the
Realtime Database at users/<uid>/model_key. No browser ever gets it back: they learn only that
one is saved, its last four characters and its model. A run decrypts it into the task's
in-memory KeyVault entry, exactly like a key sent by the browser.
"""
import base64
import hashlib
import hmac
import logging
import threading
import time
from cryptography.fernet import Fernet, InvalidToken
from pydantic import Field
from .config import claude_model_id
from .firebase import key as db_key
from .models import StrictModel

log = logging.getLogger(__name__)


class AccountKeyInput(StrictModel):
    # Empty keeps the key saved before and changes only the model.
    api_key: str = Field(default='', max_length=300)
    model: str = Field(default='', max_length=120, pattern=r'^[A-Za-z0-9._:\-\[\]/]*$')


class AccountKeys:
    # Every API request reads the record to pick the browser's default connection; this cache
    # keeps that off the network. Other servers see a change within this long.
    TTL = 60

    def __init__(self, root, secret):
        self.root, self.secret = root, (secret or '').encode()
        self.lock, self.cache = threading.Lock(), {}

    @property
    def available(self):
        return bool(self.root is not None and self.secret)

    @staticmethod
    def _path(uid):
        return f'users/{db_key(uid)}/model_key'

    def _box(self, uid):
        # One key per account, so a record copied to another account never decrypts.
        digest = hmac.new(self.secret, b'6b-account-key:'+uid.encode(), hashlib.sha256).digest()
        return Fernet(base64.urlsafe_b64encode(digest))

    def _remember(self, uid, record):
        with self.lock: self.cache[uid] = (record, time.monotonic()+self.TTL)

    def record(self, uid):
        if not (uid and self.available): return None
        with self.lock:
            hit = self.cache.get(uid)
            if hit and hit[1] > time.monotonic(): return hit[0]
        try: record = self.root.child(self._path(uid)).get() or None
        except Exception as exc:  # noqa: BLE001 - the browser falls back to its own connection
            log.warning('Could not read the saved model key of %s: %s', uid, exc)
            return None
        self._remember(uid, record)
        return record

    def status(self, uid):
        record = self.record(uid)
        return {'available':bool(uid and self.available), 'saved':bool(record),
                'hint':(record or {}).get('hint', ''), 'model':(record or {}).get('model', '')}

    def save(self, uid, api_key, model):
        record = dict(self.record(uid) or {})
        if api_key:
            record.update(hint=api_key[-4:], secret=self._box(uid).encrypt(api_key.encode()).decode())
        if not record.get('secret'): raise ValueError('Paste your Anthropic API key first.')
        record.update(provider='claude', model=claude_model_id(model), saved_at=time.time())
        self.root.update({self._path(uid):record})
        self._remember(uid, record)
        return self.status(uid)

    def forget(self, uid):
        self.root.update({self._path(uid):None})
        self._remember(uid, None)
        return self.status(uid)

    def key(self, uid):
        record = self.record(uid)
        if not record: return ''
        try: return self._box(uid).decrypt(record['secret'].encode()).decode()
        except (InvalidToken, KeyError, ValueError, AttributeError): return ''
