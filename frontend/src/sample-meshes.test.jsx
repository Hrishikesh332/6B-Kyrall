import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SampleMeshes, { SamplePreview } from "./SampleMeshes.jsx";
import { FilesPage } from "./pages.jsx";
import { fileKind } from "./filePresentation.js";

const viewer = vi.hoisted(() => ({
  update: vi.fn(),
  view: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("../viewer.js", () => ({ mountViewer: () => viewer }));
vi.mock("@formkit/auto-animate/react", () => ({
  useAutoAnimate: () => [() => {}],
}));
const sample = {
  id: "avocado",
  name: "Avocado",
  filename: "avocado.glb",
  description: "Organic shape",
  author: "Microsoft",
  license: "CC0 1.0",
  license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
  source_url: "https://github.com/KhronosGroup/glTF-Sample-Assets",
  size: 8000000,
  parts: 1,
  triangles: 682,
  bounds_mm: [40, 50, 60],
  sha256: "a".repeat(64),
  preview_note:
    "Geometry preview. Original materials and textures are included in the GLB download.",
};
const mesh = {
  kind: "reference_mesh",
  units: "mm",
  parts: [{ name: "avocado", vertices: [], faces: [] }],
};
const response = (data, status = 200) =>
  new Response(JSON.stringify(data), { status });

describe("web mesh library", () => {
  beforeEach(() =>
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null),
  );
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.removeItem("6b-token");
  });
  it("is not offered on the Assets page", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => response([]));
    render(<FilesPage />);
    await screen.findByRole("button", { name: "All files" });
    expect(
      screen.queryByRole("button", { name: "Sample meshes" }),
    ).not.toBeInTheDocument();
  });

  it("supports retrying a failed catalogue load", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({ detail: "Sample library unavailable" }, 503),
      )
      .mockImplementation(async (url) =>
        response(url.endsWith("/mesh-samples") ? [sample] : mesh),
      );
    render(<SampleMeshes />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sample library unavailable",
    );
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("button", { name: "Preview Avocado" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("shows download failures and closes with Escape cancellation", async () => {
    const close = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      url.endsWith("/original")
        ? response({ detail: "Sample file is unavailable" }, 404)
        : response(mesh),
    );
    render(<SamplePreview sample={sample} onClose={close} />);
    await userEvent.click(screen.getByRole("button", { name: "Download GLB" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sample file is unavailable",
    );
    expect(screen.getByRole("button", { name: "Download GLB" })).toBeEnabled();
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { cancelable: true }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("downloads the original GLB through the authenticated API", async () => {
    const create = vi.fn(() => "blob:sample"),
      revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    sessionStorage.setItem("6b-token", "sample-token");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) =>
        url.endsWith("/original") ? new Response("glTF") : response(mesh),
      );
    render(<SamplePreview sample={sample} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Download GLB" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find(([url]) =>
      url.endsWith("/original"),
    );
    expect(call[1].headers.get("Authorization")).toBe("Bearer sample-token");
    sessionStorage.removeItem("6b-token");
  });

  it("classifies downloadable mesh formats as models", () => {
    for (const name of ["model.glb", "model.gltf", "scan.ply"])
      expect(fileKind({ name })).toBe("models");
  });
});
