Mechanism workflow (geometry evidence and physical function are separate):
When NVIDIA/Isaac simulation is requested, use export_isaac_scene on the passing
CAD source to prepare a USD collision scene and a source-hashed test manifest.
Specify dynamic bodies only when mass and contact parameters are available, and
record whether they were measured or assumed. Export does not infer joints, robot
mounts or actuators and does not run physics. Include both exported files in the
package. The live scene observer is separate; never transfer a pass from an existing
robot scene to a newly generated CAD revision. Accurate testing needs matching CAD
and scene hashes, collision geometry review, calibrated materials, joint drives,
force/slip/hold/release traces and failure criteria from the manifest.

1. Before CAD, compare at least two plausible passive concepts using concise decision
   summaries: energy source, cycle completion, part count, fabrication, and likely
   failures. Choose the least complex concept that fits the actual requirements.
   Do not reveal private deliberation; publish the choice and concrete tradeoff.
2. Map approach, engage, transport, release, withdraw, reset. For each phase identify
   the trigger, energy source, load retention or release, and unresolved test. Check
   that release/withdraw does not immediately regrasp the object. An external fixture
   is a system dependency: model it or explicitly state its geometry is untested.
3. Distinguish printed parts, fasteners, bearings, springs, pads and fixtures. A pair
   of floating solids with no retaining joint is not an assembled working mechanism.
   Record the hardware, spring specification/open questions, guidance and load path.
   Avoid complicated cams/latches without a defined input/output relation.
4. Construct an economical model within the finite CAD schema. Node names contain
   letters/digits/underscores (no minus signs). Use revise_cad_script (or revise_cad) for small repairs; do
   not repeatedly resend the full graph. Preserve verified mounting features.
5. Inspect numeric validation and the actual preview.png using inspect_image.
   Resolve evident part layout, access, trapped part and missing connection problems.
6. Run evaluate_motion on the current generated CAD source. Give at least two
   meaningful poses and sampled transitions, including operating extremes. Poses
   are world-space deltas from the exported assembly; omitted parts stay fixed.
   All named parts are collision tested, including stations. Geometry at handoff or
   near contact needs finer sampling. Gap checks measure minimum surface distance,
   not arbitrary fingertip opening: only use them where that quantity is meaningful.
   Inspect failures and revise geometry or pose definitions; rerun after every edit.
   This does not solve joints, prove force transmission, or prove a continuous path.
   Limits are 12 states, 12 transitions, 3–25 samples per transition, 240 samples total,
   and 12000 part-pair checks. Use named studies if splitting a cycle; preserve all
   passing studies in the package. Repair a study using the same name.
   For a closing gripper, record_design_review must name base_part and retaining_parts;
   the motion study must show the retaining parts moving relative to that base.
   Moving a whole rigid tool between stations does not meet a closing requirement.
7. Use record_design_review for each requirement, with generated artifact IDs for
   measured facts and explicit assumed/unverified status otherwise. Cover all six
   phases, alternatives, nonprinted hardware, and specific bench tests with acceptance
   criteria. Include diameter-range extremes, retention, release, reset, jams, fit,
   deformation and repeatability as relevant. State unknown friction, spring rates,
   mass and allowable contact pressure; do not invent empirical tomato properties.
8. Deliver a prototype package including the current motion study/report and design
   review, as well as CAD, validation and assembly notes. Completion means these
   deliverables were created and checked. It does not mean a physical gripper works.
