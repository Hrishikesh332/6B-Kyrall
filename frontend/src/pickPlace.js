// Pick-and-place cycle for a gripper assembly. The agent's motion study drives
// the mechanism (open → hold); the whole gripper is carried around it. Checks
// are geometric, on the preview mesh: contact, release clearance and table
// clearance. Grip force, friction and suction are not simulated.
import { poseMatrix } from "./motion.js";

const ZERO = [0, 0, 0];
export const TEST_BLOCK = "test_block";
export const STATIONS = ["pick_station", "place_station"];

const tokens = (name) => name.toLowerCase().split(/[^a-z0-9]+/);
const has = (name, words) =>
  tokens(name).some((t) => words.some((w) => t === w || t === `${w}s`));

const WORK = [
  "workpiece",
  "object",
  "payload",
  "target",
  "item",
  "tomato",
  "fruit",
  "apple",
  "plate",
  "sheet",
  "cylinder",
  "bottle",
  "can",
  "ball",
  "sphere",
  "egg",
  "box",
  "block",
  "cube",
  "sample",
  "specimen",
  "product",
  "package",
  "parcel",
  "jar",
  "glass",
  "mug",
  "tube",
  "vial",
];
const TOOL = [
  "mount",
  "flange",
  "hub",
  "base",
  "jaw",
  "finger",
  "pad",
  "cup",
  "rod",
  "spring",
  "pin",
  "cap",
  "carriage",
  "plunger",
  "collar",
  "pawl",
  "post",
  "bracket",
  "link",
  "arm",
  "gear",
  "screw",
  "bolt",
  "nut",
  "bearing",
  "housing",
  "body",
  "frame",
  "guide",
  "rail",
  "shaft",
  "vent",
  "seal",
  "valve",
  "tab",
  "lever",
  "cam",
  "gripper",
  "adapter",
  "motor",
  "servo",
  "actuator",
  "piston",
  "bellows",
  "suction",
  "clamp",
  "holder",
  "palm",
  "tip",
  "wrist",
];
const CONTACT = ["pad", "jaw", "finger", "claw", "tip", "cup", "gripper"];

// Earlier patterns win: a transport/latched state is the hold, not the
// momentary overtravel at the end of the closing stroke.
const OPEN = [/open/, /releas/, /rest|home|idle|free|touch|approach|start/];
const HOLD = [
  /transport|carry/,
  /hold|latch|lock/,
  /grip|grasp|clamp|pinch/,
  /clos/,
  /compress|stroke|engag|actuat/,
];
const rank = (name, patterns) => {
  const i = patterns.findIndex((p) => p.test(name.toLowerCase()));
  return i < 0 ? Infinity : i;
};

export function bestStates(study) {
  const names = study?.states?.map((s) => s.name) || [];
  if (names.length < 2) return { open: names[0] || "", hold: names[0] || "" };
  const pick = (patterns, skip) =>
    names
      .filter((n) => n !== skip)
      .reduce((a, b) => (rank(b, patterns) < rank(a, patterns) ? b : a));
  const open = pick(OPEN, "");
  const hold = pick(HOLD, open);
  return { open, hold };
}

// The study that best names an open and a holding state.
export function chooseStudy(studies) {
  const score = (s) => {
    const { open, hold } = bestStates(s);
    return Math.min(rank(open, OPEN), 9) + Math.min(rank(hold, HOLD), 9);
  };
  return studies.reduce((a, b) => (score(b) < score(a) ? b : a), studies[0]);
}

// Shortest chain of declared transitions, so a push-to-close stroke plays
// through its intermediate states.
export function statePath(study, from, to) {
  if (!study || from === to) return [from];
  const next = {};
  for (const { start, end } of study.transitions || []) {
    (next[start] ||= []).push(end);
    (next[end] ||= []).push(start);
  }
  const back = { [from]: null },
    queue = [from];
  while (queue.length) {
    const at = queue.shift();
    if (at === to) break;
    for (const n of next[at] || [])
      if (!(n in back)) {
        back[n] = at;
        queue.push(n);
      }
  }
  if (!(to in back)) return [from, to];
  const path = [];
  for (let at = to; at !== null; at = back[at]) path.unshift(at);
  return path;
}

export function poseIn(study, state, part) {
  const pose = study?.states
    ?.find((s) => s.name === state)
    ?.poses.find((p) => p.part === part);
  return {
    translation: pose?.translation || ZERO,
    rotation: pose?.rotation || ZERO,
    pivot: pose?.pivot || ZERO,
  };
}

