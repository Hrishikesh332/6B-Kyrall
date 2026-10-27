import { Cpu } from "lucide-react";
// Official product marks from @lobehub/icons-static-svg (MIT). They are served as
// files (?no-inline) because the Content-Security-Policy blocks data: images.
import claude from "@lobehub/icons-static-svg/icons/claudecode-color.svg?no-inline";
import openai from "@lobehub/icons-static-svg/icons/openai.svg?no-inline";
import nvidia from "@lobehub/icons-static-svg/icons/nvidia-color.svg?no-inline";
// Cube mark from the official logo in onshape.com's site header (wordmark removed).
import onshape from "./logos/onshape.svg?no-inline";

const logos = {
  claude: { src: claude, name: "Claude Code" },
  // Single-color mark drawn in currentColor, which an <img> renders black.
  openai: { src: openai, name: "OpenAI", mono: true },
  nvidia: { src: nvidia, name: "NVIDIA" },
  // Its slate half needs a light plate to read on the dark theme.
  onshape: { src: onshape, name: "Onshape", plate: true },
};

export default function ProviderLogo({ provider, size = 18 }) {
  const logo = logos[provider];
  if (!logo) return <Cpu size={size} strokeWidth={1.5} />;
  return (
    <img
      className={`provider-logo${logo.mono ? " is-mono" : ""}${logo.plate ? " is-plate" : ""}`}
      src={logo.src}
      width={size}
      height={size}
      alt={`${logo.name} logo`}
    />
  );
}
