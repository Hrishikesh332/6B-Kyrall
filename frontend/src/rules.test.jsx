import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import RulesPage from "./RulesPage.jsx";

afterEach(() => vi.restoreAllMocks());

describe("rules", () => {
  it("adds a project rule, turns a rule off and deletes it", async () => {
    const user = userEvent.setup(),
      calls = [];
    let rules = [
      {
        id: "r1",
        content: "Use metric units",
        enabled: 1,
        project_id: null,
        project_name: null,
      },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = String(url),
        method = init?.method || "GET";
      calls.push([method, path, init?.body && JSON.parse(init.body)]);
      if (path.endsWith("/projects"))
        return new Response(JSON.stringify([{ id: "p1", name: "Grippers" }]));
      if (method === "POST") {
        const body = JSON.parse(init.body);
        rules = [
          ...rules,
          {
            id: "r2",
            content: body.content,
            enabled: 1,
            project_id: "p1",
            project_name: "Grippers",
          },
        ];
      }
      if (method === "PATCH")
        rules = [{ ...rules[0], enabled: 0 }, ...rules.slice(1)];
      if (method === "DELETE")
        rules = rules.filter((r) => !path.endsWith(r.id));
      return new Response(JSON.stringify(path.endsWith("/rules") ? rules : {}));
    });
    render(<RulesPage notify={vi.fn()} />);
    expect(await screen.findByText("Use metric units")).toBeInTheDocument();
    await user.type(screen.getByLabelText("New rule"), "Walls at least 2 mm");
    await screen.findByRole("option", { name: "Grippers" });
    await user.selectOptions(screen.getByLabelText("Applies to"), "p1");
    await user.click(screen.getByRole("button", { name: /Add rule/ }));
    expect(await screen.findByText("Walls at least 2 mm")).toBeInTheDocument();
    expect(calls.find(([m]) => m === "POST")[2]).toEqual({
      content: "Walls at least 2 mm",
      project_id: "p1",
      level: "must",
      rule_set: "",
      applies_when: "",
    });
    await user.click(screen.getByLabelText("Turn off: Use metric units"));
    await waitFor(() =>
      expect(
        screen.getByLabelText("Turn on: Use metric units"),
      ).not.toBeChecked(),
    );
    await user.click(
      screen.getByRole("button", { name: "Delete rule: Use metric units" }),
    );
    // Nothing is deleted until the second click confirms it.
    expect(screen.getByText("Use metric units")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete?" }));
    await waitFor(() =>
      expect(screen.queryByText("Use metric units")).toBeNull(),
    );
  });
});
