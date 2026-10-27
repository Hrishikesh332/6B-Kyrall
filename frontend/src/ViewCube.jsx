import { forwardRef, useRef } from "react";

const FACES = [
  ["front", "Front"],
  ["back", "Back"],
  ["right", "Right"],
  ["left", "Left"],
  ["top", "Top"],
  ["bottom", "Bottom"],
];

// A CSS 3D cube the viewer re-orients every frame (through the forwarded ref)
// to mirror the camera. Clicking a face snaps to that view; dragging the cube
// orbits the camera, which also brings hidden faces round to click.
const ViewCube = forwardRef(function ViewCube({ view, onView, onOrbit }, ref) {
  const drag = useRef(null);
  return (
    <div
      className="view-cube"
      role="group"
      aria-label="Standard views. Drag to orbit."
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        drag.current = { x: e.clientX, y: e.clientY, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x,
          dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 3) return;
        if (!d.moved) {
          // Capture only once it is a drag, so plain clicks still reach a face.
          d.moved = true;
          e.currentTarget.setPointerCapture(e.pointerId);
        }
        onOrbit?.(dx, dy);
        d.x = e.clientX;
        d.y = e.clientY;
      }}
      onPointerUp={() => {
        // Keep the flag until the click that follows a drag has been ignored.
        setTimeout(() => (drag.current = null));
      }}
      onPointerCancel={() => (drag.current = null)}
    >
      <div className="view-cube-body" ref={ref}>
        {FACES.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`view-cube-face face-${id}`}
            aria-pressed={view === id}
            onClick={() => {
              if (!drag.current?.moved) onView(id);
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
});
export default ViewCube;
