// Presentation-only assembly sequencing. Offsets are world millimetres added to
// the saved assembly pose; nothing here changes geometry or validation.

export function partBounds(mesh) {
  const bounds = {};
  for (const part of mesh.parts) {
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (const v of part.vertices)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], v[k]);
        max[k] = Math.max(max[k], v[k]);
      }
    if (!part.vertices.length) (min.fill(0), max.fill(0));
    const size = max.map((v, k) => Math.max(0, v - min[k]));
    bounds[part.name] = {
      min,
      max,
      size,
      center: min.map((v, k) => (v + max[k]) / 2),
      radius: Math.hypot(...size) / 2,
      volume: size.reduce((a, b) => a * Math.max(b, 1e-3), 1),
      triangles: part.faces.length,
    };
  }
  return bounds;
}

// The part with the largest footprint (Z is up) is the base, lowest first on
// ties; the rest follow nearest-first, so each lands against a placed part.
export function assemblyOrder(mesh, bounds = partBounds(mesh)) {
  const names = mesh.parts.map((p) => p.name);
  if (names.length < 2) return names;
  const footprint = (n) => bounds[n].size[0] * bounds[n].size[1];
  const base = names.reduce((a, b) =>
    footprint(b) > footprint(a) * 1.05 ||
    (footprint(b) > footprint(a) / 1.05 && bounds[b].min[2] < bounds[a].min[2])
      ? b
      : a,
  );
  const placed = [base],
    remaining = names.filter((n) => n !== base);
  while (remaining.length) {
    let best = 0,
      bestDistance = Infinity;
    remaining.forEach((name, i) => {
      const d = Math.min(
        ...placed.map((p) =>
          Math.hypot(
            ...bounds[name].center.map((v, k) => v - bounds[p].center[k]),
          ),
        ),
      );
      if (d < bestDistance - 1e-9) [best, bestDistance] = [i, d];
    });
    placed.push(remaining.splice(best, 1)[0]);
  }
  return placed;
}

// Each part arrives along the line from the parts already seated, or from
// above (+Z, the assembly's up axis) when it sits on that centre.
export function approachDirections(order, bounds) {
  const directions = {};
  order.forEach((name, i) => {
    const before = order.slice(0, i);
    const anchor = before.length
      ? [0, 1, 2].map(
          (k) =>
            before.reduce((s, n) => s + bounds[n].center[k], 0) / before.length,
        )
      : bounds[name].center;
    const d = bounds[name].center.map((v, k) => v - anchor[k]);
    const length = Math.hypot(...d);
    const unit =
      length > bounds[name].radius * 0.25
        ? d.map((v) => v / length)
        : [0, 0, 1];
    // Bias upward so parts read as being lowered into place.
    const lifted = [unit[0], unit[1], unit[2] + 0.6],
      l = Math.hypot(...lifted);
    directions[name] = lifted.map((v) => v / l);
  });
  return directions;
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// progress 0 → nothing placed, 1 → fully assembled. Each step: a short reveal,
// eased travel, then a brief settle so the seated part can be read.
export function sampleAssembly(order, directions, span, progress) {
  const n = order.length,
    p = Math.min(1, Math.max(0, progress));
  if (!n) return { offsets: {}, upcoming: [], step: 0, active: "" };
  const scaled = p * n,
    step = Math.min(Math.floor(scaled), n - 1),
    local = p >= 1 ? 1 : scaled - step;
  const travel = ease(Math.min(1, Math.max(0, (local - 0.12) / 0.73)));
  const distance = span * 0.85,
    offsets = {};
  order.forEach((name, i) => {
    // Upcoming parts stay at their seated slot; the studio ghosts or hides them.
    const remaining = i === step ? 1 - travel : 0;
    offsets[name] = directions[name].map((v) => v * distance * remaining);
  });
  return {
    offsets,
    upcoming: order.slice(step + 1),
    step,
    active: order[step],
    seated: travel >= 1,
  };
}

export function stepProgress(index, count) {
  // Land at the end of a step so its part is shown seated.
  return count ? Math.min(1, (index + 1) / count) : 0;
}

export function moveStep(order, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= order.length) return order;
  const next = [...order];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function recordingFormat(Recorder = globalThis.MediaRecorder) {
  if (!Recorder?.isTypeSupported) return null;
  return (
    [
      ["video/webm;codecs=vp9", "webm"],
      ["video/webm;codecs=vp8", "webm"],
      ["video/webm", "webm"],
      ["video/mp4", "mp4"],
    ].find(([type]) => Recorder.isTypeSupported(type)) || null
  );
}
