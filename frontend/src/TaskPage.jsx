import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  ClipboardList,
  File,
  Files,
  HandGrab,
  MessageSquare,
  Paperclip,
  Pause,
  Pencil,
  RotateCcw,
  CloudDownload,
  Upload,
  Download,
} from "lucide-react";
import { api, deliveredArtifacts, latestArtifacts } from "./lib.js";
import { renderText } from "../format.js";
import { useResource, useTask } from "./hooks.js";
import PhotoAttachments, { maxPhotos, photoTypes } from "./PhotoAttachments.jsx";
import SimulationPanel from "./SimulationPanel.jsx";
import PickPlacePanel from "./PickPlacePanel.jsx";
import { EvidenceContent } from "./EvidencePanel.jsx";
import ExecutionSummary from "./ExecutionSummary.jsx";
import TaskChecklist from "./TaskChecklist.jsx";
import TaskRules from "./TaskRules.jsx";
import ModelTag from "./ModelTag.jsx";
import { ApprovalCard, ApprovalPolicy, ParameterChange } from "./Approval.jsx";
import AgentTrace from "./AgentTrace.jsx";
import { buildTimeline } from "./trace.js";
import FileLibrary, { FileGallery } from "./FileLibrary.jsx";
import {
  Animated,
  Badge,
  Composer,
  Empty,
  ErrorNotice,
  Loading,
} from "./ui.jsx";

