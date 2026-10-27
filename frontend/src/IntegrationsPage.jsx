import { useEffect, useState } from "react";
import { ArrowRight, Printer } from "lucide-react";
import { api } from "./lib.js";
import ProviderLogo from "./ProviderLogo.jsx";
import { Dialog, PageHeading } from "./ui.jsx";

// Only real third-party connections appear here; built-in capabilities do not.
const groups = [
  {
    name: "AI models",
    items: [
      { id: "claude", name: "Claude Code", tagline: "Your Claude account" },
      { id: "openai", name: "OpenAI", tagline: "ChatGPT plan or API key" },
    ],
  },
  {
    name: "Design & simulation",
    items: [
      {
        id: "onshape",
        name: "Onshape",
        tagline: "Cloud CAD",
      },
      { id: "nvidia", name: "NVIDIA Isaac Sim", tagline: "Robot simulation" },
    ],
  },
  {
    name: "Manufacturing",
    items: [{ id: "bambu", name: "Bambu Studio", tagline: "3D print slicing" }],
  },
];
const NAMES = {
  onshape: "Onshape",
  nvidia: "NVIDIA Isaac Sim",
  bambu: "Bambu Studio",
};
const models = ["claude", "openai"];

function status(id, cap) {
  if (models.includes(id))
    return cap.provider === id
      ? { tone: "on", text: "Connected" }
      : { tone: "off", text: "Connect" };
  const name = NAMES[id];
  const s = (cap.integrations || []).find((i) => i.name === name)?.status;
  if (s === "connected") return { tone: "on", text: "Connected" };
  if (s === "configured") return { tone: "set", text: "Configured" };
  if (id === "bambu")
    return {
      tone: "off",
      text: s === "available" ? "Connect" : "Not installed",
    };
  return { tone: "off", text: id === "onshape" ? "Connect" : "Not set up" };
}

export default function IntegrationsPage({ cap, setModal }) {
  const [isaac, setIsaac] = useState(false),
    [signInError, setSignInError] = useState(null);
  useEffect(() => {
    // Back from Sign in with ChatGPT: reopen the OpenAI connection, then tidy the URL.
    const params = new URLSearchParams(window.location.search);
    if (!params.has("chatgpt") && !params.has("chatgpt_error")) return;
    setSignInError(params.get("chatgpt_error"));
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.hash,
    );
    setModal({ kind: "model", provider: "openai" });
  }, []);
  const open = (id) => {
    if (models.includes(id)) setModal({ kind: "model", provider: id });
    else if (id === "onshape")
      setModal(
        status(id, cap).tone === "on"
          ? { kind: "onshape", view: "browse" }
          : { kind: "onshape" },
      );
    else if (id === "bambu") setModal({ kind: "bambu" });
    else setIsaac(true);
  };
  return (
    <div className="page integrations-page">
      <PageHeading
        title="Integrations"
        description="Connect the accounts and tools 6B works with."
      />
      {signInError && (
        <p className="connection-check" role="alert">
          {signInError}
        </p>
      )}
      {groups.map((group) => (
        <section className="app-group" key={group.name}>
          <h2>{group.name}</h2>
          <div className="app-grid">
            {group.items.map((item) => {
              const s = status(item.id, cap);
              return (
                <button
                  key={item.id}
                  className="app-card"
                  aria-label={`${item.name} — ${s.text}`}
                  onClick={() => open(item.id)}
                >
                  <span className="app-logo">
                    {item.id === "bambu" ? (
                      <Printer size={24} strokeWidth={1.5} />
                    ) : (
                      <ProviderLogo provider={item.id} size={26} />
                    )}
                  </span>
                  <span className="app-text">
                    <strong>{item.name}</strong>
                    <small>{item.tagline}</small>
                  </span>
                  <span className={`app-status is-${s.tone}`}>{s.text}</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {isaac && (
        <IsaacDetails
          configured={status("nvidia", cap).tone !== "off"}
          onClose={() => setIsaac(false)}
        />
      )}
    </div>
  );
}

function IsaacDetails({ configured, onClose }) {
  const [check, setCheck] = useState(null),
    [checking, setChecking] = useState(false);
  const runCheck = async () => {
    setChecking(true);
    try {
      const s = await api("/simulation/status");
      setCheck(
        !s.configured
          ? { ok: false, message: s.scope }
          : s.connected
            ? { ok: true, message: "Connected to the Isaac Sim session." }
            : {
                ok: false,
                message: s.error || "Configured, but not reachable.",
              },
      );
    } catch (err) {
      setCheck({ ok: false, message: err.message });
    } finally {
      setChecking(false);
    }
  };
  return (
    <Dialog title="NVIDIA Isaac Sim" onClose={onClose}>
      <div className="connector-detail">
        <div className="connection-summary">
          <span className="app-logo">
            <ProviderLogo provider="nvidia" size={26} />
          </span>
          <div>
            <strong>NVIDIA Isaac Sim</strong>
            <span>{configured ? "Configured" : "Not set up"}</span>
          </div>
        </div>
        <p>
          {configured
            ? "Watch your Brev simulation and export designs to it from a project’s Simulation tab."
            : "Set the 6B_ISAAC_* values in backend/.env to an existing Isaac Sim container, then restart 6B."}
        </p>
        <div className="connector-check">
          <button className="secondary" disabled={checking} onClick={runCheck}>
            {checking ? "Checking…" : "Check connection"}
          </button>
          {check && (
            <p
              className={`connection-check${check.ok ? " ok" : ""}`}
              role="status"
            >
              {check.message}
            </p>
          )}
        </div>
        <div className="form-actions">
          <button className="secondary" onClick={onClose}>
            Done
          </button>
          {configured && (
            <a className="primary" href="#tasks" onClick={onClose}>
              Open projects <ArrowRight size={14} />
            </a>
          )}
        </div>
      </div>
    </Dialog>
  );
}
