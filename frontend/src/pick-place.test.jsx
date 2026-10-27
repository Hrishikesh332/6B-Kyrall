import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  TEST_BLOCK,
  analyseGrip,
  bestStates,
  boxPart,
  buildCycle,
  detectWorkpiece,
  meshGap,
  posed,
  sampleCycle,
  statePath,
  stepEnd,
  testBlock,
} from "./pickPlace.js";
import PickPlacePanel, { PickPlace } from "./PickPlacePanel.jsx";

const renderer = vi.hoisted(() => ({
  update: vi.fn(),
  view: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("../viewer.js", () => ({ mountViewer: () => renderer }));

// A parallel gripper: two jaws 2 mm clear of a 20 mm block when open.
const gripper = (extra = []) => ({
  units: "mm",
  parts: [
    boxPart("mount_flange", [-30, -10, 0], [30, 10, 10]),
    boxPart("jaw_left", [12, -6, -36], [18, 6, 0]),
    boxPart("jaw_right", [-18, -6, -36], [-12, 6, 0]),
    boxPart("block_ref", [-10, -5, -38], [10, 5, -10]),
    ...extra,
  ],
});
const study = (closed, open = {}) => ({
  id: "s1",
  name: "jaw_cycle",
  states: [
    { name: "open", poses: Object.entries(open).map(pose) },
    { name: "closed", poses: Object.entries(closed).map(pose) },
  ],
  transitions: [{ start: "open", end: "closed" }],
});
const pose = ([part, translation]) => ({ part, translation });
const squeeze = { jaw_left: [-2, 0, 0], jaw_right: [2, 0, 0] };
const check = (result, id) => result.checks.find((c) => c.id === id);

describe("pick and place mechanism checks", () => {
  it("passes a parallel gripper that closes on the block and opens clear", () => {
    const result = analyseGrip({
      mesh: gripper(),
      work: "block_ref",
      study: study(squeeze),
      open: "open",
      hold: "closed",
    });
    expect(result.verdict).toBe("pass");
    expect(check(result, "grip").detail).toMatch(
      /held from 2 opposing sides by jaw left and jaw right/,
    );
    expect(check(result, "release").detail).toMatch(/2\.0 mm clear/);
    expect(check(result, "table").status).toBe("pass");
  });

  it("fails when the jaws stop short and nothing catches the part", () => {
    const result = analyseGrip({
      mesh: gripper(),
      work: "block_ref",
      study: study({ jaw_left: [-1, 0, 0], jaw_right: [1, 0, 0] }),
      open: "open",
      hold: "closed",
    });
    expect(result.verdict).toBe("fail");
    expect(check(result, "grip").detail).toMatch(/falls out when lifted/);
  });

  it("fails release when the open pose still touches the part", () => {
    const result = analyseGrip({
      mesh: gripper(),
      work: "block_ref",
      study: study(squeeze, squeeze),
      open: "open",
      hold: "closed",
    });
    expect(check(result, "release").status).toBe("fail");
  });

  it("recognises a cage: hooks under the part catch it once lifted", () => {
    const hooks = [
      boxPart("hook_left", [2, -4, -40], [12, 4, -39]),
      boxPart("hook_right", [-12, -4, -40], [-2, 4, -39]),
    ];
    const result = analyseGrip({
      mesh: gripper(hooks),
      work: "block_ref",
      study: study({}),
      open: "open",
      hold: "closed",
    });
    expect(check(result, "grip").status).toBe("pass");
    expect(check(result, "grip").detail).toMatch(
      /drops 1\.0 mm and settles on hook left and hook right/,
    );
    // The hooks sit below the block's base, so a flat table is in the way.
    expect(check(result, "table").status).toBe("review");
  });

  it("flags suction-only contact from above for review", () => {
    const mesh = gripper([boxPart("cup", [-6, -4, -10], [6, 4, -2])]);
    mesh.parts = mesh.parts.filter((p) => !p.name.startsWith("jaw"));
    const result = analyseGrip({
      mesh,
      work: "block_ref",
      study: study({}),
      open: "open",
      hold: "closed",
    });
    expect(check(result, "grip").status).toBe("review");
    expect(check(result, "grip").detail).toMatch(/suction or adhesion/);
  });

  it("reports the agent's exact CAD collision result", () => {
    const result = analyseGrip({
      mesh: gripper(),
      work: "block_ref",
      study: study(squeeze),
      open: "open",
      hold: "closed",
      validation: {
        passed: false,
        collision_count: 1,
        collisions: [
          { sample: "open->closed@0.5", parts: ["jaw_left", "mount_flange"] },
        ],
      },
    });
    expect(check(result, "cad").status).toBe("fail");
    expect(result.verdict).toBe("fail");
  });

  it("measures an edge lying across a face, not only corners", () => {
    // The pad's bottom edge spans the block's face; both its corners overhang.
    const block = posed(boxPart("b", [0, -3, 0], [10, 3, 10]));
    const pad = posed({
      name: "pad",
      vertices: [
        [10.01, -5, 5],
        [10.01, 5, 5],
        [14, 0, 20],
      ],
      faces: [[0, 1, 2]],
    });
    expect(meshGap(pad, block).gap).toBeGreaterThan(1);
    expect(meshGap(pad, block, Infinity, 0.5).gap).toBeLessThan(0.05);
  });
});

describe("pick and place cycle", () => {
  it("keeps the object still while a push-to-close stroke presses down", () => {
    const push = {
      id: "s",
      name: "latch_cycle",
      states: [
        { name: "open_first_touch", poses: [] },
        {
          name: "closed_at_stroke",
          poses: [{ part: "block_ref", translation: [0, 0, 14] }],
        },
        {
          name: "latched",
          poses: [{ part: "block_ref", translation: [0, 0, 11] }],
        },
      ],
      transitions: [
        { start: "open_first_touch", end: "closed_at_stroke" },
        { start: "closed_at_stroke", end: "latched" },
      ],
    };
    const { open, hold } = bestStates(push);
    expect([open, hold]).toEqual(["open_first_touch", "latched"]);
    expect(statePath(push, open, hold)).toEqual([
      "open_first_touch",
      "closed_at_stroke",
      "latched",
    ]);
    const cycle = buildCycle({
      mesh: gripper(),
      work: "block_ref",
      study: push,
      open,
      hold,
    });
    const gripped = sampleCycle(cycle, stepEnd(cycle, 1));
    expect(gripped.poses.block_ref.translation).toEqual([0, 0, 0]);
    expect(gripped.poses.jaw_left.translation[2]).toBeCloseTo(-11);
    // Carried: the object moves with the gripper, then is left at the place station.
    const carried = sampleCycle(cycle, stepEnd(cycle, 3));
    expect(carried.poses.block_ref.translation[0]).toBeGreaterThan(0);
    expect(carried.poses.block_ref.translation[2]).toBeGreaterThan(0);
    const done = sampleCycle(cycle, 1);
    expect(done.poses.block_ref.translation[2]).toBeCloseTo(0);
    expect(done.poses.jaw_left.translation[2]).toBeGreaterThan(0);
    expect(done.label).toBe("Retract");
    // Jumping to a step shows that step finished, not the next one starting.
    expect(sampleCycle(cycle, stepEnd(cycle, 3)).label).toBe("Transfer");
  });

  it("finds the object and sizes a test block to the closed jaws", () => {
    expect(
      detectWorkpiece({
        parts: [
          boxPart("mount_plate", [0, 0, -80], [1, 1, 0]),
          boxPart("tomato_ref", [0, 0, -60], [1, 1, -40]),
        ],
      }),
    ).toBe("tomato_ref");
    const mesh = gripper();
    mesh.parts = mesh.parts.filter((p) => p.name !== "block_ref");
    expect(detectWorkpiece(mesh)).toBe("");
    const block = posed(testBlock(mesh, study(squeeze), "closed"));
    expect(block.lo[0]).toBeCloseTo(-10);
    expect(block.hi[0]).toBeCloseTo(10);
    expect(block.lo[2]).toBeLessThan(-36);
  });
});

describe("Pick & place tab", () => {
  it("animates the cycle and shows the mechanism verdict", async () => {
    const user = userEvent.setup();
    render(<PickPlace mesh={gripper()} studies={[study(squeeze)]} />);
    expect(
      await screen.findByRole("heading", {
        name: "Pick and place works in principle",
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Object to pick")).toHaveValue("block_ref");
    expect(screen.getByLabelText(/Holding pose/)).toHaveValue("closed");
    await user.click(screen.getByRole("button", { name: /Transfer/ }));
    expect(screen.getByRole("button", { name: /Transfer/ })).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(renderer.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ selected: "block_ref" }),
    );
    await user.selectOptions(
      screen.getByLabelText("Object to pick"),
      TEST_BLOCK,
    );
    expect(
      await screen.findByText(/test block is held from 2 opposing sides/),
    ).toBeInTheDocument();
  });

  it("explains when the project has no built assembly", async () => {
    render(<PickPlacePanel task={{ id: "t1", artifacts: [] }} />);
    expect(await screen.findByText("No assembly yet")).toBeInTheDocument();
  });

  it("loads the newest mesh with its motion study", async () => {
    const mesh = gripper();
    const files = {
      m1: mesh,
      s1: study(squeeze),
      v1: { passed: true, samples: ["open", "closed"] },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const id = url.split("/").at(-2);
      return new Response(JSON.stringify(files[id]));
    });
    const art = (id, name, kind, created_at = 1) => ({
      id,
      name,
      version: 1,
      created_at,
      metadata: { kind, build_id: "b1" },
    });
    render(
      <PickPlacePanel
        task={{
          id: "t1",
          artifacts: [
            art("m1", "preview.mesh.json", "mesh_preview", 2),
            art("s1", "jaw_cycle_study.json", "motion_source"),
            art("v1", "jaw_cycle_validation.json", "motion_validation"),
          ],
        }}
      />,
    );
    expect(
      await screen.findByText(/no collisions across 2 sampled poses/),
    ).toBeInTheDocument();
  });
});
