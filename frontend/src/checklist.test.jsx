import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { checklistSteps } from "./checklist.js";
import TaskChecklist from "./TaskChecklist.jsx";
import { ApprovalCard } from "./Approval.jsx";

const plan = (a, b, c) => ({
  type: "plan.updated",
  payload: {
    value: [
      { id: "spec", title: "Define the brief", status: a },
      { id: "build", title: "Build and inspect CAD", status: b },
      { id: "ship", title: "Package files", status: c },
    ],
  },
});
const tool = (type, seq, id, name, extra = {}) => ({
  seq,
  type,
  payload: { id, name, ...extra },
});
const activity = [
  { ...plan("in_progress", "pending", "pending"), seq: 1 },
  tool("tool.started", 2, "t1", "set_specification"),
  tool("tool.completed", 3, "t1", "set_specification", { duration_ms: 5 }),
  {
    seq: 4,
    type: "activity",
    payload: { title: "Defaults chosen", detail: "2 mm walls" },
  },
  { ...plan("completed", "in_progress", "pending"), seq: 5 },
  tool("tool.started", 6, "t2", "build_cad_script"),
  tool("tool.failed", 7, "t2", "build_cad_script", {
    result: { error: "Line 4: bad face" },
  }),
  tool("tool.started", 8, "t3", "build_cad_script"),
  tool("tool.completed", 9, "t3", "build_cad_script", { duration_ms: 14000 }),
  tool("tool.started", 10, "t4", "inspect_image"),
];

describe("task checklist", () => {
  it("attributes actions and notes to the step that was active", () => {
    const [spec, build, ship] = checklistSteps(
      activity.at(4).payload.value,
      activity,
    );
    expect(spec.actions.map((a) => a.label)).toEqual([
      "Saved the specification",
      "Defaults chosen",
    ]);
    expect(build.actions.map((a) => [a.label, a.status])).toEqual([
      ["Built CAD from script", "failed"],
      ["Built CAD from script", "completed"],
      ["Looked at rendered views", "running"],
    ]);
    expect(build.duration).toBe(14000);
    expect(ship.actions).toEqual([]);
    // A step marked done without being started still gets the actions since the last step.
    const skipped = checklistSteps(
      plan("completed", "completed", "completed").payload.value,
      [
        ...activity,
        { ...plan("completed", "completed", "completed"), seq: 11 },
      ],
    );
    expect(skipped[2].actions).toEqual([]);
    expect(skipped[1].actions).toHaveLength(3);
  });

  it("shows live progress, follows the active step and expands on click", async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(
      <TaskChecklist
        plan={activity.at(4).payload.value}
        activity={activity}
        status="running"
      />,
    );
    expect(screen.getByText("Step 2 of 3 · Working")).toBeVisible();
    expect(
      container.querySelector(".check-icon.active.spinning"),
    ).not.toBeNull();
    expect(
      container.querySelector(".checklist-progress span").style.width,
    ).toBe("33.33333333333333%");
    // The active step is open with its actions, including the failure reason.
    expect(screen.getByText("Line 4: bad face")).toBeVisible();
    expect(container.querySelector(".action-spinner")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: /Define the brief/ }));
    expect(screen.getByText("2 mm walls")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Package files/ }),
    ).toBeDisabled();
    rerender(
      <TaskChecklist
        plan={activity.at(4).payload.value}
        activity={activity}
        status="awaiting_input"
      />,
    );
    expect(screen.getByText("Step 2 of 3 · Waiting for you")).toBeVisible();
    expect(container.querySelector(".check-icon.spinning")).toBeNull();
    await user.click(
      within(container.querySelector(".checklist-steps")).getByRole("button", {
        name: /Build and inspect CAD/,
      }),
    );
    await user.click(screen.getByRole("button", { name: /Step 2 of 3/ }));
    expect(
      screen.queryByRole("button", { name: /Define the brief/ }),
    ).toBeNull();
  });
});

describe("plan questions", () => {
  it("preselects the recommended option and sends the chosen answers", async () => {
    const user = userEvent.setup();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));
    const message = {
      content: {
        id: "ap1",
        title: "Add a lip",
        summary: "Add a locating lip.",
        changes: [{ target: "lid", change: "Add lip" }],
        questions: [
          {
            id: "fit",
            question: "Lip clearance per side?",
            options: ["0.2 mm", "0.3 mm"],
            default: "0.3 mm",
          },
          {
            id: "height",
            question: "Tallest edge component?",
            options: ["Under 8 mm", "Up to 12 mm"],
            default: "Up to 12 mm",
          },
        ],
      },
    };
    const task = {
      id: "t1",
      status: "awaiting_input",
      approvals: [{ id: "ap1", status: "pending" }],
    };
    render(
      <ApprovalCard
        message={message}
        task={task}
        refresh={vi.fn().mockResolvedValue()}
      />,
    );
    expect(screen.getByText("Before I build, please confirm")).toBeVisible();
    expect(screen.getByRole("radio", { name: /0.3 mm/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByRole("radio", { name: /0.2 mm/ }));
    await user.click(screen.getByRole("button", { name: /Approve and build/ }));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      decision: "approve",
      note: "",
      answers: { fit: "0.2 mm", height: "Up to 12 mm" },
    });
  });
});

describe("checklist across runs", () => {
  it("drops actions from an earlier run when a step id is reused, and shows planning", () => {
    const rerun = [
      ...activity,
      { ...plan("completed", "completed", "completed"), seq: 11 },
      { ...plan("in_progress", "pending", "pending"), seq: 20 },
      tool("tool.started", 21, "t9", "request_approval"),
      tool("tool.completed", 22, "t9", "request_approval", { duration_ms: 3 }),
    ];
    const steps = checklistSteps(rerun.at(-3).payload.value, rerun);
    expect(steps[0].actions.map((a) => a.label)).toEqual([
      "Asked you to approve the plan",
    ]);
    expect(steps[1].actions).toEqual([]);
    const { container } = render(
      <TaskChecklist
        plan={plan("completed", "completed", "completed").payload.value}
        activity={activity}
        status="running"
      />,
    );
    expect(screen.getByText("Planning next steps…")).toBeVisible();
    expect(
      container.querySelector(".checklist-badge .spinning"),
    ).not.toBeNull();
  });
});
