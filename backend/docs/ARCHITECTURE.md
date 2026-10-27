# Backend architecture

## Components

The API owns input validation and durable state. A background worker claims queued
runs from SQLite, the engine selects workshop or model-driven execution, and the
tool registry performs bounded operations. File generation is separated from artifact
publication. The browser consumes the same records and events as API clients.

HTTP is served by Flask and Waitress. Pydantic validates endpoint inputs and generates
the OpenAPI schemas. One background asyncio loop runs in a dedicated thread; it is
not created and destroyed with Flask requests. Worker leases still coordinate claims
through SQLite. SSE is a bounded WSGI generator, with durable cursors across reconnects.

Claude Code mode runs the typed engineering tools through the Claude Agent SDK, served
by an in-process MCP server. Each resume starts a fresh Claude Code session built from
scoped application data; the application does not depend on an in-memory model
process surviving a question. The direct Responses
API path below remains an optional provider implementation.

| Component | Input | Output | Failure boundary |
|---|---|---|---|
| API | Typed HTTP requests | Task/project/file records and streams | Validation, access/origin errors |
| Store | Transactions | Durable entity states and ordered events | Rollback and explicit conflicts |
| Worker | Claimed run | Terminal state or pending questions | Lease expiration and explicit retry |
| Model adapter | Instructions, tool schemas, input items | Function calls, public text, usage | Provider errors and turn/token budgets |
| Tool runner | Validated call arguments | Persisted result and events | Per-call errors returned for repair |
| CAD process | Finite JSON feature graph | Solids, meshes, views, report | Time/CPU/file-size limits; no arbitrary code |
| Artifact store | Bytes and metadata | Immutable version and SHA-256 | Task ownership and path confinement |
| Browser | REST snapshots and event IDs | Task, question, file, and preview views | Reconnect with last event cursor |

## State machine

| Current state | Trigger | Next state |
|---|---|---|
| none | Create task or add a new turn | queued |
| queued | Worker atomically claims run | running |
| running | Valid clarification request | awaiting_input |
| awaiting_input | Valid answer to that task's pending interaction | queued, same run |
| running | Model/workshop finishes with satisfied checks | completed |
| running | Unrecoverable error or exhausted budget | failed |
| queued / awaiting_input | Stop requested | cancelled |
| running | Stop requested | cancelled at the next boundary; CAD process killed |
| running | Worker lease expires | interrupted |
| failed / cancelled / interrupted | Explicit retry | new queued run |
| running / queued | Follow-up message | message queued for the next turn |
| completed with queued messages | Worker finalization | new queued run for those messages |

One task may have many historical runs but only one queued/running/awaiting-input run.
A partial unique index enforces this. The active slot remains occupied while waiting
for answers. Task metadata, output artifacts, and messages survive a failed run.

An unclean process failure is not silently replayed: repeating an external operation
or a model call could have side effects or cost. The next worker detects an expired
lease and marks the run interrupted. Retry starts a new run with the task's persisted
conversation/specification. Graceful cancellation is checked between model waits and
tool calls, and every 250 ms while a CAD child process is running.

## Entities and invariants

| Entity | Important fields / invariant |
|---|---|
| projects | Name, shared brief, memory export scope |
| project_files | Durable references belonging to a project |
| tasks | Title, project, context scope, current status, plan, specification, archive flag |
| messages | Role, kind, content, optional run; queued messages acquire the next run ID |
| runs | Status, checkpoint, usage, cancellation flag, lease, timestamps, error |
| events | Increasing sequence ID, task/run, type, JSON payload, timestamp |
| questionnaires | Structured questions, one submitted answer set, task/run linkage |
| artifacts | Task, logical name, immutable version, physical path, bytes, hash, metadata |
| tool_calls | Run-scoped call identity, input, result, state, timing |
| memories | Concise summary attributed to the producing task |
| schedules | Prompt, interval, enabled flag, next fire, last task |
| idempotency | Scope + client key + request hash + original result identity |

Transactions use `BEGIN IMMEDIATE`; SQLite operates in WAL mode. Mutations and their
events are committed together where they share one logical operation. Worker claims
are serialized. Reusing a client idempotency key with a different payload is rejected.
Successful or failed recorded tool calls can be replayed by ID without running again.

Artifact files live under generated task/version IDs. Logical filenames never select
arbitrary filesystem paths. Downloads verify task membership and resolve inside the
artifact root. ZIPs contain one selected version per name and a checksum manifest.
Generated preview data carries the same build ID as its associated STEP/STL files,
so old artifact versions display the matching geometry rather than a newer preview.

## Event contract

`GET /api/tasks/{id}/events` returns server-sent events. The event `id` is the persisted
sequence number. `Last-Event-ID` or `?after=` resumes after a client cursor. Events
are ordered, and at-least-once transport means consumers should deduplicate by ID.
The browser uses notifications to refresh durable state; it does not make itself the
authority for run completion. Heartbeats keep idle connections alive.

