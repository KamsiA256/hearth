// A twelve-person group lease, used to exercise the AI weight-proposal path at a
// household size Willow Court doesn't: twelve uneven shares, several genuinely
// ambiguous rooms, and a total that doesn't divide evenly.
//
// EVERYTHING HERE IS INVENTED EXCEPT THE STREET ADDRESS. 140 College Ave, Ithaca,
// NY is a real address, used only as a plausible Collegetown-style building for
// this exercise — no real landlord, owner, management company or current tenant is
// named or implied anywhere in this file. The organization, the twelve residents,
// their phone numbers (reserved 555-0100–0199 fictional range), the room layout and
// the rent are all invented for this demo.
//
// This file states DATA only. The application and the API never branch on it.
import { createDatasetBuilder } from "./builder.mjs";
import { LIFE_SAFETY_REPLY, MANUAL_REPLY } from "../server/_shared/safety.mjs";

export const meta = {
  id: "college-ave-twelve",
  label: "College Ave · twelve-person household",
  disclaimer: "Demo data · real street address, invented household · local storage only · no messages sent.",
  rentActivity: {
    // Deliberately no `entries`. The household knows what it owes — the lease
    // total, the period, the due date — and has not yet divided it. seedVersion()
    // (src/allocation-state.js) treats an activity with no entries as no seed at
    // all, so this property opens with no rent split, not a split of zero.
    "ca-140": {
      period: "November 2026", total: 14350, due: "Nov 1", followUp: "Nov 6",
      source: "Fictional household agreement", scheduleNote: "Demo setting",
    },
  },
};

