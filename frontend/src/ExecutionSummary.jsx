import { ChevronRight } from "lucide-react";
import { runSummary } from "./execution.js";

export default function ExecutionSummary({ task, audit, onOpen }) {
  const runId = task.runs.at(-1)?.id;
  const tools = audit.data?.tools.filter((call) => call.run_id === runId) || [];
  const summary = runSummary(task, tools);
  const sources = audit.data?.sources.length || 0;
  return (
    <button
      className="execution-summary"
      onClick={onOpen}
      aria-label="View work details"
    >
      <span className={`status-dot ${task.status}`} aria-hidden="true" />
      <span className="execution-summary-copy">
        <span className="execution-summary-title" role="status">
          {summary.title}
        </span>
        <span className="execution-summary-meta">
          {audit.error
            ? "Details could not be loaded"
            : !audit.data
              ? "Loading details…"
              : `${summary.total} tool ${summary.total === 1 ? "call" : "calls"}${sources ? ` · ${sources} ${sources === 1 ? "source" : "sources"}` : ""}${summary.failed ? ` · ${summary.failed} failed ${summary.failed === 1 ? "attempt" : "attempts"}` : ""}`}
        </span>
      </span>
      <span className="execution-summary-link">
        Details <ChevronRight size={15} />
      </span>
    </button>
  );
}
