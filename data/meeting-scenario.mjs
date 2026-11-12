// A meeting demonstration built from a small, strictly validated profile.
//
// Why this exists: showing Hearth to a landlord is clearer at one of their own
// buildings than at an invented one. But docs/BOUNDARIES.md forbids real
// properties in this repository, and that rule stays. So the capability is
// committed and the profile is not:
//
//   - fixtures/meeting-profile.example.json is committed and entirely fictional;
//   - a real meeting's profile lives in .hearth-local/meeting-profile.json, which
//     is gitignored, and is compiled only into a local meeting build
//     (npm run build:meeting), never into public/ or the reviewer build.
//
// What a profile may say is deliberately narrow: a property label as given for
// the meeting, an illustrative household total, and a fictional household with
// opening shares. Unknown keys are refused, so a profile has no field for a lease
// term, a contact, a listing source or a payment account; and the text it does
// carry is refused when it has common contact, account or listing shapes (email,
// URL or bare domain, phone, long digit runs, money amounts). That is a seatbelt,
// not proof: whether resident names are fictional cannot be checked by code, and
// keeping them fictional is the presenter's responsibility. Every other property
// fact is UNKNOWN and is shown as unknown.
//
// Every id is fixed here, never taken from the profile, and none overlaps another
// dataset. So a meeting profile cannot attach to an existing organization,
// resident, invoice, payment record or recipient mapping.
import { createDatasetBuilder } from "./builder.mjs";

export const MEETING_IDS = Object.freeze({
  organization: "org-meeting-demo",
  property: "meeting-demo-property",
  lease: "meeting-demo-lease",
  room: (i) => `meeting-demo-room-${i + 1}`,
  resident: (i) => `meeting-demo-resident-${i + 1}`,
});

const ALLOWED = ["profileVersion", "propertyLabel", "householdTotalCents", "period", "residents"];
const RESIDENT_ALLOWED = ["name", "shareCents"];
const ROOM_LETTERS = "ABCDEF";

// Shapes that would mean somebody put contact, account or listing data in a
// profile. A profile carrying any of them is refused, not scrubbed.
const FORBIDDEN_SHAPES = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "an email address"],
  [/https?:\/\/|www\./i, "a URL"],
  [/\b[a-z0-9-]+\.(com|net|org|io|co|us|edu|info|biz|app|rentals|homes)\b/i, "a web domain"],
  [/(\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}/, "a phone number"],
  [/\d{9,}/, "a long number (account or card shaped)"],
];
// Plain ASCII only: it keeps the check above meaningful (no full-width digits or
// look-alike characters) and means the label reaches the bundle byte for byte.
const LABEL_CHARS = /^[A-Za-z0-9 .,'#&()\/-]+$/;
const NAME_CHARS = /^[A-Za-z .'-]+$/;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// Invoice numbers are derived from the period and refuse anything that does not
// name a month and a four-digit year, so the profile is held to the same rule here,
// before the demo starts, rather than failing at "Prepare invoice" mid-meeting.
const PERIOD = new RegExp(`^(${MONTHS.join("|")}) (20\\d{2})$`);

function refuse(message) { throw new Error(`Meeting profile refused: ${message}`); }

function checkText(value, field, max, chars = LABEL_CHARS) {
  if (typeof value !== "string" || !value.trim()) refuse(`${field} must be a non-empty string.`);
  const text = value.normalize("NFKC").trim();
  if (text.length > max) refuse(`${field} must be at most ${max} characters.`);
  if (!chars.test(text)) refuse(`${field} may only use plain letters${chars === NAME_CHARS ? "" : ", digits"}, spaces and ${chars === NAME_CHARS ? ". ' -" : ". , ' # & ( ) / -"}.`);
  for (const [pattern, what] of FORBIDDEN_SHAPES) if (pattern.test(text)) refuse(`${field} looks like it contains ${what}.`);
  if ((text.match(/\d/g) || []).length > 6) refuse(`${field} has too many digits for a property label.`);
  return text;
}

function checkCents(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) refuse(`${field} must be a whole, non-negative number of cents.`);
  return value;
}

/** Validate a profile. Returns a normalized copy or throws. */
export function validateMeetingProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) refuse("expected a JSON object.");
  const extra = Object.keys(profile).filter((key) => !ALLOWED.includes(key));
  if (extra.length) refuse(`unexpected field(s) ${extra.join(", ")}. Only ${ALLOWED.join(", ")} are accepted.`);
  if (profile.profileVersion !== 1) refuse("profileVersion must be 1.");
  const propertyLabel = checkText(profile.propertyLabel, "propertyLabel", 80);
  const period = String(profile.period ?? "November 2026").trim();
  if (!PERIOD.test(period)) refuse(`period must be a month and year, for example "November 2026".`);
  const total = checkCents(profile.householdTotalCents, "householdTotalCents");
  if (total === 0 || total > 10_000_000) refuse("householdTotalCents must be between 1 and 10,000,000.");
  if (!Array.isArray(profile.residents) || profile.residents.length < 2 || profile.residents.length > ROOM_LETTERS.length) {
    refuse(`residents must list 2 to ${ROOM_LETTERS.length} fictional people.`);
  }
  const residents = profile.residents.map((resident, i) => {
    if (!resident || typeof resident !== "object") refuse(`residents[${i}] must be an object.`);
    const extraKeys = Object.keys(resident).filter((key) => !RESIDENT_ALLOWED.includes(key));
    if (extraKeys.length) refuse(`residents[${i}] has unexpected field(s) ${extraKeys.join(", ")}.`);
    return { name: checkText(resident.name, `residents[${i}].name`, 40, NAME_CHARS), shareCents: checkCents(resident.shareCents, `residents[${i}].shareCents`) };
  });
  const sum = residents.reduce((acc, r) => acc + r.shareCents, 0);
  if (sum !== total) refuse(`the opening shares sum to ${sum} cents but householdTotalCents is ${total}. Start from a balanced proposal.`);
  if (new Set(residents.map((r) => r.shareCents)).size < 2) refuse("opening shares should differ, so an even split is never assumed.");
  return { propertyLabel, period, total, residents };
}