function boxOf(points) {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], points[i + k]);
      hi[k] = Math.max(hi[k], points[i + k]);
    }
  return { lo, hi };
}

export function posed(part, pose = {}) {
  const m = poseMatrix(pose),
    pts = new Float64Array(part.vertices.length * 3);
  part.vertices.forEach(([x, y, z], i) => {
    for (let k = 0; k < 3; k++)
      pts[i * 3 + k] = m[k] * x + m[4 + k] * y + m[8 + k] * z + m[12 + k];
  });
  return { name: part.name, pts, faces: part.faces, ...boxOf(pts) };
}

export function boxPart(name, lo, hi) {
  const vertices = [];
  for (let i = 0; i < 8; i++)
    vertices.push([
      i & 1 ? hi[0] : lo[0],
      i & 2 ? hi[1] : lo[1],
      i & 4 ? hi[2] : lo[2],
    ]);
  const faces = [
    [0, 2, 1],
    [1, 2, 3],
    [4, 5, 6],
    [5, 7, 6],
    [0, 1, 4],
    [1, 5, 4],
    [2, 6, 3],
    [3, 6, 7],
    [0, 4, 2],
    [2, 4, 6],
    [1, 3, 5],
    [3, 7, 5],
  ];
  return { name, vertices, faces };
}

export function detectWorkpiece(mesh) {
  const parts = mesh.parts.filter((p) => p.vertices.length);
  const low = (p) => Math.min(...p.vertices.map((v) => v[2]));
  const lowest = parts.reduce((a, b) => (low(b) < low(a) ? b : a), parts[0]);
  const candidates = parts.filter(
    (p) =>
      !has(p.name, TOOL) &&
      (has(p.name, WORK) || (p === lowest && /_ref(erence)?$/.test(p.name))),
  );
  if (!candidates.length) return "";
  return candidates.reduce((a, b) => (low(b) < low(a) ? b : a)).name;
}

// When the assembly has no object, size a block to the closed grip: centred
// between the contact tips, touching the innermost face on each opposed side.
export function testBlock(mesh, study, hold) {
  const all = mesh.parts.filter((p) => p.vertices.length);
  if (!all.length) return boxPart(TEST_BLOCK, [-5, -5, -5], [5, 5, 5]);
  const named = all.filter((p) => has(p.name, CONTACT));
  const tips = (named.length ? named : all).map((p) =>
    posed(p, poseIn(study, hold, p.name)),
  );
  const { lo, hi } = boxOf(tips.flatMap((t) => [...t.pts]));
  const reach = hi[2] - lo[2] || 1;
  const centre = [0, 1].map((k) => (lo[k] + hi[k]) / 2);
  const quarter = [0, 1].map((k) => (hi[k] - lo[k]) * 0.25 || 5);
  // Below the tips, and never up through a non-contact part over the centre.
  let top = lo[2] + reach * 0.3;
  for (const p of all) {
    if (tips.some((t) => t.name === p.name)) continue;
    const b = posed(p, poseIn(study, hold, p.name));
    const over = [0, 1].every(
      (k) =>
        b.lo[k] < centre[k] + quarter[k] && b.hi[k] > centre[k] - quarter[k],
    );
    if (over && b.lo[2] > lo[2]) top = Math.min(top, b.lo[2]);
  }
  // Tip vertices in the block's height band, plus where tip edges cross its
  // top, so slanted jaws are measured at the height they would touch.
  const band = [];
  for (const t of tips) {
    for (let i = 0; i < t.pts.length / 3; i++) {
      const p = at(t, i);
      if (p[2] <= top) band.push(p);
    }
    for (const f of t.faces)
      for (let e = 0; e < 3; e++) {
        const a = at(t, f[e]),
          b = at(t, f[(e + 1) % 3]);
        if ((a[2] - top) * (b[2] - top) >= 0) continue;
        const u = (top - a[2]) / (b[2] - a[2]);
        band.push(a.map((v, k) => v + (b[k] - v) * u));
      }
  }
  const min = [0, 0, lo[2] - Math.max(2, reach * 0.04)],
    max = [0, 0, top];
  for (const k of [0, 1]) {
    const other = 1 - k;
    let plus = Infinity,
      minus = Infinity;
    for (const p of band) {
      const d = p[k] - centre[k];
      if (Math.abs(d) < Math.abs(p[other] - centre[other])) continue;
      if (d > 0) plus = Math.min(plus, d);
      else if (d < 0) minus = Math.min(minus, -d);
    }
    const opposed = Number.isFinite(plus + minus) && plus + minus > 1;
    min[k] = centre[k] - (opposed ? minus : quarter[k]);
    max[k] = centre[k] + (opposed ? plus : quarter[k]);
  }
  return boxPart(TEST_BLOCK, min, max);
}

