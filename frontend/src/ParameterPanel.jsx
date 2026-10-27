import { useEffect, useState } from "react";
import { RefreshCw, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { IconButton } from "./ui.jsx";

const label = (name) => name.replaceAll("_", " ");
const decimals = (step) =>
  Math.min(4, Math.max(0, -Math.floor(Math.log10(step || 1))));

// Sliders come from the script header; a rebuild runs the script, not the AI.
export default function ParameterPanel({
  parameters,
  onRebuild,
  disabledReason,
  onClose,
}) {
  const initial = Object.fromEntries(parameters.map((p) => [p.name, p.value]));
  const [values, setValues] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const changed = parameters.filter((p) => values[p.name] !== p.value);
  const groups = [...new Set(parameters.map((p) => p.group || ""))];
  const set = (name, value) => {
    setError("");
    setValues((v) => ({ ...v, [name]: value }));
  };
  const rebuild = async () => {
    setBusy(true);
    setError("");
    try {
      await onRebuild(
        Object.fromEntries(changed.map((p) => [p.name, values[p.name]])),
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="parameter-panel" aria-label="Design parameters">
      <header>
        <div>
          <span className="eyebrow">PARAMETERS</span>
          <h4>
            <SlidersHorizontal size={13} aria-hidden="true" /> Driving
            dimensions
          </h4>
        </div>
        {onClose && (
          <IconButton label="Close parameters" onClick={onClose}>
            <X size={15} />
          </IconButton>
        )}
      </header>
      <div className="parameter-groups">
        {groups.map((group) => (
          <fieldset key={group || "general"} className="parameter-group">
            <legend>{group || "Dimensions"}</legend>
            {parameters
              .filter((p) => (p.group || "") === group)
              .map((p) =>
                p.type === "boolean" ? (
                  <label key={p.name} className="parameter-toggle">
                    <input
                      type="checkbox"
                      checked={!!values[p.name]}
                      disabled={busy}
                      onChange={(e) => set(p.name, e.target.checked)}
                    />
                    <span>
                      {label(p.name)}
                      {p.description && <small>{p.description}</small>}
                    </span>
                  </label>
                ) : (
                  <NumberParameter
                    key={p.name}
                    parameter={p}
                    value={values[p.name]}
                    disabled={busy}
                    onChange={(value) => set(p.name, value)}
                  />
                ),
              )}
          </fieldset>
        ))}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="parameter-actions">
        <button
          className="secondary"
          disabled={!changed.length || busy}
          onClick={() => setValues(initial)}
        >
          <RotateCcw size={13} /> Reset
        </button>
        <button
          className="primary"
          disabled={!changed.length || busy || !!disabledReason}
          onClick={rebuild}
        >
          <RefreshCw size={13} className={busy ? "spin" : ""} />
          {busy
            ? "Rebuilding…"
            : changed.length
              ? `Rebuild with ${changed.length} change${changed.length === 1 ? "" : "s"}`
              : "Rebuild"}
        </button>
      </div>
      <small className="parameter-note">
        {disabledReason ||
          "Rebuilds the saved script directly, without the AI, as a new version. Fit, overlap and print-bed checks run again."}
      </small>
    </section>
  );
}

function NumberParameter({ parameter: p, value, disabled, onChange }) {
  const span = p.max - p.min || 1;
  const at = (v) =>
    `${Math.min(100, Math.max(0, ((v - p.min) / span) * 100))}%`;
  const digits = p.type === "integer" ? 0 : decimals(p.step);
  const changed = value !== p.value;
  const commit = (raw) => {
    const number = Number(raw);
    if (raw === "" || !Number.isFinite(number)) return value;
    const clamped = Math.min(p.max, Math.max(p.min, number));
    const next =
      p.type === "integer"
        ? Math.round(clamped)
        : Number(clamped.toFixed(Math.max(digits, 3)));
    onChange(next);
    return next;
  };
  // The box keeps what is typed, so "25" can pass through "2" when the minimum is 10;
  // it applies at once while in range and is clamped when the field is left.
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const type = (raw) => {
    setText(raw);
    const number = Number(raw);
    if (raw !== "" && number >= p.min && number <= p.max) commit(raw);
  };
  const settle = () => setText(String(commit(text)));
  return (
    <div className={`parameter${changed ? " is-changed" : ""}`}>
      <div className="parameter-head">
        <label htmlFor={`param-${p.name}`} title={p.description || undefined}>
          {label(p.name)}
        </label>
        <input
          className="parameter-value"
          type="number"
          aria-label={`${label(p.name)} value`}
          min={p.min}
          max={p.max}
          step={p.step}
          value={text}
          disabled={disabled}
          onChange={(e) => type(e.target.value)}
          onBlur={settle}
          onKeyDown={(e) => {
            if (e.key === "Enter") settle();
          }}
        />
      </div>
      <div className="parameter-track">
        <input
          id={`param-${p.name}`}
          type="range"
          min={p.min}
          max={p.max}
          step={p.step}
          value={value}
          disabled={disabled}
          aria-valuetext={`${Number(value).toFixed(digits)}`}
          onChange={(e) => commit(e.target.value)}
        />
        {changed && (
          <button
            type="button"
            className="parameter-origin"
            style={{ left: at(p.value) }}
            aria-label={`Reset ${label(p.name)} to ${p.value}`}
            title={`Original ${p.value}`}
            onClick={() => onChange(p.value)}
          />
        )}
      </div>
      <div className="parameter-range" aria-hidden="true">
        <span>{p.min}</span>
        {p.description && <small>{p.description}</small>}
        <span>{p.max}</span>
      </div>
    </div>
  );
}
