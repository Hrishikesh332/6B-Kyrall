import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, GitCompareArrows, X } from "lucide-react";
import { mountViewer } from "../viewer.js";
import { api } from "./lib.js";
import { meshBounds } from "./meshBounds.js";
import { ErrorNotice, Loading } from "./ui.jsx";

const label = (name) => name.replaceAll("_", " ");
const ORIGIN = {
  assistant: "AI build",
  user: "Manual build",
  parameter_rebuild: "Slider rebuild",
};
export const buildLabel = (build) =>
  `v${build.version} · ${ORIGIN[build.origin] || build.origin}`;
const signed = (value, digits = 1) =>
  `${value > 0 ? "+" : ""}${Number(value).toFixed(digits)}`;

// One side of the comparison; its camera mirrors the other side.
function ComparePane({
  mesh,
  frame,
  title,
  caption,
  onViewer,
  onCamera,
  state,
}) {
  const canvas = useRef(null),
    viewer = useRef(null),
    [error, setError] = useState(null);
  useEffect(() => {
    try {
      viewer.current = mountViewer(canvas.current, mesh, {
        sharedFrame: frame,
        still: true,
        onCamera: (c) => onCamera(c, viewer.current),
      });
      onViewer(viewer.current);
    } catch (err) {
      setError(err);
    }
    return () => {
      onViewer(null, viewer.current);
      viewer.current?.destroy();
      viewer.current = null;
    };
  }, [mesh, frame]);
  useEffect(() => {
    viewer.current?.update(state);
  }, [state]);
  return (
    <figure className="compare-pane">
      <figcaption>
        <strong>{title}</strong>
        <span>{caption}</span>
      </figcaption>
      <canvas
        ref={canvas}
        tabIndex={0}
        aria-label={`${title} 3D view. Drag to orbit; both views move together.`}
      />
      {error && <ErrorNotice error={error} />}
    </figure>
  );
}

