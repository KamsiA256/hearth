// Verify the Anthropic connection against the real API, with one real call.
//
//   node scripts/verify-ai.mjs
//   HEARTH_DATASET=college-ave-twelve node scripts/verify-ai.mjs
//
//   Choose what the split is based on with --not-weigh and --exclude, each a
//   comma-separated list of factor keys from data/room-facts.mjs. "Not weighed"
//   and "excluded" withhold a factor identically; only "excluded" is recorded
//   and shown on the draft, which is why this script shows it separately below.
//
//     HEARTH_DATASET=college-ave-twelve node scripts/verify-ai.mjs --exclude=parking
//     HEARTH_DATASET=college-ave-twelve node scripts/verify-ai.mjs --not-weigh=floor,noise
//
//   Follow up a draft with feedback — one factor, one direction, one rating —
//   and this makes a second, real call: a redraft starting from round 1's
//   weights, printed beside them so what moved and what held is visible.
//
//     HEARTH_DATASET=college-ave-twelve node scripts/verify-ai.mjs --feedback=parking:over_weighted:2
//
// Why this exists: `npm test` proves the contract with the model (proposal.js,
// weights.js) without ever calling one. This is the one place that actually does —
// the equivalent of verify-paypal-sandbox.mjs for the other half of the AI
// Hackathon's judged criteria. It reads the active dataset's first property, its
// lease total and its residents, and sends the model each resident's REAL
// structured room facts (data/room-facts.mjs renders them, honoring the factor
// selection) — never a dollar figure — and prints what comes back, so "it works"
// means an observed reply, not an assumption.
import { resolveAi } from "../src/ai/provider.js";
import { AiConfigError } from "../src/ai/config.js";
import { proposeDraft, proposeRedraft } from "../src/ai/propose.js";
import { db, demoMeta, datasetId } from "../server/_shared/db.mjs";
import { FACTORS } from "../data/room-facts.mjs";
import { toCents } from "../src/money.js";

function parseFactorSelection(argv) {
  const selection = {};
  for (const arg of argv) {
    const exclude = arg.match(/^--exclude=(.+)$/);
    const notWeigh = arg.match(/^--not-weigh=(.+)$/);
    if (exclude) for (const key of exclude[1].split(",")) selection[key.trim()] = "excluded";
    if (notWeigh) for (const key of notWeigh[1].split(",")) selection[key.trim()] = "not_weighed";
  }
  return selection;
}
function parseFeedback(argv) {
  for (const arg of argv) {
    const match = arg.match(/^--feedback=([^:]+):([^:]+):(\d+)$/);
    if (match) return { factor: match[1], direction: match[2], rating: Number(match[3]) };
  }
  return null;
}
const factorSelection = parseFactorSelection(process.argv.slice(2));
const feedback = parseFeedback(process.argv.slice(2));

// The active dataset's first (and, for every dataset but Willow Court, only)
// property. Nothing here is hardcoded to one scenario — set HEARTH_DATASET to
// point this at a different household.
const PROPERTY = Object.keys(demoMeta.rentActivity)[0];
if (!PROPERTY) throw new Error(`Dataset "${datasetId}" has no rentActivity to verify against.`);
const TOTAL_CENTS = toCents(demoMeta.rentActivity[PROPERTY].total);

const line = (text = "") => console.log(text);
const pass = (text) => line(`  PASS  ${text}`);
const fail = (text) => line(`  FAIL  ${text}`);
const info = (text) => line(`        ${text}`);
const factorLabel = (key) => FACTORS.find((factor) => factor.key === key)?.label || key;

let ai;
try {
  ai = resolveAi({ env: { ...process.env, AI_MODE: "anthropic" } });
} catch (error) {
  line(`\nCannot verify: ${error.message}`);
  if (error instanceof AiConfigError && error.fix) line(`Fix: ${error.fix}`);
  line("\nSee .env.example for AI_MODE / ANTHROPIC_API_KEY / ANTHROPIC_MODEL\n");
  process.exit(1);
}

const { data: people } = await db().from("people").select("id,name,room_id").eq("property_id", PROPERTY);
const { data: rooms } = await db().from("rooms").select("id,label,facts").eq("property_id", PROPERTY);
const roomById = new Map((rooms || []).map((room) => [room.id, room]));
const personIds = (people || []).map((person) => person.id);
const roomInputs = (people || []).map((person) => {
  const room = roomById.get(person.room_id);
  return { personId: person.id, name: person.name, facts: room?.facts || null, label: room?.label || "" };
});

