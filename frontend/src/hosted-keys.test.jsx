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
});
