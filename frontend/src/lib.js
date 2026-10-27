export class APIError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
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
      data.code,
    );
  }
  return raw ? response : response.json();
}

// Requests for unrelated work in a prompt, ignoring code words when the code is a CAD script.
function unrelated(prompt, rules) {
  const hits = [...prompt.matchAll(new RegExp(rules.unrelated, "gi"))].map(
    (match) => match[0],
  );
  if (!new RegExp(rules.cad_code, "i").test(prompt)) return hits.length > 0;
  return hits.some((hit) => !new RegExp(rules.code, "i").test(hit));
}

// Why a new chat's prompt is not a CAD request, or null when it is one. The rules come from
// the server (capabilities.cad_scope), which refuses the same prompts if this check is skipped.
export function cadRefusal(prompt, rules) {
  if (!rules) return null;
  const test = (pattern) => new RegExp(pattern, "i").test(prompt);
  if (!test(rules.term) && !test(rules.size)) return rules.refusal;
  return unrelated(prompt, rules) ? rules.mixed : null;
}

// The same for a follow-up in a chat: only small talk and unrelated requests are refused,
// since a follow-up need not name a part ("make it thicker").
export function followUpRefusal(prompt, rules) {
  if (!rules?.small_talk) return null;
  if (new RegExp(rules.small_talk, "i").test(prompt)) return rules.refusal;
  return unrelated(prompt, rules) ? rules.mixed : null;
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
// "claude-opus-5-5" -> "Opus 5.5", "claude-sonnet-4-5-20250929" -> "Sonnet 4.5", "gpt-5.1" -> "GPT-5.1",
// "gpt-6.1-terra" -> "GPT-6.1 Terra".
export function modelLabel(id) {
  if (!id) return "";
  if (id.startsWith("claude-")) {
    const [family, ...version] = id
      .slice(7)
      .split("-")
      .filter((part) => !/^\d{8}$/.test(part));
    return `${family[0].toUpperCase()}${family.slice(1)} ${version.join(".")}`.trim();
  }
  const named = id.match(/^gpt-([\d.]+)-([a-z]+)$/i);
  if (named)
    return `GPT-${named[1]} ${named[2][0].toUpperCase()}${named[2].slice(1)}`;
  return id.replace(/^gpt/i, "GPT");
}

// Runs reach a real model only through Claude Code or OpenAI; otherwise they fall back to the
// offline workshop recipes.
export const modelConnected = (cap) =>
  cap?.provider === "claude" || cap?.provider === "openai";
export const modeLabel = (cap) =>
  cap?.provider === "claude"
    ? "Claude Code"
    : cap?.provider === "openai"
      ? modelLabel(cap.model)
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
