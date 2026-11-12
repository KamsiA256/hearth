// The demo scenario. EVERYTHING HERE IS INVENTED: the company, the building, the
// address, the rents, the residents, the applicants, the messages and the dates.
// No real company, property, listing or person is described, and nothing is cited
// from an external source. Phone numbers use the reserved 555-0100–0199 range.
//
// This file states DATA only. The application and the API never branch on it.
import { MANUAL_REPLY } from "../server/_shared/safety.mjs";
import { createDatasetBuilder } from "./builder.mjs";

export const meta = {
  id: "willow-court",
  label: "Demo data",
  disclaimer: "Fictional demo data · local storage only · no messages sent.",
  // Monthly rent coordination for each apartment. Shares are deliberately unequal:
  // rooms differ, and an even split is not what these households agreed to.
  rentActivity: {
    "wc-3a": {
      period: "November 2026", total: 3200, due: "Nov 1", followUp: "Nov 6",
      source: "Fictional household agreement", scheduleNote: "Demo setting",
      // This household agreed its split IN HEARTH and the landlord approved
      // collection: each resident confirmed these exact numbers on the date below,
      // and an invoice has been issued and paid against this version. `confirmedOn`
      // is what makes the screen show Hearth doing the work of getting a household
      // to agree, rather than reporting an agreement that happened somewhere else.
      seedState: "agreed",
      approvedOn: "Oct 30",
      entries: [
        { personId: "p-3a-ada", amount: 900, state: "received", recorded: "Oct 27", confirmedOn: "Oct 24" },
        { personId: "p-3a-bo", amount: 860, state: "received", recorded: "Oct 28", confirmedOn: "Oct 24" },
        { personId: "p-3a-cam", amount: 760, state: "received", recorded: "Oct 30", confirmedOn: "Oct 26" },
        { personId: "p-3a-devi", amount: 680, state: "due", confirmedOn: "Oct 25" },
      ],
    },
    "wc-5b": {
      period: "November 2026", total: 2400, due: "Nov 1", followUp: "Nov 6",
      source: "Fictional household agreement", scheduleNote: "Demo setting",
      seedState: "agreed",
      approvedOn: "Oct 29",
      entries: [
        { personId: "p-5b-elan", amount: 850, state: "received", recorded: "Oct 29", confirmedOn: "Oct 26" },
        { personId: "p-5b-fern", amount: 800, state: "due", confirmedOn: "Oct 27" },
        { personId: "p-5b-gus", amount: 750, state: "due", confirmedOn: "Oct 27" },
      ],
    },
  },
};

