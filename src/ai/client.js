// The Anthropic client: the only place a model is ever called.
//
// It is asked for exactly one thing — a relative weight and a one-sentence basis
// per resident — and it is forced, through tool use, to answer in the same shape
// proposal.js already validates. A forced tool call is a strong hint about the
// shape, not a guarantee: whatever comes back still goes through
// validateProposal() / draftFromProposal(), which is the actual boundary. This
// file only has to get a reply; it is not trusted to get the contract right.
//
// This call is not priced for cost; it is priced for judgment. The
// weights-to-cents conversion in weights.js is deterministic and exact however
// the model answers, so nothing here is ever asked to do arithmetic. What it is
// paid for is reading room facts a landlord typed in free text and writing a
// basis line a tenant would actually accept — a real judgment call, not a
// lookup — on a request that runs roughly twice a year per household. That
// infrequency is why the per-call cost of a stronger model is the wrong thing to
// optimize against: a cheaper model that writes a worse basis line is cheaper
// on a call nobody makes often enough for the savings to matter, and more
// expensive the one time a landlord has to defend the number to a resident.
import Anthropic from "@anthropic-ai/sdk";
import { proposalSchema } from "./proposal.js";
import { AiConfigError, ALLOCATION_MODEL } from "./config.js";

const TOOL_NAME = "propose_rent_weights";
// Opus 5 runs with thinking on by default, and thinking tokens count against
// max_tokens — both raised accordingly (and the timeout with them: reasoning
// over a dozen rooms can run well past 20s with maxRetries:0, which gives a slow
// call nowhere to land but a real, immediate failure).
export const DEFAULT_TIMEOUT_MS = 60000;

export { ALLOCATION_MODEL };

export class WeightProposer {
  constructor({ apiKey, model = ALLOCATION_MODEL, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    // No dry-run fallback. A missing key is a configuration error, reported here,
    // not a quiet switch into pretending a proposal was made.
    if (!apiKey) {
      throw new AiConfigError("WeightProposer needs an API key.", { fix: "Set ANTHROPIC_API_KEY in .env, or run with AI_MODE=off." });
    }
    this.model = model;
    this.anthropic = new Anthropic({ apiKey, fetch: fetchImpl, timeout: timeoutMs, maxRetries: 0 });
    this.name = "anthropic";
    this.available = true;
  }

  describe() { return `Anthropic (${this.model})`; }

  /**
   * Ask for a proposal. Never asked for money, and nothing here reads one.
   *
   * `rooms` is one entry per resident: `{ personId, name, facts }`, where `facts`
   * is whatever qualitative, non-monetary description the caller has — a room
   * label, a floor, "shares the upstairs bathroom". `context` is optional
   * household-level text (a request someone made, a constraint to weigh).
   *
   * Returns the raw tool input, unvalidated. The caller — propose.js — is the one
   * that runs it through validateProposal()/draftFromProposal().
   */
  async proposeWeights({ personIds, rooms, context }) {
    // strict:true, not forced tool_choice: Opus 5 runs with thinking on by
    // default, and a forced tool_choice is not compatible with thinking being
    // enabled. strict mode gets the same guarantee a different way — the schema
    // is enforced on whichever tool call the model makes — so tool_choice can
    // stay at its default ("auto") and the model is steered by naming the tool
    // in the prompt instead of by force.
    const tool = {
      name: TOOL_NAME,
      description:
        "Propose a relative rent weight and a one-sentence basis for each resident of a " +
        "shared house, from room facts. Weights are relative only (1.0 is an ordinary " +
        "room); never propose a dollar amount or a number of cents.",
      input_schema: proposalSchema(personIds),
      strict: true,
    };
    const roomLines = (rooms || [])
      .map((room) => `${room.personId} (${room.name}): ${room.facts && room.facts.trim() ? room.facts.trim() : "no facts given"}`)
      .join("\n");
    const prompt = [
      `A household of ${personIds.length} residents is splitting one monthly rent.`,
      "Here is what is known about each resident's room:",
      "",
      roomLines,
      "",
      context ? `Additional context from the household or landlord: ${context.trim()}` : null,
      "",
      "Propose one relative weight per resident (1.0 = an ordinary room; a nicer or " +
        "larger room is worth more, relative only — never a dollar figure) and the " +
        "one-sentence basis a tenant would accept for each. List in `unknowns` any " +
        `fact that would have changed the proposal and was not given. Use the ${TOOL_NAME} ` +
        "tool to answer — do not answer in plain text.",
    ].filter((line) => line !== null).join("\n");

    const message = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      tools: [tool],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: prompt }],
    });

    const toolUse = message.content.find((block) => block.type === "tool_use" && block.name === TOOL_NAME);
    if (!toolUse) {
      throw new AiConfigError(
        "The model answered without using the required tool, so no proposal was returned.",
        { fix: "Retry. If it persists, check that ANTHROPIC_MODEL names a real model." },
      );
    }
    return toolUse.input;
  }
}
