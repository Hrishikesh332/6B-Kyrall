from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path
import os
import math

# Providers backed by a language model, and those whose model can see tool images.
MODEL_PROVIDERS = ('openai', 'claude')
VISION_PROVIDERS = ('claude',)
PROVIDERS = ('workshop', *MODEL_PROVIDERS)

# Hosted 6B: the browser's own model connection for the current request or run. It
# shadows these settings fields only inside that context and never touches the shared values.
CONNECTION = ContextVar('6b_connection', default=None)
CONNECTION_FIELDS = frozenset({'provider', 'model', 'api_key', 'claude_model', 'anthropic_api_key', 'claude_home', 'openai_plan'})
# The Google account signed in for the current request (uid, email, name, picture), when
# Google sign-in is on. New chats, projects and jobs belong to it.
USER = ContextVar('6b_user', default=None)


def current_owner():
    return (USER.get() or {}).get('uid')


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.getenv("6B_DATA_DIR", "./data")).resolve())
    provider: str = field(default_factory=lambda: os.getenv("6B_PROVIDER", "workshop"))
    model: str = field(default_factory=lambda: os.getenv("6B_MODEL", ""))
    api_key: str = field(default_factory=lambda: os.getenv("OPENAI_API_KEY", ""))
    claude_binary: str = field(default_factory=lambda: os.getenv("6B_CLAUDE_BINARY", ""))
    claude_model: str = field(default_factory=lambda: os.getenv("6B_CLAUDE_MODEL", ""))
    claude_timeout: int = field(default_factory=lambda: int(os.getenv("6B_CLAUDE_TIMEOUT", "600")))
    # One model response with no tool call or text for this long is interrupted and steered.
    claude_stall_seconds: int = field(default_factory=lambda: int(os.getenv("6B_CLAUDE_STALL_SECONDS", "420")))
    anthropic_api_key: str = field(default_factory=lambda: os.getenv("ANTHROPIC_API_KEY", ""))
    max_tool_calls: int = field(default_factory=lambda: int(os.getenv("6B_MAX_TOOL_CALLS", "80")))
    api_token: str = field(default_factory=lambda: os.getenv("6B_API_TOKEN", ""))
    reasoning_effort: str = field(default_factory=lambda: os.getenv("6B_REASONING_EFFORT", "medium"))
    max_model_turns: int = field(default_factory=lambda: int(os.getenv("6B_MAX_MODEL_TURNS", "24")))
    max_output_tokens: int = field(default_factory=lambda: int(os.getenv("6B_MAX_OUTPUT_TOKENS", "6000")))
    max_run_tokens: int = field(default_factory=lambda: int(os.getenv("6B_MAX_RUN_TOKENS", "200000")))
    cad_timeout: int = field(default_factory=lambda: int(os.getenv("6B_CAD_TIMEOUT", "90")))
    tool_timeout: float = field(default_factory=lambda: float(os.getenv("6B_TOOL_TIMEOUT", "180")))
    reference_domains: tuple[str, ...] = field(default_factory=lambda: tuple(x.strip().lower() for x in os.getenv("6B_REFERENCE_DOMAINS", "").split(",") if x.strip()))
    # Hosted deployments: extra Host names to accept (".example.com" matches subdomains).
    allowed_hosts: tuple[str, ...] = field(default_factory=lambda: tuple(x.strip().lower() for x in os.getenv("6B_ALLOWED_HOSTS", "").split(",") if x.strip()))
    frontend_dir: Path = field(default_factory=lambda: Path(__file__).resolve().parents[2] / "frontend")
    worker_enabled: bool = True
    isaac_ssh_host: str = field(default_factory=lambda: os.getenv('6B_ISAAC_SSH_HOST', ''))
    isaac_container: str = field(default_factory=lambda: os.getenv('6B_ISAAC_CONTAINER', ''))
    isaac_python: str = field(default_factory=lambda: os.getenv('6B_ISAAC_PYTHON', ''))
    isaac_mcp_path: str = field(default_factory=lambda: os.getenv('6B_ISAAC_MCP_PATH', ''))
    # Shared deployment: each browser brings its own model and Onshape keys, which are held
    # in memory for its runs only. Server-wide keys, saved connections and schedules are off.
    hosted: bool = field(default_factory=lambda: os.getenv('6B_HOSTED', '').lower() in ('1', 'true', 'yes'))
    workers: int = field(default_factory=lambda: int(os.getenv('6B_WORKERS', '1')))
    # Private HOME for one Claude Code run (hosted), so no CLI state outlives it.
    claude_home: str = ''
    # The OpenAI connection is a user's ChatGPT plan (Sign in with ChatGPT), not an API key.
    openai_plan: bool = False
    # Sign in with ChatGPT on a hosted website needs a client ID approved by OpenAI. Without
    # one, OpenAI's self-serve registration only redirects to http://127.0.0.1.
    chatgpt_client_id: str = field(default_factory=lambda: os.getenv('6B_CHATGPT_CLIENT_ID', ''))
    chatgpt_client_secret: str = field(default_factory=lambda: os.getenv('6B_CHATGPT_CLIENT_SECRET', ''))
    chatgpt_redirect_uri: str = field(default_factory=lambda: os.getenv('6B_CHATGPT_REDIRECT_URI', ''))
    # Firebase: Google sign-in and the Realtime Database cloud copy of each chat. The service
    # account is the key JSON itself or its base64, held only in the environment, never in a
    # file here. The web API key, auth domain and app ID are public browser settings.
    firebase_service_account: str = field(default_factory=lambda: os.getenv('FIREBASE_SERVICE_ACCOUNT', ''))
    firebase_web_api_key: str = field(default_factory=lambda: os.getenv('FIREBASE_WEB_API_KEY', ''))
    firebase_auth_domain: str = field(default_factory=lambda: os.getenv('FIREBASE_AUTH_DOMAIN', ''))
    firebase_app_id: str = field(default_factory=lambda: os.getenv('FIREBASE_APP_ID', ''))
    # Empty: https://<project>-default-rtdb.firebaseio.com (a us-central1 database).
    firebase_database_url: str = field(default_factory=lambda: os.getenv('FIREBASE_DATABASE_URL', ''))
    cloud_sync: bool = field(default_factory=lambda: os.getenv('6B_CLOUD_SYNC', '1').lower() not in ('0', 'false', 'no'))
    # A personal workspace works signed out unless this is set; hosted ones always need sign-in.
    require_sign_in: bool = field(default_factory=lambda: os.getenv('6B_REQUIRE_SIGN_IN', '').lower() in ('1', 'true', 'yes'))
    # The Google account that owns a personal workspace: signing in with it takes the chats made
    # while signed out. Empty: any account that signs in here takes them.
    owner_email: str = field(default_factory=lambda: os.getenv('6B_OWNER_EMAIL', '').strip().lower())

    def __getattribute__(self, name):
        if name in CONNECTION_FIELDS:
            override = CONNECTION.get()
            if override is not None and name in override: return override[name]
        return object.__getattribute__(self, name)

    def prepare(self):
        if self.hosted:
            # Nothing server-wide may pay for a visitor's run.
            self.provider, self.model, self.api_key, self.anthropic_api_key = 'workshop', '', '', ''
        if not 1 <= self.workers <= 16:
            raise ValueError('6B_WORKERS must be between 1 and 16')
        if not math.isfinite(self.tool_timeout) or self.tool_timeout<=0:
            raise ValueError('6B_TOOL_TIMEOUT must be a positive finite number')
        if self.provider not in PROVIDERS:
            raise ValueError("6B_PROVIDER must be workshop, openai, or claude")
        if self.provider == "openai" and (not self.api_key or not self.model):
            raise ValueError("Live mode requires OPENAI_API_KEY and 6B_MODEL")
        self.data_dir.mkdir(parents=True, exist_ok=True)
        (self.data_dir / "artifacts").mkdir(exist_ok=True)
        (self.data_dir / "workspaces").mkdir(exist_ok=True)
