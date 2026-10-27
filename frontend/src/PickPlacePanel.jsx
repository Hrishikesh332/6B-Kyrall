import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  HandGrab,
  Home,
  Repeat,
  Rotate3d,
  X,
} from "lucide-react";
import { api, latestArtifacts } from "./lib.js";
import { mountViewer } from "../viewer.js";
import {
  STEPS,
  TEST_BLOCK,
  analyseGrip,
  bestStates,
  buildCycle,
  chooseStudy,
  cycleFrame,
  detectWorkpiece,
  sampleCycle,
  stageMesh,
  stepEnd,
  testBlock,
} from "./pickPlace.js";
import { SequencePlayback } from "./AssemblyStudio.jsx";
import { Empty, ErrorNotice, Loading } from "./ui.jsx";
import "./pick-place.css";

const CYCLE_MS = 9000;
const label = (name) => name.replaceAll("_", " ");
const VERDICT = {
  pass: "Pick and place works in principle",
  review: "Works, with points to review",
  fail: "Doesn't work as modelled",
};
const ICON = { pass: Check, review: CircleAlert, fail: X };

// The newest preview mesh, with the motion studies and their exact CAD
// reports from the same build.
function useAssembly(task) {
  const meshFile = task.artifacts
    .filter((a) => a.metadata.kind === "mesh_preview")
    .sort((a, b) => b.created_at - a.created_at)[0];
  const build = meshFile?.metadata.build_id;
  const ofKind = (kind) =>
    latestArtifacts(
      task.artifacts.filter(
        (a) => a.metadata.kind === kind && a.metadata.build_id === build,
      ),
    );
  const studies = ofKind("motion_source"),
    reports = ofKind("motion_validation");
  const key = [meshFile, ...studies, ...reports].map((a) => a?.id).join();
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    if (!meshFile) return setState({ loading: false });
    const controller = new AbortController();
    const read = (a) =>
      api(`/tasks/${task.id}/artifacts/${a.id}/content`, {
        raw: true,
        signal: controller.signal,
      }).then((r) => r.json());
    setState({ loading: true });
    Promise.all([
      read(meshFile),
      Promise.all(studies.map(async (a) => ({ id: a.id, ...(await read(a)) }))),
      Promise.all(
        reports.map(async (a) => ({ name: a.name, ...(await read(a)) })),
      ),
    ])
      .then(([mesh, studies, reports]) =>
        setState({ loading: false, mesh, studies, reports }),
      )
      .catch((error) => {
        if (!controller.signal.aborted) setState({ loading: false, error });
      });
    return () => controller.abort();
  }, [task.id, key]);
  return state;
}

export default function PickPlacePanel({ task }) {
  const data = useAssembly(task);
  if (data.loading) return <Loading>Loading the assembly…</Loading>;
  if (data.error) return <ErrorNotice error={data.error} />;
  if (!data.mesh)
    return (
      <Empty icon={HandGrab} title="No assembly yet">
        Once a design is built, its gripper can be run through a pick, move and
        place cycle here.
      </Empty>
    );
  return (
    <PickPlace
      key={data.mesh.parts.map((p) => p.name).join()}
      mesh={data.mesh}
      studies={data.studies}
      reports={data.reports}
    />
  );
}