export default function VersionCompare({
  taskId,
  artifacts,
  currentBuild,
  onClose,
}) {
  const [history, setHistory] = useState(null),
    [pair, setPair] = useState(null),
    [meshes, setMeshes] = useState(null),
    [report, setReport] = useState(null),
    [error, setError] = useState(null),
    [dim, setDim] = useState(true),
    [mode, setMode] = useState("side"),
    [focus, setFocus] = useState("");
  const viewers = useRef(new Set());
  useEffect(() => {
    api(`/tasks/${taskId}/builds`)
      .then((list) => {
        const shown = list.filter((b) =>
          artifacts.some(
            (a) =>
              a.metadata.kind === "mesh_preview" &&
              a.metadata.build_id === b.build_id,
          ),
        );
        setHistory(shown);
        const index = Math.max(
          0,
          shown.findIndex((b) => b.build_id === currentBuild),
        );
        const to = shown[index] || shown.at(-1);
        const from = shown[index - 1] || shown.find((b) => b !== to);
        setPair([from?.build_id, to?.build_id]);
      })
      .catch(setError);
  }, [taskId]);
  useEffect(() => {
    if (!pair?.[0] || !pair?.[1]) return;
    const controller = new AbortController();
    setMeshes(null);
    setReport(null);
    const meshOf = (build) => {
      const file = artifacts.find(
        (a) =>
          a.metadata.kind === "mesh_preview" && a.metadata.build_id === build,
      );
      return api(`/tasks/${taskId}/artifacts/${file.id}/content`, {
        raw: true,
        signal: controller.signal,
      }).then((r) => r.json());
    };
    const params = new URLSearchParams({
      from_build: pair[0],
      to_build: pair[1],
    });
    Promise.all([
      meshOf(pair[0]),
      meshOf(pair[1]),
      api(`/tasks/${taskId}/compare?${params}`, { signal: controller.signal }),
    ])
      .then(([before, after, changes]) => {
        setMeshes([before, after]);
        setReport(changes);
      })
      .catch((err) => !controller.signal.aborted && setError(err));
    return () => controller.abort();
  }, [pair?.[0], pair?.[1]]);
  // Both versions share one frame so equal sizes look equal.
  const frame = useMemo(
    () =>
      meshes && meshBounds({ parts: [...meshes[0].parts, ...meshes[1].parts] }),
    [meshes],
  );
  const unchanged = (report?.parts || [])
    .filter((p) => p.status === "unchanged")
    .map((p) => p.part);
  const viewState = { ghosted: dim ? unchanged : [], highlight: focus };
  // Overlay: the earlier version drawn faintly in the same view as the later one.
  const overlay = useMemo(
    () =>
      meshes && {
        ...meshes[1],
        parts: [
          ...meshes[1].parts,
          ...meshes[0].parts.map((p) => ({ ...p, name: `before · ${p.name}` })),
        ],
      },
    [meshes],
  );
  const overlayState = {
    ghosted: meshes ? meshes[0].parts.map((p) => `before · ${p.name}`) : [],
    highlight: focus,
  };
  const sync = (camera, source) => {
    for (const viewer of viewers.current)
      if (viewer !== source) viewer.setCamera(camera);
  };
  const register = (viewer, gone) => {
    if (gone) viewers.current.delete(gone);
    if (viewer) viewers.current.add(viewer);
  };
  const byId = Object.fromEntries((history || []).map((b) => [b.build_id, b]));
  const choose = (side, value) =>
    setPair((p) => (side === 0 ? [value, p[1]] : [p[0], value]));
  return (
    <div className="version-compare">
      <header className="compare-bar">
        <GitCompareArrows size={16} aria-hidden="true" />
        {history && pair && (
          <>
            <select
              aria-label="Earlier version"
              value={pair[0] || ""}
              onChange={(e) => choose(0, e.target.value)}
            >
              {history.map((b) => (
                <option
                  key={b.build_id}
                  value={b.build_id}
                  disabled={b.build_id === pair[1]}
                >
                  {buildLabel(b)}
                </option>
              ))}
            </select>
            <ArrowRight size={14} aria-hidden="true" />
            <select
              aria-label="Later version"
              value={pair[1] || ""}
              onChange={(e) => choose(1, e.target.value)}
            >
              {history.map((b) => (
                <option
                  key={b.build_id}
                  value={b.build_id}
                  disabled={b.build_id === pair[0]}
                >
                  {buildLabel(b)}
                </option>
              ))}
            </select>
          </>
        )}
        <div
          className="segmented small"
          role="group"
          aria-label="Compare layout"
        >
          <button
            aria-pressed={mode === "side"}
            onClick={() => setMode("side")}
          >
            Side by side
          </button>
          <button
            aria-pressed={mode === "overlay"}
            onClick={() => setMode("overlay")}
          >
            Overlay
          </button>
        </div>
        <label className="inline-check" hidden={mode === "overlay"}>
          <input
            type="checkbox"
            checked={dim}
            onChange={(e) => setDim(e.target.checked)}
          />
          Dim unchanged parts
        </label>
        <button className="secondary compare-close" onClick={onClose}>
          <X size={14} /> Done
        </button>
      </header>
      {error && <ErrorNotice error={error} />}
      {!error && (!meshes || !report) && (
        <Loading>Loading both versions…</Loading>
      )}
      {meshes && report && frame && (
        <>
          {mode === "overlay" ? (
            <div className="compare-panes single">
              <ComparePane
                key={`overlay-${pair[0]}-${pair[1]}`}
                mesh={overlay}
                frame={frame}
                title="After, with Before shown faintly"
                caption={`${byId[pair[1]] ? buildLabel(byId[pair[1]]) : ""} over ${byId[pair[0]] ? buildLabel(byId[pair[0]]) : ""}`}
                onViewer={register}
                onCamera={sync}
                state={overlayState}
              />
            </div>
          ) : (
            <div className="compare-panes">
              {[0, 1].map((side) => (
                <ComparePane
                  key={`${side}-${pair[side]}`}
                  mesh={meshes[side]}
                  frame={frame}
                  title={side ? "After" : "Before"}
                  caption={byId[pair[side]] ? buildLabel(byId[pair[side]]) : ""}
                  onViewer={register}
                  onCamera={sync}
                  state={viewState}
                />
              ))}
            </div>
          )}
          <ChangeReport report={report} onFocus={setFocus} />
        </>
      )}
    </div>
  );
}

