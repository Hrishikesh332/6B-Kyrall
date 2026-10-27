import { useEffect, useState } from "react";
import { ArrowUpRight, Check, Copy, KeyRound, RefreshCw } from "lucide-react";
import { api } from "./lib.js";
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
            {provider && (
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
            )}
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
          {active.source === "workspace"
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
