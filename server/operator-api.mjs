import { json } from "./_shared/http.mjs";
import { resolveOperator } from "./_shared/operator-auth.mjs";
import { db, must, audit } from "./_shared/db.mjs";
import { sendAndPersist } from "./_shared/messaging.mjs";

const pathOf = (event) => (event.path.split("/operator-api/")[1] || event.path.split("/api/operator/")[1] || "overview").replace(/\/$/, "");
class BadRequest extends Error {}
const bodyOf = (event) => { if (!event.body) return {}; try { return JSON.parse(event.body); } catch { throw new BadRequest("Request body must be JSON"); } };

// Every read and write is limited to the organizations the verified operator belongs to (resolveOperator).
// A record outside them is reported exactly like a record that doesn't exist.
class NotFound extends Error {}
const isNoRow = (error) => error && (error.code === "PGRST116" || /exactly one|0 rows|no rows/i.test(error.message || ""));
async function one(query, label) {
  const { data, error } = await query;
  if (isNoRow(error) || (!error && !data)) throw new NotFound(`${label} not found`);
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}
const inOrgs = (query, orgs) => query.in("organization_id", orgs);
const scopedProperty = (propertyId, orgs) => propertyId ? one(inOrgs(db().from("properties").select("id,organization_id").eq("id", propertyId), orgs).single(), "property") : Promise.reject(new NotFound("property not found"));

async function signedEvidence(rows) {
  return Promise.all(rows.map(async (row) => {
    const signed = await db().storage.from("inbound-media").createSignedUrl(row.media_path, 300);
    return { ...row, signed_url: signed.data?.signedUrl || null };
  }));
}

async function listProperties(orgs) {
  const [propertiesResult, peopleResult, releasingResult] = await Promise.all([
    inOrgs(db().from("properties").select("id,organization_id,address,display_name,active_lease_group_id,lease_groups!lease_groups_organization_id_property_id_fkey(id,academic_year,term_start,term_end,total_rent),rooms(id,label,rent_share,facts),phone_numbers(id,sms_number,active),escalations(id,status,tier)"), orgs).order("display_name"),
    inOrgs(db().from("people").select("id,organization_id,name,phone,role,property_id,lease_group_id,room_id,guarantor_of_person_id,consent_status,consent_timestamp,opted_out_at"), orgs),
    inOrgs(db().from("releasing_status").select("id,organization_id,property_id,current_person_id,renewal,guarantor_confirmed,signature_status,next_room_id,rent_share_agreed,reminder_sent_at,reminder_acknowledged_at,updated_at"), orgs),
  ]);
  const properties = must(propertiesResult, "properties");
  const people = must(peopleResult, "property people");
  const releasing = must(releasingResult, "property releasing status");
  return properties.map((property) => ({
    ...property,
    people: people.filter((person) => person.property_id === property.id),
    releasing_status: releasing.filter((status) => status.property_id === property.id),
  }));
}

async function propertyNameMap(orgs) {
  const properties = must(await inOrgs(db().from("properties").select("id,display_name"), orgs), "property names");
  return new Map(properties.map((property) => [property.id, { display_name: property.display_name }]));
}

// The words the operator clicked, so History reads in their language (not the stored value).
const DECISION_WORDS = { approve: "Approve", hold: "Hold", reject: "Not approve" };
const TURNOVER_TASK_KEYS = new Set(["requirements_complete", "arrival_window", "key_status", "move-in_condition_evidence", "move-out_condition_evidence"]);

async function turnover(propertyId) {
  const [propertyResult, studentsResult, tasksResult, evidenceResult] = await Promise.all([
    db().from("properties").select("id,organization_id,address,display_name,active_lease_group_id,lease_groups!lease_groups_organization_id_property_id_fkey(id,term_start,term_end),rooms(id,label)").eq("id", propertyId).single(),
    db().from("people").select("id,name,role,room_id,lease_group_id,consent_status,opted_out_at").eq("property_id", propertyId).eq("role", "student").order("name"),
    db().from("workflow_tasks").select("id,person_id,task_key,status,value_text,completed_at,evidence_id").eq("property_id", propertyId),
    db().from("evidence").select("id,person_id,room_id,kind,media_path,captured_at,notes").eq("property_id", propertyId).in("kind", ["move-in", "move-out"]).order("captured_at"),
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
        moveOut: evidence.filter((item) => item.person_id === student.id && item.kind === "move-out"),
      },
    })),
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
    model_calls: modelCalls.length,
  };
}

