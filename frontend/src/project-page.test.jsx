import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProjectPage from "./ProjectPage.jsx";

vi.mock("@formkit/auto-animate/react", () => ({
  useAutoAnimate: () => [() => {}],
}));

const project = {
  id: "p1",
  name: "Drone",
  brief: "Carbon frame, 5 inch props",
  memory_scope: "project",
  files: [],
  chats: [
    {
      id: "t1",
      title: "Arm design",
      status: "completed",
      context_scope: "project",
      updated_at: 1,
    },
  ],
  memories: [
    {
      id: "m1",
      task_id: "t1",
      title: "Arm design",
      content: "Arm tube is 16 mm OD carbon.",
      created_at: 1,
    },
  ],
};

describe("project page", () => {
  it("lists the project's chats and memory, and starts new chats inside the project", async () => {
    const user = userEvent.setup(),
      openTask = vi.fn(),
      createTask = vi.fn(),
      changed = vi.fn();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response(JSON.stringify(project), { status: 200 }),
      );
    render(
      <ProjectPage
        id="p1"
        projects={[project]}
        createTask={createTask}
        openTask={openTask}
        setModal={vi.fn()}
        notify={vi.fn()}
        changed={changed}
        revision={0}
      />,
    );
    await screen.findByRole("heading", { name: "Drone" });
    expect(screen.getByText("Arm tube is 16 mm OD carbon.")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /Arm design/ })[0]);
    expect(openTask).toHaveBeenCalledWith("t1");

    await user.type(
      screen.getByRole("textbox", { name: "Add to project memory" }),
      "Use M3 hardware.",
    );
    await user.click(screen.getByRole("button", { name: /Remember/ }));
    const [url, init] = fetch.mock.calls.at(-1);
    expect(url).toBe("/api/projects/p1/memories");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ content: "Use M3 hardware." });
    expect(changed).toHaveBeenCalled();

    await user.type(
      screen.getByRole("textbox", { name: "Describe your project" }),
      "Design a motor mount{Enter}",
    );
    expect(createTask).toHaveBeenCalledWith({
      prompt: "Design a motor mount",
      project_id: "p1",
      context_scope: "project",
    });
    fetch.mockRestore();
  });
});
