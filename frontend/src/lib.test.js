import test from "node:test";
import assert from "node:assert/strict";
import { deliveredArtifacts, eventCursor, latestArtifacts } from "./lib.js";

test("artifact versions are grouped by name and the highest version wins", () => {
  const input = [
    { id: "old", name: "model.stl", version: 1 },
    { id: "notes", name: "notes.md", version: 1 },
    { id: "new", name: "model.stl", version: 3 },
  ];
  assert.deepEqual(
    latestArtifacts(input).map((a) => a.id),
    ["new", "notes"],
  );
});
test("completed tasks show only files included in the newest delivery package", () => {
  const task = {
    status: "completed",
    artifacts: [
      { id: "draft", name: "draft.stl", version: 1, metadata: { kind: "cad" } },
      { id: "final", name: "model.stl", version: 1, metadata: { kind: "cad" } },
      {
        id: "mesh",
        name: "preview.json",
        version: 1,
        metadata: { kind: "mesh_preview" },
      },
      {
        id: "zip",
        name: "delivery.zip",
        version: 1,
        created_at: 20,
        metadata: { kind: "package", manifest: [{ id: "final" }] },
      },
    ],
  };
  assert.deepEqual(
    deliveredArtifacts(task).map((a) => a.id),
    ["final", "zip"],
  );
  assert.deepEqual(
    deliveredArtifacts({ ...task, status: "running" }).map((a) => a.id),
    ["draft", "final", "zip"],
  );
});
test("SSE cursors ignore heartbeat and malformed IDs", () => {
  assert.equal(eventCursor("id: 42\nevent: activity\ndata: {}"), 42);
  assert.equal(eventCursor(": heartbeat"), null);
  assert.equal(eventCursor("id: bad\ndata: {}"), null);
  assert.equal(eventCursor('data: {"id": 99}'), null);
});
