import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ModelTag, { modelLabel, modelMaker } from "./ModelTag.jsx";

describe("model tag", () => {
  it("names models the way people say them", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-sonnet-5")).toBe("Sonnet 5");
    expect(modelLabel("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(modelLabel("gpt-5.1")).toBe("GPT-5.1");
    expect(modelMaker("claude-haiku-5-5")).toBe("anthropic");
    expect(modelMaker("gpt-5.1")).toBe("openai");
    expect(modelMaker("workshop")).toBe(null);
  });

  it("shows the latest model with the maker's logo and lists a fallback", () => {
    render(
      <ModelTag
        runs={[
          { usage: { model: "claude-opus-5-5" } },
          { usage: {} },
          { usage: { model: "claude-sonnet-5" } },
        ]}
      />,
    );
    const tag = screen.getByText("Sonnet 5").closest(".model-tag");
    expect(tag).toHaveAttribute(
      "title",
      "Models used in this chat: Opus 5.5 (claude-opus-5-5), Sonnet 5 (claude-sonnet-5)",
    );
    expect(screen.getByAltText("Anthropic logo")).toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument();
  });

  it("stays hidden for the local workshop", () => {
    const { container } = render(
      <ModelTag runs={[{ usage: { model: "workshop" } }]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
