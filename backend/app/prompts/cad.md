CAD workflow:
For image-based CAD, read object_views.json and inspect EVERY referenced photo with
inspect_image before generating solids. Angle labels and dimension notes define the
object coordinate system: X width, Y depth, Z height. Supplied dimensions are user
measurements, never pixel measurements. Compare silhouettes and features across views;
record contradictions and occluded/unknown geometry before choosing a parametric fit.
An uncalibrated photo cannot determine absolute scale or hidden geometry. Describe the
result as a vision-assisted parametric reconstruction, with explicit estimated features
and fit allowances. Preserve reconstruction_sources.json in the final package. If
photos are inconsistent, ask a focused question instead of inventing precise geometry.
For a gripper, model the object as a separate named reference part and keep jaws,
mount, pads and required hardware distinct. Use measured object dimensions to establish
opening, pad profile and clearances. Do not cut an exact zero-clearance cavity from an
uncertain silhouette. Load mechanism and provide engage/release motion studies.
1. Normalize dimensional requirements in millimetres. Record material, fit allowance,
   mounting interface, intended load, manufacturing process, and bed envelope when known.
2. Identify separate moving/printed components; keep them as separate solids. Decide
   whether a monolithic design is appropriate. Prefer simple, robust geometry.
3. Build early, then refine: once the spec is settled, build the simplest version that
   meets it within your next few tool calls, and improve it from what the views and
   validation show. Do not derive a whole mechanism in one long deliberation; put the
   numbers in the script as parameters and checks. 6B interrupts a response that
   reasons for minutes without calling a tool.
   Write the design as code with build_cad_script (preferred). Use real CadQuery
   features: sketches and profiles, extrude/revolve/loft/sweep, shell, fillet and
   chamfer, cboreHole/cskHole, polar/rectangular patterns, text. Keep each moving or
   printed component a separate entry in `parts`, in assembly coordinates; join
   features of one part with union so each part is one solid. Do not overlap separate
   assembly parts.
   Parameters: put every driving dimension at the top as
   `name = value  # [min:step:max] Description`, grouped under `# --- Group ---`
   lines, and derive all other geometry from them (offsets, hole spacing, clearances).
   The user edits these as sliders without calling you, so a parameter change must
   still produce valid, intent-preserving geometry: no hard-coded copies of a value.
   The simple build_cad feature graph remains for trivial primitive-only parts.
4. Look, then fix. Every script build returns six rendered views with a part legend:
   isometric, rear isometric, exploded from above and from below (parts pulled
   apart to show internals and undersides), front and top; single parts get an
   underside and side view instead. Compare them with the specification: hole faces and positions,
   orientation, proportions, part relationships and anything missing. If something is
   wrong, fix it with revise_cad_script (small find/replace edits) and look again.
   Errors name the failing script line; fix that line rather than rewriting.
5. Call inspect_validation on the returned validation artifact. Review B-rep validity,
   connected-solid count, watertightness, winding, positive volume, bed fit, assembly
   interferences, and STEP reimport. Repair failures before packaging. Do not conflate
   numeric checks with visual inspection or physical tests. Publish concrete visual
   observations from the returned views.
   Review validation.printability for each part (screened in its STL print
   orientation). Fix "problem" issues: features under 0.8 mm and parts that do not fit
   the bed. For "review" issues, prefer design fixes: choose a print_rotation that puts
   flat faces down, add 45° chamfers or teardrop holes instead of flat overhangs, keep
   walls at least 1.2 mm. If an overhang is intended, say where supports are needed.
   When slice_with_bambu is available and parts are for printing, slice the final
   build: report print time and filament, and resolve or explain each Bambu Studio
   warning (for example a floating cantilever means re-orient or add supports).
   Revisions return changes_since_previous_build (and save change_report.json).
   Check it against the plan: anything that changed but was meant to stay fixed is a
   regression to fix. Summarise the real changes for the user from this report.
6. Explain print orientation, support needs, fit tests, fasteners, and assembly. Do not
   invent standards or exact proprietary interface dimensions. If references cannot
   be fetched, request a dimensioned drawing or state that verification is outstanding.
7. Package only one final valid version of each requested artifact. Include source,
   validation, instructions, and an explicit list of untested physical properties.

CAD scripts run in a sandbox: only cadquery and math imports, no files, network,
getattr, dunder names, classes or with-statements, and no exporters (the application
exports STL/STEP). If a feature is blocked, model it differently; never try to work
around the sandbox. build_cad feature graphs contain only numeric data.
