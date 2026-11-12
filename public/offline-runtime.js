var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// server/_shared/http.mjs
var json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", ...headers },
  body: JSON.stringify(body)
});

// data/in-memory-db.mjs
var randomUUID = () => globalThis.crypto.randomUUID();
var SINGULAR = { people: "person", rooms: "room", properties: "property", messages: "message", lease_groups: "lease_group", escalations: "escalation", conversations: "conversation", phone_numbers: "phone_number", evidence: "evidence", call_logs: "call_log", workflow_tasks: "workflow_task", releasing_status: "releasing_status", audit_events: "audit_event", info_requests: "info_request", request_templates: "request_template", request_groups: "request_group" };
var ROW_DEFAULTS = {
  messages: () => ({ media_urls: [], provider_message_id: null, error_code: null, needs_human: false, human_answered_at: null, model_used: null, escalated_to_deep_model: false, model_usage: [], in_reply_to_message_id: null }),
  escalations: () => ({ status: "open", resolved_at: null }),
  workflow_tasks: () => ({ value_text: null, status: "pending", completed_at: null, evidence_id: null }),
  conversations: () => ({ opened_at: (/* @__PURE__ */ new Date()).toISOString(), last_activity: (/* @__PURE__ */ new Date()).toISOString() }),
  audit_events: () => ({ metadata: {} })
};
function splitTopLevel(text) {
  const parts = [];
  let depth = 0, current = "";
  for (const char of text) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
function project(tables, table, row, columns) {
  if (!row) return row;
  const out = {};
  for (const part of splitTopLevel(columns || "*")) {
    const relation = part.match(/^([a-z_]+)(?:![a-z_]+)?\((.*)\)$/s);
    if (!relation) {
      if (part === "*") Object.assign(out, structuredClone(row));
      else out[part] = structuredClone(row[part] ?? null);
      continue;
    }
    const [, target, inner] = relation, foreignKey = `${SINGULAR[target]}_id`;
    if (Object.hasOwn(row, foreignKey)) {
      const match = (tables[target] || []).find((candidate) => candidate.id === row[foreignKey]);
      out[target] = match ? project(tables, target, match, inner) : null;
    } else {
      const backKey = `${SINGULAR[table]}_id`;
      out[target] = (tables[target] || []).filter((candidate) => candidate[backKey] === row.id).map((candidate) => project(tables, target, candidate, inner));
    }
  }
  return out;
}
var Query = class {
  constructor(tables, table) {
    Object.assign(this, { tables, table, filters: [], orders: [], max: null, mode: "select", columns: "*", returning: false, one: false });
  }
  select(columns = "*") {
    if (this.mode === "select") this.columns = columns;
    else {
      this.returning = true;
      this.columns = columns;
    }
    return this;
  }
  eq(column, value) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  neq(column, value) {
    this.filters.push((row) => row[column] !== value);
    return this;
  }
  is(column, value) {
    this.filters.push((row) => (row[column] ?? null) === value);
    return this;
  }
  in(column, values) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  textSearch(column, query) {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    this.filters.push((row) => words.every((word) => String(row[column] || "").toLowerCase().includes(word)));
    return this;
  }
  order(column, { ascending = true } = {}) {
    this.orders.push([column, ascending]);
    return this;
  }
  limit(count) {
    this.max = count;
    return this;
  }
  single() {
    this.one = true;
    return this;
  }
  maybeSingle() {
    this.one = true;
    this.maybe = true;
    return this;
  }
  insert(rows) {
    this.mode = "insert";
    this.payload = rows;
    return this;
  }
  update(changes) {
    this.mode = "update";
    this.payload = changes;
    return this;
  }
  upsert(row, { onConflict } = {}) {
    this.mode = "upsert";
    this.payload = row;
    this.conflict = onConflict ? onConflict.split(",") : ["id"];
    return this;
  }
  run() {
    const rows = this.tables[this.table] ||= [];
    let affected;
    if (this.mode === "insert" || this.mode === "upsert") {
      affected = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((input) => {
        const existing = this.mode === "upsert" && rows.find((row2) => this.conflict.every((key) => row2[key] === input[key]));
        if (existing) return Object.assign(existing, structuredClone(input));
        const row = { id: this.table === "audit_events" ? rows.length + 1 : randomUUID(), created_at: (/* @__PURE__ */ new Date()).toISOString(), ...ROW_DEFAULTS[this.table]?.(), ...structuredClone(input) };
        rows.push(row);
        return row;
      });
      if (!this.returning) return { data: null, error: null };
    } else {
      affected = rows.filter((row) => this.filters.every((test) => test(row)));
      if (this.mode === "update") affected.forEach((row) => Object.assign(row, structuredClone(this.payload)));
      if (this.mode === "update" && !this.returning) return { data: null, error: null };
    }
    for (const [column, ascending] of [...this.orders].reverse()) affected = [...affected].sort((a, b) => (a[column] > b[column] ? 1 : a[column] < b[column] ? -1 : 0) * (ascending ? 1 : -1));
    if (this.max !== null) affected = affected.slice(0, this.max);
    const data = affected.map((row) => project(this.tables, this.table, row, this.columns));
    if (this.maybe && data.length === 0) return { data: null, error: null };
    if (this.one) return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: `expected exactly one ${this.table} row, found ${data.length}` } };
    return { data, error: null };
  }
  then(resolve, reject) {
    try {
      resolve(this.run());
    } catch (error) {
      reject(error);
    }
  }
};
function createInMemoryDatabase(tables) {
  return {
    tables,
    from: (table) => new Query(tables, table),
    storage: { from: () => ({ createSignedUrl: async (path) => ({ data: { signedUrl: `/demo-media/placeholder.svg?photo=${encodeURIComponent(path)}` }, error: null }) }) }
  };
}

// data/willow-court.mjs
var willow_court_exports = {};
__export(willow_court_exports, {
  build: () => build,
  meta: () => meta
});

// server/_shared/safety.mjs
var LIFE_SAFETY_REPLY = "Hearth: This may be an emergency. Call 911 now if anyone may be in danger, then contact your landlord or emergency maintenance number directly. Hearth has flagged your message for urgent review but cannot confirm that help is on the way.";
var MANUAL_REPLY = "Hearth: Thanks - your message was saved and flagged for your landlord to review. Hearth cannot confirm that anyone is on the way. Reply STOP to opt out.";

// data/builder.mjs
function createDatasetBuilder({ orgId, orgName, now = /* @__PURE__ */ new Date(), outboundStatus = "delivered" }) {
  const at = (minutes) => new Date(now.getTime() + minutes * 6e4).toISOString();
  const hours = (h) => at(h * 60), days = (d) => at(d * 1440);
  const dayAt = (d, hour) => {
    const x = new Date(now.getTime() + d * 864e5);
    x.setHours(Math.floor(hour), Math.round(hour % 1 * 60), 0, 0);
    return new Date(Math.min(x.getTime(), now.getTime())).toISOString();
  };
  const t = { organizations: [{ id: orgId, name: orgName, created_at: days(-400) }], properties: [], lease_groups: [], rooms: [], people: [], phone_numbers: [], conversations: [], messages: [], escalations: [], evidence: [], releasing_status: [], workflow_tasks: [], call_logs: [], audit_events: [], request_templates: [], request_groups: [], info_requests: [] };
  const base = (property_id) => ({ organization_id: orgId, property_id });
  const auditRow = (action, entity_type, entity_id, metadata, created_at, actor = "seed") => t.audit_events.push({ id: t.audit_events.length + 1, organization_id: orgId, actor, action, entity_type, entity_id, metadata, created_at });
  return {
    t,
    at,
    hours,
    days,
    dayAt,
    base,
    audit: auditRow,
    property({ id, name, address, lease, rooms, number, leaseText }) {
      t.properties.push({ id, organization_id: orgId, display_name: name, address, lease_text: leaseText, lease_file_path: null, active_lease_group_id: lease.id, created_at: days(-400) });
      t.lease_groups.push({ ...base(id), ...lease, created_at: days(-400) });
      for (const [roomId, label, rent_share = null, facts = null] of rooms) t.rooms.push({ ...base(id), id: roomId, label, rent_share, facts });
      t.phone_numbers.push({ ...base(id), id: `num-${id}`, sms_number: number, active: true, created_at: days(-400) });
    },
    person(propertyId, leaseId, { id, name, phone, role = "student", room = null, guarantorOf = null, optedOutAt = null }) {
      t.people.push({ ...base(propertyId), id, name, phone, role, lease_group_id: leaseId, room_id: room, guarantor_of_person_id: guarantorOf, consent_status: optedOutAt ? "opted_out" : "consented", consent_timestamp: days(-80), opted_out_at: optedOutAt, created_at: days(-80) });
      t.conversations.push({ ...base(propertyId), id: `conv-${id}`, lease_group_id: leaseId, person_id: id, opened_at: days(-80), last_activity: days(-1) });
    },
    message(propertyId, leaseId, personId, { id, direction = "inbound", body, when, needsHuman: needsHuman2 = false, model = null, replyTo = null, status }) {
      t.messages.push({ ...base(propertyId), id, lease_group_id: leaseId, person_id: personId, conversation_id: `conv-${personId}`, direction, body, media_urls: [], provider_message_id: null, delivery_status: status || (direction === "inbound" ? "received" : outboundStatus), error_code: null, created_at: when, needs_human: needsHuman2, human_answered_at: null, model_used: model, escalated_to_deep_model: false, model_usage: [], in_reply_to_message_id: replyTo });
    },
    escalation(propertyId, { id, messageId, tier, reason, when }) {
      t.escalations.push({ ...base(propertyId), id, message_id: messageId, tier, status: "open", reason, resolved_at: null, created_at: when });
    },
    task(propertyId, personId, task_key, status, value_text = null) {
      t.workflow_tasks.push({ ...base(propertyId), id: `task-${personId}-${task_key}`, person_id: personId, task_key, status, value_text, completed_at: status === "complete" ? days(-80) : null, evidence_id: null, created_at: days(-80) });
    },
    releasing(propertyId, personId, fields) {
      t.releasing_status.push({ ...base(propertyId), id: `rel-${personId}`, current_person_id: personId, renewal: "undecided", guarantor_confirmed: false, signature_status: "not_sent", next_room_id: null, rent_share_agreed: false, reminder_sent_at: null, reminder_acknowledged_at: null, updated_at: days(-3), ...fields });
    },
    evidence(propertyId, row) {
      t.evidence.push({ ...base(propertyId), ...row });
    },
    template(row) {
      t.request_templates.push({ organization_id: orgId, created_at: days(-60), ...row });
    },
    group(propertyId, row) {
      t.request_groups.push({ ...base(propertyId), decision: null, decision_note: null, decided_at: null, created_at: days(-10), ...row });
    },
    request(propertyId, row) {
      t.info_requests.push({ ...base(propertyId), answers: {}, follow_up_count: 0, last_follow_up_at: null, response_received_at: null, decision: null, decision_note: null, decided_at: null, group_id: null, room_id: null, created_at: row.sent_at || days(-10), ...row });
    }
  };
}

