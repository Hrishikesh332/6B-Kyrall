# Image-to-CAD, assembly and Isaac evaluation

Verified on 26 October 2026. All live test data was isolated from the user's tasks.

## Implemented

- Bounded image decoding, normalized pixel delivery to Claude Code, multi-angle photo sets
  with measured scale, task ownership checks and immutable image hashes.
- Image-based CAD builds require inspection of every referenced view and retain the
  exact capture manifest alongside generated artifacts.
- Gripper requests carry object dimensions into moving-jaw CAD, object reference
  geometry, prescribed motion and the existing mechanism evidence gates.
- WebGL rendering with independent part transforms, exploded assembly, isolation,
  visibility, highlighting, turntable, keyboard controls and motion timeline playback.
- Read-only Brev/Isaac scene observation and viewport request; source-linked USD
  collision scenes and test manifests. No robot motion is exposed by this adapter.

## Results

- Backend suite: 64 passed, including real CadQuery export/reimport and seven new
  image/simulation tests. Frontend: five Node checks and 18 Vitest tests passed;
  production Vite build passed. Additional tests added later are recorded by the
  normal suite output. The final targeted image/connector/provider rerun passed all 15 tests.
- Live model evaluation: the model received a synthetic composite image containing
  four CAD projections of a plate. Outside dimensions and bore diameter were supplied;
  hole count and layout were not supplied in the prompt. It inferred four holes at
  X = ±30 mm, Y = ±15 mm, radius 2.25 mm, in an 80 × 50 × 5 mm nominal plate.
  STEP/STL, construction JSON, reconstruction provenance, notes and ZIP were created.
  Geometry passed, no assembly overlaps, and STEP reimport passed.
  [Saved numeric and construction evidence](evaluations/image_to_cad_2026-10-26.json). Reported B-rep
  envelope was 80 × 50 × 5.003 mm. This is one synthetic evaluation, not a benchmark
  of photographs, organic shapes, unseen geometry or metrology accuracy.
- Browser QA: real assembly rendering, motion reaching 100%, photo form controls,
  connected Isaac state, existing failed grasp evidence, and USD export verified.
- NVIDIA Brev access: existing L40S instance `6b-kyrall`; Isaac 6.2.0 container
  `gripforge-isaac-rl3`. A separate USD parser process accepted the exported scene,
  including metres, Z-up, collision API, vertices and declared mass. The running
  robot scene was not modified or advanced.
- Existing Isaac scene remained stopped. Its previous tomato attempt reported no
  sustained hold, no verified destination release, and a force-cap failure. The
  scene uses uncalibrated proxies and did not qualify a grasp.
- The existing `franka_snapshot` handler returned `Viewport capture did not complete`
  through both the direct connector and new backend. The application preserves this
  failure; it does not substitute a rendering and call it a live viewport.

## Remaining testing boundary

USD export prepares a scene; it is not automated gripper dynamics validation.
A matching articulated model, measured mass/friction/compliance, collision review,
robot/tool frames, actuation and force/slip traces are still needed for a new design.
No photogrammetry model, FEA solver, physical grasp validation or automatic execution
of newly generated grippers is claimed.

NVIDIA describes the SSH workflow in its
[Brev connectivity documentation](https://docs.nvidia.com/brev/cli/connectivity).
Collision offsets, contact materials and friction affect fidelity as described in
[Isaac physics fundamentals](https://docs.isaacsim.omniverse.nvidia.com/latest/physics/simulation_fundamentals.html).
