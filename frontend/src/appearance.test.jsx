import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppearancePicker } from "./App.jsx";
import { startAppearance, storedAppearance } from "./appearance.js";

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("appearance", () => {
  it("starts dark and ignores unknown saved values", () => {
    expect(storedAppearance()).toBe("dark");
    localStorage.setItem("6b-appearance", "sepia");
    startAppearance();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("switches the theme from workspace settings and remembers it", async () => {
    const user = userEvent.setup();
    render(<AppearancePicker />);
    screen.getByRole("radiogroup", { name: "Appearance" });
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("6b-appearance")).toBe("light");

    // The test environment's system preference is light.
    await user.click(screen.getByRole("radio", { name: "System" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(storedAppearance()).toBe("system");

    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