async function needsHuman(propertyId) {
  const [messagesResult, roomsResult] = await Promise.all([
    db().from("messages").select("id,property_id,person_id,conversation_id,body,created_at,model_used,escalated_to_deep_model,model_usage,people(name,role,room_id,consent_status,opted_out_at)").eq("property_id", propertyId).eq("direction", "inbound").eq("needs_human", true).is("human_answered_at", null).order("created_at", { ascending: false }),
    db().from("rooms").select("id,label").eq("property_id", propertyId),
  ]);
  const messages = must(messagesResult, "needs-human messages");
  const rooms = must(roomsResult, "needs-human rooms");
  let acknowledgements = [];
  if (messages.length) acknowledgements = must(await db().from("messages").select("id,in_reply_to_message_id,body,delivery_status,created_at").eq("property_id", propertyId).eq("direction", "outbound").in("in_reply_to_message_id", messages.map((message) => message.id)).order("created_at"), "needs-human acknowledgements");
  const acknowledgementByMessage = new Map(acknowledgements.map((message) => [message.in_reply_to_message_id, message]));
  return messages.map((message) => ({
    ...message,
    room: rooms.find((room) => room.id === message.people?.room_id) || null,
    acknowledgement: acknowledgementByMessage.get(message.id) || null,
  }));
}

async function overview(orgs) {
  const [properties, modelMessagesResult] = await Promise.all([
    listProperties(orgs),
    inOrgs(db().from("messages").select("property_id,needs_human,human_answered_at,model_used,escalated_to_deep_model,model_usage").eq("direction", "inbound"), orgs),
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
    db().from("call_logs").select("*").eq("property_id", propertyId).order("occurred_at"),
  ]);
  const property = must(propertyResult, "property export");
  property.people = must(peopleResult, "export people");
  property.messages = must(messagesResult, "export messages");
  property.evidence = await signedEvidence(must(evidenceResult, "export evidence"));
  property.releasing_status = must(releasingResult, "export releasing status");
  property.workflow_tasks = must(tasksResult, "export workflow tasks");
  property.call_logs = must(callsResult, "export call logs");
  const entityIds = [propertyId, ...(property.people || []).map(x=>x.id), ...(property.messages || []).map(x=>x.id), ...(property.escalations || []).map(x=>x.id), ...(property.evidence || []).map(x=>x.id), ...(property.call_logs || []).map(x=>x.id)];
  property.audit_events = must(await db().from("audit_events").select("*").eq("organization_id", property.organization_id).in("entity_id", entityIds).order("created_at"), "export audit events");
  return { exported_at: new Date().toISOString(), warning: "Signed evidence links expire in five minutes.", property };
}