// data/willow-court.mjs
var meta = {
  id: "willow-court",
  label: "Demo data",
  disclaimer: "Fictional demo data \xB7 local storage only \xB7 no messages sent.",
  // Monthly rent coordination for each apartment. Shares are deliberately unequal:
  // rooms differ, and an even split is not what these households agreed to.
  rentActivity: {
    "wc-3a": {
      period: "November 2026",
      total: 3200,
      due: "Nov 1",
      followUp: "Nov 6",
      source: "Fictional household agreement",
      scheduleNote: "Demo setting",
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
        { personId: "p-3a-devi", amount: 680, state: "due", confirmedOn: "Oct 25" }
      ]
    },
    "wc-5b": {
      period: "November 2026",
      total: 2400,
      due: "Nov 1",
      followUp: "Nov 6",
      source: "Fictional household agreement",
      scheduleNote: "Demo setting",
      seedState: "agreed",
      approvedOn: "Oct 29",
      entries: [
        { personId: "p-5b-elan", amount: 850, state: "received", recorded: "Oct 29", confirmedOn: "Oct 26" },
        { personId: "p-5b-fern", amount: 800, state: "due", confirmedOn: "Oct 27" },
        { personId: "p-5b-gus", amount: 750, state: "due", confirmedOn: "Oct 27" }
      ]
    }
  }
};
function build(now = /* @__PURE__ */ new Date()) {
  const b = createDatasetBuilder({ orgId: "org-lantern-ridge", orgName: "Lantern Ridge Rentals (fictional)", now, outboundStatus: "dry_run" });
  const { at, hours, days, dayAt } = b;
  const leaseText = "FICTIONAL SAMPLE LEASE FOR A LOCAL DEMO. Not a real lease and not legal text.";
  const lease = (id) => ({ id, academic_year: "2026\u201327 lease (fictional)", term_start: "2026-08-01", term_end: "2027-07-31", total_rent: null });
  const A = "wc-3a", AL = "lease-wc-3a";
  b.property({
    id: A,
    name: "Willow Court \xB7 Apt 3A",
    address: "212 Willow Court #3A, Rivermark, NY 00000 \u2014 fictional",
    number: "+16075550180",
    leaseText,
    lease: lease(AL),
    rooms: [["r3a-1", "Bedroom 1", 900], ["r3a-2", "Bedroom 2", 860], ["r3a-3", "Bedroom 3", 760], ["r3a-4", "Bedroom 4", 680]]
  });
  for (const [id, name, phone, room] of [["p-3a-ada", "Ada Moreno", "+16075550120", "r3a-1"], ["p-3a-bo", "Bo Fitzgerald", "+16075550121", "r3a-2"], ["p-3a-cam", "Cam Nakamura", "+16075550122", "r3a-3"], ["p-3a-devi", "Devi Sharma", "+16075550123", "r3a-4"]]) {
    b.person(A, AL, { id, name, phone, room });
    for (const key of ["requirements_complete", "arrival_window", "move-in_condition_evidence"]) b.task(A, id, key, "complete", key === "arrival_window" ? "Aug 1, 9am\u2013noon" : null);
    b.task(A, id, "key_status", "complete", "issued");
    b.task(A, id, "move-out_condition_evidence", "pending");
    b.evidence(A, { id: `ev-${id}-in`, person_id: id, room_id: room, kind: "move-in", media_path: `fictional/${id}-movein.jpg`, captured_at: "2026-08-01T15:00:00Z", notes: "Move-in photos (fictional placeholder)" });
    b.releasing(A, id, { renewal: "leaving", reminder_sent_at: dayAt(-21, 10), reminder_acknowledged_at: dayAt(-20, 18.5) });
  }
  b.message(A, AL, "p-3a-cam", { id: "m-3a-laundry", body: "Is the laundry room coin-only or is there a card reader?", when: dayAt(-3, 19.2), model: "fictional-demo-fixture" });
  b.message(A, AL, "p-3a-cam", { id: "m-3a-laundry-a", direction: "outbound", body: "Hearth: The basement laundry is coin-operated. Reply STOP to opt out.", when: dayAt(-3, 19.22), replyTo: "m-3a-laundry" });
  b.message(A, AL, "p-3a-devi", { id: "m-3a-rent", body: "I get paid on the 3rd this month \u2014 can I send my share then instead of the 1st?", when: hours(-5), needsHuman: true, model: "fictional-demo-fixture" });
  b.message(A, AL, "p-3a-devi", { id: "m-3a-rent-a", direction: "outbound", body: MANUAL_REPLY, when: at(-299), replyTo: "m-3a-rent" });
  b.template({
    id: "tpl-application",
    kind: "application_file",
    title: "Application file",
    follow_up_after_days: 3,
    source_title: "Lantern Ridge's application checklist (fictional)",
    source_note: "invented for this demo",
    follow_up_rule_note: "a demo setting",
    answer_sources: ["Application form", "Email", "Reference form", "Phone call"],
    fields: [
      { key: "application", short: "Own application", label: "Own application submitted (every adult applies separately)", required: true },
      { key: "income", short: "Income proof", label: "Proof of income, employment or studentship", required: true },
      { key: "cosigner", short: "Co-signer application", label: "Co-signer application \u2014 or why none is needed", required: true, chase_hint: "if a parent is paying, they complete the separate co-signer application" },
      { key: "rental_history", short: "Prior landlord reference", label: "Prior housing provider returned the reference form", required: true, chase_hint: "your prior landlord hasn\u2019t returned the reference form yet \u2014 could you check we have their right email?" },
      { key: "insurance", short: "Renters insurance proof", label: "Renters insurance proof", required: false, due: "before move-in" }
    ]
  });
  b.group(A, { id: "grp-3a-2027", label: "Apt 3A \xB7 Aug 2027 group (4 applicants)", room_id: null, created_at: days(-9) });
  const file = (id, subject_name, sentDaysAgo, answers, extra = {}) => b.request(A, { id, group_id: "grp-3a-2027", request_template_id: "tpl-application", subject_name, subject_role: "applicant", requested_from_name: subject_name.split(" ")[0], requested_from_role: "applicant", channel: "email", sent_at: dayAt(-sentDaysAgo, 10.25), response_received_at: dayAt(-sentDaysAgo + 1, 16.6), answers, ...extra });
  const got = (value, source, daysAgo, hour = 11 + daysAgo * 1.7 % 6) => ({ value, source, recorded_at: dayAt(-daysAgo, hour) });
  file("req-3a-iris", "Iris Lindqvist", 9, { application: got("Submitted", "Application form", 9), income: got("Offer letter and two pay stubs", "Application form", 9), cosigner: got("Not needed \xB7 income meets 3\xD7", "Application form", 9), rental_history: got("Returned \xB7 no issues noted", "Reference form", 6) });
  file("req-3a-jonah", "Jonah Weir", 9, { application: got("Submitted", "Application form", 9), income: got("Studentship letter and aid award", "Email", 7), cosigner: got("Father \xB7 co-signer application submitted", "Application form", 6), rental_history: got("Returned \xB7 no issues noted", "Reference form", 5), insurance: got("Policy declaration page", "Email", 4) });
  file("req-3a-kemi", "Kemi Balogun", 8, { application: got("Submitted", "Application form", 8), income: got("Pay stubs", "Email", 6), cosigner: got("Not needed \xB7 income meets 3\xD7", "Application form", 8) }, { last_follow_up_at: dayAt(-5, 9.5), follow_up_count: 1 });
  file("req-3a-luca", "Luca Ferreira", 8, { application: got("Submitted", "Application form", 8), income: got("Parent pays \xB7 see co-signer", "Application form", 8), rental_history: got("None \xB7 first rental (applicant entered \u201CNone\u201D)", "Application form", 8) }, { last_follow_up_at: dayAt(-4, 15.75), follow_up_count: 1 });
  const B = "wc-5b", BL = "lease-wc-5b";
  b.property({
    id: B,
    name: "Willow Court \xB7 Apt 5B",
    address: "212 Willow Court #5B, Rivermark, NY 00000 \u2014 fictional",
    number: "+16075550181",
    leaseText,
    lease: lease(BL),
    rooms: [["r5b-1", "Bedroom 1", 850], ["r5b-2", "Bedroom 2", 800], ["r5b-3", "Bedroom 3", 750]]
  });
  for (const [id, name, phone, room, rel] of [
    ["p-5b-elan", "Elan Petrov", "+16075550124", "r5b-1", { renewal: "leaving", reminder_sent_at: dayAt(-21, 10), reminder_acknowledged_at: dayAt(-19, 12.3) }],
    ["p-5b-fern", "Fern Adeyemi", "+16075550125", "r5b-2", { renewal: "renewing", guarantor_confirmed: true, signature_status: "sent", next_room_id: "r5b-2", rent_share_agreed: true, reminder_sent_at: dayAt(-21, 10), reminder_acknowledged_at: dayAt(-21, 20.1) }],
    ["p-5b-gus", "Gus Marchetti", "+16075550126", "r5b-3", { renewal: "undecided", reminder_sent_at: dayAt(-21, 10) }]
  ]) {
    b.person(B, BL, { id, name, phone, room });
    for (const key of ["requirements_complete", "arrival_window", "move-in_condition_evidence"]) b.task(B, id, key, "complete", key === "arrival_window" ? "Aug 1, 1\u20134pm" : null);
    b.task(B, id, "key_status", "complete", "issued");
    b.task(B, id, "move-out_condition_evidence", "pending");
    b.evidence(B, { id: `ev-${id}-in`, person_id: id, room_id: room, kind: "move-in", media_path: `fictional/${id}-movein.jpg`, captured_at: "2026-08-01T19:00:00Z", notes: "Move-in photos (fictional placeholder)" });
    b.releasing(B, id, rel);
  }
  b.person(B, BL, { id: "p-5b-fern-g", name: "Remi Adeyemi (co-signer for Fern)", phone: "+16075550127", role: "guarantor", guarantorOf: "p-5b-fern" });
  b.message(B, BL, "p-5b-elan", { id: "m-5b-heat", body: "Heat isn't coming on in 5B since last night. Radiators are cold and it's 58 inside.", when: hours(-2) });
  b.message(B, BL, "p-5b-elan", { id: "m-5b-heat-a", direction: "outbound", body: MANUAL_REPLY, when: at(-119), replyTo: "m-5b-heat" });
  b.escalation(B, { id: "esc-5b-heat", messageId: "m-5b-heat", tier: 2, reason: "no heat \xB7 urgent repair", when: hours(-2) });
  b.message(B, BL, "p-5b-gus", { id: "m-5b-sublet", body: "I'm studying abroad in the spring. Can my friend sublet my room from January to May?", when: hours(-20), needsHuman: true, model: "fictional-demo-fixture" });
  b.message(B, BL, "p-5b-gus", { id: "m-5b-sublet-a", direction: "outbound", body: MANUAL_REPLY, when: at(-20 * 60 + 1), replyTo: "m-5b-sublet" });
  b.message(B, BL, "p-5b-fern", { id: "m-5b-split", body: "Gus and I worked out the room shares for next year \u2014 can you check the amounts match the lease total?", when: dayAt(-6, 13.4), model: "fictional-demo-fixture" });
  b.message(B, BL, "p-5b-fern", { id: "m-5b-split-a", direction: "outbound", body: MANUAL_REPLY, when: dayAt(-6, 13.42), replyTo: "m-5b-split" });
  b.audit("call_logged", "property", B, { summary: "Called Elan about the radiators; building plumber booked for tomorrow morning." }, hours(-1), "Demo operator");
  return b.t;
}

// data/meeting-example.mjs
var meeting_example_exports = {};
__export(meeting_example_exports, {
  build: () => build2,
  meta: () => meta2
});

// fixtures/meeting-profile.example.json
var meeting_profile_example_default = {
  profileVersion: 1,
  propertyLabel: "12 Example Lane (fictional)",
  householdTotalCents: 24e4,
  period: "November 2026",
  residents: [
    { name: "Rowan Fictional", shareCents: 85e3 },
    { name: "Sasha Example", shareCents: 8e4 },
    { name: "Theo Placeholder", shareCents: 75e3 }
  ]
};

// data/meeting-scenario.mjs
var MEETING_IDS = Object.freeze({
  organization: "org-meeting-demo",
  property: "meeting-demo-property",
  lease: "meeting-demo-lease",
  room: (i) => `meeting-demo-room-${i + 1}`,
  resident: (i) => `meeting-demo-resident-${i + 1}`
});
var ALLOWED = ["profileVersion", "propertyLabel", "householdTotalCents", "period", "residents"];
var RESIDENT_ALLOWED = ["name", "shareCents"];
var ROOM_LETTERS = "ABCDEF";
var FORBIDDEN_SHAPES = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "an email address"],
  [/https?:\/\/|www\./i, "a URL"],
  [/\b[a-z0-9-]+\.(com|net|org|io|co|us|edu|info|biz|app|rentals|homes)\b/i, "a web domain"],
  [/(\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}/, "a phone number"],
  [/\d{9,}/, "a long number (account or card shaped)"]
];
var LABEL_CHARS = /^[A-Za-z0-9 .,'#&()\/-]+$/;
var NAME_CHARS = /^[A-Za-z .'-]+$/;
var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
var PERIOD = new RegExp(`^(${MONTHS.join("|")}) (20\\d{2})$`);
function refuse(message) {
  throw new Error(`Meeting profile refused: ${message}`);
}
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
function validateMeetingProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) refuse("expected a JSON object.");
  const extra = Object.keys(profile).filter((key) => !ALLOWED.includes(key));
  if (extra.length) refuse(`unexpected field(s) ${extra.join(", ")}. Only ${ALLOWED.join(", ")} are accepted.`);
  if (profile.profileVersion !== 1) refuse("profileVersion must be 1.");
  const propertyLabel = checkText(profile.propertyLabel, "propertyLabel", 80);
  const period = String(profile.period ?? "November 2026").trim();
  if (!PERIOD.test(period)) refuse(`period must be a month and year, for example "November 2026".`);
  const total = checkCents(profile.householdTotalCents, "householdTotalCents");
  if (total === 0 || total > 1e7) refuse("householdTotalCents must be between 1 and 10,000,000.");
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
var MEETING_DISCLAIMER = "Meeting demonstration: a fictional household with illustrative amounts. Not this property's rent, lease, residents or payment record, and nobody at this address uses Hearth.";
function scenarioFromProfile(rawProfile) {
  const profile = validateMeetingProfile(rawProfile);
  const P = MEETING_IDS.property, L = MEETING_IDS.lease;
  const roomLabel = (i) => `Room ${ROOM_LETTERS[i]} (fictional)`;
  const meta6 = {
    id: "meeting-demo",
    label: "Meeting demonstration \xB7 fictional household",
    disclaimer: MEETING_DISCLAIMER,
    provenance: {
      supplied: ["the property address, given for this meeting"],
      fictional: ["residents and their names", "the number of rooms shown", "the household total", "every share", "confirmations", "approvals", "invoices and payments"],
      unknown: ["the property's actual rent", "bedrooms and bathrooms", "room sizes and which room is larger", "the lease and its dates", "the payment schedule", "availability", "how this property is managed today"],
      statement: "This property is not a Hearth customer. Nothing here was confirmed by its owner or manager."
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
        entries: profile.residents.map((resident, i) => ({ personId: MEETING_IDS.resident(i), amount: resident.shareCents / 100, state: "proposed" }))
      }
    }
  };
  function build5(now = /* @__PURE__ */ new Date()) {
    const b = createDatasetBuilder({ orgId: MEETING_IDS.organization, orgName: "Meeting demonstration (fictional operator)", now, outboundStatus: "dry_run" });
    b.property({
      id: P,
      name: profile.propertyLabel,
      address: `${profile.propertyLabel} \xB7 address given for this meeting; every other detail here is fictional or unknown`,
      number: "+16075550190",
      leaseText: "FICTIONAL MEETING DEMONSTRATION. Not this property's lease, terms or policy.",
      lease: { id: L, academic_year: null, term_start: null, term_end: null, total_rent: null },
      rooms: profile.residents.map((_, i) => [MEETING_IDS.room(i), roomLabel(i), null])
    });
    profile.residents.forEach((resident, i) => {
      b.person(P, L, { id: MEETING_IDS.resident(i), name: resident.name, phone: `+1607555016${i}`, room: MEETING_IDS.room(i) });
      b.releasing(P, MEETING_IDS.resident(i), { renewal: "undecided" });
    });
    b.audit("dataset_loaded", "property", P, { summary: "Meeting demonstration loaded: fictional household, illustrative amounts. No tenancy, customer account or payment record." }, b.days(-1), "seed");
    return b.t;
  }
  return { meta: meta6, build: build5 };
}

