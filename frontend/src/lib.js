export class APIError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Hosted 6B: each browser keeps its own model and Onshape keys. They live only in this
// browser (this tab unless the user chose to remember them) and are sent as headers.
export const MODEL_CONNECTION = "6b-model-connection";
export const ONSHAPE_CONNECTION = "6b-onshape-connection";
const stores = () => {
  try {
    return [sessionStorage, localStorage];
  } catch {
    return [];
  }
};
export function savedConnection(name) {
  for (const store of stores()) {
    try {
      const value = store.getItem(name);
      if (value) return JSON.parse(value);
    } catch {
      // Unreadable or blocked storage counts as not connected.
    }
  }
  return null;
}
export function saveConnection(name, value, remember) {
  forgetConnection(name);
  const [session, local] = stores();
  (remember ? local : session)?.setItem(name, JSON.stringify(value));
}
export function forgetConnection(name) {
  for (const store of stores()) {
    try {
      store.removeItem(name);
    } catch {
      // Nothing stored there.
    }
  }
}
export const rememberedConnection = (name) => {
  try {
    return !!localStorage.getItem(name);
  } catch {
    return false;
  }
};
// Requests that queue a model run; only these carry the API key itself.
const RUN_REQUEST =
  /^\/tasks(\/[^/]+\/(messages|retry|approvals\/[^/]+|questions\/[^/]+\/answer))?$/;
export function connectionHeaders(path, method = "GET") {
  const headers = {};
  const model = savedConnection(MODEL_CONNECTION);
  if (model?.provider) {
    headers["X-6B-Provider"] = model.provider;
    if (model.model) headers["X-6B-Model"] = model.model;
    if (model.key && method !== "GET" && RUN_REQUEST.test(path.split("?")[0]))
      headers["X-6B-Key"] = model.key;
  }
  const onshape = savedConnection(ONSHAPE_CONNECTION);
  if (onshape && /^\/(onshape\/|integrations\/onshape)/.test(path)) {
    headers["X-6B-Onshape-Url"] = onshape.base_url;
    headers["X-6B-Onshape-Access"] = onshape.access_key;
    headers["X-6B-Onshape-Secret"] = onshape.secret_key;
  }
  return headers;
}

export async function api(path, { body, raw, ...options } = {}) {
  const headers = new Headers(options.headers);
  const token = sessionStorage.getItem("6b-token");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  for (const [name, value] of Object.entries(
    connectionHeaders(path, (options.method || "GET").toUpperCase()),
  ))
    headers.set(name, value);
  if (body && !(body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }
  const response = await fetch(`/api${path}`, { ...options, headers, body });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401)
      window.dispatchEvent(
        new Event(data.sign_in ? "6b:sign-in" : "6b:unlock"),
      );
    throw new APIError(
      typeof data.detail === "string"
        ? data.detail
        : `Request failed (${response.status}). Please try again.`,
      response.status,
    );
  }
  return raw ? response : response.json();
}

export const statusLabel = (status) =>
  ({
    awaiting_input: "Needs input",
    queued: "Queued",
    running: "Running",
    completed: "Completed",
    cancelled: "Stopped",
    failed: "Failed",
    interrupted: "Interrupted",
  })[status] || status?.replaceAll("_", " ");
export const size = (n) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${(n / 1024).toFixed(1)} KB`;
export const date = (value) =>
  new Date(value * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
export const modeLabel = (cap) =>
  cap?.provider === "claude"
    ? "Claude Code"
    : cap?.provider === "openai"
      ? cap.model
      : "Local workshop";
export function latestArtifacts(items) {
  const map = new Map();
  for (const item of items)
    if (!map.has(item.name) || map.get(item.name).version < item.version)
      map.set(item.name, item);
  return [...map.values()];
}
export function deliveredArtifacts(task) {
  const current = latestArtifacts(task.artifacts);
  const delivery = current
    .filter((a) => a.metadata.kind === "package")
    .sort((a, b) => b.created_at - a.created_at)[0];
  const ids = delivery
    ? new Set([
        delivery.id,
        ...(delivery.metadata.manifest || []).map((a) => a.id),
      ])
    : null;
  return current.filter(
    (a) =>
      !["preview", "mesh_preview", "cad_geometry"].includes(a.metadata.kind) &&
      (task.status !== "completed" || !ids || ids.has(a.id)),
  );
}
export function eventCursor(block) {
  const match = block.match(/^id:\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}
export const samples = [
  {
    id: "markers",
    title: "A place for every marker",
    description: "Wall organizer · Printable assembly",
    prompt:
      "Design a compact wall-mounted organizer for six dry-erase markers, each 18 mm in diameter. It should hold them upright and fit a 220 × 220 mm printer. Create printable STL files, an editable STEP model, and assembly notes.",
  },
  {
    id: "plate",
    title: "Start with a mounting plate",
    description: "Parametric part · STL & STEP",
    prompt:
      "Create an 80 × 50 × 5 mm mounting plate with four 4.5 mm corner holes, 10 mm from each edge. Export STL, STEP, and validation notes.",
  },
];
