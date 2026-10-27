import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ParameterPanel from "./ParameterPanel.jsx";
import { ApprovalCard, ApprovalPolicy, ParameterChange } from "./Approval.jsx";

const parameters = [
  {
    name: "length",
    value: 70,
    min: 50,
    max: 120,
    step: 1,
    type: "integer",
    group: "Enclosure",
    description: "Outer length (mm)",
  },
  {
    name: "wall",
    value: 2,
    min: 1.2,
    max: 4,
    step: 0.2,
    type: "number",
    group: "Enclosure",
    description: "",
  },
  {
    name: "vented",
    value: true,
    type: "boolean",
    group: "Lid",
    description: "Cut a vent slot",
  },
];

describe("design parameters", () => {
  it("lets a value be typed digit by digit through the minimum", async () => {
    const user = userEvent.setup(),
      onRebuild = vi.fn().mockResolvedValue();
    render(<ParameterPanel parameters={parameters} onRebuild={onRebuild} />);
    const box = screen.getByLabelText("length value");
    await user.clear(box);
    await user.type(box, "96"); // "9" alone is below the minimum of 50
    expect(box).toHaveValue(96);
    expect(screen.getByLabelText("length")).toHaveValue("96");
    await user.tab();
    expect(box).toHaveValue(96);
    await user.click(
      screen.getByRole("button", { name: "Rebuild with 1 change" }),
    );
    expect(onRebuild).toHaveBeenCalledWith({ length: 96 });
  });
  it("sends only changed values, marks the original and resets", async () => {
    const user = userEvent.setup(),
      onRebuild = vi.fn().mockResolvedValue();
    render(<ParameterPanel parameters={parameters} onRebuild={onRebuild} />);
    expect(screen.getByText("Enclosure")).toBeVisible();
    expect(screen.getByRole("button", { name: "Rebuild" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("length"), {
      target: { value: "96" },
    });
    await user.click(screen.getByRole("checkbox", { name: /vented/ }));
    fireEvent.change(screen.getByLabelText("wall value"), {
      target: { value: "9" },
    });
    expect(screen.getByLabelText("wall value")).toHaveValue(9); // kept while typing
    fireEvent.blur(screen.getByLabelText("wall value"));
    expect(screen.getByLabelText("wall value")).toHaveValue(4); // clamped to range
    const origin = screen.getByRole("button", { name: "Reset length to 70" });
    expect(origin.style.left).toBe("28.57142857142857%");
    await user.click(
      screen.getByRole("button", { name: "Rebuild with 3 changes" }),
    );
    expect(onRebuild).toHaveBeenCalledWith({
      length: 96,
      wall: 4,
      vented: false,
    });
    await user.click(origin);
    expect(screen.getByLabelText("length")).toHaveValue("70");
    await user.click(screen.getByRole("button", { name: /Reset$/ }));
    expect(screen.getByRole("button", { name: "Rebuild" })).toBeDisabled();
  });

  it("shows rebuild errors and the blocked reason", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <ParameterPanel
        parameters={parameters}
        onRebuild={vi
          .fn()
          .mockRejectedValue(new Error("wall must be between 1.2 and 4"))}
      />,
    );
    fireEvent.change(screen.getByLabelText("length"), {
      target: { value: "80" },
    });
    await user.click(
      screen.getByRole("button", { name: /Rebuild with 1 change/ }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "between 1.2 and 4",
    );
    unmount();
    render(
      <ParameterPanel
        parameters={parameters}
        onRebuild={vi.fn()}
        disabledReason="6B is working on this task."
      />,
    );
    fireEvent.change(screen.getByLabelText("length"), {
      target: { value: "80" },
    });
    expect(screen.getByRole("button", { name: /Rebuild with/ })).toBeDisabled();
    expect(screen.getByText("6B is working on this task.")).toBeVisible();
  });
});

describe("plan approval", () => {
  const plan = {
    id: "ap1",
    title: "Thicker walls",
    summary: "Increase wall to 3 mm.",
    changes: [{ target: "wall", change: "2 → 3 mm" }],
    preserved: ["Outer size"],
    risks: [],
    checks: ["Validation"],
  };
  const task = (status) => ({
    id: "t1",
    status: "awaiting_input",
    approvals: [
      {
        id: "ap1",
        status,
        decision: status === "changes_requested" ? { note: "Keep 2.4" } : null,
      },
    ],
  });

  it("approves, or requires a note before sending the plan back", async () => {
    const user = userEvent.setup(),
      refresh = vi.fn().mockResolvedValue();
    const calls = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push([url, JSON.parse(init.body)]);
      return new Response("{}");
    });
    render(
      <ApprovalCard
        message={{ content: plan }}
        task={task("pending")}
        refresh={refresh}
      />,
    );
    expect(screen.getByRole("cell", { name: "2 → 3 mm" })).toBeVisible();
    expect(screen.getByText("Outer size")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    expect(screen.getByRole("button", { name: "Send back" })).toBeDisabled();
    await user.type(
      screen.getByLabelText(/What should change/),
      "Keep 2.4 mm walls",
    );
    await user.click(screen.getByRole("button", { name: "Send back" }));
    expect(calls[0]).toEqual([
      "/api/tasks/t1/approvals/ap1",
      { decision: "changes", note: "Keep 2.4 mm walls", answers: {} },
    ]);
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: /Approve and build/ }));
    expect(calls[1][1].decision).toBe("approve");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("shows the decision and toggles the task policy", async () => {
    const user = userEvent.setup(),
      refresh = vi.fn().mockResolvedValue();
    render(
      <ApprovalCard
        message={{ content: plan }}
        task={task("changes_requested")}
        refresh={refresh}
      />,
    );
    expect(screen.getByText("Changes requested")).toBeVisible();
    expect(screen.getByText("Keep 2.4")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));
    render(
      <ApprovalPolicy
        task={{ id: "t1", approval_policy: "ask" }}
        refresh={refresh}
      />,
    );
    await user.selectOptions(screen.getByLabelText(/Design changes/), "auto");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      approval_policy: "auto",
    });
    render(
      <ParameterChange
        message={{
          content: {
            source: "box.cad.py",
            values: { length: 100, vented: false },
            passed: true,
          },
        }}
      />,
    );
    expect(screen.getByText(/length 100, vented off/)).toBeVisible();
  });
});
