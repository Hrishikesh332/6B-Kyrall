import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ClipboardList,
  MessageSquareText,
  X,
} from "lucide-react";
import { checklistSteps } from "./checklist.js";
import { elapsedLabel } from "./trace.js";
import { TOOL_ICONS } from "./AgentTrace.jsx";
import { Wrench } from "lucide-react";

function StepIcon({ status, live }) {
  if (status === "completed")
    return (
      <span className="check-icon done" aria-hidden="true">
        <Check size={12} strokeWidth={3} />
      </span>
    );
  if (status === "blocked")
    return (
      <span className="check-icon blocked" aria-hidden="true">
        <AlertTriangle size={12} />
      </span>
    );
  if (status === "in_progress")
    return (
      <span
        className={`check-icon active${live ? " spinning" : ""}`}
        aria-hidden="true"
      />
    );
  return <span className="check-icon pending" aria-hidden="true" />;
}

const actionSummary = (step) => {
  const count = step.actions.filter((a) => !a.note).length;
  if (!count) return null;
  const time = elapsedLabel(step.duration);
  return `${count} action${count === 1 ? "" : "s"}${time ? ` · ${time}` : ""}`;
};

const statusText = (status, live, waiting) =>
  ({
    completed: "Done",
    blocked: "Blocked",
    in_progress: waiting ? "Waiting for you" : live ? "Working" : "Paused",
    pending: "Up next",
  })[status] || status;

// The run's visible plan: live state per step, each expandable to what was done.
export default function TaskChecklist({ plan, activity, status }) {
  const live = ["running", "queued"].includes(status);
  const waiting = status === "awaiting_input";
  const steps = checklistSteps(plan, activity);
  const done = steps.filter((s) => s.status === "completed").length;
  const current = steps.find((s) => s.status === "in_progress");
  const [open, setOpen] = useState(live || waiting);
  const [expanded, setExpanded] = useState(current?.id || null);
  useEffect(() => {
    if (live) setOpen(true);
  }, [live]);
  // Follow the active step while the run moves through the plan.
  useEffect(() => {
    if (current?.id) setExpanded(current.id);
  }, [current?.id]);
  if (!steps.length) return null;
  const complete = done === steps.length;
  const planning = complete && live;
  return (
    <section
      className={`task-checklist${live ? " is-live" : ""}${complete && !planning ? " is-complete" : ""}`}
      aria-label="Task checklist"
    >
      <button
        className="checklist-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="checklist-badge" aria-hidden="true">
          {planning ? (
            <span className="check-icon active spinning" />
          ) : complete ? (
            <Check size={14} strokeWidth={3} />
          ) : (
            <ClipboardList size={14} />
          )}
        </span>
        <span className="checklist-title">
          <strong>
            {planning
              ? "Planning next steps…"
              : complete
                ? "Checklist complete"
                : current
                  ? current.title
                  : "Checklist"}
          </strong>
          <small>
            {planning
              ? "Previous checklist finished"
              : complete
                ? `${steps.length} steps done`
                : `Step ${Math.min(done + 1, steps.length)} of ${steps.length} · ${statusText(current?.status || "pending", live, waiting)}`}
          </small>
        </span>
        <span className="checklist-count">
          {done}/{steps.length}
        </span>
        <ChevronDown
          size={15}
          className="checklist-chevron"
          aria-hidden="true"
        />
        <span className="checklist-progress" aria-hidden="true">
          <span style={{ width: `${(done / steps.length) * 100}%` }} />
        </span>
      </button>
      {open && (
        <ol className="checklist-steps">
          {steps.map((step, index) => {
            const isOpen = expanded === step.id;
            return (
              <li
                key={step.id}
                className={`checklist-step status-${step.status}`}
                style={{ "--i": index }}
              >
                <button
                  className="checklist-step-head"
                  aria-expanded={isOpen}
                  disabled={!step.actions.length}
                  onClick={() => setExpanded(isOpen ? null : step.id)}
                >
                  <StepIcon status={step.status} live={live} />
                  <span className="checklist-step-title">{step.title}</span>
                  <span className="checklist-step-meta">
                    {actionSummary(step)}
                    {step.status === "in_progress" && (
                      <em>{statusText(step.status, live, waiting)}</em>
                    )}
                  </span>
                  {step.actions.length > 0 && (
                    <ChevronDown
                      size={13}
                      className="step-chevron"
                      aria-hidden="true"
                    />
                  )}
                </button>
                {isOpen && step.actions.length > 0 && (
                  <ul className="checklist-actions">
                    {step.actions.map((action) => (
                      <li key={action.id} className={`action-${action.status}`}>
                        {action.note ? (
                          <MessageSquareText size={12} aria-hidden="true" />
                        ) : action.status === "running" ? (
                          <span className="action-spinner" aria-hidden="true" />
                        ) : action.status === "failed" ? (
                          <X size={12} aria-hidden="true" />
                        ) : (
                          (() => {
                            const Icon = TOOL_ICONS[action.name] || Wrench;
                            return <Icon size={12} aria-hidden="true" />;
                          })()
                        )}
                        <span>
                          {action.label}
                          {action.note && action.detail && (
                            <small>{action.detail}</small>
                          )}
                          {action.status === "failed" && action.error && (
                            <small>{action.error}</small>
                          )}
                        </span>
                        {action.duration > 0 && (
                          <time>{elapsedLabel(action.duration)}</time>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
