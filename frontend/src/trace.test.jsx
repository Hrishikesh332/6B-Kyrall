import { expect, it } from "vitest";
import { buildTimeline } from "./trace.js";

const ev = (seq, type, payload) => ({ seq, type, payload, created_at: seq });

it("interleaves messages with phases built from activity and tool events", () => {
  const messages = [
    { id: "u1", role: "user", created_at: 1 },
    { id: "a1", role: "assistant", created_at: 9 },
  ];
  const activity = [
    ev(1, "message.created", { id: "u1" }),
    ev(2, "tool.started", { id: "x", name: "activity" }),
    ev(4, "activity", {
      title: "Building geometry",
      detail: "Solids and views.",
    }),
    ev(5, "tool.started", { id: "c1", name: "build_cad" }),
    ev(6, "tool.completed", {
      id: "c1",
      name: "build_cad",
      result: { artifacts: [{}, {}] },
    }),
    ev(7, "validation.completed", { passed: false }),
    ev(8, "tool.started", { id: "c2", name: "write_document" }),
    ev(9, "message.created", { id: "a1" }),
  ];
  const items = buildTimeline(messages, activity, [
    { id: "c2", status: "interrupted", duration_ms: 5 },
  ]);
  expect(items.map((i) => i.type)).toEqual(["message", "trace", "message"]);
  const [phase] = items[1].phases;
  expect(phase.title).toBe("Building geometry");
  expect(phase.thinkingMs).toBe(2000);
  expect(phase.steps.map((s) => [s.label, s.status, s.target ?? null])).toEqual(
    [
      ["Build CAD model", "completed", "2 files"],
      ["Geometry needs revision", "failed", null],
      ["Write document", "interrupted", null],
    ],
  );
});

it("titles generic commentary from its first sentence and keeps unrecorded messages", () => {
  const items = buildTimeline(
    [{ id: "old", role: "user", created_at: 0 }],
    [
      ev(3, "activity", {
        title: "Model update",
        detail: "Checking the clearance budget. Then rebuild.",
      }),
    ],
  );
  expect(items[0].message.id).toBe("old");
  expect(items[1].phases[0].title).toBe("Checking the clearance budget");
  expect(items[1].phases[0].detail).toMatch(/Then rebuild/);
});
