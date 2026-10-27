import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const renderer = vi.hoisted(() => ({
  update: vi.fn(),
  view: vi.fn(),
  destroy: vi.fn(),
  focus: vi.fn(),
}));
vi.mock("../viewer.js", () => ({ mountViewer: () => renderer }));
import { MeshPreview } from "./ArtifactPreview.jsx";

const part = (name, status, extra = {}) => ({
  part: name,
  passed: true,
  watertight: true,
  printability: {
    status,
    overhang_percent: 0,
    min_wall_mm: 2,
    fits_print_bed: true,
    thresholds: { overhang_deg: 45, min_wall_mm: 1.2, min_feature_mm: 0.8 },
    issues: [],
    ...extra,
  },
});
const report = {
  passed: true,
  parts: [part("base", "ok"), part("lid", "review", { overhang_percent: 6.4 })],
  assembly_bounds_mm: [65, 45, 24],
  interferences: [],
  step_reimport_valid: true,
  printability: {
    status: "review",
    issues: [
      {
        part: "lid",
        severity: "review",
        check: "overhang",
        message: "120 mm² overhangs beyond 45° need support",
      },
    ],
  },
};
const mesh = {
  parts: [
    { name: "base", vertices: [], faces: [] },
    { name: "lid", vertices: [], faces: [] },
  ],
};

describe("print check", () => {
  it("toggles the overlay and lists per-part results", async () => {
    const user = userEvent.setup();
    render(<MeshPreview mesh={mesh} report={report} name="box.cad.py" />);
    await user.click(screen.getByRole("button", { name: "Print check" }));
    expect(renderer.update).toHaveBeenCalledWith({ printCheck: true });
    expect(screen.getByText("Review before printing")).toBeVisible();
    expect(
      screen.getByRole("row", { name: /lid 6.4% 2 mm Fits/ }),
    ).toBeVisible();
    expect(screen.getByText(/120 mm² overhangs/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Print check" }));
    expect(renderer.update).toHaveBeenLastCalledWith({ printCheck: false });
    expect(screen.queryByText("Review before printing")).toBeNull();
  });
});
