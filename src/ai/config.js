// Local AI configuration: which mode is in play, and the one credential it needs.
//
// Mirrors src/payments/config.js on purpose. Two modes, chosen from the
// environment and never guessed: "off" (default — nothing calls a model) and
// "anthropic" (a weight proposal may be requested). A missing key in "anthropic"
// mode is a configuration error that stops the server, not a quiet fallback to
// typed-only — the alternative is an interface that looks AI-assisted and is not.
export const MODES = ["off", "anthropic"];
// Named for what it does, not what it costs: a messaging-triage model or anything
// else cheap can sit beside this one later without the name claiming it's the
// only concern that matters. See src/ai/client.js for why this call is priced the
// way it is.
export const ALLOCATION_MODEL = "claude-opus-5-5";

export class AiConfigError extends Error {
  constructor(message, { fix } = {}) { super(message); this.name = "AiConfigError"; this.fix = fix; }
}

export function resolveMode(env = process.env) {
  const mode = env.AI_MODE || "off";
  if (!MODES.includes(mode)) {
    throw new AiConfigError(`AI_MODE must be one of ${MODES.join(" or ")}, not "${mode}".`, { fix: "Set AI_MODE in .env" });
  }
  return mode;
}
