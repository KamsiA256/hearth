// Structured room facts, and the two functions that cross the model boundary with
// them: which factors the model is told about at all, and how the ones it is told
// about get flattened to text.
//
// Facts stay structured on the room record (see data/builder.mjs) so they remain
// checkable and editable — a landlord can correct "floor" without re-writing a
// paragraph. This file is the single place that boundary gets crossed: the only
// thing src/ai/client.js ever sends the model is the rendered string this produces,
// never the structured object itself, and never money (there is no rent field here
// to render in the first place).
//
// `facts` shape, every field optional:
//   squareFeet     number
//   bathroom       "private" | "shared"
//   floor          string, e.g. "2nd floor", "garden level"
//   windowExposure string, e.g. "south-facing, bright"
//   outdoorAccess  string | null — a balcony/patio description, or null for none
//   storage        string, e.g. "walk-in closet", "no closet, uses a wardrobe"
//   noise          string, e.g. "street-facing, noisy", "quiet, faces the backyard"
//   parking        boolean — whether a parking spot is assigned to this room

/**
 * Every factor a room can be weighed on, in the order it renders, with the plain
 * words a household sees when choosing what the split is based on. This is the
 * one list both the renderer below and the Rent workspace UI read from — the UI
 * keeps its own copy (public/ is served directly to the browser and cannot import
 * outside its own root), but this array is the source of truth it is kept in sync
 * with, and the only place a selection is actually validated.
 */
export const FACTORS = [
  { key: "squareFeet", label: "Room size", description: "Square footage of the room." },
  { key: "bathroom", label: "Bathroom", description: "Whether the bathroom is private or shared." },
  { key: "floor", label: "Floor", description: "Which floor the room is on, including a garden or basement level." },
  { key: "windowExposure", label: "Natural light", description: "Which way the windows face and how much light the room gets." },
  { key: "outdoorAccess", label: "Balcony or outdoor access", description: "Whether the room has a private balcony, patio, or other outdoor access." },
  { key: "storage", label: "Closet or storage", description: "How much closet or storage space the room has." },
  { key: "noise", label: "Noise", description: "Whether the room faces the street and is noisy, or is quiet." },
  { key: "parking", label: "Parking", description: "Whether a parking spot is assigned to the room." },
];
export const FACTOR_KEYS = FACTORS.map((factor) => factor.key);

/**
 * A selection is `{ [factorKey]: "not_weighed" | "excluded" }`. A key absent from
 * the object — the default for every factor — means weighed. The two withholding
 * states render identically (see renderRoomFacts below); what distinguishes them
 * is that "excluded" is a recorded, displayed decision and "not_weighed" is not.
 */
export class FactorSelectionError extends Error {
  constructor(message) { super(message); this.name = "FactorSelectionError"; this.code = "BAD_FACTOR_SELECTION"; }
}

/**
 * A typo'd factor key must fail loudly, not price the real factor in anyway —
 * that silent fallback is exactly the failure this guards against. Withholding
 * every factor is refused too: a model asked to weigh nothing is not drafting a
 * split, it is guessing one, and twelve empty strings would hide that it had
 * nothing to go on.
 */
export function validateFactorSelection(selection) {
  if (!selection) return;
  const unknown = Object.keys(selection).filter((key) => !FACTOR_KEYS.includes(key));
  if (unknown.length) {
    throw new FactorSelectionError(
      `"${unknown.join('", "')}" is not a room-facts factor. Valid factors: ${FACTOR_KEYS.join(", ")}.`,
    );
  }
  const weighed = FACTOR_KEYS.filter((key) => selection[key] !== "not_weighed" && selection[key] !== "excluded");
  if (weighed.length === 0) {
    throw new FactorSelectionError("Every factor is withheld, so there is nothing left to weigh the split on.");
  }
}

/**
 * Render structured room facts into the single descriptive string sent to the
 * model, honoring `selection`. A withheld factor (`"not_weighed"` or `"excluded"`)
 * is omitted from the string entirely — the model is never told a factor exists
 * and separately told to ignore it, because a model that can see a fact can be
 * argued into weighing it anyway. An absent fact that IS being weighed is still
 * stated explicitly ("no assigned parking" is information); a withheld factor
 * produces nothing either way, on a room that has it or a room that doesn't.
 */
export function renderRoomFacts(facts, selection) {
  if (!facts) return "";
  const weighed = (key) => !selection || (selection[key] !== "not_weighed" && selection[key] !== "excluded");
  const parts = [];
  if (weighed("squareFeet") && facts.squareFeet != null) parts.push(`${facts.squareFeet} sq ft`);
  if (weighed("bathroom") && facts.bathroom) parts.push(facts.bathroom === "private" ? "private bathroom" : "shared bathroom");
  if (weighed("floor") && facts.floor) parts.push(facts.floor);
  if (weighed("windowExposure") && facts.windowExposure) parts.push(facts.windowExposure);
  if (weighed("outdoorAccess")) parts.push(facts.outdoorAccess ? facts.outdoorAccess : "no balcony or private outdoor access");
  if (weighed("storage") && facts.storage) parts.push(facts.storage);
  if (weighed("noise") && facts.noise) parts.push(facts.noise);
  if (weighed("parking")) parts.push(facts.parking ? "assigned parking" : "no assigned parking");
  return parts.join("; ");
}
