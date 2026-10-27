# 6B backend

A working local engineering workspace with Python Flask endpoints, reconstructed from observable product behavior.
The source uses neutral branding throughout. Its prompts are independently authored;
they are not extracted private prompts or recovered server code.

## Start

From the repository root:

```sh
./start.sh
```

Open **http://127.0.0.1:8765**. API documentation is at **/docs**. The existing virtual
environment has been installed and tested on this machine. For a fresh checkout:

```sh
./install.sh
./start.sh
```

Python 3.11+ is required; the tested interpreter is Python 3.12. Dependencies include
the OpenCascade CAD kernel, so installation is substantially larger than a plain web app.

## What works now

- Persistent tasks, messages, plans, specifications, tool traces, and run states.
- Background runs, durable event replay over SSE, cancellation, explicit retry,
  worker leases, and follow-ups queued while a turn runs.
- One-to-three-question forms with free-text answers, explicit defaults, and resume.
- Project briefs and reference files, scoped memory retrieval, search, and archive.
- Rules (`/api/rules`): short instructions for all projects or one project. Enabled rules
  are sent to Claude Code and the direct API as binding requirements on every run.
- Real parametric CAD: boxes, cylinders, spheres, polygon extrusions, Boolean
  operations, fillets, chamfers, transforms, and assemblies of up to 12 parts.
- STEP assembly, per-part STL, construction JSON, four SVG projections, interactive
  mesh previews, numeric validation, assembly notes, and ZIP manifests.
- Immutable artifact versions, SHA-256 integrity metadata, uploads, and downloads.
- A configurable Responses API tool loop, bounded attempts and token accounting,
  editable domain workflows, and a public-reference reader with explicit domain scope.
- Interval schedules stored locally; new schedules start paused in the interface.
- Targeted CAD revisions, Claude Code inspection of actual CAD/PDF pixels, and allowlisted
  PDF extraction with source hashes and page numbers.
- Named motion studies: sampled exact-solid intersections, measured surface gaps,
  relative part motion, requirement evidence, operating-cycle review, and bench tests.

The React browser interface lives in `../frontend/`. Vite builds it into
`../frontend/dist/`, which this backend serves. `./install.sh` installs and builds
the frontend, and `./start.sh` rebuilds it before launch. No CDN is required at runtime.

## Execution modes

### Connecting a model after deployment

Each computer that runs 6B connects its own account; nothing is shared from the
machine where 6B was built.

1. Run `./install.sh` (it creates `backend/.env` from `.env.example` if needed).
2. Sign in once on that computer with **Claude Code** (Claude Pro, Max, Team or
   Enterprise account): `claude auth login`. The Claude Code CLI is bundled with the
   Python packages, so a separate install is optional; `./install.sh` prints the full
   command when `claude` is not on PATH. Instead of signing in you can paste an
   Anthropic Console API key in the app, or set `ANTHROPIC_API_KEY` in `backend/.env`.
3. Start 6B, open **Integrations → Model provider** (or **Workspace settings →
   Change model connection**), select Claude Code, press **Check connection**
   and then **Use …**.

The app refuses the switch until the sign-in check passes, and waits for any running
task to finish first. The choice is saved in `backend/data/integrations/model.json` (owner-only
file permissions) and takes over from `6B_PROVIDER` on later starts. Without a saved
choice the `.env` provider is used exactly as before. Saved API keys are never returned
to the browser.

API: `GET /api/integrations/model` lists providers and the active one,
`POST /api/integrations/model/check` runs a read-only sign-in check (no tokens spent),
`PUT /api/integrations/model` switches, and `DELETE /api/integrations/model/anthropic-key`
removes a saved Anthropic key.

