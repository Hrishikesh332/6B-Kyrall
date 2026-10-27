import { useEffect, useRef, useState } from "react";
import { Camera, RefreshCw, FileBox, FileJson } from "lucide-react";
import { api, latestArtifacts } from "./lib.js";
import { ErrorNotice, Loading } from "./ui.jsx";

const sourceKinds = ["cad_source", "cad_script"];

export default function SimulationPanel({ task, refresh, openArtifact }) {
  const [status, setStatus] = useState(null),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState(null),
    [capturing, setCapturing] = useState(false),
    [captureError, setCaptureError] = useState(null);
  const [source, setSource] = useState(""),
    [exporting, setExporting] = useState(false),
    [exported, setExported] = useState(null);
  const snapshotUrl = useRef(null),
    active = useRef(true),
    controller = useRef(null);
  const readStatus = async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError(null);
    try {
      const next = await api("/simulation/status", { signal: request.signal });
      if (!request.signal.aborted) setStatus(next);
    } catch (e) {
      if (!request.signal.aborted) setError(e);
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  };
  useEffect(() => {
    active.current = true;
    void readStatus();
    const poll = setInterval(() => void readStatus(), 15000);
    return () => {
      active.current = false;
      clearInterval(poll);
      controller.current?.abort();
      if (snapshotUrl.current) URL.revokeObjectURL(snapshotUrl.current);
    };
  }, []);
  const capture = async () => {
    setCapturing(true);
    setCaptureError(null);
    try {
      const blob = await (
        await api("/simulation/snapshot", { raw: true })
      ).blob();
      if (!active.current) return;
      if (snapshotUrl.current) URL.revokeObjectURL(snapshotUrl.current);
      snapshotUrl.current = URL.createObjectURL(blob);
      setSnapshot({
        url: snapshotUrl.current,
        at: new Date().toLocaleTimeString(),
      });
    } catch (e) {
      if (active.current) setCaptureError(e);
    } finally {
      if (active.current) setCapturing(false);
    }
  };
  const sources = latestArtifacts(task.artifacts).filter(
    (a) =>
      sourceKinds.includes(a.metadata.kind) && a.metadata.validation_passed,
  );
  const selected = sources.find((a) => a.id === source) || sources[0];
  const exportScene = async () => {
    setExporting(true);
    setError(null);
    try {
      const result = await api(`/tasks/${task.id}/simulation-export`, {
        method: "POST",
        body: { source_artifact_id: selected.id },
      });
      if (active.current) setExported(result);
      await refresh();
    } catch (e) {
      if (active.current) setError(e);
    } finally {
      if (active.current) setExporting(false);
    }
  };
  const state = status?.state,
    result = state?.last_task?.result;
  const forces = state?.jaw_net_contact_force_N;
  const objects = Object.entries(state?.objects || {});
  const connection = !status
    ? { cls: "", label: "Connecting…" }
    : status.connected
      ? { cls: "available", label: `Connected · v${state.isaac_sim}` }
      : status.configured
        ? { cls: "failed", label: "Unavailable" }
        : { cls: "", label: "Not configured" };
  return (
    <div className="simulation-panel">
      <header className="simulation-header">
        <div>
          <h2>Isaac Sim</h2>
          <div className="simulation-meta">
            <span className={`badge ${connection.cls}`}>
              <span className="status-dot" />
              {connection.label}
            </span>
            {status?.container && <span className="tag">{status.container}</span>}
            {state?.stop_applied && (
              <span className="badge failed">
                <span className="status-dot" />
                Stop applied
              </span>
            )}
            {status?.observed_at && (
              <small className="muted">
                Observed {new Date(status.observed_at * 1000).toLocaleTimeString()}
              </small>
            )}
          </div>
        </div>
        <button
          className="icon-button"
          aria-label="Refresh state"
          title="Refresh state"
          disabled={busy}
          onClick={readStatus}
        >
          <RefreshCw size={15} className={busy ? "spin" : ""} />
        </button>
      </header>
      {error && <ErrorNotice error={error} />}
      {!status && busy ? (
        <Loading>Reading your Brev simulation…</Loading>
      ) : !state ? (
        <p className="simulation-empty muted">
          {status?.error ||
            "Set the Isaac SSH host, container, Python path and MCP script to observe a scene."}
        </p>
      ) : (
        <>
          <dl className="simulation-metrics">
            <div>
              <dt>State</dt>
              <dd>
                {state.stopped
                  ? "Stopped"
                  : state.pick_place_phase
                    ? state.pick_place_phase.replaceAll("_", " ")
                    : state.active_motion
                      ? "Moving"
                      : "Idle"}
              </dd>
            </div>
            <div>
              <dt>Peak jaw force</dt>
              <dd>
                {state.peak_jaw_force_N != null
                  ? `${state.peak_jaw_force_N.toFixed(2)} N`
                  : "—"}
              </dd>
              {!!forces?.length && (
                <small className="muted">
                  {forces.map((n) => n.toFixed(2)).join(" / ")} N now
                </small>
              )}
            </div>
            <div>
              <dt>Sim time</dt>
              <dd>
                {state.simulation_time_s != null
                  ? `${state.simulation_time_s.toFixed(2)} s`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Grasp</dt>
              <dd>{state.grasp_qualified ? "Qualified" : "Not yet"}</dd>
            </div>
          </dl>
          {!!objects.length && (
            <div className="simulation-objects">
              <h3>Scene objects</h3>
              <ul>
                {objects.map(([name, obj]) => {
                  const [x, y, z] = obj.pose_xyzw || [];
                  const moving = (obj.velocity || []).some(
                    (v) => Math.abs(v) > 1e-3,
                  );
                  return (
                    <li key={name}>
                      <span className="object-name">
                        {name.replaceAll("_", " ")}
                      </span>
                      <span className="object-pose muted">
                        {[x, y, z].every((n) => n != null)
                          ? `${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)} m`
                          : "—"}
                      </span>
                      {moving && <span className="object-moving">moving</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <div className={`simulation-viewport ${snapshot ? "has-image" : ""}`}>
            {snapshot ? (
              <img
                src={snapshot.url}
                alt={`Isaac simulation viewport captured at ${snapshot.at}`}
              />
            ) : (
              <div className="viewport-empty">
                <Camera size={22} />
                {captureError ? (
                  <>
                    <strong>Isaac didn't return a frame</strong>
                    <small>
                      {/did not complete/i.test(captureError.message)
                        ? "The Isaac viewport isn't rendering. Restart the Isaac control session on Brev, then try again."
                        : captureError.message}
                    </small>
                  </>
                ) : (
                  <small>See what the scene looks like right now.</small>
                )}
              </div>
            )}
            <button
              className={
                snapshot ? "secondary viewport-recapture" : "secondary"
              }
              disabled={capturing}
              onClick={capture}
            >
              <Camera size={15} />
              {capturing
                ? "Capturing…"
                : snapshot
                  ? `${snapshot.at} · Recapture`
                  : captureError
                    ? "Try again"
                    : "Capture viewport"}
            </button>
          </div>
          {result && (
            <div
              className={`simulation-result ${result.simulation_pass ? "pass" : "fail"}`}
            >
              <strong>
                Last scene test ·{" "}
                {result.simulation_pass ? "conditional pass" : "did not pass"}
              </strong>
              <ul>
                {(result.errors || []).map((e) => (
                  <li key={e}>{e.replaceAll("_", " ")}</li>
                ))}
                <li>
                  Valid hold: {result.maximum_valid_hold_s ?? "not reported"} s
                </li>
              </ul>
            </div>
          )}
          <p className="simulation-scope">
            Observed scene only · not linked to this design
          </p>
        </>
      )}
      <section className="simulation-export">
        <div>
          <h3>Export to Isaac</h3>
          <p className="muted">
            Static USD collision scene in metres, tied to the CAD revision.
          </p>
        </div>
        {selected ? (
          <div className="simulation-export-row">
            {sources.length > 1 && (
              <select
                aria-label="CAD source for Isaac export"
                value={selected.id}
                onChange={(e) => {
                  setSource(e.target.value);
                  setExported(null);
                }}
              >
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · v{s.version}
                  </option>
                ))}
              </select>
            )}
            <button
              className="primary"
              disabled={exporting}
              onClick={exportScene}
            >
              {exporting ? "Exporting…" : "Export scene"}
            </button>
          </div>
        ) : (
          <p className="muted">Needs a validated CAD model.</p>
        )}
        {exported && (
          <div className="button-row">
            <button
              className="secondary"
              onClick={() => openArtifact(task.id, exported.scene.id)}
            >
              <FileBox size={15} />
              USD scene
            </button>
            <button
              className="secondary"
              onClick={() => openArtifact(task.id, exported.manifest.id)}
            >
              <FileJson size={15} />
              Test manifest
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
