// Pure derivations behind every number and status the operator screens show. No DOM, no fetch:
// each function takes rows exactly as the operator API returns them, so tests can run it against
// the real handler. Rule: if Hearth does not store a fact, return null/[] (the UI says "not tracked"
// or hides the widget) — never a fabricated zero or percentage.

const DAY = 86400000;
export const dayDiff = (isoDate, now = new Date()) => Math.ceil((new Date(`${isoDate}T12:00:00`) - now) / DAY);
export const activeLease = (property) => property?.lease_groups?.find((group) => group.id === property.active_lease_group_id) || property?.lease_groups?.[0] || null;
export const residentsOf = (property) => (property?.people || []).filter((person) => person.role === "student");
export const guarantorsOf = (property, personId) => (property?.people || []).filter((person) => person.role === "guarantor" && person.guarantor_of_person_id === personId);
export const roomOf = (property, roomId) => (property?.rooms || []).find((room) => room.id === roomId) || null;

// Header line under the property name: "3 residents · Aug 25, 2026 – Jul 31, 2027". Only stored facts.
export function propertyFacts(property, fmt = (d) => d) {
  const lease = activeLease(property), residents = residentsOf(property).length;
  return { residents, term: lease?.term_start && lease?.term_end ? `${fmt(lease.term_start)} – ${fmt(lease.term_end)}` : null, leaseName: lease?.academic_year || null };
}

// The next lease milestone, as words ("Move-out in 6 days"), or null when no lease is set.
export function nextMilestone(property, now = new Date()) {
  const lease = activeLease(property); if (!lease) return null;
  // A lease with no dates on file is UNKNOWN, not over. Reporting "Lease term
  // ended" for an absent date states something nobody recorded, and for a scenario
  // whose dates are deliberately unset that is the difference between showing what
  // is known and inventing the rest.
  if (!lease.term_start && !lease.term_end) return null;
  const start = dayDiff(lease.term_start, now), end = dayDiff(lease.term_end, now);
  const days = (n) => `${n} ${n === 1 ? "day" : "days"}`;
  if (start > 0) return { kind: "move-in", date: lease.term_start, days: start, label: `Move-in in ${days(start)}` };
  if (end > 0) return { kind: "move-out", date: lease.term_end, days: end, label: `Move-out in ${days(end)}` };
  if (end === 0) return { kind: "move-out", date: lease.term_end, days: 0, label: "Move-out is today" };
  return { kind: "ended", date: lease.term_end, days: end, label: "Lease term ended" };
}

// Renewal state per resident, in words. "leaving" residents have no renewal steps left to chase.
const RENEWAL_STEPS = [["guarantor_confirmed", "guarantor"], ["signature_status", "signature"], ["next_room_id", "room"], ["rent_share_agreed", "rent share"]];
const stepDone = (record, key) => key === "signature_status" ? record.signature_status === "signed" : Boolean(record[key]);
export function renewalState(record) {
  if (!record) return { stage: "NO RECORD", label: "No renewal record", missing: [] };
  if (record.renewal === "leaving") return { stage: "MOVING_OUT", label: "Moving out", missing: [] };
  if (record.renewal === "undecided") return { stage: "UNDECIDED", label: record.reminder_sent_at && !record.reminder_acknowledged_at ? "Asked · no reply yet" : "Hasn’t decided", missing: [] };
  const missing = RENEWAL_STEPS.filter(([key]) => !stepDone(record, key)).map(([, label]) => label);
  if (!missing.length) return { stage: "READY", label: "Renewed · all set", missing };
  return { stage: "IN_PROGRESS", label: record.signature_status === "sent" ? "Renewing · lease sent" : "Renewing", missing };
}
export function renewalSummary(property) {
  const counts = { READY: 0, IN_PROGRESS: 0, UNDECIDED: 0, MOVING_OUT: 0 };
  for (const resident of residentsOf(property)) { const state = renewalState((property.releasing_status || []).find((row) => row.current_person_id === resident.id)); if (state.stage in counts) counts[state.stage] += 1; }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return total ? { ...counts, total } : null;
}

