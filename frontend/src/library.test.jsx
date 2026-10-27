import { describe, expect, it, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FileLibrary, { FileGallery } from "./FileLibrary.jsx";
import {
  DocumentContent,
  BrowserFileContent,
  ImageContent,
  PackageContent,
} from "./FileContent.jsx";
import IntegrationsPage from "./IntegrationsPage.jsx";
import { csvPreview, fileKind, thumbnailSource } from "./filePresentation.js";

const file = (id, name, taskId = "t1") => ({
  id,
  name,
  task_id: taskId,
  task_title: taskId === "t1" ? "Fixture" : "Enclosure",
  size: 1000,
  version: 2,
  created_at: Number(id.replace(/\D/g, "")) || 0,
  metadata: {},
});
const files = [
  file("a1", "body.step"),
  file("a2", "jaw.stl"),
  file("a3", "notes.md"),
  file("a4", "front.png"),
  file("a5", "side.svg"),
  file("a6", "top.png"),
  file("a7", "parts.csv"),
  file("a8", "pack.zip"),
  file("b1", "housing.step", "t2"),
];

describe("preview-led file browsing", () => {
  it("groups tasks, expands files, switches layouts and opens the right file", async () => {
    const user = userEvent.setup(),
      onOpen = vi.fn();
    render(<FileLibrary files={files} onOpen={onOpen} />);
    expect(screen.getByRole("link", { name: "Fixture" })).toHaveAttribute(
      "href",
      "#task=t1",
    );
    expect(
      screen.queryByRole("button", { name: "Preview parts.csv" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show 2 more files" }));
    await user.click(screen.getByRole("button", { name: "Preview parts.csv" }));
    expect(onOpen).toHaveBeenCalledWith("t1", "a7");
    await user.click(screen.getByRole("button", { name: "List view" }));
    expect(screen.getByRole("button", { name: "List view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.selectOptions(screen.getByLabelText("Sort files"), "name");
    const names = screen
      .getAllByRole("button", { name: /^Preview / })
      .map((node) => node.getAttribute("aria-label"));
    expect(names.slice(0, 3)).toEqual([
      "Preview body.step",
      "Preview front.png",
      "Preview jaw.stl",
    ]);
    await user.click(screen.getByRole("button", { name: "Group by project" }));
    expect(screen.queryByRole("link", { name: "Fixture" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Preview / })).toHaveLength(
      9,
    );
  });
  it("keeps downloads independent from opening a file and reports failures", async () => {
    const user = userEvent.setup(),
      onOpen = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "File unavailable" }), {
        status: 404,
      }),
    );
    render(<FileGallery files={[files[0]]} onOpen={onOpen} />);
    await user.click(
      screen.getByRole("button", { name: "Download body.step" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "File unavailable",
    );
    expect(onOpen).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Download body.step" }),
    ).toBeEnabled();
  });
  it("only uses a projection from the exact task and CAD build", () => {
    const model = { ...files[0], metadata: { build_id: "current" } };
    const wrongTask = {
      ...files[3],
      task_id: "other",
      metadata: { build_id: "current" },
    };
    const old = { ...files[4], metadata: { build_id: "previous" } };
    expect(thumbnailSource(model, [wrongTask, old])).toBeNull();
    const match = { ...files[3], metadata: { build_id: "current" } };
    expect(thumbnailSource(model, [wrongTask, old, match])).toBe(match);
    expect(fileKind(file("x", "drawing.pdf"))).toBe("documents");
    expect(fileKind(file("x", "capture.webm"))).toBe("media");
  });
});

describe("file-specific preview controls", () => {
  it("opens PDFs in an isolated native viewer without blocked embedded content", () => {
    const { container } = render(
      <BrowserFileContent
        file={file("pdf", "drawing.pdf")}
        url="blob:document"
      />,
    );
    const link = screen.getByRole("link", { name: "Open PDF" });
    expect(link).toHaveAttribute("href", "blob:document");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(container.querySelector("object, iframe")).toBeNull();
  });
  it("renders readable markdown safely and preserves the source", async () => {
    const user = userEvent.setup();
    const text =
      '# Assembly notes\n\n**Check the fit.**\n\n<script>alert("bad")</script>';
    const { container } = render(
      <DocumentContent file={file("md", "notes.md")} text={text} />,
    );
    expect(
      screen.getByRole("heading", { name: "Assembly notes" }),
    ).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Source", exact: true }),
    );
    expect(container.querySelector("pre")).toHaveTextContent(
      "# Assembly notes",
    );
    expect(
      screen.queryByRole("heading", { name: "Assembly notes" }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Preview", exact: true }),
    );
    expect(
      screen.getByRole("heading", { name: "Assembly notes" }),
    ).toBeInTheDocument();
  });
  it("displays quoted CSV cells as inert text and bounds large tables", () => {
    const text =
      'Part,Description\r\nJaw,"Left, right"\r\nBase,"line one\nline two"\r\nNote,"<img src=x>"';
    render(<DocumentContent file={file("csv", "parts.csv")} text={text} />);
    const table = screen.getByRole("table");
    expect(
      within(table).getByRole("cell", { name: "Left, right" }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("cell", { name: /line one\s+line two/ }),
    ).toBeInTheDocument();
    expect(table.querySelector("img")).toBeNull();
    expect(csvPreview("A\n" + "1\n".repeat(250)).rows).toHaveLength(201);
    expect(csvPreview("A\n" + "1\n".repeat(250)).truncated).toBe(true);
  });
  it("zooms images and restores fit without changing the original", async () => {
    const user = userEvent.setup();
    render(<ImageContent image="blob:image" name="front.svg" />);
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByLabelText("Image zoom")).toHaveTextContent("125%");
    expect(screen.getByRole("img")).toHaveAttribute("src", "blob:image");
    await user.click(screen.getByRole("button", { name: "Fit image" }));
    expect(screen.getByLabelText("Image zoom")).toHaveTextContent("100%");
  });
  it("opens the version included in a delivery package", async () => {
    const onChange = vi.fn();
    render(
      <PackageContent
        taskId="t1"
        file={{ ...files[7], metadata: { manifest: [files[0]] } }}
        onChange={onChange}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Preview body.step" }),
    );
    expect(onChange).toHaveBeenCalledWith({ taskId: "t1", artifactId: "a1" });
  });
});

describe("integration catalog", () => {
  const cap = {
    provider: "openai",
    integrations: [
      { name: "Onshape", status: "not_configured", detail: "Import designs" },
      { name: "Parametric CAD", status: "available", detail: "CAD export" },
      { name: "NVIDIA Isaac Sim", status: "configured", detail: "Scenes" },
      {
        name: "Desktop CAD / external MCP",
        status: "not_implemented",
        detail: "No external application control",
      },
    ],
  };
  it("lists only real connections with honest status and opens their setup", async () => {
    const user = userEvent.setup(),
      setModal = vi.fn();
    render(<IntegrationsPage cap={cap} setModal={setModal} />);
    expect(
      screen.getAllByRole("button").map((b) => b.getAttribute("aria-label")),
    ).toEqual([
      "Claude Code — Connect",
      "OpenAI — Connected",
      "Onshape — Connect",
      "NVIDIA Isaac Sim — Configured",
      "Bambu Studio — Not installed",
    ]);
    expect(screen.queryByText(/Parametric CAD|Desktop CAD/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Onshape — Connect" }));
    expect(setModal).toHaveBeenCalledWith({ kind: "onshape" });
    await user.click(
      screen.getByRole("button", { name: "Claude Code — Connect" }),
    );
    expect(setModal).toHaveBeenCalledWith({
      kind: "model",
      provider: "claude",
    });
    await user.click(
      screen.getByRole("button", { name: "NVIDIA Isaac Sim — Configured" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("link", { name: "Open projects" }),
    ).toHaveAttribute("href", "#tasks");
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
