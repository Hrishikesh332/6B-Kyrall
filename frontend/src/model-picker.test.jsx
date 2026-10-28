import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MODEL_CONNECTION,
  api,
  savedConnection,
  saveConnection,
} from "./lib.js";
import ModelPicker from "./ModelPicker.jsx";

const siteModels = {
  provider: "openai",
  plan: false,
  model: "gpt-6.1-terra",
  models: [
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
    { id: "gpt-6.1-terra", name: "GPT-6.1 Terra" },
  ],
};
const siteCap = {
  provider: "openai",
  model: "gpt-6.1-terra",
  connection_source: "site",
};

const claudeModels = {
  provider: "claude",
  model: "",
  models: [
    { id: "", name: "Default (recommended)", description: "Sonnet 5.5" },
    { id: "opus", name: "Opus 5.5", description: "Complex work" },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

describe("model picker", () => {
  it("lists what Claude Code can reach and saves the choice", async () => {
    const user = userEvent.setup(),
      calls = [],
      onChange = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push([String(url), init?.method || "GET", init?.body]);
      return new Response(JSON.stringify(claudeModels), { status: 200 });
    });
    render(
      <ModelPicker
        cap={{ provider: "claude", connection_source: "workspace" }}
        onChange={onChange}
      />,
    );
    const select = await screen.findByLabelText("Model");
    expect(screen.getByAltText("Claude Code logo")).toBeInTheDocument();
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Default (recommended)",
      "Opus 5.5",
    ]);
    await user.selectOptions(select, "opus");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const put = calls.find(([, method]) => method === "PUT");
    expect(put[0]).toBe("/api/integrations/model/choice");
    expect(JSON.parse(put[2])).toEqual({ model: "opus" });
  });

  it("keeps a hosted choice in this browser", async () => {
    const user = userEvent.setup();
    saveConnection(MODEL_CONNECTION, { provider: "chatgpt", model: "gpt-a" });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            provider: "openai",
            plan: true,
            model: "gpt-a",
            models: [
              { id: "gpt-a", name: "GPT A" },
              { id: "gpt-b", name: "GPT B" },
            ],
          }),
          { status: 200 },
        ),
    );
    render(
      <ModelPicker
        cap={{ provider: "openai", plan: true, connection_source: "browser" }}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: /^Model GPT A/ }),
    );
    // The model list is a step away from the effort slider.
    await user.click(screen.getByRole("button", { name: "GPT A" }));
    await user.click(screen.getByRole("button", { name: "GPT B" }));
    await waitFor(() =>
      expect(savedConnection(MODEL_CONNECTION)).toEqual({
        provider: "chatgpt",
        model: "gpt-b",
      }),
    );
  });

  it("starts a site key choice in this browser", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            provider: "openai",
            plan: false,
            model: "gpt-6.1-terra",
            models: [
              { id: "gpt-6-astra", name: "GPT-6 Astra" },
              { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
              { id: "gpt-6.1-terra", name: "GPT-6.1 Terra" },
            ],
          }),
          { status: 200 },
        ),
    );
    render(
      <ModelPicker
        cap={{
          provider: "openai",
          model: "gpt-6.1-terra",
          connection_source: "site",
        }}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: /^Model GPT-6\.1 Terra/ }),
    );
    await user.click(screen.getByRole("button", { name: "GPT-6.1 Terra" }));
    expect(
      screen.getByRole("button", { name: "GPT-6.1 Terra", pressed: true }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "GPT-6.1 Sol" }));
    // Only the model is kept; the site's key never reaches the browser.
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(MODEL_CONNECTION))).toEqual({
        provider: "openai",
        model: "gpt-6.1-sol",
      }),
    );
  });

  it("picks a reasoning effort that travels with each hosted request", async () => {
    const user = userEvent.setup(),
      onChange = vi.fn();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response(JSON.stringify(siteModels), { status: 200 }),
      );
    render(
      <ModelPicker
        cap={{ ...siteCap, reasoning_effort: "medium" }}
        onChange={onChange}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: /Medium reasoning$/ }),
    );
    const slider = screen.getByRole("slider", { name: "Reasoning effort" });
    expect(slider).toHaveAttribute("aria-valuetext", "Medium");
    expect(
      screen.getByRole("button", { name: "Reset to Medium" }),
    ).toBeDisabled();
    // jsdom does not move a range input on arrow keys, so set it as a key press would.
    fireEvent.change(slider, { target: { value: "3" } });
    fireEvent.keyUp(slider, { key: "ArrowRight" });
    expect(slider).toHaveAttribute("aria-valuetext", "Extra high");
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(MODEL_CONNECTION))).toEqual({
        provider: "openai",
        model: "gpt-6.1-terra",
        effort: "xhigh",
      }),
    );
    expect(onChange).toHaveBeenCalled();
    // The next run asks for it.
    await api("/tasks", { method: "POST", body: {} }).catch(() => {});
    const headers = fetch.mock.calls.at(-1)[1].headers;
    expect(headers.get("X-6B-Effort")).toBe("xhigh");
    await user.click(screen.getByRole("button", { name: "Reset to Medium" }));
    await waitFor(() =>
      expect(savedConnection(MODEL_CONNECTION).effort).toBe("medium"),
    );
  });

  it("saves a local effort on the server and closes on Escape", async () => {
    const user = userEvent.setup(),
      calls = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push([String(url), init?.method || "GET", init?.body]);
      return new Response(JSON.stringify(siteModels), { status: 200 });
    });
    render(
      <ModelPicker
        cap={{
          provider: "openai",
          connection_source: "workspace",
          reasoning_effort: "high",
        }}
        followUp
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: /High reasoning$/ }),
    );
    const slider = screen.getByRole("slider", { name: "Reasoning effort" });
    fireEvent.change(slider, { target: { value: "1" } });
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(calls.some(([, m]) => m === "PUT")).toBe(true));
    const put = calls.find(([, method]) => method === "PUT");
    expect(put[0]).toBe("/api/integrations/model/choice");
    expect(JSON.parse(put[2])).toEqual({
      model: "gpt-6.1-terra",
      effort: "medium",
    });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps a running Claude chat's model as a label", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    render(<ModelPicker cap={{ provider: "claude" }} followUp />);
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows the workshop as a plain label", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    render(<ModelPicker cap={{ provider: "workshop" }} />);
    expect(screen.getByText("Local workshop")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});
