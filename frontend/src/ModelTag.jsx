import { modelLabel } from "./lib.js";
import ProviderLogo from "./ProviderLogo.jsx";

export { modelLabel };

export const modelMaker = (id) =>
  id?.startsWith("claude")
    ? "anthropic"
    : /^(gpt|o\d)/i.test(id || "")
      ? "openai"
      : null;

// The model that answered this chat, with its maker's mark. Runs record the model
// that actually responded, so a fallback to another model shows up here.
export default function ModelTag({ runs }) {
  const used = [
    ...new Set((runs || []).map((r) => r.usage?.model).filter(Boolean)),
  ].filter((m) => modelMaker(m));
  if (!used.length) return null;
  const latest = used.at(-1);
  const maker = modelMaker(latest);
  const company = maker === "anthropic" ? "Anthropic" : "OpenAI";
  const all = used.map((m) => `${modelLabel(m)} (${m})`).join(", ");
  return (
    <span
      className="model-tag"
      title={
        used.length > 1
          ? `Models used in this chat: ${all}`
          : `${company} ${all}`
      }
    >
      <ProviderLogo provider={maker} size={11} />
      {modelLabel(latest)}
      {used.length > 1 && <em>+{used.length - 1}</em>}
    </span>
  );
}
