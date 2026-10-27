import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MeshPreview } from "./ArtifactPreview.jsx";
import ObjectCapture from "./ObjectCapture.jsx";
import SimulationPanel from "./SimulationPanel.jsx";
const viewer = vi.hoisted(() => ({
  update: vi.fn(),
  view: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("../viewer.js", () => ({ mountViewer: () => viewer }));
vi.mock("@formkit/auto-animate/react", () => ({
  useAutoAnimate: () => [() => {}],
}));
const mesh = {
  parts: [
    { name: "base", vertices: [], faces: [] },
    { name: "jaw", vertices: [], faces: [] },
  ],
};
const study = {
  id: "m1",
  name: "grip_cycle",
  states: [
    { name: "open", poses: [] },
    { name: "closed", poses: [{ part: "jaw", translation: [10, 0, 0] }] },
  ],
  transitions: [{ start: "open", end: "closed" }],
};

describe("engineering controls", () => {
  it("explodes, isolates, restores and scrubs actual study poses", async () => {
    const user = userEvent.setup();
    render(<MeshPreview mesh={mesh} studies={[study]} name="assembly.step" />);
    fireEvent.change(screen.getByRole("slider", { name: "Explode assembly" }), {
      target: { value: "0.5" },
    });
    expect(viewer.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ explode: 0.5 }),
    );
    await user.selectOptions(
      screen.getByLabelText("Displayed geometry"),
      "jaw",
    );
    expect(viewer.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ hidden: ["base"] }),
    );
    await user.click(screen.getByText("Reset view"));
    await user.selectOptions(screen.getByLabelText("Presentation mode"), "m1");
    fireEvent.change(screen.getByLabelText("Motion timeline"), {
      target: { value: "0.5" },
    });
    expect(viewer.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        explode: 0,
        hidden: [],
        poses: {
          jaw: {
            translation: [5, 0, 0],
            rotation: [0, 0, 0],
            pivot: [0, 0, 0],
          },
        },
      }),
    );
    expect(
      screen.getByText(/contact, forces and grasp success/),
    ).toBeInTheDocument();
  });
  it("requires scale before queueing an image design and preserves a queued request for retries", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: () => "blob:test",
      revokeObjectURL: vi.fn(),
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        if (url.endsWith("/image-sets"))
          return new Response(JSON.stringify({ id: "capture1" }), {
            status: 201,
          });
        if (url.endsWith("/messages"))
          return new Response("{}", { status: 202 });
        return new Response("image");
      });
    const photo = {
      id: "p1",
      name: "front.png",
      version: 1,
      metadata: { kind: "reference_image" },
    };
    render(
      <ObjectCapture
        task={{ id: "t1", status: "completed", artifacts: [photo] }}
        cap={{ provider: "claude" }}
        refresh={vi.fn()}
        notify={vi.fn()}
      />,
    );
    await user.selectOptions(
      screen.getByLabelText("Use an attached photo"),
      "p1",
    );
    await user.type(screen.getByLabelText("Object name"), "Housing");
    await user.type(
      screen.getByLabelText("What was measured?"),
      "Outside width",
    );
    await user.click(screen.getByText("Generate object CAD"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "at least one measured dimension",
    );
    expect(
      fetchMock.mock.calls.some(([url]) => url.endsWith("/messages")),
    ).toBe(false);
    await user.type(screen.getByLabelText("Width X (mm)"), "40");
    await user.click(screen.getByText("Generate object CAD"));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => url.endsWith("/messages")),
      ).toBe(true),
    );
    const request = fetchMock.mock.calls.find(([url]) =>
      url.endsWith("/image-sets"),
    );
    expect(JSON.parse(request[1].body)).toMatchObject({
      width_mm: 40,
      depth_mm: null,
      views: [{ artifact_id: "p1", angle: "front" }],
    });
  });
  it("shows failed Isaac evidence without applying it to the open design", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          configured: true,
          connected: true,
          observed_at: 1,
          state: {
            isaac_sim: "6.2.0",
            stopped: true,
            simulation_time_s: 2,
            scene_sha256: "abc",
            last_task: {
              result: {
                simulation_pass: false,
                errors: ["slip_hold_failed"],
                maximum_valid_hold_s: 0,
                scope: "simulation",
              },
            },
          },
        }),
      ),
    );
    render(
      <SimulationPanel
        task={{ id: "t1", artifacts: [] }}
        refresh={vi.fn()}
        openArtifact={vi.fn()}
      />,
    );
    expect(
      await screen.findByText("Last scene test · did not pass"),
    ).toBeInTheDocument();
    expect(screen.getByText("Not linked")).toBeInTheDocument();
    expect(screen.getByText("slip hold failed")).toBeInTheDocument();
  });
});