export function PickPlace({ mesh, studies = [], reports = [] }) {
  const [studyId, setStudyId] = useState(() =>
    studies.length ? chooseStudy(studies).id : "",
  );
  const study = studies.find((s) => s.id === studyId);
  const [states, setStates] = useState(() => bestStates(study));
  const [work, setWork] = useState(() => detectWorkpiece(mesh) || TEST_BLOCK);
  const [progress, setProgress] = useState(0),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1),
    [loop, setLoop] = useState(false),
    [rotate, setRotate] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const canvas = useRef(null),
    viewer = useRef(null);
  const { open, hold } = states;
  const scene = useMemo(() => {
    const withWork =
      work === TEST_BLOCK
        ? { ...mesh, parts: [...mesh.parts, testBlock(mesh, study, hold)] }
        : mesh;
    const cycle = buildCycle({ mesh: withWork, work, study, open, hold });
    const staged = stageMesh(withWork, work, cycle);
    return { withWork, cycle, staged, frame: cycleFrame(staged, cycle) };
  }, [mesh, study, open, hold, work]);
  const sample = sampleCycle(scene.cycle, progress);
  const validation = reports.find(
    (r) => study && r.name === `${study.name}_validation.json`,
  );

  useEffect(() => {
    try {
      viewer.current = mountViewer(canvas.current, scene.staged, {
        sharedFrame: scene.frame,
      });
      setError(null);
    } catch (err) {
      setError(err);
    }
    return () => {
      viewer.current?.destroy();
      viewer.current = null;
    };
  }, [scene]);
  useEffect(() => {
    viewer.current?.update({ poses: sample.poses, selected: work, rotate });
  }, [scene, progress, work, rotate]);

  // Contact checks take up to half a second on dense meshes; let the stage
  // paint first.
  useEffect(() => {
    setResult(null);
    const timer = setTimeout(() => {
      try {
        setResult(
          analyseGrip({
            mesh: scene.withWork,
            work,
            study,
            open,
            hold,
            validation,
          }),
        );
      } catch (err) {
        setResult({ verdict: "review", checks: [], error: err.message });
      }
    }, 30);
    return () => clearTimeout(timer);
  }, [scene, validation]);

  useEffect(() => {
    if (!playing) return;
    let frame,
      last,
      position = progress >= 1 ? 0 : progress;
    const tick = (now) => {
      if (last !== undefined) {
        position += ((now - last) * speed) / CYCLE_MS;
        if (position >= 1) {
          if (!loop) {
            setProgress(1);
            setPlaying(false);
            return;
          }
          position %= 1;
        }
        setProgress(position);
      }
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, loop]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!media.matches) setPlaying(true);
  }, []);

  const restart = (patch) => {
    setPlaying(false);
    setProgress(0);
    patch();
  };
  const stateNames = study?.states.map((s) => s.name) || [];
  const verdict = result?.verdict;
  const VerdictIcon = ICON[verdict];
  return (
    <div className="pick-place">
      <div className="pick-stage">
        <div className="mesh-viewer pick-viewer">
          <canvas
            ref={canvas}
            tabIndex={0}
            aria-label="Pick and place animation. Drag or use arrow keys to orbit, scroll to zoom."
          />
          {error && <ErrorNotice error={error} />}
          <span className="viewer-caption" aria-live="polite">
            {sample.label.toUpperCase()}
          </span>
          <div className="pick-tools">
            <button
              className="pill-button"
              aria-label="Reset view"
              title="Reset view"
              onClick={() => viewer.current?.view("iso")}
            >
              <Home size={15} />
            </button>
            <button
              className="pill-button"
              aria-label="Turntable"
              title="Turntable"
              aria-pressed={rotate}
              onClick={() => setRotate((r) => !r)}
            >
              <Rotate3d size={15} />
            </button>
          </div>
          <div className="pick-strip">
            <SequencePlayback
              playing={playing}
              progress={progress}
              speed={speed}
              playLabel="pick and place"
              timelineLabel="Pick and place timeline"
              onPlay={() => {
                if (progress >= 1) setProgress(0);
                setPlaying((p) => !p);
              }}
              onSeek={(value) => {
                setPlaying(false);
                setProgress(value);
              }}
              onSpeed={setSpeed}
            />
            <button
              className="pill-button"
              aria-label="Loop"
              title="Loop"
              aria-pressed={loop}
              onClick={() => setLoop((l) => !l)}
            >
              <Repeat size={15} />
            </button>
          </div>
        </div>
        <ol className="pick-steps" aria-label="Cycle steps">
          {STEPS.map(([key, name], i) => (
            <li
              key={key}
              className={
                i === sample.step ? "current" : i < sample.step ? "done" : ""
              }
            >
              <button
                aria-current={i === sample.step ? "step" : undefined}
                onClick={() => {
                  setPlaying(false);
                  setProgress(stepEnd(scene.cycle, i));
                }}
              >
                <span>{i + 1}</span>
                {name}
              </button>
            </li>
          ))}
        </ol>
      </div>
      <aside className="pick-side">
        <section
          className={`pick-verdict ${verdict || "pending"}`}
          aria-label="Mechanism check"
          aria-busy={!result}
        >
          <header>
            {VerdictIcon ? <VerdictIcon size={16} /> : <HandGrab size={16} />}
            <h3>{result ? VERDICT[verdict] : "Checking the grip…"}</h3>
          </header>
          {result?.error && <p className="pick-note">{result.error}</p>}
          <ul>
            {result?.checks.map((c) => {
              const Icon = ICON[c.status];
              return (
                <li key={c.id} className={c.status}>
                  <Icon size={14} aria-label={c.status} />
                  <div>
                    <strong>{c.label}</strong>
                    <p>{c.detail}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
        <section className="pick-setup" aria-label="Cycle setup">
          {studies.length > 1 && (
            <label>
              <span>Motion study</span>
              <select
                value={studyId}
                onChange={(e) =>
                  restart(() => {
                    const next = studies.find((s) => s.id === e.target.value);
                    setStudyId(e.target.value);
                    setStates(bestStates(next));
                  })
                }
              >
                {studies.map((s) => (
                  <option key={s.id} value={s.id}>
                    {label(s.name)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {study ? (
            <>
              <label>
                <span>Open pose · approach and release</span>
                <select
                  value={open}
                  onChange={(e) =>
                    restart(() => setStates({ hold, open: e.target.value }))
                  }
                >
                  {stateNames.map((n) => (
                    <option key={n} value={n}>
                      {label(n)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Holding pose · carry</span>
                <select
                  value={hold}
                  onChange={(e) =>
                    restart(() => setStates({ open, hold: e.target.value }))
                  }
                >
                  {stateNames.map((n) => (
                    <option key={n} value={n}>
                      {label(n)}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <p className="pick-note">
              This build has no motion study, so the gripper is carried as a
              rigid body. Ask the agent to add a motion study with open and
              closed states to test the grip.
            </p>
          )}
          <label>
            <span>Object to pick</span>
            <select
              value={work}
              onChange={(e) => restart(() => setWork(e.target.value))}
            >
              <option value={TEST_BLOCK}>
                Test block (fits the closed grip)
              </option>
              {mesh.parts.map((p) => (
                <option key={p.name} value={p.name}>
                  {label(p.name)}
                </option>
              ))}
            </select>
          </label>
        </section>
        <small className="pick-note">
          Kinematic check on the preview mesh: contact within{" "}
          {result?.tolerance
            ? `${result.tolerance.toFixed(1)} mm`
            : "tolerance"}
          , release and table clearance. Grip force, friction, suction and
          flexing fingers aren't simulated. While the mechanism moves, the
          gripper is lowered so the object stays still on its station.
        </small>
      </aside>
    </div>
  );
}
