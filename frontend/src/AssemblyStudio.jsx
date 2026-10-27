import { useState } from "react";
import {
  ChevronDown,
  Pause,
  Play,
  ChevronUp,
  Crosshair,
  EyeOff,
  Ghost,
  Send,
  Square,
  Video,
  X,
} from "lucide-react";
import { IconButton } from "./ui.jsx";

const label = (name) => name.replaceAll("_", " ");

// Compact transport for the viewer's bottom bar.
export function SequencePlayback({
  playing,
  disabled,
  progress,
  speed,
  timelineLabel,
  playLabel,
  onPlay,
  onSeek,
  onSpeed,
}) {
  return (
    <div className="viewer-transport">
      <button
        className="pill-button"
        aria-label={`${playing ? "Pause" : "Play"} ${playLabel}`}
        disabled={disabled}
        onClick={onPlay}
      >
        {playing ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <input
        type="range"
        aria-label={timelineLabel}
        min="0"
        max="1"
        step=".001"
        value={progress}
        disabled={disabled}
        style={{ "--fill": `${progress * 100}%` }}
        onChange={(e) => onSeek(Number(e.target.value))}
      />
      <select
        className="pill-select"
        aria-label="Playback speed"
        value={speed}
        disabled={disabled}
        onChange={(e) => onSpeed(Number(e.target.value))}
      >
        {[0.25, 0.5, 1, 2].map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
    </div>
  );
}

export function AssemblySequence({
  order,
  sequence,
  recording,
  canRecord,
  reverse,
  ghostUpcoming,
  onJump,
  onMove,
  onReverse,
  onGhost,
  onRecord,
}) {
  const step = sequence.step,
    total = order.length;
  return (
    <div className="assembly-sequence">
      <div className="segmented" role="group" aria-label="Sequence direction">
        <button
          aria-pressed={!reverse}
          disabled={recording}
          onClick={() => onReverse(false)}
        >
          Assemble
        </button>
        <button
          aria-pressed={reverse}
          disabled={recording}
          onClick={() => onReverse(true)}
        >
          Disassemble
        </button>
      </div>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={ghostUpcoming}
          onChange={(e) => onGhost(e.target.checked)}
        />
        Show remaining parts as ghosts
      </label>
      <ol className="assembly-steps" aria-label="Assembly steps">
        {order.map((name, i) => {
          const done = reverse ? i > step : i < step;
          return (
            <li
              key={name}
              className={i === step ? "current" : done ? "done" : ""}
            >
              <button
                className="step-name"
                aria-current={i === step ? "step" : undefined}
                onClick={() => onJump(i)}
              >
                <span>{i + 1}</span>
                {label(name)}
              </button>
              <IconButton
                label={`Move ${label(name)} earlier`}
                disabled={i === 0 || recording}
                onClick={() => onMove(i, -1)}
              >
                <ChevronUp size={13} />
              </IconButton>
              <IconButton
                label={`Move ${label(name)} later`}
                disabled={i === total - 1 || recording}
                onClick={() => onMove(i, 1)}
              >
                <ChevronDown size={13} />
              </IconButton>
            </li>
          );
        })}
      </ol>
      <button
        className={recording ? "record-button is-recording" : "record-button"}
        disabled={!canRecord}
        onClick={onRecord}
      >
        {recording ? <Square size={13} /> : <Video size={14} />}
        {recording ? "Stop recording" : "Record assembly video"}
      </button>
      <small>
        {canRecord
          ? "Records the full sequence at the current camera and speed. Orbit or turn on Turntable while it plays."
          : "This browser cannot record the canvas. Use a Chromium, Firefox or Safari release with MediaRecorder."}{" "}
        Sequence and travel paths are presentation only; fits and insertion
        clearances are not simulated.
      </small>
    </div>
  );
}

const fmt = (v) => (Math.round(v * 10) / 10).toString();

// Suggestions come from what 6B measured about this part: print-check
// findings first, then assembly overlaps and mates, then its proportions.
export function suggestChanges({
  name,
  bounds,
  part,
  interferences = [],
  partCount = 1,
}) {
  const out = [];
  const add = (text, reason, source) => {
    if (!out.some((s) => s.text === text)) out.push({ text, reason, source });
  };
  const print = part?.printability;
  const limits = print?.thresholds || {};
  for (const issue of print?.issues || []) {
    if (issue.check === "bed_fit")
      add(
        "Split it into pieces that fit the print bed",
        "Larger than the print bed",
        "Print check",
      );
    if (issue.check === "small_features")
      add(
        `Thicken features under ${limits.min_feature_mm ?? 0.8} mm`,
        `Thinnest section ${print.min_wall_mm} mm`,
        "Print check",
      );
    if (issue.check === "thin_walls")
      add(
        `Thicken walls to at least ${limits.min_wall_mm ?? 1.2} mm`,
        `Minimum wall ${print.min_wall_mm} mm`,
        "Print check",
      );
    if (issue.check === "overhang")
      add(
        "Chamfer overhangs to 45° so it prints without supports",
        `${print.overhang_percent}% of the surface overhangs`,
        "Print check",
      );
  }
  const overlap = interferences.find((i) => i.parts?.includes(name));
  if (overlap) {
    const other = overlap.parts.find((p) => p !== name);
    add(
      `Remove the overlap with ${label(other)}`,
      `${fmt(overlap.overlap_mm3)} mm³ of shared volume`,
      "Assembly",
    );
  } else if (partCount > 1) {
    add(
      "Add 0.2 mm fit clearance to mating faces",
      `Mates with ${partCount - 1} other part${partCount > 2 ? "s" : ""}`,
      "Assembly",
    );
  }
  const [thin, , long] = [...(bounds?.size || [])].sort((a, b) => a - b);
  if (long >= 80 && long / thin >= 5)
    add(
      `Add stiffening ribs along the ${fmt(long)} mm length`,
      `${Math.round(long / thin)}:1 length to depth`,
      "Shape",
    );
  const box = (bounds?.size || []).reduce((a, b) => a * b, 1);
  if (part?.volume_mm3 > 20000 && part.volume_mm3 / box > 0.6)
    add(
      "Reduce mass with lightening pockets",
      `${Math.round((100 * part.volume_mm3) / box)}% of its envelope is solid`,
      "Shape",
    );
  add(
    "Fillet sharp outer edges by 1 mm",
    "Softer edges, fewer stress points",
    "General",
  );
  if (print && !print.issues?.length && out.length < 3)
    add(
      "Increase wall thickness by 1 mm",
      `Stiffer; minimum wall is ${print.min_wall_mm ?? "—"} mm`,
      "General",
    );
  return out.slice(0, 4);
}

const IMPORT_REQUESTS = [
  {
    text: "Design a mounting bracket for this part",
    reason: "Fits its measured envelope",
    source: "Design",
  },
  {
    text: "Design a protective cover with 0.4 mm clearance",
    reason: "Wraps the part with print tolerance",
    source: "Design",
  },
  {
    text: "Suggest changes to make it easier to print",
    reason: "Listed as edits to make in Onshape",
    source: "Design",
  },
];

const PRINT_STATUS = {
  ok: "Prints cleanly",
  review: "Review before printing",
  problem: "Print problems",
};

export function ComponentPanel({
  name,
  bounds,
  step,
  part,
  interferences,
  partCount,
  isolated,
  onFocus,
  onIsolate,
  onHide,
  onClear,
  onRevise,
  reviseNote,
  reviseMode = "cad",
}) {
  const imported = reviseMode === "onshape";
  const [text, setText] = useState(""),
    [sending, setSending] = useState(false);
  const suggestions = imported
    ? IMPORT_REQUESTS
    : suggestChanges({ name, bounds, part, interferences, partCount });
  const print = part?.printability;
  const submit = async (e) => {
    e.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      // Keep the draft when sending fails so it can be retried.
      if ((await onRevise(name, text.trim())) !== false) setText("");
    } finally {
      setSending(false);
    }
  };
  return (
    <section className="component-panel" aria-label="Selected component">
      <header>
        <div>
          <span className="eyebrow">
            SELECTED COMPONENT
            {step && ` · STEP ${step[0]}/${step[1]}`}
          </span>
          <h4>{label(name)}</h4>
        </div>
        <IconButton label="Clear selection" onClick={onClear}>
          <X size={15} />
        </IconButton>
      </header>
      <dl className="component-size" aria-label="Envelope in mm">
        {["X", "Y", "Z"].map((axis, i) => (
          <div key={axis}>
            <dt>{axis}</dt>
            <dd>
              {bounds.size[i].toFixed(1)}
              <small>mm</small>
            </dd>
          </div>
        ))}
      </dl>
      <p className="component-meta">
        <span>{bounds.triangles.toLocaleString()} triangles</span>
        {part?.volume_mm3 != null && (
          <span>{(part.volume_mm3 / 1000).toFixed(1)} cm³</span>
        )}
        {print && (
          <span className={`component-print ${print.status}`}>
            <i aria-hidden="true" />
            {PRINT_STATUS[print.status] || PRINT_STATUS.review}
          </span>
        )}
      </p>
      <div className="component-actions">
        <button className="secondary" onClick={onFocus}>
          <Crosshair size={13} /> Focus
        </button>
        <button
          className="secondary"
          aria-pressed={isolated}
          onClick={onIsolate}
        >
          <Ghost size={13} /> Isolate
        </button>
        <button className="secondary" onClick={onHide}>
          <EyeOff size={13} /> Hide
        </button>
      </div>
      {onRevise ? (
        <form className="component-revise" onSubmit={submit}>
          <span className="component-revise-title">
            {imported ? "Suggested requests" : "Suggested for this part"}
          </span>
          <ul className="quick-changes">
            {suggestions.map((s) => (
              <li key={s.text}>
                <button
                  type="button"
                  aria-label={s.text}
                  onClick={() =>
                    setText((t) =>
                      t.trim() ? `${t.trim()}. ${s.text}` : s.text,
                    )
                  }
                >
                  <span className="quick-change-text">{s.text}</span>
                  <span className="quick-change-why">
                    <em>{s.source}</em> {s.reason}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="component-composer">
            <label htmlFor="component-change" className="sr-only">
              {imported ? "Design around this part" : "Revise this component"}
            </label>
            <textarea
              id="component-change"
              rows={3}
              maxLength={4000}
              value={text}
              placeholder={
                imported
                  ? `e.g. Design a cover that fits ${label(name)}…`
                  : `Describe a change to ${label(name)}…`
              }
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
              }}
            />
            <div className="component-composer-bar">
              <kbd>⌘ ↵</kbd>
              <button
                className="primary"
                aria-label={
                  imported ? "Send request" : "Send component revision"
                }
                disabled={!text.trim() || sending}
              >
                {sending ? "Sending…" : imported ? "Send" : "Revise"}
                <Send size={12} />
              </button>
            </div>
          </div>
          <small>
            {imported
              ? "Onshape geometry is read-only. New parts are designed around its measured size and position."
              : "Only this part is rebuilt; fit and overlap checks rerun on the new version."}
          </small>
        </form>
      ) : (
        reviseNote && <small className="component-note">{reviseNote}</small>
      )}
    </section>
  );
}