export default function TaskPage({
  id,
  cap,
  openArtifact,
  setModal,
  notify,
  onTaskChange,
  onConnection,
}) {
  const { task, activity, error, refresh } = useTask(
    id,
    onTaskChange,
    onConnection,
  );
  const audit = useResource(
    `/tasks/${id}/audit`,
    task?.last_event_id || 0,
    true,
  );
  const [tab, setTab] = useState("conversation"),
    [busy, setBusy] = useState(false),
    [photos, setPhotos] = useState([]),
    [dragging, setDragging] = useState(false);
  const uploadInput = useRef(null),
    end = useRef(null),
    priorCount = useRef(0);
  useEffect(() => {
    if (task?.messages.length !== priorCount.current) {
      if (priorCount.current && end.current)
        end.current.scrollIntoView({ block: "nearest" });
      priorCount.current = task?.messages.length || 0;
    }
  }, [task?.messages.length]);
  const action = async (operation) => {
    if (busy) return;
    setBusy(true);
    try {
      await operation();
      await refresh();
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  };
  if (!task)
    return (
      <div className="page">
        {error ? (
          <ErrorNotice error={error} retry={refresh} />
        ) : (
          <Loading>Loading project…</Loading>
        )}
      </div>
    );
  const active = ["running", "queued", "awaiting_input"].includes(task.status);
  const artifacts = deliveredArtifacts(task);
  const model =
    artifacts.find(
      (a) => a.metadata.kind === "cad" && /\.step$/i.test(a.name),
    ) || artifacts.find((a) => a.metadata.kind === "cad");
  const lastError = task.runs.at(-1)?.error;
  const timeline = buildTimeline(task.messages, activity, audit.data?.tools);
  const upload = (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    return attach(files);
  };
  // Photos wait in the composer so they can be tagged before sending.
  const attach = async (files) => {
    const images = files.filter((f) => photoTypes.includes(f.type));
    const others = files.filter((f) => !photoTypes.includes(f.type));
    const room = maxPhotos - photos.length;
    if (images.length > room)
      notify(`Attach up to ${maxPhotos} photos per message.`);
    const staged = images.slice(0, Math.max(room, 0)).map((file) => ({
      id: crypto.randomUUID(),
      file,
      role: "object",
    }));
    if (staged.length) {
      setPhotos((current) => [...current, ...staged]);
      setTab("conversation");
    }
    if (!others.length) return;
    await action(async () => {
      for (const file of others) {
        const body = new FormData();
        body.append("file", file);
        await api(`/tasks/${id}/uploads`, { method: "POST", body });
      }
      notify("Files attached. Mention them in your next message.");
    });
  };
  const send = async ({ prompt }) => {
    let content = prompt;
    if (photos.length) {
      const sent = [];
      for (const photo of photos) {
        const body = new FormData();
        body.append("file", photo.file);
        body.append("role", photo.role);
        const artifact = await api(`/tasks/${id}/uploads`, {
          method: "POST",
          body,
        });
        sent.push(`${artifact.name} (${photo.role})`);
        // A retry after a partial failure must not re-upload this photo.
        setPhotos((current) => current.filter((p) => p.id !== photo.id));
      }
      content = `${prompt || "Use the attached photos."}\n\nAttached photos: ${sent.join(", ")}.`;
    }
    await api(`/tasks/${id}/messages`, {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: { content },
    });
    await refresh();
  };
  return (
    <div className="task-page page">
      <div className="task-heading">
        <a className="task-back" href="#tasks">
          <ArrowLeft size={14} /> All projects
        </a>
        <div className="task-heading-content">
          <div className="task-heading-copy">
            <div className="task-title-line">
              <h1>{task.title}</h1>
              <button
                className="icon-button"
                aria-label="Rename project"
                onClick={() => setModal({ kind: "rename", task, refresh })}
              >
                <Pencil size={16} />
              </button>
            </div>
            <div className="task-meta">
              <Badge status={task.status} />
              <span>{artifacts.length} deliverables</span>
              <ModelTag runs={task.runs} />
              <ApprovalPolicy task={task} refresh={refresh} />
            </div>
          </div>
          <div className="task-controls">
            <button
              className="secondary"
              title="Download the full record of this chat: messages, decisions, rules, tool calls and files"
              onClick={async () => {
                try {
                  const blob = await (
                    await api(`/tasks/${id}/session?format=md`, { raw: true })
                  ).blob();
                  const url = URL.createObjectURL(blob),
                    link = document.createElement("a");
                  link.href = url;
                  link.download = `${task.title.replace(/[^\w.-]+/g, "_").slice(0, 60)}-session.md`;
                  link.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                } catch (err) {
                  notify(err.message);
                }
              }}
            >
              <Download size={15} /> Export session
            </button>
            {active && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  action(() => api(`/tasks/${id}/cancel`, { method: "POST" }))
                }
              >
                <Pause size={15} />
                Stop
              </button>
            )}
            {["failed", "cancelled", "interrupted"].includes(task.status) && (
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  action(() => api(`/tasks/${id}/retry`, { method: "POST" }))
                }
              >
                <RotateCcw size={15} />
                Retry
              </button>
            )}
            {model &&
              /\.(step|stp)$/i.test(model.name) &&
              model.metadata.source !== "onshape" && (
                <button
                  className="secondary"
                  onClick={() =>
                    setModal({
                      kind: "onshape-export",
                      taskId: id,
                      artifactId: model.id,
                      name: model.name,
                      title: task.title,
                    })
                  }
                >
                  <Upload size={15} /> Send to Onshape
                </button>
              )}
            {model && (
              <button
                className="primary"
                onClick={() => openArtifact(id, model.id)}
              >
                <Box size={15} /> View model
              </button>
            )}
          </div>
        </div>
      </div>
      <div
        className="tabs"
        role="tablist"
        aria-label="Project views"
        onKeyDown={(e) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
            return;
          const tabs = [...e.currentTarget.querySelectorAll('[role="tab"]')];
          const current = tabs.indexOf(document.activeElement);
          if (current < 0) return;
          e.preventDefault();
          const next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? tabs.length - 1
                : (current + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) %
                  tabs.length;
          tabs[next].focus();
          tabs[next].click();
        }}
      >
        {[
          ["conversation", "Conversation", MessageSquare],
          ["files", "Files", Files],
          ["motion", "Pick & place", HandGrab],
          ["evidence", "Details", ClipboardList],
          ["simulation", "Simulation", Activity],
        ].map(([key, label, Icon]) => (
          <button
            key={key}
            id={`tab-${key}`}
            role="tab"
            aria-selected={tab === key}
            aria-controls={`panel-${key}`}
            tabIndex={tab === key ? 0 : -1}
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key)}
          >
            <Icon size={16} />
            {label}
            {key === "files" && (
              <span className="tab-count">{artifacts.length}</span>
            )}
          </button>
        ))}
      </div>
      {error && <ErrorNotice error={error} retry={refresh} />}
      {lastError && <ErrorNotice error={lastError} />}
      <div className="task-panels">
        {tab === "motion" && (
          <section
            role="tabpanel"
            id="panel-motion"
            aria-labelledby="tab-motion"
            key="motion"
          >
            <PickPlacePanel task={task} />
          </section>
        )}
        {tab === "simulation" && (
          <section
            role="tabpanel"
            id="panel-simulation"
            aria-labelledby="tab-simulation"
            key="simulation"
          >
            <SimulationPanel
              key={id}
              task={task}
              refresh={refresh}
              openArtifact={openArtifact}
            />
          </section>
        )}
        {tab === "evidence" && (
          <section
            role="tabpanel"
            id="panel-evidence"
            aria-labelledby="tab-evidence"
            key="evidence"
          >
            <EvidenceContent
              key={task.id}
              task={task}
              openArtifact={openArtifact}
              audit={audit}
              updates={<ActivityList activity={activity} />}
              onTrace={() =>
                action(async () =>
                  setModal({
                    kind: "trace",
                    trace: await api(`/tasks/${id}/trace`),
                  }),
                )
              }
            />
          </section>
        )}
        {tab === "conversation" && (
          <section
            role="tabpanel"
            id="panel-conversation"
            aria-labelledby="tab-conversation"
            key="conversation"
            className="conversation"
          >
            <Animated className="messages">
              {timeline.map((item, i) =>
                item.type === "trace" ? (
                  <AgentTrace
                    key={item.key}
                    trace={item}
                    live={active && i === timeline.length - 1}
                    taskId={task.id}
                    openArtifact={openArtifact}
                  />
                ) : (
                  <Message
                    key={item.key}
                    message={item.message}
                    task={task}
                    refresh={refresh}
                  />
                ),
              )}
            </Animated>
            <div ref={end} />
            <ExecutionSummary
              task={task}
              audit={audit}
              onOpen={() => {
                setTab("evidence");
                document.getElementById("tab-evidence")?.focus();
                document
                  .getElementById("tab-evidence")
                  ?.scrollIntoView({ block: "nearest" });
              }}
            />
            <EngineeringEvidence task={task} openArtifact={openArtifact} />
            {artifacts.length > 0 && (
              <div className="task-deliverables">
                <div className="section-heading">
                  <h2>
                    Files & deliverables<span>{artifacts.length}</span>
                  </h2>
                </div>
                <FileGallery
                  files={artifacts}
                  allFiles={latestArtifacts(task.artifacts)}
                  onOpen={openArtifact}
                  notify={notify}
                />
              </div>
            )}
            <TaskRules task={task} notify={notify} />
            <TaskChecklist
              plan={task.plan}
              activity={activity}
              status={task.status}
            />
            <div
              className={`task-composer ${dragging ? "dragging" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget))
                  setDragging(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void attach([...e.dataTransfer.files]);
              }}
            >
              <Composer
                cap={cap}
                onSubmit={send}
                contextScope={task.context_scope}
                disabled={task.status === "awaiting_input"}
                onUpload={() => uploadInput.current.click()}
                hasAttachments={photos.length > 0}
                attachments={
                  <PhotoAttachments photos={photos} onChange={setPhotos} />
                }
              />
              <p className="composer-note">
                {task.status === "awaiting_input"
                  ? task.approvals?.some((a) => a.status === "pending")
                    ? "Approve the plan or request changes to continue."
                    : "Answer the design questions to continue."
                  : task.status === "running"
                    ? "Follow-ups are queued for the next turn."
                    : "Conversation and files are saved in your local workspace."}
              </p>
            </div>
          </section>
        )}
        {tab === "files" && (
          <section
            role="tabpanel"
            id="panel-files"
            aria-labelledby="tab-files"
            key="files"
            className="task-files"
          >
            <div className="section-heading task-files-heading">
              <div>
                <h2>Design files</h2>
                <p>Latest deliverables and attached references.</p>
              </div>
              <div className="button-row">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    setModal({ kind: "onshape", view: "browse", taskId: id })
                  }
                >
                  <CloudDownload size={15} /> Import from Onshape
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => uploadInput.current.click()}
                >
                  <Paperclip size={15} /> Attach a file
                </button>
              </div>
            </div>
            {artifacts.length ? (
              <FileLibrary
                files={artifacts}
                allFiles={latestArtifacts(task.artifacts)}
                onOpen={openArtifact}
                notify={notify}
                groupByTask={false}
              />
            ) : (
              <Empty icon={Files} title="No files yet">
                Generated designs and uploaded references will appear here.
              </Empty>
            )}
          </section>
        )}
      </div>
      <input type="file" ref={uploadInput} hidden multiple onChange={upload} />
    </div>
  );
}
// Studio revisions carry a scope note for the agent; show the part as a chip.
const FOCUS =
  /^\[Component focus: ([A-Za-z0-9_]+)\]\n([\s\S]*?)\n\nScope: [\s\S]*$/;
function UserText({ content }) {
  const focus = FOCUS.exec(content);
  if (!focus) return <div className="prose plain-text">{content}</div>;
  return (
    <div className="prose plain-text">
      <span className="focus-chip">
        <Box size={12} /> {focus[1].replaceAll("_", " ")}
      </span>
      {focus[2]}
    </div>
  );
}
function Message({ message: m, task, refresh }) {
  if (m.kind === "clarification_answer" || m.kind === "approval_decision")
    return null;
  if (m.kind === "approval")
    return <ApprovalCard message={m} task={task} refresh={refresh} />;
  if (m.kind === "parameter_change") return <ParameterChange message={m} />;
  if (m.kind === "clarification") {
    const questionnaire = task.questionnaires.find(
      (q) => q.id === m.content.id,
    );
    return questionnaire ? (
      <Questionnaire
        key={questionnaire.id}
        questionnaire={questionnaire}
        task={task}
        refresh={refresh}
      />
    ) : null;
  }
  const content =
    typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  return (
    <article
      className={`message ${m.role}`}
      aria-label={m.role === "assistant" ? "6B" : "You"}
    >
      {m.kind === "attachment" ? (
        <div className="attachment">
          <Paperclip size={15} />
          {m.content.name}
          {m.content.role && (
            <span className="photo-role">{m.content.role}</span>
          )}
        </div>
      ) : m.role === "assistant" ? (
        <div
          className="prose"
          dangerouslySetInnerHTML={{ __html: renderText(content) }}
        />
      ) : (
        <UserText content={content} />
      )}
      {m.kind === "queued" && (
        <small className="queued-label">Queued for the next turn</small>
      )}
    </article>
  );
}
export function Questionnaire({ questionnaire: q, task, refresh }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  const form = useRef(null),
    locked = useRef(false);
  if (q.status === "answered")
    return (
      <details className="question-summary">
        <summary>
          <Check size={17} />
          <span>{q.title}</span>
          <small>{q.questions.length} choices saved</small>
        </summary>
        {q.questions.map((x) => (
          <p key={x.id}>
            {x.question}
            <strong>{q.answers?.answers?.[x.id] || x.default}</strong>
          </p>
        ))}
      </details>
    );
  if (q.status !== "pending")
    return <p className="muted">Design questions cancelled.</p>;
  const answer = async (skip) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    const data = new FormData(form.current),
      answers = {};
    for (const question of q.questions)
      answers[question.id] = skip
        ? question.default
        : String(
            data.get(`custom_${question.id}`) ||
              data.get(question.id) ||
              question.default,
          );
    try {
      await api(`/tasks/${task.id}/questions/${q.id}/answer`, {
        method: "POST",
        body: {
          answers,
          notes: skip ? "" : String(data.get("notes") || ""),
          skip,
        },
      });
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return (
    <form
      ref={form}
      className="question-card"
      onSubmit={(e) => {
        e.preventDefault();
        void answer(false);
      }}
    >
      <div className="eyebrow">A QUICK DESIGN CHECK</div>
      <h3>{q.title}</h3>
      {q.questions.map((question) => (
        <fieldset key={question.id}>
          <legend>{question.question}</legend>
          <div className="options">
            {question.options.map((option) => (
              <label className="choice" key={option}>
                <input
                  type="radio"
                  name={question.id}
                  value={option}
                  defaultChecked={option === question.default}
                />
                {option}
                {option === question.default && (
                  <span className="recommended">Recommended</span>
                )}
              </label>
            ))}
          </div>
          <input
            name={`custom_${question.id}`}
            aria-label={`Custom answer: ${question.question}`}
            placeholder="Or add your own answer…"
          />
        </fieldset>
      ))}
      <textarea
        name="notes"
        aria-label="Additional design details"
        placeholder="Anything else to consider?"
        rows={2}
      />
      {error && <ErrorNotice error={error} />}
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy || task.status !== "awaiting_input"}
          onClick={() => answer(true)}
        >
          Use defaults
        </button>
        <button
          className="primary"
          disabled={busy || task.status !== "awaiting_input"}
        >
          {busy ? "Continuing…" : "Continue"}
          <ArrowRight size={16} />
        </button>
      </div>
    </form>
  );
}
function ActivityList({ activity }) {
  const events = activity.filter((e) =>
    [
      "activity",
      "tool.started",
      "tool.failed",
      "validation.completed",
      "message.queued",
      "completion.checked",
      "decision.recorded",
      "source.fetched",
    ].includes(e.type),
  );
  return events.length ? (
    <Animated className="activity-list">
      {events.map((event) => (
        <div
          className={`activity-line ${event.type === "tool.failed" || event.payload.passed === false ? "failed" : ""}`}
          key={event.seq}
        >
          <span className="activity-mark">
            <Activity size={14} />
          </span>
          <div>
            <strong>
              {event.payload.title ||
                (event.type === "source.fetched" ? "Reference saved" : null) ||
                event.payload.name?.replaceAll("_", " ") ||
                (event.type === "validation.completed"
                  ? event.payload.passed
                    ? "Validation passed"
                    : "Validation needs revision"
                  : "Follow-up queued")}
            </strong>
            {event.payload.detail && <p>{event.payload.detail}</p>}
            {event.payload.summary && <p>{event.payload.summary}</p>}
            {event.type === "source.fetched" && <p>{event.payload.url}</p>}
            {event.type === "completion.checked" &&
              event.payload.errors.map((error, i) => <p key={i}>{error}</p>)}
            {event.type === "tool.failed" && (
              <p>{event.payload.result?.error}</p>
            )}
          </div>
        </div>
      ))}
    </Animated>
  ) : (
    <Empty icon={Activity} title="Nothing to report yet">
      Execution and validation events will appear here.
    </Empty>
  );
}
function EngineeringEvidence({ task, openArtifact }) {
  const current = latestArtifacts(task.artifacts);
  const geometry = current.find((a) => a.metadata.kind === "validation");
  const motion = current.find(
    (a) =>
      a.metadata.kind === "motion_validation" &&
      a.metadata.build_id === geometry?.metadata.build_id,
  );
  const review = current.find(
    (a) =>
      a.metadata.kind === "design_review" &&
      a.metadata.build_id === geometry?.metadata.build_id,
  );
  if (!motion && !review) return null;
  return (
    <div
      className={`validation-panel ${motion?.metadata.motion_passed ? "" : "warning"}`}
    >
      <h3>Prototype evidence</h3>
      <ul>
        <li>
          Static geometry:{" "}
          {geometry?.metadata.validation_passed ? "passed" : "needs revision"}
        </li>
        <li>
          Sampled motion:{" "}
          {motion
            ? motion.metadata.motion_passed
              ? "passed"
              : "collisions or clearance failures"
            : "not evaluated"}
        </li>
        <li>
          Requirement and operating-cycle review:{" "}
          {review ? "recorded" : "pending"}
        </li>
      </ul>
      <small>
        Prescribed poses do not prove grip force, release, fruit protection, or
        physical operation.
      </small>
      <div className="button-row">
        {motion && (
          <button
            className="secondary"
            onClick={() => openArtifact(task.id, motion.id)}
          >
            Motion report
          </button>
        )}
        {review && (
          <button
            className="secondary"
            onClick={() => openArtifact(task.id, review.id)}
          >
            Requirements & bench tests
          </button>
        )}
      </div>
    </div>
  );
}
