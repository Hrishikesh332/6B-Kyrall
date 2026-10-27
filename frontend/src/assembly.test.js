import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approachDirections,
  assemblyOrder,
  moveStep,
  partBounds,
  recordingFormat,
  sampleAssembly,
  stepProgress,
} from "./assembly.js";

const box = (name, [x, y, z], s) => ({
  name,
  vertices: [
    [x - s, y - s, z - s],
    [x + s, y + s, z + s],
    [x + s, y - s, z - s],
  ],
  faces: [[0, 1, 2]],
});
const mesh = {
  parts: [
    box("cap", [0, 0, 60], 5),
    box("body", [0, 0, 0], 20),
    box("pin", [0, 0, 28], 3),
  ],
};

test("orders from the widest base outward, nearest first", () => {
  const plate = {
    name: "plate",
    vertices: [
      [-40, -40, 0],
      [40, 40, 8],
      [40, -40, 0],
    ],
    faces: [[0, 1, 2]],
  };
  const tall = {
    name: "tower",
    vertices: [
      [-18, -18, 8],
      [18, 18, 48],
      [18, -18, 8],
    ],
    faces: [[0, 1, 2]],
  };
  // The tower's box volume is larger, but the plate is the base.
  assert.deepEqual(assemblyOrder({ parts: [tall, plate] }), ["plate", "tower"]);
  assert.deepEqual(assemblyOrder(mesh), ["body", "pin", "cap"]);
  assert.deepEqual(assemblyOrder({ parts: [box("only", [0, 0, 0], 1)] }), [
    "only",
  ]);
});

test("parts approach from outside and seat exactly at the end of their step", () => {
  const bounds = partBounds(mesh),
    order = assemblyOrder(mesh, bounds),
    directions = approachDirections(order, bounds);
  for (const d of Object.values(directions))
    assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-9);
  assert.ok(directions.cap[2] > 0.5, "cap is lowered from above");
  const start = sampleAssembly(order, directions, 100, 0);
  assert.equal(start.active, "body");
  assert.deepEqual(start.upcoming, ["pin", "cap"]);
  assert.ok(Math.hypot(...start.offsets.body) > 80);
  const seated = sampleAssembly(
    order,
    directions,
    100,
    stepProgress(1, 3) - 1e-6,
  );
  assert.equal(seated.active, "pin");
  assert.ok(Math.hypot(...seated.offsets.pin) < 1e-3);
  assert.deepEqual(
    seated.offsets.cap,
    [0, 0, 0],
    "upcoming parts stay in their slot",
  );
  const done = sampleAssembly(order, directions, 100, 1);
  assert.deepEqual(done.upcoming, []);
  assert.ok(Object.values(done.offsets).every((o) => Math.hypot(...o) < 1e-9));
});

test("reorders steps within bounds and picks a supported video format", () => {
  assert.deepEqual(moveStep(["a", "b", "c"], 2, -1), ["a", "c", "b"]);
  assert.deepEqual(moveStep(["a", "b"], 0, -1), ["a", "b"]);
  assert.equal(recordingFormat(undefined), null);
  assert.deepEqual(
    recordingFormat({ isTypeSupported: (t) => t === "video/mp4" }),
    ["video/mp4", "mp4"],
  );
});