// data/meeting-example.mjs
var scenario = scenarioFromProfile(meeting_profile_example_default);
var meta2 = scenario.meta;
var build2 = scenario.build;

// data/college-ave-twelve.mjs
var college_ave_twelve_exports = {};
__export(college_ave_twelve_exports, {
  build: () => build3,
  meta: () => meta3
});
var meta3 = {
  id: "college-ave-twelve",
  label: "College Ave \xB7 twelve-person household",
  disclaimer: "Demo data \xB7 real street address, invented household \xB7 local storage only \xB7 no messages sent.",
  rentActivity: {
    // Deliberately no `entries`. The household knows what it owes — the lease
    // total, the period, the due date — and has not yet divided it. seedVersion()
    // (src/allocation-state.js) treats an activity with no entries as no seed at
    // all, so this property opens with no rent split, not a split of zero.
    "ca-140": {
      period: "November 2026",
      total: 14350,
      due: "Nov 1",
      followUp: "Nov 6",
      source: "Fictional household agreement",
      scheduleNote: "Demo setting"
    }
  }
};
function build3(now = /* @__PURE__ */ new Date()) {
  const b = createDatasetBuilder({ orgId: "org-college-ave", orgName: "Demo account (fictional operator, real address)", now, outboundStatus: "dry_run" });
  const { at, hours, days, dayAt } = b;
  const leaseText = "FICTIONAL SAMPLE LEASE FOR A LOCAL DEMO. Not a real lease and not legal text.";
  const lease = { id: "lease-ca-140", academic_year: "2026\u201327 lease (fictional)", term_start: "2026-08-01", term_end: "2027-07-31", total_rent: null };
  const P = "ca-140", L = "lease-ca-140";
  const rooms = [
    // id,       label,      rent, facts
    ["ca-r1", "Room 1", 1450, {
      squareFeet: 220,
      bathroom: "shared",
      floor: "garden level",
      windowExposure: "small windows, limited natural light",
      outdoorAccess: null,
      storage: "large closet",
      noise: "quiet, interior room, no street noise",
      parking: false
    }],
    // ambiguous: largest closet and size on this floor, but dim and no private bath
    ["ca-r2", "Room 2", 1175, {
      squareFeet: 150,
      bathroom: "shared",
      floor: "1st floor",
      windowExposure: "west-facing, moderate light",
      outdoorAccess: null,
      storage: "small closet",
      noise: "street-facing, noisy",
      parking: true
    }],
    // ambiguous: one of only two rooms with assigned parking, but noisy and small
    ["ca-r3", "Room 3", 1250, {
      squareFeet: 160,
      bathroom: "shared",
      floor: "1st floor",
      windowExposure: "east-facing, bright",
      outdoorAccess: null,
      storage: "medium closet",
      noise: "quiet, faces the backyard",
      parking: false
    }],
    ["ca-r4", "Room 4", 1650, {
      squareFeet: 240,
      bathroom: "private",
      floor: "2nd floor",
      windowExposure: "south-facing, very bright",
      outdoorAccess: "private balcony",
      storage: "walk-in closet",
      noise: "quiet, faces the backyard",
      parking: false
    }],
    // the clear anchor: largest room, private bath, private balcony, quiet
    ["ca-r5", "Room 5", 1e3, {
      squareFeet: 120,
      bathroom: "shared",
      floor: "2nd floor",
      windowExposure: "north-facing, dim",
      outdoorAccess: null,
      storage: "small closet",
      noise: "quiet, faces the backyard",
      parking: false
    }],
    ["ca-r6", "Room 6", 1200, {
      squareFeet: 170,
      bathroom: "shared",
      floor: "2nd floor",
      windowExposure: "south-facing, bright",
      outdoorAccess: "shared balcony access",
      storage: "small closet",
      noise: "street-facing, noisy",
      parking: false
    }],
    // ambiguous: balcony access and good light, but shared bath and street noise
    ["ca-r7", "Room 7", 1325, {
      squareFeet: 190,
      bathroom: "private",
      floor: "3rd floor",
      windowExposure: "west-facing, moderate light",
      outdoorAccess: null,
      storage: "medium closet",
      noise: "quiet, faces the backyard",
      parking: false
    }],
    ["ca-r8", "Room 8", 950, {
      squareFeet: 110,
      bathroom: "shared",
      floor: "3rd floor",
      windowExposure: "east-facing, bright",
      outdoorAccess: null,
      storage: "no closet, uses a wardrobe",
      noise: "quiet, faces the backyard",
      parking: false
    }],
    // smallest room in the house
    ["ca-r9", "Room 9", 1500, {
      squareFeet: 230,
      bathroom: "private",
      floor: "garden level",
      windowExposure: "small windows, limited natural light",
      outdoorAccess: null,
      storage: "large closet",
      noise: "quiet, interior room, no street noise",
      parking: true
    }],
    // ambiguous: private bath, large, parking and quiet, against a dim garden level
    ["ca-r10", "Room 10", 1e3, {
      squareFeet: 130,
      bathroom: "shared",
      floor: "3rd floor",
      windowExposure: "skylight, bright",
      outdoorAccess: null,
      storage: "small, slanted-ceiling closet",
      noise: "quiet, faces the backyard",
      parking: false
    }],
    // ambiguous: a skylight gives it the best light on its floor, but it's small
    ["ca-r11", "Room 11", 1050, {
      squareFeet: 140,
      bathroom: "shared",
      floor: "1st floor",
      windowExposure: "north-facing, dim",
      outdoorAccess: null,
      storage: "walk-in closet",
      noise: "street-facing, noisy",
      parking: false
    }],
    ["ca-r12", "Room 12", 800, {
      squareFeet: 180,
      bathroom: "shared",
      floor: "garden level",
      windowExposure: "small windows, limited natural light",
      outdoorAccess: null,
      storage: "extra attached storage room",
      noise: "quiet, interior room, no street noise",
      parking: false
    }]
  ];
  b.property({
    id: P,
    name: "140 College Ave",
    address: "140 College Ave, Ithaca, NY 14850",
    number: "+16075550182",
    leaseText,
    lease,
    rooms
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
    ["p-ca-theo", "Theo Castellano", "+16075550151", "ca-r12"]
  ];
  for (const [id, name, phone, room] of residents) {
    b.person(P, L, { id, name, phone, room });
    b.task(P, id, "requirements_complete", "complete");
    b.task(P, id, "key_status", "complete", "issued");
  }
  b.message(P, L, "p-ca-mei", { id: "m-ca-gas", body: "I smell gas in the kitchen \u2014 it is strong near the stove and the pilot light is out.", when: hours(-1) });
  b.message(P, L, "p-ca-mei", { id: "m-ca-gas-a", direction: "outbound", body: LIFE_SAFETY_REPLY, when: at(-59), replyTo: "m-ca-gas" });
  b.escalation(P, { id: "esc-ca-gas", messageId: "m-ca-gas", tier: 3, reason: "possible gas leak \xB7 life safety", when: hours(-1) });
  b.message(P, L, "p-ca-marcus", { id: "m-ca-outlet", body: "The outlet by my desk is sparking when I plug anything in.", when: hours(-4) });
  b.message(P, L, "p-ca-marcus", { id: "m-ca-outlet-a", direction: "outbound", body: MANUAL_REPLY, when: at(-239), replyTo: "m-ca-outlet" });
  b.escalation(P, { id: "esc-ca-outlet", messageId: "m-ca-outlet", tier: 2, reason: "sparking outlet \xB7 urgent repair", when: hours(-4) });
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

// data/college-ave-twelve-reviewed.mjs
var college_ave_twelve_reviewed_exports = {};
__export(college_ave_twelve_reviewed_exports, {
  build: () => build3,
  meta: () => meta4
});
var meta4 = {
  id: "college-ave-twelve-reviewed",
  label: "College Ave \xB7 twelve-person household (agreed split)",
  disclaimer: "Demo data \xB7 real street address, invented household \xB7 the agreed split and its reasoning are fictional, not a model's output \xB7 local storage only \xB7 no messages sent.",
  rentActivity: {
    "ca-140": {
      period: "November 2026",
      total: 14350,
      due: "Nov 1",
      followUp: "Nov 6",
      source: "Fictional household agreement",
      scheduleNote: "Demo setting",
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
        "p-ca-diego": 1.4,
        "p-ca-mei": 1.23,
        "p-ca-priya": 1.17,
        "p-ca-ngozi": 1.15,
        "p-ca-theo": 0.98,
        "p-ca-tyler": 0.96,
        "p-ca-sofia": 0.96,
        "p-ca-marcus": 0.86,
        "p-ca-isla": 0.86,
        "p-ca-caleb": 0.84,
        "p-ca-hannah": 0.82,
        "p-ca-owen": 0.77
      },
      aiBasis: {
        "p-ca-diego": "The largest room at 240 sq ft, and the only one that has a private bathroom, a private balcony and a walk-in closet together; south-facing light and a quiet backyard aspect leave nothing on this room arguing for less.",
        "p-ca-mei": "230 sq ft with a private bathroom, a large closet and no street noise at all; the garden level's limited natural light is the one thing holding it below Room 4.",
        "p-ca-priya": "At 220 sq ft with the largest closet in the house, size and storage carry this room well above average despite a shared bathroom and dim garden-level windows.",
        "p-ca-ngozi": "A private bathroom and a quiet backyard aspect on the top floor, at an above-average 190 sq ft; moderate west light is what places it under the two larger private-bath rooms.",
        "p-ca-theo": "180 sq ft plus an attached storage room no other bedroom has; the garden level's limited light brings it back to roughly an ordinary share.",
        "p-ca-tyler": "South-facing light and shared balcony access lift this 170 sq ft room, and a street-facing aspect with a shared bathroom brings it back to about ordinary.",
        "p-ca-sofia": "160 sq ft, bright east light, a medium closet and a quiet backyard aspect \u2014 no standout advantage, and no real drawback either.",
        "p-ca-marcus": "150 sq ft with a small closet, moderate west light and street-facing noise puts this room below an ordinary share.",
        "p-ca-isla": "A walk-in closet is unusual at 140 sq ft, but north-facing light and street noise place this room below an ordinary share.",
        "p-ca-caleb": "A skylight gives this room the brightest light on the third floor, though 130 sq ft and a slanted-ceiling closet keep it under average.",
        "p-ca-hannah": "120 sq ft with north-facing light and a small closet; quiet, but among the smallest and dimmest rooms in the house.",
        "p-ca-owen": "The smallest room at 110 sq ft and the only one with no closet, offset partly by bright east light and a quiet aspect \u2014 the lowest share in the house."
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
        { personId: "p-ca-caleb", amount: 1e3, state: "received", recorded: "Nov 2", confirmedOn: "Oct 26" },
        { personId: "p-ca-isla", amount: 1025, state: "due", confirmedOn: "Oct 24" },
        { personId: "p-ca-theo", amount: 1175, state: "due", confirmedOn: "Oct 22" }
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
        { personId: "p-ca-hannah", state: "partially_paid", paidCents: 5e4 },
        { personId: "p-ca-marcus", state: "sent" },
        { personId: "p-ca-owen", state: "sent" }
      ]
    }
  }
};

// data/datasets.mjs
var DATASETS = {
  "willow-court": willow_court_exports,
  "meeting-example": meeting_example_exports,
  // The same household at two points in its month, and the difference is the point:
  // -twelve has nothing divided yet, which is the slate a live demonstration of the
  // drafting needs; -reviewed has the split agreed and confirmed, which is what a
  // static build has to show because it can reach neither a model nor a provider.
  "college-ave-twelve": college_ave_twelve_exports,
  "college-ave-twelve-reviewed": college_ave_twelve_reviewed_exports
};
var DEFAULT_DATASET = "willow-court";
var fromEnvironment = () => {
  if ("willow-court") return "willow-court";
  if (typeof process !== "undefined" && process.env) return process.env.HEARTH_DATASET;
  return void 0;
};
function resolveDataset(name = fromEnvironment()) {
  const id = String(name || DEFAULT_DATASET).trim();
  const dataset2 = DATASETS[id];
  if (!dataset2) {
    throw new Error(
      `HEARTH_DATASET="${id}" is not a dataset. Available: ${Object.keys(DATASETS).join(", ")}. Leave it unset for ${DEFAULT_DATASET}.`
    );
  }
  return { id, ...dataset2 };
}

// server/_shared/db.mjs
var dataset = resolveDataset();
var { build: build4, meta: meta5 } = dataset;
var datasetId = dataset.id;
var demoMeta = meta5;
var demoOrganizationIds = build4().organizations.map((organization) => organization.id);
var singleton = createInMemoryDatabase(build4());
function db() {
  return singleton;
}
function must(result, label = "database operation") {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}
async function audit(organizationId, action, entityType, entityId, metadata = {}, actor = "Demo operator") {
  const { error } = await db().from("audit_events").insert({ organization_id: organizationId, actor, action, entity_type: entityType, entity_id: String(entityId), metadata });
  if (error) throw new Error(`audit event: ${error.message}`);
}

// server/_shared/operator-auth.mjs
var DEMO_ACCESS_CODE = "demo";
var accessCode = () => globalThis.process?.env?.HEARTH_ACCESS_CODE || DEMO_ACCESS_CODE;
function resolveOperator(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || "";
  return header === `Bearer ${accessCode()}` ? { name: "Demo operator", organizationIds: demoOrganizationIds } : null;
}

// server/_shared/messaging.mjs
var SMS_BRAND_PREFIX = "Hearth: ";
var SMS_OPT_OUT_SUFFIX = "Reply STOP to opt out.";
function formatOutboundMessage(body) {
  const unformatted = String(body || "").trim();
  const branded = unformatted.startsWith(SMS_BRAND_PREFIX) ? unformatted : `${SMS_BRAND_PREFIX}${unformatted}`;
  if (branded === LIFE_SAFETY_REPLY || branded.endsWith(SMS_OPT_OUT_SUFFIX)) return branded;
  return `${branded} ${SMS_OPT_OUT_SUFFIX}`;
}
async function sendAndPersist({ organizationId, propertyId, leaseGroupId, person, conversationId, body, inReplyToMessageId = null }) {
  if (person.consent_status === "opted_out" || person.opted_out_at) throw new Error("CONSENT_BLOCK: recipient is opted out");
  return must(await db().from("messages").insert({
    organization_id: organizationId,
    property_id: propertyId,
    lease_group_id: leaseGroupId,
    person_id: person.id,
    conversation_id: conversationId,
    direction: "outbound",
    body: formatOutboundMessage(body),
    delivery_status: "dry_run",
    in_reply_to_message_id: inReplyToMessageId
  }).select().single(), "record demo reply");
}

// server/operator-api.mjs
var pathOf = (event) => (event.path.split("/operator-api/")[1] || event.path.split("/api/operator/")[1] || "overview").replace(/\/$/, "");
var BadRequest = class extends Error {
};
var bodyOf = (event) => {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    throw new BadRequest("Request body must be JSON");
  }
};
var NotFound = class extends Error {
};
var isNoRow = (error) => error && (error.code === "PGRST116" || /exactly one|0 rows|no rows/i.test(error.message || ""));
async function one(query, label) {
  const { data, error } = await query;
  if (isNoRow(error) || !error && !data) throw new NotFound(`${label} not found`);
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}
var inOrgs = (query, orgs) => query.in("organization_id", orgs);
var scopedProperty = (propertyId, orgs) => propertyId ? one(inOrgs(db().from("properties").select("id,organization_id").eq("id", propertyId), orgs).single(), "property") : Promise.reject(new NotFound("property not found"));
async function signedEvidence(rows) {
  return Promise.all(rows.map(async (row) => {
    const signed = await db().storage.from("inbound-media").createSignedUrl(row.media_path, 300);
    return { ...row, signed_url: signed.data?.signedUrl || null };
  }));
}
async function listProperties(orgs) {
  const [propertiesResult, peopleResult, releasingResult] = await Promise.all([
    inOrgs(db().from("properties").select("id,organization_id,address,display_name,active_lease_group_id,lease_groups!lease_groups_organization_id_property_id_fkey(id,academic_year,term_start,term_end,total_rent),rooms(id,label,rent_share),phone_numbers(id,sms_number,active),escalations(id,status,tier)"), orgs).order("display_name"),
    inOrgs(db().from("people").select("id,organization_id,name,phone,role,property_id,lease_group_id,room_id,guarantor_of_person_id,consent_status,consent_timestamp,opted_out_at"), orgs),
    inOrgs(db().from("releasing_status").select("id,organization_id,property_id,current_person_id,renewal,guarantor_confirmed,signature_status,next_room_id,rent_share_agreed,reminder_sent_at,reminder_acknowledged_at,updated_at"), orgs)
  ]);
  const properties = must(propertiesResult, "properties");
  const people = must(peopleResult, "property people");
  const releasing = must(releasingResult, "property releasing status");
  return properties.map((property) => ({
    ...property,
    people: people.filter((person) => person.property_id === property.id),
    releasing_status: releasing.filter((status) => status.property_id === property.id)
  }));
}
async function propertyNameMap(orgs) {
  const properties = must(await inOrgs(db().from("properties").select("id,display_name"), orgs), "property names");
  return new Map(properties.map((property) => [property.id, { display_name: property.display_name }]));
}
var DECISION_WORDS = { approve: "Approve", hold: "Hold", reject: "Not approve" };
var TURNOVER_TASK_KEYS = /* @__PURE__ */ new Set(["requirements_complete", "arrival_window", "key_status", "move-in_condition_evidence", "move-out_condition_evidence"]);
async function turnover(propertyId) {
  const [propertyResult, studentsResult, tasksResult, evidenceResult] = await Promise.all([
    db().from("properties").select("id,organization_id,address,display_name,active_lease_group_id,lease_groups!lease_groups_organization_id_property_id_fkey(id,term_start,term_end),rooms(id,label)").eq("id", propertyId).single(),
    db().from("people").select("id,name,role,room_id,lease_group_id,consent_status,opted_out_at").eq("property_id", propertyId).eq("role", "student").order("name"),
    db().from("workflow_tasks").select("id,person_id,task_key,status,value_text,completed_at,evidence_id").eq("property_id", propertyId),
    db().from("evidence").select("id,person_id,room_id,kind,media_path,captured_at,notes").eq("property_id", propertyId).in("kind", ["move-in", "move-out"]).order("captured_at")
  ]);
  const property = must(propertyResult, "turnover property");
  const students = must(studentsResult, "turnover students");
  const tasks = must(tasksResult, "turnover tasks");
  const evidence = await signedEvidence(must(evidenceResult, "turnover evidence"));
  return {
    property,
    students: students.map((student) => ({
      ...student,
      room: property.rooms.find((room) => room.id === student.room_id) || null,
      tasks: Object.fromEntries(tasks.filter((task) => task.person_id === student.id).map((task) => [task.task_key, task])),
      evidence: {
        moveIn: evidence.filter((item) => item.person_id === student.id && item.kind === "move-in"),
        moveOut: evidence.filter((item) => item.person_id === student.id && item.kind === "move-out")
      }
    }))
  };
}
function usageSummary(messages) {
  const handled = messages.filter((message) => message.model_used).length;
  const modelCalls = messages.flatMap((message) => Array.isArray(message.model_usage) ? message.model_usage : []);
  const reportedCalls = modelCalls.filter((call) => call.usage && (Object.hasOwn(call.usage, "cache_read_input_tokens") || Object.hasOwn(call.usage, "cache_creation_input_tokens")));
  const cacheHits = reportedCalls.filter((call) => Number(call.usage.cache_read_input_tokens || 0) > 0).length;
  return {
    messages_handled: handled,
    sonnet_escalation_rate: handled ? Math.round(messages.filter((message) => message.model_used && message.escalated_to_deep_model).length / handled * 100) : 0,
    cache_hit_rate: reportedCalls.length ? Math.round(cacheHits / reportedCalls.length * 100) : null,
    cache_reported_calls: reportedCalls.length,
    model_calls: modelCalls.length
  };
}
async function needsHuman(propertyId) {
  const [messagesResult, roomsResult] = await Promise.all([
    db().from("messages").select("id,property_id,person_id,conversation_id,body,created_at,model_used,escalated_to_deep_model,model_usage,people(name,role,room_id,consent_status,opted_out_at)").eq("property_id", propertyId).eq("direction", "inbound").eq("needs_human", true).is("human_answered_at", null).order("created_at", { ascending: false }),
    db().from("rooms").select("id,label").eq("property_id", propertyId)
  ]);
  const messages = must(messagesResult, "needs-human messages");
  const rooms = must(roomsResult, "needs-human rooms");
  let acknowledgements = [];
  if (messages.length) acknowledgements = must(await db().from("messages").select("id,in_reply_to_message_id,body,delivery_status,created_at").eq("property_id", propertyId).eq("direction", "outbound").in("in_reply_to_message_id", messages.map((message) => message.id)).order("created_at"), "needs-human acknowledgements");
  const acknowledgementByMessage = new Map(acknowledgements.map((message) => [message.in_reply_to_message_id, message]));
  return messages.map((message) => ({
    ...message,
    room: rooms.find((room) => room.id === message.people?.room_id) || null,
    acknowledgement: acknowledgementByMessage.get(message.id) || null
  }));
}
async function overview(orgs) {
  const [properties, modelMessagesResult] = await Promise.all([
    listProperties(orgs),
    inOrgs(db().from("messages").select("property_id,needs_human,human_answered_at,model_used,escalated_to_deep_model,model_usage").eq("direction", "inbound"), orgs)
  ]);
  const modelMessages = must(modelMessagesResult, "overview message intelligence");
  return properties.map((property) => {
    const statuses = property.releasing_status || [];
    const propertyMessages = modelMessages.filter((message) => message.property_id === property.id);
    const complete = statuses.reduce((sum, row) => sum + [row.renewal !== "undecided", row.guarantor_confirmed, row.signature_status === "signed", Boolean(row.next_room_id), row.rent_share_agreed, Boolean(row.reminder_acknowledged_at)].filter(Boolean).length, 0);
    return { id: property.id, display_name: property.display_name, address: property.address, readiness: statuses.length ? Math.round(complete / (statuses.length * 6) * 100) : 0, open_escalations: property.escalations.filter((item) => item.status === "open").length, needs_human: propertyMessages.filter((message) => message.needs_human && !message.human_answered_at).length, usage: usageSummary(propertyMessages), blockers: statuses.reduce((sum, row) => sum + 6 - [row.renewal !== "undecided", row.guarantor_confirmed, row.signature_status === "signed", Boolean(row.next_room_id), row.rent_share_agreed, Boolean(row.reminder_acknowledged_at)].filter(Boolean).length, 0) };
  });
}
async function exportProperty(propertyId) {
  const [propertyResult, peopleResult, messagesResult, evidenceResult, releasingResult, tasksResult, callsResult] = await Promise.all([
    db().from("properties").select("*,lease_groups!lease_groups_organization_id_property_id_fkey(*),rooms(*),phone_numbers(*),escalations(*)").eq("id", propertyId).single(),
    db().from("people").select("*").eq("property_id", propertyId),
    db().from("messages").select("*").eq("property_id", propertyId).order("created_at"),
    db().from("evidence").select("*").eq("property_id", propertyId).order("captured_at"),
    db().from("releasing_status").select("*").eq("property_id", propertyId),
    db().from("workflow_tasks").select("*").eq("property_id", propertyId),
    db().from("call_logs").select("*").eq("property_id", propertyId).order("occurred_at")
  ]);
  const property = must(propertyResult, "property export");
  property.people = must(peopleResult, "export people");
  property.messages = must(messagesResult, "export messages");
  property.evidence = await signedEvidence(must(evidenceResult, "export evidence"));
  property.releasing_status = must(releasingResult, "export releasing status");
  property.workflow_tasks = must(tasksResult, "export workflow tasks");
  property.call_logs = must(callsResult, "export call logs");
  const entityIds = [propertyId, ...(property.people || []).map((x) => x.id), ...(property.messages || []).map((x) => x.id), ...(property.escalations || []).map((x) => x.id), ...(property.evidence || []).map((x) => x.id), ...(property.call_logs || []).map((x) => x.id)];
  property.audit_events = must(await db().from("audit_events").select("*").eq("organization_id", property.organization_id).in("entity_id", entityIds).order("created_at"), "export audit events");
  return { exported_at: (/* @__PURE__ */ new Date()).toISOString(), warning: "Signed evidence links expire in five minutes.", property };
}
async function handler(event) {
  const operator = resolveOperator(event);
  if (!operator) return json(401, { error: "Operator token required" });
  const orgs = operator.organizationIds, actor = operator.name;
  const route = pathOf(event);
  try {
    if (event.httpMethod === "GET" && route === "overview") return json(200, await overview(orgs));
    if (event.httpMethod === "GET" && route === "properties") return json(200, await listProperties(orgs));
    const PROPERTY_ROUTES = ["turnover", "needs-human", "escalations", "evidence", "recipients", "timeline", "export", "requests", "request-groups"];
    if (event.httpMethod === "GET" && PROPERTY_ROUTES.includes(route)) await scopedProperty((event.queryStringParameters || {}).propertyId, orgs);
    if (event.httpMethod === "GET" && route === "turnover") {
      const p = event.queryStringParameters || {};
      if (!p.propertyId) return json(400, { error: "propertyId required" });
      return json(200, await turnover(p.propertyId));
    }
    if (event.httpMethod === "GET" && route === "needs-human") {
      const p = event.queryStringParameters || {};
      if (!p.propertyId) return json(400, { error: "propertyId required" });
      return json(200, await needsHuman(p.propertyId));
    }
    if (event.httpMethod === "GET" && route === "messages") {
      const p = event.queryStringParameters || {};
      let query = inOrgs(db().from("messages").select("*,people(name,role,room_id),escalations(tier,status,reason)"), orgs).order("created_at", { ascending: false }).limit(500);
      if (p.propertyId) {
        await scopedProperty(p.propertyId, orgs);
        query = query.eq("property_id", p.propertyId);
      }
      if (p.personId) query = query.eq("person_id", p.personId);
      if (p.q) query = query.textSearch("body", p.q, { type: "websearch" });
      const [rows, names] = await Promise.all([query, propertyNameMap(orgs)]);
      return json(200, must(rows, "messages").map((message) => ({ ...message, properties: names.get(message.property_id) || null })));
    }
    if (event.httpMethod === "GET" && route === "escalations") {
      const p = event.queryStringParameters || {};
      if (!p.propertyId) return json(400, { error: "propertyId required" });
      return json(200, must(await db().from("escalations").select("*,messages(body,created_at,person_id,people(name)),properties(display_name)").eq("property_id", p.propertyId).order("created_at", { ascending: false }), "escalations"));
    }
    if (event.httpMethod === "GET" && route === "evidence") {
      const p = event.queryStringParameters || {};
      if (!p.propertyId) return json(400, { error: "propertyId required" });
      const rows = await db().from("evidence").select("*,people(name),rooms(label)").eq("property_id", p.propertyId).order("captured_at", { ascending: false });
      return json(200, await signedEvidence(must(rows, "evidence")));
    }
    if (event.httpMethod === "GET" && route === "recipients") {
      const p = event.queryStringParameters || {};
      if (!p.propertyId) return json(400, { error: "propertyId required" });
      const [peopleResult, conversationsResult] = await Promise.all([
        db().from("people").select("id,name,role,consent_status,opted_out_at,lease_group_id").eq("property_id", p.propertyId).neq("consent_status", "opted_out").is("opted_out_at", null).order("name"),
        db().from("conversations").select("id,person_id").eq("property_id", p.propertyId)
      ]);
      const people = must(peopleResult, "message recipients");
      const conversations = must(conversationsResult, "recipient conversations");
      const conversationByPerson = new Map(conversations.map((conversation) => [conversation.person_id, conversation.id]));
      return json(200, people.map((person) => ({ ...person, conversation_id: conversationByPerson.get(person.id) || null })));
    }
    if (event.httpMethod === "GET" && route === "timeline") {
      const p = event.queryStringParameters || {};
      if (!p.propertyId) return json(400, { error: "propertyId required" });
      const byPerson = (query) => p.personId ? query.eq("person_id", p.personId) : query;
      const [messages, calls, evidence, allEvents] = await Promise.all([
        byPerson(db().from("messages").select("id,body,direction,delivery_status,error_code,created_at,people(name)").eq("property_id", p.propertyId)),
        byPerson(db().from("call_logs").select("id,summary,occurred_at,people(name)").eq("property_id", p.propertyId)),
        byPerson(db().from("evidence").select("id,kind,notes,captured_at,people(name)").eq("property_id", p.propertyId)),
        inOrgs(db().from("audit_events").select("id,action,actor,created_at,metadata"), orgs).eq("entity_type", "property").eq("entity_id", p.propertyId)
      ]);
      const events = p.personId && !allEvents.error ? { data: (allEvents.data || []).filter((x) => x.metadata?.personId === p.personId) } : allEvents;
      const timeline = [
        ...must(messages, "timeline messages").map((x) => ({ type: "message", at: x.created_at, ...x })),
        ...must(calls, "timeline calls").map((x) => ({ type: "call", at: x.occurred_at, ...x })),
        ...must(evidence, "timeline evidence").map((x) => ({ type: "evidence", at: x.captured_at, ...x })),
        ...must(events, "timeline audit").map((x) => ({ type: "audit", at: x.created_at, ...x }))
      ].sort((a, b) => new Date(b.at) - new Date(a.at));
      return json(200, timeline);
    }
    if (event.httpMethod === "GET" && route === "requests") {
      const p = event.queryStringParameters || {};
      if (!p.propertyId) return json(400, { error: "propertyId required" });
      return json(200, must(await db().from("info_requests").select("*,request_templates(*),rooms(label)").eq("property_id", p.propertyId).order("sent_at"), "information requests"));
    }
    if (event.httpMethod === "GET" && route === "request-groups") {
      const p = event.queryStringParameters || {};
      if (!p.propertyId) return json(400, { error: "propertyId required" });
      return json(200, must(await db().from("request_groups").select("*,rooms(label)").eq("property_id", p.propertyId).order("created_at"), "request groups"));
    }
    if (event.httpMethod === "GET" && route === "export") {
      const p = event.queryStringParameters || {};
      return p.propertyId ? json(200, await exportProperty(p.propertyId), { "content-disposition": `attachment; filename="hearth-property-${p.propertyId}.json"` }) : json(400, { error: "propertyId required" });
    }
    const payload = bodyOf(event);
    if (event.httpMethod === "POST" && payload.propertyId) await scopedProperty(payload.propertyId, orgs);
    if (event.httpMethod === "POST" && route === "resolve-escalation") {
      let target = inOrgs(db().from("escalations").select("id,property_id"), orgs).eq("id", payload.id);
      if (payload.propertyId) target = target.eq("property_id", payload.propertyId);
      await one(target.single(), "escalation");
      const row = await one(inOrgs(db().from("escalations").update({ status: "resolved", resolved_at: (/* @__PURE__ */ new Date()).toISOString() }), orgs).eq("id", payload.id).eq("status", "open").select().single(), "open escalation");
      await audit(row.organization_id, "escalation_resolved", "escalation", row.id, {}, actor);
      await audit(row.organization_id, "escalation_resolved", "property", row.property_id, { escalationId: row.id, summary: `Marked handled: ${row.reason}` }, actor);
      return json(200, row);
    }
    if (event.httpMethod === "POST" && route === "releasing") {
      const allowed = ["renewal", "guarantor_confirmed", "signature_status", "next_room_id", "rent_share_agreed", "reminder_sent_at", "reminder_acknowledged_at"];
      const update = Object.fromEntries(Object.entries(payload.changes || {}).filter(([key]) => allowed.includes(key)));
      update.updated_at = (/* @__PURE__ */ new Date()).toISOString();
      let target = inOrgs(db().from("releasing_status").select("id,property_id"), orgs).eq("id", payload.id);
      if (payload.propertyId) target = target.eq("property_id", payload.propertyId);
      const renewal = await one(target.single(), "renewal record");
      if (update.next_room_id) await one(inOrgs(db().from("rooms").select("id"), orgs).eq("id", update.next_room_id).eq("property_id", renewal.property_id).single(), "room");
      return json(200, must(await inOrgs(db().from("releasing_status").update(update), orgs).eq("id", payload.id).eq("property_id", renewal.property_id).select().single(), "update releasing"));
    }
    if (event.httpMethod === "POST" && route === "workflow-task") {
      const taskKey = String(payload.taskKey || "");
      if (!payload.propertyId) return json(400, { error: "propertyId required" });
      if (!TURNOVER_TASK_KEYS.has(taskKey)) return json(400, { error: "Unsupported turnover task" });
      if (!["pending", "complete"].includes(payload.status)) return json(400, { error: "Invalid workflow status" });
      if (taskKey === "key_status" && !["not issued", "issued", "returned"].includes(payload.valueText)) return json(400, { error: "Invalid key status" });
      const person = await one(inOrgs(db().from("people").select("id,organization_id,property_id"), orgs).eq("id", payload.personId).eq("property_id", payload.propertyId).eq("role", "student").single(), "turnover student");
      const valueText = payload.status === "complete" ? String(payload.valueText || "").trim().slice(0, 120) || null : taskKey === "key_status" ? "not issued" : null;
      const task = must(await db().from("workflow_tasks").upsert({ organization_id: person.organization_id, property_id: person.property_id, person_id: person.id, task_key: taskKey, status: payload.status, value_text: valueText, completed_at: payload.status === "complete" ? (/* @__PURE__ */ new Date()).toISOString() : null }, { onConflict: "person_id,task_key" }).select().single(), "update turnover task");
      await audit(person.organization_id, "turnover_task_updated", "property", person.property_id, { personId: person.id, taskKey, status: task.status, valueText: task.value_text }, actor);
      return json(200, task);
    }
    if (event.httpMethod === "POST" && route === "manual-reply") {
      let conversation;
      let sourceMessage = null;
      if (payload.sourceMessageId) {
        if (!payload.propertyId) return json(400, { error: "propertyId required" });
        sourceMessage = await one(inOrgs(db().from("messages").select("id,organization_id,property_id,lease_group_id,person_id,conversation_id,needs_human,human_answered_at,people(*)"), orgs).eq("id", payload.sourceMessageId).eq("property_id", payload.propertyId).eq("direction", "inbound").eq("needs_human", true).is("human_answered_at", null).single(), "open needs-human message");
        conversation = await one(inOrgs(db().from("conversations").select("*,people(*)"), orgs).eq("id", sourceMessage.conversation_id).eq("property_id", payload.propertyId).single(), "needs-human conversation");
      } else if (payload.conversationId) {
        if (!payload.propertyId) return json(400, { error: "propertyId required" });
        conversation = await one(inOrgs(db().from("conversations").select("*,people(*)"), orgs).eq("id", payload.conversationId).eq("property_id", payload.propertyId).single(), "manual conversation");
      } else {
        if (!payload.propertyId) return json(400, { error: "propertyId required" });
        const person = await one(inOrgs(db().from("people").select("*"), orgs).eq("id", payload.personId).eq("property_id", payload.propertyId).single(), "manual recipient");
        conversation = must(await db().from("conversations").upsert({ organization_id: person.organization_id, property_id: person.property_id, lease_group_id: person.lease_group_id, person_id: person.id, last_activity: (/* @__PURE__ */ new Date()).toISOString() }, { onConflict: "property_id,lease_group_id,person_id" }).select("*,people(*)").single(), "create manual conversation");
      }
      const numbers = must(await db().from("phone_numbers").select("sms_number,active").eq("property_id", conversation.property_id).eq("active", true), "manual reply property number");
      const from = numbers[0]?.sms_number;
      if (!from) return json(409, { error: "No active property number" });
      const sent = await sendAndPersist({ organizationId: conversation.organization_id, propertyId: conversation.property_id, leaseGroupId: conversation.lease_group_id, person: conversation.people, conversationId: conversation.id, from, body: String(payload.body || "").trim().slice(0, 1500), inReplyToMessageId: sourceMessage?.id || null });
      if (sourceMessage) {
        const answeredAt = (/* @__PURE__ */ new Date()).toISOString();
        must(await db().from("messages").update({ human_answered_at: answeredAt }).eq("id", sourceMessage.id).eq("property_id", sourceMessage.property_id).select().single(), "mark needs-human answered");
        await audit(conversation.organization_id, "needs_human_answered", "message", sourceMessage.id, { replyMessageId: sent.id }, actor);
      }
      await audit(conversation.organization_id, "manual_reply_sent", "message", sent.id, { reason: String(payload.reason || "").slice(0, 300) }, actor);
      return json(201, sent);
    }
    if (event.httpMethod === "POST" && route === "request-decision" && payload.groupId) {
      if (!payload.propertyId) return json(400, { error: "propertyId required" });
      const group = await one(inOrgs(db().from("request_groups").select("*"), orgs).eq("id", payload.groupId).eq("property_id", payload.propertyId).single(), "request group");
      const decision = payload.decision ?? null, note = String(payload.note || "").trim().slice(0, 300);
      if (decision !== null && !["approve", "hold", "reject"].includes(decision)) return json(400, { error: "Invalid decision" });
      if (decision === null && !group.decision) return json(409, { error: "Nothing to undo" });
      if (decision !== null && group.decision) return json(409, { error: "Already decided \xB7 undo first" });
      if (decision !== null && !note) return json(400, { error: "Say why \xB7 it is kept in the record" });
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const row = must(await db().from("request_groups").update(decision === null ? { decision: null, decision_note: null, decided_at: null } : { decision, decision_note: note, decided_at: now }).eq("id", group.id).eq("property_id", group.property_id).select("*,rooms(label)").single(), "update request group");
      const summary = decision === null ? `${group.label}: you undid \u201C${DECISION_WORDS[group.decision]}\u201D (${group.decision_note})` : `${group.label}: you chose \u201C${DECISION_WORDS[decision]}\u201D \xB7 ${note}`;
      await audit(group.organization_id, decision === null ? "request_group_decision_undone" : "request_group_decided", "property", group.property_id, { groupId: group.id, summary }, actor);
      return json(200, row);
    }
    if (event.httpMethod === "POST" && ["request-answer", "request-follow-up", "request-decision"].includes(route)) {
      if (!payload.propertyId || !payload.requestId) return json(400, { error: "propertyId and requestId required" });
      const request = await one(inOrgs(db().from("info_requests").select("*,request_templates(*)"), orgs).eq("id", payload.requestId).eq("property_id", payload.propertyId).single(), "information request");
      const now = (/* @__PURE__ */ new Date()).toISOString(), who = request.subject_name, form = request.request_templates?.title || "request";
      let changes, action, summary;
      if (route === "request-answer") {
        const field = (request.request_templates?.fields || []).find((item) => item.key === payload.fieldKey);
        const value = String(payload.value || "").trim().slice(0, 500), source = String(payload.source || "").trim().slice(0, 120);
        if (!field) return json(400, { error: "Unknown field for this form" });
        if (!value || !source) return json(400, { error: "Answer and where it came from are both required" });
        if (request.decision) return json(409, { error: "Undo the decision before changing answers" });
        changes = { answers: { ...request.answers || {}, [field.key]: { value, source, recorded_at: now } }, response_received_at: request.response_received_at || now };
        action = "request_answer_recorded";
        summary = `${form} for ${who}: ${field.short || field.label} \u2014 \u201C${value}\u201D \xB7 from ${source}`;
      } else if (route === "request-follow-up") {
        if (request.decision) return json(409, { error: "Already decided" });
        changes = { last_follow_up_at: now, follow_up_count: (request.follow_up_count || 0) + 1 };
        action = "request_follow_up_sent";
        summary = `${form} for ${who}: you marked a follow-up to ${request.requested_from_name} as sent by ${request.channel || "a channel outside Hearth"}`;
      } else {
        const decision = payload.decision ?? null, note = String(payload.note || "").trim().slice(0, 300);
        if (decision !== null && !["approve", "hold", "reject"].includes(decision)) return json(400, { error: "Invalid decision" });
        if (decision === null && !request.decision) return json(409, { error: "Nothing to undo" });
        if (decision !== null && request.decision) return json(409, { error: "Already decided \xB7 undo first" });
        if (decision !== null && !note) return json(400, { error: "Say why \xB7 it is kept in the record" });
        changes = decision === null ? { decision: null, decision_note: null, decided_at: null } : { decision, decision_note: note, decided_at: now };
        action = decision === null ? "request_decision_undone" : "request_decided";
        summary = decision === null ? `${form} for ${who}: you undid \u201C${DECISION_WORDS[request.decision]}\u201D (${request.decision_note})` : `${form} for ${who}: you chose \u201C${DECISION_WORDS[decision]}\u201D \xB7 ${note}`;
      }
      const row = must(await db().from("info_requests").update(changes).eq("id", request.id).eq("property_id", request.property_id).select("*,request_templates(*),rooms(label)").single(), "update information request");
      await audit(request.organization_id, action, "property", request.property_id, { requestId: request.id, summary }, actor);
      return json(200, row);
    }
    if (event.httpMethod === "POST" && route === "call-log") {
      let personQuery = inOrgs(db().from("people").select("organization_id,property_id"), orgs).eq("id", payload.personId);
      if (payload.propertyId) personQuery = personQuery.eq("property_id", payload.propertyId);
      const person = await one(personQuery.single(), "call person");
      const row = must(await db().from("call_logs").insert({ organization_id: person.organization_id, property_id: person.property_id, person_id: payload.personId, occurred_at: payload.occurredAt || (/* @__PURE__ */ new Date()).toISOString(), summary: String(payload.summary || "").trim() }).select().single(), "call log");
      return json(201, row);
    }
    return json(404, { error: "Not found" });
  } catch (error) {
    if (error instanceof NotFound) return json(404, { error: error.message });
    if (error instanceof BadRequest) return json(400, { error: error.message });
    console.error("operator_api_error", error);
    return json(500, { error: error.message });
  }
}

