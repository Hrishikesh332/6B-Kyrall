import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ModelConnection from "./ModelConnection.jsx";
import {
  MODEL_CONNECTION,
  ONSHAPE_CONNECTION,
  api,
  connectionHeaders,
  savedConnection,
  saveConnection,
} from "./lib.js";

// Hosted 6B: each browser keeps its own keys; the server only sees them on use.
const overview = (headers = {}) => {
  const provider = headers["x-6b-provider"] || "workshop";
  return {
    hosted: true,
    active: {
      provider,
      name: provider === "claude" ? "Claude Code" : "Local workshop",
      source: "browser",
      model: headers["x-6b-model"] || "",
    },
    providers: [
      {
        id: "claude",
        name: "Claude Code",
        active: provider === "claude",
        installed: true,
        models: [
          { id: "", name: "Account default" },
          { id: "sonnet", name: "Sonnet (latest)" },
        ],
        api_key_saved: false,
      },
      {
        id: "workshop",
        name: "Local workshop",
        active: provider === "workshop",
        installed: true,
      },
      {
        id: "openai",
        name: "OpenAI API",
        active: provider === "openai",
        installed: true,
      },
    ],
  };
};
const headersOf = (init) =>
  Object.fromEntries(
    [...new Headers(init?.headers).entries()].map(([k, v]) => [
      k.toLowerCase(),
      v,
    ]),
  );

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

