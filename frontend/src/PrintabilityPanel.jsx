import { useState } from "react";
import {
  AlertTriangle,
  Check,
  CircleAlert,
  ExternalLink,
  Printer,
} from "lucide-react";
import { api } from "./lib.js";

export const printStatus = (report) => report?.printability?.status;

const STATUS = {
  ok: { label: "Ready to print", Icon: Check },
  review: { label: "Review before printing", Icon: AlertTriangle },
  problem: { label: "Will not print as is", Icon: CircleAlert },
};

const label = (name) => name.replaceAll("_", " ");

// Geometric FDM screen per part, in each part's STL print orientation.
export default function PrintabilityPanel({ report, context }) {
  const summary = report.printability;
  const { label: title, Icon } = STATUS[summary.status] || STATUS.review;
  const thresholds = report.parts[0]?.printability?.thresholds;
  return (
    <section
      className={`print-panel status-${summary.status}`}
      aria-label="Print check"
    >
      <h3>
        <Icon size={14} aria-hidden="true" /> {title}
      </h3>
      <ul className="print-legend" aria-label="Colour key">
        <li>
          <span className="swatch overhang" /> Overhang over{" "}
          {thresholds?.overhang_deg ?? 45}°
        </li>
        <li>
          <span className="swatch thin" /> Wall under{" "}
          {thresholds?.min_wall_mm ?? 1.2} mm
        </li>
        <li>
          <span className="swatch tiny" /> Under{" "}
          {thresholds?.min_feature_mm ?? 0.8} mm, may not print
        </li>
      </ul>
      <table className="print-table">
        <thead>
          <tr>
            <th scope="col">Part</th>
            <th scope="col">Overhang</th>
            <th scope="col">Min wall</th>
            <th scope="col">Bed</th>
          </tr>
        </thead>
        <tbody>
          {report.parts
            .filter((p) => p.printability)
            .map((p) => {
              const pr = p.printability;
              return (
                <tr key={p.part} className={`row-${pr.status}`}>
                  <th scope="row">
                    <span className={`print-dot ${pr.status}`} />
                    {label(p.part)}
                  </th>
                  <td>{pr.overhang_percent}%</td>
                  <td>
                    {pr.min_wall_mm != null ? `${pr.min_wall_mm} mm` : "—"}
                  </td>
                  <td>{pr.fits_print_bed ? "Fits" : "Too big"}</td>
                </tr>
              );
            })}
        </tbody>
      </table>
      {summary.issues.length > 0 && (
        <ul className="print-issues">
          {summary.issues.map((issue, i) => (
            <li key={i} className={issue.severity}>
              <strong>{label(issue.part)}</strong> {issue.message}
            </li>
          ))}
        </ul>
      )}
      {context?.taskId && <BambuSlice context={context} />}
      <small>
        <Printer size={11} aria-hidden="true" /> Screened in each part's STL
        print orientation. Not a slicer simulation: bridging, supports and
        material behaviour are not modelled.
      </small>
    </section>
  );
}

// A real slice of this build in the user's installed Bambu Studio.
function BambuSlice({ context }) {
  const [result, setResult] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      const query = context.buildId ? `?build_id=${context.buildId}` : "";
      setResult(
        await api(`/tasks/${context.taskId}/slice${query}`, { method: "POST" }),
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const open = async () => {
    try {
      await api(
        `/tasks/${context.taskId}/artifacts/${result.project_artifact_id}/open-in-bambu`,
        { method: "POST" },
      );
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <div className="bambu-slice">
      <div className="bambu-slice-head">
        <strong>Bambu Studio slice</strong>
        <button className="secondary" disabled={busy} onClick={run}>
          <Printer size={13} />
          {busy ? "Slicing…" : result ? "Slice again" : "Slice in Bambu Studio"}
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          <dl className="bambu-stats">
            <div>
              <dt>Print time</dt>
              <dd>{result.estimated_time || "—"}</dd>
            </div>
            <div>
              <dt>Filament</dt>
              <dd>
                {result.filament_g != null ? `${result.filament_g} g` : "—"}
                {result.filament_m != null && ` · ${result.filament_m} m`}
              </dd>
            </div>
            <div>
              <dt>Layers</dt>
              <dd>{result.layers ?? "—"}</dd>
            </div>
          </dl>
          <small className="bambu-profile">
            {result.printer} · {result.process} · {result.filament}
          </small>
          {result.warnings.length ? (
            <ul className="print-issues">
              {result.warnings.map((w, i) => (
                <li key={i} className="review">
                  <strong>Bambu Studio</strong> {w}
                </li>
              ))}
            </ul>
          ) : (
            <p className="bambu-clean">
              <Check size={12} /> No slicer warnings
            </p>
          )}
          {result.project_artifact_id && (
            <button className="secondary" onClick={open}>
              <ExternalLink size={13} /> Open in Bambu Studio
            </button>
          )}
        </>
      )}
    </div>
  );
}