// src/money.js
function toCents(dollars) {
  const n = typeof dollars === "string" ? Number(dollars) : dollars;
  if (!Number.isFinite(n)) throw new TypeError(`not a money amount: ${dollars}`);
  return Math.round(n * 100);
}
function money(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const d = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${d}.${String(abs % 100).padStart(2, "0")}`;
}

// src/allocation.js
var periodKey = (label) => String(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function canonical(snapshot) {
  return JSON.stringify({
    property: snapshot.propertyId,
    period: snapshot.period.key,
    total: snapshot.totalCents,
    lines: snapshot.lines.map((line) => [line.personId, line.amountCents]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  });
}
function shortLabel(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
function allocationFor({ propertyId, activity, people }) {
  if (!activity) return null;
  const byId = new Map((people || []).map((person) => [person.id, person]));
  const totalCents = toCents(activity.total);
  const lines = (activity.entries || []).map((entry) => {
    const person = byId.get(entry.personId);
    return {
      personId: entry.personId,
      name: person?.name || "Unknown resident",
      roomId: person?.room_id || null,
      amountCents: toCents(entry.amount),
      amountLabel: money(toCents(entry.amount)),
      // "received" is the household's own record of who has paid in. It is NOT a
      // payment-provider state and never becomes one: a provider's status is the
      // only thing that can say an invoice was paid.
      recordedByHousehold: entry.state === "received",
      recordedOn: entry.recorded || null
    };
  });
  const allocatedCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const snapshot = {
    propertyId,
    period: { label: activity.period, key: periodKey(activity.period), due: activity.due, followUp: activity.followUp },
    totalCents,
    totalLabel: money(totalCents),
    allocatedCents,
    allocatedLabel: money(allocatedCents),
    // Signed: positive means the shares overshoot the rent, negative means short.
    differenceCents: allocatedCents - totalCents,
    lines,
    source: activity.source || null
  };
  snapshot.balances = snapshot.differenceCents === 0;
  snapshot.differenceLabel = money(Math.abs(snapshot.differenceCents));
  snapshot.version = canonical(snapshot);
  snapshot.versionLabel = shortLabel(snapshot.version);
  return snapshot;
}

// src/allocation-state.js
var canonicalLines = (lines) => Object.entries(lines).map(([personId, cents]) => [personId, Math.round(Number(cents) || 0)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
var SEEDED_AI_FIELDS = {
  aiBasis: "basis",
  aiWeights: "weights",
  aiUnknowns: "unknowns",
  aiExcludedFactors: "excludedFactors",
  aiFactorSelection: "factorSelection",
  aiModelId: "modelId"
};
function seedVersion(activity) {
  if (!activity || !(activity.entries || []).length) return null;
  const lines = {};
  for (const entry of activity.entries || []) lines[entry.personId] = Math.round(Number(entry.amount) * 100);
  const version = { n: 1, state: activity.seedState || "proposed", lines, createdAt: null, note: activity.source || null };
  for (const [onActivity, onVersion] of Object.entries(SEEDED_AI_FIELDS)) {
    if (activity[onActivity] !== void 0) version[onVersion] = activity[onActivity];
  }
  return version;
}
function workspaceFor({ activity, stored }) {
  const seed = seedVersion(activity);
  const versions = stored?.versions?.length ? stored.versions : seed ? [seed] : null;
  if (!versions) return null;
  const current = versions[versions.length - 1];
  const confirmations = stored?.confirmations || {};
  const approval = stored?.approval || null;
  return { versions, current, confirmations, approval, requiredCents: Math.round(Number(activity.total) * 100) };
}
function activityForVersion(activity, version) {
  if (!activity || !version) return activity;
  const covered = new Set((activity.entries || []).map((entry) => entry.personId));
  const updated = (activity.entries || []).map((entry) => ({
    ...entry,
    amount: Object.hasOwn(version.lines, entry.personId) ? version.lines[entry.personId] / 100 : entry.amount
  }));
  const added = Object.keys(version.lines).filter((personId) => !covered.has(personId)).map((personId) => ({ personId, amount: version.lines[personId] / 100 }));
  return { ...activity, entries: [...updated, ...added] };
}
function confirmedFor(workspace, versionCanonical) {
  return Object.entries(workspace?.confirmations || {}).filter(([, record]) => record.versionCanonical === versionCanonical).map(([personId]) => personId);
}
function allocationStatus({ snapshot, workspace, invoices = [], residentCount, provider = {} }) {
  const none = { tone: "pending", headline: "No rent split yet", detail: "Nothing has been proposed for this period.", waitingOn: "landlord" };
  if (!snapshot || !workspace) return none;
  const version = workspace.current;
  const label = `v${version.n}`;
  const people = residentCount ?? snapshot.lines.length;
  const confirmed = confirmedFor(workspace, snapshot.version);
  const issued = invoices.filter((invoice) => invoice && invoice.providerInvoiceId);
  const uncertain = issued.filter((invoice) => invoice.localState === "send_uncertain");
  if (uncertain.length) {
    return { tone: "overdue", headline: `${uncertain.length} invoice${uncertain.length === 1 ? "" : "s"} need${uncertain.length === 1 ? "s" : ""} checking`, detail: "A send result was never confirmed. Check with the provider before retrying.", waitingOn: "landlord", label };
  }
  const staleInvoices = issued.filter((invoice) => invoice.stale);
  if (staleInvoices.length) {
    return { tone: "overdue", headline: `${staleInvoices.length} invoice${staleInvoices.length === 1 ? "" : "s"} issued against older numbers`, detail: "The split changed after these were sent. Use a correction rather than editing the share.", waitingOn: "landlord", label };
  }
  const failed = issued.filter((invoice) => invoice.localState === "create_failed" || invoice.localState === "send_failed");
  if (failed.length) {
    return { tone: "blocked", headline: `${failed.length} invoice${failed.length === 1 ? "" : "s"} failed to go out`, detail: "The others are unaffected. Retry only the ones that failed.", waitingOn: "landlord", label };
  }
  if (!snapshot.balances) {
    const short = snapshot.differenceCents < 0;
    return {
      tone: "blocked",
      headline: `Draft ${label} \xB7 ${money(Math.abs(snapshot.differenceCents))} ${short ? "short" : "over"}`,
      detail: `Saved, but it cannot go to residents or be collected until the shares total ${snapshot.totalLabel}.`,
      waitingOn: "landlord",
      label
    };
  }
  if (version.state === "draft") {
    return { tone: "needs-decision", headline: `Draft ${label} balanced \xB7 not sent to residents`, detail: `${snapshot.totalLabel} allocated across ${people} ${people === 1 ? "resident" : "residents"}. Publish it for confirmation.`, waitingOn: "landlord", label };
  }
  if (version.state === "proposed") {
    if (confirmed.length < people) {
      return { tone: "pending", headline: `Rent proposal awaiting review \xB7 ${confirmed.length} of ${people} confirmed`, detail: confirmed.length ? `Waiting on ${people - confirmed.length} resident${people - confirmed.length === 1 ? "" : "s"}.` : "Shared with residents to confirm. Nobody has confirmed yet.", waitingOn: "residents", label };
    }
    return { tone: "needs-decision", headline: `Ready for your approval \xB7 ${label}`, detail: `All ${people} residents confirmed these numbers. Approving authorizes collection.`, waitingOn: "landlord", label };
  }
  const collectable = snapshot.lines.length;
  if (!provider.available) {
    return { tone: "complete", headline: `Approved ${label} \xB7 collection unavailable`, detail: provider.reason || "No payment provider is connected in this mode.", waitingOn: "nobody", label };
  }
  const mappedCount = provider.mappedCount ?? collectable;
  const sent = issued.filter((invoice) => invoice.localState === "sent");
  const drafts = issued.length - sent.length;
  const draftNote = drafts ? ` ${drafts} draft${drafts === 1 ? "" : "s"} prepared, not sent.` : "";
  if (!sent.length) {
    return mappedCount ? { tone: "needs-decision", headline: `Approved ${label} \xB7 ${collectable} invoice${collectable === 1 ? "" : "s"} not yet sent`, detail: `The split is agreed. Nothing has been sent for this period.${draftNote}`, waitingOn: "landlord", label } : { tone: "pending", headline: `Approved ${label} \xB7 no billing destination yet`, detail: "Collection needs a billing destination for each resident.", waitingOn: "landlord", label };
  }
  const paidCents = issued.reduce((sum, invoice) => sum + (invoice.paidCents || 0), 0);
  if (paidCents >= snapshot.totalCents && sent.length >= collectable) {
    return { tone: "complete", headline: `${snapshot.period.label} collected in full`, detail: `${snapshot.totalLabel} received from ${collectable} ${collectable === 1 ? "resident" : "residents"}.`, waitingOn: "nobody", label };
  }
  if (sent.length < collectable) {
    const remaining = collectable - sent.length;
    return { tone: "needs-decision", headline: `Approved ${label} \xB7 ${remaining} invoice${remaining === 1 ? "" : "s"} not yet sent`, detail: `${money(paidCents)} of ${snapshot.totalLabel} collected so far.${draftNote}`, waitingOn: "landlord", label };
  }
  return { tone: "pending", headline: `${money(paidCents)} of ${snapshot.totalLabel} collected`, detail: `All ${collectable} invoices are out. Waiting on residents to pay.`, waitingOn: "residents", label };
}
function publishBlockedReason(snapshot, version) {
  if (!snapshot || !version) return "There is no allocation to publish yet. Draft one first.";
  if (!snapshot.balances) {
    const short = snapshot.differenceCents < 0;
    return `The shares are ${snapshot.differenceLabel} ${short ? "short of" : "over"} the ${snapshot.totalLabel} total. A draft can be saved unbalanced; it cannot be sent to residents until it matches exactly.`;
  }
  if (version.state === "proposed") return "This version has already been published to residents.";
  if (version.state === "agreed") return "This version is already agreed.";
  return null;
}
function approveBlockedReason(snapshot, workspace) {
  if (!snapshot || !workspace) return "There is no allocation to approve yet. Draft one first.";
  const version = workspace.current;
  if (!snapshot.balances) return publishBlockedReason(snapshot, version);
  if (version.state === "draft") return "This version has not been published to residents yet, so nobody has confirmed it.";
  if (version.state === "agreed") return "This version is already approved.";
  const confirmed = confirmedFor(workspace, snapshot.version);
  const missing = snapshot.lines.filter((line) => !confirmed.includes(line.personId));
  if (missing.length) return `${missing.map((line) => line.name).join(", ")} ${missing.length === 1 ? "has" : "have"} not confirmed ${`v${version.n}`}. Approval needs every resident on this version.`;
  return null;
}
function withShare(workspace, { personId, cents }) {
  const current = workspace?.current;
  if (!current) return { version: { n: 1, state: "draft", lines: { [personId]: Math.round(cents) }, createdAt: (/* @__PURE__ */ new Date()).toISOString(), note: null }, created: true };
  const lines = { ...current.lines, [personId]: Math.round(cents) };
  if (JSON.stringify(canonicalLines(lines)) === JSON.stringify(canonicalLines(current.lines))) {
    return { version: current, created: false };
  }
  if (current.state === "draft") {
    return { version: { ...current, lines, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }, created: false };
  }
  return { version: { n: current.n + 1, state: "draft", lines, createdAt: (/* @__PURE__ */ new Date()).toISOString(), note: null }, created: true };
}

// server/allocation-api.mjs
var routeOf = (event) => (event.path.split("/api/allocation/")[1] || "").replace(/\/$/, "");
var bodyOf2 = (event) => {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return null;
  }
};
var blocksEditing = (invoice) => Boolean(invoice.providerInvoiceId) || invoice.localState === "draft_proposed";
function createAllocationHandler({
  store,
  invoicesFor = () => [],
  provider = { available: false, reason: "No payment provider is connected in this mode." },
  ai = { available: false, reason: "No AI is connected in this mode." },
  proposeAiDraft = async () => {
    throw new Error("AI is not connected in this mode.");
  },
  proposeAiRedraft = async () => {
    throw new Error("AI is not connected in this mode.");
  }
}) {
  async function scopedProperty2(propertyId, orgs) {
    if (!propertyId) return null;
    const { data } = await db().from("properties").select("id,organization_id,display_name,address").eq("id", propertyId).in("organization_id", orgs).single();
    return data || null;
  }
  async function resolve(propertyId, orgs) {
    const property = await scopedProperty2(propertyId, orgs);
    if (!property) return { error: json(404, { error: "property not found" }) };
    const seedActivity = demoMeta.rentActivity?.[property.id];
    if (!seedActivity) return { error: json(409, { error: "This property has no rent period set up.", code: "NO_PERIOD" }) };
    const identity = { propertyId: property.id, periodKey: periodKey(seedActivity.period) };
    const stored = store.get(identity);
    const workspace = workspaceFor({ activity: seedActivity, stored });
    const { data: people } = await db().from("people").select("id,name,room_id,role").eq("property_id", property.id);
    const snapshot = workspace ? allocationFor({ propertyId: property.id, activity: activityForVersion(seedActivity, workspace.current), people: people || [] }) : null;
    return { property, seedActivity, identity, stored, workspace, snapshot, people: people || [] };
  }
  const residentsOf = (people) => (people || []).filter((person) => person.role === "student" || !person.role);
  function view({ property, seedActivity, identity, workspace, snapshot, people }) {
    const hasAllocation = Boolean(workspace && snapshot);
    const invoices = invoicesFor(identity.propertyId, identity.periodKey);
    const withStaleness = invoices.map((invoice) => ({
      ...invoice,
      stale: Boolean(hasAllocation && invoice.approvedAllocationVersion && invoice.approvedAllocationVersion !== snapshot.version)
    }));
    const invoiceFor = new Map(withStaleness.filter((invoice) => invoice.personId).map((invoice) => [invoice.personId, invoice]));
    const confirmed = hasAllocation ? confirmedFor(workspace, snapshot.version) : [];
    const agreedOnFile = hasAllocation && workspace.current.state === "agreed" && Object.keys(workspace.confirmations).length === 0;
    const seedConfirmedOn = new Map((seedActivity.entries || []).map((entry) => [entry.personId, entry.confirmedOn || null]));
    const status = allocationStatus({ snapshot, workspace, invoices: withStaleness, residentCount: hasAllocation ? snapshot.lines.length : residentsOf(people).length, provider });
    const requiredCents = hasAllocation ? snapshot.totalCents : toCents(seedActivity.total);
    return {
      property: { id: property.id, display_name: property.display_name, address: property.address },
      dataset: { label: demoMeta.label, disclaimer: demoMeta.disclaimer, provenance: demoMeta.provenance || null },
      period: hasAllocation ? snapshot.period : { label: seedActivity.period, key: periodKey(seedActivity.period), due: seedActivity.due, followUp: seedActivity.followUp },
      total: hasAllocation ? {
        requiredCents,
        requiredLabel: money(requiredCents),
        allocatedCents: snapshot.allocatedCents,
        allocatedLabel: snapshot.allocatedLabel,
        differenceCents: snapshot.differenceCents,
        differenceLabel: snapshot.differenceLabel,
        balances: snapshot.balances,
        basis: seedActivity.source || null,
        illustrative: Boolean(seedActivity.illustrative),
        allocationBasis: seedActivity.basis || null
      } : {
        // No allocatedCents/differenceCents here at all, deliberately — not 0,
        // not null disguised as a number. "$0.00 collected" and "$0.00 short" are
        // both claims about a split that exists; this property has none yet, and
        // the only honest numbers to show are the ones the household already
        // knows: the lease total, and nothing it hasn't decided.
        requiredCents,
        requiredLabel: money(requiredCents),
        allocatedCents: null,
        allocatedLabel: null,
        differenceCents: null,
        differenceLabel: null,
        balances: false,
        basis: seedActivity.source || null,
        illustrative: Boolean(seedActivity.illustrative),
        allocationBasis: seedActivity.basis || null
      },
      version: hasAllocation ? {
        n: workspace.current.n,
        state: workspace.current.state,
        label: snapshot.versionLabel,
        canonical: snapshot.version,
        count: workspace.versions.length,
        // Present only on a version an AI call produced. A manually-typed version
        // carries none of these, and the screen must tell the two apart: a basis
        // line and an excluded-factors note are claims about how the number was
        // reached, not decoration on any version.
        aiBasis: workspace.current.basis || null,
        aiWeights: workspace.current.weights || null,
        aiUnknowns: workspace.current.unknowns || null,
        excludedFactors: workspace.current.excludedFactors || null,
        // What produced this version, not just what it concluded — a model id and
        // the factor selection it ran under, present on every AI-authored version.
        modelId: workspace.current.modelId || null,
        aiFactorSelection: workspace.current.factorSelection || null,
        // Present only on a redraft: the complaint that produced THIS version,
        // specifically, and the rating recorded alongside it.
        feedback: workspace.current.feedback || null,
        rating: workspace.current.rating ?? null
      } : null,
      // The round before this one, for comparison — "round one beside round two
      // is the whole argument for the feature." Only the previous version's own
      // facts (its weights, basis, the feedback that produced the NEXT one):
      // dollar amounts are read off `line.amountCents` scoped to each version
      // below, so a resident's name never has to be re-derived from a stale set.
      previousVersion: (() => {
        if (!hasAllocation) return null;
        const versions = workspace.versions;
        if (versions.length < 2) return null;
        const previous = versions[versions.length - 2];
        return {
          n: previous.n,
          lines: snapshot.lines.map((line) => ({ personId: line.personId, name: line.name, amountCents: previous.lines?.[line.personId] ?? null })),
          aiBasis: previous.basis || null,
          aiWeights: previous.weights || null,
          excludedFactors: previous.excludedFactors || null,
          modelId: previous.modelId || null,
          // The complaint that led FROM this previous round TO the current one —
          // i.e. the feedback recorded on the current version, shown here so the
          // comparison reads as "this is what changed, and why."
          answeredFeedback: workspace.current.feedback || null
        };
      })(),
      status,
      approval: hasAllocation ? workspace.approval || (agreedOnFile && seedActivity.approvedOn ? { actor: "Demo operator", on: seedActivity.approvedOn, versionLabel: snapshot.versionLabel, seeded: true } : null) : null,
      // Editable until the version has been published. After that, editing creates
      // a new version rather than changing what residents were shown.
      roomFactsUnknown: Boolean(demoMeta.provenance?.unknown?.some((fact) => /room (area|size)/i.test(fact))),
      // Every resident is listed, whether or not they have a line in this version
      // yet. A partial split — one typed share among twelve residents — must still
      // show all twelve; the eleven without a figure get amountCents: null, not
      // silent omission from the array.
      lines: (() => {
        const byPersonId = hasAllocation ? new Map(snapshot.lines.map((line) => [line.personId, line])) : null;
        return residentsOf(people).map((person) => {
          const line = byPersonId?.get(person.id);
          if (!line) {
            return {
              personId: person.id,
              name: person.name,
              roomId: person.room_id,
              amountCents: null,
              amountLabel: null,
              recipientMapped: provider.mappedPersonIds ? provider.mappedPersonIds.includes(person.id) : false,
              invoice: null,
              confirmed: false,
              confirmedBySeed: false,
              confirmedOn: null,
              confirmedAt: null,
              confirmedOtherVersion: null
            };
          }
          return {
            ...line,
            // Whether this resident has a billing destination at all. Injected as a
            // list of person ids rather than read from a payments module, so the
            // offline bundle still carries no provider code. Without it the Rent page
            // showed "No billing destination" for everyone, which happened to be true
            // while one resident was mapped and would have stayed wrong as soon as a
            // second was added.
            recipientMapped: provider.mappedPersonIds ? provider.mappedPersonIds.includes(line.personId) : false,
            // What the provider last said about this resident's share, if anything.
            // Kept in its own field: an agreed share and a collected payment are
            // different facts and the screen shows them in different columns.
            invoice: invoiceFor.get(line.personId) || null,
            confirmed: confirmed.includes(line.personId) || agreedOnFile,
            confirmedBySeed: agreedOnFile && !confirmed.includes(line.personId),
            // WHEN they confirmed, so the screen can show Hearth collecting the
            // agreement rather than reporting a bare state.
            confirmedOn: workspace.confirmations[line.personId]?.versionCanonical === snapshot.version ? workspace.confirmations[line.personId].at : agreedOnFile ? seedConfirmedOn.get(line.personId) : null,
            confirmedAt: workspace.confirmations[line.personId]?.versionCanonical === snapshot.version ? workspace.confirmations[line.personId].at : null,
            // A confirmation of an EARLIER version is shown as such rather than as
            // nothing: "they agreed, to different numbers" is useful to the landlord.
            confirmedOtherVersion: Boolean(workspace.confirmations[line.personId] && workspace.confirmations[line.personId].versionCanonical !== snapshot.version) ? workspace.confirmations[line.personId].versionLabel : null
          };
        });
      })(),
      blocked: {
        publish: hasAllocation ? publishBlockedReason(snapshot, workspace.current) : "There is no allocation yet. Draft one first.",
        approve: hasAllocation ? approveBlockedReason(snapshot, workspace) : "There is no allocation yet. Draft one first."
      },
      history: (store.get(identity)?.history || []).slice(-20),
      provider,
      ai
    };
  }
  return async function handler2(event) {
    const operator = resolveOperator(event);
    if (!operator) return json(401, { error: "Operator token required" });
    const orgs = operator.organizationIds, actor = operator.name;
    const route = routeOf(event);
    try {
      if (event.httpMethod === "GET" && route === "workspace") {
        const resolved2 = await resolve((event.queryStringParameters || {}).propertyId, orgs);
        if (resolved2.error) return resolved2.error;
        return json(200, view(resolved2));
      }
      const payload = bodyOf2(event);
      if (payload === null) return json(400, { error: "Request body must be JSON" });
      const resolved = await resolve(payload.propertyId, orgs);
      if (resolved.error) return resolved.error;
      const { property, seedActivity, identity, workspace, snapshot, people } = resolved;
      if (["share", "publish", "confirm", "approve", "ai-draft", "ai-redraft"].includes(route) && event.httpMethod === "POST") {
        if (snapshot) {
          if (!payload.versionCanonical) return json(400, { error: "versionCanonical is required: name the exact split you are acting on.", code: "VERSION_REQUIRED" });
          if (payload.versionCanonical !== snapshot.version) {
            const who = route === "confirm" ? snapshot.lines.find((x) => x.personId === payload.personId)?.name : null;
            return json(409, { error: who ? `${who} was shown different numbers. Version ${snapshot.versionLabel} is current.` : `The split changed since you opened it. Version ${snapshot.versionLabel} is current. Reload and check the numbers again.`, code: "STALE_VERSION", currentVersion: snapshot.version });
          }
        } else if (payload.versionCanonical) {
          return json(409, { error: "There is no allocation yet for this period, so there is no version to match.", code: "STALE_VERSION", currentVersion: null });
        }
      }
      if (event.httpMethod === "POST" && route === "share") {
        const residentExists = snapshot ? snapshot.lines.some((x) => x.personId === payload.personId) : residentsOf(people).some((p) => p.id === payload.personId);
        if (!residentExists) return json(404, { error: "resident not found in this allocation" });
        const cents = Number(payload.amountCents);
        if (!Number.isSafeInteger(cents)) return json(400, { error: "amountCents must be a whole number of cents.", code: "NOT_INTEGER_CENTS" });
        if (cents < 0) return json(400, { error: "A share cannot be negative.", code: "NEGATIVE_SHARE" });
        const requiredCents = snapshot ? snapshot.totalCents : toCents(seedActivity.total);
        if (cents > requiredCents) return json(400, { error: `One share cannot be more than the whole rent (${money(requiredCents)}).`, code: "SHARE_EXCEEDS_RENT" });
        if (invoicesFor(identity.propertyId, identity.periodKey).some(blocksEditing)) {
          return json(409, { error: provider.simulated ? "Invoices already exist for this period, so the split cannot be edited here. In this offline demo, reload the page to start over." : "Invoices already exist for this period, so the split cannot be edited here. Void them in PayPal and record a correction instead.", code: "HAS_INVOICES" });
        }
        const { version, created } = withShare(workspace, { personId: payload.personId, cents });
        store.putVersion(identity, version, { event: created ? "version_created" : "share_edited", actor, personId: payload.personId, amountCents: cents, versionNumber: version.n });
        await audit(property.organization_id, created ? "allocation_version_created" : "allocation_share_edited", "property", property.id, { personId: payload.personId, amountCents: cents, versionNumber: version.n }, actor);
        const after = await resolve(payload.propertyId, orgs);
        return json(200, { ...view(after), createdVersion: created });
      }
      if (event.httpMethod === "POST" && route === "ai-draft") {
        if (!ai.available) return json(409, { error: ai.reason || "No AI is connected in this mode.", code: "AI_UNAVAILABLE" });
        if (invoicesFor(identity.propertyId, identity.periodKey).some(blocksEditing)) {
          return json(409, { error: "Invoices already exist for this period, so a new split cannot be proposed here.", code: "HAS_INVOICES" });
        }
        const { data: rooms } = await db().from("rooms").select("id,label,facts").eq("property_id", property.id);
        const roomFor = new Map((rooms || []).map((room) => [room.id, room]));
        const roomFacts = payload.roomFacts && typeof payload.roomFacts === "object" ? payload.roomFacts : {};
        const residents = residentsOf(people);
        const personIds = residents.map((person) => person.id);
        const roomInputs = residents.map((person) => {
          const extra = typeof roomFacts[person.id] === "string" ? roomFacts[person.id].trim() : "";
          const room = person.room_id ? roomFor.get(person.room_id) : null;
          return { personId: person.id, name: person.name, facts: room?.facts || null, label: room?.label || "", extra };
        });
        const context = typeof payload.context === "string" ? payload.context.trim() : void 0;
        const factorSelection = payload.factorSelection && typeof payload.factorSelection === "object" ? payload.factorSelection : void 0;
        const totalCents = snapshot ? snapshot.totalCents : toCents(seedActivity.total);
        let draft;
        try {
          draft = await proposeAiDraft({ personIds, rooms: roomInputs, context, totalCents, factorSelection });
        } catch (error) {
          if (error.code === "BAD_FACTOR_SELECTION") return json(400, { error: error.message, code: error.code });
          return json(502, { error: `The model's proposal was refused: ${error.message}`, code: "AI_PROPOSAL_REFUSED" });
        }
        const version = {
          n: workspace ? workspace.current.n + 1 : 1,
          state: "draft",
          lines: draft.lines,
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
          note: "Proposed by AI \u2014 review before publishing.",
          basis: draft.basis,
          unknowns: draft.unknowns,
          weights: draft.weights,
          excludedFactors: draft.excludedFactors,
          factorSelection: draft.factorSelection,
          modelId: draft.modelId
        };
        store.putVersion(identity, version, { event: "ai_draft_proposed", actor, versionNumber: version.n });
        await audit(property.organization_id, "allocation_ai_draft_proposed", "property", property.id, { versionNumber: version.n }, actor);
        return json(200, { ...view(await resolve(payload.propertyId, orgs)), createdVersion: true });
      }
      if (event.httpMethod === "POST" && route === "ai-redraft") {
        if (!ai.available) return json(409, { error: ai.reason || "No AI is connected in this mode.", code: "AI_UNAVAILABLE" });
        if (invoicesFor(identity.propertyId, identity.periodKey).some(blocksEditing)) {
          return json(409, { error: "Invoices already exist for this period, so a new split cannot be proposed here.", code: "HAS_INVOICES" });
        }
        if (!workspace || !workspace.current.weights) {
          return json(409, { error: "This version has no AI weights to redraft from. Draft with AI first.", code: "NOTHING_TO_REDRAFT" });
        }
        const { data: rooms } = await db().from("rooms").select("id,label,facts").eq("property_id", property.id);
        const roomFor = new Map((rooms || []).map((room) => [room.id, room]));
        const roomFacts = payload.roomFacts && typeof payload.roomFacts === "object" ? payload.roomFacts : {};
        const residents = residentsOf(people);
        const personIds = residents.map((person) => person.id);
        const roomInputs = residents.map((person) => {
          const extra = typeof roomFacts[person.id] === "string" ? roomFacts[person.id].trim() : "";
          const room = person.room_id ? roomFor.get(person.room_id) : null;
          return { personId: person.id, name: person.name, facts: room?.facts || null, label: room?.label || "", extra };
        });
        const context = typeof payload.context === "string" ? payload.context.trim() : void 0;
        const factorSelection = payload.factorSelection && typeof payload.factorSelection === "object" ? payload.factorSelection : void 0;
        const feedback = payload.feedback && typeof payload.feedback === "object" ? payload.feedback : void 0;
        let draft;
        try {
          draft = await proposeAiRedraft({
            personIds,
            rooms: roomInputs,
            context,
            totalCents: snapshot.totalCents,
            factorSelection,
            previousWeights: workspace.current.weights,
            feedback
          });
        } catch (error) {
          if (error.code === "BAD_FACTOR_SELECTION" || error.code === "BAD_FEEDBACK") return json(400, { error: error.message, code: error.code });
          if (error.code === "REDRAFT_REFUSED") return json(502, { error: error.message, code: error.code });
          return json(502, { error: `The model's proposal was refused: ${error.message}`, code: "AI_PROPOSAL_REFUSED" });
        }
        const version = {
          n: workspace.current.n + 1,
          state: "draft",
          lines: draft.lines,
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
          note: "Redrafted after feedback \u2014 review before publishing.",
          basis: draft.basis,
          unknowns: draft.unknowns,
          weights: draft.weights,
          excludedFactors: draft.excludedFactors,
          factorSelection: draft.factorSelection,
          modelId: draft.modelId,
          feedback: draft.feedback,
          rating: draft.feedback?.rating ?? null
        };
        store.putVersion(identity, version, { event: "ai_redraft_proposed", actor, versionNumber: version.n, feedback: draft.feedback });
        await audit(property.organization_id, "allocation_ai_redraft_proposed", "property", property.id, { versionNumber: version.n, feedback: draft.feedback }, actor);
        return json(200, { ...view(await resolve(payload.propertyId, orgs)), createdVersion: true });
      }
      if (event.httpMethod === "POST" && route === "publish") {
        if (!workspace) return json(409, { error: "There is no allocation yet. Draft one first.", code: "NO_ALLOCATION" });
        const blocked = publishBlockedReason(snapshot, workspace.current);
        if (blocked) return json(409, { error: blocked, code: snapshot.balances ? "ALREADY_PUBLISHED" : "ALLOCATION_DOES_NOT_BALANCE" });
        store.putVersion(identity, { ...workspace.current, state: "proposed", publishedAt: (/* @__PURE__ */ new Date()).toISOString() }, { event: "version_published", actor, versionNumber: workspace.current.n, versionLabel: snapshot.versionLabel });
        await audit(property.organization_id, "allocation_published", "property", property.id, { versionNumber: workspace.current.n, versionLabel: snapshot.versionLabel }, actor);
        return json(200, view(await resolve(payload.propertyId, orgs)));
      }
      if (event.httpMethod === "POST" && route === "confirm") {
        if (!workspace) return json(409, { error: "There is no allocation yet. Draft one first.", code: "NO_ALLOCATION" });
        const line = snapshot.lines.find((x) => x.personId === payload.personId);
        if (!line) return json(404, { error: "resident not found in this allocation" });
        if (workspace.current.state === "draft") return json(409, { error: "This version has not been published to residents yet.", code: "NOT_PUBLISHED" });
        if (!snapshot.balances) return json(409, { error: "An unbalanced split cannot be confirmed.", code: "ALLOCATION_DOES_NOT_BALANCE" });
        store.putConfirmation(identity, { personId: payload.personId, versionCanonical: snapshot.version, versionLabel: snapshot.versionLabel }, { event: "resident_confirmed", actor, personId: payload.personId, amountCents: line.amountCents, versionLabel: snapshot.versionLabel });
        await audit(property.organization_id, "allocation_confirmed", "person", payload.personId, { versionLabel: snapshot.versionLabel, amountCents: line.amountCents }, `${line.name} (simulated)`);
        return json(200, view(await resolve(payload.propertyId, orgs)));
      }
      if (event.httpMethod === "POST" && route === "approve") {
        const blocked = approveBlockedReason(snapshot, workspace);
        if (blocked) return json(409, { error: blocked, code: "APPROVAL_BLOCKED" });
        store.putVersion(identity, { ...workspace.current, state: "agreed", agreedAt: (/* @__PURE__ */ new Date()).toISOString() }, { event: "landlord_approved", actor, versionNumber: workspace.current.n, versionLabel: snapshot.versionLabel });
        store.putApproval(identity, { actor, at: (/* @__PURE__ */ new Date()).toISOString(), versionCanonical: snapshot.version, versionLabel: snapshot.versionLabel, totalCents: snapshot.totalCents }, { event: "approval_recorded", actor, versionLabel: snapshot.versionLabel });
        await audit(property.organization_id, "allocation_approved", "property", property.id, { versionLabel: snapshot.versionLabel, totalCents: snapshot.totalCents }, actor);
        return json(200, view(await resolve(payload.propertyId, orgs)));
      }
      if (event.httpMethod === "POST" && route === "reset") {
        const invoices = invoicesFor(identity.propertyId, identity.periodKey);
        if (invoices.some(blocksEditing)) {
          return json(409, {
            error: `This period already has ${invoices.length} invoice(s) at the payment provider. Resetting the allocation would leave them pointing at numbers nobody approved. Use a correction instead.`,
            code: "HAS_INVOICES"
          });
        }
        store.clear(identity, { event: "workspace_reset", actor });
        return json(200, view(await resolve(payload.propertyId, orgs)));
      }
      return json(404, { error: "Not found" });
    } catch (error) {
      console.error("allocation_api_error", error);
      return json(500, { error: error.message });
    }
  };
}

