import { toolLabel } from "./execution.js";

// Commentary events whose titles carry no meaning of their own.
const GENERIC_TITLES = new Set(["Model update"]);
// The checklist pill above the composer already shows plan updates.
const HIDDEN_TOOLS = new Set(["activity", "update_plan"]);

const firstSentence = (text = "") => {
  const line = text.trim().split("\n")[0];
  const match = line.match(/^.{12,}?[.!?](?=\s|$)/);
  const sentence = (match ? match[0] : line).replace(/[.!?]$/, "");
  return sentence.length > 90
    ? `${sentence.slice(0, 87).trimEnd()}…`
    : sentence;
};

const resultTarget = (result) => {
  if (!result || typeof result !== "object") return null;
  if (result.artifacts?.length)
    return `${result.artifacts.length} ${result.artifacts.length === 1 ? "file" : "files"}`;
  return result.name || result.artifact?.name || null;
};

const hostname = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url || null;
  }
};

/**
 * Interleaves saved messages with the work recorded between them. Each run of
 * events between two messages becomes a trace of phases; an `activity` summary
 * opens a phase, and the tool calls and checks that follow become its steps.
 */
export function buildTimeline(messages = [], activity = [], tools = []) {
  const audit = new Map(tools.map((call) => [call.id, call]));
  const byId = new Map(messages.map((m) => [m.id, m]));
  const placed = new Set();
  const items = [];
  let trace = null,
    phase = null,
    last = null;
  const calls = new Map();
  const flush = () => {
    if (trace?.phases.length) items.push(trace);
    trace = phase = null;
  };
  const openPhase = (event, fields) => {
    trace ||= {
      type: "trace",
      key: `trace-${event.seq}`,
      phases: [],
      start: event.created_at,
    };
    phase = {
      key: `phase-${event.seq}`,
      steps: [],
      start: event.created_at,
      end: event.created_at,
      ...fields,
    };
    trace.phases.push(phase);
  };
  const addStep = (event, step) => {
    if (!phase) openPhase(event, { title: null });
    phase.steps.push(Object.assign(step, { key: `step-${event.seq}` }));
    phase.end = event.created_at;
  };

  for (const event of activity) {
    const { type, payload = {} } = event;
    if (type === "message.created") {
      const message = byId.get(payload.id);
      if (message && !placed.has(message.id)) {
        flush();
        placed.add(message.id);
        items.push({ type: "message", key: message.id, message });
      }
    } else if (type === "activity") {
      const generic = !payload.title || GENERIC_TITLES.has(payload.title);
      const title = generic ? firstSentence(payload.detail) : payload.title;
      const detail =
        payload.detail && payload.detail.trim() !== title
          ? payload.detail.trim()
          : null;
      const pause = last == null ? null : Math.max(0, event.created_at - last);
      openPhase(event, {
        title,
        detail,
        thinkingMs: pause == null ? null : Math.round(pause * 1000),
      });
    } else if (type === "tool.started" && !HIDDEN_TOOLS.has(payload.name)) {
      const step = {
        kind: "tool",
        id: payload.id,
        name: payload.name,
        label: toolLabel(payload.name),
        status: "running",
      };
      calls.set(payload.id, step);
      addStep(event, step);
    } else if (type === "tool.completed" || type === "tool.failed") {
      const step = calls.get(payload.id);
      if (step) {
        step.status = type === "tool.failed" ? "failed" : "completed";
        step.target = resultTarget(payload.result);
        step.error = payload.result?.error || null;
        if (phase) phase.end = event.created_at;
      }
    } else if (type === "validation.completed") {
      addStep(event, {
        kind: "check",
        status: payload.passed ? "completed" : "failed",
        label: payload.passed
          ? "Geometry checks passed"
          : "Geometry needs revision",
      });
    } else if (type === "completion.checked" && payload.errors?.length) {
      addStep(event, {
        kind: "check",
        status: "failed",
        label: "Completion checks need repair",
        error: payload.errors.join("; "),
      });
    } else if (type === "source.fetched") {
      addStep(event, {
        kind: "source",
        status: "completed",
        label: "Saved reference",
        target: hostname(payload.url),
      });
    } else if (type === "decision.recorded") {
      addStep(event, {
        kind: "decision",
        status: "completed",
        label: "Recorded decision",
        target: payload.key?.replaceAll("_", " ") || null,
      });
    }
    last = event.created_at ?? last;
  }
  flush();

  // The audit record is authoritative for final status (cancelled, interrupted).
  for (const step of calls.values()) {
    const record = audit.get(step.id);
    if (record) {
      step.status = record.status;
      step.durationMs = record.duration_ms;
    }
  }
  for (const item of items)
    if (item.type === "trace")
      for (const p of item.phases) {
        p.title ||= p.steps[0]?.label || "Working";
        p.running = p.steps.some((s) => s.status === "running");
      }

  // Messages without a recorded event (older data) keep their saved order.
  for (const message of messages) {
    if (placed.has(message.id)) continue;
    const at = items.findIndex(
      (item) => (item.message?.created_at ?? item.start) > message.created_at,
    );
    items.splice(at < 0 ? items.length : at, 0, {
      type: "message",
      key: message.id,
      message,
    });
  }
  return items;
}

export const elapsedLabel = (ms) => {
  if (ms == null || ms < 1000) return null;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
