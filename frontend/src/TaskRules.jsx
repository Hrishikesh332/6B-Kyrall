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
import { Clamp } from "./ui.jsx";

// Check results, in the order the meter shows them.
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

const tally = (rules) =>
  Object.keys(CHECK)
    .map((status) => [
      status,
      rules.filter((r) => r.check?.status === status).length,
    ])
    .filter(([, count]) => count);

// One bar split by check result, with a legend of the counts.
function CheckMeter({ rules }) {
  const parts = tally(rules);
  const met = rules.filter((r) => r.check.status === "met").length;
  return (
    <div className="check-meter">
      <div
        className="check-meter-bar"
        role="img"
        aria-label={`${met} of ${rules.length} checks met`}
      >
        {parts.map(([status, count]) => (
          <span
            key={status}
            className={`check-${status}`}
            style={{ flexGrow: count }}
          />
        ))}
      </div>
      <ul className="check-meter-legend">
        {parts.map(([status, count]) => (
          <li key={status} className={`check-${status}`}>
            <i aria-hidden="true" />
            {count} {CHECK[status].label.toLowerCase()}
          </li>
        ))}
      </ul>
    </div>
  );
}

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
        <span className="task-rules-icon">
          <ScrollText size={15} aria-hidden="true" />
        </span>
        <span className="task-rules-title">
          <strong>Rules</strong>
          <small>
            {active.length} of {sets.length}{" "}
            {sets.length === 1 ? "set" : "sets"} in force
          </small>
        </span>
        <a className="task-rules-manage" href="#rules">
          Manage rules
        </a>
      </header>
      {checks.length > 0 && <CheckMeter rules={checks} />}
      <div className="task-rule-sets">
        {sets.map((set) => {
          const key = set.rule_set || "general";
          const expanded = open === key;
          const checked = set.rules.filter((r) => r.check);
          const met = checked.filter((r) => r.check.status === "met").length;
          const failing = checked.some((r) => r.check.status === "not_met");
          return (
            <article key={key} className={`task-rule-set status-${set.status}`}>
              <div className="task-rule-head">
                <button
                  className="task-rule-toggle"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : key)}
                >
                  <ChevronDown size={13} aria-hidden="true" />
                  <span className="task-rule-name">
                    {set.rule_set || "General rules"}
                  </span>
                  <span className={`task-rule-status ${set.status}`}>
                    <i aria-hidden="true" />
                    {statusLabel(set)}
                  </span>
                  {checked.length > 0 && (
                    <span
                      className={`task-rule-score${failing ? " is-failing" : ""}`}
                    >
                      {met}/{checked.length} met
                    </span>
                  )}
                </button>
                {set.conditional && (
                  <div
                    className="rule-decision"
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
                <Clamp lines={2} className="task-rule-reason">
                  <p>{set.decision.reason}</p>
                </Clamp>
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
                          <span className="rule-check-line">
                            <span className={`rule-level ${rule.level}`}>
                              {rule.level === "should" ? "Should" : "Must"}
                            </span>
                            {rule.text}
                          </span>
                          {rule.check?.evidence && (
                            <Clamp lines={2}>
                              <small>
                                {state.label}: {rule.check.evidence}
                              </small>
                            </Clamp>
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
      </div>
    </section>
  );
}