// ---- Distances between triangle meshes -----------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const at = (m, i) => [m.pts[i * 3], m.pts[i * 3 + 1], m.pts[i * 3 + 2]];

// Closest point on triangle (a, b, c) of the packed array P to point p,
// written to `out`; Ericson, Real-Time Collision Detection §5.1.5. Plain
// numbers only: this is the inner loop of every gap search.
function closestOnTriangle(p, P, ia, ib, ic, out) {
  const ax = P[ia * 3],
    ay = P[ia * 3 + 1],
    az = P[ia * 3 + 2];
  const abx = P[ib * 3] - ax,
    aby = P[ib * 3 + 1] - ay,
    abz = P[ib * 3 + 2] - az;
  const acx = P[ic * 3] - ax,
    acy = P[ic * 3 + 1] - ay,
    acz = P[ic * 3 + 2] - az;
  const apx = p[0] - ax,
    apy = p[1] - ay,
    apz = p[2] - az;
  const set = (v, w) => {
    out[0] = ax + abx * v + acx * w;
    out[1] = ay + aby * v + acy * w;
    out[2] = az + abz * v + acz * w;
  };
  const d1 = abx * apx + aby * apy + abz * apz,
    d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return set(0, 0);
  const bpx = apx - abx,
    bpy = apy - aby,
    bpz = apz - abz;
  const d3 = abx * bpx + aby * bpy + abz * bpz,
    d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return set(d1 / (d1 - d3), 0);
  const cpx = apx - acx,
    cpy = apy - acy,
    cpz = apz - acz;
  const d5 = abx * cpx + aby * cpy + abz * cpz,
    d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return set(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return set(1 - w, w);
  }
  const denom = 1 / (va + vb + vc);
  return set(vb * denom, vc * denom);
}

