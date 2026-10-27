import { describe, expect, it } from "vitest";
import { suggestChanges } from "./AssemblyStudio.jsx";

const bounds = { size: [200, 29, 52], triangles: 3436 };

describe("suggestChanges", () => {
  it("leads with print-check findings and explains each one", () => {
    const part = {
      part: "rack",
      volume_mm3: 90000,
      printability: {
        status: "review",
        min_wall_mm: 0.9,
        overhang_percent: 12,
        thresholds: { min_wall_mm: 1.2 },
        issues: [{ check: "thin_walls" }, { check: "overhang" }],
      },
    };
    const out = suggestChanges({ name: "rack", bounds, part });
    expect(out[0]).toEqual({
      text: "Thicken walls to at least 1.2 mm",
      reason: "Minimum wall 0.9 mm",
      source: "Print check",
    });
    expect(out[1].reason).toBe("12% of the surface overhangs");
    expect(out.length).toBeLessThanOrEqual(4);
  });

  it("uses overlaps, mates and proportions when nothing failed", () => {
    const overlap = suggestChanges({
      name: "jaw",
      bounds,
      partCount: 2,
      interferences: [{ parts: ["base", "jaw"], overlap_mm3: 3.21 }],
    });
    expect(overlap[0].text).toBe("Remove the overlap with base");
    const clean = suggestChanges({ name: "jaw", bounds, partCount: 3 });
    expect(clean.map((s) => s.source)).toEqual([
      "Assembly",
      "Shape",
      "General",
    ]);
    expect(clean[1].text).toBe("Add stiffening ribs along the 200 mm length");
  });
});
