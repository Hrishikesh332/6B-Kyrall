import { useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  ExternalLink,
  CircleAlert,
  LoaderCircle,
  CircleMinus,
} from "lucide-react";
import { useResource } from "./hooks.js";
import { statusLabel } from "./lib.js";
import { ErrorNotice, Loading } from "./ui.jsx";
import { toolLabel, durationLabel } from "./execution.js";

const timestamp = (value) =>
  value ? new Date(value * 1000).toLocaleString() : "Not recorded";
const safeURL = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
};

function ToolDetails({ taskId, call, openArtifact }) {
  const { data, error, reload } = useResource(
    `/tasks/${taskId}/tools/${call.id}`,
    call.status,
  );
  if (error) return <ErrorNotice error={error} retry={reload} />;
  if (!data) return <Loading>Loading tool details…</Loading>;
  const result = data.result;
  const errorTitle =
    {
      invalid_arguments: "The request needs a correction",
      tool_unavailable: "This tool is unavailable",
      tool_timeout: "The time limit was reached",
    }[result?.code] || "This attempt did not complete";
  const files = [result, result?.artifact, ...(result?.artifacts || [])].filter(
    (item) => item?.id && item?.name && item?.metadata,
  );
  return (
    <div className="tool-detail">
      {result?.error ? (
        <div className="tool-explanation">
          <strong>{errorTitle}</strong>
          {result.fields?.length ? (
            <ul>
              {result.fields.map((field, i) => (
                <li key={i}>
                  <code>{field.path}</code> — {field.message}
                </li>
              ))}
            </ul>
          ) : (
            <p>{result.error}</p>
          )}
          {result.hint && <p className="muted">{result.hint}</p>}
        </div>
      ) : (
        <p className="muted">
          {{
            running: "This tool is running. Its result will appear here.",
            completed: "Tool completed successfully.",
            failed: "This attempt failed. No error details were recorded.",
            cancelled: "This tool was stopped. Partial output may exist.",
            interrupted:
              "This tool was interrupted. Inspect saved output before retrying.",
          }[call.status] || "No result recorded."}
        </p>
      )}
      {openArtifact && files.length > 0 && (
        <div className="button-row">
          {files.map((file) => (
            <button
              className="secondary"
              key={file.id}
              onClick={() => openArtifact(taskId, file.id)}
            >
              {file.name}
            </button>
          ))}
        </div>
      )}
      <details className="technical-details">
        <summary>Technical details</summary>
        <div>
          <p className="muted">
            {call.name} · Started {timestamp(data.started_at)} · Finished{" "}
            {timestamp(data.finished_at)}
          </p>
          <h4>Arguments</h4>
          <pre>{JSON.stringify(data.arguments, null, 2)}</pre>
          <h4>Result</h4>
          <pre>
            {JSON.stringify(result, null, 2) || "Waiting for tool result…"}
          </pre>
        </div>
      </details>
    </div>
  );
}

export function ToolRecord({ taskId, call, openArtifact }) {
  const [open, setOpen] = useState(false);
  const Icon =
    call.status === "completed"
      ? Check
      : call.status === "running"
        ? LoaderCircle
        : call.status === "failed"
          ? CircleAlert
          : CircleMinus;
  return (
    <details
      className={`tool-record ${call.status}`}
      onToggle={(e) => {
        if (e.target === e.currentTarget) setOpen(e.currentTarget.open);
      }}
    >
      <summary>
        <Icon size={15} className="tool-status-icon" aria-hidden="true" />
        <span className="tool-name">{toolLabel(call.name)}</span>
        <span className="tool-state">{statusLabel(call.status)}</span>
        {call.duration_ms != null && (
          <span className="evidence-meta tool-duration">
            {durationLabel(call.duration_ms)}
          </span>
        )}
        <ChevronRight size={14} className="tool-chevron" aria-hidden="true" />
      </summary>
      {open && (
        <ToolDetails taskId={taskId} call={call} openArtifact={openArtifact} />
      )}
    </details>
  );
}

