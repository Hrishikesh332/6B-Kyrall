import { useState } from "react";
import {
  Check,
  ChevronDown,
  ClipboardCheck,
  MessageSquareReply,
  SlidersHorizontal,
} from "lucide-react";
import { api } from "./lib.js";

// The plan the agent wants to apply to an existing design, held until decided.
export function ApprovalCard({ message, task, refresh }) {
  const plan = message.content;
  const record = task.approvals?.find((a) => a.id === plan.id);
  const decision = record?.decision;
  const pending = record?.status === "pending";
  // Decided plans fold down to their title; open ones stay expanded for a decision.
  const collapsible = !!record && !pending;
  const [open, setOpen] = useState(!collapsible),
    [mode, setMode] = useState(""),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [answers, setAnswers] = useState(() =>
      Object.fromEntries((plan.questions || []).map((q) => [q.id, q.default])),
    );
  const decide = async (choice) => {
    setBusy(true);
    setError("");
    try {
      await api(`/tasks/${task.id}/approvals/${plan.id}`, {
        method: "POST",
        body: { decision: choice, note, answers },
      });
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article
      className={`approval-card status-${record?.status || "pending"}${open ? "" : " is-collapsed"}`}
      aria-label={`Plan for approval: ${plan.title}`}
    >
      <header>
        <button
          type="button"
          className="approval-toggle"
          disabled={!collapsible}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ClipboardCheck size={16} aria-hidden="true" />
          <div>
            <span className="eyebrow">PLAN FOR APPROVAL</span>
            <h3>{plan.title}</h3>
          </div>
          {collapsible && (
            <>
              <span className="approval-status">
                {record.status === "approved" ? (
                  <>
                    <Check size={12} /> Approved
                  </>
                ) : (
                  "Changes requested"
                )}
              </span>
              <ChevronDown
                size={14}
                className="approval-chevron"
                aria-hidden="true"
              />
            </>
          )}
        </button>
      </header>
      {open && body()}
      {decision?.note && (
        <p className="approval-note">
          <MessageSquareReply size={13} aria-hidden="true" /> {decision.note}
        </p>
      )}
    </article>
  );
  function body() {
    return (
      <>
        <p>{plan.summary}</p>
        <table className="approval-changes">
          <thead>
            <tr>
              <th scope="col">What</th>
              <th scope="col">Change</th>
            </tr>
          </thead>
          <tbody>
            {plan.changes.map((c, i) => (
              <tr key={i}>
                <td>{c.target}</td>
                <td>{c.change}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {[
          ["Stays fixed", plan.preserved],
          ["Risks", plan.risks],
          ["Checks after the change", plan.checks],
        ]
          .filter(([, items]) => items?.length)
          .map(([title, items]) => (
            <div className="approval-list" key={title}>
              <strong>{title}</strong>
              <ul>
                {items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        {plan.questions?.length > 0 && (
          <fieldset className="approval-questions" disabled={!pending || busy}>
            <legend>
              {pending ? "Before I build, please confirm" : "Your answers"}
            </legend>
            {plan.questions.map((q) => {
              const chosen = pending
                ? answers[q.id]
                : (decision?.answers?.[q.question] ?? q.default);
              return (
                <div className="approval-question" key={q.id}>
                  <span id={`q-${plan.id}-${q.id}`}>{q.question}</span>
                  <div
                    className="approval-options"
                    role="radiogroup"
                    aria-labelledby={`q-${plan.id}-${q.id}`}
                  >
                    {q.options.map((option) => (
                      <button
                        type="button"
                        key={option}
                        role="radio"
                        aria-checked={chosen === option}
                        onClick={() =>
                          setAnswers((a) => ({ ...a, [q.id]: option }))
                        }
                      >
                        {option}
                        {option === q.default && <small>Recommended</small>}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </fieldset>
        )}
        {pending && task.status === "awaiting_input" && (
          <div className="approval-actions">
            {mode === "changes" ? (
              <>
                <label htmlFor={`changes-${plan.id}`}>
                  What should change in the plan?
                </label>
                <textarea
                  id={`changes-${plan.id}`}
                  rows={3}
                  value={note}
                  maxLength={4000}
                  onChange={(e) => setNote(e.target.value)}
                />
                <div className="button-row">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => setMode("")}
                  >
                    Back
                  </button>
                  <button
                    className="primary"
                    disabled={busy || !note.trim()}
                    onClick={() => decide("changes")}
                  >
                    Send back
                  </button>
                </div>
              </>
            ) : (
              <div className="button-row">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => setMode("changes")}
                >
                  Request changes
                </button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => decide("approve")}
                >
                  <Check size={14} /> Approve and build
                </button>
              </div>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </>
    );
  }
}

export function ParameterChange({ message }) {
  const { source, values, passed } = message.content;
  const text = Object.entries(values)
    .map(
      ([name, value]) =>
        `${name.replaceAll("_", " ")} ${typeof value === "boolean" ? (value ? "on" : "off") : value}`,
    )
    .join(", ");
  return (
    <p className="parameter-change">
      <SlidersHorizontal size={13} aria-hidden="true" />
      <span>
        Rebuilt <strong>{source}</strong> with {text}
        {passed ? " · checks passed" : " · checks need attention"}
      </span>
    </p>
  );
}

export function ApprovalPolicy({ task, refresh, notify }) {
  const [busy, setBusy] = useState(false);
  const policy = task.approval_policy || "ask";
  const change = async (value) => {
    setBusy(true);
    try {
      await api(`/tasks/${task.id}`, {
        method: "PATCH",
        body: { approval_policy: value },
      });
      await refresh();
    } catch (err) {
      notify?.(err.message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <label
      className="approval-policy"
      title="Whether 6B shows a plan before changing an existing design"
    >
      Design changes
      <select
        value={policy}
        disabled={busy}
        onChange={(e) => change(e.target.value)}
      >
        <option value="ask">Ask me first</option>
        <option value="auto">Apply automatically</option>
      </select>
    </label>
  );
}
