import { api } from "./lib.js";

export const extensionOf = (file) => file.name.split(".").at(-1).toLowerCase();
export function fileKind(file) {
  const ext = extensionOf(file);
  if (
    [
      "step",
      "stp",
      "stl",
      "obj",
      "3mf",
      "iges",
      "igs",
      "glb",
      "gltf",
      "ply",
    ].includes(ext)
  )
    return "models";
  if (["png", "jpg", "jpeg", "webp", "svg", "gif", "avif"].includes(ext))
    return "images";
  if (["zip", "tar", "gz", "7z"].includes(ext)) return "packages";
  if (["mp4", "webm", "mov", "mp3", "wav", "ogg", "m4a"].includes(ext))
    return "media";
  return "documents";
}
export function fileDescription(file) {
  if (file.name.endsWith(".cad.json")) return "Editable CAD source";
  if (file.metadata?.kind === "mesh_preview") return "Assembly geometry";
  if (file.metadata?.kind === "validation") return "Geometry report";
  return (
    {
      models: "3D model",
      images: "Image",
      packages: "Delivery package",
      media: "Media",
    }[fileKind(file)] ||
    {
      md: "Document",
      pdf: "PDF document",
      csv: "Table",
      json: "Structured data",
      txt: "Text document",
    }[extensionOf(file)] ||
    "File"
  );
}
export function thumbnailSource(file, files) {
  if (fileKind(file) === "images") return file;
  if (fileKind(file) !== "models" || !file.metadata?.build_id) return null;
  return (
    files
      .filter(
        (other) =>
          other.task_id === file.task_id &&
          other.metadata?.build_id === file.metadata.build_id &&
          fileKind(other) === "images",
      )
      .sort(
        (a, b) =>
          Number(/isometric|iso[._]/i.test(b.name)) -
          Number(/isometric|iso[._]/i.test(a.name)),
      )[0] || null
  );
}
export function sortFiles(files, sort = "recommended") {
  const priority = (file) => {
    if (fileKind(file) === "models") return 0;
    if (["md", "pdf", "txt"].includes(extensionOf(file))) return 1;
    if (fileKind(file) === "images") return /iso/i.test(file.name) ? 2 : 3;
    if (fileKind(file) === "packages") return 4;
    return 5;
  };
  return [...files].sort((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name)
      : sort === "recent"
        ? (b.created_at || 0) - (a.created_at || 0)
        : priority(a) - priority(b) || a.name.localeCompare(b.name),
  );
}
export async function downloadArtifact(file) {
  const response = await api(
    `/tasks/${file.task_id}/artifacts/${file.id}/content`,
    { raw: true },
  );
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// Bounded, quoted-field CSV parsing for display; cells remain plain React text.
export function csvPreview(text, limit = 201) {
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (quoted || !cell) quoted = !quoted;
      else cell += c;
    } else if (!quoted && (c === "," || c === "\n" || c === "\r")) {
      row.push(cell);
      cell = "";
      if (c !== ",") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        rows.push(row.slice(0, 50));
        row = [];
        if (rows.length >= limit)
          return { rows, truncated: i < text.length - 1 };
      }
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell].slice(0, 50));
  return { rows, truncated: false };
}
