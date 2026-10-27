import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "./ui.jsx";
import { Questionnaire } from "./TaskPage.jsx";
import { api } from "./lib.js";

vi.mock("@formkit/auto-animate/react", () => ({
  useAutoAnimate: () => [() => {}],
}));

describe("React composer", () => {
  it("submits project context, prevents duplicate sends, and clears only after success", async () => {
    const user = userEvent.setup();
    let finish;
    const onSubmit = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <Composer
        initial
        projects={[{ id: "p1", name: "Fixtures" }]}
        projectId="p1"
        cap={{ provider: "workshop" }}
        onSubmit={onSubmit}
      />,
    );
    await user.type(
      screen.getByRole("textbox", { name: "Describe your project" }),
      "Make a bracket",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSubmit).toHaveBeenCalledWith({
      prompt: "Make a bracket",
      project_id: "p1",
      context_scope: "project",
    });
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByRole("textbox")).toHaveValue("Make a bracket");
    finish();
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
  it("retains the draft after a network failure and supports retry", async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce({});
    render(
      <Composer initial cap={{ provider: "workshop" }} onSubmit={onSubmit} />,
    );
    await user.type(screen.getByRole("textbox"), "Design a mounting plate");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connection interrupted",
    );
    expect(screen.getByRole("textbox")).toHaveValue("Design a mounting plate");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
  });
  it("allows Shift+Enter without submitting", async () => {
    const user = userEvent.setup(),
      onSubmit = vi.fn();
    render(
      <Composer initial cap={{ provider: "workshop" }} onSubmit={onSubmit} />,
    );
    expect(
      screen.queryByRole("option", { name: "Project context" }),
    ).toBeNull();
    await user.type(screen.getByRole("textbox"), "Bracket");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("Bracket\n");
  });
});
const questionnaire = {
  id: "q1",
  title: "Mounting",
  status: "pending",
  questions: [
    {
      id: "mount",
      question: "How should it mount?",
      options: ["Screws", "Adhesive"],
      default: "Screws",
    },
  ],
};
describe("clarification form", () => {
  it("preserves edited answers when live task data rerenders and submits the custom answer", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const refresh = vi.fn();
    const { rerender } = render(
      <Questionnaire
        questionnaire={questionnaire}
        task={{ id: "t1", status: "awaiting_input" }}
        refresh={refresh}
      />,
    );
    await user.type(
      screen.getByLabelText("Custom answer: How should it mount?"),
      "Two M3 screws",
    );
    rerender(
      <Questionnaire
        questionnaire={{ ...questionnaire }}
        task={{ id: "t1", status: "awaiting_input" }}
        refresh={refresh}
      />,
    );
    expect(
      screen.getByLabelText("Custom answer: How should it mount?"),
    ).toHaveValue("Two M3 screws");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      answers: { mount: "Two M3 screws" },
      notes: "",
      skip: false,
    });
  });
  it("Use defaults submits the recommended choices", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    render(
      <Questionnaire
        questionnaire={questionnaire}
        task={{ id: "t1", status: "awaiting_input" }}
        refresh={vi.fn()}
      />,
    );
    await user.click(screen.getByLabelText("Adhesive"));
    await user.click(screen.getByRole("button", { name: "Use defaults" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      answers: { mount: "Screws" },
      notes: "",
      skip: true,
    });
  });
});
it("sends the local token on requests and signals authentication failure", async () => {
  sessionStorage.setItem("6b-token", "test-local-token");
  const onUnlock = vi.fn();
  window.addEventListener("6b:unlock", onUnlock);
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response('{"detail":"Local API token required"}', { status: 401 }),
    );
  await expect(api("/tasks")).rejects.toMatchObject({ status: 401 });
  expect(fetchMock.mock.calls[0][1].headers.get("Authorization")).toBe(
    "Bearer test-local-token",
  );
  expect(onUnlock).toHaveBeenCalledTimes(1);
  window.removeEventListener("6b:unlock", onUnlock);
  sessionStorage.clear();
});