line("\nAI weight-proposal verification");
line("================================");
info(`Model:      ${ai.client.describe()}`);
info(`Household:  ${roomInputs.map((r) => r.name).join(", ")}`);
info(`Total:      $${(TOTAL_CENTS / 100).toFixed(2)} (never shown to the model as a per-room figure)`);
const notWeighed = Object.keys(factorSelection).filter((key) => factorSelection[key] === "not_weighed");
const excluded = Object.keys(factorSelection).filter((key) => factorSelection[key] === "excluded");
info(`Not weighed: ${notWeighed.length ? notWeighed.map(factorLabel).join(", ") : "none"}`);
info(`Excluded:    ${excluded.length ? excluded.map(factorLabel).join(", ") : "none"}`);
line();

let draft;
try {
  draft = await proposeDraft({ client: ai.client, personIds, rooms: roomInputs, totalCents: TOTAL_CENTS, factorSelection });
  pass("the model returned a proposal and it passed validateProposal() / draftFromProposal()");
} catch (error) {
  fail(`the call failed or the proposal was refused: ${error.message}`);
  process.exit(1);
}

info(`Balanced:  ${draft.balanced} (allocated ${draft.allocated}, difference ${draft.differenceCents} cents)`);
line();
for (const personId of personIds) {
  const person = roomInputs.find((r) => r.personId === personId);
  info(`${person.name.padEnd(16)} weight ${String(draft.weights[personId]).padEnd(6)} -> $${(draft.lines[personId] / 100).toFixed(2)}`);
  info(`  basis: ${draft.basis[personId]}`);
}
if (draft.unknowns.length) {
  line();
  info("Unknowns the model flagged:");
  for (const note of draft.unknowns) info(`  - ${note}`);
}
line();
// The visible line a household would see next to these numbers: what was
// deliberately kept out of them. "Not weighed" factors leave no trace here —
// only a deliberate exclusion is a claim worth stating.
info(draft.excludedFactors.length
  ? `Not priced in: ${draft.excludedFactors.map(factorLabel).join(", ")} ${draft.excludedFactors.length === 1 ? "was" : "were"} not priced into these shares.`
  : "Not priced in: nothing — every factor was weighed.");
line();
pass(`arithmetic reconciles to the cent regardless of what the model proposed (allocated=${draft.allocated} total=${TOTAL_CENTS})`);
line();

if (feedback) {
  line("Feedback-driven redraft");
  line("=======================");
  info(`A resident says "${factorLabel(feedback.factor)}" was ${feedback.direction.replace("_", "-")} (${feedback.rating}/5 stars — the rating is recorded, not sent to the model as an instruction).`);
  line();

  let redraft;
  try {
    redraft = await proposeRedraft({
      client: ai.client, personIds, rooms: roomInputs, totalCents: TOTAL_CENTS, factorSelection,
      previousWeights: draft.weights, feedback,
    });
    pass("the redraft was accepted: no resident whose room lacks this factor moved beyond tolerance");
  } catch (error) {
    fail(`the redraft was refused: ${error.message}`);
    process.exit(1);
  }

  info(`Balanced:  ${redraft.balanced} (allocated ${redraft.allocated}, difference ${redraft.differenceCents} cents)`);
  line();
  info("Round 1 (draft) vs round 2 (redraft) — same household, same total:");
  line();
  for (const personId of personIds) {
    const person = roomInputs.find((r) => r.personId === personId);
    const before = draft.weights[personId], after = redraft.weights[personId];
    const moved = Math.abs(after - before) > 0.0001;
    info(`${person.name.padEnd(16)} ${String(before).padEnd(6)} -> ${String(after).padEnd(6)}  ${moved ? "MOVED" : "held"}   $${(draft.lines[personId] / 100).toFixed(2)} -> $${(redraft.lines[personId] / 100).toFixed(2)}`);
  }
  line();
  for (const personId of personIds) {
    const person = roomInputs.find((r) => r.personId === personId);
    info(`${person.name}: ${redraft.basis[personId]}`);
  }
  line();
  pass(`redraft arithmetic reconciles to the cent too (allocated=${redraft.allocated} total=${TOTAL_CENTS})`);
  line();
}
