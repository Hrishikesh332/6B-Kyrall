import { describe, it, expect } from "vitest";
import { poseMatrix, sampleStudy } from "./motion.js";
const apply = (m, p) =>
  [0, 1, 2].map(
    (i) => m[i] * p[0] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[12 + i],
  );
describe("assembly motion matches CAD coordinate conventions", () => {
  it("rotates around the world pivot before translating", () => {
    const result = apply(
      poseMatrix({
        rotation: [0, 0, 90],
        pivot: [10, 0, 0],
        translation: [0, 5, 0],
      }),
      [20, 0, 0],
    );
    [10, 15, 0].forEach((v, i) => expect(result[i]).toBeCloseTo(v));
  });
  it("uses X then Y then Z Euler rotations", () => {
    const result = apply(poseMatrix({ rotation: [90, 90, 0] }), [0, 1, 0]);
    [1, 0, 0].forEach((v, i) => expect(result[i]).toBeCloseTo(v));
  });
  it("interpolates study poses and keeps absent parts fixed", () => {
    const study = {
      states: [
        { name: "open", poses: [] },
        { name: "closed", poses: [{ part: "jaw", translation: [10, 0, 0] }] },
      ],
      transitions: [{ start: "open", end: "closed" }],
    };
    expect(sampleStudy(study, 0.5).poses.jaw.translation).toEqual([5, 0, 0]);
    expect(sampleStudy(study, 1).poses.jaw.translation).toEqual([10, 0, 0]);
    expect(sampleStudy(study, 0.5).poses.base).toBeUndefined();
  });
});
