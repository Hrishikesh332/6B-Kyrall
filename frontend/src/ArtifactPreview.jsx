import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Camera,
  Check,
  CircleAlert,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  File,
  Home,
  Layers,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  Rotate3d,
  Scan,
  X,
  Upload,
  SlidersHorizontal,
  Printer,
  GitCompareArrows,
  Sparkles,
} from "lucide-react";
import { api, date, latestArtifacts, size } from "./lib.js";
import {
  extensionOf,
  fileDescription,
  fileKind,
  sortFiles,
} from "./filePresentation.js";
import {
  DocumentContent,
  ImageContent,
  BrowserFileContent,
  PackageContent,
} from "./FileContent.jsx";
import { FileIcon } from "./FileLibrary.jsx";
import { mountViewer } from "../viewer.js";
import { sampleStudy } from "./motion.js";
import { meshBounds } from "./meshBounds.js";
import {
  approachDirections,
  assemblyOrder,
  moveStep,
  partBounds,
  recordingFormat,
  sampleAssembly,
  stepProgress,
} from "./assembly.js";
import {
  AssemblySequence,
  ComponentPanel,
  SequencePlayback,
} from "./AssemblyStudio.jsx";
import ParameterPanel from "./ParameterPanel.jsx";
import PrintabilityPanel from "./PrintabilityPanel.jsx";
import VersionCompare from "./VersionCompare.jsx";
import ViewCube from "./ViewCube.jsx";
import { cubeTransform } from "./viewCube.js";
import { Empty, ErrorNotice, IconButton, Loading } from "./ui.jsx";

