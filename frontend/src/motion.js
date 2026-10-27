// Matches motion_worker: world deltas, fixed pivot, Rx then Ry then Rz.
export function poseMatrix(pose = {}, offset = [0, 0, 0]) {
  const [x, y, z] = (pose.rotation || [0, 0, 0]).map(
    (a) => (a * Math.PI) / 180,
  );
  const [cx, cy, cz] = [Math.cos(x), Math.cos(y), Math.cos(z)];
  const [sx, sy, sz] = [Math.sin(x), Math.sin(y), Math.sin(z)];
  const r = [
    cy * cz,
    cy * sz,
    -sy,
    sx * sy * cz - cx * sz,
    sx * sy * sz + cx * cz,
    sx * cy,
    cx * sy * cz + sx * sz,
    cx * sy * sz - sx * cz,
    cx * cy,
  ];
  const p = pose.pivot || [0, 0, 0],
    t = pose.translation || [0, 0, 0];
  const d = p.map(
    (v, i) =>
      v + t[i] + offset[i] - r[i] * p[0] - r[3 + i] * p[1] - r[6 + i] * p[2],
  );
  return new Float32Array([
    r[0],
    r[1],
    r[2],
    0,
    r[3],
    r[4],
    r[5],
    0,
    r[6],
    r[7],
    r[8],
    0,
    ...d,
    1,
  ]);
}

export function sampleStudy(study, progress) {
  if (!study?.transitions?.length) return { poses: {}, label: "Assembled" };
  const scaled = Math.min(1, Math.max(0, progress)) * study.transitions.length;
  const index = Math.min(Math.floor(scaled), study.transitions.length - 1),
    alpha = scaled - index;
  const transition = study.transitions[index];
  const start = study.states.find((s) => s.name === transition.start),
    end = study.states.find((s) => s.name === transition.end);
  const poses = {};
  const names = new Set(
    [...(start?.poses || []), ...(end?.poses || [])].map((p) => p.part),
  );
  for (const part of names) {
    const a = start?.poses.find((p) => p.part === part) || {},
      b = end?.poses.find((p) => p.part === part) || {};
    const mix = (key) =>
      (a[key] || [0, 0, 0]).map(
        (v, i) => v + ((b[key] || [0, 0, 0])[i] - v) * alpha,
      );
    poses[part] = {
      translation: mix("translation"),
      rotation: mix("rotation"),
      pivot: a.pivot || [0, 0, 0],
    };
  }
  return {
    poses,
    label: `${transition.start.replaceAll("_", " ")} → ${transition.end.replaceAll("_", " ")}`,
  };
}