// Turnover: which side of the lease is next decides the default phase.
export const defaultTurnoverPhase = (property, now = new Date()) => nextMilestone(property, now)?.kind === "move-in" ? "movein" : "moveout";
const done = (task) => task?.status === "complete";
const keys = (student) => student.tasks?.key_status?.value_text || "not issued";
export const TURNOVER_STEPS = {
  movein: [["Move-in paperwork", (s) => done(s.tasks?.requirements_complete)], ["Arrival time", (s) => done(s.tasks?.arrival_window)], ["Move-in photos", (s) => done(s.tasks?.["move-in_condition_evidence"])], ["Keys issued", (s) => ["issued", "returned"].includes(keys(s))]],
  moveout: [["Move-out photos", (s) => done(s.tasks?.["move-out_condition_evidence"])], ["Keys returned", (s) => keys(s) === "returned"]],
};
export function turnoverState(student, phase) {
  const steps = TURNOVER_STEPS[phase].map(([label, test]) => ({ label, done: test(student) }));
  const count = steps.filter((step) => step.done).length;
  const stage = count === steps.length ? "COMPLETE" : count === 0 ? "NOT_STARTED" : "IN_PROGRESS";
  return { stage, label: { COMPLETE: "Complete", NOT_STARTED: "Not started", IN_PROGRESS: "In progress" }[stage], missing: steps.filter((step) => !step.done).map((step) => step.label), steps };
}
export function turnoverSummary(students, phase) {
  const states = students.map((student) => turnoverState(student, phase));
  return { total: states.length, complete: states.filter((s) => s.stage === "COMPLETE").length, open: states.filter((s) => s.stage !== "COMPLETE").length };
}

// Delivery wording. Only backend states; "dry_run" is said plainly so a test send never looks delivered.
export function deliveryLabel(message) {
  if (message.direction === "inbound") return null;
  if (message.error_code || ["failed", "undelivered"].includes(message.delivery_status)) return { kind: "blocked", label: "Not delivered" };
  if (message.delivery_status === "delivered") return { kind: "complete", label: "Delivered" };
  if (message.delivery_status === "dry_run") return { kind: "pending", label: "Test only · not sent" };
  if (message.delivery_status === "sent") return { kind: "pending", label: "Sent · awaiting carrier" };
  return { kind: "pending", label: "Queued" };
}
export const urgencyLabel = (tier) => tier >= 3 ? "Possible emergency" : "Urgent repair";

// Everything that needs a human, for one property, most serious first. Each item says what, who, why,
// how long and the one action. Sources: open escalations, unanswered needs-human messages, failed sends.
export function attentionItems({ escalations = [], decisions = [], messages = [], requests = [], groups = [], allocation = null }, now = new Date()) {
  const items = [];
  // Rent work the landlord has to do is work that needs them. Leaving it out of
  // this list produced "Nothing needs you right now" on a screen whose own Rent
  // card said a draft was waiting to be published — the list and the card
  // disagreeing about the same fact.
  if (allocation && allocation.status.waitingOn === "landlord" && allocation.status.tone !== "complete") {
    items.push({
      kind: "rent", id: `rent-${allocation.period.key}`, action: "rent",
      who: allocation.period.label,
      what: allocation.status.headline,
      why: allocation.status.detail,
      since: allocation.approval?.at || null,
      tone: allocation.status.tone,
    });
  }
  for (const row of escalations.filter((x) => x.status === "open")) items.push({ kind: "urgent", tier: row.tier, id: row.id, who: row.messages?.people?.name || "Unknown sender", what: row.messages?.body || row.reason, why: `${urgencyLabel(row.tier)} · flagged from the wording of the message`, since: row.created_at, action: "resolve" });
  for (const row of decisions) items.push({ kind: "decision", id: row.id, who: row.people?.name || "Unknown resident", room: row.room?.label || null, what: row.body, why: row.acknowledgement ? "Only you can answer this · Hearth told them it’s with you" : "Only you can answer this · no acknowledgement on record", since: row.created_at, action: "answer" });
  for (const row of messages.filter((m) => deliveryLabel(m)?.kind === "blocked")) items.push({ kind: "failed", id: row.id, who: row.people?.name || "Unknown recipient", what: row.body, why: `Text not delivered${row.error_code ? ` (carrier code ${row.error_code})` : ""} · they may not know`, since: row.created_at, action: "open" });
  items.push(...requestAttention(requests, groups, now));
  // Money that is stuck ranks below a person waiting on an answer and above a
  // routine applicant check: a blocked or uncertain rent state is more urgent than
  // a balanced draft waiting to be sent.
  const rentRank = (item) => (item.tone === "blocked" || item.tone === "overdue") ? 15 : 27;
  const rank = (item) => item.kind === "urgent" ? 10 - item.tier : item.kind === "rent" ? rentRank(item) : item.kind === "decision" ? 20 : item.kind === "request" ? 25 : 30;
  return items.sort((a, b) => rank(a) - rank(b) || new Date(a.since) - new Date(b.since));
}