export function build(now = new Date()) {
  const b = createDatasetBuilder({ orgId: "org-lantern-ridge", orgName: "Lantern Ridge Rentals (fictional)", now, outboundStatus: "dry_run" });
  const { at, hours, days, dayAt } = b;
  const leaseText = "FICTIONAL SAMPLE LEASE FOR A LOCAL DEMO. Not a real lease and not legal text.";
  const lease = (id) => ({ id, academic_year: "2026–27 lease (fictional)", term_start: "2026-08-01", term_end: "2027-07-31", total_rent: null });

  // --- Willow Court, Apt 3A: four residents, one month's rent not fully in, next year's group applying.
  const A = "wc-3a", AL = "lease-wc-3a";
  b.property({ id: A, name: "Willow Court · Apt 3A", address: "212 Willow Court #3A, Rivermark, NY 00000 — fictional", number: "+16075550180", leaseText, lease: lease(AL),
    rooms: [["r3a-1", "Bedroom 1", 900], ["r3a-2", "Bedroom 2", 860], ["r3a-3", "Bedroom 3", 760], ["r3a-4", "Bedroom 4", 680]] });
  for (const [id, name, phone, room] of [["p-3a-ada", "Ada Moreno", "+16075550120", "r3a-1"], ["p-3a-bo", "Bo Fitzgerald", "+16075550121", "r3a-2"], ["p-3a-cam", "Cam Nakamura", "+16075550122", "r3a-3"], ["p-3a-devi", "Devi Sharma", "+16075550123", "r3a-4"]]) {
    b.person(A, AL, { id, name, phone, room });
    for (const key of ["requirements_complete", "arrival_window", "move-in_condition_evidence"]) b.task(A, id, key, "complete", key === "arrival_window" ? "Aug 1, 9am–noon" : null);
    b.task(A, id, "key_status", "complete", "issued");
    b.task(A, id, "move-out_condition_evidence", "pending");
    b.evidence(A, { id: `ev-${id}-in`, person_id: id, room_id: room, kind: "move-in", media_path: `fictional/${id}-movein.jpg`, captured_at: "2026-08-01T15:00:00Z", notes: "Move-in photos (fictional placeholder)" });
    b.releasing(A, id, { renewal: "leaving", reminder_sent_at: dayAt(-21, 10), reminder_acknowledged_at: dayAt(-20, 18.5) });
  }
  b.message(A, AL, "p-3a-cam", { id: "m-3a-laundry", body: "Is the laundry room coin-only or is there a card reader?", when: dayAt(-3, 19.2), model: "fictional-demo-fixture" });
  b.message(A, AL, "p-3a-cam", { id: "m-3a-laundry-a", direction: "outbound", body: "Hearth: The basement laundry is coin-operated. Reply STOP to opt out.", when: dayAt(-3, 19.22), replyTo: "m-3a-laundry" });
  b.message(A, AL, "p-3a-devi", { id: "m-3a-rent", body: "I get paid on the 3rd this month — can I send my share then instead of the 1st?", when: hours(-5), needsHuman: true, model: "fictional-demo-fixture" });
  b.message(A, AL, "p-3a-devi", { id: "m-3a-rent-a", direction: "outbound", body: MANUAL_REPLY, when: at(-299), replyTo: "m-3a-rent" });

  // The landlord's own application checklist. Invented, not taken from any real company's published form.
  b.template({ id: "tpl-application", kind: "application_file", title: "Application file", follow_up_after_days: 3,
    source_title: "Lantern Ridge's application checklist (fictional)",
    source_note: "invented for this demo", follow_up_rule_note: "a demo setting",
    answer_sources: ["Application form", "Email", "Reference form", "Phone call"],
    fields: [
      { key: "application", short: "Own application", label: "Own application submitted (every adult applies separately)", required: true },
      { key: "income", short: "Income proof", label: "Proof of income, employment or studentship", required: true },
      { key: "cosigner", short: "Co-signer application", label: "Co-signer application — or why none is needed", required: true, chase_hint: "if a parent is paying, they complete the separate co-signer application" },
      { key: "rental_history", short: "Prior landlord reference", label: "Prior housing provider returned the reference form", required: true, chase_hint: "your prior landlord hasn’t returned the reference form yet — could you check we have their right email?" },
      { key: "insurance", short: "Renters insurance proof", label: "Renters insurance proof", required: false, due: "before move-in" },
    ] });
  b.group(A, { id: "grp-3a-2027", label: "Apt 3A · Aug 2027 group (4 applicants)", room_id: null, created_at: days(-9) });
  const file = (id, subject_name, sentDaysAgo, answers, extra = {}) => b.request(A, { id, group_id: "grp-3a-2027", request_template_id: "tpl-application", subject_name, subject_role: "applicant", requested_from_name: subject_name.split(" ")[0], requested_from_role: "applicant", channel: "email", sent_at: dayAt(-sentDaysAgo, 10.25), response_received_at: dayAt(-sentDaysAgo + 1, 16.6), answers, ...extra });
  const got = (value, source, daysAgo, hour = 11 + (daysAgo * 1.7) % 6) => ({ value, source, recorded_at: dayAt(-daysAgo, hour) });
  file("req-3a-iris", "Iris Lindqvist", 9, { application: got("Submitted", "Application form", 9), income: got("Offer letter and two pay stubs", "Application form", 9), cosigner: got("Not needed · income meets 3×", "Application form", 9), rental_history: got("Returned · no issues noted", "Reference form", 6) });
  file("req-3a-jonah", "Jonah Weir", 9, { application: got("Submitted", "Application form", 9), income: got("Studentship letter and aid award", "Email", 7), cosigner: got("Father · co-signer application submitted", "Application form", 6), rental_history: got("Returned · no issues noted", "Reference form", 5), insurance: got("Policy declaration page", "Email", 4) });
  file("req-3a-kemi", "Kemi Balogun", 8, { application: got("Submitted", "Application form", 8), income: got("Pay stubs", "Email", 6), cosigner: got("Not needed · income meets 3×", "Application form", 8) }, { last_follow_up_at: dayAt(-5, 9.5), follow_up_count: 1 });
  file("req-3a-luca", "Luca Ferreira", 8, { application: got("Submitted", "Application form", 8), income: got("Parent pays · see co-signer", "Application form", 8), rental_history: got("None · first rental (applicant entered “None”)", "Application form", 8) }, { last_follow_up_at: dayAt(-4, 15.75), follow_up_count: 1 });

  // --- Willow Court, Apt 5B: three residents, an urgent repair and an owner-only question.
  const B = "wc-5b", BL = "lease-wc-5b";
  b.property({ id: B, name: "Willow Court · Apt 5B", address: "212 Willow Court #5B, Rivermark, NY 00000 — fictional", number: "+16075550181", leaseText, lease: lease(BL),
    rooms: [["r5b-1", "Bedroom 1", 850], ["r5b-2", "Bedroom 2", 800], ["r5b-3", "Bedroom 3", 750]] });
  for (const [id, name, phone, room, rel] of [
    ["p-5b-elan", "Elan Petrov", "+16075550124", "r5b-1", { renewal: "leaving", reminder_sent_at: dayAt(-21, 10), reminder_acknowledged_at: dayAt(-19, 12.3) }],
    ["p-5b-fern", "Fern Adeyemi", "+16075550125", "r5b-2", { renewal: "renewing", guarantor_confirmed: true, signature_status: "sent", next_room_id: "r5b-2", rent_share_agreed: true, reminder_sent_at: dayAt(-21, 10), reminder_acknowledged_at: dayAt(-21, 20.1) }],
    ["p-5b-gus", "Gus Marchetti", "+16075550126", "r5b-3", { renewal: "undecided", reminder_sent_at: dayAt(-21, 10) }],
  ]) {
    b.person(B, BL, { id, name, phone, room });
    for (const key of ["requirements_complete", "arrival_window", "move-in_condition_evidence"]) b.task(B, id, key, "complete", key === "arrival_window" ? "Aug 1, 1–4pm" : null);
    b.task(B, id, "key_status", "complete", "issued");
    b.task(B, id, "move-out_condition_evidence", "pending");
    b.evidence(B, { id: `ev-${id}-in`, person_id: id, room_id: room, kind: "move-in", media_path: `fictional/${id}-movein.jpg`, captured_at: "2026-08-01T19:00:00Z", notes: "Move-in photos (fictional placeholder)" });
    b.releasing(B, id, rel);
  }
  b.person(B, BL, { id: "p-5b-fern-g", name: "Remi Adeyemi (co-signer for Fern)", phone: "+16075550127", role: "guarantor", guarantorOf: "p-5b-fern" });
  b.message(B, BL, "p-5b-elan", { id: "m-5b-heat", body: "Heat isn't coming on in 5B since last night. Radiators are cold and it's 58 inside.", when: hours(-2) });
  b.message(B, BL, "p-5b-elan", { id: "m-5b-heat-a", direction: "outbound", body: MANUAL_REPLY, when: at(-119), replyTo: "m-5b-heat" });
  b.escalation(B, { id: "esc-5b-heat", messageId: "m-5b-heat", tier: 2, reason: "no heat · urgent repair", when: hours(-2) });
  b.message(B, BL, "p-5b-gus", { id: "m-5b-sublet", body: "I'm studying abroad in the spring. Can my friend sublet my room from January to May?", when: hours(-20), needsHuman: true, model: "fictional-demo-fixture" });
  b.message(B, BL, "p-5b-gus", { id: "m-5b-sublet-a", direction: "outbound", body: MANUAL_REPLY, when: at(-20 * 60 + 1), replyTo: "m-5b-sublet" });
  b.message(B, BL, "p-5b-fern", { id: "m-5b-split", body: "Gus and I worked out the room shares for next year — can you check the amounts match the lease total?", when: dayAt(-6, 13.4), model: "fictional-demo-fixture" });
  b.message(B, BL, "p-5b-fern", { id: "m-5b-split-a", direction: "outbound", body: MANUAL_REPLY, when: dayAt(-6, 13.42), replyTo: "m-5b-split" });
  b.audit("call_logged", "property", B, { summary: "Called Elan about the radiators; building plumber booked for tomorrow morning." }, hours(-1), "Demo operator");
  return b.t;
}
