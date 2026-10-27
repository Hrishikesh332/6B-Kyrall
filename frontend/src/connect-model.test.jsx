import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "./ui.jsx";
import { api } from "./lib.js";

vi.mock("@formkit/auto-animate/react", () => ({
  useAutoAnimate: () => [() => {}],
}));

const textbox = () =>
  screen.getByRole("textbox", { name: "Describe your project" });

describe("composer without a model", () => {
  it("asks for a connection when the user starts writing, and keeps the draft", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(),
      onConnectModel = vi.fn();
    render(
      <Composer
        initial
        cap={{ provider: "workshop" }}
        onSubmit={onSubmit}
        onConnectModel={onConnectModel}
      />,
    );
    await user.click(textbox());
    expect(onConnectModel).toHaveBeenCalledTimes(1);
    // Closing the dialog and writing again does not ask on every focus.
    await user.type(textbox(), "Make a bracket");
    expect(onConnectModel).toHaveBeenCalledTimes(1);
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onConnectModel).toHaveBeenCalledTimes(2);
    expect(textbox()).toHaveValue("Make a bracket");
    await user.click(
      screen.getByRole("button", {
        name: /Connect Claude Code or ChatGPT to start/,
      }),
    );
    expect(onConnectModel).toHaveBeenCalledTimes(3);
  });

  it("sends straight away once a model is connected", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(),
      onConnectModel = vi.fn();
    render(
      <Composer
        initial
        cap={{ provider: "claude" }}
        onSubmit={onSubmit}
        onConnectModel={onConnectModel}
      />,
    );
    await user.type(textbox(), "Make a bracket{Enter}");
    expect(onConnectModel).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Make a bracket" }),
    );
    expect(
      screen.queryByRole("button", { name: /Connect Claude Code/ }),
    ).toBeNull();
  });

  it("waits for capabilities before asking", async () => {
    const user = userEvent.setup();
    const onConnectModel = vi.fn();
    render(
      <Composer
        initial
        cap={null}
        onSubmit={vi.fn()}
        onConnectModel={onConnectModel}
      />,
    );
    await user.click(textbox());
    expect(onConnectModel).not.toHaveBeenCalled();
  });
});

describe("composer with a prompt that is not about CAD", () => {
  it("keeps the draft when the prompt is refused", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(false);
    render(
      <Composer initial cap={{ provider: "claude" }} onSubmit={onSubmit} />,
    );
    await user.type(textbox(), "Tell me a joke{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(textbox()).toHaveValue("Tell me a joke");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refuses a general prompt before sending or asking for a model", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(),
      onRefused = vi.fn(),
      onConnectModel = vi.fn();
    const cad_scope = {
      term: "\\bbracket",
      size: "\\d\\s*mm",
      unrelated: "\\b(?:poem|hi)\\b",
      cad_code: "\\bopenscad\\b",
      code: "^python$",
      refusal: "Please ask only about CAD generation",
      mixed: "Your prompt also asks for something else",
    };
    render(
      <Composer
        initial
        cap={{ provider: "claude", cad_scope }}
        onSubmit={onSubmit}
        onRefused={onRefused}
        onConnectModel={onConnectModel}
      />,
    );
    await user.type(textbox(), "Hi{Enter}");
    expect(onRefused).toHaveBeenLastCalledWith(
      "Please ask only about CAD generation",
      "warning",
    );
    await user.clear(textbox());
    await user.type(textbox(), "A 40 mm bracket and a poem{Enter}");
    expect(onRefused).toHaveBeenLastCalledWith(
      "Your prompt also asks for something else",
      "warning",
    );
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onConnectModel).not.toHaveBeenCalled();
    expect(textbox()).toHaveValue("A 40 mm bracket and a poem");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    await user.clear(textbox());
    await user.type(textbox(), "A 40 mm bracket{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("passes the refusal code on from the server", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: "Please ask only about CAD generation",
          code: "off_topic",
        }),
        { status: 422 },
      ),
    );
    await expect(
      api("/tasks", { method: "POST", body: { prompt: "Hi" } }),
    ).rejects.toMatchObject({
      status: 422,
      code: "off_topic",
      message: "Please ask only about CAD generation",
    });
    vi.restoreAllMocks();
  });
});