// Group a property's messages into conversations (one per person), newest activity first.
export function conversations(messages, openDecisionIds = new Set()) {
  const byPerson = new Map();
  for (const message of messages) {
    const key = message.person_id || "unknown";
    if (!byPerson.has(key)) byPerson.set(key, { personId: key, name: message.people?.name || "Unknown", role: message.people?.role || null, roomId: message.people?.room_id || null, conversationId: message.conversation_id || null, messages: [] });
    byPerson.get(key).messages.push(message);
  }
  return [...byPerson.values()].map((thread) => {
    thread.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const last = thread.messages.at(-1);
    const needsYou = thread.messages.some((m) => openDecisionIds.has(m.id) || m.escalations?.some((e) => e.status === "open"));
    const failed = thread.messages.some((m) => deliveryLabel(m)?.kind === "blocked");
    const lastInbound = thread.messages.filter((m) => m.direction === "inbound").at(-1) || null;
    return { ...thread, last, lastInbound, needsYou, failed, waitingOnYou: last.direction === "inbound" };
  }).sort((a, b) => (b.needsYou - a.needsYou) || new Date(b.last.created_at) - new Date(a.last.created_at));
}

// Lease rent as entered in Hearth's lease SETUP: the figures on the lease record.
// Collected and outstanding are deliberately not here — they belong to a billing
// period and come from the allocation workspace and the payment provider, which is
// what the Rent page shows. Two different facts, two different sources.
export function rentFacts(property) {
  const lease = activeLease(property), shares = (property?.rooms || []).map((room) => room.rent_share).filter((value) => value !== null && value !== undefined).map(Number);
  if (lease?.total_rent == null && !shares.length) return null;
  return { leaseTotal: lease?.total_rent == null ? null : Number(lease.total_rent), roomShareMin: shares.length ? Math.min(...shares) : null, roomShareMax: shares.length ? Math.max(...shares) : null, roomsWithShare: shares.length, paymentsTracked: false };
}

// Old hash links keep working: each retired page maps to the place its job now lives.
export const ROUTE_ALIASES = { overview: "today", needs: "messages", escalations: "messages", reply: "messages", people: "residents", calls: "residents", releasing: "leasing", evidence: "property", timeline: "property", export: "property" };
export const resolveRoute = (hash, known) => { const key = ROUTE_ALIASES[hash] || hash || "today"; return known.includes(key) ? key : "today"; };

// Consent wording from the schema enum (pending | consented | opted_out).
export const consentLabel = (person) => person?.opted_out_at || person?.consent_status === "opted_out" ? { kind: "blocked", label: "Opted out of texts" } : person?.consent_status === "consented" ? { kind: "complete", label: "Texts OK" } : { kind: "pending", label: "Hasn’t opted in" };

