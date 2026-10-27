import { describe, expect, it } from "vitest";
import { meshBounds } from "./meshBounds.js";

describe("camera framing", () => {
  it("keeps an elongated diagonal model within the frame through a full orbit", () => {
    const vertices = [
      [0, 0, 0],
      [100, 80, 90],
      [30, 0, 10],
    ];
    const { center, span } = meshBounds({ parts: [{ vertices }] });
    for (let yaw = 0; yaw < Math.PI * 2; yaw += 0.2)
      for (let pitch = -Math.PI / 2; pitch < Math.PI / 2; pitch += 0.2)
        for (const vertex of vertices) {
          const [x, z, y] = vertex.map(
            (value, axis) => (value - center[axis]) / span,
          );
          const projectedX = Math.cos(yaw) * x + Math.sin(yaw) * z;
          const depth = -Math.sin(yaw) * x + Math.cos(yaw) * z;
          const projectedY = Math.cos(pitch) * y - Math.sin(pitch) * depth;
          expect(Math.abs(projectedX * 1.7)).toBeLessThanOrEqual(0.85 + 1e-10);
          expect(Math.abs(projectedY * 1.7)).toBeLessThanOrEqual(0.85 + 1e-10);
        }
  });
  it("fits very small meshes and includes every part", () => {
    expect(
      meshBounds({
        parts: [{ vertices: [[0, 0, 0]] }, { vertices: [[0.002, 0, 0]] }],
      }),
    ).toEqual({ center: [0.001, 0, 0], span: 0.002 });
  });
  it("rejects missing and nonfinite geometry before preparing the camera", () => {
    expect(() => meshBounds({ parts: [] })).toThrow("no visible geometry");
    expect(() => meshBounds({ parts: [{ vertices: [[NaN, 0, 0]] }] })).toThrow(
      "invalid geometry",
    );
  });
});
