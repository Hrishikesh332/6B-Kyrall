import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PhotoAttachments from "./PhotoAttachments.jsx";
import { Composer } from "./ui.jsx";

function Harness({ onSubmit, seen }) {
  const [photos, setPhotos] = useState([
    { id: "a", file: new File(["x"], "cup.png", { type: "image/png" }), role: "object" },
    { id: "b", file: new File(["x"], "jaw.png", { type: "image/png" }), role: "object" },
  ]);
  seen.current = photos;
  return (
    <Composer
      cap={{ provider: "claude" }}
      onSubmit={onSubmit}
      hasAttachments={photos.length > 0}
      attachments={<PhotoAttachments photos={photos} onChange={setPhotos} />}
    />
  );
}

describe("chat photo attachments", () => {
  it("tags each photo as object or gripper and sends without text", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: () => "blob:test",
      revokeObjectURL: vi.fn(),
    });
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const seen = { current: null };
    render(<Harness onSubmit={onSubmit} seen={seen} />);
    const second = screen.getByRole("group", { name: "Photo 2 shows" });
    expect(
      screen.getAllByRole("button", { name: "Object", pressed: true }),
    ).toHaveLength(2);
    await user.click(second.querySelector("button:last-child"));
    expect(seen.current.map((p) => p.role)).toEqual(["object", "gripper"]);
    await user.click(screen.getByLabelText("Remove cup.png"));
    expect(seen.current.map((p) => p.file.name)).toEqual(["jaw.png"]);
    await user.click(screen.getByLabelText("Send message"));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "" }),
    );
  });
});
