import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MeshPreview } from "./ArtifactPreview.jsx";
import { cubeTransform } from "./viewCube.js";

const renderer = vi.hoisted(() => ({
  update: vi.fn(),
  view: vi.fn(),
  focus: vi.fn(),
  orbitBy: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("../viewer.js", () => ({ mountViewer: () => renderer }));
vi.mock("@formkit/auto-animate/react", () => ({
  useAutoAnimate: () => [() => {}],
}));
// jsdom has no PointerEvent; a MouseEvent subclass carries the coordinates.
globalThis.PointerEvent ??= class extends MouseEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
};
const mesh = {
  parts: [
    { name: "base", vertices: [], faces: [] },
    { name: "jaw", vertices: [], faces: [] },
  ],
};

it("peels Escape back one layer before letting it close the studio", async () => {
  const user = userEvent.setup(),
    outer = vi.fn();
  render(
    <div onKeyDown={(e) => e.key === "Escape" && outer()}>
      <MeshPreview mesh={mesh} name="assembly.step" />
    </div>,
  );
  await user.click(screen.getByText("Parts · 2"));
  await user.click(screen.getByRole("button", { name: "jaw" }));
  expect(
    screen.getByRole("region", { name: "Selected component" }),
  ).toBeVisible();
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("region", { name: "Selected component" }),
  ).toBeNull();
  expect(screen.getByRole("checkbox", { name: "jaw" })).toBeVisible();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("checkbox", { name: "jaw" })).toBeNull();
  expect(outer).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(outer).toHaveBeenCalledOnce();
});

it("orbits when the view cube is dragged and snaps only on a plain click", () => {
  render(<MeshPreview mesh={mesh} name="assembly.step" />);
  const cube = screen.getByRole("group", { name: /Standard views/ });
  const front = screen.getByRole("button", { name: "Front", exact: true });
  front.setPointerCapture = cube.setPointerCapture = vi.fn();
  fireEvent.pointerDown(front, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(front, { clientX: 30, clientY: 14 });
  fireEvent.pointerUp(front);
  fireEvent.click(front);
  expect(renderer.orbitBy).toHaveBeenCalledWith(20, 4);
  expect(renderer.view).not.toHaveBeenCalledWith("front");
});

it("orients the cube to face the camera", () => {
  // Front view leaves the cube untransformed.
  expect(cubeTransform(0, 0)).toBe("matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)");
  // From the right, the cube's +X face (local column one) points at the viewer.
  expect(cubeTransform(Math.PI / 2, 0)).toMatch(/^matrix3d\(0,0,1,0,/);
});
