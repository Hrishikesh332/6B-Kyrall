import { useState } from "react";
import {
  Check,
  ChevronDown,
  CircleHelp,
  Minus,
  ScrollText,
  X,
} from "lucide-react";
import { api } from "./lib.js";
import { useResource } from "./hooks.js";

const CHECK = {
  met: { label: "Met", Icon: Check },
  not_met: { label: "Not met", Icon: X },
  unverified: { label: "Unverified", Icon: CircleHelp },
  not_applicable: { label: "Not applicable", Icon: Minus },
};

const statusLabel = (set) =>
  set.decision?.decided_by === "default"
    ? set.status === "applied"
      ? "On by default"
      : "Off by default"
    : {
        always: "Always applies",
        applied:
          set.decision?.decided_by === "user"
            ? "Applied by you"
            : "Applied by 6B",
        skipped:
          set.decision?.decided_by === "user" ? "Skipped by you" : "Not needed",
        pending: "Needs a decision",
      }[set.status];

// Which rule sets this task follows, why, and how the design meets each rule.
export default function TaskRules({ task, notify }) {
  const resource = useResource(
    `/tasks/${task.id}/rules`,
    task.last_event_id,
    true,
  );
  const [open, setOpen] = useState(null),
    [busy, setBusy] = useState(false);
  const sets = (Array.isArray(resource.data) ? resource.data : []).filter(
    (s) => s.rules?.length,
  );
  if (!sets.length) return null;
  const active = sets.filter((s) => ["always", "applied"].includes(s.status));
  const checks = active.flatMap((s) => s.rules).filter((r) => r.check);
  const met = checks.filter((r) => r.check.status === "met").length;
  const decide = async (set, apply) => {
    setBusy(true);
    try {
      await api(`/tasks/${task.id}/rules`, {
        method: "PUT",
        body: { rule_set: set.rule_set, apply },
      });
      resource.reload();
    } catch (err) {
      notify?.(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="task-rules" aria-label="Rules for this task">
      <header>
        <ScrollText size={15} aria-hidden="true" />
        <strong>Rules</strong>
        <span>
          {active.length} {active.length === 1 ? "set" : "sets"} in force
          {checks.length > 0 && ` · ${met}/${checks.length} checks met`}
        </span>
      </header>
      {sets.map((set) => {
        const key = set.rule_set || "general";
        const expanded = open === key;
        return (
          <article key={key} className={`task-rule-set status-${set.status}`}>
            <div className="task-rule-head">
              <button
                className="task-rule-toggle"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : key)}
              >
                <span className="task-rule-name">
                  {set.rule_set || "General rules"}
                </span>
                <span className={`task-rule-status ${set.status}`}>
                  {statusLabel(set)}
                </span>
                <ChevronDown size={13} aria-hidden="true" />
              </button>
              {set.conditional && (
                <div
                  className="segmented small"
                  role="group"
                  aria-label={`Use ${set.rule_set}`}
                >
                  <button
                    aria-pressed={set.status === "applied"}
                    disabled={busy}
                    onClick={() => decide(set, true)}
                  >
                    Apply
                  </button>
                  <button
                    aria-pressed={set.status === "skipped"}
                    disabled={busy}
                    onClick={() => decide(set, false)}
                  >
                    Skip
                  </button>
                </div>
              )}
            </div>
            {set.decision?.reason && (
              <p className="task-rule-reason">{set.decision.reason}</p>
            )}
            {expanded && (
              <ul className="task-rule-list">
                {set.rules.map((rule) => {
                  const state = rule.check && CHECK[rule.check.status];
                  const Icon = state?.Icon;
                  return (
                    <li
                      key={rule.id}
                      className={`check-${rule.check?.status || "none"}`}
                    >
                      <span
                        className="rule-check-icon"
                        title={state?.label || "Not checked yet"}
                      >
                        {Icon ? <Icon size={11} /> : null}
                      </span>
                      <span className="rule-check-text">
                        <span className={`rule-level ${rule.level}`}>
                          {rule.level === "should" ? "Should" : "Must"}
                        </span>
                        {rule.text}
                        {rule.check?.evidence && (
                          <small>
                            {state.label}: {rule.check.evidence}
                          </small>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </article>
        );
      })}
    </section>
  );
}