export async function handler(event) {
  const operator = resolveOperator(event);
  if (!operator) return json(401, { error: "Operator token required" });
  const orgs = operator.organizationIds, actor = operator.name;
  const route = pathOf(event);
  try {
    if (event.httpMethod === "GET" && route === "overview") return json(200, await overview(orgs));
    if (event.httpMethod === "GET" && route === "properties") return json(200, await listProperties(orgs));
    // Property-scoped reads: the property must belong to the operator's organizations. Rows are then read by
    // property_id; composite (organization_id, property_id) foreign keys keep them in the same organization.
    const PROPERTY_ROUTES = ["turnover", "needs-human", "escalations", "evidence", "recipients", "timeline", "export", "requests", "request-groups"];
    if (event.httpMethod === "GET" && PROPERTY_ROUTES.includes(route)) await scopedProperty((event.queryStringParameters || {}).propertyId, orgs);
    if (event.httpMethod === "GET" && route === "turnover") {
      const p = event.queryStringParameters || {}; if (!p.propertyId) return json(400, { error: "propertyId required" });
      return json(200, await turnover(p.propertyId));
    }
    if (event.httpMethod === "GET" && route === "needs-human") {
      const p = event.queryStringParameters || {}; if (!p.propertyId) return json(400, { error: "propertyId required" });
      return json(200, await needsHuman(p.propertyId));
    }
    if (event.httpMethod === "GET" && route === "messages") {
      const p = event.queryStringParameters || {}; let query = inOrgs(db().from("messages").select("*,people(name,role,room_id),escalations(tier,status,reason)"), orgs).order("created_at", { ascending: false }).limit(500);
      if (p.propertyId) { await scopedProperty(p.propertyId, orgs); query = query.eq("property_id", p.propertyId); } if (p.personId) query = query.eq("person_id", p.personId); if (p.q) query = query.textSearch("body", p.q, { type: "websearch" });
      const [rows, names] = await Promise.all([query, propertyNameMap(orgs)]);
      return json(200, must(rows, "messages").map((message) => ({ ...message, properties: names.get(message.property_id) || null })));
    }
    if (event.httpMethod === "GET" && route === "escalations") {
      const p = event.queryStringParameters || {}; if (!p.propertyId) return json(400, { error: "propertyId required" });
      return json(200, must(await db().from("escalations").select("*,messages(body,created_at,person_id,people(name)),properties(display_name)").eq("property_id", p.propertyId).order("created_at", { ascending: false }), "escalations"));
    }
    if (event.httpMethod === "GET" && route === "evidence") {
      const p = event.queryStringParameters || {}; if (!p.propertyId) return json(400, { error: "propertyId required" });
      const rows = await db().from("evidence").select("*,people(name),rooms(label)").eq("property_id", p.propertyId).order("captured_at", { ascending: false });
      return json(200, await signedEvidence(must(rows, "evidence")));
    }
    if (event.httpMethod === "GET" && route === "recipients") {
      const p = event.queryStringParameters || {}; if (!p.propertyId) return json(400, { error: "propertyId required" });
      const [peopleResult, conversationsResult] = await Promise.all([
        db().from("people").select("id,name,role,consent_status,opted_out_at,lease_group_id").eq("property_id", p.propertyId).neq("consent_status", "opted_out").is("opted_out_at", null).order("name"),
        db().from("conversations").select("id,person_id").eq("property_id", p.propertyId),
      ]);
      const people = must(peopleResult, "message recipients");
      const conversations = must(conversationsResult, "recipient conversations");
      const conversationByPerson = new Map(conversations.map((conversation) => [conversation.person_id, conversation.id]));
      return json(200, people.map((person) => ({ ...person, conversation_id: conversationByPerson.get(person.id) || null })));
    }
    if (event.httpMethod === "GET" && route === "timeline") {
      const p = event.queryStringParameters || {}; if (!p.propertyId) return json(400, { error: "propertyId required" });
      // Optional personId narrows the property's record to one resident (the property is already scoped above).
      const byPerson = (query) => p.personId ? query.eq("person_id", p.personId) : query;
      const [messages, calls, evidence, allEvents] = await Promise.all([
        byPerson(db().from("messages").select("id,body,direction,delivery_status,error_code,created_at,people(name)").eq("property_id", p.propertyId)),
        byPerson(db().from("call_logs").select("id,summary,occurred_at,people(name)").eq("property_id", p.propertyId)),
        byPerson(db().from("evidence").select("id,kind,notes,captured_at,people(name)").eq("property_id", p.propertyId)),
        inOrgs(db().from("audit_events").select("id,action,actor,created_at,metadata"), orgs).eq("entity_type", "property").eq("entity_id", p.propertyId),
      ]);
      const events = p.personId && !allEvents.error ? { data: (allEvents.data || []).filter((x) => x.metadata?.personId === p.personId) } : allEvents;
      const timeline = [
        ...must(messages, "timeline messages").map(x => ({ type: "message", at: x.created_at, ...x })),
        ...must(calls, "timeline calls").map(x => ({ type: "call", at: x.occurred_at, ...x })),
        ...must(evidence, "timeline evidence").map(x => ({ type: "evidence", at: x.captured_at, ...x })),
        ...must(events, "timeline audit").map(x => ({ type: "audit", at: x.created_at, ...x })),
      ].sort((a,b) => new Date(b.at)-new Date(a.at)); return json(200, timeline);
    }
    if (event.httpMethod === "GET" && route === "requests") {
      const p = event.queryStringParameters || {}; if (!p.propertyId) return json(400, { error: "propertyId required" });
      return json(200, must(await db().from("info_requests").select("*,request_templates(*),rooms(label)").eq("property_id", p.propertyId).order("sent_at"), "information requests"));
    }
    if (event.httpMethod === "GET" && route === "request-groups") {
      const p = event.queryStringParameters || {}; if (!p.propertyId) return json(400, { error: "propertyId required" });
      return json(200, must(await db().from("request_groups").select("*,rooms(label)").eq("property_id", p.propertyId).order("created_at"), "request groups"));
    }
    if (event.httpMethod === "GET" && route === "export") { const p = event.queryStringParameters || {}; return p.propertyId ? json(200, await exportProperty(p.propertyId), { "content-disposition": `attachment; filename="hearth-property-${p.propertyId}.json"` }) : json(400, { error: "propertyId required" }); }

    const payload = bodyOf(event);
    // Writes that name a property must name one of the operator's own.
    if (event.httpMethod === "POST" && payload.propertyId) await scopedProperty(payload.propertyId, orgs);
    if (event.httpMethod === "POST" && route === "resolve-escalation") {
      let target = inOrgs(db().from("escalations").select("id,property_id"), orgs).eq("id", payload.id); if (payload.propertyId) target = target.eq("property_id", payload.propertyId);
      await one(target.single(), "escalation");
      const row = await one(inOrgs(db().from("escalations").update({ status: "resolved", resolved_at: new Date().toISOString() }), orgs).eq("id", payload.id).eq("status", "open").select().single(), "open escalation"); await audit(row.organization_id, "escalation_resolved", "escalation", row.id, {}, actor);
      await audit(row.organization_id, "escalation_resolved", "property", row.property_id, { escalationId: row.id, summary: `Marked handled: ${row.reason}` }, actor); return json(200, row);
    }
    if (event.httpMethod === "POST" && route === "releasing") {
      const allowed = ["renewal","guarantor_confirmed","signature_status","next_room_id","rent_share_agreed","reminder_sent_at","reminder_acknowledged_at"]; const update = Object.fromEntries(Object.entries(payload.changes || {}).filter(([key]) => allowed.includes(key))); update.updated_at = new Date().toISOString();
      let target = inOrgs(db().from("releasing_status").select("id,property_id"), orgs).eq("id", payload.id); if (payload.propertyId) target = target.eq("property_id", payload.propertyId);
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
      const valueText = payload.status === "complete" ? String(payload.valueText || "").trim().slice(0, 120) || null : (taskKey === "key_status" ? "not issued" : null);
      const task = must(await db().from("workflow_tasks").upsert({ organization_id: person.organization_id, property_id: person.property_id, person_id: person.id, task_key: taskKey, status: payload.status, value_text: valueText, completed_at: payload.status === "complete" ? new Date().toISOString() : null }, { onConflict: "person_id,task_key" }).select().single(), "update turnover task");
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
      }
      else {
        if (!payload.propertyId) return json(400, { error: "propertyId required" });
        const person = await one(inOrgs(db().from("people").select("*"), orgs).eq("id", payload.personId).eq("property_id", payload.propertyId).single(), "manual recipient");
        conversation = must(await db().from("conversations").upsert({ organization_id: person.organization_id, property_id: person.property_id, lease_group_id: person.lease_group_id, person_id: person.id, last_activity: new Date().toISOString() }, { onConflict: "property_id,lease_group_id,person_id" }).select("*,people(*)").single(), "create manual conversation");
      }
      const numbers = must(await db().from("phone_numbers").select("sms_number,active").eq("property_id", conversation.property_id).eq("active", true), "manual reply property number");
      const from = numbers[0]?.sms_number; if (!from) return json(409, { error: "No active property number" });
      const sent = await sendAndPersist({ organizationId: conversation.organization_id, propertyId: conversation.property_id, leaseGroupId: conversation.lease_group_id, person: conversation.people, conversationId: conversation.id, from, body: String(payload.body || "").trim().slice(0, 1500), inReplyToMessageId: sourceMessage?.id || null });
      if (sourceMessage) {
        const answeredAt = new Date().toISOString();
        must(await db().from("messages").update({ human_answered_at: answeredAt }).eq("id", sourceMessage.id).eq("property_id", sourceMessage.property_id).select().single(), "mark needs-human answered");
        await audit(conversation.organization_id, "needs_human_answered", "message", sourceMessage.id, { replyMessageId: sent.id }, actor);
      }
      await audit(conversation.organization_id, "manual_reply_sent", "message", sent.id, { reason: String(payload.reason || "").slice(0, 300) }, actor); return json(201, sent);
    }
    if (event.httpMethod === "POST" && route === "request-decision" && payload.groupId) {
      if (!payload.propertyId) return json(400, { error: "propertyId required" });
      const group = await one(inOrgs(db().from("request_groups").select("*"), orgs).eq("id", payload.groupId).eq("property_id", payload.propertyId).single(), "request group");
      const decision = payload.decision ?? null, note = String(payload.note || "").trim().slice(0, 300);
      if (decision !== null && !["approve", "hold", "reject"].includes(decision)) return json(400, { error: "Invalid decision" });
      if (decision === null && !group.decision) return json(409, { error: "Nothing to undo" });
      if (decision !== null && group.decision) return json(409, { error: "Already decided · undo first" });
      if (decision !== null && !note) return json(400, { error: "Say why · it is kept in the record" });
      const now = new Date().toISOString();
      const row = must(await db().from("request_groups").update(decision === null ? { decision: null, decision_note: null, decided_at: null } : { decision, decision_note: note, decided_at: now }).eq("id", group.id).eq("property_id", group.property_id).select("*,rooms(label)").single(), "update request group");
      const summary = decision === null ? `${group.label}: you undid “${DECISION_WORDS[group.decision]}” (${group.decision_note})` : `${group.label}: you chose “${DECISION_WORDS[decision]}” · ${note}`;
      await audit(group.organization_id, decision === null ? "request_group_decision_undone" : "request_group_decided", "property", group.property_id, { groupId: group.id, summary }, actor);
      return json(200, row);
    }
    if (event.httpMethod === "POST" && ["request-answer", "request-follow-up", "request-decision"].includes(route)) {
      if (!payload.propertyId || !payload.requestId) return json(400, { error: "propertyId and requestId required" });
      const request = await one(inOrgs(db().from("info_requests").select("*,request_templates(*)"), orgs).eq("id", payload.requestId).eq("property_id", payload.propertyId).single(), "information request");
      const now = new Date().toISOString(), who = request.subject_name, form = request.request_templates?.title || "request";
      let changes, action, summary;
      if (route === "request-answer") {
        const field = (request.request_templates?.fields || []).find((item) => item.key === payload.fieldKey);
        const value = String(payload.value || "").trim().slice(0, 500), source = String(payload.source || "").trim().slice(0, 120);
        if (!field) return json(400, { error: "Unknown field for this form" });
        if (!value || !source) return json(400, { error: "Answer and where it came from are both required" });
        if (request.decision) return json(409, { error: "Undo the decision before changing answers" });
        changes = { answers: { ...(request.answers || {}), [field.key]: { value, source, recorded_at: now } }, response_received_at: request.response_received_at || now };
        action = "request_answer_recorded"; summary = `${form} for ${who}: ${field.short || field.label} — “${value}” · from ${source}`;
      } else if (route === "request-follow-up") {
        if (request.decision) return json(409, { error: "Already decided" });
        changes = { last_follow_up_at: now, follow_up_count: (request.follow_up_count || 0) + 1 };
        action = "request_follow_up_sent"; summary = `${form} for ${who}: you marked a follow-up to ${request.requested_from_name} as sent by ${request.channel || "a channel outside Hearth"}`;
      } else {
        const decision = payload.decision ?? null, note = String(payload.note || "").trim().slice(0, 300);
        if (decision !== null && !["approve", "hold", "reject"].includes(decision)) return json(400, { error: "Invalid decision" });
        if (decision === null && !request.decision) return json(409, { error: "Nothing to undo" });
        if (decision !== null && request.decision) return json(409, { error: "Already decided · undo first" });
        if (decision !== null && !note) return json(400, { error: "Say why · it is kept in the record" });
        changes = decision === null ? { decision: null, decision_note: null, decided_at: null } : { decision, decision_note: note, decided_at: now };
        action = decision === null ? "request_decision_undone" : "request_decided";
        summary = decision === null ? `${form} for ${who}: you undid “${DECISION_WORDS[request.decision]}” (${request.decision_note})` : `${form} for ${who}: you chose “${DECISION_WORDS[decision]}” · ${note}`;
      }
      const row = must(await db().from("info_requests").update(changes).eq("id", request.id).eq("property_id", request.property_id).select("*,request_templates(*),rooms(label)").single(), "update information request");
      await audit(request.organization_id, action, "property", request.property_id, { requestId: request.id, summary }, actor);
      return json(200, row);
    }
    if (event.httpMethod === "POST" && route === "call-log") {
      let personQuery = inOrgs(db().from("people").select("organization_id,property_id"), orgs).eq("id", payload.personId); if (payload.propertyId) personQuery = personQuery.eq("property_id", payload.propertyId);
      const person = await one(personQuery.single(), "call person"); const row = must(await db().from("call_logs").insert({ organization_id: person.organization_id, property_id: person.property_id, person_id: payload.personId, occurred_at: payload.occurredAt || new Date().toISOString(), summary: String(payload.summary || "").trim() }).select().single(), "call log"); return json(201, row);
    }
    return json(404, { error: "Not found" });
  } catch (error) {
    if (error instanceof NotFound) return json(404, { error: error.message });
    if (error instanceof BadRequest) return json(400, { error: error.message });
    console.error("operator_api_error", error); return json(500, { error: error.message });
  }
}
