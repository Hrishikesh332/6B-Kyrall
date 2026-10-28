import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Zap,
} from "lucide-react";
import {
  MODEL_CONNECTION,
  api,
  modeLabel,
  rememberedConnection,
  saveConnection,
  savedConnection,
} from "./lib.js";
import ProviderLogo from "./ProviderLogo.jsx";

const MODEL_PROVIDERS = ["claude", "openai"];
// The reasoning efforts an OpenAI chat can run at, lightest first, as the server offers them.
export const EFFORTS = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
  { id: "xhigh", name: "Extra high" },
];
const DEFAULT_EFFORT = "medium";
const effortIndex = (id) =>
  Math.max(
    0,
    EFFORTS.findIndex((e) => e.id === id),
  );

// The model a new project runs on, listed from what the connected account can use:
// Claude Code's own model list, or the ChatGPT plan's. Picking one changes the
// connection's model, so later runs use it too. OpenAI chats also pick how hard the
// model reasons. `followUp` is the composer of a chat already running: there only an
// OpenAI connection can change, since its model and effort travel with each message.
export default function ModelPicker({ cap, onChange, onError, followUp }) {
  const [list, setList] = useState(null),
    [value, setValue] = useState(""),
    [effort, setEffort] = useState(cap?.reasoning_effort || DEFAULT_EFFORT),
    [busy, setBusy] = useState(false);
  const hasModels = MODEL_PROVIDERS.includes(cap?.provider);
  const openai = cap?.provider === "openai";
  useEffect(() => {
    if (!hasModels || (followUp && !openai)) return;
    let live = true;
    api("/integrations/model/models")
      .then((r) => {
        if (!live) return;
        setList(r.models);
        setValue(r.model || "");
      })
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [hasModels, followUp, openai, cap?.plan, cap?.model]);
  useEffect(() => {
    setEffort(cap?.reasoning_effort || DEFAULT_EFFORT);
  }, [cap?.reasoning_effort]);

  if (!hasModels || !list || (!openai && (followUp || list.length < 2)))
    return (
      <span className="composer-model">
        {hasModels ? (
          <ProviderLogo provider={cap.provider} size={13} />
        ) : (
          <span className="status-dot" />
        )}
        {modeLabel(cap)}
      </span>
    );

  // A model saved earlier but not listed now still shows as the current choice.
  const options = list.some((m) => m.id === value)
    ? list
    : [{ id: value, name: value || "Account default" }, ...list];
  // Save a new model and/or effort: in this browser when hosted, else on the server.
  const save = async ({ model = value, effort: nextEffort }) => {
    const previous = [value, effort];
    setValue(model);
    if (nextEffort) setEffort(nextEffort);
    setBusy(true);
    try {
      if (["browser", "site"].includes(cap.connection_source)) {
        // Hosted: the connection lives in this browser (or is the site's own, which it
        // starts on with nothing saved); only its model and effort change.
        const saved = savedConnection(MODEL_CONNECTION);
        saveConnection(
          MODEL_CONNECTION,
          {
            provider: cap.provider,
            ...saved,
            model,
            ...(nextEffort && { effort: nextEffort }),
          },
          !saved || rememberedConnection(MODEL_CONNECTION),
        );
      } else {
        await api("/integrations/model/choice", {
          method: "PUT",
          body: { model, ...(nextEffort && { effort: nextEffort }) },
        });
      }
      await onChange?.();
    } catch (err) {
      setValue(previous[0]);
      setEffort(previous[1]);
      onError?.(err);
    } finally {
      setBusy(false);
    }
  };

  if (openai)
    return (
      <ReasoningPicker
        provider={cap.provider}
        models={options}
        model={value}
        effort={effort}
        busy={busy}
        onModel={(model) => save({ model })}
        onEffort={(next) => save({ effort: next })}
      />
    );
  return (
    <label className="composer-model model-picker">
      <ProviderLogo provider={cap.provider} size={13} />
      <select
        aria-label="Model"
        value={value}
        disabled={busy}
        onChange={(e) => save({ model: e.target.value })}
      >
        {options.map((m) => (
          <option key={m.id} value={m.id} title={m.description || undefined}>
            {m.name}
          </option>
        ))}
      </select>
    </label>
  );
}

// A button showing the model and effort, which opens a panel with an effort slider and,
// a step away, the model list.
function ReasoningPicker({
  provider,
  models,
  model,
  effort,
  busy,
  onModel,
  onEffort,
}) {
  const [open, setOpen] = useState(false),
    [view, setView] = useState("effort"),
    [draft, setDraft] = useState(effortIndex(effort));
  const root = useRef(null),
    panel = useRef(null),
    [place, setPlace] = useState(null);
  const modelName = models.find((m) => m.id === model)?.name || model;
  useEffect(() => setDraft(effortIndex(effort)), [effort]);
  useEffect(() => {
    if (!open) return;
    const away = (e) =>
      !root.current?.contains(e.target) &&
      !panel.current?.contains(e.target) &&
      setOpen(false);
    const escape = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      root.current?.querySelector(".reasoning-trigger")?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  // The panel sits in <body>, above the trigger and aligned to its right edge, so the
  // composer's own clipping never cuts it off.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = root.current?.getBoundingClientRect();
      if (r)
        setPlace({
          right: Math.max(16, window.innerWidth - r.right),
          bottom: window.innerHeight - r.top + 10,
        });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);
  const shown = EFFORTS[draft];
  const commit = (index) => {
    setDraft(index);
    if (EFFORTS[index].id !== effort) onEffort(EFFORTS[index].id);
  };
  const toggle = () => {
    setView("effort");
    setOpen((o) => !o);
  };
  const fraction = draft / (EFFORTS.length - 1);

  return (
    <div className="composer-model reasoning-picker" ref={root}>
      <button
        type="button"
        className="reasoning-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model ${modelName}, ${EFFORTS[effortIndex(effort)].name} reasoning`}
        onClick={toggle}
      >
        <ProviderLogo provider={provider} size={13} />
        <span>{modelName}</span>
        <span className="reasoning-trigger-effort">
          {EFFORTS[effortIndex(effort)].name}
        </span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open &&
        place &&
        createPortal(
          <div
            ref={panel}
            className="reasoning-panel"
            style={place}
            role="dialog"
            aria-label={view === "effort" ? "Reasoning" : "Model"}
          >
            {view === "effort" ? (
              <>
                <div className="reasoning-head">
                  <Zap
                    size={18}
                    className="reasoning-bolt"
                    aria-hidden="true"
                  />
                  <div className="reasoning-title">
                    <strong>{shown.name}</strong>
                    <button
                      type="button"
                      className="reasoning-model"
                      onClick={() => setView("model")}
                    >
                      {modelName}
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  </div>
                  <button
                    type="button"
                    className="reasoning-reset"
                    aria-label="Reset to Medium"
                    title="Reset to Medium"
                    disabled={busy || EFFORTS[draft].id === DEFAULT_EFFORT}
                    onClick={() => commit(effortIndex(DEFAULT_EFFORT))}
                  >
                    <RotateCcw size={16} />
                  </button>
                </div>
                <div
                  className="reasoning-slider"
                  style={{ "--reasoning-fill": fraction }}
                >
                  <div className="reasoning-track" aria-hidden="true">
                    <div className="reasoning-fill" />
                    {EFFORTS.map((e, i) => (
                      <span
                        key={e.id}
                        className={`reasoning-stop${i <= draft ? " passed" : ""}`}
                        style={{
                          left: `calc(22px + (100% - 44px) * ${i / (EFFORTS.length - 1)})`,
                        }}
                      />
                    ))}
                    <div className="reasoning-thumb" />
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={EFFORTS.length - 1}
                    step={1}
                    value={draft}
                    disabled={busy}
                    aria-label="Reasoning effort"
                    aria-valuetext={shown.name}
                    onChange={(e) => setDraft(Number(e.target.value))}
                    onPointerUp={(e) => commit(Number(e.currentTarget.value))}
                    onKeyUp={(e) => commit(Number(e.currentTarget.value))}
                    onBlur={(e) => commit(Number(e.currentTarget.value))}
                  />
                </div>
                <div className="reasoning-scale" aria-hidden="true">
                  <span>Faster</span>
                  <span>Smarter</span>
                </div>
              </>
            ) : (
              <>
                <div className="reasoning-head">
                  <button
                    type="button"
                    className="reasoning-back"
                    aria-label="Back to reasoning"
                    onClick={() => setView("effort")}
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <div className="reasoning-title">
                    <strong>Model</strong>
                  </div>
                  <span className="reasoning-back-spacer" />
                </div>
                <ul className="reasoning-models">
                  {models.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        aria-pressed={m.id === model}
                        disabled={busy}
                        onClick={() => {
                          if (m.id !== model) onModel(m.id);
                          setView("effort");
                        }}
                      >
                        <span>{m.name}</span>
                        {m.id === model && (
                          <Check size={15} aria-hidden="true" />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