// Distance from point (x, y, z) to the box at offset i of a packed lo/hi array.
function boxDistance(x, y, z, b, i = 0) {
  const dx = Math.max(b[i] - x, 0, x - b[i + 3]),
    dy = Math.max(b[i + 1] - y, 0, y - b[i + 4]),
    dz = Math.max(b[i + 2] - z, 0, z - b[i + 5]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
const packed = (m) => [...m.lo, ...m.hi];
const boxGap = (a, b) =>
  Math.hypot(
    ...[0, 1, 2].map((k) => Math.max(a.lo[k] - b.hi[k], 0, b.lo[k] - a.hi[k])),
  );

function faceBoxes(m) {
  if (m.boxes) return m.boxes;
  const boxes = new Float64Array(m.faces.length * 6),
    p = m.pts;
  m.faces.forEach((f, j) => {
    for (let k = 0; k < 3; k++) {
      const a = p[f[0] * 3 + k],
        b = p[f[1] * 3 + k],
        c = p[f[2] * 3 + k];
      boxes[j * 6 + k] = Math.min(a, b, c);
      boxes[j * 6 + 3 + k] = Math.max(a, b, c);
    }
  });
  return (m.boxes = boxes);
}

// Height of face f's plane over (x, y), or NaN when (x, y) is outside it.
function heightOver(x, y, P, f, inset = 0) {
  const ax = P[f[0] * 3],
    ay = P[f[0] * 3 + 1],
    az = P[f[0] * 3 + 2];
  const bx = P[f[1] * 3] - ax,
    by = P[f[1] * 3 + 1] - ay,
    bz = P[f[1] * 3 + 2] - az;
  const cx = P[f[2] * 3] - ax,
    cy = P[f[2] * 3 + 1] - ay,
    cz = P[f[2] * 3 + 2] - az;
  const det = bx * cy - by * cx;
  if (Math.abs(det) < 1e-12) return NaN;
  const px = x - ax,
    py = y - ay;
  const u = (px * cy - py * cx) / det,
    v = (bx * py - by * px) / det;
  if (u < inset || v < inset || u + v > 1 - inset) return NaN;
  return az + bz * u + cz * v;
}

// Ray parity straight up; a tiny XY nudge keeps the ray off shared edges.
function contains(m, p) {
  const boxes = faceBoxes(m),
    x = p[0] + 1.37e-7,
    y = p[1] + 2.91e-7;
  let hits = 0;
  for (let j = 0; j < m.faces.length; j++) {
    const o = j * 6;
    if (
      x < boxes[o] ||
      x > boxes[o + 3] ||
      y < boxes[o + 1] ||
      y > boxes[o + 4] ||
      boxes[o + 5] < p[2]
    )
      continue;
    if (heightOver(x, y, m.pts, m.faces[j]) > p[2]) hits++;
  }
  return hits % 2 === 1;
}

// Vertices plus points along each edge at most `step` apart, so an edge
// lying across a face (a pad's rim on a block) is measured, not just corners.
function samples(m, step) {
  if (m.samples && m.samples.step === step) return m.samples.points;
  const points = [],
    seen = new Set();
  for (let i = 0; i < m.pts.length / 3; i++) points.push(at(m, i));
  if (Number.isFinite(step))
    for (const f of m.faces)
      for (let e = 0; e < 3; e++) {
        const i = Math.min(f[e], f[(e + 1) % 3]),
          j = Math.max(f[e], f[(e + 1) % 3]);
        if (seen.has(i * 1e7 + j)) continue;
        seen.add(i * 1e7 + j);
        const a = at(m, i),
          b = at(m, j),
          n = Math.floor(Math.hypot(...sub(b, a)) / step);
        for (let k = 1; k <= n; k++)
          points.push(a.map((v, c) => v + ((b[c] - v) * k) / (n + 1)));
      }
  m.samples = { step, points };
  return points;
}

// Sample points of `m` nearest the box `b`, closest first.
function nearest(m, b, within, step = Infinity) {
  const order = [];
  for (const p of samples(m, step)) {
    const d = boxDistance(p[0], p[1], p[2], b);
    if (d < within) order.push([p, d]);
  }
  return order.sort((x, y) => x[1] - y[1]);
}

function sweep(from, onto, best, step) {
  const boxes = faceBoxes(onto),
    q = new Float64Array(3);
  const faces = [];
  for (let j = 0; j < onto.faces.length; j++) {
    let d = 0;
    for (let k = 0; k < 3; k++) {
      const e = Math.max(
        boxes[j * 6 + k] - from.hi[k],
        0,
        from.lo[k] - boxes[j * 6 + 3 + k],
      );
      d += e * e;
    }
    if (Math.sqrt(d) < best.gap) faces.push(j);
  }
  for (const [p, d] of nearest(from, packed(onto), best.gap, step)) {
    if (d >= best.gap) break;
    if (d === 0 && contains(onto, p)) {
      Object.assign(best, { gap: 0, overlap: true, point: p });
      return;
    }
    for (const j of faces) {
      if (boxDistance(p[0], p[1], p[2], boxes, j * 6) >= best.gap) continue;
      const f = onto.faces[j];
      closestOnTriangle(p, onto.pts, f[0], f[1], f[2], q);
      const gap = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      if (gap < best.gap) Object.assign(best, { gap, point: [...q] });
    }
  }
}

// Smallest surface gap; 0 with overlap when one mesh pokes into the other.
// Beyond `limit` only the bounding-box gap (a lower bound) is reported.
export function meshGap(a, b, limit = Infinity, step = Infinity) {
  const coarse = boxGap(a, b);
  if (coarse > limit) return { gap: coarse, approximate: true };
  // Seed with the closest vertex pair among those facing each other, so the
  // exact search only visits the region where the parts meet.
  const near = (m, other) => nearest(m, packed(other), Infinity).slice(0, 40);
  let seed = { gap: Infinity, point: null };
  for (const [p] of near(a, b))
    for (const [q] of near(b, a)) {
      const gap = Math.hypot(...sub(p, q));
      if (gap < seed.gap) seed = { gap, point: q };
    }
  const best = { gap: seed.gap * (1 + 1e-9), overlap: false, point: null };
  sweep(a, b, best, step);
  if (best.gap > 0) sweep(b, a, best, step);
  return best.point ? best : { ...seed, overlap: false };
}

// How far the object falls straight down before landing on the gripper:
// vertical rays from its vertices down onto each part, and from the parts'
// vertices up onto it. Returns the landing per part, nearest first, with the
// centre of where it lands (a flat seat has no single touch point).
export function dropTest(work, tools, maxDrop, step = Infinity) {
  const cast = (points, mesh, down) => {
    const boxes = faceBoxes(mesh),
      hits = [];
    for (const p of points)
      mesh.faces.forEach((f, j) => {
        const o = j * 6;
        if (
          p[0] < boxes[o] ||
          p[0] > boxes[o + 3] ||
          p[1] < boxes[o + 1] ||
          p[1] > boxes[o + 4]
        )
          return;
        if (down ? boxes[o + 2] > p[2] : boxes[o + 5] < p[2]) return;
        // Strictly inside, so a ray grazing a wall the object touches misses.
        const z = heightOver(p[0], p[1], mesh.pts, f, 1e-9);
        if (Number.isNaN(z)) return;
        const drop = down ? p[2] - z : z - p[2];
        // A face level with the point is the one it falls away from.
        if (drop > 1e-6) hits.push([drop, down ? p : [p[0], p[1], z]]);
      });
    return hits;
  };
  const band = Number.isFinite(step) ? step : 1e-3;
  const wPts = samples(work, step);
  const within = (p, b) =>
    p[0] >= b.lo[0] && p[0] <= b.hi[0] && p[1] >= b.lo[1] && p[1] <= b.hi[1];
  return tools
    .map((t) => {
      const overlapXY = [0, 1].every(
        (k) => t.lo[k] <= work.hi[k] && t.hi[k] >= work.lo[k],
      );
      if (!overlapXY || t.hi[2] < work.lo[2] - maxDrop || t.lo[2] > work.hi[2])
        return { name: t.name, drop: Infinity };
      const tPts = samples(t, step).filter(
        (p) => p[2] <= work.hi[2] && within(p, work),
      );
      const hits = [
        ...cast(
          wPts.filter((p) => p[2] >= t.lo[2] && within(p, t)),
          t,
          true,
        ),
        ...cast(tPts, work, false),
      ];
      const drop = Math.min(...hits.map((h) => h[0]));
      const seat = hits.filter((h) => h[0] <= drop + band).map((h) => h[1]);
      const point = [0, 1, 2].map(
        (k) => seat.reduce((sum, p) => sum + p[k], 0) / seat.length,
      );
      return { name: t.name, drop, point };
    })
    .filter((h) => h.drop <= maxDrop)
    .sort((a, b) => a.drop - b.drop);
}

// ---- Checks ----------------------------------------------------------------

const label = (name) => name.replaceAll("_", " ");
const mm = (v) => `${(Math.round(v * 10) / 10).toFixed(1)} mm`;
const list = (names) => {
  const n = names.map(label);
  return n.length < 2
    ? n.join("")
    : `${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
};

// Where a part meets the object: the middle of their overlap (grown by the
// contact tolerance), which is stable when whole faces touch.
function contactSide(gap, work, tol) {
  const region = [0, 1, 2].map((k) => [
    Math.max(gap.lo[k], work.lo[k] - tol),
    Math.min(gap.hi[k], work.hi[k] + tol),
  ]);
  const point = region.every(([a, b]) => a <= b)
    ? region.map(([a, b]) => (a + b) / 2)
    : gap.point;
  const centre = [0, 1, 2].map((k) => (work.lo[k] + work.hi[k]) / 2);
  const half = [0, 1, 2].map((k) =>
    Math.max((work.hi[k] - work.lo[k]) / 2, 1e-6),
  );
  const v = [0, 1, 2].map((k) => (point[k] - centre[k]) / half[k]);
  const side = Math.hypot(v[0], v[1]);
  if (side >= Math.abs(v[2]))
    return { side: "side", angle: Math.atan2(v[1], v[0]) };
  return { side: v[2] > 0 ? "top" : "bottom" };
}

// Contacts can balance sideways when no half-turn is free of them.
export function opposed(angles) {
  if (angles.length < 2) return false;
  const sorted = [...angles].sort((a, b) => a - b);
  const gaps = sorted.map((a, i) =>
    i ? a - sorted[i - 1] : a + 2 * Math.PI - sorted.at(-1),
  );
  return Math.max(...gaps) <= (210 * Math.PI) / 180;
}

const toolParts = (mesh, work) =>
  mesh.parts.filter(
    (p) => p.name !== work && !STATIONS.includes(p.name) && p.vertices.length,
  );

export function analyseGrip({ mesh, work, study, open, hold, validation }) {
  const checks = [];
  const workPart = mesh.parts.find((p) => p.name === work);
  if (!workPart) return { checks, verdict: "review" };
  const tools = toolParts(mesh, work);
  const whole = boxOf(mesh.parts.flatMap((p) => p.vertices.flat()));
  const span = Math.hypot(...[0, 1, 2].map((k) => whole.hi[k] - whole.lo[k]));
  const tol = Math.max(0.5, span * 0.004),
    limit = Math.max(tol * 10, span * 0.05);
  const gapsAt = (state, names) => {
    const w = posed(workPart, poseIn(study, state, work));
    return {
      work: w,
      gaps: tools
        .filter((p) => !names || names.includes(p.name))
        .map((p) => {
          const t = posed(p, poseIn(study, state, p.name));
          return {
            name: p.name,
            lo: t.lo,
            hi: t.hi,
            ...meshGap(t, w, limit, tol),
          };
        })
        .sort((a, b) => a.gap - b.gap),
    };
  };
  const held = gapsAt(hold);
  const contacts = held.gaps
    .filter((g) => g.gap <= tol)
    .map((g) => ({ ...g, ...contactSide(g, held.work, tol) }));
  const sides = contacts.filter((c) => c.side === "side"),
    below = contacts.filter((c) => c.side === "bottom"),
    above = contacts.filter((c) => c.side === "top");
  const where = study ? `in “${label(hold)}”` : "as modelled";
  const grip = (status, detail) =>
    checks.push({ id: "grip", label: "Holds the part", status, detail });
  let cage = null;
  if (opposed(sides.map((c) => c.angle)))
    grip(
      "pass",
      `The ${label(work)} is held from ${sides.length} opposing sides by ${list(sides.map((c) => c.name))} ${where}. Holding force comes from friction, which isn't simulated.`,
    );
  else if (below.length)
    grip(
      "pass",
      `The ${label(work)} is cradled from below by ${list(below.map((c) => c.name))} ${where}.`,
    );
  else {
    // Not clamped: lift it and see whether the gripper catches it.
    const height = held.work.hi[2] - held.work.lo[2];
    const landings = dropTest(
      held.work,
      tools.map((p) => posed(p, poseIn(study, hold, p.name))),
      height,
      tol,
    );
    const first = landings[0]?.drop ?? Infinity;
    const rests = landings.filter((l) => l.drop <= first + tol);
    const centre = [0, 1].map((k) => (held.work.lo[k] + held.work.hi[k]) / 2);
    const half = [0, 1].map(
      (k) => (held.work.hi[k] - held.work.lo[k]) / 2 || 1,
    );
    const off = rests.map((r) =>
      [0, 1].map((k) => (r.point[k] - centre[k]) / half[k]),
    );
    const beneath = off.some((o) => Math.hypot(...o) < 0.15);
    if (
      rests.length &&
      (beneath || opposed(off.map((o) => Math.atan2(o[1], o[0]))))
    ) {
      cage = rests;
      grip(
        "pass",
        `Not clamped ${where}: lifted, the ${label(work)} drops ${mm(first)} and settles on ${list(rests.map((r) => r.name))}, which cage it from below.`,
      );
    } else if (above.length)
      grip(
        "review",
        `Only ${list(above.map((c) => c.name))} touches, from above ${where}. Holding relies on suction or adhesion, which isn't simulated.`,
      );
    else if (rests.length)
      grip(
        "review",
        `Not clamped ${where}: lifted, the ${label(work)} drops ${mm(first)} onto ${list(rests.map((r) => r.name))} only, on one side, so it can tip out.`,
      );
    else if (sides.length)
      grip(
        "review",
        `Only ${list(sides.map((c) => c.name))} touches, all from one side ${where}. Nothing opposes it, so the ${label(work)} can slide out.`,
      );
    else {
      const near = held.gaps[0];
      grip(
        "fail",
        `Nothing touches or catches the ${label(work)} ${where}, so it falls out when lifted.${near ? ` Closest is ${label(near.name)}, ${near.approximate ? "over " : ""}${mm(near.gap)} away.` : ""}`,
      );
    }
  }
  const overlap = contacts.filter((c) => c.overlap);
  if (overlap.length)
    checks[0].detail += ` ${list(overlap.map((c) => c.name))} ${overlap.length > 1 ? "overlap" : "overlaps"} it, which means squeeze or interference.`;

  // Side grippers must swing clear to approach and let go; a cup pressing
  // from above is allowed to stay in touch.
  const members = cage
    ? cage.map((c) => c.name)
    : (sides.length ? sides : contacts).map((c) => c.name);
  if (members.length && study && open !== hold) {
    const opened = gapsAt(open, members).gaps;
    const stuck = opened.filter((g) => g.gap <= tol);
    checks.push(
      stuck.length
        ? {
            id: "release",
            label: "Opens clear of the part",
            status: "fail",
            detail: `${list(stuck.map((g) => g.name))} still ${stuck.length > 1 ? "touch" : "touches"} the ${label(work)} in “${label(open)}”, so it can't approach or let go cleanly.`,
          }
        : {
            id: "release",
            label: "Opens clear of the part",
            status: "pass",
            detail: `In “${label(open)}” the nearest gripping part (${label(opened[0].name)}) is ${mm(opened[0].gap)} clear.`,
          },
    );
  } else if (members.length) {
    checks.push({
      id: "release",
      label: "Opens clear of the part",
      status: "review",
      detail: "There's no separate open state to test release against.",
    });
  }

  // The object sits on a flat table at pick and place; nothing may go lower.
  const table = boxOf(workPart.vertices.flat()).lo[2];
  let lowest = { gap: Infinity, name: "" };
  for (const state of study ? statePath(study, open, hold) : [""]) {
    const shift = poseIn(study, state, work).translation[2];
    for (const p of tools) {
      const gap = posed(p, poseIn(study, state, p.name)).lo[2] - shift - table;
      if (gap < lowest.gap) lowest = { gap, name: p.name };
    }
  }
  checks.push(
    lowest.gap < -tol
      ? {
          id: "table",
          label: "Clears the table",
          status: "review",
          detail: `${label(lowest.name)} reaches ${mm(-lowest.gap)} below the ${label(work)}'s base, so it would strike a flat surface at pick and place. Fine if the part hangs or sits on a raised fixture.`,
        }
      : {
          id: "table",
          label: "Clears the table",
          status: "pass",
          detail: `The lowest gripper point stays ${mm(Math.max(0, lowest.gap))} above the surface the ${label(work)} rests on.`,
        },
  );

  if (validation)
    checks.push(
      validation.passed
        ? {
            id: "cad",
            label: "Moves without self-collision",
            status: "pass",
            detail: `Exact CAD check of the study found no collisions across ${validation.samples?.length || 0} sampled poses.`,
          }
        : {
            id: "cad",
            label: "Moves without self-collision",
            status: "fail",
            detail: `Exact CAD check found ${validation.collision_count ?? validation.collisions?.length} collision(s)${validation.collisions?.[0] ? `, first between ${list(validation.collisions[0].parts)} at ${label(validation.collisions[0].sample)}` : ""}.`,
          },
    );
  const statuses = checks.map((c) => c.status);
  return {
    checks,
    tolerance: tol,
    verdict: statuses.includes("fail")
      ? "fail"
      : statuses.includes("review")
        ? "review"
        : "pass",
  };
}

// ---- Cycle -----------------------------------------------------------------

export const STEPS = [
  ["approach", "Approach"],
  ["grip", "Grip"],
  ["lift", "Lift"],
  ["transfer", "Transfer"],
  ["lower", "Lower"],
  ["release", "Release"],
  ["retract", "Retract"],
];
const WEIGHT = {
  approach: 1,
  grip: 0.9,
  lift: 0.8,
  transfer: 1.4,
  lower: 0.8,
  release: 0.9,
  retract: 0.9,
};

const add = (a, b) => a.map((v, i) => v + b[i]);
const minus = (a, b) => a.map((v, i) => v - b[i]);

// Workpiece and carrier offsets are world millimetres from the saved CAD.
// While the mechanism moves, the carrier cancels the study's motion of the
// object, so the object stays put on the station (push-to-close presses down).
export function buildCycle({ mesh, work, study, open, hold }) {
  const tools = toolParts(mesh, work).map((p) => p.name);
  const workPart = mesh.parts.find((p) => p.name === work);
  const tb = boxOf(toolParts(mesh, work).flatMap((p) => p.vertices.flat()));
  const wb = workPart ? boxOf(workPart.vertices.flat()) : tb;
  const size = (b) => [0, 1, 2].map((k) => b.hi[k] - b.lo[k]);
  const lift = Math.max(size(wb)[2] * 1.2, size(tb)[2] * 0.35, 10);
  // Far enough that the stations (object footprint + 30% each side) never touch.
  const travel = Math.max(
    1.4 * Math.max(size(tb)[0], 10),
    1.8 * Math.max(size(wb)[0], size(wb)[1]),
  );
  const w = (state) => poseIn(study, state, work).translation;
  const up = [0, 0, lift],
    pick = [0, 0, 0],
    place = [travel, 0, 0];
  const grip = study ? statePath(study, open, hold) : [open];
  const frames = [];
  const key = (step, state, carrier, object) =>
    frames.push({ step, state, carrier, object });
  key("approach", open, add(minus(pick, w(open)), up), pick);
  grip.forEach((s, i) =>
    key(i ? "grip" : "approach", s, minus(pick, w(s)), pick),
  );
  if (grip.length === 1) key("grip", hold, minus(pick, w(hold)), pick);
  key("lift", hold, add(minus(pick, w(hold)), up), add(pick, up));
  key("transfer", hold, add(minus(place, w(hold)), up), add(place, up));
  key("lower", hold, minus(place, w(hold)), place);
  [...grip]
    .reverse()
    .slice(1)
    .forEach((s) => key("release", s, minus(place, w(s)), place));
  if (grip.length === 1) key("release", open, minus(place, w(open)), place);
  key("retract", open, add(minus(place, w(open)), up), place);
  const phases = frames.slice(1).map((b, i) => ({
    a: frames[i],
    b,
    step: b.step,
    weight: WEIGHT[b.step],
  }));
  return {
    study,
    tools,
    work,
    phases,
    total: phases.reduce((s, p) => s + p.weight, 0),
    stations: { pick, place, lift, travel },
  };
}

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

export function sampleCycle(cycle, progress) {
  const { phases, total, study } = cycle;
  let at = Math.min(1, Math.max(0, progress)) * total,
    index = 0;
  while (index < phases.length - 1 && at > phases[index].weight + 1e-9) {
    at -= phases[index].weight;
    index++;
  }
  const phase = phases[index],
    t = ease(Math.min(1, at / phase.weight));
  const carrier = mix(phase.a.carrier, phase.b.carrier, t);
  const poses = {};
  for (const name of cycle.tools) {
    const a = poseIn(study, phase.a.state, name),
      b = poseIn(study, phase.b.state, name);
    poses[name] = {
      translation: add(mix(a.translation, b.translation, t), carrier),
      rotation: mix(a.rotation, b.rotation, t),
      pivot: a.pivot === ZERO ? b.pivot : a.pivot,
    };
  }
  if (cycle.work)
    poses[cycle.work] = { translation: mix(phase.a.object, phase.b.object, t) };
  const step = STEPS.findIndex(([k]) => k === phase.step);
  const moving = phase.a.state !== phase.b.state;
  return {
    poses,
    step,
    label: moving
      ? `${STEPS[step][1]} · ${label(phase.a.state)} → ${label(phase.b.state)}`
      : STEPS[step][1],
  };
}

// Progress at which a step finishes, for jumping straight to it.
export function stepEnd(cycle, step) {
  let sum = 0,
    end = 0;
  for (const p of cycle.phases) {
    sum += p.weight;
    if (STEPS.findIndex(([k]) => k === p.step) <= step) end = sum;
  }
  return end / cycle.total;
}

// The scene the viewer shows: gripper, object and the two stations.
export function stageMesh(mesh, work, cycle) {
  const workPart = mesh.parts.find((p) => p.name === work);
  if (!workPart) return mesh;
  const wb = boxOf(workPart.vertices.flat());
  const grow = 0.3 * Math.max(wb.hi[0] - wb.lo[0], wb.hi[1] - wb.lo[1], 4);
  const thick = Math.max(1.5, 0.06 * (wb.hi[2] - wb.lo[2]));
  const stations = [cycle.stations.pick, cycle.stations.place].map((at, i) =>
    boxPart(
      STATIONS[i],
      [wb.lo[0] - grow + at[0], wb.lo[1] - grow + at[1], wb.lo[2] - thick],
      [wb.hi[0] + grow + at[0], wb.hi[1] + grow + at[1], wb.lo[2]],
    ),
  );
  return { ...mesh, parts: [...mesh.parts, ...stations] };
}

// Camera frame covering the whole travel, so nothing leaves the view.
export function cycleFrame(scene, cycle) {
  const pts = scene.parts.flatMap((p) => p.vertices.flat());
  const { lo, hi } = boxOf(pts);
  const { lift, travel } = cycle.stations;
  const top = [hi[0] + travel, hi[1], hi[2] + lift];
  const center = [0, 1, 2].map((k) => (lo[k] + Math.max(hi[k], top[k])) / 2);
  const span = Math.hypot(
    ...[0, 1, 2].map((k) => Math.max(hi[k], top[k]) - lo[k]),
  );
  // The diagonal bounds every orientation; the iso views never need all of it.
  return { center, span: Math.max(span * 0.82, 1e-6) };
}