export function ChangeReport({ report, onFocus = () => {} }) {
  const { before, after } = report.checks;
  const checkRows = [
    [
      "Validation",
      before.passed ? "Passed" : "Failed",
      after.passed ? "Passed" : "Failed",
    ],
    ["Print check", before.printability || "—", after.printability || "—"],
    ["Overlaps", before.interferences, after.interferences],
    [
      "Overall size (mm)",
      before.assembly_bounds_mm.map((v) => v.toFixed(1)).join(" × "),
      after.assembly_bounds_mm.map((v) => v.toFixed(1)).join(" × "),
    ],
  ];
  return (
    <section className="change-report" aria-label="Change report">
      <h3>What changed</h3>
      <ul className="change-summary">
        {report.summary.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
      <table className="change-table">
        <thead>
          <tr>
            <th scope="col">Part</th>
            <th scope="col">Change</th>
            <th scope="col">Volume</th>
            <th scope="col">Size (mm)</th>
            <th scope="col">Moved (mm)</th>
          </tr>
        </thead>
        <tbody>
          {report.parts.map((p) => (
            <tr
              key={p.part}
              className={`change-${p.status}`}
              onMouseEnter={() => onFocus(p.part)}
              onMouseLeave={() => onFocus("")}
            >
              <th scope="row">{label(p.part)}</th>
              <td>
                <span className={`change-badge ${p.status}`}>{p.status}</span>
              </td>
              <td>
                {p.volume_delta_percent != null
                  ? `${signed(p.volume_delta_percent)}%`
                  : "—"}
              </td>
              <td>
                {Array.isArray(p.size_mm?.[0])
                  ? p.size_delta_mm.some((d) => Math.abs(d) > 0.01)
                    ? `${p.size_mm[0].map((v) => +v.toFixed(1)).join("×")} → ${p.size_mm[1].map((v) => +v.toFixed(1)).join("×")}`
                    : "same"
                  : (p.size_mm || []).map((v) => +v.toFixed(1)).join("×")}
              </td>
              <td>
                {p.moved_mm?.some((d) => Math.abs(d) > 0.01)
                  ? p.moved_mm.map((d) => signed(d)).join(", ")
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {report.parameters.length > 0 && (
        <div className="change-block">
          <h4>Parameters</h4>
          <ul className="change-params">
            {report.parameters.map((p) => (
              <li key={p.name}>
                <span>{label(p.name)}</span>
                <code>{String(p.old ?? "—")}</code>
                <ArrowRight size={11} aria-hidden="true" />
                <code>{String(p.new ?? "—")}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="change-block">
        <h4>Checks</h4>
        <table className="change-checks">
          <tbody>
            {checkRows.map(([name, a, b]) => (
              <tr
                key={name}
                className={String(a) !== String(b) ? "differs" : ""}
              >
                <th scope="row">{name}</th>
                <td>{String(a)}</td>
                <td aria-hidden="true">→</td>
                <td>{String(b)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.source_diff.text && (
        <details className="change-block change-diff">
          <summary>
            Source changes
            <span>
              +{report.source_diff.added_lines} −
              {report.source_diff.removed_lines} lines
            </span>
          </summary>
          <pre>
            {report.source_diff.text.split("\n").map((line, i) => (
              <span
                key={i}
                className={
                  line.startsWith("+") && !line.startsWith("+++")
                    ? "add"
                    : line.startsWith("-") && !line.startsWith("---")
                      ? "del"
                      : line.startsWith("@@")
                        ? "hunk"
                        : ""
                }
              >
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
        </details>
      )}
      <small>{report.note}</small>
    </section>
  );
}
