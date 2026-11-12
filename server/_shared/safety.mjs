const LIFE_SAFETY = [
  /\b(smell(?:ing)? gas|gas leak|carbon monoxide|co alarm)\b/i,
  /\b(fire|smoke|flames?)\b/i,
  /\b(flood(?:ing|ed)?|burst pipe|water (?:pouring|gushing))\b/i,
  /\b(no heat|heat(?:ing)? (?:is )?(?:out|broken)|freezing inside)\b/i,
  /\b(injur(?:y|ed)|can'?t breathe|unconscious)\b/i,
  /\b(break[ -]?in|intruder|burgl(?:ar|ary))\b/i,
];

const URGENT = [/\blocked out\b/i, /\bno (?:water|electricity)\b/i, /\bsparking\b/i, /\bsewage\b/i];
export const COMMANDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT", "OPT OUT"]);
export const OPT_IN_COMMANDS = new Set(["START", "YES", "UNSTOP"]);

export function classifyHardSafety(body) {
  if (LIFE_SAFETY.some((pattern) => pattern.test(body))) return { tier: 3, reason: "life-safety language detected" };
  if (URGENT.some((pattern) => pattern.test(body))) return { tier: 2, reason: "urgent maintenance language detected" };
  return null;
}

export function normalizedCommand(body) { return body.trim().toUpperCase(); }
// Whole-message keywords always revoke (trailing punctuation allowed). A sentence revokes only
// when it names messages or consent ("please stop texting me", "I revoke consent", "opt me out"),
// never on a bare "stop" in a sentence ("the water won't stop", "can you stop by?"), and never
// when it reads as an emergency, so safety routing is not swallowed by an opt-out.
const SENTENCE_REVOCATION = /\b(?:unsubscribe|revoke|opt[ -]?(?:me\s+)?out)\b|\b(?:stop|quit|cancel|end)\s+(?:texting|messaging|sending|contacting|the\s+(?:texts|messages)|(?:all\s+)?(?:texts|messages))\b/i;
export function isStop(body) {
  const normalized = normalizedCommand(body).replace(/[.!?,;:]+$/g, "").trim();
  if (COMMANDS.has(normalized)) return true;
  if (classifyHardSafety(body)) return false;
  return SENTENCE_REVOCATION.test(body);
}
export function isStart(body) { return OPT_IN_COMMANDS.has(normalizedCommand(body)); }
export function isHelp(body) { return normalizedCommand(body) === "HELP"; }

export const LIFE_SAFETY_REPLY = "Hearth: This may be an emergency. Call 911 now if anyone may be in danger, then contact your landlord or emergency maintenance number directly. Hearth has flagged your message for urgent review but cannot confirm that help is on the way.";

export const MANUAL_REPLY = "Hearth: Thanks - your message was saved and flagged for your landlord to review. Hearth cannot confirm that anyone is on the way. Reply STOP to opt out.";

export function safeRoleContext(person) {
  if (person.role === "guarantor") return {
    role: "guarantor",
    allowedPersonId: person.guarantor_of_person_id,
    rule: "Answer only lease-wide terms and facts specifically about the one student this guarantor guarantees. Never discuss roommates, other occupants, their conversations, balances, rooms, or personal data.",
  };
  return { role: person.role, allowedPersonId: person.id, rule: "Never disclose information about any other person, room occupant, conversation, balance, or private record." };
}
