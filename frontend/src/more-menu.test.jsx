import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MoreMenu } from "./ui.jsx";

describe("more menu", () => {
  it("opens, runs an action and closes, and closes on Escape", async () => {
    const user = userEvent.setup(),
      exported = vi.fn();
    render(
      <MoreMenu>
        <button role="menuitem" onClick={exported}>
          Export session
        </button>
      </MoreMenu>,
    );
    const toggle = screen.getByRole("button", { name: "More actions" });
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("menuitem", { name: "Export session" }));
    expect(exported).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(toggle);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
