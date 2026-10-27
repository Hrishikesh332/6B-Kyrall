import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ArtifactPreview, { MeshPreview } from "./ArtifactPreview.jsx";
import TaskPage from "./TaskPage.jsx";
import OnshapeSetup, { OnshapeExport } from "./OnshapeSetup.jsx";
import { Home } from "./App.jsx";
import { useTask } from "./hooks.js";

const renderer = vi.hoisted(() => ({
  update: vi.fn(),
  view: vi.fn(),
  focus: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("../viewer.js", () => ({ mountViewer: () => renderer }));
vi.mock("@formkit/auto-animate/react", () => ({
  useAutoAnimate: () => [() => {}],
}));
vi.mock("./hooks.js", () => ({
  useTask: vi.fn(),
  useResource: () => ({ data: null, loading: true, reload: vi.fn() }),
}));

const file = {
  id: "model2",
  task_id: "t1",
  name: "assembly.step",
  version: 2,
  size: 1024,
  created_at: 1,
  sha256: "abc123456789",
  metadata: { kind: "cad", build_id: "b2" },
};
const task = {
  id: "t1",
  title: "Mounting assembly",
  status: "completed",
  context_scope: "isolated",
  messages: [],
  plan: [],
  runs: [],
  artifacts: [file],
};
const mesh = {
  parts: [
    { name: "base", vertices: [], faces: [] },
    { name: "jaw", vertices: [], faces: [] },
  ],
};
const study = {
  id: "motion",
  name: "grip_cycle",
  states: [
    { name: "open", poses: [] },
    { name: "closed", poses: [{ part: "jaw", translation: [10, 0, 0] }] },
  ],
  transitions: [{ start: "open", end: "closed" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  useTask.mockReturnValue({
    task,
    activity: [],
    refresh: vi.fn().mockResolvedValue(),
    error: null,
  });
});

describe("task workspace controls", () => {
  it("opens the model, navigates tabs with the keyboard, previews files and opens rename", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ configured: false, connected: false })),
    );
    const user = userEvent.setup(),
      openArtifact = vi.fn(),
      setModal = vi.fn();
    render(
      <TaskPage
        id="t1"
        cap={{ provider: "claude" }}
        openArtifact={openArtifact}
        setModal={setModal}
        notify={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "View model" }));
    expect(openArtifact).toHaveBeenCalledWith("t1", "model2");
    await user.click(screen.getByRole("tab", { name: "Conversation" }));
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: /Files/ })).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: /Files/ })).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Preview assembly.step" }),
    );
    expect(openArtifact).toHaveBeenLastCalledWith("t1", "model2");
    await user.click(screen.getByRole("tab", { name: /Files/ }));
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Conversation" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getAllByRole("tab").at(-1)).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Rename project" }));
    expect(setModal).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rename", task }),
    );
  });

  it.each([
    ["running", "Stop", "cancel"],
    ["failed", "Retry", "retry"],
  ])("preserves the %s task action", async (status, label, endpoint) => {
    const user = userEvent.setup(),
      refresh = vi.fn().mockResolvedValue();
    useTask.mockReturnValue({
      task: { ...task, status },
      activity: [],
      refresh,
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));
    render(
      <TaskPage
        id="t1"
        cap={{ provider: "claude" }}
        openArtifact={vi.fn()}
        setModal={vi.fn()}
        notify={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: label, exact: true }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/t1/${endpoint}`,
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("model studio controls", () => {
  it("changes orientation, hides parts and resets every presentation control", async () => {
    const user = userEvent.setup();
    render(<MeshPreview mesh={mesh} studies={[study]} name="assembly.step" />);
    await user.click(
      screen.getByRole("button", { name: "Front", exact: true }),
    );
    expect(renderer.view).toHaveBeenLastCalledWith("front");
    expect(
      screen.getByRole("button", { name: "Front", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByText("Parts · 2"));
    await user.click(screen.getByRole("checkbox", { name: "jaw" }));
    expect(renderer.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ hidden: ["jaw"] }),
    );
    await user.selectOptions(
      screen.getByLabelText("Presentation mode"),
      "motion",
    );
    fireEvent.change(screen.getByLabelText("Motion timeline"), {
      target: { value: "0.5" },
    });
    await user.selectOptions(screen.getByLabelText("Playback speed"), "2");
    await user.click(screen.getByRole("button", { name: "Turntable" }));
    await user.click(screen.getByRole("button", { name: "Reset view" }));
    expect(screen.getByLabelText("Presentation mode")).toHaveValue("");
    expect(screen.getByLabelText("Explode assembly")).toHaveValue("0");
    expect(screen.getByRole("checkbox", { name: "jaw" })).toBeChecked();
    expect(renderer.update).toHaveBeenLastCalledWith({
      explode: 0,
      hidden: [],
      poses: {},
      offsets: {},
      ghosted: [],
      selected: "",
      rotate: false,
    });
    expect(renderer.view).toHaveBeenLastCalledWith("iso");
  });

  it("plays an assembly sequence, reorders steps and selects the active part", async () => {
    const user = userEvent.setup();
    render(<MeshPreview mesh={mesh} name="assembly.step" />);
    await user.selectOptions(
      screen.getByLabelText("Presentation mode"),
      "__assembly",
    );
    expect(screen.getByText("ASSEMBLY SEQUENCE · STEP 2/2 · mm")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Assembly timeline"), {
      target: { value: "0.1" },
    });
    expect(screen.getByText(/Step 1 of 2 · Install/)).toBeVisible();
    expect(renderer.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ ghosted: [expect.any(String)] }),
    );
    const steps = screen.getByRole("list", { name: "Assembly steps" });
    const first = steps.querySelector("li .step-name").lastChild.textContent;
    await user.click(screen.getAllByRole("button", { name: /later$/ })[0]);
    expect(
      steps.querySelectorAll("li .step-name")[1].lastChild.textContent,
    ).toBe(first);
    await user.click(screen.getByRole("checkbox", { name: /ghosts/ }));
    expect(renderer.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ ghosted: [], hidden: [expect.any(String)] }),
    );
    await user.click(screen.getByRole("button", { name: "Disassemble" }));
    expect(screen.getByText(/Step 1 of 2 · Remove/)).toBeVisible();
    await user.click(steps.querySelectorAll("li .step-name")[0]);
    expect(
      screen.getByRole("region", { name: "Selected component" }),
    ).toBeVisible();
  });

  it("sends a revision scoped to the selected component", async () => {
    const user = userEvent.setup(),
      onRevise = vi.fn().mockResolvedValue();
    render(
      <MeshPreview mesh={mesh} name="assembly.step" onRevise={onRevise} />,
    );
    await user.click(screen.getByText("Parts · 2"));
    await user.click(screen.getByRole("button", { name: "jaw" }));
    expect(renderer.focus).toHaveBeenLastCalledWith("jaw");
    expect(renderer.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ selected: "jaw" }),
    );
    await user.click(screen.getByRole("button", { name: "Isolate" }));
    expect(renderer.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ ghosted: ["base"] }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Add 0.2 mm fit clearance to mating faces",
      }),
    );
    await user.type(
      screen.getByLabelText("Revise this component"),
      " on the slot",
    );
    await user.click(
      screen.getByRole("button", { name: "Send component revision" }),
    );
    expect(onRevise).toHaveBeenCalledWith(
      "jaw",
      "Add 0.2 mm fit clearance to mating faces on the slot",
    );
    expect(screen.getByLabelText("Revise this component")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(
      screen.queryByRole("region", { name: "Selected component" }),
    ).toBeNull();
  });

  it("expands, switches the loaded version, downloads the selected file and closes", async () => {
    const user = userEvent.setup(),
      onClose = vi.fn(),
      notify = vi.fn();
    const old = {
      ...file,
      id: "model1",
      version: 1,
      metadata: { kind: "cad", build_id: "b1" },
    };
    const previewTask = {
      ...task,
      artifacts: [
        file,
        old,
        ...["b1", "b2"].map((build_id) => ({
          id: `mesh-${build_id}`,
          name: "mesh.json",
          metadata: { kind: "mesh_preview", build_id },
        })),
      ],
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        if (url === "/api/tasks/t1")
          return new Response(JSON.stringify(previewTask));
        if (url.includes("mesh-")) return new Response(JSON.stringify(mesh));
        return new Response("STEP bytes");
      });
    const createURL = vi.fn(() => "blob:download");
    vi.stubGlobal(
      "URL",
      Object.assign(class extends URL {}, {
        createObjectURL: createURL,
        revokeObjectURL: vi.fn(),
      }),
    );
    let downloaded;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function () {
        downloaded = this.download;
      },
    );
    function Preview() {
      const [selection, setSelection] = useState({
        taskId: "t1",
        artifactId: "model2",
      });
      return (
        <ArtifactPreview
          {...selection}
          onChange={setSelection}
          onClose={onClose}
          notify={notify}
        />
      );
    }
    render(<Preview />);
    await screen.findByLabelText("Displayed geometry");
    await user.click(screen.getByRole("button", { name: "Expand preview" }));
    expect(
      screen.getByRole("dialog", { name: "Artifact preview" }),
    ).toHaveClass("is-expanded");
    await user.selectOptions(screen.getByLabelText("File version"), "model1");
    await waitFor(() =>
      expect(screen.getByLabelText("File version")).toHaveValue("model1"),
    );
    await user.click(
      screen.getByRole("button", { name: "Download", exact: true }),
    );
    await waitFor(() => expect(createURL).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/tasks/t1/artifacts/model1/content",
      expect.anything(),
    );
    expect(downloaded).toBe("assembly.step");
    await user.click(screen.getByRole("button", { name: "Minimize preview" }));
    expect(screen.getByRole("dialog")).not.toHaveClass("is-expanded");
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { bubbles: false, cancelable: true }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("Send to Onshape", () => {
  it("creates a document or picks an existing one and links the result", async () => {
    const user = userEvent.setup();
    const did = "a".repeat(24),
      wid = "b".repeat(24);
    const bodies = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const json = (data) => new Response(JSON.stringify(data));
      if (url === "/api/integrations/onshape")
        return json({
          configured: true,
          base_url: "https://cad.onshape.com",
          user: { name: "Ada" },
        });
      if (url.startsWith("/api/onshape/documents?"))
        return json({
          items: [{ id: did, name: "Fixtures", workspace_id: wid }],
          next: false,
          offset: 0,
        });
      if (url.startsWith("/api/onshape/thumbnail"))
        return new Response("", { status: 422 });
      if (url === "/api/onshape/export") {
        bodies.push(JSON.parse(init.body));
        return json({
          state: "done",
          file: "gripper.step",
          created_document: bodies.length === 1,
          elements: [{ id: "e1", name: "gripper" }],
          url: "https://cad.onshape.com/documents/new/w/x/e/e1",
        });
      }
      return new Response("{}", { status: 404 });
    });
    const { unmount } = render(
      <OnshapeExport
        taskId="t1"
        artifactId="s1"
        name="gripper.step"
        title="Gripper R07"
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByLabelText("Document name")).toHaveValue(
      "Gripper R07",
    );
    await user.click(screen.getByRole("checkbox", { name: /one Part Studio/ }));
    await user.click(
      screen.getByRole("button", { name: "Create document and send" }),
    );
    expect(bodies[0]).toEqual({
      task_id: "t1",
      artifact_id: "s1",
      flatten: false,
      new_document_name: "Gripper R07",
    });
    expect(
      await screen.findByRole("link", { name: /Open in Onshape/ }),
    ).toHaveAttribute("href", "https://cad.onshape.com/documents/new/w/x/e/e1");
    unmount();
    render(
      <OnshapeExport
        taskId="t1"
        artifactId="s1"
        name="gripper.step"
        onClose={vi.fn()}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Existing document" }),
    );
    await user.click(await screen.findByRole("button", { name: /Fixtures/ }));
    await user.click(screen.getByRole("button", { name: "Send to Fixtures" }));
    expect(bodies[1]).toEqual({
      task_id: "t1",
      artifact_id: "s1",
      flatten: true,
      document_id: did,
      workspace_id: wid,
    });
  });
});

describe("Onshape entry point", () => {
  it("opens setup from home without creating a task", async () => {
    const user = userEvent.setup(),
      setModal = vi.fn(),
      createTask = vi.fn();
    render(
      <Home
        tasks={[]}
        projects={[]}
        cap={{ provider: "claude", integrations: [] }}
        setModal={setModal}
        createTask={createTask}
        openTask={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /Working in Onshape/ }),
    );
    expect(setModal).toHaveBeenCalledWith({ kind: "onshape" });
    expect(createTask).not.toHaveBeenCalled();
  });
  it("connects with keys, browses documents and imports an assembly", async () => {
    const user = userEvent.setup(),
      onImported = vi.fn(),
      onChanged = vi.fn();
    const did = "a".repeat(24),
      wid = "b".repeat(24),
      eid = "c".repeat(24);
    const calls = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push([url, init?.method || "GET", init?.body]);
      const json = (data) => new Response(JSON.stringify(data));
      if (url === "/api/integrations/onshape" && !init?.method)
        return json({ configured: false });
      if (url === "/api/integrations/onshape")
        return json({
          configured: true,
          base_url: "https://cad.onshape.com",
          access_key_hint: "…1234",
          user: { name: "Ada" },
        });
      if (url.startsWith("/api/onshape/documents?"))
        return json({
          items: [
            {
              id: did,
              name: "Gripper",
              workspace_id: wid,
              owner: "Ada",
              url: "https://cad.onshape.com/documents/x",
            },
          ],
          next: false,
          offset: 0,
        });
      if (url.endsWith("/elements"))
        return json([{ id: eid, name: "Main assembly", type: "ASSEMBLY" }]);
      if (url.startsWith("/api/onshape/thumbnail"))
        return new Response("", { status: 422 });
      if (url === "/api/onshape/import")
        return json({ task_id: "t9", preview_artifact_id: "m1", parts: 3 });
      return new Response("{}", { status: 404 });
    });
    render(
      <OnshapeSetup
        onClose={vi.fn()}
        onChanged={onChanged}
        onImported={onImported}
        notify={vi.fn()}
      />,
    );
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Access key"), "access-1234");
    await user.type(screen.getByLabelText("Secret key"), "secret-5678");
    await user.click(screen.getByRole("button", { name: "Connect Onshape" }));
    const put = calls.find(([, method]) => method === "PUT");
    expect(JSON.parse(put[2])).toEqual({
      base_url: "https://cad.onshape.com",
      access_key: "access-1234",
      secret_key: "secret-5678",
    });
    expect(onChanged).toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: /Gripper/ }));
    await user.click(
      await screen.findByRole("radio", { name: /Main assembly/ }),
    );
    await user.type(
      screen.getByLabelText(/What should 6B do/),
      "Design a cover",
    );
    await user.click(screen.getByRole("button", { name: "Import and start" }));
    const imported = calls.find(([url]) => url === "/api/onshape/import");
    expect(JSON.parse(imported[2])).toEqual({
      document_id: did,
      workspace_id: wid,
      element_id: eid,
      prompt: "Design a cover",
    });
    expect(onImported).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: "t9", preview_artifact_id: "m1" }),
    );
  });
});