export default function ArtifactPreview({
  taskId,
  artifactId,
  onChange,
  onClose,
  notify,
  sendToOnshape,
}) {
  const [state, setState] = useState({ loading: true });
  const [downloading, setDownloading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [comparing, setComparing] = useState(false);
  useEffect(() => setComparing(false), [artifactId]);
  const panel = useRef(null);
  const closeButton = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    panel.current.showModal();
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl;
    const { signal } = controller;
    setState({ loading: true });
    const read = (aid, format) =>
      api(`/tasks/${taskId}/artifacts/${aid}/content`, {
        raw: true,
        signal,
      }).then((r) => r[format]());
    (async () => {
      try {
        const task = await api(`/tasks/${taskId}`, { signal });
        const artifact = task.artifacts.find((a) => a.id === artifactId);
        if (!artifact) throw new Error("This file is no longer available.");
        const sameBuild = task.artifacts.filter(
          (a) =>
            artifact.metadata.build_id &&
            a.metadata.build_id === artifact.metadata.build_id,
        );
        const meshFile =
          artifact.metadata.kind === "mesh_preview"
            ? artifact
            : sameBuild.find((a) => a.metadata.kind === "mesh_preview");
        let content = {};
        if (
          meshFile &&
          [
            "cad",
            "cad_source",
            "cad_script",
            "mesh_preview",
            "motion_source",
          ].includes(artifact.metadata.kind)
        ) {
          const reportFile = sameBuild.find(
            (a) => a.metadata.kind === "validation",
          );
          const [mesh, report] = await Promise.all([
            read(meshFile.id, "json"),
            reportFile ? read(reportFile.id, "json") : null,
          ]);
          const studyFiles = sameBuild
            .filter((a) => a.metadata.kind === "motion_source")
            .filter(
              (a, _, all) =>
                !all.some((b) => b.name === a.name && b.version > a.version),
            );
          const studies = await Promise.all(
            studyFiles.map(async (a) => ({
              id: a.id,
              ...(await read(a.id, "json")),
            })),
          );
          const said = task.messages.filter(
            (m) =>
              m.role === "assistant" &&
              m.kind === "text" &&
              typeof m.content === "string",
          );
          content = {
            mesh,
            report,
            studies,
            // The agent's own account of this build, shown beside the model.
            notes: {
              decisions: sameBuild
                .filter((a) => a.metadata.kind === "decision")
                .map((a) => a.metadata.decision)
                .filter(Boolean),
              summary: said.at(-1)?.content || "",
            },
            buildId: meshFile.metadata.build_id,
            // Generated builds are patched; Onshape imports are read-only.
            cadSource:
              sameBuild.find((a) => a.metadata.kind === "cad_source") ||
              sameBuild.find((a) => a.metadata.kind === "cad_script") ||
              sameBuild.find((a) => a.metadata.kind === "onshape_import"),
          };
        } else if (
          fileKind(artifact) === "images" ||
          [
            "preview",
            "preview_image",
            "reference_page",
            "reference_image",
          ].includes(artifact.metadata.kind)
        ) {
          const blob = await read(artifactId, "blob");
          if (signal.aborted) return;
          objectUrl = URL.createObjectURL(blob);
          content = { image: objectUrl };
        } else if (
          extensionOf(artifact) === "pdf" ||
          fileKind(artifact) === "media"
        ) {
          const blob = await read(artifactId, "blob");
          if (signal.aborted) return;
          objectUrl = URL.createObjectURL(
            extensionOf(artifact) === "pdf"
              ? new Blob([blob], { type: "application/pdf" })
              : blob,
          );
          content =
            extensionOf(artifact) === "pdf"
              ? { pdf: objectUrl }
              : { media: objectUrl };
        } else if (/\.(md|txt|json|csv)$/i.test(artifact.name)) {
          let text = await read(artifactId, "text");
          if (artifact.name.endsWith(".json")) {
            try {
              text = JSON.stringify(JSON.parse(text), null, 2);
            } catch {
              /* Display the original if the document isn't valid JSON. */
            }
          }
          content = {
            text: text.slice(0, 250000),
            truncated: text.length > 250000,
          };
        }
        if (!signal.aborted)
          setState({ task, artifact, ...content, loading: false });
      } catch (error) {
        if (!signal.aborted) setState({ error, loading: false });
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [taskId, artifactId, attempt]);
  const a = state.artifact;
  const siblings = state.task
    ? sortFiles(latestArtifacts(state.task.artifacts))
    : [];
  const fileIndex = siblings.findIndex((file) => file.name === a?.name);
  const download = async () => {
    setDownloading(true);
    try {
      const blob = await (
        await api(`/tasks/${taskId}/artifacts/${artifactId}/content`, {
          raw: true,
        })
      ).blob();
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = a.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      notify(error.message);
    } finally {
      setDownloading(false);
    }
  };
  // Slider changes rebuild the script server-side; then show the new version.
  const rebuild = async (values) => {
    const result = await api(
      `/tasks/${taskId}/artifacts/${state.cadSource.id}/rebuild`,
      { method: "POST", body: { values } },
    );
    notify(
      result.validation.passed
        ? "Rebuilt with new parameters. Checks passed."
        : "Rebuilt with new parameters. Some checks need attention.",
    );
    onChange({ taskId, artifactId: result.preview_artifact_id });
  };
  // Scoped follow-up: the backend tells the agent to patch only this part.
  const revise = async (part, change) => {
    try {
      await api(`/tasks/${taskId}/messages`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: {
          content: change,
          focus: { part, source_artifact_id: state.cadSource.id },
        },
      });
      notify(`Revision for ${part.replaceAll("_", " ")} sent.`);
      onClose();
      location.hash = `task=${encodeURIComponent(taskId)}`;
    } catch (error) {
      notify(error.message);
      return false;
    }
  };
  return (
    <dialog
      ref={panel}
      className={`preview-panel${expanded ? " is-expanded" : ""}${state.mesh ? " has-model" : " file-reader"}`}
      aria-label="Artifact preview"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header className="preview-header">
        <div className="preview-identity">
          {a && (
            <span className={`file-glyph kind-${fileKind(a)}`}>
              <FileIcon file={a} size={20} strokeWidth={1.5} />
            </span>
          )}
          <div>
            <span className="eyebrow">
              {state.mesh
                ? "MODEL STUDIO"
                : a
                  ? fileDescription(a).toUpperCase()
                  : "FILE PREVIEW"}
            </span>
            <h2>{a?.name || "Preview"}</h2>
          </div>
        </div>
        <div className="preview-header-actions">
          <IconButton
            label={expanded ? "Minimize preview" : "Expand preview"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </IconButton>
          <button
            ref={closeButton}
            className="icon-button"
            aria-label="Close preview"
            title="Close preview"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
      </header>
      {state.loading ? (
        <Loading>Loading preview…</Loading>
      ) : state.error ? (
        <ErrorNotice
          error={state.error}
          retry={() => setAttempt((n) => n + 1)}
        />
      ) : (
        <>
          <div className="preview-controls">
            <div className="preview-version-controls">
              <IconButton
                label="Previous file"
                disabled={fileIndex <= 0 || downloading}
                onClick={() =>
                  onChange({ taskId, artifactId: siblings[fileIndex - 1].id })
                }
              >
                <ChevronLeft size={16} />
              </IconButton>
              <span className="preview-file-position">
                {fileIndex + 1} / {siblings.length}
              </span>
              <IconButton
                label="Next file"
                disabled={
                  fileIndex < 0 ||
                  fileIndex >= siblings.length - 1 ||
                  downloading
                }
                onClick={() =>
                  onChange({ taskId, artifactId: siblings[fileIndex + 1].id })
                }
              >
                <ChevronRight size={16} />
              </IconButton>
              <select
                aria-label="File version"
                value={artifactId}
                disabled={downloading}
                onChange={(e) =>
                  onChange({ taskId, artifactId: e.target.value })
                }
              >
                {state.task.artifacts
                  .filter((item) => item.name === a.name)
                  .sort((x, y) => y.version - x.version)
                  .map((item, i) => (
                    <option key={item.id} value={item.id}>
                      Version {item.version}
                      {i === 0 ? " · latest" : ""}
                    </option>
                  ))}
              </select>
            </div>
            {sendToOnshape &&
              /^(step|stp)$/.test(extensionOf(a)) &&
              a.metadata.source !== "onshape" && (
                <button
                  className="secondary"
                  onClick={() => sendToOnshape(a, state.task.title)}
                >
                  <Upload size={15} />
                  Send to Onshape
                </button>
              )}
            <button
              className="secondary"
              onClick={download}
              disabled={downloading}
            >
              <Download size={15} />
              {downloading ? "Preparing…" : "Download"}
            </button>
          </div>
          <div className="preview-body">
            {comparing && state.mesh ? (
              <VersionCompare
                taskId={taskId}
                artifacts={state.task.artifacts}
                currentBuild={state.buildId}
                onClose={() => setComparing(false)}
              />
            ) : state.mesh ? (
              <MeshPreview
                printContext={{ taskId, buildId: state.buildId }}
                onCompare={
                  new Set(
                    state.task.artifacts
                      .filter((x) =>
                        ["cad_script", "cad_source"].includes(x.metadata.kind),
                      )
                      .map((x) => x.metadata.build_id),
                  ).size > 1
                    ? () => setComparing(true)
                    : undefined
                }
                key={artifactId}
                mesh={state.mesh}
                report={state.report}
                notes={state.notes}
                studies={state.studies}
                name={a.name}
                onRevise={
                  state.cadSource && state.task.status !== "awaiting_input"
                    ? revise
                    : undefined
                }
                parameters={
                  state.cadSource?.metadata.kind === "cad_script"
                    ? state.cadSource.metadata.parameters
                    : null
                }
                onRebuild={rebuild}
                rebuildBlocked={
                  ["queued", "running"].includes(state.task.status)
                    ? "6B is working on this project. Rebuild when the run finishes."
                    : ""
                }
                reviseMode={
                  state.cadSource?.metadata.kind === "onshape_import"
                    ? "onshape"
                    : "cad"
                }
                reviseNote={
                  state.cadSource
                    ? "Answer the pending design questions before revising a component."
                    : "Component revisions need a generated CAD build."
                }
              />
            ) : state.image ? (
              <ImageContent
                key={artifactId}
                image={state.image}
                name={a.name}
              />
            ) : state.pdf ? (
              <BrowserFileContent url={state.pdf} file={a} />
            ) : state.media ? (
              <BrowserFileContent url={state.media} file={a} />
            ) : state.text !== undefined ? (
              <DocumentContent
                key={artifactId}
                file={a}
                text={state.text}
                truncated={state.truncated}
              />
            ) : fileKind(a) === "packages" ? (
              <PackageContent file={a} taskId={taskId} onChange={onChange} />
            ) : (
              <Empty
                icon={a.metadata.kind === "package" ? Box : File}
                title={
                  a.metadata.kind === "package"
                    ? "Ready to build"
                    : "Download to open"
                }
              >
                {a.metadata.kind === "package"
                  ? "Your complete delivery package."
                  : "A preview is not available for this file type."}
              </Empty>
            )}
          </div>
          <footer className="preview-meta">
            <span>{size(a.size)}</span>
            <span>{date(a.created_at)}</span>
            <a href={`#task=${encodeURIComponent(taskId)}`} onClick={onClose}>
              Open project <ChevronRight size={12} />
            </a>
          </footer>
        </>
      )}
    </dialog>
  );
}
const ASSEMBLY = "__assembly";
// Matches the renderer's part palette so list swatches identify parts.
const PART_SWATCHES = [
  "#cccfd1",
  "#a1b599",
  "#d1c2a8",
  "#99abbf",
  "#bdb3c7",
  "#b3c4b8",
];
const STEP_MS = 1700;
export function MeshPreview({
  mesh,
  report,
  notes,
  name,
  studies = [],
  onRevise,
  reviseNote,
  reviseMode = "cad",
  parameters,
  onRebuild,
  rebuildBlocked,
  onCompare,
  printContext,
}) {
  const reference = mesh.kind === "reference_mesh";
  const [paramsOpen, setParamsOpen] = useState(false);
  const [part, setPart] = useState(
    mesh.parts.find((p) => `${p.name}.stl` === name)?.name || "",
  );
  const [error, setError] = useState(null),
    [view, setView] = useState("iso");
  const [explode, setExplode] = useState(0),
    [hidden, setHidden] = useState([]);
  const [studyId, setStudyId] = useState(""),
    [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1),
    [rotate, setRotate] = useState(false);
  const [selected, setSelected] = useState(""),
    [isolate, setIsolate] = useState(false),
    [tip, setTip] = useState(null);
  const [drawer, setDrawer] = useState(false),
    [printCheck, setPrintCheck] = useState(false);
  const bounds = useMemo(() => partBounds(mesh), [mesh]);
  const span = useMemo(() => {
    try {
      return meshBounds(mesh).span;
    } catch {
      return 1; // The viewer reports invalid geometry itself.
    }
  }, [mesh]);
  const [order, setOrder] = useState(() => assemblyOrder(mesh, bounds));
  const [reverse, setReverse] = useState(false),
    [ghostUpcoming, setGhostUpcoming] = useState(true),
    [recording, setRecording] = useState(false);
  const canvas = useRef(null),
    viewer = useRef(null),
    recorder = useRef(null),
    cube = useRef(null),
    zoomLabel = useRef(null),
    inspector = useRef(null);
  const assembly = studyId === ASSEMBLY;
  const study = studies.find((s) => s.id === studyId),
    sample = sampleStudy(study, progress);
  const directions = useMemo(
    () => approachDirections(order, bounds),
    [order, bounds],
  );
  const sequence = assembly
    ? sampleAssembly(order, directions, span, reverse ? 1 - progress : progress)
    : null;
  useEffect(() => {
    try {
      viewer.current = mountViewer(canvas.current, mesh, {
        onPick: (picked) => setSelected(picked),
        // Written straight to the DOM so orbiting never re-renders React.
        onCamera: ({ yaw, pitch, zoom }) => {
          if (cube.current)
            cube.current.style.transform = cubeTransform(yaw, pitch);
          if (zoomLabel.current)
            zoomLabel.current.textContent = `${Math.round(zoom * 100)}%`;
        },
        onHover: (hovered, at) => {
          const rect = canvas.current?.getBoundingClientRect();
          setTip(
            hovered && at && rect
              ? { name: hovered, x: at[0] - rect.left, y: at[1] - rect.top }
              : null,
          );
        },
      });
    } catch (err) {
      setError(err);
    }
    return () => {
      viewer.current?.destroy();
      viewer.current = null;
    };
  }, [mesh]);
  useEffect(() => {
    let shown = part
      ? mesh.parts.filter((p) => p.name !== part).map((p) => p.name)
      : hidden;
    let ghosted = [];
    if (sequence)
      if (ghostUpcoming) ghosted = sequence.upcoming;
      else shown = [...new Set([...shown, ...sequence.upcoming])];
    if (selected && isolate)
      ghosted = mesh.parts.map((p) => p.name).filter((n) => n !== selected);
    viewer.current?.update({
      explode: study || sequence ? 0 : explode,
      poses: sample.poses,
      offsets: sequence?.offsets || {},
      hidden: shown,
      ghosted,
      selected,
      rotate,
    });
  }, [
    mesh,
    part,
    hidden,
    explode,
    study,
    progress,
    rotate,
    assembly,
    order,
    reverse,
    ghostUpcoming,
    selected,
    isolate,
  ]);
  const steps = assembly ? order.length : study?.transitions.length || 1;
  useEffect(() => {
    if (!playing || !(study || assembly)) return;
    let frame,
      last,
      position = progress;
    const perStep = assembly ? STEP_MS : 4000;
    const tick = (now) => {
      if (last !== undefined) {
        position = Math.min(
          1,
          position + ((now - last) * speed) / (perStep * steps),
        );
        setProgress(position);
        if (position >= 1) {
          setPlaying(false);
          // Hold the finished assembly briefly so the video ends on it.
          if (recorder.current) setTimeout(() => recorder.current?.stop(), 900);
          return;
        }
      }
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, study, assembly, speed, steps]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stop = () => {
      if (media.matches) {
        setPlaying(false);
        setRotate(false);
      }
    };
    media.addEventListener("change", stop);
    return () => media.removeEventListener("change", stop);
  }, []);
  useEffect(() => () => recorder.current?.stop(), []);
  useEffect(() => {
    viewer.current?.update({ printCheck });
  }, [printCheck, mesh]);
  const format = recordingFormat();
  const record = () => {
    if (recorder.current) {
      recorder.current.stop();
      return;
    }
    const stream = canvas.current?.captureStream?.(60);
    if (!stream || !format) return;
    const chunks = [],
      media = new MediaRecorder(stream, {
        mimeType: format[0],
        videoBitsPerSecond: 8_000_000,
      });
    media.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    media.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      recorder.current = null;
      setRecording(false);
      setPlaying(false);
      viewer.current?.update({ background: null });
      if (!chunks.length) return;
      const url = URL.createObjectURL(new Blob(chunks, { type: format[0] })),
        link = document.createElement("a");
      link.href = url;
      link.download = `${(name || "assembly").replace(/\.[^.]+$/, "")}-${reverse ? "disassembly" : "assembly"}.${format[1]}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    // Video has no alpha channel; record against the studio background.
    viewer.current?.update({ background: [0.075, 0.082, 0.075, 1] });
    recorder.current = media;
    media.start(250);
    setRecording(true);
    setProgress(0);
    setPlaying(true);
  };
  const choose = (picked) => {
    setSelected(picked);
    viewer.current?.focus(picked);
  };
  const reset = () => {
    recorder.current?.stop();
    setPlaying(false);
    setProgress(0);
    setExplode(0);
    setHidden([]);
    setPart("");
    setRotate(false);
    setStudyId("");
    setSpeed(1);
    setSelected("");
    setIsolate(false);
    setReverse(false);
    setView("iso");
    viewer.current?.view("iso");
  };
  const position = order.indexOf(selected);
  const snapshot = () => {
    const url = viewer.current?.snapshot?.();
    if (!url) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(name || "model").replace(/\.[^.]+$/, "")}-view.png`;
    link.click();
  };
  const caption = sequence
    ? `${reverse ? "DISASSEMBLY" : "ASSEMBLY"} SEQUENCE · STEP ${reverse ? order.length - sequence.step : sequence.step + 1}/${order.length}`
    : study
      ? "PRESCRIBED MOTION"
      : explode > 0
        ? "EXPLODED ASSEMBLY"
        : reference
          ? "REFERENCE MESH"
          : mesh.kind === "onshape_import"
            ? "IMPORTED FROM ONSHAPE"
            : "ASSEMBLED";
  const shownStep = sequence
    ? reverse
      ? order.length - sequence.step
      : sequence.step + 1
    : 0;
  const hint = sequence
    ? `Step ${shownStep} of ${order.length} · ${reverse ? "Remove" : "Install"} ${sequence.active.replaceAll("_", " ")}`
    : study
      ? sample.label
      : "Click a part to inspect · Double-click to focus · Drag to orbit";
  const side = selected && bounds[selected];
  // Overall envelope: the validated report when present, else the mesh itself.
  const envelope = useMemo(() => {
    if (report?.assembly_bounds_mm) return report.assembly_bounds_mm;
    const all = Object.values(bounds);
    if (!all.length) return null;
    return [0, 1, 2].map(
      (k) =>
        Math.max(...all.map((b) => b.max[k])) -
        Math.min(...all.map((b) => b.min[k])),
    );
  }, [report, bounds]);
  const units = mesh.units || "mm";
  const volume = report?.parts?.reduce(
    (sum, p) => sum + (p.volume_mm3 || 0),
    0,
  );
  const checkRows = report
    ? [
        ["Valid solids", report.parts.every((p) => p.valid_brep !== false)],
        ["Watertight meshes", report.parts.every((p) => p.watertight)],
        [
          report.interferences.length
            ? `${report.interferences.length} assembly overlap(s)`
            : "No overlaps",
          !report.interferences.length,
        ],
        ["STEP re-import", !!report.step_reimport_valid],
        ...(report.parts.some((p) => "fits_print_bed" in p)
          ? [["Fits print bed", report.parts.every((p) => p.fits_print_bed)]]
          : []),
      ]
    : [];
  const decisions = notes?.decisions || [];
  const focusPanel = side ? selected : sequence ? "sequence" : paramsOpen;
  // A newly opened focus panel sits at the top of the inspector; bring it into view.
  useEffect(() => {
    if (focusPanel)
      inspector.current?.scrollTo?.({ top: 0, behavior: "smooth" });
  }, [focusPanel]);
  return (
    <div
      className={`model-studio bench${side || sequence || paramsOpen ? " has-side" : ""}`}
      onKeyDown={(e) => {
        // Escape peels back one layer (selection, then open panels) before
        // it reaches the dialog and closes the studio.
        if (e.key !== "Escape" || recording) return;
        if (selected) {
          setSelected("");
          setIsolate(false);
        } else if (drawer || printCheck || paramsOpen) {
          setDrawer(false);
          setPrintCheck(false);
          setParamsOpen(false);
        } else return;
        e.preventDefault();
        e.stopPropagation();
        // The focused control may have just unmounted; keep focus in the studio.
        canvas.current?.focus();
      }}
    >
      <div
        className={`mesh-viewer bench-stage${recording ? " is-recording" : ""}`}
      >
        <canvas
          ref={canvas}
          tabIndex={0}
          className={tip ? "is-picking" : ""}
          // Orbiting leaves the named view, so its cube face stops reading as active.
          onPointerMove={(e) => e.buttons && view && setView("")}
          aria-label="Interactive 3D model. Click a component to select it, double-click to focus it. Drag or use arrow keys to orbit, Shift-drag or right-drag to pan. Scroll or use plus and minus to zoom, F to fit."
        />
        <span className="bench-mark is-tl" aria-hidden="true" />
        <span className="bench-mark is-tr" aria-hidden="true" />
        <span className="bench-mark is-bl" aria-hidden="true" />
        <span className="bench-mark is-br" aria-hidden="true" />
        {error && <ErrorNotice error={error} />}
        {tip && !recording && (
          <span
            className="part-tip"
            style={{ left: tip.x, top: tip.y }}
            aria-hidden="true"
          >
            {tip.name.replaceAll("_", " ")}
          </span>
        )}
        {recording && (
          <span className="recording-badge" role="status">
            REC
          </span>
        )}
        <span className="viewer-caption">
          {caption} · {units}
        </span>
        {envelope && (
          <span className="bench-envelope" aria-label="Overall size">
            {envelope.map((v) => Number(v.toFixed(1))).join(" × ")}{" "}
            <small>{units}</small>
          </span>
        )}

        <div className="viewer-dock dock-top-right">
          <ViewCube
            ref={cube}
            view={view}
            onOrbit={(dx, dy) => {
              viewer.current?.orbitBy?.(dx, dy);
              setView("");
              setRotate(false);
            }}
            onView={(id) => {
              viewer.current?.view(id);
              setView(id);
              setRotate(false);
            }}
          />
          <div className="bench-tools">
            <button className="pill-button" title="Reset view" onClick={reset}>
              <Home size={15} aria-hidden="true" />
              <span className="sr-only">Reset view</span>
            </button>
            <button
              className="pill-button"
              aria-label="Fit to view"
              title="Fit to view (F)"
              onClick={() => viewer.current?.fit?.()}
            >
              <Scan size={15} aria-hidden="true" />
            </button>
            <button
              className="pill-button"
              aria-label="Turntable"
              title="Turntable"
              aria-pressed={rotate}
              onClick={() => setRotate((r) => !r)}
            >
              <Rotate3d size={15} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="bench-strip">
          {!reference && (
            <select
              className="pill-select"
              aria-label="Presentation mode"
              value={studyId}
              disabled={recording}
              onChange={(e) => {
                setStudyId(e.target.value);
                // The sequence opens fully assembled; Play restarts it from empty.
                setProgress(e.target.value === ASSEMBLY ? 1 : 0);
                setPlaying(false);
                setExplode(0);
              }}
            >
              <option value="">Explore</option>
              {mesh.parts.length > 1 && (
                <option value={ASSEMBLY}>Assembly sequence</option>
              )}
              {studies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          )}
          {sequence || study ? (
            <SequencePlayback
              playing={playing}
              disabled={recording}
              progress={progress}
              speed={speed}
              playLabel={sequence ? "assembly" : "motion"}
              timelineLabel={sequence ? "Assembly timeline" : "Motion timeline"}
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
          ) : (
            <label className="explode-control">
              <span>{reference ? "Separate" : "Explode"}</span>
              <input
                type="range"
                aria-label={reference ? "Separate parts" : "Explode assembly"}
                min="0"
                max="1"
                step=".01"
                value={explode}
                disabled={!!part}
                style={{ "--fill": `${explode * 100}%` }}
                onChange={(e) => setExplode(Number(e.target.value))}
              />
              <span className="pill-value" aria-hidden="true">
                {Math.round(explode * 100)}%
              </span>
            </label>
          )}
          <span className="pill-divider" aria-hidden="true" />
          <button
            className="pill-button"
            aria-label="Zoom out"
            onClick={() => viewer.current?.zoomBy?.(1 / 1.25)}
          >
            <Minus size={15} />
          </button>
          <span className="pill-value zoom-value" ref={zoomLabel}>
            100%
          </span>
          <button
            className="pill-button"
            aria-label="Zoom in"
            onClick={() => viewer.current?.zoomBy?.(1.25)}
          >
            <Plus size={15} />
          </button>
          <span className="pill-divider" aria-hidden="true" />
          <button
            className="pill-button"
            aria-label="Save snapshot"
            title="Save snapshot (PNG)"
            onClick={snapshot}
          >
            <Camera size={15} />
          </button>
          <span className="viewer-hint" role="status">
            {hint}
          </span>
          {study && (
            <small className="sr-only">
              Interpolated prescribed poses. Playback speed is illustrative;
              contact, forces and grasp success are not simulated here.
            </small>
          )}
        </div>
      </div>

      <aside
        ref={inspector}
        className="viewer-card bench-inspector"
        aria-label="Model details"
      >
        {(side || sequence || (paramsOpen && parameters?.length > 0)) && (
          <div className="inspector-focus">
            {paramsOpen && parameters?.length > 0 && (
              <ParameterPanel
                parameters={parameters}
                onRebuild={onRebuild}
                disabledReason={rebuildBlocked}
                onClose={() => setParamsOpen(false)}
              />
            )}
            {side && (
              <ComponentPanel
                key={selected}
                name={selected}
                bounds={bounds[selected]}
                part={report?.parts?.find((p) => p.part === selected)}
                interferences={report?.interferences}
                partCount={mesh.parts.length}
                step={
                  assembly && position >= 0
                    ? [position + 1, order.length]
                    : null
                }
                isolated={isolate}
                onFocus={() => viewer.current?.focus(selected)}
                onIsolate={() => setIsolate((v) => !v)}
                onHide={() => {
                  setHidden((h) => [...new Set([...h, selected])]);
                  setSelected("");
                  setIsolate(false);
                }}
                onClear={() => {
                  setSelected("");
                  setIsolate(false);
                  viewer.current?.focus("");
                }}
                onRevise={onRevise}
                reviseNote={reviseNote}
                reviseMode={reviseMode}
              />
            )}
            {sequence && (
              <AssemblySequence
                order={order}
                sequence={sequence}
                recording={recording}
                canRecord={!!format && !!canvas.current?.captureStream}
                reverse={reverse}
                ghostUpcoming={ghostUpcoming}
                onJump={(i) => {
                  setPlaying(false);
                  const seated = stepProgress(i, order.length);
                  // Reversed playback removes the last-installed part first.
                  setProgress(reverse ? 1 - seated : seated);
                  setSelected(order[i]);
                }}
                onMove={(i, delta) => setOrder((o) => moveStep(o, i, delta))}
                onReverse={(value) => {
                  setReverse(value);
                  setPlaying(false);
                  setProgress(value ? 0 : 1);
                }}
                onGhost={setGhostUpcoming}
                onRecord={record}
              />
            )}
          </div>
        )}

        <section className="inspector-summary">
          {report ? (
            <span
              className={`inspector-status ${report.passed ? "is-pass" : "is-warn"}`}
            >
              {report.passed ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <CircleAlert size={14} aria-hidden="true" />
              )}
              {report.passed ? "Checks passed" : "Needs revision"}
            </span>
          ) : (
            <span className="inspector-status">
              {reference ? "Reference mesh" : "Not validated"}
            </span>
          )}
          {envelope && (
            <dl className="inspector-dims">
              {["W", "D", "H"].map((axis, i) => (
                <div key={axis}>
                  <dt>{axis}</dt>
                  <dd>
                    {Number(envelope[i].toFixed(1))}
                    <small>{units}</small>
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <p className="inspector-facts">
            {mesh.parts.length} part{mesh.parts.length === 1 ? "" : "s"}
            {volume ? ` · ${(volume / 1000).toFixed(1)} cm³` : ""}
            {report?.engine ? ` · ${report.engine}` : ""}
          </p>
        </section>

        {report && (
          <section className="inspector-section">
            <h3>Checks</h3>
            <ul className="inspector-checks">
              {checkRows.map(([label, ok]) => (
                <li key={label} className={ok ? "is-pass" : "is-warn"}>
                  {ok ? (
                    <Check size={13} aria-hidden="true" />
                  ) : (
                    <CircleAlert size={13} aria-hidden="true" />
                  )}
                  {label}
                </li>
              ))}
            </ul>
            {report.printability && (
              <button
                className={`inspector-toggle print-pill ${report.printability.status}`}
                aria-pressed={printCheck}
                onClick={() => setPrintCheck((on) => !on)}
              >
                <Printer size={14} aria-hidden="true" />
                <span>Print check</span>
              </button>
            )}
            {printCheck && report.printability && (
              <PrintabilityPanel report={report} context={printContext} />
            )}
            <small>
              Physical fit, strength and print behavior are not tested.
            </small>
          </section>
        )}

        {(decisions.length > 0 || notes?.summary) && (
          <section className="inspector-section inspector-notes">
            <h3>
              <Sparkles size={13} aria-hidden="true" /> AI notes
            </h3>
            {decisions.length ? (
              decisions.map((d) => (
                <article key={d.key || d.title}>
                  <strong>{d.title}</strong>
                  <p>{d.summary}</p>
                  {d.tradeoffs?.length > 0 && (
                    <ul>
                      {d.tradeoffs.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                  )}
                  {d.uncertainties?.length > 0 && (
                    <p className="inspector-open">
                      Open: {d.uncertainties.join(" · ")}
                    </p>
                  )}
                </article>
              ))
            ) : (
              <p className="inspector-summary-text">{notes.summary}</p>
            )}
          </section>
        )}

        <section className="inspector-section">
          <div className="inspector-row">
            <select
              aria-label="Displayed geometry"
              value={part}
              onChange={(e) => setPart(e.target.value)}
            >
              <option value="">
                {reference ? "Complete model" : "Complete assembly"}
              </option>
              {mesh.parts.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </div>
          <div className="inspector-actions">
            {(!reference || mesh.parts.length > 1) && (
              <button
                className="inspector-toggle"
                aria-expanded={drawer}
                onClick={() => setDrawer((open) => !open)}
              >
                <Layers size={14} aria-hidden="true" />
                <span>{`Parts · ${mesh.parts.length}`}</span>
                <ChevronRight
                  size={13}
                  className="pill-chevron"
                  aria-hidden="true"
                />
              </button>
            )}
            {parameters?.length > 0 && (
              <button
                className="inspector-toggle"
                aria-expanded={paramsOpen}
                onClick={() => setParamsOpen((open) => !open)}
              >
                <SlidersHorizontal size={14} aria-hidden="true" />
                <span>{`Parameters · ${parameters.length}`}</span>
              </button>
            )}
            {onCompare && (
              <button className="inspector-toggle" onClick={onCompare}>
                <GitCompareArrows size={14} aria-hidden="true" />
                <span>Compare versions</span>
              </button>
            )}
          </div>
          {drawer && (
            <div className="assembly-parts">
              {mesh.parts.map((p, i) => (
                <div
                  key={p.name}
                  className={`part-row${selected === p.name ? " is-selected" : ""}`}
                  style={{
                    "--swatch": PART_SWATCHES[i % PART_SWATCHES.length],
                  }}
                  onMouseEnter={() =>
                    viewer.current?.update({ highlight: p.name })
                  }
                  onMouseLeave={() => viewer.current?.update({ highlight: "" })}
                >
                  <button
                    className="part-select"
                    aria-pressed={selected === p.name}
                    onClick={() => choose(selected === p.name ? "" : p.name)}
                  >
                    <span className="part-swatch" aria-hidden="true" />
                    {p.name.replaceAll("_", " ")}
                  </button>
                  <label className="part-visibility">
                    <input
                      type="checkbox"
                      aria-label={p.name.replaceAll("_", " ")}
                      checked={
                        part ? part === p.name : !hidden.includes(p.name)
                      }
                      disabled={!!part}
                      onChange={(e) =>
                        setHidden((h) =>
                          e.target.checked
                            ? h.filter((n) => n !== p.name)
                            : [...h, p.name],
                        )
                      }
                    />
                    {(part ? part === p.name : !hidden.includes(p.name)) ? (
                      <Eye size={14} aria-hidden="true" />
                    ) : (
                      <EyeOff size={14} aria-hidden="true" />
                    )}
                  </label>
                </div>
              ))}
              <p className="preview-source">
                {reference
                  ? "Part separation is for viewing only. Download preserves the original model."
                  : "Exploded offsets are presentation only. STL files use each part’s print orientation."}
              </p>
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}
