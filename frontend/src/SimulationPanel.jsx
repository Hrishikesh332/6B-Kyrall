import { useEffect, useRef, useState } from "react";
import { Activity, Camera, RefreshCw } from "lucide-react";
import { api, latestArtifacts } from "./lib.js";
import { ErrorNotice, Loading } from "./ui.jsx";

export default function SimulationPanel({ task, refresh, openArtifact }) {
  const [status, setStatus] = useState(null),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState(null),
    [capturing, setCapturing] = useState(false);
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
    return () => {
      active.current = false;
      controller.current?.abort();
      if (snapshotUrl.current) URL.revokeObjectURL(snapshotUrl.current);
    };
  }, []);
  const capture = async () => {
    setCapturing(true);
    setError(null);
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
      if (active.current) setError(e);
    } finally {
      if (active.current) setCapturing(false);
    }
  };
  const sources = latestArtifacts(task.artifacts).filter(
    (a) => a.metadata.kind === "cad_source" && a.metadata.validation_passed,
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
  return (
    <div className="simulation-panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">NVIDIA · ISAAC SIM</span>
          <h2>See the scene. Inspect the evidence.</h2>
        </div>
        <button className="secondary" disabled={busy} onClick={readStatus}>
          <RefreshCw size={15} />
          {busy ? "Connecting…" : "Refresh state"}
        </button>
      </div>
      {error && <ErrorNotice error={error} />}
      {!status && busy ? (
        <Loading>Reading your Brev simulation…</Loading>
      ) : (
        <>
          <div className="simulation-summary">
            <div>
              <span
                className={`status-dot ${status?.connected ? "completed" : "failed"}`}
              />
              <strong>
                {status?.connected
                  ? `Isaac Sim ${state.isaac_sim}`
                  : status?.configured
                    ? "Connection unavailable"
                    : "Isaac not configured"}
              </strong>
              <span className="muted">
                {status?.observed_at
                  ? `Observed ${new Date(status.observed_at * 1000).toLocaleTimeString()}`
                  : ""}
              </span>
            </div>
            <p>{status?.error || status?.scope}</p>
          </div>
          {state && (
            <>
              <div className="simulation-metrics">
                <div>
                  <small>Scene state</small>
                  <strong>
                    {state.stopped
                      ? "Stopped"
                      : state.active_motion
                        ? "Moving"
                        : "Idle"}
                  </strong>
                </div>
                <div>
                  <small>Contact forces</small>
                  <strong>
                    {state.jaw_net_contact_force_N
                      ?.map((n) => n.toFixed(2))
                      .join(" / ") || "—"}{" "}
                    N
                  </strong>
                </div>
                <div>
                  <small>Simulation time</small>
                  <strong>{state.simulation_time_s?.toFixed(2)} s</strong>
                </div>
                <div>
                  <small>CAD validation</small>
                  <strong>Not linked</strong>
                </div>
              </div>
              <div className="simulation-viewport">
                {snapshot ? (
                  <img
                    src={snapshot.url}
                    alt={`Isaac simulation viewport captured at ${snapshot.at}`}
                  />
                ) : (
                  <div>
                    <Activity size={36} />
                    <p>Capture the current Isaac viewport</p>
                    <small>A timestamped snapshot of the existing scene.</small>
                  </div>
                )}
              </div>
              <div className="button-row">
                <button
                  className="secondary"
                  disabled={capturing}
                  onClick={capture}
                >
                  <Camera size={15} />
                  {capturing ? "Capturing…" : "Capture viewport"}
                </button>
                {snapshot && (
                  <small className="muted">Captured {snapshot.at}</small>
                )}
              </div>
              {result && (
                <div
                  className={`validation-panel ${result.simulation_pass ? "" : "warning"}`}
                >
                  <h3>
                    Last scene test ·{" "}
                    {result.simulation_pass
                      ? "conditional simulation pass"
                      : "did not pass"}
                  </h3>
                  <ul>
                    {(result.errors || []).map((e) => (
                      <li key={e}>{e.replaceAll("_", " ")}</li>
                    ))}
                    <li>
                      Sustained valid hold:{" "}
                      {result.maximum_valid_hold_s ?? "not reported"} s
                    </li>
                  </ul>
                  <small>
                    {result.scope}. This result is for the simulation scene, not
                    the open CAD design.
                  </small>
                </div>
              )}
            </>
          )}
        </>
      )}
      <div className="simulation-export">
        <h3>Prepare this design for Isaac</h3>
        <p>
          Export the validated assembly as USD in metres, with collision meshes
          and a manifest tied to the exact CAD revision.
        </p>
        {sources.length ? (
          <>
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
            <button
              className="primary"
              disabled={exporting}
              onClick={exportScene}
            >
              {exporting ? "Preparing scene…" : "Export Isaac scene"}
            </button>
          </>
        ) : (
          <p className="muted">
            Generate and validate a CAD model to enable export.
          </p>
        )}
        <small>
          The export starts as a static collision scene. Define joints, drives,
          mass and measured contact properties in Isaac before grasp testing. It
          does not change the connected scene.
        </small>
        {exported && (
          <div className="button-row">
            <button
              className="secondary"
              onClick={() => openArtifact(task.id, exported.scene.id)}
            >
              USD scene
            </button>
            <button
              className="secondary"
              onClick={() => openArtifact(task.id, exported.manifest.id)}
            >
              Test manifest
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
