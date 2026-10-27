export const toolLabel = (name = "") =>
  ({
    activity: "Share progress",
    load_workflow: "Load workflow",
    set_specification: "Save design brief",
    update_plan: "Update checklist",
    ask_questions: "Ask for design choices",
    build_cad: "Build CAD model",
    revise_cad: "Revise CAD model",
    build_cad_script: "Build CAD from script",
    revise_cad_script: "Revise CAD script",
    request_approval: "Ask for plan approval",
    inspect_validation: "Check geometry",
    inspect_image: "Inspect image",
    evaluate_motion: "Check motion",
    record_design_review: "Record design review",
    record_decision: "Save decision",
    write_document: "Write document",
    read_artifact: "Read file",
    list_artifacts: "List saved files",
    package_artifacts: "Package deliverables",
    fetch_reference: "Read source",
    search_context: "Find saved context",
    save_memory: "Save task summary",
    export_isaac_scene: "Export simulation scene",
  })[name] || name.replaceAll("_", " ");

export const durationLabel = (ms) => {
  if (ms == null) return null;
  if (ms < 100) return "<0.1 s";
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
};

export function runSummary(task, tools = []) {
  const running = tools.findLast((call) => call.status === "running");
  const titles = {
    completed: "Work completed",
    failed: "Work needs attention",
    interrupted: "Work interrupted",
    cancelled: "Work stopped",
    awaiting_input: "Waiting for your choices",
    queued: "Waiting to start",
  };
  return {
    title:
      titles[task.status] ||
      (running ? toolLabel(running.name) : "Working on your task"),
    failed: tools.filter((call) => call.status === "failed").length,
    total: tools.length,
  };
}
