// The twelve-person household at a later point in its month: the split drafted and
// explained, every resident confirmed, the landlord's approval given, and collection
// part-way in — ten invoices out, seven of them paid, two never sent.
//
// Why this exists as a separate module. data/college-ave-twelve.mjs deliberately
// carries NO rent entries, so that property opens with nothing divided — that is the
// slate a live demonstration needs, because the drafting is the thing being shown.
// A static reviewer build has no model behind it, so handed the clean slate it would
// open on an empty Rent workspace and a button that cannot do anything. This variant
// is for that build. It shares the property, the rooms, the residents and the message
// traffic by re-exporting build() unchanged, and overrides only the rent activity.
//
// WHAT THE NUMBERS ARE, stated plainly because it matters: a FICTIONAL HOUSEHOLD
// AGREEMENT, the same kind of seed data/willow-court.mjs carries. The basis lines
// below are written to read the way a drafted split reads — each one citing the room
// facts in college-ave-twelve.mjs — but NO MODEL PRODUCED THEM. That is why
// `aiModelId` says `fictional-demo-fixture`, the same marker the seeded messages
// use, and why the reviewer build's banner says the agreed split is fictional and not
// a model's output. A real draft, with a real model id, exists only in server mode
// where there is a credential and a live call. Nothing here should be presented as
// one, in a demonstration or anywhere else.
//
// Shares are whole multiples of $25 and sum exactly to the $14,350 lease total; the
// weights sum to exactly 12.00, one resident's worth each. Both are deliberate: a
// screen full of $1,196.67 is arithmetically honest and hard to read, and these are
// read off a screen by people who have not seen them before.
import { build } from "./college-ave-twelve.mjs";

export { build };

