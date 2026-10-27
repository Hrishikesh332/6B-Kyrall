import { useState } from "react";
import {
  BookMarked,
  ChevronDown,
  Layers,
  Pencil,
  Plus,
  ScrollText,
  Trash2,
} from "lucide-react";
import { api } from "./lib.js";
import { useResource } from "./hooks.js";
import {
  ConfirmButton,
  Empty,
  ErrorNotice,
  IconButton,
  Loading,
  PageHeading,
} from "./ui.jsx";

const GENERAL = "";

// General rules always apply; a rule set applies when a task matches its
// "applies when" description. The agent decides per task, or asks.
export default function RulesPage({ notify }) {
  const rules = useResource("/rules"),
    projects = useResource("/projects"),
    templates = useResource("/rules/templates");
  const templateList = Array.isArray(templates.data) ? templates.data : [];
  const [text, setText] = useState(""),
    [scope, setScope] = useState(""),
    [level, setLevel] = useState("must"),
    [ruleSet, setRuleSet] = useState(""),
    [appliesWhen, setAppliesWhen] = useState(""),
    [busy, setBusy] = useState(false);
  const act = async (work, message) => {
    setBusy(true);
    try {
      await work();
      rules.reload();
      if (message) notify?.(message);
    } catch (err) {
      notify?.(err.message);
    } finally {
      setBusy(false);
    }
  };
  const groups = new Map();
  for (const rule of rules.data || []) {
    const key = rule.rule_set || GENERAL;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rule);
  }
  const existingWhen =
    ruleSet && groups.get(ruleSet)?.find((r) => r.applies_when)?.applies_when;
  const add = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    void act(async () => {
      await api("/rules", {
        method: "POST",
        body: {
          content: text.trim(),
          ...(scope ? { project_id: scope } : {}),
          level,
          rule_set: ruleSet.trim(),
          applies_when: ruleSet.trim() ? appliesWhen.trim() : "",
        },
      });
      setText("");
    }, "Rule added.");
  };
  const ordered = [...groups.entries()].sort(([a], [b]) =>
    a === GENERAL ? -1 : b === GENERAL ? 1 : a.localeCompare(b),
  );
  const installed = new Set(groups.keys());
  return (
    <div className="page rules-page">
      <PageHeading
        title="Rules"
        description="Requirements the agent follows. General rules always apply; a rule set applies when a task matches it — the agent decides with a reason, or asks you."
      />
      {templateList.some((t) => !installed.has(t.name)) && (
        <section className="rule-templates" aria-label="Rule templates">
          <h2>
            <BookMarked size={14} aria-hidden="true" /> Start from a template
          </h2>
          <div className="rule-template-list">
            {templateList
              .filter((t) => !installed.has(t.name))
              .map((t) => (
                <article key={t.id} className="rule-template">
                  <strong>{t.name}</strong>
                  <p>{t.applies_when}</p>
                  <small>
                    {t.count} rules · {t.source}
                  </small>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      act(
                        () =>
                          api(
                            `/rules/templates/${t.id}${scope ? `?project_id=${scope}` : ""}`,
                            { method: "POST" },
                          ),
                        `Added “${t.name}”.`,
                      )
                    }
                  >
                    <Plus size={14} /> Add set
                  </button>
                </article>
              ))}
          </div>
        </section>
      )}
      <form className="rule-form" onSubmit={add}>
        <textarea
          aria-label="New rule"
          rows={2}
          maxLength={2000}
          value={text}
          placeholder="e.g. Use metric units and keep walls at least 2 mm thick"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) add(e);
          }}
        />
        <div className="rule-form-fields">
          <label>
            Level
            <select
              aria-label="Level"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
            >
              <option value="must">Must</option>
              <option value="should">Should</option>
            </select>
          </label>
          <label>
            Rule set
            <input
              aria-label="Rule set"
              list="rule-sets"
              value={ruleSet}
              placeholder="General (always applies)"
              onChange={(e) => setRuleSet(e.target.value)}
            />
            <datalist id="rule-sets">
              {[...groups.keys()].filter(Boolean).map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
          {ruleSet.trim() && !existingWhen && (
            <label className="wide">
              Applies when
              <input
                aria-label="Applies when"
                value={appliesWhen}
                placeholder="e.g. Designing a gripper for the Franka hackathon"
                onChange={(e) => setAppliesWhen(e.target.value)}
              />
            </label>
          )}
          <label>
            Scope
            <select
              aria-label="Applies to"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="">All projects</option>
              {(projects.data || []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" disabled={busy || !text.trim()}>
            <Plus size={15} /> Add rule
          </button>
        </div>
      </form>
      {rules.loading && !rules.data && <Loading />}
      {rules.error && <ErrorNotice error={rules.error} retry={rules.reload} />}
      {rules.data &&
        (rules.data.length ? (
          <div className="rule-groups">
            {ordered.map(([name, items]) => (
              <RuleGroup
                key={name || "general"}
                name={name}
                rules={items}
                busy={busy}
                act={act}
              />
            ))}
          </div>
        ) : (
          <Empty icon={ScrollText} title="No rules yet">
            Add a rule or start from a template. The agent follows general rules
            everywhere and decides when a rule set applies.
          </Empty>
        ))}
    </div>
  );
}

function RuleGroup({ name, rules, busy, act }) {
  const [open, setOpen] = useState(true),
    [editing, setEditing] = useState(false);
  const when = rules.find((r) => r.applies_when)?.applies_when || "";
  const [draft, setDraft] = useState(when);
  const must = rules.filter((r) => r.level !== "should").length;
  const on = rules.filter((r) => r.enabled).length;
  return (
    <section
      className={`rule-group${name ? " is-set" : ""}`}
      aria-label={name || "General rules"}
    >
      <header>
        <button
          className="rule-group-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {name ? (
            <Layers size={15} aria-hidden="true" />
          ) : (
            <ScrollText size={15} aria-hidden="true" />
          )}
          <span>
            <strong>{name || "General rules"}</strong>
            <small>
              {name ? "Applies when the task matches" : "Always applies"} ·{" "}
              {must} must · {rules.length - must} should
              {on < rules.length ? ` · ${rules.length - on} off` : ""}
            </small>
          </span>
          <ChevronDown size={14} className="rule-chevron" aria-hidden="true" />
        </button>
      </header>
      {name && (
        <div className="rule-when">
          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await api(`/rules/${rules[0].id}`, {
                    method: "PATCH",
                    body: { applies_when: draft.trim() },
                  });
                  setEditing(false);
                }, "Updated when this set applies.");
              }}
            >
              <input
                aria-label={`Applies when: ${name}`}
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditing(false);
                }}
              />
              <button
                type="button"
                className="secondary"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                Save
              </button>
            </form>
          ) : (
            <>
              <p>
                <span>Applies when</span>{" "}
                {when || "Not described — always applies"}
              </p>
              <IconButton
                label={`Edit when ${name} applies`}
                onClick={() => {
                  setDraft(when);
                  setEditing(true);
                }}
              >
                <Pencil size={13} />
              </IconButton>
            </>
          )}
          {rules[0]?.source && <small>Source: {rules[0].source}</small>}
        </div>
      )}
      {open && (
        <ul className="rule-list">
          {rules.map((rule) => (
            <li key={rule.id} className={rule.enabled ? "" : "is-off"}>
              <label className="rule-toggle">
                <input
                  type="checkbox"
                  checked={!!rule.enabled}
                  disabled={busy}
                  aria-label={`${rule.enabled ? "Turn off" : "Turn on"}: ${rule.content}`}
                  onChange={() =>
                    act(() =>
                      api(`/rules/${rule.id}`, {
                        method: "PATCH",
                        body: { enabled: !rule.enabled },
                      }),
                    )
                  }
                />
              </label>
              <button
                className={`rule-level ${rule.level || "must"}`}
                title="Switch between must and should"
                disabled={busy}
                onClick={() =>
                  act(() =>
                    api(`/rules/${rule.id}`, {
                      method: "PATCH",
                      body: {
                        level: rule.level === "should" ? "must" : "should",
                      },
                    }),
                  )
                }
              >
                {rule.level === "should" ? "Should" : "Must"}
              </button>
              <p>{rule.content}</p>
              <span className="rule-scope">
                {rule.project_name || "All projects"}
              </span>
              <ConfirmButton
                className="icon-button"
                label={`Delete rule: ${rule.content}`}
                confirm="Delete?"
                disabled={busy}
                onConfirm={() =>
                  act(
                    () => api(`/rules/${rule.id}`, { method: "DELETE" }),
                    "Rule deleted.",
                  )
                }
              >
                <Trash2 size={15} />
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
