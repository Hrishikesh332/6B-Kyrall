import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  KeyRound,
  RefreshCw,
  Unplug,
} from "lucide-react";
import {
  MODEL_CONNECTION,
  api,
  forgetConnection,
  rememberedConnection,
  saveConnection,
  savedConnection,
} from "./lib.js";
import ProviderLogo from "./ProviderLogo.jsx";
import { Dialog, ErrorNotice, Loading } from "./ui.jsx";

// Pick which model service runs tasks: Claude Code, the workshop or the OpenAI API.
export default function ModelConnection({
  onClose,
  onChanged,
  notify,
  initialProvider,
}) {
  const [overview, setOverview] = useState(null),
    [error, setError] = useState(null),
    [selected, setSelected] = useState(null);
  const load = async () => {
    setError(null);
    try {
      const next = await api("/integrations/model");
      setOverview(next);
      setSelected(
        (id) =>
          id ||
          initialProvider ||
          (next.active.provider === "workshop"
            ? "claude"
            : next.active.provider),
      );
    } catch (err) {
      setError(err);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const provider = overview?.providers.find((p) => p.id === selected);
  return (
    <Dialog title="Model connection" onClose={onClose}>
      <div className="onshape-setup model-connection">
        {error ? (
          <ErrorNotice error={error} retry={load} />
        ) : !overview ? (
          <Loading>Checking connections…</Loading>
        ) : (
          <>
            <ActiveSummary active={overview.active} />
            <div
              className="provider-options"
              role="radiogroup"
              aria-label="Model provider"
            >
              {overview.providers
                .filter((p) => p.id !== "workshop")
                .map((p) => {
                  return (
                    <button
                      key={p.id}
                      role="radio"
                      aria-checked={selected === p.id}
                      className="onshape-card provider-option"
                      onClick={() => setSelected(p.id)}
                    >
                      <ProviderLogo provider={p.id} size={22} />
                      <strong>{p.name}</strong>
                      {p.active && <small>In use</small>}
                    </button>
                  );
                })}
            </div>
            {provider &&
              (overview.hosted ? (
                <>
                  {provider.id === "openai" && (
                    <ChatGPTPlan
                      onConnected={async (next) => {
                        setOverview(next);
                        await onChanged?.();
                        notify?.(
                          `${next.active.name} is now running your tasks.`,
                        );
                      }}
                    />
                  )}
                  <BrowserKeySetup
                    key={provider.id}
                    provider={provider}
                    onConnected={async (next) => {
                      setOverview(next);
                      await onChanged?.();
                      notify?.(
                        `${next.active.name} is now running your tasks.`,
                      );
                    }}
                    onClose={onClose}
                  />
                </>
              ) : (
                <ProviderSetup
                  key={provider.id}
                  provider={provider}
                  onConnected={async (next) => {
                    setOverview(next);
                    await onChanged?.();
                    notify?.(`${next.active.name} is now running your tasks.`);
                  }}
                  onKeyRemoved={setOverview}
                  onClose={onClose}
                />
              ))}
          </>
        )}
      </div>
    </Dialog>
  );
}

function ActiveSummary({ active }) {
  return (
    <div className="connection-summary">
      <span className="connection-icon">
        <ProviderLogo provider={active.provider} size={26} />
      </span>
      <div>
        <strong>{active.name}</strong>
        <span>
          {active.provider === "workshop"
            ? "No model"
            : active.model || "Account default model"}{" "}
          ·{" "}
          {active.source === "browser"
            ? active.provider === "workshop"
              ? "no key connected in this browser"
              : active.plan
                ? "signed in with ChatGPT"
                : "your key, saved in this browser"
            : active.source === "workspace"
              ? "chosen in this workspace"
              : "from backend/.env"}
        </span>
      </div>
      <span className="connection-status is-connected">
        <Check size={11} /> In use
      </span>
    </div>
  );
}

// Shows the short form (e.g. "claude auth login"); copying gives the full path.
function Command({ text }) {
  const [copied, setCopied] = useState(false);
  const [program, ...args] = text.split(" ");
  const short = [program.split("/").pop(), ...args].join(" ");
  return (
    <span className="command-line" title={text}>
      <code>{short}</code>
      <button
        type="button"
        className="text-button"
        aria-label={`Copy ${text}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </span>
  );
}

function ProviderSetup({ provider, onConnected, onKeyRemoved, onClose }) {
  const [check, setCheck] = useState(null),
    [busy, setBusy] = useState(""),
    [model, setModel] = useState(provider.model || ""),
    [apiKey, setApiKey] = useState(""),
    [models, setModels] = useState(provider.models || null);
  const run = async (kind, work) => {
    setBusy(kind);
    try {
      await work();
    } catch (err) {
      setCheck({ ok: false, message: err.message });
    } finally {
      setBusy("");
    }
  };
  const test = () =>
    run("check", async () => {
      const result = await api("/integrations/model/check", {
        method: "POST",
        body: { provider: provider.id },
      });
      if (result.models?.length) setModels(result.models);
      setCheck(result);
    });
  const connect = () =>
    run("connect", async () => {
      const next = await api("/integrations/model", {
        method: "PUT",
        body: {
          provider: provider.id,
          model: model.trim(),
          ...(apiKey.trim() ? { anthropic_api_key: apiKey.trim() } : {}),
        },
      });
      setApiKey("");
      setCheck(next.check);
      await onConnected(next);
    });
  const canChooseModel = provider.id === "claude";
  return (
    <div className="provider-setup">
      {provider.id === "openai" ? (
        <p className="setup-line">
          Set <code>OPENAI_API_KEY</code> and <code>6B_MODEL</code> in{" "}
          <code>backend/.env</code>.
        </p>
      ) : !provider.installed ? (
        <p className="setup-line">
          Install {provider.name} first.{" "}
          <a href={provider.install} target="_blank" rel="noreferrer">
            Install guide <ArrowUpRight size={12} />
          </a>
        </p>
      ) : (
        <div className="setup-line">
          <span>Sign in once</span>
          <Command text={provider.sign_in} />
        </div>
      )}
      {canChooseModel && (
        <label className="export-field">
          Model
          {models?.length ? (
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.default ? " (default)" : ""}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={model}
              placeholder="Account default"
              maxLength={120}
              spellCheck={false}
              onChange={(e) => setModel(e.target.value)}
            />
          )}
        </label>
      )}
      {provider.id === "claude" &&
        (provider.api_key_saved ? (
          <p className="connect-note">
            <KeyRound size={13} /> API key saved.{" "}
            <button
              type="button"
              className="text-button danger-text"
              disabled={!!busy}
              onClick={() =>
                run("forget", async () => {
                  onKeyRemoved(
                    await api("/integrations/model/anthropic-key", {
                      method: "DELETE",
                    }),
                  );
                  setCheck({ ok: true, message: "API key removed." });
                })
              }
            >
              Remove
            </button>
          </p>
        ) : (
          !provider.api_key_from_environment && (
            <details className="api-key-option">
              <summary>Use an API key instead</summary>
              <input
                type="password"
                aria-label="Anthropic API key"
                value={apiKey}
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-ant-…"
                onChange={(e) => setApiKey(e.target.value)}
              />
            </details>
          )
        ))}
      {check && (
        <p className={`connection-check${check.ok ? " ok" : ""}`} role="status">
          {check.message}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="secondary" onClick={onClose}>
          Done
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!!busy}
          onClick={test}
        >
          <RefreshCw size={14} />
          {busy === "check" ? "Checking…" : "Check"}
        </button>
        <button
          type="button"
          className="primary"
          disabled={
            !!busy ||
            (provider.active &&
              model === (provider.model || "") &&
              !apiKey.trim())
          }
          onClick={connect}
        >
          {busy === "connect"
            ? "Connecting…"
            : provider.active
              ? "Save changes"
              : `Use ${provider.name}`}
        </button>
      </div>
    </div>
  );
}

// Hosted 6B: Sign in with ChatGPT pays for runs with the user's ChatGPT plan. The tokens
// stay on the server behind an HttpOnly cookie; this browser only remembers the choice.
function ChatGPTPlan({ onConnected }) {
  const saved = savedConnection(MODEL_CONNECTION);
  const [status, setStatus] = useState(null),
    [models, setModels] = useState(null),
    [model, setModel] = useState(
      saved?.provider === "chatgpt" ? saved.model : "",
    ),
    [busy, setBusy] = useState(""),
    [message, setMessage] = useState(null);
  const run = async (kind, work) => {
    setBusy(kind);
    setMessage(null);
    try {
      await work();
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    } finally {
      setBusy("");
    }
  };
  const load = () =>
    run("load", async () => {
      const next = await api("/integrations/chatgpt");
      setStatus(next);
      if (next.signed_in && next.plan_usage) {
        const list = (await api("/integrations/chatgpt/models")).models;
        setModels(list);
        setModel((current) => current || list[0]?.id || "");
      }
    });
  useEffect(() => {
    void load();
  }, []);
  const inUse = saved?.provider === "chatgpt";
  if (!status) return null;
  return (
    <section className="provider-setup chatgpt-plan" aria-label="ChatGPT plan">
      {!status.available ? (
        <p className="setup-line">{status.reason}</p>
      ) : !status.signed_in ? (
        <>
          <p className="setup-line">
            Use your ChatGPT Plus or Pro plan instead of an API key.
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="primary"
              disabled={!!busy}
              onClick={() =>
                run("start", async () => {
                  const { url } = await api("/integrations/chatgpt/start", {
                    method: "POST",
                  });
                  window.location.assign(url);
                })
              }
            >
              <ProviderLogo provider="openai" size={14} />
              {busy === "start" ? "Opening ChatGPT…" : "Continue with ChatGPT"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="setup-line">
            Signed in with ChatGPT{status.email ? ` as ${status.email}` : ""}.{" "}
            <a href={status.usage_url} target="_blank" rel="noreferrer">
              Manage usage <ArrowUpRight size={12} />
            </a>
          </p>
          {!status.plan_usage ? (
            <p className="connection-check" role="status">
              Using your ChatGPT plan was not allowed during sign-in. Sign out
              and continue with ChatGPT again to allow it, or use an API key
              below.
            </p>
          ) : (
            <label className="export-field">
              ChatGPT model
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {(models || []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="secondary danger-text"
              disabled={!!busy}
              onClick={() =>
                run("signout", async () => {
                  const next = await api("/integrations/chatgpt", {
                    method: "DELETE",
                  });
                  if (inUse) forgetConnection(MODEL_CONNECTION);
                  setStatus(next);
                  setModels(null);
                  await onConnected(await api("/integrations/model"));
                })
              }
            >
              <Unplug size={14} /> Sign out
            </button>
            {status.plan_usage && (
              <button
                type="button"
                className="primary"
                disabled={!!busy || !model || (inUse && saved.model === model)}
                onClick={() =>
                  run("use", async () => {
                    // No secret here: the server finds the tokens from the sign-in cookie.
                    saveConnection(
                      MODEL_CONNECTION,
                      { provider: "chatgpt", model },
                      true,
                    );
                    await onConnected(await api("/integrations/model"));
                  })
                }
              >
                {inUse ? "Save changes" : "Use my ChatGPT plan"}
              </button>
            )}
          </div>
        </>
      )}
      {message && (
        <p
          className={`connection-check${message.ok ? " ok" : ""}`}
          role="status"
        >
          {message.text}
        </p>
      )}
      <p className="connect-note">
        <KeyRound size={13} /> Or use an OpenAI API key:
      </p>
    </section>
  );
}

const KEY_PAGES = {
  claude: [
    "Anthropic API key",
    "sk-ant-…",
    "https://console.anthropic.com/settings/keys",
  ],
  openai: ["OpenAI API key", "sk-…", "https://platform.openai.com/api-keys"],
};

// Hosted 6B: the key is checked live, then kept only in this browser.
function BrowserKeySetup({ provider, onConnected, onClose }) {
  const saved = savedConnection(MODEL_CONNECTION);
  const mine = saved?.provider === provider.id ? saved : null;
  const [model, setModel] = useState(mine?.model ?? ""),
    [apiKey, setApiKey] = useState(""),
    [remember, setRemember] = useState(rememberedConnection(MODEL_CONNECTION)),
    [check, setCheck] = useState(null),
    [busy, setBusy] = useState("");
  const [label, placeholder, keysPage] = KEY_PAGES[provider.id];
  const key = apiKey.trim() || mine?.key || "";
  const run = async (kind, work) => {
    setBusy(kind);
    try {
      await work();
    } catch (err) {
      setCheck({ ok: false, message: err.message });
    } finally {
      setBusy("");
    }
  };
  const verify = async () => {
    const result = await api("/integrations/model/check", {
      method: "POST",
      body: { provider: provider.id, model: model.trim(), api_key: key },
    });
    setCheck(result);
    return result.ok;
  };
  const connect = () =>
    run("connect", async () => {
      if (!(await verify())) return;
      saveConnection(
        MODEL_CONNECTION,
        { provider: provider.id, model: model.trim(), key },
        remember,
      );
      setApiKey("");
      await onConnected(await api("/integrations/model"));
    });
  const disconnect = () =>
    run("disconnect", async () => {
      forgetConnection(MODEL_CONNECTION);
      setCheck({ ok: true, message: "Key removed from this browser." });
      await onConnected(await api("/integrations/model"));
    });
  return (
    <div className="provider-setup">
      <p className="setup-line">
        Use your own key.{" "}
        <a href={keysPage} target="_blank" rel="noreferrer">
          Create a key <ArrowUpRight size={12} />
        </a>
      </p>
      <label className="export-field">
        {label}
        <input
          type="password"
          aria-label={label}
          value={apiKey}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            mine?.key
              ? `Saved in this browser · …${mine.key.slice(-4)}`
              : placeholder
          }
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      <label className="export-field">
        Model
        {provider.id === "claude" ? (
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {(provider.models || []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={model}
            required
            placeholder="Responses API model, e.g. gpt-5"
            maxLength={120}
            spellCheck={false}
            onChange={(e) => setModel(e.target.value)}
          />
        )}
      </label>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
        />
        Remember on this device (otherwise cleared when this tab closes)
      </label>
      <p className="connect-note">
        <KeyRound size={13} /> Your key stays in this browser. 6B sends it only
        when a task runs and holds it in server memory until that run ends; it
        is never saved on the server or shown to other visitors.
      </p>
      {check && (
        <p className={`connection-check${check.ok ? " ok" : ""}`} role="status">
          {check.message}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="secondary" onClick={onClose}>
          Done
        </button>
        {mine && (
          <button
            type="button"
            className="secondary danger-text"
            disabled={!!busy}
            onClick={disconnect}
          >
            <Unplug size={14} /> Remove key
          </button>
        )}
        <button
          type="button"
          className="secondary"
          disabled={!!busy || !key}
          onClick={() => run("check", verify)}
        >
          <RefreshCw size={14} />
          {busy === "check" ? "Checking…" : "Check"}
        </button>
        <button
          type="button"
          className="primary"
          disabled={
            !!busy || !key || (provider.id === "openai" && !model.trim())
          }
          onClick={connect}
        >
          {busy === "connect"
            ? "Checking key…"
            : mine
              ? "Save changes"
              : `Use ${provider.name}`}
        </button>
      </div>
    </div>
  );
}