export function SourceCard({ source, taskId, openArtifact }) {
  const url = safeURL(source.url);
  const [read, setRead] = useState(false);
  return (
    <article className="evidence-card source-card">
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer">
          {new URL(url).hostname}
          <ExternalLink size={14} />
        </a>
      ) : (
        <strong>Saved reference</strong>
      )}
      <p className="source-url">{source.url || source.name}</p>
      <p className="muted">
        Fetched {timestamp(source.fetched_at)}
        {source.pages.length > 0 && ` · Pages ${source.pages.join(", ")}`}
      </p>
      {source.truncated && (
        <p className="evidence-warning">
          Extract is truncated; consult the original for full context.
        </p>
      )}
      <details
        className="source-extract"
        onToggle={(e) => {
          if (e.target === e.currentTarget) setRead(e.currentTarget.open);
        }}
      >
        <summary>Read saved extract</summary>
        {read && <SourceExtract taskId={taskId} sourceId={source.id} />}
      </details>
      <button
        className="secondary"
        onClick={() => openArtifact(taskId, source.id)}
      >
        Open saved evidence · v{source.version}
      </button>
    </article>
  );
}

function SourceExtract({ taskId, sourceId }) {
  const { data, error, reload } = useResource(
    `/tasks/${taskId}/artifacts/${sourceId}/content`,
  );
  if (error) return <ErrorNotice error={error} retry={reload} />;
  if (!data) return <Loading>Loading saved extract…</Loading>;
  const text =
    data.text ||
    data.pages
      ?.map(
        (page) =>
          `Page ${page.page}\n${page.text || "No text extracted from this page."}`,
      )
      .join("\n\n");
  return (
    <div
      className="source-text"
      tabIndex={0}
      role="region"
      aria-label="Saved source text"
    >
      {text ||
        "No text extract was saved. Open the original evidence to inspect this reference."}
    </div>
  );
}

