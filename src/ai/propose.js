// The whole model-assisted path: render each room's structured facts according
// to the household's factor selection, ask the client for a proposal, then run
// it through the same validation and arithmetic a typed proposal would get. No
// caller gets to skip draftFromProposal() — this function cannot return anything
// the money boundary in proposal.js has not already checked, and no caller gets
// to skip renderRoomFacts() either — a withheld factor is withheld here, before
// anything reaches the model, not after.
//
// Two entry points: proposeDraft() for a first proposal, proposeRedraft() for a
// feedback-driven revision of one. Both return the same shape, now carrying
// `modelId` and `factorSelection` beside `weights`/`basis`/`unknowns` — so every
// AI-authored version can say what produced it, not just what it concluded.
import { draftFromProposal } from "./proposal.js";
import { renderRoomFacts, validateFactorSelection, FACTOR_KEYS, FACTORS } from "../../data/room-facts.mjs";

export const FEEDBACK_DIRECTIONS = ["over_weighted", "under_weighted"];

export class FeedbackError extends Error {
  constructor(message) { super(message); this.name = "FeedbackError"; this.code = "BAD_FEEDBACK"; }
}

/**
 * Refused when a redraft moved a resident it had no business moving. This is
 * the enforcement part 3 asks for: an instruction to "hold everyone else
 * steady" lives in the prompt too, but it is not trusted — this is what is
 * actually checked, and it is checked after every redraft, not sometimes.
 */
export class RedraftError extends Error {
  constructor(message) { super(message); this.name = "RedraftError"; this.code = "REDRAFT_REFUSED"; }
}

function validateFeedback(feedback) {
  if (!feedback || typeof feedback !== "object") {
    throw new FeedbackError("Feedback must name a rating, a factor and a direction.");
  }
  const { rating, factor, direction } = feedback;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new FeedbackError(`rating must be a whole number from 1 to 5, not ${JSON.stringify(rating)}.`);
  }
  if (!FACTOR_KEYS.includes(factor)) {
    throw new FeedbackError(`"${factor}" is not a room-facts factor. Valid factors: ${FACTOR_KEYS.join(", ")}.`);
  }
  if (!FEEDBACK_DIRECTIONS.includes(direction)) {
    throw new FeedbackError(`direction must be "over_weighted" or "under_weighted", not ${JSON.stringify(direction)}.`);
  }
}

const factorLabel = (key) => FACTORS.find((factor) => factor.key === key)?.label || key;

const renderRooms = (rooms, factorSelection) => (rooms || []).map((room) => {
  const rendered = renderRoomFacts(room.facts, factorSelection);
  const facts = [rendered || room.label || "", room.extra].filter(Boolean).join(" — ");
  return { personId: room.personId, name: room.name, facts };
});

/**
 * Who is exempt from moving when `factorKey` is the one named in a complaint —
 * the residents the isolation check in proposeRedraft() holds to "no real
 * change, within tolerance."
 *
 * Only three factors have a clean present/absent split: a room either has a
 * private bathroom or doesn't, a balcony or doesn't, an assigned space or
 * doesn't. The other five (size, floor, light, storage, noise) are facts every
 * room has some value for — there is no "doesn't carry this factor" subset to
 * exempt, so a complaint about one of those is honestly allowed to move anyone.
 * That is not a gap in the check; a universal fact has no exempt side.
 */
const EXEMPT_WHEN_FLAGGED = {
  parking: (facts) => !facts?.parking,
  outdoorAccess: (facts) => !facts?.outdoorAccess,
  bathroom: (facts) => facts?.bathroom !== "private",
};
const isExempt = (factorKey, facts) => EXEMPT_WHEN_FLAGGED[factorKey]?.(facts) ?? false;

// How much an exempt resident's weight may drift between rounds before a
// redraft counts as having wandered. A little room is left for the model
// restating rather than literally echoing a decimal; a resident whose room
// doesn't carry the flagged factor moving by more than this is the household's
// complaint being answered by re-rolling everyone, which is refused outright.
const MIN_TOLERANCE = 0.03;
const RELATIVE_TOLERANCE = 0.05;
const toleranceFor = (weight) => Math.max(MIN_TOLERANCE, Math.abs(weight) * RELATIVE_TOLERANCE);

function redraftContext({ personIds, previousWeights, feedback, exemptPersonIds }) {
  const label = factorLabel(feedback.factor);
  const verdict = feedback.direction === "over_weighted"
    ? `too high relative to the other rooms, so lower the weight of residents whose room has it`
    : `too low relative to the other rooms, so raise the weight of residents whose room has it`;
  const previousLines = personIds.map((id) => `${id}: ${previousWeights[id]}`).join(", ");
  const holdLine = exemptPersonIds.length
    ? `These residents' rooms do not have "${label}" in a way that complaint should touch, so their weight must come back EXACTLY as it was: ${exemptPersonIds.map((id) => `${id}=${previousWeights[id]}`).join(", ")}.`
    : null;
  return [
    `This is a REDRAFT of a previous proposal, not a fresh one. The previous weights were: ${previousLines}.`,
    `A resident said "${label}" was weighted ${verdict}.`,
    `Start from the previous weights above and change only what that complaint requires. Every resident not implicated by it keeps the exact weight they had.`,
    holdLine,
  ].filter(Boolean).join("\n");
}

