import { useState } from "react";

// The appearance picked in Workspace settings: "dark" (the default), "light", or "system"
// to follow the operating system. Kept per browser.
const KEY = "6b-appearance";
const choices = new Set(["dark", "light", "system"]);
const lightQuery = () =>
  typeof matchMedia === "function"
    ? matchMedia("(prefers-color-scheme: light)")
    : null;

export function storedAppearance() {
  try {
    const saved = localStorage.getItem(KEY);
    return choices.has(saved) ? saved : "dark";
  } catch {
    return "dark";
  }
}

export function applyAppearance(choice) {
  const light =
    choice === "light" || (choice === "system" && !!lightQuery()?.matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", light ? "#ffffff" : "#181818");
}

// Applies the saved appearance before the first render, then follows the system theme
// while "system" is picked.
export function startAppearance() {
  applyAppearance(storedAppearance());
  lightQuery()?.addEventListener("change", () =>
    applyAppearance(storedAppearance()),
  );
}

export function useAppearance() {
  const [choice, setChoice] = useState(storedAppearance);
  const choose = (next) => {
    setChoice(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Private windows may refuse storage; the choice still holds until reload.
    }
    applyAppearance(next);
  };
  return [choice, choose];
}
