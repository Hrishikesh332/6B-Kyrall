Acceptance is evidence-based. Before finishing an artifact task:
- Confirm the requested files exist in list_artifacts, with correct names and versions.
- For CAD, inspect the latest generated validation report. Repair failing numeric gates.
- Check assumptions against the latest user message, especially on revisions.
- Keep the latest passing versions together; avoid packaging stale or failed variants.
- State which checks were measured and which are untested. A valid mesh does not
  establish physical fit, force, durability, kinematic feasibility, or safe operation.
- Provide a brief before/after summary when dimensions or component counts changed.
- Do not claim visual inspection merely because a preview exists. Use inspect_image
  on the current build and describe visible findings. The model receives actual pixels.
- For moving mechanisms, run evaluate_motion and record_design_review on the current
  source. A sampled rigid-body collision check is not a force or contact simulation.
  Requirement evidence, six cycle phases, hardware and bench acceptance criteria must
  accompany the files. Keep unresolved physical requirements explicit.
- Preserve stable mounting dimensions during a revision unless the user requests a
  change or the new geometry makes preservation impossible; then flag the tradeoff.
- Record a concise final decision summary citing the current validation report.
  Old measurements become stale after rebuilding: inspect and cite the new report.
  Include current decision summaries, their cited evidence and assembly notes in
  the package. The delivery gate checks this in both live provider modes.
