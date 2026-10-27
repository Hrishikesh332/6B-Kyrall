import { useId, useState } from "react";
import {
  BookOpen,
  Bookmark,
  Box,
  ChevronDown,
  CircleAlert,
  ClipboardCheck,
  FilePen,
  FileSearch,
  FileText,
  Folder,
  Globe,
  Image,
  ListChecks,
  MessageCircleQuestion,
  Move3d,
  Package,
  PencilRuler,
  Scale,
  ScanSearch,
  Search,
  ShieldCheck,
  Boxes,
  Check,
  FileCode2,
  FileDiff,
  UserCheck,
  Wrench,
} from "lucide-react";
import { useResource } from "./hooks.js";
import { elapsedLabel } from "./trace.js";

export const TOOL_ICONS = {
  build_cad_script: FileCode2,
  revise_cad_script: FileDiff,
  request_approval: UserCheck,
  load_workflow: BookOpen,
  set_specification: FileText,
  update_plan: ListChecks,
  ask_questions: MessageCircleQuestion,
  build_cad: Box,
  revise_cad: PencilRuler,
  inspect_validation: ScanSearch,
  inspect_image: Image,
  evaluate_motion: Move3d,
  record_design_review: ClipboardCheck,
  record_decision: Scale,
  write_document: FilePen,
  read_artifact: FileSearch,
  list_artifacts: Folder,
  package_artifacts: Package,
  fetch_reference: Globe,
  search_context: Search,
  save_memory: Bookmark,
  export_isaac_scene: Boxes,
};
const KIND_ICONS = { check: ShieldCheck, source: Globe, decision: Scale };

function Disclosure({ label, className = "", defaultOpen = false, children }) {
  // Follows defaultOpen (the live phase) until the user toggles it.
  const [chosen, setOpen] = useState(null);
  const open = chosen ?? defaultOpen;
  const id = useId();
  return (
    <div className={`trace-disclosure ${className}`} data-open={open}>
      <button
        type="button"
        className="trace-trigger"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {label}
        <ChevronDown size={12} className="trace-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div id={id} className="trace-content">
          {children}
        </div>
      )}
    </div>
  );
}

