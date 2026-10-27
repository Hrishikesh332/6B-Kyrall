import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const viewers = vi.hoisted(() => []);
vi.mock("../viewer.js", () => ({
  mountViewer: (canvas, mesh, options) => {
    const viewer = {
      options,
      update: vi.fn(),
      setCamera: vi.fn(),
      destroy: vi.fn(),
    };
    viewers.push(viewer);
    return viewer;
  },
}));
import VersionCompare from "./VersionCompare.jsx";

const box = (name) => ({
  name,
  vertices: [
    [0, 0, 0],
    [10, 10, 10],
    [10, 0, 0],
  ],
  faces: [[0, 1, 2]],
});
const artifacts = ["b1", "b2"].map((b, i) => ({
  id: `m${i}`,
  metadata: { kind: "mesh_preview", build_id: b },
}));
const report = {
  summary: [
    "1 part changed",
    "lid: size 70 × 40 × 5 → 70 × 40 × 8 mm",
    "Parameters: lid_height 5 → 8",
  ],
  parts: [
    {
      part: "base",
      status: "unchanged",
      volume_delta_percent: 0,
      size_mm: [
        [70, 40, 20],
        [70, 40, 20],
      ],
      size_delta_mm: [0, 0, 0],
      moved_mm: [0, 0, 0],
    },
    {
      part: "lid",
      status: "changed",
      volume_delta_percent: 60,
      size_mm: [
        [70, 40, 5],
        [70, 40, 8],
      ],
      size_delta_mm: [0, 0, 3],
      moved_mm: [0, 0, 1.5],
    },
  ],
  parameters: [{ name: "lid_height", old: 5, new: 8 }],
  checks: {
    before: {
      passed: true,
      printability: "ok",
      interferences: 0,
      assembly_bounds_mm: [70, 40, 26],
    },
    after: {
      passed: true,
      printability: "review",
      interferences: 0,
      assembly_bounds_mm: [70, 40, 29],
    },
  },
  source_diff: {
    added_lines: 1,
    removed_lines: 1,
    text: "@@ -9 +9 @@\n-lid_height = 5\n+lid_height = 8",
  },
  note: "Measured differences.",
};

describe("version compare", () => {
  it("loads both builds, mirrors the camera and reports the changes", async () => {
    const user = userEvent.setup(),
      onClose = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const json = (data) => new Response(JSON.stringify(data));
      if (url.endsWith("/builds"))
        return json([
          { build_id: "b1", version: 1, origin: "assistant" },
          { build_id: "b2", version: 2, origin: "parameter_rebuild" },
        ]);
      if (url.includes("/artifacts/"))
        return json({ parts: [box("base"), box("lid")] });
      if (url.includes("/compare?from_build=b1&to_build=b2"))
        return json(report);
      return new Response("{}", { status: 404 });
    });
    render(
      <VersionCompare
        taskId="t1"
        artifacts={artifacts}
        currentBuild="b2"
        onClose={onClose}
      />,
    );
    expect(await screen.findByText("1 part changed")).toBeVisible();
    expect(screen.getByLabelText("Earlier version")).toHaveValue("b1");
    expect(
      screen.getByText("v2 · Slider rebuild", { selector: "figcaption span" }),
    ).toBeVisible();
    await waitFor(() => expect(viewers).toHaveLength(2));
    const [before, after] = viewers;
    expect(before.options.sharedFrame).toEqual(after.options.sharedFrame);
    before.options.onCamera(
      { yaw: 1, pitch: 0.2, zoom: 1.5, target: [0, 0, 0] },
      before,
    );
    expect(after.setCamera).toHaveBeenCalledWith({
      yaw: 1,
      pitch: 0.2,
      zoom: 1.5,
      target: [0, 0, 0],
    });
    expect(before.setCamera).not.toHaveBeenCalled();
    expect(after.update).toHaveBeenLastCalledWith({
      ghosted: ["base"],
      highlight: "",
    });
    await user.hover(screen.getByRole("row", { name: /lid changed/ }));
    expect(after.update).toHaveBeenLastCalledWith({
      ghosted: ["base"],
      highlight: "lid",
    });
    await user.click(
      screen.getByRole("checkbox", { name: "Dim unchanged parts" }),
    );
    expect(after.update).toHaveBeenLastCalledWith({
      ghosted: [],
      highlight: "",
    });
    expect(
      screen.getByRole("row", { name: /Print check ok review/ }),
    ).toHaveClass("differs");
    expect(screen.getByText("+1 −1 lines")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Overlay" }));
    const overlay = viewers.at(-1);
    expect(overlay.update).toHaveBeenLastCalledWith({
      ghosted: ["before · base", "before · lid"],
      highlight: "",
    });
    expect(screen.getByText("After, with Before shown faintly")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });
});
