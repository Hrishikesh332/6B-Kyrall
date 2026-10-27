# Observable behavior and implementation parity

“Implemented” means working code exists and the verification scope below is stated.
It does not imply identical internals or equal model intelligence.

| Capability | Status | Verification / limit |
|---|---|---|
| New task and conversation history | Implemented | API and browser exercised |
| Asynchronous runs | Implemented | Real worker and queued states |
| Progress groups and plan | Implemented | Durable events and checklist |
| Clarification forms | Implemented | Browser and API; 1–3 questions |
| Resume after answers | Implemented | Same run checkpoint; tested |
| Mid-run follow-up | Implemented with boundary | Queued for next turn, not arbitrary mid-tool interruption |
| Stop / retry / recovery | Implemented | Tests include cancellation while waiting on a model and expired leases |
| Duplicate request protection | Implemented | Scoped idempotency keys and request fingerprints |
| Exact hidden prompts | Unavailable | Authored replacements in app/prompts/ |
| Private model reasoning | Unavailable | Action summaries and tool evidence only |
| Workflow loading | Implemented | Version hashes and domain-specific guidance |
| General AI interpretation | Implemented | Claude Code (Agent SDK) drives typed tools through an in-process MCP server; direct Responses adapter also available |
| Python Flask endpoints | Implemented | Native WSGI endpoints, validation, OpenAPI, SSE; existing URL contract preserved |
| Clarification/resume | Implemented | Same application run; restored context in a new Claude Code session |
| Model catalog / fast presets | Partial | Operator selects model; no fabricated catalog or billing |
| Offline CAD examples | Implemented | Real six/eight-marker and plate exports tested |
| General CAD construction | Implemented with bounds | 120-node finite feature graph; 12 assembly parts |
| CAD as code | Implemented with sandbox | Model-written CadQuery scripts: AST allowlist (cadquery/math only, no file/IO/introspection), restricted builtins, CPU/file limits, macOS Seatbelt with no network and writes confined to the build folder. Other platforms run without the OS layer. No general shell/Python tool |
| STL / STEP / construction source | Implemented | Kernel exports; STEP reimport and mesh checks |
| Artifact versions | Implemented | Immutable bytes; revision 1 and 2 tested |
| ZIP delivery | Implemented | Exact-version manifest and checksum validation |
| CAD preview | Implemented | Actual triangles, orbit/zoom, SVG projections |
| Model visual review | Implemented for Claude Code | Actual CAD PNG and PDF pixels, current-build inspection gate; observations can still be wrong |
| Numerical geometry checks | Implemented | Solids, watertightness, winding, volume, envelope, intersection, reimport |
| Printability screening | Implemented with limits | Per part in STL print orientation: overhangs beyond 45°, ray-measured walls under 1.2 mm (review) / 0.8 mm (problem), bed fit; faces shown in the 3D studio Print check. Not a slicer simulation |
| Prescribed motion checks | Implemented | Sampled exact-solid intersections, surface gaps, relative-moving parts; not joint/contact dynamics |
| FEA / physical validation | Not implemented | No claims of tested physical performance |
| Functional requirement review | Implemented with limits | Alternatives, six cycle phases, evidence links, hardware and bench criteria; model-authored semantic assessment |
| Targeted CAD edits | Implemented | Validated node/part patches; exact find/replace script edits |
| Build review images | Implemented | Six depth-tested views (isometric, rear, exploded above and below, front, top) with part legend and overall size, returned to the model after every script build |
| Parameter sliders | Implemented | Parameters parsed from the script header; rebuilds run the saved script in the sandbox without a model call |
| Change report and version compare | Implemented | Every rebuild saves change_report.json (parts added/removed/changed with volume, size and position deltas, parameter changes, check changes, source diff) and returns its summary to the model; the 3D studio compares any two builds side by side with a synced camera |
| Plan approval | Implemented | request_approval pauses the run; design tools are blocked on existing designs until a plan is approved (per-task policy) |
| Assembly/manufacturing notes | Implemented | Artifact with measured values and stated limits |
| Shared project brief and text references | Implemented | Project APIs and bounded model context |
| Memory scopes | Implemented | Isolation and project export boundary tests |
| Semantic memory search | Not implemented | Lexical ranking over recent summaries |
| File search / uploads / downloads | Implemented | Task ownership and exact-byte tests |
| Native rich document/table editor | Not implemented | Safe text/JSON preview and original download |
| Public reference retrieval | Implemented with bounds | Allowlisted HTTPS HTML/text/JSON/PDF, source hash, date and pages |
| PDF drawing inspection | Implemented for Claude Code | Poppler rendering and actual pixels; tested with manufacturer manual |
| General web search | Not implemented | Official catalog links and known references only |
| External CAD/MCP/OAuth connectors | Not implemented | Shown as not connected; extension contract documented |
| Scheduled runs | Implemented with limits | Interval-based, local-server-dependent; no webhook/calendar parser |
| Team roles / sharing / public links | Not implemented | Single-user local workspace |
| Billing and spend controls | Partial | Usage tokens and soft budgets; no monetary ledger |
| Security for public hosting | Not complete | Loopback, optional token, origin/host checks; production tenancy is separate |

## Validation performed

- Real CAD generation, versioned revisions, STEP reimport, and mesh validation.
- ZIP member checksums and artifact ownership/path confinement.
- Stateful clarification/resume, durable runs, cancellation, leases, retries, queued messages.
- Model/tool integration using scripted provider outputs, including repair after failed tools.
- Project memory boundaries, API auth/origin checks, project references, and schedule records.
- JavaScript syntax checks and browser walkthrough of the connected local interface.

The repository deliberately avoids a fabricated success narrative for unimplemented
capabilities. The interface displays execution mode and connection status truthfully.

## Workflow/evidence extension — 26 October 2026

Decision summaries now have checked artifact citations, revision history and stale
measurement indicators. Source cards preserve retrieval provenance, including legacy
reference records. Tool inputs/results expand independently with status and elapsed
time. Claude Code and direct API completion share current-build gates and bounded repairs;
final text is withheld until those gates pass. ZIP bytes are verified against stored
hashes and mixed builds are rejected. These changes implement observable workflow
contracts without claiming access to private prompts or internal reasoning.
