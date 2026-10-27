import { expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ExecutionSummary from "./ExecutionSummary.jsx";
import { EvidenceContent, ToolRecord } from "./EvidencePanel.jsx";
import TaskPage from "./TaskPage.jsx";

vi.mock("@formkit/auto-animate/react", () => ({
  useAutoAnimate: () => [() => {}],
}));
const task = {
  id: "t1",
  title: "Plate",
  status: "completed",
  runs: [{ id: "r1", status: "completed" }],
  artifacts: [],
  messages: [],
  plan: [],
  questionnaires: [],
  context_scope: "isolated",
  last_event_id: 1,
};
const call = {
  id: "c1",
  run_id: "r1",
  name: "write_document",
  status: "failed",
  duration_ms: 10,
};
const data = { tools: [call], sources: [], decisions: [], checks: [] };
const resource = { data, error: null, reload: vi.fn() };
const response = (body) => new Response(JSON.stringify(body), { status: 200 });

it("does not report a stopped tool with no result as successful", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    response({ ...call, status: "cancelled", result: null, arguments: {} }),
  );
  const { container } = render(
    <ToolRecord taskId="t1" call={{ ...call, status: "cancelled" }} />,
  );
  await userEvent.click(container.querySelector("summary"));
  expect(
    await screen.findByText("This tool was stopped. Partial output may exist."),
  ).toBeVisible();
  expect(screen.queryByText("Tool completed successfully.")).toBeNull();
});

it("shows failed attempts as history without relabeling a completed run", async () => {
  const onOpen = vi.fn();
  render(<ExecutionSummary task={task} audit={resource} onOpen={onOpen} />);
  expect(screen.getByRole("status")).toHaveTextContent("Work completed");
  expect(screen.getByText(/1 failed attempt/)).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "View work details" }),
  );
  expect(onOpen).toHaveBeenCalledOnce();
});

it("tracks only the latest run and explains loading failures instead of showing zero calls", () => {
  const current = {
    ...task,
    status: "running",
    runs: [...task.runs, { id: "r2", status: "running" }],
  };
  const { rerender } = render(
    <ExecutionSummary
      task={current}
      audit={{
        ...resource,
        data: {
          ...data,
          tools: [
            call,
            {
              ...call,
              id: "c2",
              run_id: "r2",
              name: "build_cad",
              status: "running",
            },
          ],
        },
      }}
      onOpen={vi.fn()}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Build CAD model");
  expect(screen.queryByText(/failed attempt/)).toBeNull();
  rerender(
    <ExecutionSummary
      task={current}
      audit={{ error: new Error("Offline"), data: null }}
      onOpen={vi.fn()}
    />,
  );
  expect(screen.getByText("Details could not be loaded")).toBeInTheDocument();
  expect(screen.queryByText(/0 tool calls/)).toBeNull();
});

it("explains structured errors before exposing raw input and keeps nested disclosures independent", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    response({
      ...call,
      arguments: { name: "/bad.txt", content: "raw-document-body" },
      result: {
        error: "Schema rejected",
        code: "invalid_arguments",
        fields: [{ path: "name", message: "Use a file name without a path" }],
        hint: "Correct the name and retry",
      },
    }),
  );
  const { container } = render(<ToolRecord taskId="t1" call={call} />);
  await userEvent.click(container.querySelector("summary"));
  expect(
    await screen.findByText("The request needs a correction"),
  ).toBeVisible();
  expect(screen.getByText(/Use a file name/, { selector: "li" })).toBeVisible();
  expect(screen.getByText(/raw-document-body/)).not.toBeVisible();
  await userEvent.click(screen.getByText("Technical details"));
  expect(screen.getByText(/raw-document-body/)).toBeVisible();
  await userEvent.click(screen.getByText("Technical details"));
  expect(screen.getByText("The request needs a correction")).toBeVisible();
  expect(screen.getByText(/raw-document-body/)).not.toBeVisible();
});

it("keeps old failures inspectable while showing the latest delivery check", async () => {
  const checks = [
    {
      run_id: "r1",
      created_at: 1,
      payload: {
        passed: false,
        title: "Delivery checks require repair",
        errors: ["Check the geometry"],
        attempt: 1,
      },
    },
    {
      run_id: "r1",
      created_at: 2,
      payload: {
        passed: true,
        title: "Delivery checks passed",
        errors: [],
        attempt: 2,
      },
    },
  ];
  const tools = [
    call,
    ...Array.from({ length: 7 }, (_, i) => ({
      ...call,
      id: `ok${i}`,
      status: "completed",
      name: "activity",
    })),
  ];
  const { rerender } = render(
    <EvidenceContent
      task={task}
      audit={{ ...resource, data: { ...data, tools, checks } }}
      openArtifact={vi.fn()}
    />,
  );
  expect(screen.getByText("Delivery checks passed")).toBeVisible();
  expect(screen.getByText("Check the geometry")).not.toBeVisible();
  await userEvent.click(screen.getByText("Previous checks (1)"));
  expect(screen.getByText("Check the geometry")).toBeVisible();
  expect(screen.queryByText("Write document")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /Show failures/ }));
  expect(screen.getByText("Write document")).toBeVisible();
  expect(screen.queryByText("Share progress")).toBeNull();
  await userEvent.selectOptions(
    screen.getByLabelText("Execution run"),
    "latest",
  );
  rerender(
    <EvidenceContent
      task={{ ...task, runs: [...task.runs, { id: "r2", status: "running" }] }}
      audit={{
        ...resource,
        data: {
          ...data,
          tools: [
            ...tools,
            {
              ...call,
              id: "new",
              run_id: "r2",
              name: "build_cad",
              status: "running",
            },
          ],
          checks,
        },
      }}
      openArtifact={vi.fn()}
    />,
  );
  expect(screen.getByText("Build CAD model")).toBeVisible();
  expect(screen.queryByText("Write document")).toBeNull();
});

it("connects the conversation summary to details without eagerly fetching the full trace", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, options) => {
      if (url.includes("/events?"))
        return new Response(
          new ReadableStream({
            start(controller) {
              options.signal.addEventListener(
                "abort",
                () => controller.close(),
                { once: true },
              );
            },
          }),
        );
      if (url.includes("/activity?")) return response([]);
      if (url.endsWith("/audit")) return response(data);
      if (url.endsWith("/trace")) return response([{ id: "trace1" }]);
      return response(task);
    });
  const modal = vi.fn();
  render(
    <TaskPage
      id="t1"
      cap={{ provider: "workshop" }}
      openArtifact={vi.fn()}
      setModal={modal}
      notify={vi.fn()}
      onTaskChange={vi.fn()}
      onConnection={vi.fn()}
    />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "View work details" }),
  );
  expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.queryByRole("tab", { name: "Activity" })).toBeNull();
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/trace"))).toBe(false);
  await userEvent.click(
    screen.getByRole("button", { name: "Open full technical trace" }),
  );
  await waitFor(() =>
    expect(modal).toHaveBeenCalledWith({
      kind: "trace",
      trace: [{ id: "trace1" }],
    }),
  );
});
