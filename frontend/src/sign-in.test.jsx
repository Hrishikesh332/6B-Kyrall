import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "./App.jsx";

const json = (body, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );

// jsdom has no scrolling; App scrolls to the top on each route.
beforeEach(() => vi.stubGlobal("scrollTo", () => {}));
afterEach(() => vi.unstubAllGlobals());

const stubWorkspace = (account) =>
  vi.stubGlobal(
    "fetch",
    vi.fn((url) =>
      json(
        url === "/api/auth/config"
          ? account
          : url.startsWith("/api/tasks")
            ? { items: [], total: 0 }
            : url === "/api/projects"
              ? []
              : { provider: "workshop", tools: [], integrations: [] },
      ),
    ),
  );

describe("Google sign-in", () => {
  it("shows only the sign-in screen when the server requires an account", async () => {
    const fetch = vi.fn((url) =>
      url === "/api/auth/config"
        ? json({
            enabled: true,
            required: true,
            firebase: { apiKey: "web-key", projectId: "demo" },
            user: null,
          })
        : json({ detail: "Sign in", sign_in: "google" }, 401),
    );
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    expect(
      await screen.findByRole("button", { name: "Continue with Google" }),
    ).toBeInTheDocument();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/auth/config"]);
  });

  it("offers Sign in with Google in the top right of a personal workspace", async () => {
    stubWorkspace({ enabled: true, required: false, firebase: {}, user: null });
    render(<App />);
    const button = await screen.findByRole("button", {
      name: "Sign in with Google",
    });
    expect(button.closest(".workspace-topbar")).not.toBeNull();
    expect(
      screen.getByText("Personal workspace", { selector: "strong" }),
    ).toBeInTheDocument();
  });

  it("shows the signed-in account in the sidebar and the top right", async () => {
    const user = {
      uid: "a",
      email: "ada@example.com",
      name: "Ada Lovelace",
      picture: "",
    };
    stubWorkspace({ enabled: true, required: false, firebase: {}, user });
    render(<App />);
    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Account: ada@example.com" }),
    ).toHaveTextContent("Ada");
    expect(
      screen.queryByRole("button", { name: "Sign in with Google" }),
    ).toBeNull();
  });
});