Important event families:

- `run.queued`, `run.started`, `run.awaiting_input`, `run.completed`, `run.failed`,
  `run.stopping`, `run.cancelled`, `run.interrupted`.
- `message.created`, `message.queued`.
- `clarification.requested`, `clarification.answered`.
- `plan.updated`, `spec.updated`, `activity`, `workflow.loaded`.
- `tool.started`, `tool.completed`, `tool.failed`, `tool.cancelled`.
- `artifact.created`, `validation.completed`, `validation.inspected`, `usage.updated`.

The stream carries real execution events. Model text currently arrives at response
boundaries; token-by-token model streaming is not implemented.

## Model/tool loop

1. Read the current specification, conversation, artifact manifest, and project context.
2. Compose the authored orchestrator and communication prompts. Domain workflows are
   loaded explicitly through a typed tool; their hashes appear in the activity log.
3. Call the Responses API with model, effort, tool schemas, and bounded output tokens.
4. Execute returned function calls sequentially. Input schemas reject unknown fields,
   malformed geometry, invalid filenames, and unsupported operations.
5. Store results and send `function_call_output` items linked by `call_id`.
6. Persist the provider response ID, pending outputs, turn count, and token usage.
7. When a question is emitted, checkpoint and pause. Resume with the saved tool output
   and submitted answers instead of regenerating the original question.
8. Return tool errors to the model for repair. Unresolved tool errors or a failed latest
   CAD validation prevent a successful terminal state.

Turn and token budgets are checked between requests. A single response can cross the
soft total-token threshold; this is not a provider-side hard spending cap. The backend
does not calculate currency costs or substitute model names. The direct Responses adapter was mock-tested.

## CAD and validation

The finite feature graph is an original implementation choice. It trades unrestricted
CAD scripting for a small, testable compiler. Nodes refer only to prior nodes, so the
graph is acyclic. Dimensions and coordinates are bounded finite numbers. There are
at most 120 nodes and 12 output parts. Primitives are centered at the origin except
polygon extrusions; transforms rotate X/Y/Z and then translate.

A separate trusted Python process imports CadQuery. It receives JSON data and a unique
output directory, not executable model code or shell strings. The subprocess environment
does not include provider secrets. Time, CPU, and per-file output limits bound work.
This is not a security sandbox for arbitrary Python: no such execution feature exists.

For each part, the compiler checks B-rep validity, connected-solid count, STL closure,
winding, positive volume, and build-volume fit after print orientation. Across the
assembly it checks solid intersections. It exports and reimports STEP to verify that
the interchange file is readable and valid. It produces isometric/front/top/side SVG
projections and a triangulated assembly for the browser.

The static checker does not prove wall thickness, overhang suitability, physical
clearance under manufacturing variation, stiffness or load capacity. Claude Code can now
inspect actual rendered CAD/PDF pixels, and completion requires the current preview.
These observations do not establish physical operation.

`revise_cad` replaces selected nodes/parts, preserves untouched geometry, sorts the
dependency graph and rejects missing/cyclic references. Full audit results stay in
SQLite; the compact model-facing response removes redundant metadata and JSON escaping.

`evaluate_motion` uses a bounded subprocess and the finite compiler. It samples
declared world-space rigid transforms, tests exact B-rep intersections and minimum
surface gaps, and identifies relative motion using transformation matrices. It does
not solve joints, forces, contact, compliance, robot IK or continuous collision
freedom. Named studies preserve pickup/release evidence separately; repairs replace
only their named report.

`record_design_review` links requirements to evidence, compares alternatives, records
six operating phases and lists hardware and bench tests. Only generated validation,
motion and fetched-source artifacts support a `measured` label; prose alone cannot.
This checks provenance, not the truth of every semantic interpretation. The closing
gate detects explicit closing phrases in user messages and requires declared retaining
parts to move relative to their base in a passing study. This phrase detector is a
bounded heuristic, not a general natural-language verifier.

Completion binds static, visual, motion and review evidence to the latest build.
ZIP selection rejects failed/stale CAD; completion checks that current solids,
source and evidence are included. The UI separates prototype evidence from physical
operation. PDF retrieval uses allowlisted hosts, bounded downloads and a separate
extraction/rendering process; URL, timestamp, SHA-256 and pages accompany evidence.

## Context and memory

There are two separate concepts: task history and cross-task retrieval. History stays
within the conversation. Retrieval uses concise saved summaries:

- Isolated scope returns only the current task's summaries.
- Project scope retrieves summaries in the same project.
- Workspace scope can retrieve ungrouped summaries and summaries whose project permits
  workspace reuse; private project memories do not leak through this route.

