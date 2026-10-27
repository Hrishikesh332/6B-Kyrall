import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useTask } from "./hooks.js";

it("recovers from initial load failure, streams later updates, and aborts on unmount", async () => {
  let failInitial = true,
    version = 1,
    eventController,
    eventSignal;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    if (url.includes("/events?")) {
      eventSignal = options.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            eventController = controller;
            options.signal.addEventListener("abort", () => controller.close(), {
              once: true,
            });
          },
        }),
      );
    }
    if (url.includes("/activity?")) return new Response("[]");
    if (failInitial) {
      failInitial = false;
      throw new Error("Server offline");
    }
    return new Response(
      JSON.stringify({
        id: "test-task",
        title: `Version ${version}`,
        last_event_id: 0,
      }),
    );
  });
  const onChange = vi.fn(),
    onConnection = vi.fn();
  const { result, unmount } = renderHook(() =>
    useTask("test-task", onChange, onConnection),
  );
  await waitFor(() =>
    expect(result.current.error?.message).toBe("Server offline"),
  );
  await act(async () => {
    await result.current.refresh();
  });
  await waitFor(() => expect(onConnection).toHaveBeenCalledWith(true));
  expect(result.current.task.title).toBe("Version 1");
  version = 2;
  act(() =>
    eventController.enqueue(
      new TextEncoder().encode("id: 4\nevent: task.updated\ndata: {}\n\n"),
    ),
  );
  await waitFor(() => expect(result.current.task.title).toBe("Version 2"));
  unmount();
  expect(eventSignal.aborted).toBe(true);
});

it("retrieves every activity page instead of truncating long-running tasks", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    if (url.includes("/events?"))
      return new Response(
        new ReadableStream({
          start(controller) {
            options.signal.addEventListener("abort", () => controller.close(), {
              once: true,
            });
          },
        }),
      );
    if (url.includes("/activity?after=0"))
      return new Response(
        JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ seq: i + 1 }))),
      );
    if (url.includes("/activity?after=500"))
      return new Response(JSON.stringify([{ seq: 501 }]));
    return new Response(
      JSON.stringify({ id: "test-task", last_event_id: 501 }),
    );
  });
  const { result } = renderHook(() => useTask("test-task", vi.fn(), vi.fn()));
  await waitFor(() => expect(result.current.activity).toHaveLength(501));
});