export const meta = {
  id: "college-ave-twelve-reviewed",
  label: "College Ave · twelve-person household (agreed split)",
  disclaimer: "Demo data · real street address, invented household · the agreed split and its reasoning are fictional, not a model's output · local storage only · no messages sent.",
  rentActivity: {
    "ca-140": {
      period: "November 2026", total: 14350, due: "Nov 1", followUp: "Nov 6",
      source: "Fictional household agreement", scheduleNote: "Demo setting",
      // "agreed" is what makes the screen show the two-sided work: each resident
      // confirmed their own share on the date below, and the landlord could not
      // approve until all twelve had.
      seedState: "agreed",
      approvedOn: "Oct 28",
      // Parking is deliberately left out, and the page says so under the shares.
      // Two rooms have an assigned space and ten do not, so pricing it in would
      // move money between residents over something this household decided was not
      // rent's business. None of the basis lines below mentions it, which is the
      // point: an excluded factor is absent from the reasoning, not argued against.
      aiExcludedFactors: ["parking"],
      aiModelId: "fictional-demo-fixture",
      aiWeights: {
        "p-ca-diego": 1.40, "p-ca-mei": 1.23, "p-ca-priya": 1.17, "p-ca-ngozi": 1.15,
        "p-ca-theo": 0.98, "p-ca-tyler": 0.96, "p-ca-sofia": 0.96, "p-ca-marcus": 0.86,
        "p-ca-isla": 0.86, "p-ca-caleb": 0.84, "p-ca-hannah": 0.82, "p-ca-owen": 0.77,
      },
      aiBasis: {
        "p-ca-diego": "The largest room at 240 sq ft, and the only one that has a private bathroom, a private balcony and a walk-in closet together; south-facing light and a quiet backyard aspect leave nothing on this room arguing for less.",
        "p-ca-mei": "230 sq ft with a private bathroom, a large closet and no street noise at all; the garden level's limited natural light is the one thing holding it below Room 4.",
        "p-ca-priya": "At 220 sq ft with the largest closet in the house, size and storage carry this room well above average despite a shared bathroom and dim garden-level windows.",
        "p-ca-ngozi": "A private bathroom and a quiet backyard aspect on the top floor, at an above-average 190 sq ft; moderate west light is what places it under the two larger private-bath rooms.",
        "p-ca-theo": "180 sq ft plus an attached storage room no other bedroom has; the garden level's limited light brings it back to roughly an ordinary share.",
        "p-ca-tyler": "South-facing light and shared balcony access lift this 170 sq ft room, and a street-facing aspect with a shared bathroom brings it back to about ordinary.",
        "p-ca-sofia": "160 sq ft, bright east light, a medium closet and a quiet backyard aspect — no standout advantage, and no real drawback either.",
        "p-ca-marcus": "150 sq ft with a small closet, moderate west light and street-facing noise puts this room below an ordinary share.",
        "p-ca-isla": "A walk-in closet is unusual at 140 sq ft, but north-facing light and street noise place this room below an ordinary share.",
        "p-ca-caleb": "A skylight gives this room the brightest light on the third floor, though 130 sq ft and a slanted-ceiling closet keep it under average.",
        "p-ca-hannah": "120 sq ft with north-facing light and a small closet; quiet, but among the smallest and dimmest rooms in the house.",
        "p-ca-owen": "The smallest room at 110 sq ft and the only one with no closet, offset partly by bright east light and a quiet aspect — the lowest share in the house.",
      },
      entries: [
        { personId: "p-ca-priya", amount: 1400, state: "received", recorded: "Oct 30", confirmedOn: "Oct 24" },
        { personId: "p-ca-marcus", amount: 1025, state: "due", confirmedOn: "Oct 23" },
        { personId: "p-ca-sofia", amount: 1150, state: "received", recorded: "Oct 30", confirmedOn: "Oct 22" },
        { personId: "p-ca-diego", amount: 1675, state: "received", recorded: "Nov 1", confirmedOn: "Oct 25" },
        { personId: "p-ca-hannah", amount: 975, state: "due", confirmedOn: "Oct 26" },
        { personId: "p-ca-tyler", amount: 1150, state: "received", recorded: "Oct 31", confirmedOn: "Oct 24" },
        { personId: "p-ca-ngozi", amount: 1375, state: "received", recorded: "Nov 1", confirmedOn: "Oct 23" },
        { personId: "p-ca-owen", amount: 925, state: "due", confirmedOn: "Oct 22" },
        { personId: "p-ca-mei", amount: 1475, state: "received", recorded: "Oct 30", confirmedOn: "Oct 25" },
        { personId: "p-ca-caleb", amount: 1000, state: "received", recorded: "Nov 2", confirmedOn: "Oct 26" },
        { personId: "p-ca-isla", amount: 1025, state: "due", confirmedOn: "Oct 24" },
        { personId: "p-ca-theo", amount: 1175, state: "due", confirmedOn: "Oct 22" },
      ],
      // Invoices the scenario says already exist, read by scripts/reviewer-entry.mjs
      // when it builds the page's simulated provider. The mix is the point: a month
      // part-way collected shows that "invoice sent" and "paid" are separate facts
      // and that Hearth tracks them separately. Isla and Theo have no invoice at
      // all, so the two that were never sent are visible as missing rather than
      // implied — and a reviewer can send them from the page and watch what happens.
      //
      // Hannah is the partly-paid one on purpose: her message in the inbox asks
      // whether a parent may pay her share instead of her, which is exactly the
      // question Hearth refuses to answer on its own.
      seedInvoices: [
        { personId: "p-ca-priya", state: "paid" },
        { personId: "p-ca-sofia", state: "paid" },
        { personId: "p-ca-diego", state: "paid" },
        { personId: "p-ca-tyler", state: "paid" },
        { personId: "p-ca-ngozi", state: "paid" },
        { personId: "p-ca-mei", state: "paid" },
        { personId: "p-ca-caleb", state: "paid" },
        { personId: "p-ca-hannah", state: "partially_paid", paidCents: 50000 },
        { personId: "p-ca-marcus", state: "sent" },
        { personId: "p-ca-owen", state: "sent" },
      ],
    },
  },
};