Project briefs and bounded text-reference excerpts are available to project tasks.
Binary project attachments are stored but not automatically interpreted. Retrieval
currently uses lexical ranking over recent summaries; it is not an embedding service.
Original instructions, structured specifications, and artifact IDs remain durable
even when older conversational text is bounded for the model context window.

## HTTP surfaces

The generated OpenAPI schema is authoritative. Principal routes are:

| Route | Purpose |
|---|---|
| `POST /api/tasks` | Create and asynchronously queue a task; supports Idempotency-Key |
| `GET /api/tasks` | Search/filter/paginate task metadata |
| `GET/PATCH /api/tasks/{id}` | Read detail; rename/archive |
| `POST /api/tasks/{id}/messages` | Start or queue a follow-up turn |
| `POST /api/tasks/{id}/questions/{qid}/answer` | Submit choices/free text and resume |
| `POST /api/tasks/{id}/cancel` | Idempotent stop request |
| `POST /api/tasks/{id}/retry` | Explicit retry after failure, stop, or interruption |
| `GET /api/tasks/{id}/events` | Live event stream and replay |
| `GET /api/tasks/{id}/activity` | Bounded event history |
| `GET /api/tasks/{id}/trace` | Recorded tool inputs/results/timing |
| `POST /api/tasks/{id}/uploads` | Store a task attachment |
| `GET /api/tasks/{id}/artifacts/{aid}/content` | Download exact version |
| `GET /api/files` | Search files across local tasks |
| `GET/POST /api/projects` | Project list/create |
| `GET/PATCH /api/projects/{id}` | Shared brief and memory configuration |
| `POST /api/projects/{id}/files` | Durable project reference upload |
| `GET/DELETE /api/memories[/{id}]` | Review and forget summaries |
| `GET/POST/PATCH /api/schedules[/{id}]` | Interval jobs, disabled by UI default |
| `GET /api/capabilities` | Truthful local tool and integration availability |

## Extension path

Before multi-user deployment, replace the local trust model with tenant-scoped
authorization on every entity, transactional ownership checks, short-lived artifact
links, persistent object storage, workspace quotas, and a queue with worker isolation.
Keep provider keys in a vault. Enforce reference egress through a DNS-pinning proxy;
the local reader's allowlist and public-address check are not a production network
sandbox. Add schema migrations and backups as first-class operations.

For external CAD applications, add adapters behind typed tools with explicit capability
discovery, document/session IDs, permission scopes, idempotency, and compensating
actions. Do not expose a connector as available until a real session can be inspected.
For general code execution, use a separately isolated service with network policy,
resource quotas, ephemeral filesystem, and audited artifact export; do not relax the
finite CAD compiler into host-level `exec`.

Rich document exports, semantic retrieval, CAD-native features,
advanced manufacturing checks, organization sharing, OAuth, and webhooks are independent
extension areas. The parity matrix records that they are not implemented here.

## Evidence and provider-independent completion

`app/audit.py` builds a compact audit from existing records. Decision artifacts use a
stable logical key and immutable versions; evidence references carry their original
artifact ID/version/hash. CAD build IDs allow the viewer to flag obsolete measured
summaries after a revision. Fetched reference metadata contains URL, document digest,
fetch time, page selection and truncation. Older metadata is enriched from the saved
fetch tool result. Sources remain untrusted data.

`app/completion.py` is shared by both live providers. The model's candidate final
text is withheld until delivery checks pass. Each attempt emits `completion.checked`;
failed attempts request bounded repairs while retaining the original tool error
history. Live tool payloads can be fetched individually, while the audit endpoint
returns only compact metadata. `record_decision` validates evidence type and task/
build identity; semantic interpretation remains the model's responsibility.

Claude Code tool IDs are namespaced by ephemeral session before run-scoped replay checks.
Identical replays return the saved result; reuse with a changed tool or arguments is
rejected. The ID claim and task/run ownership check share a SQLite transaction.
Both providers route arguments through the same finite-JSON decoder and capability
check. Invalid calls return structured errors, field paths and repair hints; their
bounded audit input includes a digest when decoding fails. Disabled/unregistered
tools cannot execute and consume the provider call budget. Their rejection alone
does not leave an impossible completion repair requirement: the model can select
an available tool, while required-deliverable gates still apply.

A shared watchdog checks pending asynchronous tools every 250 ms and cancels them
on a user stop, configured tool timeout, or earlier Claude Code run deadline. Child
cleanup finishes before the terminal tool event. Synchronous in-process code is
not preemptible. A timeout records a failed call and warns of partial output; no
mutation is automatically retried.

Worker cancellation and lease expiry close running tool rows with an
explicit incomplete status. This avoids both silent side-effect replay and stale
"running" entries in the trace.
