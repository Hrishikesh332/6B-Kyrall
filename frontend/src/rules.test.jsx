import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import RulesPage from "./RulesPage.jsx";
import TaskRules from "./TaskRules.jsx";

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

  it("searches, filters by level, edits inline and switches a whole set", async () => {
    const user = userEvent.setup(),
      patches = [];
    let rules = [
      { id: "r1", content: "Use metric units", enabled: 1, level: "must" },
      {
        id: "r2",
        content: "Walls at least 2 mm",
        enabled: 1,
        level: "must",
        rule_set: "FDM",
        applies_when: "Printed parts",
      },
      {
        id: "r3",
        content: "Flat faces on the bed",
        enabled: 1,
        level: "should",
        rule_set: "FDM",
        applies_when: "Printed parts",
      },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = String(url);
      if (init?.method === "PATCH") {
        const body = JSON.parse(init.body),
          id = path.split("/").at(-1);
        patches.push([id, body]);
        rules = rules.map((r) => (r.id === id ? { ...r, ...body } : r));
      }
      return new Response(JSON.stringify(path.endsWith("/rules") ? rules : []));
    });
    render(<RulesPage notify={vi.fn()} />);
    await screen.findByText("Use metric units");

    await user.type(screen.getByLabelText("Search rules"), "walls");
    expect(screen.queryByText("Use metric units")).toBeNull();
    expect(screen.getByText("Walls", { selector: "mark" })).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Search rules"));

    const show = within(screen.getByRole("radiogroup", { name: "Show rules" }));
    await user.click(show.getByRole("radio", { name: "Should" }));
    expect(screen.getByText("Flat faces on the bed")).toBeInTheDocument();
    expect(screen.queryByText("Use metric units")).toBeNull();
    await user.click(show.getByRole("radio", { name: "All" }));

    await user.click(
      screen.getByRole("button", { name: "Edit rule: Use metric units" }),
    );
    const editor = screen.getByLabelText("Edit rule");
    await user.clear(editor);
    await user.type(editor, "Use metric units only{Enter}");
    await waitFor(() =>
      expect(patches).toContainEqual([
        "r1",
        { content: "Use metric units only" },
      ]),
    );

    await user.click(screen.getByLabelText("Turn off all rules in FDM"));
    await waitFor(() =>
      expect(patches).toEqual(
        expect.arrayContaining([
          ["r2", { enabled: false }],
          ["r3", { enabled: false }],
        ]),
      ),
    );
    expect(
      await screen.findByLabelText("Turn on all rules in FDM"),
    ).not.toBeChecked();
  });

  it("shows a chat's check results and lets you skip a rule set", async () => {
    const user = userEvent.setup(),
      puts = [];
    const sets = [
      {
        rule_set: "",
        status: "always",
        rules: [
          {
            id: "a",
            level: "must",
            text: "Metric units",
            check: { status: "met" },
          },
        ],
      },
      {
        rule_set: "FDM",
        status: "applied",
        conditional: true,
        decision: { decided_by: "agent", reason: "Parts are printed." },
        rules: [
          {
            id: "b",
            level: "must",
            text: "Fits the bed",
            check: { status: "met" },
          },
          {
            id: "c",
            level: "should",
            text: "Thin walls",
            check: { status: "not_met" },
          },
        ],
      },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (init?.method === "PUT") puts.push(JSON.parse(init.body));
      return new Response(JSON.stringify(sets));
    });
    render(
      <TaskRules task={{ id: "t1", last_event_id: 1 }} notify={vi.fn()} />,
    );
    expect(
      await screen.findByRole("img", { name: "2 of 3 checks met" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 not met")).toBeInTheDocument();
    expect(screen.getByText("1/2 met")).toHaveClass("is-failing");
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() =>
      expect(puts).toEqual([{ rule_set: "FDM", apply: false }]),
    );
  });
});
