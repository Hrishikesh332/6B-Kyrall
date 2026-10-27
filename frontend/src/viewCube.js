// Camera orientation shared by the WebGL viewer and its CSS view cube.
// Camera presets match the backend's projected SVG views: front looks along +Y,
// side looks from +X, and isometric sits front-right and above.
export const VIEWS = {
  iso: [Math.PI / 4, 0.5],
  front: [0, 0],
  back: [Math.PI, 0],
  right: [Math.PI / 2, 0],
  side: [Math.PI / 2, 0],
  left: [-Math.PI / 2, 0],
  top: [0, Math.PI / 2],
  bottom: [0, -Math.PI / 2],
};

// World (x, y, z-up) to view space (x right, y up, z toward the viewer).
export function viewBasis(yaw, pitch) {
  const c = Math.cos(yaw),
    s = Math.sin(yaw),
    a = Math.cos(pitch),
    b = Math.sin(pitch);
  return (w) => {
    const z1 = s * w[0] - c * w[1];
    return [c * w[0] + s * w[1], a * w[2] - b * z1, b * w[2] + a * z1];
  };
}

// CSS matrix3d that orients a view cube whose front face looks along +Y.
export function cubeTransform(yaw, pitch) {
  const toView = viewBasis(yaw, pitch);
  // Cube-local axes: x right, y down, z out of the front face (world -Y).
  const columns = [
    [1, 0, 0],
    [0, 0, -1],
    [0, -1, 0],
  ].map((world) => {
    const [x, y, z] = toView(world);
    return [x, -y, z];
  });
  return `matrix3d(${[...columns.flatMap((c) => [...c, 0]), 0, 0, 0, 1]
    .map((v) => +v.toFixed(5))
    .join(",")})`;
}
