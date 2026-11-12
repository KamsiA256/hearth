// Shared helpers for demo datasets: each call appends rows shaped exactly like the Supabase tables
// the operator API reads. A prospect fixture (scripts/demo/prospects/*.mjs) uses these so it only
// states data — properties, people, messages, requests — never table plumbing or app logic.
// outboundStatus: delivery status for seeded outbound texts. Prospect fixtures use "dry_run" so nothing
// in a discovery demo ever claims a text was delivered.
export function createDatasetBuilder({ orgId, orgName, now = new Date(), outboundStatus = "delivered" }) {
  const at = (minutes) => new Date(now.getTime() + minutes * 60000).toISOString();
  const hours = (h) => at(h * 60), days = (d) => at(d * 1440);
  // A past day at a local clock time (e.g. dayAt(-9, 14.5) = 9 days ago, 2:30pm), so seeded events don't
  // all share the current minute. Clamped to "now" so nothing lands in the future.
  const dayAt = (d, hour) => { const x = new Date(now.getTime() + d * 86400000); x.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0); return new Date(Math.min(x.getTime(), now.getTime())).toISOString(); };
  const t = { organizations: [{ id: orgId, name: orgName, created_at: days(-400) }], properties: [], lease_groups: [], rooms: [], people: [], phone_numbers: [], conversations: [], messages: [], escalations: [], evidence: [], releasing_status: [], workflow_tasks: [], call_logs: [], audit_events: [], request_templates: [], request_groups: [], info_requests: [] };
  const base = (property_id) => ({ organization_id: orgId, property_id });
  const auditRow = (action, entity_type, entity_id, metadata, created_at, actor = "seed") => t.audit_events.push({ id: t.audit_events.length + 1, organization_id: orgId, actor, action, entity_type, entity_id, metadata, created_at });
  return {
    t, at, hours, days, dayAt, base, audit: auditRow,
    property({ id, name, address, lease, rooms, number, leaseText }) {
      t.properties.push({ id, organization_id: orgId, display_name: name, address, lease_text: leaseText, lease_file_path: null, active_lease_group_id: lease.id, created_at: days(-400) });
      t.lease_groups.push({ ...base(id), ...lease, created_at: days(-400) });
      // facts is the 4th, optional tuple element: structured, checkable room facts
      // (see data/room-facts.mjs), never money. Every existing call site passes a
      // 3-element tuple and keeps working unchanged — facts defaults to null there.
      for (const [roomId, label, rent_share = null, facts = null] of rooms) t.rooms.push({ ...base(id), id: roomId, label, rent_share, facts });
      t.phone_numbers.push({ ...base(id), id: `num-${id}`, sms_number: number, active: true, created_at: days(-400) });
    },
    person(propertyId, leaseId, { id, name, phone, role = "student", room = null, guarantorOf = null, optedOutAt = null }) {
      t.people.push({ ...base(propertyId), id, name, phone, role, lease_group_id: leaseId, room_id: room, guarantor_of_person_id: guarantorOf, consent_status: optedOutAt ? "opted_out" : "consented", consent_timestamp: days(-80), opted_out_at: optedOutAt, created_at: days(-80) });
      t.conversations.push({ ...base(propertyId), id: `conv-${id}`, lease_group_id: leaseId, person_id: id, opened_at: days(-80), last_activity: days(-1) });
    },
    message(propertyId, leaseId, personId, { id, direction = "inbound", body, when, needsHuman = false, model = null, replyTo = null, status }) {
      t.messages.push({ ...base(propertyId), id, lease_group_id: leaseId, person_id: personId, conversation_id: `conv-${personId}`, direction, body, media_urls: [], provider_message_id: null, delivery_status: status || (direction === "inbound" ? "received" : outboundStatus), error_code: null, created_at: when, needs_human: needsHuman, human_answered_at: null, model_used: model, escalated_to_deep_model: false, model_usage: [], in_reply_to_message_id: replyTo });
    },
    escalation(propertyId, { id, messageId, tier, reason, when }) { t.escalations.push({ ...base(propertyId), id, message_id: messageId, tier, status: "open", reason, resolved_at: null, created_at: when }); },
    task(propertyId, personId, task_key, status, value_text = null) { t.workflow_tasks.push({ ...base(propertyId), id: `task-${personId}-${task_key}`, person_id: personId, task_key, status, value_text, completed_at: status === "complete" ? days(-80) : null, evidence_id: null, created_at: days(-80) }); },
    releasing(propertyId, personId, fields) { t.releasing_status.push({ ...base(propertyId), id: `rel-${personId}`, current_person_id: personId, renewal: "undecided", guarantor_confirmed: false, signature_status: "not_sent", next_room_id: null, rent_share_agreed: false, reminder_sent_at: null, reminder_acknowledged_at: null, updated_at: days(-3), ...fields }); },
    evidence(propertyId, row) { t.evidence.push({ ...base(propertyId), ...row }); },
    template(row) { t.request_templates.push({ organization_id: orgId, created_at: days(-60), ...row }); },
    group(propertyId, row) { t.request_groups.push({ ...base(propertyId), decision: null, decision_note: null, decided_at: null, created_at: days(-10), ...row }); },
    request(propertyId, row) { t.info_requests.push({ ...base(propertyId), answers: {}, follow_up_count: 0, last_follow_up_at: null, response_received_at: null, decision: null, decision_note: null, decided_at: null, group_id: null, room_id: null, created_at: row.sent_at || days(-10), ...row }); },
  };
}