// Short values read inline; lists become items and long text a code block.
function ArgumentValue({ value, depth = 0 }) {
  if (Array.isArray(value) && depth < 2) {
    return (
      <ul className="trace-arg-list">
        {value.slice(0, 12).map((item, i) => (
          <li key={i}>
            <ArgumentValue value={item} depth={depth + 1} />
          </li>
        ))}
        {value.length > 12 && <li>+{value.length - 12} more</li>}
      </ul>
    );
  }
  if (value && typeof value === "object" && depth < 2) {
    return (
      <dl className="trace-args nested">
        {Object.entries(value).map(([key, item]) => (
          <ArgumentRow key={key} name={key} value={item} depth={depth + 1} />
        ))}
      </dl>
    );
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 140 || text.includes("\n") ? <pre>{text}</pre> : text;
}

function ArgumentRow({ name, value, depth = 0 }) {
  const block =
    typeof value === "object" && value !== null
      ? true
      : String(value).length > 140 || String(value).includes("\n");
  return (
    <div className={`trace-arg${block ? " long" : ""}`}>
      <dt>{name.replaceAll("_", " ")}</dt>
      <dd>
        <ArgumentValue value={value} depth={depth} />
      </dd>
    </div>
  );
}

function ToolPeek({ taskId, step, openArtifact }) {
  const { data, error } = useResource(
    `/tasks/${taskId}/tools/${step.id}`,
    step.status,
  );
  if (error) return <pre className="trace-peek">Details unavailable</pre>;
  if (!data) return <pre className="trace-peek">Loading…</pre>;
  const result = data.result;
  const files = [result, result?.artifact, ...(result?.artifacts || [])].filter(
    (item) => item?.id && item?.name && item?.metadata,
  );
  const args = Object.entries(data.arguments || {});
  return (
    <>
      {result?.error ? (
        <pre className="trace-peek failed">{result.error}</pre>
      ) : args.length ? (
        <dl className="trace-args">
          {args.map(([key, value]) => (
            <ArgumentRow key={key} name={key} value={value} />
          ))}
        </dl>
      ) : (
        <p className="trace-args-empty">No inputs</p>
      )}
      {openArtifact && files.length > 0 && (
        <div className="trace-files">
          {files.map((file) => (
            <button
              type="button"
              key={file.id}
              onClick={() => openArtifact(taskId, file.id)}
            >
              {file.name}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function Step({ step, taskId, openArtifact }) {
  const Icon =
    step.status === "failed"
      ? CircleAlert
      : TOOL_ICONS[step.name] || KIND_ICONS[step.kind] || Wrench;
  const label = (
    <span className="trace-step-label">
      <Icon size={14} className="trace-icon" aria-hidden="true" />
      <span className="trace-text">
        {step.label}
        {step.target && <span className="trace-target"> · {step.target}</span>}
      </span>
      {step.status === "running" && (
        <span className="trace-spinner" role="status" aria-label="Running" />
      )}
      {step.durationMs >= 1000 && step.status !== "running" && (
        <span className="trace-duration">{elapsedLabel(step.durationMs)}</span>
      )}
    </span>
  );
  return (
    <li className={`trace-step ${step.status}`}>
      {step.kind === "tool" ? (
        <Disclosure label={label}>
          <ToolPeek taskId={taskId} step={step} openArtifact={openArtifact} />
        </Disclosure>
      ) : step.error ? (
        <Disclosure label={label}>
          <pre className="trace-peek failed">{step.error}</pre>
        </Disclosure>
      ) : (
        label
      )}
    </li>
  );
}

function Phase({ phase, live, taskId, openArtifact }) {
  const thought = elapsedLabel(phase.thinkingMs);
  const failed = phase.steps.filter((s) => s.status === "failed").length;
  return (
    <Disclosure
      className={`trace-phase ${live ? "live" : ""}`}
      defaultOpen={live}
      label={
        <span className="trace-phase-title">
          {live ? (
            <span className="trace-spinner" aria-hidden="true" />
          ) : failed && failed === phase.steps.length ? (
            <CircleAlert
              size={13}
              className="trace-phase-mark warn"
              aria-hidden="true"
            />
          ) : (
            <Check size={13} className="trace-phase-mark" aria-hidden="true" />
          )}
          {phase.title}
          {failed > 0 && (
            <span className="trace-target">
              {" "}
              · {failed} {failed === 1 ? "retry" : "retries"}
            </span>
          )}
          {phase.steps.length > 0 && (
            <span className="trace-phase-meta">
              {phase.steps.length} {phase.steps.length === 1 ? "step" : "steps"}
            </span>
          )}
        </span>
      }
    >
      <ol className="trace-steps">
        {phase.detail && (
          <li className="trace-step reasoning">
            <Disclosure
              label={
                <span className="trace-text">
                  {thought ? `Thought for ${thought}` : "Reasoning"}
                </span>
              }
            >
              <p className="trace-reasoning">{phase.detail}</p>
            </Disclosure>
          </li>
        )}
        {phase.steps.map((step) => (
          <Step
            key={step.key}
            step={step}
            taskId={taskId}
            openArtifact={openArtifact}
          />
        ))}
        {!phase.detail && !phase.steps.length && (
          <li className="trace-step">
            <span className="trace-text">No recorded steps</span>
          </li>
        )}
      </ol>
    </Disclosure>
  );
}

export default function AgentTrace({ trace, live, taskId, openArtifact }) {
  return (
    <div className="agent-trace" aria-label="Work steps">
      {trace.phases.map((phase, i) => (
        <Phase
          key={phase.key}
          phase={phase}
          live={live && i === trace.phases.length - 1}
          taskId={taskId}
          openArtifact={openArtifact}
        />
      ))}
    </div>
  );
}
