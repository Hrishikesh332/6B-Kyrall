# Behavioral research and reconstruction

Inspection date: **26 October 2026**, Europe/Berlin. The reference product's identity
is intentionally omitted from the local deliverables. No original brand assets,
private account identifiers, authentication material, or proprietary source bundles
are included.

## Scope and confidence

This investigation used the signed-in interface, the existing design conversation,
one fresh design task, one follow-up revision, and publicly accessible product guides.
It did not access private server files, intercept credentials, bypass access controls,
or recover a hidden system prompt. Browser-visible “thought” panels are displayed
summaries; they do not establish the underlying model's private reasoning process.

Evidence labels used below:

- **Observed:** directly visible in the interface during this session.
- **Documented:** stated in a public product guide; not independently exercised here.
- **Inferred:** a plausible implementation explaining the observed behavior.
- **Implemented:** an independently designed equivalent in this repository.
- **Unknown:** unavailable through the inspected surface.

The implementation reproduces observable contracts. Its backend language, database,
queue design, prompt wording, and CAD representation are engineering choices, not
claims about the reference implementation's internal source code.

## Probe A: existing mechanical design conversation

The existing task requested a passive tomato gripper on a robotic arm, with printable
files and no electrical actuation. Its clarification form resolved three high-impact
choices: how contact triggers grip/release, which arm interface to use, and the object
size range. The response then proceeded through recognizable phases:

1. Load domain and research guidance; look for earlier related work.
2. Verify a manufacturer interface against official references.
3. Generate a parametric design and component meshes.
4. Check watertightness, dimensions, part clearances, and attachment relationships.
5. Produce isometric, orthographic, section, and wireframe views.
6. Revise component placement and remove stale/nonprintable combined output.
7. Repeat validation, document limitations, and deliver versioned files.

The final conversation distinguished geometry checks from mechanism validation. It
identified omitted springs and passive fixtures and said the cam/pawl mechanism was
not physically or kinematically verified. That distinction is central to the recreated
review workflow: useful geometry must not be presented as a proven physical system.

A second task using a similar request immediately showed a phase about recovering
the prior design. The user stopped that probe and asked for a different specification.
This is direct evidence that a new conversation can still retrieve earlier work;
it is not evidence of any particular vector database or embedding model.

## Probe B: a genuinely different specification

The fresh task asked for a wall-mounted organizer for six dry-erase markers, each
18 mm in diameter and 140 mm long, printable on a 220 × 220 mm FDM machine. It asked
for appropriate STL parts, editable STEP, and assembly notes, and explicitly stated
that it was a standalone project.

### Clarification behavior

The system asked three questions together:

| Design dimension | Options observed | Answer submitted |
|---|---|---|
| Wall attachment | screws, adhesive, or either | Two screws |
| Marker orientation | caps up, caps down, or no preference | Caps up |
| Print material | PLA, PETG, or no preference | PETG |

Each question exposed an additional-details control. The form also had a general
free-text field. Before selection the action was “Skip”; after choices it became
“Continue.” Once submitted, the interactive form became a compact read-only summary
within the conversation. The run resumed without creating a separate conversation.

**Decision implication:** the clarification step resolves high-impact design choices
in one batch, supplies a low-friction default route, persists the answers, and avoids
asking again when those choices are known. The number of questions appears deliberately
small; this observation alone does not establish a hard internal limit.

### Execution behavior

The visible phase groups showed domain guidance loading, installed-exporter checks,
construction-API checks, CAD review requirements, FDM screening, source generation,
regeneration after an empty-intersection handling issue, and a display-color revision.
The to-do panel tracked four steps and changed its current-step summary as the work
progressed. File cards appeared before the final natural-language answer.

Several implementation details are observable at the interface boundary:

- Tool progress and natural-language messages are distinct renderable parts.
- Multiple lower-level actions are grouped into one collapsible phase.
- Failed operations can be corrected without abandoning the conversation.
- A generated document can open automatically in an adjacent preview.
- Artifact publication and the final answer are separate events.
- File versions advance during execution, before a user requests another turn.

### Result and design judgment

The task chose a monolithic design rather than unnecessary separate parts. It described
rigid open-front channels with upward removal, explained why the design did not use
fatiguing snap arms, and stated the required extraction direction.

The visible deliverable reported an envelope of **166 × 38 × 105 mm**, six channels
with **19.6 mm** bores, **25 mm** center pitch, **0.8 mm** radial clearance around the
specified barrels, and **140 mm** wall-fastener spacing. It reported a single connected
watertight STL with **9,600 triangles**, virtual marker-envelope fit checks, and generic
overhang/wall-thickness screening. These are **reported results from the inspected
conversation**, not checks independently rerun against its downloaded files.

The delivered STEP was described as editable solid geometry and the Python file as
the parametric source. The interface showed a source-file history of four versions.
However, the source preview reported that the file was unavailable. Therefore, the
source implementation, CAD library, and exact source code were **not verified**.

The recreated system intentionally stores immutable files itself, validates download
bytes, and includes checksums in delivery packages. A visible file card alone is not
treated as proof of file availability.

## Probe C: revision under a new constraint

