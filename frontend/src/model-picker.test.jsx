import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MODEL_CONNECTION, savedConnection, saveConnection } from "./lib.js";
import ModelPicker from "./ModelPicker.jsx";

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
    await user.selectOptions(await screen.findByLabelText("Model"), "gpt-b");
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
    const select = await screen.findByLabelText("Model");
    expect(select).toHaveValue("gpt-6.1-terra");
    await user.selectOptions(select, "gpt-6.1-sol");
    // Only the model is kept; the site's key never reaches the browser.
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(MODEL_CONNECTION))).toEqual({
        provider: "openai",
        model: "gpt-6.1-sol",
      }),
    );
  });

  it("shows the workshop as a plain label", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    render(<ModelPicker cap={{ provider: "workshop" }} />);
    expect(screen.getByText("Local workshop")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});
