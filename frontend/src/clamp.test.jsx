import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Clamp } from "./ui.jsx";

// jsdom has no layout; pretend the clamped body is taller than its box.
const overflow = (scroll, client) => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
    scroll,
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
    client,
  );
};

afterEach(() => vi.restoreAllMocks());

describe("clamp", () => {
  it("offers Show more only when the text overflows, and toggles it", async () => {
    overflow(400, 100);
    const user = userEvent.setup();
    render(
      <Clamp lines={2}>
        <p>A long note</p>
      </Clamp>,
    );
    const toggle = screen.getByRole("button", { name: "Show more" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("A long note").parentElement).not.toHaveClass(
      "is-clamped",
    );
  });

  it("stays quiet for short text", () => {
    overflow(40, 100);
    render(
      <Clamp>
        <p>Short</p>
      </Clamp>,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
