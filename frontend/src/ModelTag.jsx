import ProviderLogo from "./ProviderLogo.jsx";

// "claude-opus-5-5" -> "Opus 5.5", "claude-sonnet-4-5-20250929" -> "Sonnet 4.5", "gpt-5.1" -> "GPT-5.1".
export function modelLabel(id) {
  if (!id) return "";
  if (id.startsWith("claude-")) {
    const [family, ...version] = id
      .slice(7)
      .split("-")
      .filter((part) => !/^\d{8}$/.test(part));
    return `${family[0].toUpperCase()}${family.slice(1)} ${version.join(".")}`.trim();
  }
  return id.replace(/^gpt/i, "GPT");
}

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
        used.length > 1 ? `Models used in this chat: ${all}` : `${company} ${all}`
      }
    >
      <ProviderLogo provider={maker} size={11} />
      {modelLabel(latest)}
      {used.length > 1 && <em>+{used.length - 1}</em>}
    </span>
  );
}
