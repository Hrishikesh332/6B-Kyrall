import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CollectionPage, FilesPage, ProjectsPage } from "./pages.jsx";

vi.mock("@formkit/auto-animate/react", () => ({
  useAutoAnimate: () => [() => {}],
}));
const files = [
  {
    id: "model",
    task_id: "t1",
    name: "bracket.step",
    size: 1024,
    version: 2,
    metadata: { validation_passed: true },
  },
  {
    id: "image",
    task_id: "t1",
    name: "view_top.svg",
    size: 2048,
    version: 2,
    metadata: {},
  },
  {
    id: "notes",
    task_id: "t1",
    name: "assembly_notes.md",
    size: 500,
    version: 1,
    metadata: {},
  },
];

describe("workspace collections", () => {
  it("filters files by category, preserves the selected category during search, and opens the correct version", async () => {
    const user = userEvent.setup(),
      openArtifact = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify(files), { status: 200 }),
    );
    render(<FilesPage openArtifact={openArtifact} revision={0} />);
    await screen.findByRole("button", { name: "Preview bracket.step" });
    await user.click(
      screen.getByRole("button", { name: "Models", exact: true }),
    );
    expect(
      screen.queryByRole("button", { name: "Preview view_top.svg" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Preview bracket.step" }),
    );
    expect(openArtifact).toHaveBeenCalledWith("t1", "model");
    await user.type(
      screen.getByRole("textbox", { name: "Search files" }),
      "notes",
    );
    await screen.findByRole("heading", { name: "No matching files" });
    expect(
      screen.getByRole("button", { name: "Models", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Documents & data" }));
    expect(
      screen.getByRole("button", { name: "Preview assembly_notes.md" }),
    ).toBeInTheDocument();
  });
  it("finds a project by its brief and opens its chats", async () => {
    const user = userEvent.setup(),
      openProject = vi.fn(),
      setModal = vi.fn();
    const projects = [
      {
        id: "p1",
        name: "Workshop",
        brief: "Mounting fixtures",
        memory_scope: "project",
        chat_count: 3,
        memory_count: 1,
      },
      { id: "p2", name: "Kitchen", brief: "Storage", memory_scope: "project" },
    ];
    render(
      <ProjectsPage
        projects={projects}
        openProject={openProject}
        setModal={setModal}
        notify={vi.fn()}
      />,
    );
    await user.type(
      screen.getByRole("textbox", { name: "Search projects" }),
      "fixtures",
    );
    expect(
      screen.queryByRole("heading", { name: "Kitchen" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/3 chats · 1 memory · project-only/),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Open project", exact: true }),
    );
    expect(openProject).toHaveBeenCalledWith("p1");
    await user.clear(screen.getByRole("textbox", { name: "Search projects" }));
    await user.type(
      screen.getByRole("textbox", { name: "Search projects" }),
      "not a project",
    );
    expect(
      screen.getByRole("heading", { name: "No matching projects" }),
    ).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Search projects" }));
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Open project", exact: true }),
      ).toHaveLength(2),
    );
  });

  it("runs a paused job once in its own chat and shows the latest chat status", async () => {
    const user = userEvent.setup(),
      openTask = vi.fn(),
      changed = vi.fn(async () => {});
    const job = {
      id: "j1",
      name: "Kyrall gripper — ripe tomato",
      prompt: "Design a tomato gripper",
      interval_minutes: 1440,
      enabled: 0,
      last_task_id: "old",
      last_task_status: "awaiting_input",
    };
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) =>
        url.endsWith("/schedules/j1/run") && init?.method === "POST"
          ? new Response(JSON.stringify({ id: "t9" }), { status: 201 })
          : new Response(JSON.stringify([job]), { status: 200 }),
      );
    render(
      <CollectionPage
        page="schedules"
        revision={0}
        notify={() => {}}
        changed={changed}
        openTask={openTask}
        setModal={() => {}}
      />,
    );
    expect(await screen.findByText("Needs input")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("Every day")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(openTask).toHaveBeenCalledWith("t9"));
    expect(changed).toHaveBeenCalled();
    expect(
      fetch.mock.calls.some(([url]) => url.endsWith("/schedules/j1/run")),
    ).toBe(true);
  });
});