**Claude Code mode** (`6B_PROVIDER=claude`) runs the same typed engineering tools
through the [Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/overview). The
tools are served to Claude Code by an in-process MCP server; every built-in Claude Code
tool (shell, files, web) is removed, and user settings, hooks, plugins, skills and
other MCP servers are not loaded, so actions flow only through 6B's tools.
Questions, approvals, completion checks, image review, token budgets and
cancellation are supported. `6B_CLAUDE_MODEL` (or the app's model picker) accepts
`opus`, `sonnet`, `haiku` or a full model ID; empty uses the account default. Backend
secrets (OpenAI and Onshape keys, the local API token) are blanked in the Claude Code
process environment. Task context and tool results are sent to Anthropic and use the
signed-in account's plan limits, or Console billing with an API key. The adapter is
covered by scripted protocol tests and a live check that the CLI starts with only the
6B tools; a full CAD run with a signed-in Claude account has not yet been recorded.

**Workshop mode** (`6B_PROVIDER=workshop`) needs no model account. It is an explicit deterministic
demonstration, not general AI. The marker organizer supports counts of 1–8, barrel
diameters of 5–30 mm, diametral clearances of 0.4–3 mm, wall-mount choices, and revisions.
The mounting-plate example defaults to an 80 × 50 × 5 mm plate with four 4.5 mm holes;
explicit `width × depth × thickness mm` and `diameter mm holes` values are supported. Unsupported
requests return a clear limitation instead of fabricated artifacts.

**Direct API mode** is an alternative for operators who want to use an API key:

1. Copy `.env.example` to `.env`.
2. Set `6B_PROVIDER=openai`, `OPENAI_API_KEY`, and `6B_MODEL` to a Responses
   API model available to your account. Set a supported `6B_REASONING_EFFORT` or
   leave it empty for models without that parameter.
3. Restart the server.

The direct Responses adapter was verified with controlled provider responses. In API mode, task content and tool results are
sent to the configured provider; Responses storage is enabled for continuation via
`previous_response_id`. API credentials are read from the server environment and
excluded from CAD subprocess environments and client responses.

Official integration references:
[Responses function calling](https://developers.openai.com/api/docs/guides/function-calling)
and [Responses conversation integration](https://developers.openai.com/api/docs/guides/migrate-to-responses).
These establish the request/tool-output continuation contract used by the adapter.

## Example

Create a task with this prompt:

> Design a wall-mounted organizer for six markers, each 18 mm in diameter. Export
> STL, STEP, and assembly notes.

Answer the three questions, then inspect the STEP card. Revise in the same task:

> Revise the organizer for eight markers. Keep the same diameter. Keep the width below 210 mm.

The second run preserves the answers and produces version 2 of the files. The ZIP
contains only the selected revision and includes a checksum manifest.

A completed, verified eight-marker package is included in
[examples/marker_organizer_package.zip](examples/marker_organizer_package.zip).

Rebuild a downloaded construction recipe directly:

```sh
cd backend
../.venv/bin/python -m app.cad_worker /absolute/path/model.cad.json /absolute/path/output
```

## Verification

```sh
./verify.sh
```

Tests exercise real CAD export/reimport, mesh integrity, failed geometry, artifact
versioning and packages, task idempotency, question ownership, worker recovery,
context boundaries, queued messages, auth/origin checks, and the provider tool loop.
The test launcher disables pytest's capture plugin to avoid a native readline crash
in the available Anaconda interpreter. Test assertions still execute normally.

The expanded backend suite covers Flask and Claude Code protocol behavior as well. See the
[verification record](docs/VERIFICATION.md) for browser evidence, sample output,
and the limits of these checks.

## Where to look

| File | Responsibility |
|---|---|
| `app/main.py`, `app/api.py` | Flask REST endpoints, Pydantic validation, OpenAPI, SSE, local access boundary |
| `app/runtime.py` | Persistent background worker lifecycle separate from request threads |
| `app/db.py` | SQLite schema, transactions, lifecycle, run leases, event log |
| `app/engine.py` | Workshop execution and live model/tool loop |
| `app/provider.py` | Responses API transport and bounded retries |
| `app/claude_code.py` | Claude Code integration through the Agent SDK, in-process MCP tools, sign-in check |
| `app/connections.py` | Model connection chosen in the app: live checks, saved choice, provider switching |
| `app/tools.py` | Typed tool registry, workflow loading, reference retrieval, CAD process |
| `app/cad_schema.py` | Finite CAD feature graph and limits |
| `app/cad_worker.py` | Trusted CAD compiler, exports, views, numeric checks |
| `app/motion_worker.py`, `app/engineering_schema.py` | Prescribed rigid-body studies and typed engineering evidence |
| `app/reference_reader.py`, `app/pdf_worker.py` | Public references, PDF pages, provenance and drawing images |
| `app/artifacts.py` | Immutable files, versions, checksums, ZIP manifests |
| `app/prompts/` | Editable orchestration, CAD, research, manufacturing, review, communication |
| `docs/BEHAVIORAL_RESEARCH.md` | Observations, fresh probe, revision probe, confidence levels |
| `docs/ARCHITECTURE.md` | Backend design, state transitions, contracts, extension boundaries |
| `docs/PARITY_MATRIX.md` | Implemented behaviors and remaining gaps |
| `docs/VERIFICATION.md` | Automated checks, browser evidence, sample output and their limits |
| `docs/IMAGE_CAD_SIMULATION.md` | Object photos, assembly playback and Isaac scene export |

## Operating limits

This is a **single-user, loopback-only local implementation**. It is not ready to
expose directly as a public multi-tenant service. Before hosting, add real identity,
workspace ownership checks, role-based permissions, durable worker infrastructure,
object storage, quotas, backups, secret management, and an outbound network proxy.
An optional `6B_API_TOKEN` protects the local API; the UI stores it for the current
browser session. This does not replace production identity.

The CAD language deliberately excludes arbitrary Python and shell execution. It does
not implement native desktop CAD connections, general code sandboxes, general web
search, FEA, joint/contact dynamics, continuous swept-volume proofs, sampled wall
thickness, or third-party OAuth connectors. Tool and workflow interfaces
are ready for those extensions, but they are not represented as connected features.

Geometric checks are real. Physical fit, material behavior, safe loads, robot operation,
and print success are not established by those checks. STEP preserves editable solids;
the JSON recipe preserves construction intent. STEP does not preserve a native CAD
feature-history tree. [CadQuery's format documentation](https://cadquery.readthedocs.io/en/latest/importexport.html)
explains that distinction.

Data lives in `backend/data/`, excluded from Git. Back up the directory while the
server is stopped. Schedules run only while the server is active; missed intervals
coalesce to one run on restart. No recurring schedule was enabled during development.

PDF extraction needs `pypdf`; page images additionally need Poppler's `pdftoppm` on
PATH (available on this machine). The reader accepts up to 24 MB / 500 pages and
returns at most three selected pages per call. It does not read arbitrary local PDFs.
`inspect_image` sends generated image pixels to Claude Code; the direct API
adapter does not expose that tool. Image inspection is a model observation, not a physical test.

Complex runs can use `6B_CLAUDE_TIMEOUT=1200` and
`6B_MAX_RUN_TOKENS=2000000`. The token ceiling counts repeated
cached input as well as new input/output, is soft, and is not a currency spending cap.
Usage records expose cached/input/output counts separately. Smaller ceilings remain
useful for simple tasks; artifacts survive a budget stop. No run is silently retried.

## Execution evidence and delivery checks

The task's **Details** tab shows versioned decision summaries, their exact evidence
files, fetched sources (URL, retrieval time, document hash and PDF pages), tool
arguments/results, elapsed times, and delivery-check failures. Tools expand on demand;
large CAD inputs are not sent with every audit refresh. Earlier decisions remain
inspectable, and measurements tied to replaced geometry are marked stale.

`record_decision` records a short explanation with an explicit basis: assumption,
user choice, design choice, fetched source, or numeric measurement. Evidence IDs must
belong to the task. Source/measurement claims need appropriate evidence, and geometry
measurements must reference the current build. These are user-facing summaries;
source interpretation is model-authored, not private chain-of-thought or a proof of
physical operation.

Both live adapters now use `app/completion.py`: final answers wait for current CAD
validation/inspection, exports, decision evidence, assembly notes and packaging.
Failed checks can trigger up to three repair turns within the existing run budgets.
ZIP creation verifies stored hashes and rejects mixed CAD builds, failed motion
reports, stale CAD files and reserved manifest filenames. Tool budgets also apply to
batched calls in direct API mode. Tool IDs are scoped to each Claude Code session so a
clarification resume cannot replay an unrelated old result.

API additions:

- `GET /api/tasks/{task_id}/audit`: compact tool lifecycle, sources, decision history
  and delivery checks.
- `GET /api/tasks/{task_id}/tools/{call_id}`: full arguments and result for one call,
  restricted to that task.

Existing `/trace`, `/activity` and SSE contracts remain available. Tool interruption
is persisted after cancellation, shutdown or an expired worker lease. No database
migration is needed: the audit uses existing tool, artifact and event records.

Tool execution uses one shared boundary for both model providers. Malformed JSON,
duplicate keys, nonfinite numbers, oversized payloads, and schema errors return
structured repair hints without ending the run. Tool availability is enforced when
executing, and rejected calls remain visible in the audit. Call IDs are claimed
atomically; replaying a completed call returns its stored result without repeating
side effects. Reusing an ID for a different request is rejected.

`6B_TOOL_TIMEOUT` (default 180 seconds) bounds each tool's asynchronous work;
the Claude Code run deadline can shorten this. Pending downloads and child-process work
check cancellation every 250 ms and await cleanup before finalizing the trace.
Synchronous in-process operations finish before the event loop can observe a stop.
Timeouts are never automatically retried because partial artifacts may already
exist. Inspect saved output before explicitly retrying. Validation failures include
field paths; rejected argument previews are limited to 8 KB and fingerprinted.

## Object photos, assembly playback and NVIDIA Isaac

Open a task's **Object photos** tab. Attach PNG, JPEG or WebP views of the same
object, label the angles, and enter at least one measured dimension plus what it
represents. Choose **Reconstruct object** or **Design a gripper**. Up to twelve
views are supported. Front, side and top views reduce ambiguity. Claude Code inspects
actual image pixels and generates parametric solids using the existing CAD kernel.
This is vision-assisted reconstruction, not calibrated photogrammetry: hidden
surfaces, tolerances and unmeasured dimensions remain estimates. Workshop and direct
API modes do not interpret the uploaded photos.

Photos are decoded with bounded pixel counts, oriented using EXIF, converted to RGB
PNG and resized to a maximum 1600-pixel edge. Metadata is stripped; original and
normalized SHA-256 hashes are retained. `object_views.json` records angles, scale
and requirements. Every image in the active set must be inspected before CAD can
build. Each build retains `reconstruction_sources.json` and the source-set hash.

Open STEP, construction JSON or a motion study to use the assembly explorer. It
supports exploded views, part isolation/visibility/highlighting, camera presets,
keyboard orbit/zoom, optional turntable, and study playback with pause, scrub and
speed control. Motion uses the same world-space deltas, rotation order and pivots as
the exact-solid motion checker. Exploded offsets and playback speed are illustrative;
no dynamics results are inferred from animation.

The **Simulation** tab reads the configured existing Isaac scene through SSH/MCP.
Only `franka_observe`, `franka_task_status` and `franka_snapshot` are allowlisted;
there is no motion command, stop-latch reset, physical-robot control or public port.
Set the `6B_ISAAC_*` variables in `.env.example` to an existing instance and
container. The server uses the operator's existing SSH authentication. Connection
state, measured contacts, stop state and the previous test result are shown separately
from validation of the open design. A failed viewport capture is reported as an error.

**Export Isaac scene** creates an assembled USD collision scene in metres/Z-up and
an `isaac_manifest.json` tied to the exact CAD, mesh and scene hashes. UI export is
static. The `export_isaac_scene` tool/API can also declare dynamic parts with explicit
mass, friction and restitution. Dynamic collision uses convex hulls, which must be
reviewed for cavities and contact patches. Exports do not infer joints, actuators,
robot mounts, or physically validated materials; they do not change the running scene.
The manifest gives the remaining contact, hold, slip, release and repeatability tests.
See [the evaluation record](docs/IMAGE_CAD_SIMULATION.md) for tested behavior and limits.

## Onshape import

Connect from **Integrations → Onshape** with an API key pair created at
<https://dev-portal.onshape.com/keys> (Read access is enough). Keys are verified
against `/users/sessioninfo`, stored owner-only in `data/integrations/onshape.json`,
and never returned to the browser. Requests are HMAC-signed against
`https://<stack>.onshape.com/api/v17`; only `*.onshape.com` hosts and redirects are
accepted. Alternatively set `ONSHAPE_ACCESS_KEY`, `ONSHAPE_SECRET_KEY` and optionally
`ONSHAPE_BASE_URL` in `.env`.

Import a Part Studio or Assembly from **Files**, a task's **Files** tab, or the home
page. Each import saves one STL per distinct part (millimetres, Part Studio
coordinates), a placed `preview.mesh.json` for the 3D studio, an
`onshape_import.json` manifest (placements, quantities, sizes, watertightness) and the
Onshape thumbnail. Selecting an imported part in the studio sends a request scoped to
that read-only geometry. Imports are snapshots: features, mates and parameters stay
in Onshape. Limits: 200 instances, 80 distinct parts, 900k triangles.

**Send to Onshape** (task heading or a STEP file's preview) uploads a generated STEP
file to a new or chosen document through `POST /translations` (`translate=true`,
optionally flattening the assembly into one Part Studio), polls the translation with
backoff for up to 150 s, and links to the new element. This is the only write
6B makes, it adds a new element without changing existing ones, and it needs
API keys with Write scope.

## CAD as code, sliders and plan approval

`build_cad_script` runs a model-written CadQuery script (sketches, revolve, loft,
sweep, shell, holes, patterns) and produces the same STL/STEP/validation/preview
outputs as `build_cad`, plus `<name>.cad.py` and the exact placed solids
(`<name>.geometry.zip`, used by motion checks). Scripts are checked statically
(only `cadquery` and `math` imports; no file, network, `getattr`, dunder, class or
`with` usage; exporters/importers blocked), run with restricted builtins and CPU and
file-size limits, and on macOS under `sandbox-exec` with no network and writes
confined to the build folder. Errors report the script line. After each build the
model receives the rendered review image; `revise_cad_script` applies exact
find/replace edits.

Top-of-file assignments such as `wall = 2.4  # [1.6:0.2:5] Wall thickness (mm)`,
grouped under `# --- Housing ---`, become sliders in the 3D studio. `POST
/api/tasks/{id}/artifacts/{script}/rebuild` rewrites only those literals and rebuilds
in the same sandbox, without a model call, as a new validated version.

Once a task has a design, `request_approval` pauses the run with a plan (changes,
what stays fixed, risks, checks). Design tools return `approval_required` until the
plan is approved (`POST /api/tasks/{id}/approvals/{approval}`). Set a task's
`approval_policy` to `auto` to skip this.
