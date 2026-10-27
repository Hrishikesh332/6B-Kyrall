// Attribute each checklist step to the actions taken while it was the active step.

const LABELS = {
  load_workflow: "Loaded design guidance",
  set_specification: "Saved the specification",
  ask_questions: "Asked you questions",
  request_approval: "Asked you to approve the plan",
  build_cad: "Built CAD model",
  revise_cad: "Revised CAD model",
  build_cad_script: "Built CAD from script",
  revise_cad_script: "Revised CAD script",
  inspect_image: "Looked at rendered views",
  inspect_validation: "Checked validation results",
  evaluate_motion: "Checked motion and clearances",
  record_design_review: "Recorded design review",
  record_decision: "Recorded a decision",
  write_document: "Wrote a document",
  read_artifact: "Read a file",
  list_artifacts: "Listed files",
  package_artifacts: "Packaged deliverables",
  save_memory: "Saved a summary",
  search_context: "Searched earlier work",
  fetch_reference: "Read a reference",
  export_isaac_scene: "Exported simulation scene",
};
const HIDDEN = new Set(["update_plan", "activity"]);

export const actionLabel = (name) =>
  LABELS[name] ||
  name.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());

export function checklistSteps(plan = [], activity = []) {
  const windows = {};
  let previous = {},
    firstSeq = null;
  for (const event of activity) {
    if (event.type !== "plan.updated") continue;
    firstSeq ??= event.seq;
    const steps = event.payload.value || [];
    steps.forEach((step, index) => {
      const before = previous[step.id];
      // A pending step has not started in this plan, even if an earlier run reused its id.
      if (step.status === "pending") delete windows[step.id];
      if (step.status === "in_progress" && before !== "in_progress")
        windows[step.id] = { start: event.seq, end: null };
      if (step.status === "completed" && before !== "completed") {
        // A step completed without being started begins where the one before it ended.
        const prior = steps
          .slice(0, index)
          .map((s) => windows[s.id]?.end)
          .filter((x) => x != null)
          .at(-1);
        const window =
          windows[step.id] && before === "in_progress"
            ? windows[step.id]
            : { start: prior ?? event.seq, end: null };
        window.end = event.seq;
        windows[step.id] = window;
      }
    });
    previous = Object.fromEntries(steps.map((s) => [s.id, s.status]));
  }
  const tools = new Map();
  for (const event of activity) {
    if (!event.type.startsWith("tool.") || HIDDEN.has(event.payload.name))
      continue;
    const id = event.payload.id;
    const known = tools.get(id) || {
      id,
      name: event.payload.name,
      label: actionLabel(event.payload.name),
      seq: event.seq,
      status: "running",
    };
    if (event.type === "tool.completed") known.status = "completed";
    if (event.type === "tool.failed") {
      known.status = "failed";
      known.error = event.payload.result?.error;
    }
    if (event.payload.duration_ms != null)
      known.duration = event.payload.duration_ms;
    tools.set(id, known);
  }
  const notes = activity
    .filter((e) => e.type === "activity")
    .map((e) => ({
      id: `note-${e.seq}`,
      seq: e.seq,
      note: true,
      label: e.payload.title,
      detail: e.payload.detail,
      status: "note",
    }));
  const entries = [...tools.values(), ...notes].sort((a, b) => a.seq - b.seq);
  return plan.map((step) => {
    const window = windows[step.id];
    const actions = window
      ? entries.filter(
          (e) =>
            e.seq > window.start && (window.end == null || e.seq <= window.end),
        )
      : [];
    const duration = actions.reduce((sum, a) => sum + (a.duration || 0), 0);
    return {
      ...step,
      actions,
      duration,
      started: !!window || firstSeq == null,
    };
  });
}
