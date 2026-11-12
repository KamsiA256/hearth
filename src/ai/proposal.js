// What the model is allowed to say, and what happens when it says something else.
//
// This is the contract with the model, enforced in code rather than hoped for in a
// prompt. A proposal that does not fit is refused with a reason — never repaired
// quietly, because a silently corrected proposal is one nobody reviews.
//
// The rule the rest of the system depends on: a proposal carries weights and
// reasoning. It carries no money. If a model ever returns cents, that is a refusal,
// not a shortcut — see MONEY_FIELDS below.

import { allocationFromWeights, reconciles } from "./weights.js";

export class ProposalError extends Error {
  constructor(message) { super(message); this.name = "ProposalError"; this.code = "BAD_PROPOSAL"; }
}

// Names a model might reach for if it decided to do the arithmetic itself. Their
// presence means the boundary has been crossed, whatever the numbers say.
const MONEY_FIELDS = ["cents", "amount", "amountCents", "share", "shareCents", "dollars", "rent"];

const refuse = (message) => { throw new ProposalError(message); };

/**
 * The JSON shape requested of the model. Exported so the prompt and the validator
 * cannot drift apart: both read this.
 */
export function proposalSchema(personIds) {
  return {
    type: "object",
    properties: {
      weights: {
        type: "object",
        description:
          "One weight per resident, keyed by person id. Relative only — 1.0 is an " +
          "ordinary room, 1.2 is worth a fifth more than an ordinary room. Never an " +
          "amount of money.",
        properties: Object.fromEntries(personIds.map((id) => [id, { type: "number" }])),
        required: [...personIds],
        additionalProperties: false,
      },
      basis: {
        type: "object",
        description: "For each resident, the observed facts that produced their weight, in one sentence a tenant would accept.",
        properties: Object.fromEntries(personIds.map((id) => [id, { type: "string" }])),
        required: [...personIds],
        additionalProperties: false,
      },
      unknowns: {
        type: "array",
        description: "Facts that would have changed the proposal and were not available. Empty if none.",
        items: { type: "string" },
      },
    },
    required: ["weights", "basis", "unknowns"],
    additionalProperties: false,
  };
}

/**
 * Validate a raw model response against the household it was asked about.
 *
 * Returns a normalized proposal. Throws ProposalError with a readable reason
 * otherwise — the reason is shown to the operator, so it is written for a person.
 */
export function validateProposal(raw, { personIds }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse("The proposal was not a JSON object.");

  const money = MONEY_FIELDS.filter((field) => field in raw);
  if (money.length > 0) {
    refuse(
      `The proposal carries ${money.join(", ")}. A proposal may only carry weights; ` +
      `the amounts are worked out from them, so a proposal that names money is refused rather than used.`,
    );
  }

  const { weights, basis, unknowns } = raw;
  if (!weights || typeof weights !== "object" || Array.isArray(weights)) refuse("The proposal has no weights object.");
  if (!basis || typeof basis !== "object" || Array.isArray(basis)) refuse("The proposal has no basis object.");
  if (!Array.isArray(unknowns)) refuse("The proposal has no unknowns list. An empty list is the way to say nothing is missing.");

  const proposed = Object.keys(weights);
  const missing = personIds.filter((id) => !proposed.includes(id));
  const invented = proposed.filter((id) => !personIds.includes(id));
  if (missing.length > 0) refuse(`The proposal leaves out ${missing.join(", ")}. Every resident needs a share.`);
  if (invented.length > 0) refuse(`The proposal names ${invented.join(", ")}, who is not on this lease.`);

  for (const id of personIds) {
    if (typeof basis[id] !== "string" || basis[id].trim() === "") {
      refuse(`The proposal gives ${id} a weight with no stated basis. An unexplained share is not reviewable.`);
    }
  }
  if (unknowns.some((note) => typeof note !== "string")) refuse("Every entry in unknowns must be text.");

  return {
    weights: Object.fromEntries(personIds.map((id) => [id, weights[id]])),
    basis: Object.fromEntries(personIds.map((id) => [id, basis[id].trim()])),
    unknowns: unknowns.map((note) => note.trim()).filter(Boolean),
  };
}

/**
 * The whole deterministic path: a validated proposal plus a rent total becomes an
 * allocation in exact cents, carrying the reasoning that produced it.
 *
 * The result is a DRAFT. It is not agreed, not approved and not an invoice — the
 * existing version model decides all of that, and this only ever feeds the first
 * state in it.
 */
export function draftFromProposal({ proposal, totalCents, personIds }) {
  const checked = validateProposal(proposal, { personIds });
  const lines = allocationFromWeights({ totalCents, weights: checked.weights });
  return { lines, ...reconciles({ totalCents, lines }), basis: checked.basis, unknowns: checked.unknowns, weights: checked.weights };
}
