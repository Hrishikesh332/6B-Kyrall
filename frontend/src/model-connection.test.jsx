import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ModelConnection from "./ModelConnection.jsx";
import IntegrationsPage from "./IntegrationsPage.jsx";
import { modeLabel } from "./lib.js";

const overview = (active = "workshop") => ({
  active: {
    provider: active,
    name: active === "workshop" ? "Local workshop" : "Claude Code",
    source: active === "workshop" ? "environment" : "workspace",
    model: active === "workshop" ? "" : "sonnet",
  },
  providers: [
    {
      id: "claude",
      name: "Claude Code",
      active: active === "claude",
      installed: true,
      sign_in: "claude auth login",
      detail: "Uses the Claude account signed in to Claude Code.",
      model: active === "claude" ? "sonnet" : "",
      models: [
        { id: "", name: "Account default" },
        { id: "sonnet", name: "Sonnet (latest)" },
      ],
      api_key_saved: false,
    },
    {
      id: "workshop",
      name: "Local workshop",
      active: active === "workshop",
      installed: true,
      detail: "Offline recipes.",
    },
    {
      id: "openai",
      name: "OpenAI API",
      active: false,
      installed: true,
      api_key_set: false,
      detail: "Responses API.",
    },
  ],
});

afterEach(() => vi.restoreAllMocks());

describe("model connection", () => {
  it("checks Claude Code and switches to it with the chosen model", async () => {
    const user = userEvent.setup(),
      onChanged = vi.fn(),
      notify = vi.fn(),
      calls = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push([String(url), init?.method || "GET", init?.body]);
      const path = String(url);
      const body = path.endsWith("/integrations/model/check")
        ? { ok: true, message: "Claude Code is signed in as dev@example.com." }
        : init?.method === "PUT"
          ? {
              ...overview("claude"),
              check: { ok: true, message: "Signed in." },
            }
          : overview();
      return new Response(JSON.stringify(body), { status: 200 });
    });
    render(
      <ModelConnection
        onClose={vi.fn()}
        onChanged={onChanged}
        notify={notify}
      />,
    );
    await screen.findByText("from backend/.env", { exact: false });
    expect(screen.getByText("No model", { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Local workshop/ })).toBeNull();
    expect(screen.getByRole("radio", { name: /Claude Code/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByRole("radio", { name: /OpenAI API/ }));
    expect(screen.getByText("OPENAI_API_KEY")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Claude Code/ }));
    expect(screen.getByText("claude auth login")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check" }));
    expect(
      await screen.findByText(/signed in as dev@example.com/),
    ).toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole("combobox", { name: /^Model/ }),
      "sonnet",
    );
    await user.click(screen.getByRole("button", { name: "Use Claude Code" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const put = calls.find(([, method]) => method === "PUT");
    expect(JSON.parse(put[2])).toEqual({ provider: "claude", model: "sonnet" });
    expect(notify).toHaveBeenCalledWith(
      "Claude Code is now running your tasks.",
    );
    expect(
      screen.getByText("chosen in this workspace", { exact: false }),
    ).toBeInTheDocument();
  });

  it("shows why a connection was refused", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) =>
      init?.method === "PUT"
        ? new Response(
            JSON.stringify({
              detail: "Claude Code is installed but not signed in.",
            }),
            { status: 422 },
          )
        : new Response(JSON.stringify(overview()), { status: 200 }),
    );
    render(<ModelConnection onClose={vi.fn()} />);
    await user.click(await screen.findByRole("radio", { name: /Claude Code/ }));
    await user.click(screen.getByRole("button", { name: "Use Claude Code" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "not signed in",
    );
  });

  it("opens from the integrations catalog and labels the active provider", async () => {
    const user = userEvent.setup(),
      setModal = vi.fn();
    render(
      <IntegrationsPage
        cap={{ provider: "claude", integrations: [] }}
        setModal={setModal}
      />,
    );
    const card = screen.getByRole("button", {
      name: "Claude Code — Connected",
    });
    expect(within(card).getByAltText("Claude Code logo")).toBeInTheDocument();
    await user.click(card);
    expect(setModal).toHaveBeenCalledWith({
      kind: "model",
      provider: "claude",
    });
    expect(modeLabel({ provider: "claude" })).toBe("Claude Code");
    expect(modeLabel({ provider: "workshop" })).toBe("Local workshop");
  });

  it("preselects the provider chosen from the catalog", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify(overview()), { status: 200 }),
    );
    render(<ModelConnection onClose={vi.fn()} initialProvider="claude" />);
    expect(
      await screen.findByRole("radio", { name: /Claude Code/ }),
    ).toHaveAttribute("aria-checked", "true");
  });
});