export function build(now = new Date()) {
  const b = createDatasetBuilder({ orgId: "org-college-ave", orgName: "Demo account (fictional operator, real address)", now, outboundStatus: "dry_run" });
  const { at, hours, days, dayAt } = b;
  const leaseText = "FICTIONAL SAMPLE LEASE FOR A LOCAL DEMO. Not a real lease and not legal text.";
  const lease = { id: "lease-ca-140", academic_year: "2026–27 lease (fictional)", term_start: "2026-08-01", term_end: "2027-07-31", total_rent: null };

  const P = "ca-140", L = "lease-ca-140";

  // Structured, checkable facts per room (see data/room-facts.mjs for the renderer).
  // Deliberately uneven and, in several rooms, deliberately ambiguous — a room that
  // is better in one way and worse in another is what actually tests a model's
  // judgment; a dataset where the ranking is obvious proves nothing.
  const rooms = [
    // id,       label,      rent, facts
    ["ca-r1", "Room 1", 1450, {
      squareFeet: 220, bathroom: "shared", floor: "garden level",
      windowExposure: "small windows, limited natural light", outdoorAccess: null,
      storage: "large closet", noise: "quiet, interior room, no street noise", parking: false,
    }], // ambiguous: largest closet and size on this floor, but dim and no private bath
    ["ca-r2", "Room 2", 1175, {
      squareFeet: 150, bathroom: "shared", floor: "1st floor",
      windowExposure: "west-facing, moderate light", outdoorAccess: null,
      storage: "small closet", noise: "street-facing, noisy", parking: true,
    }], // ambiguous: one of only two rooms with assigned parking, but noisy and small
    ["ca-r3", "Room 3", 1250, {
      squareFeet: 160, bathroom: "shared", floor: "1st floor",
      windowExposure: "east-facing, bright", outdoorAccess: null,
      storage: "medium closet", noise: "quiet, faces the backyard", parking: false,
    }],
    ["ca-r4", "Room 4", 1650, {
      squareFeet: 240, bathroom: "private", floor: "2nd floor",
      windowExposure: "south-facing, very bright", outdoorAccess: "private balcony",
      storage: "walk-in closet", noise: "quiet, faces the backyard", parking: false,
    }], // the clear anchor: largest room, private bath, private balcony, quiet
    ["ca-r5", "Room 5", 1000, {
      squareFeet: 120, bathroom: "shared", floor: "2nd floor",
      windowExposure: "north-facing, dim", outdoorAccess: null,
      storage: "small closet", noise: "quiet, faces the backyard", parking: false,
    }],
    ["ca-r6", "Room 6", 1200, {
      squareFeet: 170, bathroom: "shared", floor: "2nd floor",
      windowExposure: "south-facing, bright", outdoorAccess: "shared balcony access",
      storage: "small closet", noise: "street-facing, noisy", parking: false,
    }], // ambiguous: balcony access and good light, but shared bath and street noise
    ["ca-r7", "Room 7", 1325, {
      squareFeet: 190, bathroom: "private", floor: "3rd floor",
      windowExposure: "west-facing, moderate light", outdoorAccess: null,
      storage: "medium closet", noise: "quiet, faces the backyard", parking: false,
    }],
    ["ca-r8", "Room 8", 950, {
      squareFeet: 110, bathroom: "shared", floor: "3rd floor",
      windowExposure: "east-facing, bright", outdoorAccess: null,
      storage: "no closet, uses a wardrobe", noise: "quiet, faces the backyard", parking: false,
    }], // smallest room in the house
    ["ca-r9", "Room 9", 1500, {
      squareFeet: 230, bathroom: "private", floor: "garden level",
      windowExposure: "small windows, limited natural light", outdoorAccess: null,
      storage: "large closet", noise: "quiet, interior room, no street noise", parking: true,
    }], // ambiguous: private bath, large, parking and quiet, against a dim garden level
    ["ca-r10", "Room 10", 1000, {
      squareFeet: 130, bathroom: "shared", floor: "3rd floor",
      windowExposure: "skylight, bright", outdoorAccess: null,
      storage: "small, slanted-ceiling closet", noise: "quiet, faces the backyard", parking: false,
    }], // ambiguous: a skylight gives it the best light on its floor, but it's small
    ["ca-r11", "Room 11", 1050, {
      squareFeet: 140, bathroom: "shared", floor: "1st floor",
      windowExposure: "north-facing, dim", outdoorAccess: null,
      storage: "walk-in closet", noise: "street-facing, noisy", parking: false,
    }],
    ["ca-r12", "Room 12", 800, {
      squareFeet: 180, bathroom: "shared", floor: "garden level",
      windowExposure: "small windows, limited natural light", outdoorAccess: null,
      storage: "extra attached storage room", noise: "quiet, interior room, no street noise", parking: false,
    }],
  ];

  b.property({
    id: P, name: "140 College Ave", address: "140 College Ave, Ithaca, NY 14850",
    number: "+16075550182", leaseText, lease,
    rooms,
  });

  const residents = [
    ["p-ca-priya", "Priya Natarajan", "+16075550140", "ca-r1"],
    ["p-ca-marcus", "Marcus Delgado", "+16075550141", "ca-r2"],
    ["p-ca-sofia", "Sofia Kowalski", "+16075550142", "ca-r3"],
    ["p-ca-diego", "Diego Alvarez", "+16075550143", "ca-r4"],
    ["p-ca-hannah", "Hannah Brecht", "+16075550144", "ca-r5"],
    ["p-ca-tyler", "Tyler Osei", "+16075550145", "ca-r6"],
    ["p-ca-ngozi", "Ngozi Chukwu", "+16075550146", "ca-r7"],
    ["p-ca-owen", "Owen Fairweather", "+16075550147", "ca-r8"],
    ["p-ca-mei", "Mei-Lin Zhao", "+16075550148", "ca-r9"],
    ["p-ca-caleb", "Caleb Thornton", "+16075550149", "ca-r10"],
    ["p-ca-isla", "Isla Donoghue", "+16075550150", "ca-r11"],
    ["p-ca-theo", "Theo Castellano", "+16075550151", "ca-r12"],
  ];
  for (const [id, name, phone, room] of residents) {
    b.person(P, L, { id, name, phone, room });
    b.task(P, id, "requirements_complete", "complete");
    b.task(P, id, "key_status", "complete", "issued");
  }

  // Next year's lease, as invented as everything else here: most of the house has
  // signed or is signing, two haven't decided, and two are moving out — enough that
  // the leasing view has something true to sort.
  const asked = { reminder_sent_at: dayAt(-12, 10) };
  const signed = (room) => ({ ...asked, renewal: "renewing", guarantor_confirmed: true, signature_status: "signed", next_room_id: room, rent_share_agreed: true, reminder_acknowledged_at: dayAt(-11, 19) });
  const signing = (room) => ({ ...asked, renewal: "renewing", guarantor_confirmed: true, signature_status: "sent", next_room_id: room, rent_share_agreed: false, reminder_acknowledged_at: dayAt(-10, 9) });
  const renewals = {
    "p-ca-priya": signed("ca-r1"), "p-ca-sofia": signed("ca-r3"), "p-ca-diego": signed("ca-r4"), "p-ca-ngozi": signed("ca-r7"), "p-ca-caleb": signed("ca-r10"),
    "p-ca-tyler": signing("ca-r6"), "p-ca-mei": signing("ca-r9"), "p-ca-isla": signing("ca-r11"),
    "p-ca-hannah": { ...asked, renewal: "undecided", reminder_acknowledged_at: dayAt(-11, 21) }, "p-ca-theo": { ...asked, renewal: "undecided" },
    "p-ca-marcus": { ...asked, renewal: "leaving", reminder_acknowledged_at: dayAt(-9, 14) }, "p-ca-owen": { ...asked, renewal: "leaving", reminder_acknowledged_at: dayAt(-8, 16) },
  };
  for (const [id, fields] of Object.entries(renewals)) b.releasing(P, id, fields);

  // Fictional message traffic, written so the bodies genuinely classify through
  // classifyHardSafety() rather than relying on a hard-coded tier: the gas message
  // is tier 3 and the sparking outlet is tier 2 on their wording alone. The four
  // states a landlord actually sorts by are all represented — handled without them,
  // ordinary but needing their answer, urgent, and life-safety.
  b.message(P, L, "p-ca-mei", { id: "m-ca-gas", body: "I smell gas in the kitchen — it is strong near the stove and the pilot light is out.", when: hours(-1) });
  b.message(P, L, "p-ca-mei", { id: "m-ca-gas-a", direction: "outbound", body: LIFE_SAFETY_REPLY, when: at(-59), replyTo: "m-ca-gas" });
  b.escalation(P, { id: "esc-ca-gas", messageId: "m-ca-gas", tier: 3, reason: "possible gas leak · life safety", when: hours(-1) });

  b.message(P, L, "p-ca-marcus", { id: "m-ca-outlet", body: "The outlet by my desk is sparking when I plug anything in.", when: hours(-4) });
  b.message(P, L, "p-ca-marcus", { id: "m-ca-outlet-a", direction: "outbound", body: MANUAL_REPLY, when: at(-239), replyTo: "m-ca-outlet" });
  b.escalation(P, { id: "esc-ca-outlet", messageId: "m-ca-outlet", tier: 2, reason: "sparking outlet · urgent repair", when: hours(-4) });

  b.message(P, L, "p-ca-hannah", { id: "m-ca-payer", body: "My parents want to pay my share directly this year. Can they send it instead of me?", when: hours(-9), needsHuman: true, model: "fictional-demo-fixture" });
  b.message(P, L, "p-ca-hannah", { id: "m-ca-payer-a", direction: "outbound", body: MANUAL_REPLY, when: at(-539), replyTo: "m-ca-payer" });

  b.message(P, L, "p-ca-owen", { id: "m-ca-laundry", body: "Is the basement laundry coin-only or is there a card reader?", when: dayAt(-2, 18.6), model: "fictional-demo-fixture" });
  b.message(P, L, "p-ca-owen", { id: "m-ca-laundry-a", direction: "outbound", body: "Hearth: The basement laundry is coin-operated. Reply STOP to opt out.", when: dayAt(-2, 18.62), replyTo: "m-ca-laundry" });

  b.message(P, L, "p-ca-caleb", { id: "m-ca-trash", body: "What day does trash go out on College Ave?", when: dayAt(-4, 11.2), model: "fictional-demo-fixture" });
  b.message(P, L, "p-ca-caleb", { id: "m-ca-trash-a", direction: "outbound", body: "Hearth: Trash goes out Tuesday night for Wednesday pickup. Reply STOP to opt out.", when: dayAt(-4, 11.22), replyTo: "m-ca-trash" });

  b.message(P, L, "p-ca-isla", { id: "m-ca-porch", body: "The porch light has been out for about a week.", when: dayAt(-3, 20.1), model: "fictional-demo-fixture" });

  b.audit("household_seeded", "property", P, { summary: "Twelve-person household seeded for AI verification.", residentCount: residents.length }, days(-1));

  return b.t;
}
