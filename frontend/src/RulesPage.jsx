import { useRef, useState } from "react";
import {
  BookMarked,
  ChevronDown,
  FolderOpen,
  Layers,
  Pencil,
  Plus,
  ScrollText,
  Search,
  Trash2,
} from "lucide-react";
import { api } from "./lib.js";
import { useResource } from "./hooks.js";
import {
  Clamp,
  ConfirmButton,
  Empty,
  ErrorNotice,
  IconButton,
  Loading,
  PageHeading,
} from "./ui.jsx";

const GENERAL = "";
const LEVEL_FILTERS = [
  ["all", "All"],
  ["must", "Must"],
  ["should", "Should"],
];

// An on/off switch over a real checkbox, so it keeps checkbox semantics.
function Switch({ checked, label, mixed = false, ...props }) {
  return (
    <label className={`switch${mixed ? " is-mixed" : ""}`} title={label}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        aria-label={label}
        {...props}
      />
      <span aria-hidden="true" />
    </label>
  );
}

// Marks each match of the search, so a filtered rule shows why it matched.
function Highlight({ text, query }) {
  if (!query) return text;
  const lower = text.toLowerCase(),
    needle = query.toLowerCase(),
    parts = [];
  let from = 0,
    at;
  while ((at = lower.indexOf(needle, from)) !== -1) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return parts;
}

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
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [levelFilter, setLevelFilter] = useState("all");
  const composer = useRef(null);
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
  const all = rules.data || [];
  const groups = new Map();
  for (const rule of all) {
    const key = rule.rule_set || GENERAL;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rule);
  }
  const existingWhen =
    ruleSet && groups.get(ruleSet)?.find((r) => r.applies_when)?.applies_when;
  const add = (e) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
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
  // "+" on a set fills the composer with that set and puts the cursor there.
  const addTo = (name) => {
    setRuleSet(name);
    composer.current?.focus();
    composer.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const ordered = [...groups.entries()].sort(([a], [b]) =>
    a === GENERAL ? -1 : b === GENERAL ? 1 : a.localeCompare(b),
  );
  const installed = new Set(groups.keys());
  const needle = query.trim().toLowerCase();
  const filtering = !!needle || levelFilter !== "all";
  const matches = (rule) =>
    (levelFilter === "all" || (rule.level || "must") === levelFilter) &&
    (!needle ||
      rule.content.toLowerCase().includes(needle) ||
      (rule.rule_set || "").toLowerCase().includes(needle));
  const shown = ordered
    .map(([name, items]) => [name, items, items.filter(matches)])
    .filter(([, , visible]) => visible.length);
  return (
    <div className="page rules-page">
      <PageHeading
        title="Rules"
        description="What the agent follows in every chat. General rules always apply; a rule set applies when a chat matches it."
      />
      <form className="rule-composer" onSubmit={add}>
        <textarea
          ref={composer}
          aria-label="New rule"
          rows={1}
          maxLength={2000}
          value={text}
          placeholder="Add a rule, e.g. Keep every wall at least 2 mm thick"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)
              add(e);
          }}
        />
        <div className="rule-composer-bar">
          <div
            className="rule-level-picker"
            role="radiogroup"
            aria-label="Level"
          >
            {["must", "should"].map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={level === value}
                onClick={() => setLevel(value)}
              >
                {value === "must" ? "Must" : "Should"}
              </button>
            ))}
          </div>
          <label className="rule-composer-field" title="Rule set">
            <Layers size={13} aria-hidden="true" />
            <input
              aria-label="Rule set"
              list="rule-sets"
              value={ruleSet}
              placeholder="General rules"
              onChange={(e) => setRuleSet(e.target.value)}
            />
            <datalist id="rule-sets">
              {[...groups.keys()].filter(Boolean).map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
          <label className="rule-composer-field" title="Projects it applies to">
            <FolderOpen size={13} aria-hidden="true" />
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
          <small className="rule-composer-hint">Enter to add</small>
          <button className="primary" disabled={busy || !text.trim()}>
            <Plus size={15} /> Add rule
          </button>
        </div>
        {ruleSet.trim() && !existingWhen && (
          <label className="rule-composer-when">
            <span>New set · applies when</span>
            <input
              aria-label="Applies when"
              value={appliesWhen}
              placeholder="e.g. Designing a gripper for the Franka hackathon"
              onChange={(e) => setAppliesWhen(e.target.value)}
            />
          </label>
        )}
      </form>
      {rules.loading && !rules.data && <Loading />}
      {rules.error && <ErrorNotice error={rules.error} retry={rules.reload} />}
      {rules.data &&
        (all.length ? (
          <>
            <div className="rules-toolbar">
              <label className="rules-search">
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Search rules"
                  placeholder="Search rules and sets"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <div
                className="rules-filter"
                role="radiogroup"
                aria-label="Show rules"
              >
                {LEVEL_FILTERS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={levelFilter === value}
                    onClick={() => setLevelFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {shown.length ? (
              <div className="rule-groups">
                {shown.map(([name, items, visible]) => (
                  <RuleGroup
                    key={name || "general"}
                    name={name}
                    rules={items}
                    visible={visible}
                    query={needle}
                    forceOpen={filtering}
                    busy={busy}
                    act={act}
                    onAddTo={addTo}
                  />
                ))}
              </div>
            ) : (
              <div className="rules-no-match">
                <p>
                  No rules match
                  {needle ? ` “${query.trim()}”` : " this filter"}.
                </p>
                <button
                  className="text-button"
                  onClick={() => {
                    setQuery("");
                    setLevelFilter("all");
                  }}
                >
                  Clear filters
                </button>
              </div>
            )}
          </>
        ) : (
          <Empty icon={ScrollText} title="No rules yet">
            Add a rule or start from a template. The agent follows general rules
            everywhere and decides when a rule set applies.
          </Empty>
        ))}
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
                  <div>
                    <strong>{t.name}</strong>
                    <Clamp lines={2}>
                      <p>{t.applies_when}</p>
                    </Clamp>
                    <small>
                      {t.count} rules · {t.source}
                    </small>
                  </div>
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
    </div>
  );
}

function RuleGroup({
  name,
  rules,
  visible,
  query,
  forceOpen,
  busy,
  act,
  onAddTo,
}) {
  const [open, setOpen] = useState(true),
    [editing, setEditing] = useState(false);
  const when = rules.find((r) => r.applies_when)?.applies_when || "";
  const [draft, setDraft] = useState(when);
  const label = name || "General rules";
  const must = rules.filter((r) => r.level !== "should").length;
  const on = rules.filter((r) => r.enabled).length;
  const allOn = on === rules.length;
  const expanded = open || forceOpen;
  // The set's switch turns every rule in it on, or (when all are on) off.
  const switchAll = () =>
    act(
      () =>
        Promise.all(
          rules
            .filter((r) => !!r.enabled === allOn)
            .map((r) =>
              api(`/rules/${r.id}`, {
                method: "PATCH",
                body: { enabled: !allOn },
              }),
            ),
        ),
      allOn ? `Turned off ${label}.` : `Turned on ${label}.`,
    );
  return (
    <section
      className={`rule-group${name ? " is-set" : ""}${on ? "" : " is-off"}`}
      aria-label={label}
    >
      <header>
        <button
          className="rule-group-toggle"
          aria-expanded={expanded}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown size={14} className="rule-chevron" aria-hidden="true" />
          <span className="rule-group-icon">
            {name ? (
              <Layers size={15} aria-hidden="true" />
            ) : (
              <ScrollText size={15} aria-hidden="true" />
            )}
          </span>
          <span className="rule-group-title">
            <strong>{label}</strong>
            <small>
              {name ? "When a chat matches" : "Always applies"} · {must} must ·{" "}
              {rules.length - must} should
              {!allOn && ` · ${rules.length - on} off`}
            </small>
          </span>
        </button>
        <IconButton
          label={`Add a rule to ${label}`}
          onClick={() => onAddTo(name)}
        >
          <Plus size={15} />
        </IconButton>
        <Switch
          checked={allOn}
          mixed={!!on && !allOn}
          disabled={busy}
          label={`${allOn ? "Turn off" : "Turn on"} all rules in ${label}`}
          onChange={switchAll}
        />
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
              <span className="rule-when-label">Applies when</span>
              <p>{when || "Not described, so it always applies"}</p>
              <IconButton
                label={`Edit when ${name} applies`}
                onClick={() => {
                  setDraft(when);
                  setEditing(true);
                }}
              >
                <Pencil size={13} />
              </IconButton>
              {rules[0]?.source && <small>Source: {rules[0].source}</small>}
            </>
          )}
        </div>
      )}
      {expanded && (
        <ul className="rule-list">
          {visible.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              query={query}
              busy={busy}
              act={act}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function RuleRow({ rule, query, busy, act }) {
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(rule.content);
  const edit = () => {
    setDraft(rule.content);
    setEditing(true);
  };
  const save = (e) => {
    e.preventDefault();
    const next = draft.trim();
    if (!next || next === rule.content) return setEditing(false);
    void act(async () => {
      await api(`/rules/${rule.id}`, {
        method: "PATCH",
        body: { content: next },
      });
      setEditing(false);
    }, "Rule updated.");
  };
  return (
    <li className={`rule-row${rule.enabled ? "" : " is-off"}`}>
      <Switch
        checked={!!rule.enabled}
        disabled={busy}
        label={`${rule.enabled ? "Turn off" : "Turn on"}: ${rule.content}`}
        onChange={() =>
          act(() =>
            api(`/rules/${rule.id}`, {
              method: "PATCH",
              body: { enabled: !rule.enabled },
            }),
          )
        }
      />
      <button
        className={`rule-level ${rule.level || "must"}`}
        title="Switch between must and should"
        disabled={busy}
        onClick={() =>
          act(() =>
            api(`/rules/${rule.id}`, {
              method: "PATCH",
              body: { level: rule.level === "should" ? "must" : "should" },
            }),
          )
        }
      >
        {rule.level === "should" ? "Should" : "Must"}
      </button>
      {editing ? (
        <form className="rule-edit" onSubmit={save}>
          <textarea
            aria-label="Edit rule"
            value={draft}
            rows={2}
            maxLength={2000}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter" && !e.shiftKey) save(e);
            }}
          />
          <div className="rule-edit-actions">
            <small>Enter to save · Esc to cancel</small>
            <button
              type="button"
              className="secondary"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button className="primary" disabled={busy || !draft.trim()}>
              Save
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="rule-text" onDoubleClick={edit}>
            <Highlight text={rule.content} query={query} />
          </p>
          {rule.project_name && (
            <span className="rule-scope">{rule.project_name}</span>
          )}
          <span className="rule-actions">
            <IconButton label={`Edit rule: ${rule.content}`} onClick={edit}>
              <Pencil size={14} />
            </IconButton>
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
              <Trash2 size={14} />
            </ConfirmButton>
          </span>
        </>
      )}
    </li>
  );
}