export function DecisionCard({ decision, taskId, openArtifact }) {
  return (
    <article className="evidence-card decision-card">
      <div className="evidence-heading">
        <h3>{decision.title}</h3>
        <span className="evidence-meta">
          {decision.basis.replaceAll("_", " ")} · v{decision.version}
        </span>
      </div>
      {decision.superseded && (
        <p className="evidence-warning">Superseded by a later decision</p>
      )}
      {decision.stale && (
        <p className="evidence-warning">
          Evidence belongs to an earlier CAD build. Recheck this decision.
        </p>
      )}
      <p>{decision.summary}</p>
      {decision.tradeoffs.length > 0 && (
        <>
          <h4>Tradeoffs</h4>
          <ul>
            {decision.tradeoffs.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </>
      )}
      {decision.uncertainties.length > 0 && (
        <>
          <h4>Uncertainties</h4>
          <ul>
            {decision.uncertainties.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </>
      )}
      <div className="button-row">
        {decision.evidence.map((e) => (
          <button
            key={e.id}
            className="secondary"
            onClick={() => openArtifact(taskId, e.id)}
          >
            {e.name} · v{e.version}
          </button>
        ))}
      </div>
      {!decision.evidence.length && (
        <small className="muted">No measured or external evidence cited.</small>
      )}
    </article>
  );
}

export default function EvidencePanel(props) {
  const audit = useResource(
    `/tasks/${props.task.id}/audit`,
    props.task.last_event_id,
    true,
  );
  return <EvidenceContent {...props} audit={audit} />;
}

function CompletionCheck({ check }) {
  return (
    <div
      className={`completion-check ${check.payload.passed ? "passed" : "failed"}`}
    >
      <strong>{check.payload.title}</strong>
      {check.payload.errors.length > 0 && (
        <ul>
          {check.payload.errors.map((error, i) => (
            <li key={i}>{error}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function EvidenceContent({
  task,
  openArtifact,
  audit,
  updates,
  onTrace,
}) {
  const [selection, setSelection] = useState("latest");
  const [history, setHistory] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [failedOnly, setFailedOnly] = useState(false);
  const { data, error, reload } = audit;
  const runId = selection === "latest" ? task.runs.at(-1)?.id : selection;
  useEffect(() => {
    setShowAll(false);
    setFailedOnly(false);
  }, [runId]);
  if (error) return <ErrorNotice error={error} retry={reload} />;
  if (!data) return <Loading>Loading work details…</Loading>;
  const tools = data.tools.filter((c) => runId === "all" || c.run_id === runId);
  const checks = data.checks.filter(
    (c) => runId === "all" || c.run_id === runId,
  );
  const failed = tools.filter((c) => c.status === "failed");
  const filtered = (failedOnly ? failed : tools).slice().reverse();
  const shown = showAll ? filtered : filtered.slice(0, 6);
  const decisions = data.decisions.filter((d) => history || !d.superseded);
  const latestCheck = checks.at(-1);
  return (
    <div className="evidence-panel">
      <section aria-label="Tool activity">
        <div className="evidence-heading">
          <div>
            <h2>Tool activity</h2>
            <p className="evidence-meta">
              {tools.length} calls · Most recent first
            </p>
          </div>
          <select
            aria-label="Execution run"
            value={selection}
            onChange={(e) => {
              setSelection(e.target.value);
              setShowAll(false);
              setFailedOnly(false);
            }}
          >
            <option value="latest">Latest run</option>
            <option value="all">All runs</option>
            {task.runs.map((run, i) => (
              <option key={run.id} value={run.id}>
                Run {i + 1} · {statusLabel(run.status)}
              </option>
            ))}
          </select>
        </div>
        {latestCheck && <CompletionCheck check={latestCheck} />}
        {checks.length > 1 && (
          <details className="check-history">
            <summary>Previous checks ({checks.length - 1})</summary>
            {checks.slice(0, -1).map((check, i) => (
              <div key={i}>
                <small className="evidence-meta">
                  Attempt {check.payload.attempt} ·{" "}
                  {timestamp(check.created_at)}
                </small>
                <CompletionCheck check={check} />
              </div>
            ))}
          </details>
        )}
        {failed.length > 0 && (
          <button
            className="tool-filter"
            aria-pressed={failedOnly}
            onClick={() => {
              setFailedOnly(!failedOnly);
              setShowAll(false);
            }}
          >
            <CircleAlert size={14} />
            {failed.length} failed{" "}
            {failed.length === 1 ? "attempt" : "attempts"}
            <span>{failedOnly ? "Show all calls" : "Show failures"}</span>
          </button>
        )}
        {shown.length ? (
          <div className="tool-list">
            {shown.map((call) => (
              <ToolRecord
                key={call.id}
                taskId={task.id}
                call={call}
                openArtifact={openArtifact}
              />
            ))}
          </div>
        ) : (
          <p className="muted">No tool calls in this run yet.</p>
        )}
        {filtered.length > 6 && (
          <button className="quiet-button" onClick={() => setShowAll(!showAll)}>
            {showAll
              ? "Show recent calls"
              : `Show all ${filtered.length} calls`}
          </button>
        )}
      </section>
      <details className="evidence-section">
        <summary>
          <span>Decisions</span>
          <span className="section-count">{decisions.length}</span>
          <ChevronRight size={16} />
        </summary>
        <div className="evidence-section-body">
          <div className="evidence-heading">
            <p className="muted">
              Design choices, evidence, and remaining uncertainties.
            </p>
            <label>
              <input
                type="checkbox"
                checked={history}
                onChange={(e) => setHistory(e.target.checked)}
              />{" "}
              Show history
            </label>
          </div>
          {decisions.length ? (
            decisions.map((decision) => (
              <DecisionCard
                key={decision.id}
                decision={decision}
                taskId={task.id}
                openArtifact={openArtifact}
              />
            ))
          ) : (
            <p className="muted">No decision summaries recorded yet.</p>
          )}
        </div>
      </details>
      <details className="evidence-section">
        <summary>
          <span>Sources</span>
          <span className="section-count">{data.sources.length}</span>
          <ChevronRight size={16} />
        </summary>
        <div className="evidence-section-body">
          <p className="muted">
            References from all runs. Open the exact saved extract.
          </p>
          {data.sources.length ? (
            <div className="source-grid">
              {data.sources.map((source) => (
                <SourceCard
                  key={source.id}
                  source={source}
                  taskId={task.id}
                  openArtifact={openArtifact}
                />
              ))}
            </div>
          ) : (
            <p className="muted">
              No external sources fetched for this project.
            </p>
          )}
        </div>
      </details>
      {updates && (
        <details className="evidence-section">
          <summary>
            <span>Progress updates</span>
            <ChevronRight size={16} />
          </summary>
          <div className="evidence-section-body">{updates}</div>
        </details>
      )}
      {onTrace && (
        <button className="quiet-button technical-trace" onClick={onTrace}>
          Open full technical trace
        </button>
      )}
    </div>
  );
}
