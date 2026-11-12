// Resolving the AI mode. The only place that decides whether a model is called.
//
// Mirrors src/payments/provider.js. Server mode calls this at startup, so a
// misconfigured ANTHROPIC_API_KEY is a failure to start, not a surprise three
// clicks into a demo — the same discipline PayPal sandbox mode already gets.
import { resolveMode, AiConfigError } from "./config.js";
import { WeightProposer, ALLOCATION_MODEL } from "./client.js";

export function resolveAi({ env = process.env, fetchImpl } = {}) {
  const mode = resolveMode(env);
  if (mode === "off") {
    return { mode, client: null, available: false };
  }
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AiConfigError(
      "AI_MODE=anthropic needs ANTHROPIC_API_KEY, which is not set.",
      { fix: "Set ANTHROPIC_API_KEY in .env, or run with AI_MODE=off." },
    );
  }
  const model = env.ANTHROPIC_MODEL || ALLOCATION_MODEL;
  const client = new WeightProposer({ apiKey, model, fetchImpl });
  return { mode, client, available: true };
}
