import { useCallback, useEffect, useRef, useState } from "react";
import { api, eventCursor } from "./lib.js";

export function useResource(path, revision = 0, keepPrevious = false) {
  const [state, setState] = useState({
    data: null,
    error: null,
    loading: true,
  });
  const [retry, setRetry] = useState(0);
  const previousPath = useRef(path);
  useEffect(() => {
    const controller = new AbortController();
    const preserve = keepPrevious && previousPath.current === path;
    previousPath.current = path;
    setState((old) => ({
      data: preserve ? old.data : null,
      error: null,
      loading: true,
    }));
    api(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted)
          setState({ data, error: null, loading: false });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({ data: null, error, loading: false });
      });
    return () => controller.abort();
  }, [path, revision, retry, keepPrevious]);
  return { ...state, reload: useCallback(() => setRetry((n) => n + 1), []) };
}

export function useTask(id, onChange, onConnection) {
  const [state, setState] = useState({ task: null, activity: [], error: null });
  const refreshRef = useRef(() => Promise.resolve());
  const callbacks = useRef({ onChange, onConnection });
  callbacks.current = { onChange, onConnection };
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let timer,
      reconnectTimer,
      loading = false,
      pending = false;
    let cursor = 0,
      started = false,
      activity = [];
    setState({ task: null, activity: [], error: null });
    const refresh = async () => {
      if (loading) {
        pending = true;
        return;
      }
      loading = true;
      try {
        const task = await api(`/tasks/${id}`, { signal });
        let batch;
        do {
          batch = await api(
            `/tasks/${id}/activity?after=${activity.at(-1)?.seq || 0}&limit=500`,
            { signal },
          );
          activity = [...activity, ...batch];
        } while (batch.length === 500 && !signal.aborted);
        if (!signal.aborted) {
          setState({ task, activity, error: null });
          callbacks.current.onChange(task);
          if (!started) {
            started = true;
            cursor = task.last_event_id || 0;
            void stream();
          }
        }
        return task;
      } catch (error) {
        if (!signal.aborted) setState((s) => ({ ...s, error }));
      } finally {
        loading = false;
        if (pending && !signal.aborted) {
          pending = false;
          void refresh();
        }
      }
    };
    refreshRef.current = refresh;
    const stream = async () => {
      if (signal.aborted) return;
      try {
        const response = await api(`/tasks/${id}/events?after=${cursor}`, {
          raw: true,
          signal,
        });
        callbacks.current.onConnection(true);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder
              .decode(value, { stream: true })
              .replace(/\r\n/g, "\n");
            let boundary;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const next = eventCursor(buffer.slice(0, boundary));
              buffer = buffer.slice(boundary + 2);
              if (next !== null) {
                cursor = Math.max(cursor, next);
                // Throttle rather than debounce: sustained streams still update the UI.
                if (!timer)
                  timer = setTimeout(() => {
                    timer = null;
                    void refresh();
                  }, 180);
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      } catch {
        if (!signal.aborted) callbacks.current.onConnection(false);
      }
      if (!signal.aborted)
        reconnectTimer = setTimeout(() => {
          void refresh();
          void stream();
        }, 2000);
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearTimeout(reconnectTimer);
    };
  }, [id]);
  return { ...state, refresh: useCallback(() => refreshRef.current(), []) };
}