export const MEETING_DISCLAIMER = "Meeting demonstration: a fictional household with illustrative amounts. Not this property's rent, lease, residents or payment record, and nobody at this address uses Hearth.";

/** Build a dataset ({ meta, build }) from a profile. */
export function scenarioFromProfile(rawProfile) {
  const profile = validateMeetingProfile(rawProfile);
  const P = MEETING_IDS.property, L = MEETING_IDS.lease;
  const roomLabel = (i) => `Room ${ROOM_LETTERS[i]} (fictional)`;

  const meta = {
    id: "meeting-demo",
    label: "Meeting demonstration · fictional household",
    disclaimer: MEETING_DISCLAIMER,
    provenance: {
      supplied: ["the property address, given for this meeting"],
      fictional: ["residents and their names", "the number of rooms shown", "the household total", "every share", "confirmations", "approvals", "invoices and payments"],
      unknown: ["the property's actual rent", "bedrooms and bathrooms", "room sizes and which room is larger", "the lease and its dates", "the payment schedule", "availability", "how this property is managed today"],
      statement: "This property is not a Hearth customer. Nothing here was confirmed by its owner or manager.",
    },
    rentActivity: {
      [P]: {
        period: profile.period,
        total: profile.total / 100,
        due: null,
        followUp: null,
        source: "Illustrative amount chosen for this demonstration. It is not this property's rent.",
        basis: "Fictional household proposal. No room is claimed to be larger or worth more; the shares only show how an uneven split is checked and agreed.",
        scheduleNote: null,
        illustrative: true,
        // Opens as an unpublished draft: nobody has been asked to confirm anything.
        seedState: "draft",
        entries: profile.residents.map((resident, i) => ({ personId: MEETING_IDS.resident(i), amount: resident.shareCents / 100, state: "proposed" })),
      },
    },
  };

  function build(now = new Date()) {
    const b = createDatasetBuilder({ orgId: MEETING_IDS.organization, orgName: "Meeting demonstration (fictional operator)", now, outboundStatus: "dry_run" });
    b.property({
      id: P,
      name: profile.propertyLabel,
      address: `${profile.propertyLabel} · address given for this meeting; every other detail here is fictional or unknown`,
      number: "+16075550190",
      leaseText: "FICTIONAL MEETING DEMONSTRATION. Not this property's lease, terms or policy.",
      lease: { id: L, academic_year: null, term_start: null, term_end: null, total_rent: null },
      rooms: profile.residents.map((_, i) => [MEETING_IDS.room(i), roomLabel(i), null]),
    });
    profile.residents.forEach((resident, i) => {
      // Reserved fictional range 555-0100–0199 only.
      b.person(P, L, { id: MEETING_IDS.resident(i), name: resident.name, phone: `+1607555016${i}`, room: MEETING_IDS.room(i) });
      b.releasing(P, MEETING_IDS.resident(i), { renewal: "undecided" });
    });
    b.audit("dataset_loaded", "property", P, { summary: "Meeting demonstration loaded: fictional household, illustrative amounts. No tenancy, customer account or payment record." }, b.days(-1), "seed");
    return b.t;
  }

  return { meta, build };
}
