import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MeshPreview } from "./ArtifactPreview.jsx";
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
      expect.objectContaining({ ghosted: ["base"], selected: "jaw" }),
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
    expect(screen.getByText(/not linked to this design/)).toBeInTheDocument();
    expect(screen.getByText("slip hold failed")).toBeInTheDocument();
  });
  it("explains a viewport capture Isaac could not render", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      url.endsWith("/snapshot")
        ? new Response(
            JSON.stringify({
              detail: "Isaac: Viewport capture did not complete",
            }),
            { status: 503 },
          )
        : new Response(
            JSON.stringify({
              configured: true,
              connected: true,
              state: { isaac_sim: "6.2.0", stopped: true },
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
    await user.click(await screen.findByText("Capture viewport"));
    expect(
      await screen.findByText("Isaac didn't return a frame"),
    ).toBeInTheDocument();
    expect(screen.getByText("Try again")).toBeInTheDocument();
  });
  it("offers Isaac export for a validated CAD script", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) =>
        url.endsWith("/simulation-export")
          ? new Response(
              JSON.stringify({ scene: { id: "s1" }, manifest: { id: "m1" } }),
              { status: 201 },
            )
          : new Response(JSON.stringify({ configured: false })),
      );
    const openArtifact = vi.fn();
    render(
      <SimulationPanel
        task={{
          id: "t1",
          artifacts: [
            {
              id: "c1",
              name: "gripper.cad.py",
              version: 2,
              created_at: 2,
              metadata: { kind: "cad_script", validation_passed: true },
            },
          ],
        }}
        refresh={vi.fn()}
        openArtifact={openArtifact}
      />,
    );
    await user.click(await screen.findByText("Export scene"));
    await user.click(await screen.findByText("USD scene"));
    expect(openArtifact).toHaveBeenCalledWith("t1", "s1");
    const request = fetchMock.mock.calls.find(([url]) =>
      url.endsWith("/simulation-export"),
    );
    expect(JSON.parse(request[1].body)).toEqual({ source_artifact_id: "c1" });
  });
});
