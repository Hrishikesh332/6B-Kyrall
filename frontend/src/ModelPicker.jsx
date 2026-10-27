import { useEffect, useState } from "react";
import {
  MODEL_CONNECTION,
  api,
  modeLabel,
  rememberedConnection,
  saveConnection,
  savedConnection,
} from "./lib.js";
import ProviderLogo from "./ProviderLogo.jsx";

const MODEL_PROVIDERS = ["claude", "openai"];

// The model a new project runs on, listed from what the connected account can use:
// Claude Code's own model list, or the ChatGPT plan's. Picking one changes the
// connection's model, so later runs use it too.
export default function ModelPicker({ cap, onChange }) {
  const [list, setList] = useState(null),
    [value, setValue] = useState(""),
    [busy, setBusy] = useState(false);
  const hasModels = MODEL_PROVIDERS.includes(cap?.provider);
  useEffect(() => {
    if (!hasModels) return;
    let live = true;
    api("/integrations/model/models")
      .then((r) => {
        if (!live) return;
        setList(r.models);
        setValue(r.model || "");
      })
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [hasModels, cap?.plan, cap?.model]);

  if (!hasModels || !list || list.length < 2)
    return (
      <span className="composer-model">
        {hasModels ? (
          <ProviderLogo provider={cap.provider} size={13} />
        ) : (
          <span className="status-dot" />
        )}
        {modeLabel(cap)}
      </span>
    );

  // A model saved earlier but not listed now still shows as the current choice.
  const options = list.some((m) => m.id === value)
    ? list
    : [{ id: value, name: value || "Account default" }, ...list];
  const choose = async (model) => {
    const previous = value;
    setValue(model);
    setBusy(true);
    try {
      if (cap.connection_source === "browser") {
        // Hosted: the connection lives in this browser; only its model changes.
        const saved = savedConnection(MODEL_CONNECTION);
        saveConnection(
          MODEL_CONNECTION,
          { ...saved, model },
          rememberedConnection(MODEL_CONNECTION),
        );
      } else {
        await api("/integrations/model/choice", {
          method: "PUT",
          body: { model },
        });
      }
      await onChange?.();
    } catch {
      setValue(previous);
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="composer-model model-picker">
      <ProviderLogo provider={cap.provider} size={13} />
      <select
        aria-label="Model"
        value={value}
        disabled={busy}
        onChange={(e) => choose(e.target.value)}
      >
        {options.map((m) => (
          <option key={m.id} value={m.id} title={m.description || undefined}>
            {m.name}
          </option>
        ))}
      </select>
    </label>
  );
}