The follow-up requested eight markers while preserving the barrel size, orientation,
PETG, and two-screw mounting, with an overall width below 210 mm. It requested updates
to the existing files and a summary of dimensional changes.

The revised notes reported:

The observed revision screen showed the updated document
and its version controls.

| Property | Original | Revision |
|---|---:|---:|
| Marker capacity | 6 | 8 |
| Width | 166 mm | 206 mm |
| Depth | 38 mm | 38 mm |
| Height | 105 mm | 105 mm |
| Center pitch | 25 mm | 25 mm |
| Wall-fastener spacing | 140 mm | 140 mm |
| Bore / radial clearance | 19.6 / 0.8 mm | unchanged |

The revision also reduced the recommended brim because the new width left less room
on the printer bed. This is evidence of a useful dependency rule: a dimensional change
can require manufacturing-note changes even when the material and orientation stay
the same. The updated notes exposed version navigation and retained the original
logical document identity.

The local workshop follows the same interaction pattern but uses an original, simpler
geometry recipe. Its dimensions are intentionally different. It supports explicit
count/diameter/clearance revisions and rejects a violated width limit rather than
pretending the constraint was satisfied. General redesign belongs to live mode.

## Frontend inventory

| Surface | Observed behavior | Local counterpart |
|---|---|---|
| New task | Centered composer, model/effort control, context selector, attachment entry | Centered composer, truthful execution-mode display, explicit memory/project scope |
| Navigation | Tasks, Projects, Files, Integrations, Scheduled, task history | Same main work surfaces plus local memory inspection |
| Task header | Rename/title, task actions, new conversation | Rename, archive, trace, stop, retry |
| Conversation | User messages, summaries, questions, tool phases, final answer | Separate persisted message kinds, clarification forms, activity phases |
| To-do | Collapsed current-step summary, completion count, expandable checklist | Stable step IDs and persisted statuses |
| Artifacts | Format, size, preview thumbnail, downloads, version navigation | Real metadata, versions, checksum, preview, file-backed download |
| Document preview | Markdown, tables, zoom, export menu | Safe text preview and original download; rich table/format conversion is a gap |
| CAD preview | File card and adjacent viewing surface | Interactive mesh orbit/zoom and four geometric projections |
| Mobile layout | Collapsible sidebar and modal-style preview | Responsive sidebar and overlay preview |
| Model selector | Presets, reasoning effort, advanced settings, fast toggle | Operator-configured model; no invented availability or pricing |
| Progress disclosure | Collapsed thought summaries and named execution stages | Concise action summaries and auditable tool results; no fabricated private thoughts |

The recreated visual vocabulary uses a near-black canvas, slightly darker sidebar,
subtle borders, small muted labels, spacious conversation columns, rounded composer,
and violet accents. It does not reuse reference logos, icons, fonts, or image assets.

## Publicly documented contracts

The inspected project guide describes shared briefs/files and project-only versus
workspace memory. The task guide documents asynchronous runs, questions, messages
submitted while a task runs, and per-task sharing. The file guide describes cross-task
search, previews, original downloads, and format-specific exports. The public tools
guide describes task creation, messages, interactions, cancellation, file retrieval,
scopes, and idempotency keys. Those guides support the overall entity boundaries,
but they do not reveal the private queue, database, prompt source, or model runtime.

Public documentation was consulted under its page topics: “Core concepts,” “Projects,”
“Tasks,” “Files,” “Tools and workflows,” and “API overview.” Source identity and URL
strings are omitted here to honor the requested naming constraint. UI evidence from
the three probes above is the main basis for the reconstruction.

## Reconstructed decision policy

The following is **our implementation policy**, inferred from the observations:

1. Identify the intended artifact and measurable acceptance criteria.
2. Separate fixed user constraints, external interface facts, and adjustable assumptions.
3. Retrieve prior context only within the chosen scope. An explicit standalone request
   should prevent unrelated designs from determining the specification.
4. Ask a compact batch of questions when unresolved choices change the design.
5. Persist a structured specification before expensive work.
6. Load the relevant workflow and choose tools based on artifact type and available
   capabilities, not on a promise to support every external application.
7. Build an editable source of truth, then derive presentation and manufacturing files.
8. Inspect numeric outputs; repair specific failures with bounded attempts.
9. Review dependent requirements after a revision, including print-envelope margins.
10. Publish existing valid files and preserve their provenance and versions.
11. Report result, measured checks, and remaining physical limits separately.
12. Save a short scoped summary for the next related task.

These steps are encoded in editable prompts and enforced where possible by backend
state and validation gates. Prompt instructions alone are not the enforcement boundary.

## What remains unknown

- Exact hidden instructions, model-internal reasoning, and prompt assembly order.
- The original server framework, database, queue, deployment, or tenancy architecture.
- Whether retrieval uses embeddings, keyword search, hand-maintained memories, or a mix.
- The original sandbox, execution images, CAD packages, tool schemas, and renderer.
- The original numeric tolerances, validation implementations, and repair limits.
- Proprietary connector protocols, pricing calculations, and model-routing logic.
- Whether every publicly documented feature behaves as described in the user's plan.

The code and parity matrix explicitly distinguish these unknowns from working local
capabilities. This is a tested behavioral reconstruction, not an exact backend clone.