/**
 * `rooms` is one entry per resident: `{ personId, name, facts, label, extra }`.
 * `facts` is the structured object from data/room-facts.mjs (or null); `label`
 * is a plain fallback used only when rendering `facts` produces nothing (a room
 * with no structured facts at all — every existing dataset before this feature);
 * `extra` is an optional free-text note appended after the rendered facts.
 *
 * `factorSelection` is `{ [factorKey]: "not_weighed" | "excluded" }` — see
 * data/room-facts.mjs. Validated here, once, before any room is rendered or any
 * model called: a typo'd key or a selection that withholds every factor is
 * refused outright, never silently priced in or silently sent as nothing.
 *
 * The returned draft carries `excludedFactors` beside `weights`, `basis` and
 * `unknowns` — the factors the household deliberately took off the table, for
 * display next to the numbers. "Not weighed" factors leave no trace on the
 * draft; only a deliberate exclusion is a claim worth recording. It also
 * carries `modelId` and `factorSelection` itself, so the version this becomes
 * can say what produced it.
 */
export async function proposeDraft({ client, personIds, rooms, context, totalCents, factorSelection }) {
  validateFactorSelection(factorSelection);
  const raw = await client.proposeWeights({ personIds, rooms: renderRooms(rooms, factorSelection), context });
  const draft = draftFromProposal({ proposal: raw, totalCents, personIds });
  const excludedFactors = factorSelection ? FACTOR_KEYS.filter((key) => factorSelection[key] === "excluded") : [];
  return { ...draft, excludedFactors, factorSelection: factorSelection || {}, modelId: client.model || null };
}

/**
 * A feedback-driven revision of a previous AI proposal. `previousWeights` is
 * that proposal's `weights` — required, because a redraft starts from what was
 * already agreed to be close, not from a blank re-proposal. `feedback` is
 * `{ rating, factor, direction, personId? }`: a 1–5 rating (recorded, never
 * sent to the model as an instruction — a star count is not steerable), which
 * factor was wrong, and which way.
 *
 * The isolation this function is actually trusted to provide is not the
 * prompt's instruction to hold everything else steady — that instruction is
 * sent, but it is not believed. After the model answers, every resident whose
 * room does not carry the flagged factor (see isExempt) is checked against
 * their previous weight; if any moved more than a small tolerance, the whole
 * redraft is refused with RedraftError rather than stored. A redraft that
 * re-rolls the household when asked to fix one dimension is the failure this
 * exists to make impossible to store silently.
 */
export async function proposeRedraft({ client, personIds, rooms, context, totalCents, factorSelection, previousWeights, feedback }) {
  validateFactorSelection(factorSelection);
  validateFeedback(feedback);
  if (!previousWeights || typeof previousWeights !== "object" || Object.keys(previousWeights).length === 0) {
    throw new FeedbackError("A redraft needs the previous round's weights as its starting point.");
  }

  const roomByPersonId = new Map((rooms || []).map((room) => [room.personId, room]));
  const exemptPersonIds = personIds.filter((id) => isExempt(feedback.factor, roomByPersonId.get(id)?.facts));

  const note = redraftContext({ personIds, previousWeights, feedback, exemptPersonIds });
  const fullContext = [context, note].filter(Boolean).join("\n\n");

  const raw = await client.proposeWeights({ personIds, rooms: renderRooms(rooms, factorSelection), context: fullContext });
  const draft = draftFromProposal({ proposal: raw, totalCents, personIds });

  const wandered = exemptPersonIds.filter((id) => {
    const before = previousWeights[id], after = draft.weights[id];
    if (before == null || after == null) return true;
    return Math.abs(after - before) > toleranceFor(before);
  });
  if (wandered.length) {
    throw new RedraftError(
      `The redraft moved ${wandered.length === 1 ? "a resident" : `${wandered.length} residents`} whose room doesn't carry "${factorLabel(feedback.factor)}": ${wandered.join(", ")}. ` +
      "Asked to fix one factor, a redraft that moves everyone is refused rather than stored.",
    );
  }

  const excludedFactors = factorSelection ? FACTOR_KEYS.filter((key) => factorSelection[key] === "excluded") : [];
  return { ...draft, excludedFactors, factorSelection: factorSelection || {}, modelId: client.model || null, feedback };
}