describe("hosted keys", () => {
  it("checks the key live, then keeps it only in this tab", async () => {
    const user = userEvent.setup(),
      calls = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = String(url);
      calls.push([path, init?.method || "GET", init?.body, headersOf(init)]);
      const body = path.endsWith("/integrations/model/check")
        ? { ok: true, message: "Anthropic accepted the key." }
        : overview(headersOf(init));
      return new Response(JSON.stringify(body), { status: 200 });
    });
    render(<ModelConnection onClose={() => {}} />);
    await user.type(
      await screen.findByLabelText("Anthropic API key"),
      "sk-ant-mine",
    );
    await user.selectOptions(screen.getByLabelText("Model"), "sonnet");
    await user.click(screen.getByRole("button", { name: "Use Claude Code" }));
    await waitFor(() =>
      expect(savedConnection(MODEL_CONNECTION)).toEqual({
        provider: "claude",
        model: "sonnet",
        key: "sk-ant-mine",
      }),
    );
    expect(localStorage.getItem(MODEL_CONNECTION)).toBeNull();
    const check = calls.find(([p]) => p.endsWith("/integrations/model/check"));
    expect(JSON.parse(check[2])).toEqual({
      provider: "claude",
      model: "sonnet",
      api_key: "sk-ant-mine",
    });
    // Never sent to the server to be saved.
    expect(calls.some(([, method]) => method === "PUT")).toBe(false);
    expect(
      await screen.findByText(/your key, saved in this browser/),
    ).toBeTruthy();
    // Reloading the overview names the provider, never the key.
    const last = calls.at(-1)[3];
    expect(last["x-6b-provider"]).toBe("claude");
    expect(last["x-6b-key"]).toBeUndefined();
  });

  it("saves Claude's key to the Google account, keeping none in the browser", async () => {
    const user = userEvent.setup(),
      calls = [];
    let saved = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = String(url),
        method = init?.method || "GET";
      calls.push([path, method, init?.body, headersOf(init)]);
      if (path.endsWith("/integrations/model/account-key"))
        saved = method === "PUT";
      const body = overview(headersOf(init));
      body.providers[0].account_key = {
        available: true,
        saved,
        hint: saved ? "mine" : "",
        model: saved ? "sonnet" : "",
      };
      if (headersOf(init)["x-6b-account-key"]) body.active.source = "account";
      return new Response(
        JSON.stringify(
          path.endsWith("/account-key") ? body.providers[0].account_key : body,
        ),
        { status: 200 },
      );
    });
    render(<ModelConnection onClose={() => {}} />);
    await user.type(
      await screen.findByLabelText("Anthropic API key"),
      "sk-ant-mine",
    );
    await user.selectOptions(screen.getByLabelText("Model"), "sonnet");
    await user.click(screen.getByRole("button", { name: "Use Claude Code" }));
    await waitFor(() =>
      expect(savedConnection(MODEL_CONNECTION)).toEqual({
        provider: "claude",
        model: "sonnet",
        account: true,
      }),
    );
    const put = calls.find(
      ([p, m]) => p.endsWith("/account-key") && m === "PUT",
    );
    expect(JSON.parse(put[2])).toEqual({
      api_key: "sk-ant-mine",
      model: "sonnet",
    });
    expect(
      await screen.findByText(/your key, saved to your Google account/),
    ).toBeTruthy();
    expect(
      screen.getByPlaceholderText("Saved to your Google account · …mine"),
    ).toBeTruthy();
    expect(connectionHeaders("/tasks", "POST")).toEqual({
      "X-6B-Provider": "claude",
      "X-6B-Model": "sonnet",
      "X-6B-Account-Key": "1",
    });
  });

  it("sends the key only with requests that start a run", () => {
    saveConnection(MODEL_CONNECTION, {
      provider: "openai",
      model: "gpt-x",
      key: "sk-secret",
    });
    expect(connectionHeaders("/tasks", "POST")["X-6B-Key"]).toBe("sk-secret");
    expect(connectionHeaders("/tasks/t1/messages", "POST")["X-6B-Key"]).toBe(
      "sk-secret",
    );
    expect(connectionHeaders("/tasks/t1/retry", "POST")["X-6B-Key"]).toBe(
      "sk-secret",
    );
    expect(
      connectionHeaders("/tasks/t1/approvals/a1", "POST")["X-6B-Key"],
    ).toBe("sk-secret");
    expect(
      connectionHeaders("/tasks/t1/questions/q1/answer", "POST")["X-6B-Key"],
    ).toBe("sk-secret");
    for (const [path, method] of [
      ["/tasks", "GET"],
      ["/tasks/t1", "PATCH"],
      ["/tasks/t1/uploads", "POST"],
      ["/capabilities", "GET"],
      ["/rules", "POST"],
    ])
      expect(connectionHeaders(path, method)["X-6B-Key"]).toBeUndefined();
    expect(connectionHeaders("/capabilities")).toEqual({
      "X-6B-Provider": "openai",
      "X-6B-Model": "gpt-x",
    });
  });

  it("remembers keys on the device only when asked, and sends Onshape keys only to Onshape", async () => {
    saveConnection(
      ONSHAPE_CONNECTION,
      {
        base_url: "https://cad.onshape.com",
        access_key: "acc",
        secret_key: "sec",
      },
      true,
    );
    expect(sessionStorage.getItem(ONSHAPE_CONNECTION)).toBeNull();
    expect(connectionHeaders("/onshape/documents")["X-6B-Onshape-Secret"]).toBe(
      "sec",
    );
    expect(
      connectionHeaders("/integrations/onshape/test", "POST")[
        "X-6B-Onshape-Access"
      ],
    ).toBe("acc");
    expect(
      connectionHeaders("/tasks", "POST")["X-6B-Onshape-Secret"],
    ).toBeUndefined();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await api("/onshape/documents?q=x");
    expect(headersOf(fetch.mock.calls[0][1])["x-6b-onshape-url"]).toBe(
      "https://cad.onshape.com",
    );
  });

  it("signs in with ChatGPT and keeps no ChatGPT secret in the browser", async () => {
    const user = userEvent.setup(),
      calls = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = String(url),
        method = init?.method || "GET";
      calls.push([path, method]);
      const body = path.endsWith("/integrations/chatgpt/models")
        ? { models: [{ id: "gpt-plan", name: "GPT Plan" }] }
        : path.endsWith("/integrations/chatgpt")
          ? {
              available: true,
              signed_in: true,
              plan_usage: true,
              email: "ada@example.com",
              usage_url: "https://chatgpt.com/settings/usage",
            }
          : overview(headersOf(init));
      return new Response(JSON.stringify(body), { status: 200 });
    });
    render(<ModelConnection onClose={() => {}} initialProvider="openai" />);
    expect(
      await screen.findByText(/Signed in with ChatGPT as ada@example.com/),
    ).toBeTruthy();
    await user.click(
      await screen.findByRole("button", { name: "Use my ChatGPT plan" }),
    );
    await waitFor(() =>
      expect(savedConnection(MODEL_CONNECTION)).toEqual({
        provider: "chatgpt",
        model: "gpt-plan",
      }),
    );
    // Runs name the plan; the token is found on the server from the sign-in cookie.
    const headers = connectionHeaders("/tasks", "POST");
    expect(headers["X-6B-Provider"]).toBe("chatgpt");
    expect(headers["X-6B-Key"]).toBeUndefined();
    expect(
      calls.some(([p, m]) => p.endsWith("/integrations/model") && m === "PUT"),
    ).toBe(false);
  });

  it("runs OpenAI on the site's own key, choosing only the model", async () => {
    const user = userEvent.setup();
    const models = [
      { id: "gpt-6-astra", name: "GPT-6 Astra" },
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
      { id: "gpt-6.1-terra", name: "GPT-6.1 Terra" },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const base = overview(headersOf(init)),
        model = headersOf(init)["x-6b-model"] || "gpt-6.1-terra";
      const body = {
        ...base,
        active: {
          provider: "openai",
          name: "OpenAI API",
          source: "site",
          model,
        },
        providers: base.providers.map((p) =>
          p.id === "openai"
            ? { ...p, active: true, site_key: true, model, models }
            : { ...p, active: false },
        ),
      };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    render(<ModelConnection onClose={() => {}} />);
    // A browser with nothing saved starts on the site's key and GPT-6.1 Terra.
    expect(
      (await screen.findByText(/· this site’s OpenAI API key/)).textContent,
    ).toMatch(/^GPT-6\.1 Terra · /);
    const select = screen.getByLabelText("Model");
    expect(select).toHaveValue("gpt-6.1-terra");
    expect([...select.options].map((o) => o.text)).toEqual([
      "GPT-6 Astra",
      "GPT-6.1 Sol",
      "GPT-6.1 Terra",
    ]);
    expect(screen.queryByLabelText("OpenAI API key")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Continue with ChatGPT" }),
    ).toBeNull();
    await user.selectOptions(select, "gpt-6.1-sol");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(savedConnection(MODEL_CONNECTION)).toEqual({
        provider: "openai",
        model: "gpt-6.1-sol",
      }),
    );
    expect(connectionHeaders("/tasks", "POST")["X-6B-Key"]).toBeUndefined();
  });

  it("explains when this website is not approved for ChatGPT sign-in", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const body = String(url).endsWith("/integrations/chatgpt")
        ? {
            available: false,
            reason:
              "Sign in with ChatGPT needs OpenAI’s approval for this website.",
          }
        : overview(headersOf(init));
      return new Response(JSON.stringify(body), { status: 200 });
    });
    render(<ModelConnection onClose={() => {}} initialProvider="openai" />);
    expect(await screen.findByText(/needs OpenAI’s approval/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Continue with ChatGPT" }),
    ).toBeNull();
    // On the web ChatGPT connects only through its sign-in: no API key to fall back on.
    expect(screen.queryByLabelText("OpenAI API key")).toBeNull();
  });

  it("offers the visitor's own ChatGPT plan beside the site's key once approved", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = String(url);
      const base = overview(headersOf(init));
      const body = path.endsWith("/integrations/chatgpt")
        ? { available: true, signed_in: false }
        : {
            ...base,
            active: {
              provider: "openai",
              name: "OpenAI API",
              source: "site",
              model: "gpt-6.1-terra",
            },
            providers: base.providers.map((p) =>
              p.id === "openai"
                ? {
                    ...p,
                    active: true,
                    site_key: true,
                    chatgpt_sign_in: true,
                    model: "gpt-6.1-terra",
                    models: [{ id: "gpt-6.1-terra", name: "GPT-6.1 Terra" }],
                  }
                : p,
            ),
          };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    render(<ModelConnection onClose={() => {}} initialProvider="openai" />);
    expect(
      await screen.findByText("Runs on this site’s OpenAI API key."),
    ).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: /Continue with ChatGPT/ }),
    ).toBeTruthy();
  });
});
