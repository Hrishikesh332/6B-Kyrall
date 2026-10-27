// A bounding sphere keeps every orientation inside the viewport at reset zoom.
export function meshBounds(mesh) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const part of mesh.parts)
    for (const vertex of part.vertices) {
      if (vertex.length !== 3 || !vertex.every(Number.isFinite))
        throw Error("The model contains invalid geometry.");
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], vertex[axis]);
        max[axis] = Math.max(max[axis], vertex[axis]);
      }
    }
  if (!Number.isFinite(min[0]))
    throw Error("The model has no visible geometry.");
  const center = min.map((value, axis) => (value + max[axis]) / 2);
  let radius = 0;
  for (const part of mesh.parts)
    for (const vertex of part.vertices)
      radius = Math.max(
        radius,
        Math.hypot(...vertex.map((value, axis) => value - center[axis])),
      );
  return { center, span: Math.max(2 * radius, 1e-6) };
}