// src/allocation-store-core.js
var keyFor = ({ propertyId, periodKey: periodKey2 }) => `${propertyId}:${periodKey2}`;
function emptyEntry(identity) {
  return { ...identity, versions: [], confirmations: {}, approval: null, history: [], createdAt: (/* @__PURE__ */ new Date()).toISOString() };
}
function operations(data, persist) {
  return {
    get(identity) {
      return data.entries[keyFor(identity)] || null;
    },
    all() {
      return Object.values(data.entries);
    },
    /** Replace the version list head, or append a new version. */
    putVersion(identity, version, event) {
      const key = keyFor(identity);
      const entry = data.entries[key] || emptyEntry(identity);
      const versions = [...entry.versions];
      const last = versions[versions.length - 1];
      if (last && last.n === version.n) versions[versions.length - 1] = version;
      else {
        if (last) versions[versions.length - 1] = { ...last, state: last.state === "agreed" ? "agreed" : "superseded" };
        versions.push(version);
      }
      data.entries[key] = { ...entry, versions, history: [...entry.history, { at: (/* @__PURE__ */ new Date()).toISOString(), ...event }], updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
      persist();
      return data.entries[key];
    },
    /**
     * Record one resident's confirmation, bound to the exact version canonical form.
     * Storing the canonical string rather than the version number is what makes a
     * confirmation impossible to carry onto different numbers.
     */
    putConfirmation(identity, { personId, versionCanonical, versionLabel }, event) {
      const key = keyFor(identity);
      const entry = data.entries[key] || emptyEntry(identity);
      data.entries[key] = {
        ...entry,
        confirmations: { ...entry.confirmations, [personId]: { versionCanonical, versionLabel, at: (/* @__PURE__ */ new Date()).toISOString() } },
        history: [...entry.history, { at: (/* @__PURE__ */ new Date()).toISOString(), ...event }],
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      persist();
      return data.entries[key];
    },
    putApproval(identity, approval, event) {
      const key = keyFor(identity);
      const entry = data.entries[key] || emptyEntry(identity);
      data.entries[key] = { ...entry, approval, history: [...entry.history, { at: (/* @__PURE__ */ new Date()).toISOString(), ...event }], updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
      persist();
      return data.entries[key];
    },
    /** Drop everything for one property and period, so a walkthrough can restart. */
    clear(identity, event) {
      const key = keyFor(identity);
      const entry = data.entries[key];
      data.entries[key] = { ...emptyEntry(identity), history: [...entry?.history || [], { at: (/* @__PURE__ */ new Date()).toISOString(), ...event }] };
      persist();
      return data.entries[key];
    },
    __reset() {
      data.entries = {};
      persist();
    }
  };
}

// src/allocation-store-memory.js
function createMemoryAllocationStore() {
  const data = { version: 1, entries: {} };
  return { location: null, ...operations(data, () => {
  }) };
}

// scripts/offline-entry.mjs
var allocationHandler = createAllocationHandler({
  store: createMemoryAllocationStore(),
  invoicesFor: () => [],
  provider: { available: false, reason: "Offline mode: no payment provider is connected, so nothing can be collected from here.", mappedCount: 0 }
});
var startedAt = (/* @__PURE__ */ new Date()).toISOString();
var demoHeaders = { "x-hearth-dataset": "fictional-offline-demo", "content-type": "application/json; charset=utf-8" };
function response(status, body, headers = {}) {
  const all = Object.fromEntries(Object.entries({ ...demoHeaders, ...headers }).map(([key, value]) => [key.toLowerCase(), value]));
  return { ok: status >= 200 && status < 300, status, headers: { get: (name) => all[String(name).toLowerCase()] || null }, json: async () => body };
}
async function demoFetch(resource, options = {}) {
  const url = new URL(resource, globalThis.location?.origin || "https://hearth-demo.invalid");
  if (url.pathname === "/demo/meta") return response(200, { ...demoMeta, startedAt, storage: "page" });
  const route = url.pathname.startsWith("/api/allocation/") ? allocationHandler : handler;
  const result = await route({
    path: url.pathname,
    httpMethod: String(options.method || "GET").toUpperCase(),
    headers: options.headers || {},
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: options.body || null
  });
  let body = {};
  try {
    body = JSON.parse(result.body || "{}");
  } catch {
    body = {};
  }
  return response(result.statusCode, body, result.headers);
}
function getDemoMeta() {
  return { ...demoMeta, startedAt };
}
export {
  demoFetch,
  getDemoMeta
};
