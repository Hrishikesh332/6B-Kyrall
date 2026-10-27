import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EvidencePanel, {
  SourceCard,
  DecisionCard,
  ToolRecord,
} from "./EvidencePanel.jsx";

vi.mock("@formkit/auto-animate/react", () => ({
  useAutoAnimate: () => [() => {}],
}));
const source = {
  id: "source1",
  version: 2,
  name: "reference.json",
  url: "https://example.com/manual",
  fetched_at: 1720000000,
  pages: [46],
  document_sha256: "abc123",
  truncated: true,
};
const decision = {
  id: "decision1",
  title: "Mounting interface",
  basis: "source",
  summary: "A documented nominal dimension.",
  version: 1,
  stale: true,
  superseded: false,
  tradeoffs: ["Fit allowance is a design choice."],
  uncertainties: ["Confirm the hardware revision."],
  evidence: [{ id: "source1", name: "reference.json", version: 2 }],
};
const call = {
  id: "call1",
  run_id: "r1",
  name: "fetch_reference",
  phase: "research",
  status: "completed",
  duration_ms: 1250,
};
const response = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("execution evidence", () => {
  it("reads the saved source as text on demand without executing its content", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({
        text: "<script>untrusted reference</script>\nSaved evidence text",
      }),
    );
    render(
      <SourceCard source={source} taskId="task1" openArtifact={vi.fn()} />,
    );
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("Read saved extract"));
    const extract = await screen.findByRole("region", {
      name: "Saved source text",
    });
    expect(extract).toHaveTextContent("<script>untrusted reference</script>");
    expect(extract.querySelector("script")).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      "/api/tasks/task1/artifacts/source1/content",
      expect.anything(),
    );
  });
  it("opens the exact saved source and reports truncation and pages", async () => {
    const openArtifact = vi.fn();
    render(
      <SourceCard source={source} taskId="task1" openArtifact={openArtifact} />,
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", source.url);
    expect(screen.getByText(/Pages 46/)).toBeInTheDocument();
    expect(screen.getByText(/truncated/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /Open saved evidence/ }),
    );
    expect(openArtifact).toHaveBeenCalledWith("task1", "source1");
  });
  it("does not turn unsafe source URLs into executable links", () => {
    render(
      <SourceCard
        source={{ ...source, url: "javascript:alert(1)" }}
        taskId="t"
        openArtifact={vi.fn()}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("marks stale decisions and navigates to their precise evidence version", async () => {
    const openArtifact = vi.fn();
    render(
      <DecisionCard
        decision={decision}
        taskId="task1"
        openArtifact={openArtifact}
      />,
    );
    expect(screen.getByText(/earlier CAD build/)).toBeInTheDocument();
    expect(
      screen.getByText("Confirm the hardware revision."),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "reference.json · v2" }),
    );
    expect(openArtifact).toHaveBeenCalledWith("task1", "source1");
  });
  it("loads full tool arguments and results only when expanded", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({
        ...call,
        started_at: 1,
        finished_at: 2.25,
        arguments: { url: source.url },
        result: { pages: [46] },
      }),
    );
    const { container } = render(<ToolRecord taskId="task1" call={call} />);
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.click(container.querySelector("summary"));
    expect(await screen.findByText("Arguments")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/tasks/task1/tools/call1",
      expect.anything(),
    );
    expect(screen.getByText(/1.3 s/)).toBeInTheDocument();
    expect(screen.getByText("Arguments")).not.toBeVisible();
    await userEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("Arguments")).toBeVisible();
  });
  it("keeps failed completion checks visible and filters tools by run", async () => {
    const audit = {
      sources: [source],
      decisions: [decision],
      tools: [call, { ...call, id: "call2", run_id: "r2", name: "build_cad" }],
      checks: [
        {
          run_id: "r2",
          created_at: 2,
          payload: {
            title: "Delivery checks require repair",
            passed: false,
            attempt: 1,
            errors: ["Inspect the latest validation report"],
          },
        },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(response(audit)),
    );
    render(
      <EvidencePanel
        task={{
          id: "task1",
          last_event_id: 3,
          runs: [
            { id: "r1", status: "completed" },
            { id: "r2", status: "running" },
          ],
        }}
        openArtifact={vi.fn()}
      />,
    );
    expect(
      await screen.findByText("Inspect the latest validation report"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Read source")).toBeNull();
    await userEvent.selectOptions(
      screen.getByLabelText("Execution run"),
      "all",
    );
    expect(screen.getByText("Read source")).toBeInTheDocument();
  });
});