// Information requests: a checklist of items Hearth is waiting on from outside the lease — an
// applicant's file, a prior landlord's verification, a co-signer's form. The items come from a request
// template (the operator's own published requirements); Hearth only tracks which required items are back,
// from where, how long it has waited and what the operator decided. Files can belong to a group (e.g.
// four applicants for one whole apartment) that the operator decides on together. Hearth never scores or
// decides an application: a decision is always a person's recorded choice.
export const REQUEST_DECISIONS = { approve: "Approved by you", hold: "On hold", reject: "Not approved by you" };
const filled = (item) => String(item?.value ?? "").trim() !== "";
export function requestState(request, now = new Date()) {
  const fields = request?.request_templates?.fields || [];
  const answers = request?.answers || {};
  const missing = fields.filter((field) => field.required && !filled(answers[field.key])).map((field) => field.short || field.label);
  const answered = fields.filter((field) => filled(answers[field.key])).length;
  const followUpDays = request?.request_templates?.follow_up_after_days ?? 3;
  const lastAsked = request?.last_follow_up_at || request?.sent_at || null;
  const waitedDays = lastAsked ? Math.floor((now - new Date(lastAsked)) / DAY) : null;
  const overdue = waitedDays !== null && waitedDays >= followUpDays;
  const base = { missing, answered, total: fields.length, waitedDays, followUpDays, overdue };
  const days = (n) => `${n} ${n === 1 ? "day" : "days"}`;
  if (request?.decision) return { ...base, stage: "DECIDED", label: REQUEST_DECISIONS[request.decision] || "Decided", needsYou: false };
  if (!request?.sent_at) return { ...base, stage: "NOT_SENT", label: "Not requested yet", needsYou: false };
  if (!answered) return { ...base, stage: "NO_REPLY", label: overdue ? `Nothing back · ${days(waitedDays)}` : "Waiting", needsYou: overdue, why: overdue ? `Nothing back after ${days(waitedDays)} · your follow-up rule is ${days(followUpDays)}` : null };
  if (missing.length) return { ...base, stage: "INCOMPLETE", label: `Missing ${missing.length} required ${missing.length === 1 ? "item" : "items"}`, needsYou: overdue, why: `Still missing: ${missing.join("; ")}${overdue ? ` · last asked ${days(waitedDays)} ago (rule: ${days(followUpDays)})` : ""}` };
  return { ...base, stage: "READY", label: "All required items in", needsYou: !request.group_id, why: request.group_id ? "Every required item is in · you decide for the whole group" : "Every required item is in · the decision is yours" };
}
// A group is decided once, by the operator, for everyone in it. It needs the operator when every file
// is complete (decide) or when any file is overdue (chase). Members' own decisions are not used.
export function groupState(group, files, now = new Date()) {
  const states = files.map((file) => ({ file, st: requestState({ ...file, decision: null }, now) }));
  const ready = states.filter((x) => x.st.stage === "READY").length;
  const blocking = states.filter((x) => x.st.stage !== "READY").map((x) => ({ name: x.file.subject_name, missing: x.st.missing.length ? x.st.missing : ["everything"], overdue: x.st.overdue, waitedDays: x.st.waitedDays }));
  const base = { ready, total: files.length, blocking };
  const overdueBlocking = blocking.filter((b) => b.overdue);
  // "Hold" is a decision to wait, not a close: overdue items still come back to Today.
  if (group?.decision === "hold") return { ...base, stage: "DECIDED", label: `On hold · ${ready} of ${files.length} files complete`, needsYou: overdueBlocking.length > 0, why: overdueBlocking.length ? `On hold, and still waiting on ${overdueBlocking.map((b) => `${b.name}: ${b.missing.join(", ")} (${b.waitedDays} days)`).join(" · ")}` : null };
  if (group?.decision) return { ...base, stage: "DECIDED", label: REQUEST_DECISIONS[group.decision] || "Decided", needsYou: false };
  if (files.length && ready === files.length) return { ...base, stage: "READY", label: `All ${files.length} files complete`, needsYou: true, why: "Every required item is in for the whole group · the decision is yours" };
  return { ...base, stage: "INCOMPLETE", label: `${ready} of ${files.length} files complete`, needsYou: overdueBlocking.length > 0, why: `Waiting on ${blocking.map((b) => `${b.name}: ${b.missing.join(", ")}${b.overdue ? ` (${b.waitedDays} days)` : ""}`).join(" · ")}` };
}
// When a complete group is waiting on the operator, it has waited since its last item came in.
const lastRecorded = (files) => files.flatMap((f) => [...Object.values(f.answers || {}).map((a) => a?.recorded_at), f.response_received_at, f.sent_at]).filter(Boolean).sort().at(-1) || null;
export function requestAttention(requests = [], groups = [], now = new Date()) {
  const items = [];
  for (const group of groups) { const files = requests.filter((r) => r.group_id === group.id), st = groupState(group, files, now); if (st.needsYou) items.push({ kind: "request", stage: st.stage, id: group.id, group: true, who: group.label, room: group.rooms?.label || null, what: st.label, why: st.why, since: files.filter((f) => requestState({ ...f, decision: null }, now).stage !== "READY").map((f) => f.last_follow_up_at || f.sent_at).filter(Boolean).sort()[0] || lastRecorded(files) || group.created_at, action: "review" }); }
  for (const row of requests.filter((r) => !r.group_id)) { const st = requestState(row, now); if (st.needsYou) items.push({ kind: "request", stage: st.stage, id: row.id, group: false, who: `${row.subject_name} · ${row.request_templates?.title || "request"}`, room: row.rooms?.label || null, what: st.label, why: st.why, since: row.last_follow_up_at || row.sent_at, action: "review" }); }
  return items;
}
export const openRequestCount = (requests = [], groups = [], now = new Date()) => requestAttention(requests, groups, now).length;

// A typed rent share, as whole cents, or null when it is not a plain dollar amount.
// Strict on purpose: stripping characters turned "-1300" into $1,300, "abc" and a
// blank into $0.00, and "12e2" into $122, each saved without a word.
export function parseShareCents(input) {
  const text = String(input ?? "").trim().replace(/^\$\s*/, "");
  if (!/^(\d{1,3}(,\d{3}){0,2}|\d{1,9})(\.\d{1,2})?$/.test(text)) return null; // at most $999,999,999.99
  const [whole, fraction = ""] = text.replace(/,/g, "").split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

// True only for a VERIFIED absence: the server said "not found" (404) or that the
// property has no rent period (NO_PERIOD). A 5xx, a network failure or a timeout is
// not absence and must never render as an empty state.
export const isVerifiedAbsence = (error) => error?.status === 404 || error?.code === "NO_PERIOD";
