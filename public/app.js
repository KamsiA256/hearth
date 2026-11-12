// Hearth operator app. One property at a time: Today (what needs you), Messages, Residents,
// Leasing, Turnover and Property. Every number comes from model.js over the operator API;
// anything Hearth does not store is shown as absent, never as a zero.
import { REQUEST_DECISIONS, isVerifiedAbsence, activeLease, groupState, attentionItems, consentLabel, conversations, defaultTurnoverPhase, deliveryLabel, guarantorsOf, nextMilestone, openRequestCount, propertyFacts, parseShareCents, renewalState, requestState, renewalSummary, rentFacts, resolveRoute, residentsOf, roomOf, turnoverState, turnoverSummary, urgencyLabel } from "./model.js";

const OFFLINE_MODE = document.documentElement.dataset.hearthMode === "offline";
const demoRuntime = OFFLINE_MODE ? import("./offline-runtime.js") : null;
const PROPERTY_KEY = "hearth_property";
const remembered = () => { if (OFFLINE_MODE) return ""; try { return localStorage.getItem(PROPERTY_KEY) || ""; } catch { return ""; } };
const remember = (id) => { if (OFFLINE_MODE) return; try { localStorage.setItem(PROPERTY_KEY, id); } catch {} };
// The built-in demo code. The page sends it by itself, so nobody is asked for one.
// A deploy that sets its own HEARTH_ACCESS_CODE answers it with a 401, and the code
// dialog opens instead.
const DEMO_CODE = "demo";
const state = { token: sessionStorage.getItem("hearth_token") || DEMO_CODE, properties: [], propertyId: remembered(), summaries: {}, openRequests: {}, demoMeta: null, turnoverPhase: null, messageView: "all", propertyTab: "overview", openThread: null, rentReminders: new Set() };
const app = document.querySelector("#app"), title = document.querySelector("#title"), propertySelect = document.querySelector("#propertySelect"), propertyName = document.querySelector("#propertyName"), propertyMeta = document.querySelector("#propertyMeta"), milestoneLine = document.querySelector("#milestone"), dialog = document.querySelector("#access"), sheet = document.querySelector("#sheet");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const date = (s) => s ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(s)) : "—";
const dateOnly = (s) => s ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(`${s}T12:00:00`)) : "—";
const monthYear = (s) => s ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${s}T12:00:00`)) : "—";
const money = (n) => n == null ? "—" : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
const moneyExact = (n) => n == null ? "—" : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);
const ago = (s) => { if (!s) return "time unknown"; const m = Math.max(1, Math.floor((Date.now() - new Date(s)) / 60000)); if (m < 60) return `${m} min`; const h = Math.floor(m / 60); if (h < 24) return `${h} h`; const d = Math.floor(h / 24); return `${d} ${d === 1 ? "day" : "days"}`; };
const waitingFor = (s) => s ? `Waiting ${ago(s)}` : "Waiting time unknown";
const first = (name) => String(name || "").split(" ")[0];
const toast = (s) => { const el = document.querySelector("#toast"); el.textContent = s; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 2800); };
// A total marked illustrative (a meeting demonstration) is an example amount, not
// anyone's rent, so it is never labelled "Monthly rent".
const totalLabel = (illustrative) => illustrative ? "Household total (illustrative)" : "Monthly rent";
const status = (kind, label) => `<span class="status status-${kind}">${esc(label)}</span>`;
const calm = (heading, detail = "") => `<div class="calm"><strong>${esc(heading)}</strong>${detail ? `<span>${esc(detail)}</span>` : ""}</div>`;
const emptyState = (heading, detail, href, label) => `<div class="empty-state"><strong>${esc(heading)}</strong><span>${esc(detail)}</span>${href ? `<a class="button secondary" href="${href}">${esc(label)}</a>` : ""}</div>`;
const errorLine = (id) => `<p class="error-banner" id="${id}" role="alert"></p>`;
const showError = (id, error) => { const el = document.querySelector(`#${id}`); if (el) el.textContent = error.message || "Something went wrong"; toast(error.message || "Something went wrong"); };

// A 401 is the only response that means "wrong token"; every other failure is reported as what it is,
// so a server or database outage never looks like a login problem.
class AccessError extends Error{}
function showAccess(message){const note=document.querySelector("#accessError");note.textContent=message;note.hidden=false;if(!dialog.open)dialog.showModal()}
async function api(path,options={},base="/api/operator/"){const requestOptions={...options,headers:{authorization:`Bearer ${state.token}`,"content-type":"application/json",...(options.headers||{})}};const res=OFFLINE_MODE?await(await demoRuntime).demoFetch(`${base}${path}`,requestOptions):await fetch(`${base}${path}`,requestOptions);if(res.headers.get("x-hearth-dataset")?.startsWith("fictional-"))showDemoNotice();const data=await res.json().catch(()=>({}));if(res.status===401){sessionStorage.removeItem("hearth_token");state.token="";const message=OFFLINE_MODE?"That demonstration code was not accepted. Check it and try again.":"That access token was not accepted. Check it and try again.";showAccess(message);throw new AccessError(OFFLINE_MODE?"Demonstration code not accepted":"Access token not accepted")}if(!res.ok){const failure=new Error(OFFLINE_MODE?(data.error?`Hearth demo error ${res.status}: ${String(data.error).replace(/\.+$/,"")}.`:`Hearth demo is unavailable (HTTP ${res.status}).`):(data.error?`Hearth server error ${res.status}: ${String(data.error).replace(/\.+$/,"")}. The access token was accepted; this is not a login problem.`:`Hearth is unavailable (HTTP ${res.status}). The access token was not checked.`));failure.status=res.status;failure.code=data.code||null;throw failure}return data}
// Only a verified absence may render as "nothing here". A 5xx, a network failure or a
// timeout is a failure and must stay visible: showing it as an empty queue or "no rent
// period" would tell the landlord nothing needs attention when Hearth simply could not look.
function absentOnly(error,empty){if(error instanceof AccessError)throw error;if(isVerifiedAbsence(error))return empty;throw error}
// Local demo only: the dataset's own label and disclaimer (from its fixture) replace the generic pill.
let demoMetaRequest=null;
function showDemoNotice(){document.querySelector("#datasetBanner").hidden=false;demoMetaRequest||=(OFFLINE_MODE?demoRuntime.then(runtime=>runtime.getDemoMeta()):fetch("/demo/meta").then(r=>r.ok?r.json():null)).catch(()=>null).then(meta=>{if(!meta)return;const firstLoad=!state.demoMeta;state.demoMeta=meta;let fresh=false;try{if(meta.startedAt&&localStorage.getItem("hearth_demo_run")!==meta.startedAt){localStorage.setItem("hearth_demo_run",meta.startedAt);localStorage.removeItem(PROPERTY_KEY);fresh=Boolean(state.propertyId)}}catch{}if(fresh){const first=state.properties[0]?.id||"";if(state.propertyId!==first){state.propertyId=first;if(first){updateChrome();render()}}}const pill=document.querySelector("#datasetBanner"),notice=document.querySelector("#datasetNotice");pill.textContent="Demo data";pill.title=meta.disclaimer;pill.setAttribute("aria-label",meta.disclaimer);notice.textContent=`${meta.disclaimer} ${meta.storageNote||(OFFLINE_MODE?"Changes reset when this page reloads.":"Changes are kept on this computer until you start the walkthrough over.")}`;notice.hidden=false;if(firstLoad&&!fresh&&(location.hash.slice(1)||"today")==="today")render()})}
// The property list itself failed to load. Retrying must reload it: re-rendering
// with an empty list would report "No properties yet", a failure shown as absence.
const loadFailed=(error)=>{if(error instanceof AccessError)return;app.innerHTML=`<div class="load-failed" role="alert"><p><strong>Unable to load Hearth.</strong> ${esc(error.message||"Unknown error")}</p><button type="button" class="secondary small" data-retry-load>Try again</button></div>`;app.dataset.page="";app.querySelector("[data-retry-load]").onclick=()=>loadProperties().then(render).catch(loadFailed);toast(error.message||"Unable to load Hearth")};

async function loadProperties() {
  state.properties = await api("properties");
  // The sidebar counts read the overview, so load it with the list: opening Rent or a
  // deep link first must not show a Messages tab with no count.
  state.summaries = Object.fromEntries((await api("overview").catch((error) => absentOnly(error, []))).map((item) => [item.id, item]));
  state.propertiesLoaded = true;
  if (!state.properties.some((p) => p.id === state.propertyId)) state.propertyId = state.properties[0]?.id || "";
  updateChrome();
}
const current = () => state.properties.find((p) => p.id === state.propertyId);
const openCount = (id) => { const s = state.summaries[id]; return s ? (s.needs_human || 0) + (s.open_escalations || 0) + (state.openRequests[id] || 0) : null; };
// Information requests (e.g. prior-landlord verification), from the info_requests table.
const loadRequests = (id) => Promise.all([api(`requests?propertyId=${id}`), api(`request-groups?propertyId=${id}`)]).then(([requests, groups]) => ({ requests, groups })).catch((error) => absentOnly(error, { requests: [], groups: [] }));

function updateChrome() {
  const property = current();
  if (!property) { propertyName.textContent = "No properties yet"; propertyMeta.textContent = "A property appears here once it is set up."; propertySelect.innerHTML = "<option>No properties</option>"; propertySelect.disabled = true; milestoneLine.textContent = ""; return; }
  const facts = propertyFacts(property, monthYear);
  propertyName.textContent = property.display_name;
  document.querySelector("#propertyMark").textContent = propertyMark(property.display_name);
  propertyMeta.textContent = [`${facts.residents} ${facts.residents === 1 ? "resident" : "residents"}`, facts.term].filter(Boolean).join(" · ");
  milestoneLine.textContent = pageSubtitle(property);
  propertySelect.innerHTML = state.properties.map((item) => { const n = openCount(item.id); return `<option value="${esc(item.id)}"${item.id===state.propertyId?" selected":""}>${esc(item.display_name)}${n ? ` — ${n} need${n === 1 ? "s" : ""} you` : ""}</option>`; }).join("");
  propertySelect.disabled = state.properties.length < 2;
  document.querySelector("#propertyPicker").classList.toggle("single", state.properties.length < 2);
  const s = state.summaries[property.id], n = s ? (s.needs_human || 0) + (s.open_escalations || 0) : 0, badge = document.querySelector('[data-count="messages"]');
  badge.hidden = !n; badge.textContent = n || ""; badge.setAttribute("aria-label", n ? `${n} need you` : "");
  propertySelect.onchange=()=>{state.propertyId=propertySelect.value;updateChrome();render();remember(state.propertyId);flashPropertyBar();toast(`Showing ${current()?.display_name||"property"}`)};
}
// Under the page title: today's date on Today, the property everywhere else.
function pageSubtitle(property) {
  const key = location.hash.slice(1) || "today";
  return key === "today" || key === "home" ? new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date()) : property?.display_name || "";
}
function selectProperty(id) { state.propertyId = id; remember(id); updateChrome(); flashPropertyBar(); }
// A neutral tile beside the name so the active property is recognizable at a glance: the unit ("1B") when
// the name ends with one, otherwise the name's initials. (A landlord-supplied photo could replace it later.)
function propertyMark(name) { const tail = String(name || "").split("·").pop().trim().split(/\s+/).pop() || ""; return /\d/.test(tail) && tail.length <= 4 ? tail.toUpperCase() : String(name || "").split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase(); }
function flashPropertyBar() { const bar = document.querySelector(".property-bar"); bar.classList.remove("just-switched"); void bar.offsetWidth; bar.classList.add("just-switched"); }

// ---------- shared pieces ----------
function openSheet(heading, html) { document.querySelector("#sheetTitle").textContent = heading; document.querySelector("#sheetBody").innerHTML = html; if (!sheet.open) sheet.showModal(); return document.querySelector("#sheetBody"); }
document.querySelector("#sheetClose").onclick = () => sheet.close();
sheet.addEventListener("close", () => { state.openThread = null; });


const REQUEST_LABEL = { NO_REPLY: "Nothing back yet", INCOMPLETE: "Waiting on applicants", READY: "Ready for your decision", DECIDED: "On hold · still waiting" };
const KIND_LABEL = { urgent: (item) => urgencyLabel(item.tier), decision: () => "Your answer", failed: () => "Not delivered", request: (item) => REQUEST_LABEL[item.stage] || "Request", rent: (item) => item.tone === "blocked" ? "Rent · blocked" : item.tone === "overdue" ? "Rent · needs checking" : "Rent" };
const KIND_STATUS = { urgent: (item) => item.tier >= 3 ? "urgent" : "overdue", decision: () => "needs-decision", failed: () => "blocked", request: (item) => item.stage === "READY" ? "needs-decision" : "overdue", rent: (item) => item.tone };
const ACTION_LABEL = { resolve: "Mark handled", answer: "Answer", open: "Open conversation", review: "Review", rent: "Open rent" };
function attentionList(items) {
  return `<ol class="attention" aria-label="Needs you">${items.map((item) => `<li class="attention-item kind-${item.kind}"><div class="attention-main">${status(KIND_STATUS[item.kind](item), KIND_LABEL[item.kind](item))}<p class="attention-what">${item.kind === "request" || item.kind === "rent" ? esc(item.what) : `“${esc(item.what)}”`}</p><p class="attention-who"><strong>${esc(item.who)}</strong>${item.room ? ` · ${esc(item.room)}` : ""}${item.kind === "rent" && !item.since ? "" : ` · <span>${esc(waitingFor(item.since))}</span>`}</p><p class="attention-why">${esc(item.why)}</p></div><button data-attention="${esc(item.id)}" data-action="${item.action}">${ACTION_LABEL[item.action]}</button></li>`).join("")}</ol>`;
}
function wireAttention(items, sources, rerender) {
  app.querySelectorAll("[data-attention]").forEach((button) => button.onclick = async () => {
    const item = items.find((x) => x.id === button.dataset.attention);
    if (item.action === "resolve") {
      // Two steps: "Mark handled" removes the item from the queue (it stays in History), so the first
      // click asks for confirmation and the button reverts after a few seconds if not confirmed.
      if (!button.dataset.confirming) { button.dataset.confirming = "1"; const label = button.textContent; button.textContent = "Confirm — moves it to History"; setTimeout(() => { if (button.isConnected && button.dataset.confirming) { delete button.dataset.confirming; button.textContent = label; } }, 5000); return; }
      button.disabled = true;
      try { await api("resolve-escalation", { method: "POST", body: JSON.stringify({ id: item.id }) }); toast("Marked handled · kept in the record"); await rerender(); app.focus({ preventScroll: true }); } catch (error) { button.disabled = false; showError("pageError", error); }
    } else if (item.action === "rent") openRentActivity(current()).catch((error) => showError("pageError", error));
    else if (item.action === "answer") answerDecision(sources.decisions.find((x) => x.id === item.id), rerender);
    else if (item.action === "review") { const data = sources.requestData; if (item.group) openGroup(data.groups.find((g) => g.id === item.id), data, rerender); else openRequest(data.requests.find((x) => x.id === item.id), rerender); }
    else { state.openThread = sources.messages.find((m) => m.id === item.id)?.person_id || null; state.messageView = "all"; location.hash = "#messages"; if (location.hash === "#messages") render(); }
  });
}
function composer({ person, buttonLabel = "Approve and send", placeholder = "Type the exact text", disabledReason = "" }) {
  const consent = consentLabel(person);
  const blocked = consent.kind === "blocked";
  return `<div class="composer">${errorLine("composeError")}<label for="composeBody">Text to ${esc(person?.name || "resident")}</label><textarea id="composeBody" placeholder="${esc(placeholder)}" ${blocked ? "disabled" : ""}></textarea><div class="composer-foot"><span class="muted">${blocked ? "They opted out, so Hearth won’t text them. Call instead." : disabledReason || "Nothing is sent until you approve. Hearth adds “Hearth:” before it and “Reply STOP to opt out.” after it; the text as sent is kept in the record."}</span><button id="composeSend" ${blocked ? "disabled" : ""}>${esc(buttonLabel)}</button></div></div>`;
}
async function sendText(payload, onDone) {
  const body = document.querySelector("#composeBody").value.trim();
  if (!body) return showError("composeError", new Error("Type the exact text before approving."));
  const button = document.querySelector("#composeSend"); button.disabled = true;
  try { const sent = await api("manual-reply", { method: "POST", body: JSON.stringify({ ...payload, propertyId: state.propertyId, body }) }); toast(`Recorded · ${deliveryLabel(sent)?.label || "Queued"}`); await onDone(sent); }
  catch (error) { button.disabled = false; showError("composeError", error); }
}
function answerDecision(row, rerender) {
  openSheet(`Answer ${first(row.people?.name) || "resident"}`, `<p class="sheet-meta">${esc(row.people?.name || "Unknown")} · ${esc(row.room?.label || "No room")} · ${esc(waitingFor(row.created_at))}</p><blockquote>${esc(row.body)}</blockquote>${row.acknowledgement ? `<p class="muted">Hearth replied: “${esc(row.acknowledgement.body)}”</p>` : ""}${composer({ person: row.people, buttonLabel: "Approve, send & mark answered", placeholder: "Your answer, exactly as it should be texted" })}`);
  document.querySelector("#composeSend").onclick = () => sendText({ sourceMessageId: row.id, personId: row.person_id, conversationId: row.conversation_id, reason: `Landlord decision requested: ${row.body}` }, async () => { sheet.close(); await loadProperties(); await rerender(); app.focus({ preventScroll: true }); });
}

// ---------- Information requests (e.g. prior-landlord verification) ----------
const REQUEST_SOURCES = ["Phone call", "Email", "Returned form", "In person"];
// Drafts a follow-up listing exactly what's missing; a field's chase_hint (from the template) says what the
// recipient can do about it. The operator edits and sends it from their own email.
function requestFollowUpText(row, st) {
  const fields = row.request_templates?.fields || [], own = row.requested_from_role === row.subject_role;
  const missing = fields.filter((f) => f.required && st.missing.includes(f.short || f.label));
  const lines = (missing.length ? missing : fields.filter((f) => f.required)).map((f) => `- ${f.short || f.label}${f.chase_hint ? `: ${f.chase_hint}` : ""}`);
  const about = `${own ? "your" : `the ${(row.request_templates?.title || "request").toLowerCase()} for ${row.subject_name}`}${own ? ` ${(row.request_templates?.title || "request").toLowerCase()}` : ""}`;
  return `Hi ${row.requested_from_name}, a quick follow-up on ${about}. We still need:\n${lines.join("\n")}\nThank you!`;
}
function openRequest(row, rerender, back = null) {
  if (!row) return;
  const st = requestState(row), t = row.request_templates || {}, answers = row.answers || {};
  const fieldRows = (t.fields || []).map((f) => { const a = answers[f.key], blank = !String(a?.value ?? "").trim(); return `<li class="${blank && f.required ? "missing" : ""}"><span><strong>${esc(f.short || f.label)}</strong>${f.required ? "" : ` <small class="muted">${f.due ? `due ${esc(f.due)}` : "optional"}</small>`}${f.short ? `<small class="muted">${esc(f.label)}</small>` : ""}<small>${blank ? (f.required ? "Missing" : "Not in yet") : `${esc(a.value)}`}</small></span><span class="muted">${blank ? "" : `${esc(a.source)} · ${esc(date(a.recorded_at))}`}</span>${blank && !row.decision ? `<button class="secondary small" data-record="${esc(f.key)}">Record</button>` : "<span></span>"}</li>`; }).join("");
  const decided = row.decision ? `<div class="decided">${status(row.decision === "approve" ? "complete" : row.decision === "hold" ? "pending" : "blocked", REQUEST_DECISIONS[row.decision])}<p>${esc(row.decision_note || "")}</p><p class="muted">${esc(date(row.decided_at))} · kept in the property record</p><button class="secondary" id="undoDecision">Undo decision</button></div>` : "";
  const body = openSheet(`${row.subject_name} · ${t.title || "Request"}`, `${errorLine("requestError")}<p class="sheet-meta">${esc(row.rooms?.label ? `${row.rooms.label} · ` : "")}Requested ${esc(date(row.sent_at))} from ${esc(row.requested_from_role === row.subject_role ? row.subject_name : `${row.requested_from_name} (${row.requested_from_role || "contact"})`)} by ${esc(row.channel || "—")}${row.follow_up_count ? ` · ${row.follow_up_count} follow-up${row.follow_up_count === 1 ? "" : "s"} since` : ""}</p>
<div class="why-box"><p class="eyebrow">Why this is in front of you</p><p><strong>${esc(st.label)}</strong>${st.why ? ` · ${esc(st.why)}` : ""}</p><p class="muted">Items come from ${t.source_url ? `<a href="${esc(t.source_url)}" target="_blank" rel="noreferrer">${esc(t.source_title || t.title)}</a>` : esc(t.source_title || t.title || "your form")}${t.source_note ? ` · ${esc(t.source_note)}` : ""}. Follow-up rule: ${st.followUpDays} days${t.follow_up_rule_note ? ` (${esc(t.follow_up_rule_note)})` : ""}.</p></div>
<h3>Items <span class="count muted">${st.answered} of ${st.total} in</span></h3><ul class="plain-rows request-fields">${fieldRows}</ul><div id="recordSlot"></div>
${decided || `${st.stage === "NO_REPLY" || st.stage === "INCOMPLETE" ? `<h3>Follow up</h3><div class="composer"><label for="followUpText">Draft for ${esc(row.requested_from_name)} · you send it from your own ${esc(row.channel || "email")}</label><textarea id="followUpText">${esc(requestFollowUpText(row, st))}</textarea><div class="composer-foot"><span class="muted">Hearth doesn’t send email. Mark it sent so the record shows when you asked.</span><span><button class="secondary" id="copyFollowUp">Copy text</button> <button id="markFollowUp">Mark follow-up sent</button></span></div></div>` : ""}
${row.group_id ? `<p class="muted">This file is part of a group. You decide on the group as a whole.</p>` : decisionForm(st.missing.length)}`}`);
  const refresh = async (updated, message) => { toast(message); await rerender(); openRequest(updated, rerender, back); };
  if (back) body.insertAdjacentHTML("afterbegin", `<p><button class="quiet small" id="backToGroup">← ${esc(back.label)}</button></p>`), body.querySelector("#backToGroup").onclick = () => back.open();
  const post = (route, extra) => api(route, { method: "POST", body: JSON.stringify({ propertyId: state.propertyId, requestId: row.id, ...extra }) });
  body.querySelectorAll("[data-record]").forEach((b) => b.onclick = () => { const f = t.fields.find((x) => x.key === b.dataset.record); body.querySelector("#recordSlot").innerHTML = `<div class="composer">${errorLine("answerError")}<label for="answerValue">${esc(f.label)}</label><input id="answerValue"><label for="answerSource">Where did this answer come from?</label><select id="answerSource"><option value="">Choose where it came from…</option>${(t.answer_sources?.length ? t.answer_sources : REQUEST_SOURCES).map((x) => `<option>${esc(x)}</option>`).join("")}</select><div class="composer-foot"><span class="muted">Saved with its source and time.</span><button id="saveAnswer">Save answer</button></div></div>`; body.querySelector("#answerValue").focus(); body.querySelector("#saveAnswer").onclick = async () => { const value = body.querySelector("#answerValue").value.trim(); if (!value) return showError("answerError", new Error("Type what came in first.")); if (!body.querySelector("#answerSource").value) return showError("answerError", new Error("Choose where it came from · it is kept in the record.")); try { await refresh(await post("request-answer", { fieldKey: f.key, value, source: body.querySelector("#answerSource").value }), "Answer saved to the record"); } catch (error) { showError("answerError", error); } }; });
  const copy = body.querySelector("#copyFollowUp"); if (copy) copy.onclick = async () => { try { await navigator.clipboard.writeText(body.querySelector("#followUpText").value); toast("Copied · paste it into your email"); } catch { toast("Copy failed · select the text instead"); } };
  const mark = body.querySelector("#markFollowUp"); if (mark) mark.onclick = async () => { mark.disabled = true; try { await refresh(await post("request-follow-up", {}), "Follow-up recorded"); } catch (error) { mark.disabled = false; showError("requestError", error); } };
  body.querySelectorAll("[data-decide]").forEach((b) => b.onclick = async () => { const note = body.querySelector("#decisionNote").value.trim(); if (!note) { body.querySelector("#decisionNote").focus(); return showError("decisionError", new Error("Say why first · it is kept in the record.")); } b.disabled = true; try { await refresh(await post("request-decision", { decision: b.dataset.decide, note }), `${REQUEST_DECISIONS[b.dataset.decide]} · recorded (you can undo)`); } catch (error) { b.disabled = false; showError("requestError", error); } });
  const undo = body.querySelector("#undoDecision"); if (undo) undo.onclick = async () => { undo.disabled = true; try { await refresh(await post("request-decision", { decision: null }), "Decision undone · both steps stay in the record"); } catch (error) { undo.disabled = false; showError("requestError", error); } };
}

function decisionForm(missingCount) {
  return `<h3>Your decision</h3><p class="muted">Hearth doesn’t score or approve applicants. This records what you decided and why${missingCount ? `, even with ${missingCount} required item${missingCount === 1 ? "" : "s"} still missing` : ""}. You can undo it.</p><label for="decisionNote">Why (kept in the record)</label><input id="decisionNote" placeholder="e.g. All four files complete; approved for a 12-month lease">${errorLine("decisionError")}<div class="sheet-actions"><button data-decide="approve">Approve</button><button class="secondary" data-decide="hold">Hold</button><button class="secondary danger" data-decide="reject">Not approve</button></div>`;
}
function openGroup(group, data, rerender) {
  if (!group) return;
  const files = data.requests.filter((r) => r.group_id === group.id), st = groupState(group, files);
  const reopen = async (message) => { toast(message); await rerender(); const fresh = await loadRequests(state.propertyId); openGroup(fresh.groups.find((g) => g.id === group.id), fresh, rerender); };
  const body = openSheet(group.label, `${errorLine("groupError")}<div class="why-box"><p class="eyebrow">Why this is in front of you</p><p><strong>${esc(st.label)}</strong>${st.why ? ` · ${esc(st.why)}` : ""}</p><p class="muted">Each applicant’s file is checked against the same published requirements. A whole-apartment lease is decided for the group.</p></div>
<h3>Applicants <span class="count muted">${st.ready} of ${st.total} complete</span></h3><ul class="plain-rows">${files.map((f) => { const fs = groupState(null, [f]); const one = fs.blocking[0]; return `<li><span><strong>${esc(f.subject_name)}</strong><small>${one ? `Missing: ${esc(one.missing.join("; "))}${one.overdue ? ` · last asked ${one.waitedDays} days ago` : ""}` : "All required items in"}</small></span><span>${status(one ? (one.overdue ? "overdue" : "pending") : "complete", one ? (one.overdue ? "Chase" : "Waiting") : "Complete")}</span><button class="secondary small" data-file="${esc(f.id)}">Open file</button></li>`; }).join("")}</ul>
${group.decision ? `<div class="decided">${status(group.decision === "approve" ? "complete" : group.decision === "hold" ? "pending" : "blocked", REQUEST_DECISIONS[group.decision])}<p>${esc(group.decision_note || "")}</p><p class="muted">${esc(date(group.decided_at))} · kept in the property record</p><button class="secondary" id="undoDecision">Undo decision</button></div>` : decisionForm(st.blocking.reduce((n, b) => n + (b.missing[0] === "everything" ? 1 : b.missing.length), 0))}`);
  const back = { label: group.label, open: () => openGroup(group, data, rerender) };
  body.querySelectorAll("[data-file]").forEach((b) => b.onclick = () => openRequest(files.find((f) => f.id === b.dataset.file), async () => { await rerender(); const fresh = await loadRequests(state.propertyId); back.open = () => openGroup(fresh.groups.find((g) => g.id === group.id), fresh, rerender); }, back));
  const post = (extra) => api("request-decision", { method: "POST", body: JSON.stringify({ propertyId: state.propertyId, groupId: group.id, ...extra }) });
  body.querySelectorAll("[data-decide]").forEach((b) => b.onclick = async () => { const note = body.querySelector("#decisionNote").value.trim(); if (!note) { body.querySelector("#decisionNote").focus(); return showError("decisionError", new Error("Say why first · it is kept in the record.")); } b.disabled = true; try { await post({ decision: b.dataset.decide, note }); await reopen(`${REQUEST_DECISIONS[b.dataset.decide]} · recorded (you can undo)`); } catch (error) { b.disabled = false; showError("groupError", error); } });
  const undo = body.querySelector("#undoDecision"); if (undo) undo.onclick = async () => { undo.disabled = true; try { await post({ decision: null }); await reopen("Decision undone · both steps stay in the record"); } catch (error) { undo.disabled = false; showError("groupError", error); } };
}

// ---------- Rent allocation and sandbox invoicing ----------
// The household's own record of who has paid in is one thing; what the payment
// provider says about an invoice is another. They are shown side by side and never
// merged into a single word, because "Ada says she sent it" and "PayPal says it is
// paid" are different claims with different weight.

const paymentsApi = (path, options = {}) => api(path, options, "/api/payments/");

// Mirrors data/room-facts.mjs's FACTORS. Duplicated, not imported: public/ is
// served directly to the browser and cannot reach outside its own root. The
// server is still the only place a selection is actually validated or
// rendered — this list is presentation only, and drifting from the server's
// copy would be cosmetic, never a correctness bug, since every selection is
// re-checked there regardless of what this menu shows.
const ROOM_FACTORS = [
  { key: "squareFeet", label: "Room size", description: "Square footage of the room." },
  { key: "bathroom", label: "Bathroom", description: "Whether the bathroom is private or shared." },
  { key: "floor", label: "Floor", description: "Which floor the room is on, including a garden or basement level." },
  { key: "windowExposure", label: "Natural light", description: "Which way the windows face and how much light the room gets." },
  { key: "outdoorAccess", label: "Balcony or outdoor access", description: "Whether the room has a private balcony, patio, or other outdoor access." },
  { key: "storage", label: "Closet or storage", description: "How much closet or storage space the room has." },
  { key: "noise", label: "Noise", description: "Whether the room faces the street and is noisy, or is quiet." },
  { key: "parking", label: "Parking", description: "Whether a parking spot is assigned to the room." },
];
// A room's facts in a few words: what the AI split weighs, said the way a person would.
const roomFactsLine = (f) => !f ? "" : [f.squareFeet && `${f.squareFeet} sq ft`, f.bathroom && `${f.bathroom} bath`, f.floor, f.windowExposure, f.outdoorAccess, f.parking ? "parking" : null].filter(Boolean).join(" · ");
const CUSTOM = "custom:";
const factorLabel = (key) => ROOM_FACTORS.find((factor) => factor.key === key)?.label || (key.startsWith(CUSTOM) ? key.slice(CUSTOM.length) : key);

// The allocation workspace. ONE source in both modes: /api/allocation/workspace,
// served by the local server in sandbox mode and by the page's own bundled handler
// offline.
const allocationApi = (path, options = {}) => api(path, options, "/api/allocation/");
const loadWorkspace = (propertyId) => allocationApi(`workspace?propertyId=${encodeURIComponent(propertyId)}`);

// Money on the rent and collection surfaces always carries both decimals. The
// general formatter drops them on a whole number, which reads fine for a lease
// figure and wrong beside $680.00 and $2,520.00 in the same column.
const centsLabel = (cents) => cents == null ? "—" : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);

const INVOICE_TONE = { paid: "complete", marked_paid: "complete", partially_paid: "pending", payment_pending: "pending", sent: "pending", draft: "pending", cancelled: "blocked", refunded: "blocked", partially_refunded: "blocked", unknown: "overdue" };

function invoiceStatusChip(invoice) {
  if (!invoice) return "";
  if (invoice.localState === "send_uncertain") return status("overdue", "Send result unknown · check before retrying");
  if (invoice.localState === "create_failed") return status("blocked", "Draft failed");
  if (invoice.localState === "draft_proposed") return status("pending", "Preparing…");
  if (invoice.localState === "created") return status("pending", "Draft ready · not sent");
  if (invoice.paymentState) return status(INVOICE_TONE[invoice.paymentState] || "pending", invoice.paymentStateLabel);
  return status("pending", "Invoice sent · not paid");
}

// The month's rent as four steps, each on its own screen: Split (who pays what),
// Agree (residents confirm, you approve), Invoice (PayPal), Collect (who paid).
// Rent opens on the first step not yet done; the step bar moves between them.
// Allocation state and payment state still never share a claim: "Cam agreed to $760"
// lives under Agree, "PayPal says $760 arrived" under Collect.
const RENT_STEPS = ["Split", "Agree", "Invoice", "Collect"];
// What the page remembers between redraws of the same property. `factors` is what
// the next AI draft is based on — `{ [factorKey]: "excluded" }`, absent is weighed —
// and only reaches the server on "Suggest a split". `custom` is facts the landlord
// added by name; they travel as plain guidance, never as a factor key.
const rentUi = { propertyId: null, step: null, factors: {}, order: null, ranked: false, custom: [], adding: false, revising: false, feedback: false };

// The one way into Rent from elsewhere: a step to open, or one resident's invoice
// to show on top of it.
async function openRentActivity(property, { invoiceFor = null, step = null } = {}) {
  if (invoiceFor) {
    const result = await paymentsApi("refresh", { method: "POST", body: JSON.stringify({ propertyId: property.id, personId: invoiceFor }) });
    openInvoiceReview(property, result.review, rentReload(property));
    return;
  }
  Object.assign(rentUi, { propertyId: property.id, step });
  if (location.hash === "#rent") render(); else location.hash = "#rent";
}

// Re-read the workspace and redraw, but only while Rent is still the page on screen.
let factorDragged = false;
const rentReload = (p) => async () => {
  const next = await loadWorkspace(p.id);
  if ((location.hash.slice(1) || "today") === "rent") drawRent(p, next);
  return next;
};

async function rent() {
  const p = current();
  if (!p) { app.innerHTML = emptyState("No properties yet", "Rent appears here once a property is set up.", "", ""); return; }
  if (rentUi.propertyId !== p.id) Object.assign(rentUi, { propertyId: p.id, step: null, factors: {}, order: null, ranked: false, custom: [], adding: false, revising: false, feedback: false });
  const view = await loadWorkspace(p.id).catch((error) => absentOnly(error, null));
  if (!view) { app.innerHTML = emptyState("No rent period yet", "Once a billing period is set up for this property, it appears here.", "#today", "Back to Today"); return; }
  drawRent(p, view);
}

const stepEmpty = (ic, heading, detail, action = "") => `<section class="card step-empty"><span class="tile-ic">${icon(ic)}</span><h3>${esc(heading)}</h3>${detail ? `<p>${esc(detail)}</p>` : ""}${action}</section>`;
const personCell = (p, line, extra = "") => `<span class="avatar" aria-hidden="true">${esc(initials(line.name))}</span><span class="person-text"><strong>${esc(line.name)}</strong><small${extra ? ` title="${esc(extra)}"` : ""}>${esc(roomOf(p, line.roomId)?.label || "No room")}${extra ? ` · ${esc(extra)}` : ""}</small></span>`;

function drawRent(p, view) {
  const t = view.total, v = view.version, progress = rentProgress(view);
  const anyIssued = view.lines.some((line) => line.invoice?.providerInvoiceId);
  if (rentUi.revising && (v?.state !== "agreed" || anyIssued)) rentUi.revising = false;
  // With no version yet there is nothing published to protect, so everything is as
  // editable as an ordinary unpublished draft.
  const editable = !v || v.state !== "agreed" || rentUi.revising;
  const step = rentUi.step ?? Math.min(progress.at, 3);

  const hero = `<section class="card rent-hero"><div class="rent-hero-left"><span class="tile-ic">${icon("hand-coins")}</span><div><h2>${esc(view.period.label)}</h2><p>${esc(totalLabel(t.illustrative))} <strong>${esc(t.requiredLabel)}</strong> · ${view.lines.length} residents · due ${esc(view.period.due || "—")}</p></div></div>
    <div class="rent-hero-right">${progress.sentCount ? `<div class="rent-hero-num">${esc(centsLabel(progress.collected))} <small>of ${esc(t.requiredLabel)} collected</small></div>${meter(progress)}` : `<span class="chip ${v?.state === "agreed" ? "calm" : "none"}">${v?.state === "agreed" ? "Approved · ready to invoice" : "Nothing invoiced yet"}</span>`}</div></section>`;
  const bar = `<ol class="steps" role="tablist" aria-label="Rent steps">${RENT_STEPS.map((label, i) => { const s = progress.steps[i]; return `<li><button type="button" role="tab" data-step="${i}" class="${s.done ? "done" : ""}" aria-selected="${i === step}"><span class="step-n">${s.done ? icon("check") : i + 1}</span><span class="step-label"><strong>${label}</strong><small>${esc(s.detail)}</small></span></button></li>`; }).join("")}</ol>`;
  const panel = [() => splitPanel(p, view, editable, anyIssued), () => agreePanel(p, view), () => invoicePanel(p, view), () => collectPanel(p, view, progress)][step]();

  const pv = view.dataset.provenance;
  const foot = `<footer class="rent-foot"><p>Shares are what the household agreed between themselves. Invoicing a share doesn't change the lease, and Hearth doesn't decide what anyone owes.</p>
    ${pv ? `<details><summary>What's real in this demo</summary><dl class="facts">${pv.supplied?.length ? `<dt>Given for this meeting</dt><dd>${esc(pv.supplied.join(", "))}</dd>` : ""}<dt>Invented</dt><dd>${esc(pv.fictional.join(", "))}</dd><dt>Unknown</dt><dd>${esc(pv.unknown.join(", "))}</dd></dl></details>` : ""}
    ${!anyIssued || view.provider.simulated ? `<button type="button" class="link" data-restart>Start the walkthrough over</button>` : ""}</footer>`;

  app.innerHTML = `${errorLine("rentError")}${hero}${bar}${panel}${foot}`;
  wireRent(p, view, editable);
}

// The room facts in the landlord's order of importance. Turned-off facts keep
// their place in the order, so turning one back on returns it where it was.
const rentOrder = () => { const known = [...ROOM_FACTORS.map((factor) => factor.key), ...rentUi.custom.map((label) => CUSTOM + label)]; return [...(rentUi.order || []).filter((key) => known.includes(key)), ...known.filter((key) => !(rentUi.order || []).includes(key))]; };
// Only a ranking someone actually set is sent, as plain guidance the model reads
// beside the room facts. The default order is not a preference and is never sent.
const rankingContext = () => {
  const said = [];
  if (rentUi.ranked) {
    const on = rentOrder().filter((key) => rentUi.factors[key] !== "excluded").map(factorLabel);
    said.push(`The landlord ranked the room facts by how much they should count, most important first: ${on.map((label, i) => `${i + 1}. ${label}`).join(", ")}. Weigh higher-ranked facts more heavily than lower-ranked ones.`);
  }
  // An added fact may appear nowhere in the room facts; the model is told to use
  // only what is written and to name what it could not find.
  if (rentUi.custom.length) said.push(`The landlord also asked to weigh: ${rentUi.custom.join(", ")}. Use these only where the room facts above say something about them, and list any you could not find in unknowns.`);
  return said.length ? said.join(" ") : undefined;
};
function aiCard(view) {
  const v = view.version, available = view.ai?.available, order = rentOrder();
  const on = order.filter((key) => rentUi.factors[key] !== "excluded"), off = order.filter((key) => rentUi.factors[key] === "excluded");
  const chip = (key, rank) => { const factor = ROOM_FACTORS.find((f) => f.key === key), added = key.startsWith(CUSTOM); return rank
    ? `<button type="button" class="factor${added ? " added" : ""}" data-factor="${esc(key)}" aria-pressed="true" title="${added ? "Added by you. Drag to rank, click to remove." : `${esc(factor.description)} Drag to rank, click to leave out.`}"><span class="rank">${rank}</span>${esc(factorLabel(key))}${added ? `<span class="x" aria-hidden="true">${icon("x")}</span>` : ""}</button>`
    : `<button type="button" class="factor" data-factor="${esc(key)}" aria-pressed="false" title="Not priced in. Click to include.">${esc(factor.label)}</button>`; };
  const add = rentUi.adding
    ? `<form class="factor-form" data-factor-form><input type="text" maxlength="40" placeholder="e.g. Private entrance" aria-label="Fact to add" required><button type="submit" class="small">Add</button><button type="button" class="quiet small" data-cancel-factor>Cancel</button></form>`
    : `<button type="button" class="factor-add" data-add-factor>${icon("plus")}Add a factor</button>`;
  return `<section class="ai-card"><div class="ai-top"><span class="ai-mark" aria-hidden="true">${icon("magic-wand")}</span>
    <div class="ai-body"><h3>${v?.aiWeights ? "Want another suggestion?" : "Let AI suggest a fair split"}</h3><p>Drag what matters most to the front. Click a fact to leave it out.</p></div>
    <div class="ai-cta"><button type="button" data-ai-draft${available ? "" : " disabled"}>${icon("magic-wand")}Suggest a split</button><small>${available ? "or type the shares below" : esc(view.ai?.reason || "AI is off in this mode.")}</small></div></div>
    <div class="factors" role="group" aria-label="Room facts, most important first">${on.map((key, i) => chip(key, i + 1)).join("")}${off.map((key) => chip(key, 0)).join("")}${add}</div></section>`;
}

function splitPanel(p, view, editable, anyIssued) {
  const t = view.total, v = view.version, src = splitSource(v);
  const rows = view.lines.map((line) => {
    // No value at all — not 0.00 — when nobody has set this share yet. A pre-filled
    // zero would read as a decision nobody made. Once an invoice exists the share
    // stops being a text box: changing a number can't correct an issued invoice.
    const amount = editable && !line.invoice?.providerInvoiceId
      ? `<input class="share-input" type="text" inputmode="decimal" value="${line.amountCents != null ? esc((line.amountCents / 100).toFixed(2)) : ""}" placeholder="0.00" data-share="${esc(line.personId)}" aria-label="${esc(line.name)} share in dollars">`
      : `<span class="person-amount">${line.amountLabel != null ? esc(line.amountLabel) : "—"}${line.invoice?.providerInvoiceId ? `<small>${line.invoice.localState === "sent" ? "Invoiced" : "Invoice drafted"}</small>` : ""}</span>`;
    return `<div class="person-row">${personCell(p, line, v?.aiBasis?.[line.personId] || "")}${amount}</div>`;
  }).join("");
  const sum = !v ? `<span class="sum">Nothing assigned yet</span>`
    : t.balances ? `<span class="sum ok">${icon("circle-check")}Adds up to ${esc(t.requiredLabel)}</span>`
    : `<span class="sum off">${esc(t.allocatedLabel ?? "—")} of ${esc(t.requiredLabel)} · ${esc(t.differenceLabel)} ${t.differenceCents < 0 ? "short" : "over"}</span>`;
  // What a redraft actually answered: which residents moved and which held,
  // computed from the two weight maps, not trusted as the model's claim.
  let redraft = "";
  if (v?.feedback && view.previousVersion?.aiWeights) {
    const moved = [], held = [];
    for (const line of view.lines) { const before = view.previousVersion.aiWeights[line.personId], after = v.aiWeights?.[line.personId]; if (before == null || after == null) continue; (Math.abs(after - before) > 0.0001 ? moved : held).push(first(line.name)); }
    redraft = `<p class="redraft-note">You said ${esc(factorLabel(v.feedback.factor).toLowerCase())} was weighted too ${v.feedback.direction === "over_weighted" ? "high" : "low"}. Moved: ${esc(moved.join(", ") || "nobody")}. Held: ${esc(held.join(", ") || "nobody")}.</p>`;
  }
  const feedback = rentUi.feedback ? `<div class="feedback"><label>Whose share<select data-feedback-person>${view.lines.map((line) => `<option value="${esc(line.personId)}">${esc(line.name)}</option>`).join("")}</select></label><label>Which fact<select data-feedback-factor>${ROOM_FACTORS.map((factor) => `<option value="${esc(factor.key)}">${esc(factor.label)}</option>`).join("")}</select></label><label>It was weighted<select data-feedback-direction><option value="over_weighted">Too high</option><option value="under_weighted">Too low</option></select></label><label>Overall<select data-feedback-rating>${[5, 4, 3, 2, 1].map((n) => `<option value="${n}">${n} of 5</option>`).join("")}</select></label><button type="button" data-send-feedback>${icon("magic-wand")}Redraft</button></div>` : "";

  let hint = "", actions = "";
  if (!v) hint = "Type each share, or let AI suggest a starting split.";
  else if (v.state === "draft") { hint = view.blocked.publish || (t.balances ? "Looks right? Send it to the residents to confirm." : `Shares need to add up to ${t.requiredLabel}.`); actions = `<button type="button" data-publish${view.blocked.publish || !t.balances ? " disabled" : ""}>${icon("send")}Send to residents</button>`; }
  else if (v.state === "proposed") { hint = `Sent to residents. Changing a share starts version ${v.n + 1}.`; actions = `<button type="button" data-goto="1">Go to Agree${icon("arrow-right")}</button>`; }
  else { hint = rentUi.revising ? "Change a share to start a new version. Residents confirm it again." : "Approved by you."; actions = `${!anyIssued && !rentUi.revising ? `<button type="button" class="secondary" data-revise>Revise the split</button>` : ""}<button type="button" data-goto="2">Go to Invoice${icon("arrow-right")}</button>`; }

  return `${editable ? aiCard(view) : ""}<section class="card">
    <div class="card-head"><h3>${icon("users")}Who pays what</h3>${sum}</div>
    ${v ? `<p class="source">${icon(src.kind === "ai" ? "magic-wand" : src.kind === "example" ? "file-text" : "users")}${esc(src.label)}${src.kind === "ai" && rentUi.ranked ? ` · ranked by you: ${esc(rentOrder().filter((k) => rentUi.factors[k] !== "excluded").slice(0, 3).map(factorLabel).join(", "))}…` : ""}${v.excludedFactors?.length ? ` · ${esc(v.excludedFactors.map(factorLabel).join(", "))} not priced in` : ""}</p>` : ""}
    ${src?.kind === "ai" && v.aiUnknowns?.length ? `<p class="source unknowns">${icon("info")}The AI couldn't find: ${esc(v.aiUnknowns.join("; "))}</p>` : ""}
    ${redraft}<div class="share-grid">${rows}</div>${feedback}
    <div class="panel-foot"><p class="hint">${esc(hint)}${v?.aiWeights && editable ? ` <button type="button" class="link" data-feedback-toggle>${rentUi.feedback ? "Close" : "Not quite right? Tell the AI."}</button>` : ""}</p><div class="actions">${actions}</div></div>
    ${v ? `<p class="version-tag" title="A fingerprint of these exact numbers. Each confirmation is bound to it.">Version ${v.n} · ${esc(v.state)} · ${esc(v.label)}</p>` : ""}
    ${view.previousVersion ? `<details class="version-tag"><summary>Compare with version ${view.previousVersion.n}</summary><div class="share-grid">${view.previousVersion.lines.map((line) => `<div class="person-row">${personCell(p, line, view.previousVersion.aiBasis?.[line.personId] || "")}<span class="person-amount">${line.amountCents != null ? esc(centsLabel(line.amountCents)) : "—"}</span></div>`).join("")}</div></details>` : ""}
  </section>`;
}

function agreePanel(p, view) {
  const v = view.version, t = view.total;
  if (!v) return stepEmpty("users", "Nothing to agree on yet", "Start with the split. Residents confirm their share here.", `<button type="button" data-goto="0">Go to Split</button>`);
  if (v.state === "draft") return stepEmpty("send", "Ready to send?", t.balances ? `Each resident confirms their share of ${t.requiredLabel}.` : `The shares don't add up to ${t.requiredLabel} yet.`, t.balances ? `<button type="button" data-publish${view.blocked.publish ? " disabled" : ""}>${icon("send")}Send to residents</button>` : `<button type="button" data-goto="0">Back to Split</button>`);
  const n = view.lines.length, confirmed = view.lines.filter((line) => line.confirmed || line.confirmedBySeed).length, agreed = v.state === "agreed";
  const rows = view.lines.map((line) => {
    const chip = line.confirmed || line.confirmedBySeed ? `<span class="chip ok">${icon("check")}Confirmed${line.confirmedOn ? ` ${esc(shortDate(line.confirmedOn))}` : ""}</span>`
      : line.confirmedOtherVersion ? `<span class="chip t2">Confirmed other numbers</span>` : `<span class="chip t1">Waiting</span>`;
    const act = v.state === "proposed" && !line.confirmed ? `<button type="button" class="secondary small" data-confirm="${esc(line.personId)}">Confirm as ${esc(first(line.name))}</button>` : "";
    return `<div class="person-row">${personCell(p, line)}<span class="person-amount">${esc(line.amountLabel ?? "—")}</span>${chip}${act}</div>`;
  }).join("");
  const pct = n ? Math.round((confirmed / n) * 100) : 0;
  return `<section class="card">
    <div class="card-head"><h3>${icon("users")}Residents confirm their share</h3><span class="count-pill">${confirmed} of ${n}</span></div>
    <div class="meter progress" role="img" aria-label="${confirmed} of ${n} confirmed"><span style="width:${pct}%"></span></div>
    <div class="person-list" style="margin-top:8px">${rows}</div>
    <div class="panel-foot">${agreed
      ? `<p class="hint">${icon("seal-check")} Approved by you${view.approval?.at ? ` · ${esc(date(view.approval.at))}` : view.approval?.on ? ` · ${esc(shortDate(view.approval.on))}` : ""}</p><div class="actions"><button type="button" data-goto="2">Go to Invoice${icon("arrow-right")}</button></div>`
      : `<p class="hint">In a real house each resident confirms by text. Here you can confirm for them.</p><div class="actions">${confirmed < n ? `<button type="button" class="secondary" data-confirm-all>Confirm for everyone</button>` : ""}<button type="button" data-approve${view.blocked.approve ? " disabled" : ""}>${icon("seal-check")}Approve the split</button></div>`}</div>
  </section>`;
}

function invoicePanel(p, view) {
  const v = view.version;
  if (v?.state !== "agreed" || rentUi.revising) return stepEmpty("seal-check", "Approve the split first", "Invoices go out only for numbers every resident confirmed and you approved.", `<button type="button" data-goto="1">Go to Agree</button>`);
  if (!view.provider.available) return stepEmpty("paypal", "No payment provider connected", view.provider.reason || "");
  const n = view.lines.length, sent = view.lines.filter((line) => line.invoice?.localState === "sent").length;
  const unprepared = view.lines.filter((line) => !line.invoice && line.recipientMapped).length;
  const ready = view.lines.filter((line) => line.invoice?.localState === "created").length;
  const rows = view.lines.map((line) => {
    const chip = line.invoice ? invoiceStatusChip(line.invoice) : line.recipientMapped ? `<span class="chip none">Not prepared</span>` : `<span class="chip none">No PayPal email</span>`;
    const act = !line.invoice ? (line.recipientMapped ? `<button type="button" class="secondary small" data-draft="${esc(line.personId)}">Prepare</button>` : "")
      : line.invoice.localState === "created" ? `<button type="button" class="small" data-review="${esc(line.personId)}">Review and send</button>`
      : `<button type="button" class="secondary small" data-review="${esc(line.personId)}">Open</button>`;
    return `<div class="person-row">${personCell(p, line)}<span class="person-amount">${esc(line.amountLabel ?? "—")}</span>${chip}${act}</div>`;
  }).join("");
  return `<section class="card">
    <div class="card-head"><h3>${icon("paypal")}${view.provider.simulated ? "Invoices · simulated PayPal" : "PayPal invoices"}</h3><span class="count-pill">${sent} of ${n} sent</span></div>
    <div class="person-list">${rows}</div>
    <div class="panel-foot"><p class="hint">${sent === n ? "Every invoice is out." : "Prepare drafts, then send. Nothing goes out until you press Send."}</p><div class="actions">${unprepared ? `<button type="button" class="secondary" data-draft-all>Prepare ${unprepared} ${unprepared === 1 ? "draft" : "drafts"}</button>` : ""}${ready ? `<button type="button" data-send-all>${icon("send")}Send ${ready} ${ready === 1 ? "invoice" : "invoices"}</button>` : ""}${sent === n ? `<button type="button" data-goto="3">Track payments${icon("arrow-right")}</button>` : ""}</div></div>
  </section>`;
}

function collectPanel(p, view, progress) {
  const t = view.total, n = view.lines.length;
  const paidLine = (line) => line.invoice?.paidCents >= line.amountCents && line.amountCents > 0;
  const paid = view.lines.filter(paidLine).length;
  const waiting = view.lines.filter((line) => line.invoice?.localState === "sent" && !paidLine(line)).length;
  const outstanding = Math.max(0, t.requiredCents - progress.collected);
  const rows = view.lines.map((line) => `<tr><td><button type="button" class="ledger-person" data-ledger="${esc(line.personId)}">${personCell(p, line)}</button></td>
    <td class="num"><strong>${line.amountLabel != null ? esc(line.amountLabel) : "—"}</strong></td>
    <td>${line.invoice ? invoiceStatusChip(line.invoice) : `<span class="chip none">Not invoiced</span>`}</td>
    <td class="num">${line.invoice?.paidCents ? esc(centsLabel(line.invoice.paidCents)) : `<span class="muted">—</span>`}</td></tr>`).join("");
  return `<div class="collect">
    <section class="card"><div class="card-head"><h3>${icon("chart-donut")}Collected</h3></div>
      <div class="donut-row">${donut([{ value: paid, color: "var(--g1)" }, { value: waiting, color: "var(--g2)" }, { value: n - paid - waiting, color: "var(--g3)" }], `${paid}/${n}`, "residents paid")}
      <ul class="legend"><li><i style="background:var(--g1)"></i>Paid <b>${paid}</b></li><li><i style="background:var(--g2)"></i>Waiting <b>${waiting}</b></li><li><i style="background:var(--g3)"></i>Not invoiced <b>${n - paid - waiting}</b></li></ul></div>
      <div class="collect-figures"><div><span>Collected</span><strong>${esc(centsLabel(progress.collected))}</strong></div><div><span>Still due</span><strong>${esc(centsLabel(outstanding))}</strong></div><div><span>${esc(totalLabel(t.illustrative))}</span><strong>${esc(t.requiredLabel)}</strong></div></div>
      ${progress.sentCount ? `<p style="margin:16px 0 0"><button type="button" class="secondary small" data-refresh-all>${icon("refresh-cw")}${view.provider.simulated ? "Refresh statuses" : "Refresh from PayPal"}</button></p>` : ""}
    </section>
    <section class="card ledger-card"><table class="ledger"><thead><tr><th>Resident</th><th class="num">Share</th><th>${view.provider.simulated ? "Invoice (simulated)" : "PayPal invoice"}</th><th class="num">Paid</th></tr></thead><tbody>${rows}</tbody></table></section>
  </div>`;
}

function wireRent(p, view, editable) {
  const v = view.version, reload = rentReload(p);
  const redraw = (step = rentUi.step) => { rentUi.step = step; drawRent(p, view); };
  // No version yet: the server bootstraps v1 from nothing and needs no
  // versionCanonical to match against.
  const call = (route, payload) => allocationApi(route, { method: "POST", body: JSON.stringify({ propertyId: p.id, ...(v ? { versionCanonical: v.canonical } : {}), ...payload }) });
  const post = async (route, payload, button, nextStep) => {
    if (button) button.disabled = true;
    try { await call(route, payload); if (nextStep !== undefined) rentUi.step = nextStep; await reload(); }
    catch (error) { if (button) button.disabled = false; showError("rentError", error); }
  };
  // Several actions, one after another, stopping at the first refusal so a failure
  // is never hidden behind later successes.
  const each = async (button, busy, list, run, done) => {
    button.disabled = true; button.textContent = busy;
    let count = 0;
    try { for (const line of list) { await run(line); count += 1; } toast(done(count)); }
    catch (error) { showError("rentError", error); }
    await reload().catch((error) => showError("rentError", error));
  };

  app.querySelectorAll("[data-step]").forEach((button) => button.onclick = () => redraw(Number(button.dataset.step)));
  app.querySelectorAll("[data-goto]").forEach((button) => button.onclick = () => { redraw(Number(button.dataset.goto)); window.scrollTo({ top: 0, behavior: "smooth" }); });

  app.querySelectorAll("[data-share]").forEach((input) => {
    const commit = async () => {
      const cents = parseShareCents(input.value);
      const line = view.lines.find((x) => x.personId === input.dataset.share);
      if (cents === null) {
        input.value = line.amountCents != null ? (line.amountCents / 100).toFixed(2) : "";
        showError("rentError", new Error(`Not saved: enter ${line.name}'s share as dollars and cents, for example 1300 or 1,300.50.`));
        return;
      }
      if (cents === line.amountCents) return;
      await post("share", { personId: input.dataset.share, amountCents: cents }, input, 0);
    };
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); input.blur(); } });
    input.addEventListener("blur", commit);
  });

  // Toggling a fact only redraws from `rentUi.factors`; nothing is sent until
  // "Suggest a split" is pressed. A fact turned off is recorded on the draft as not
  // priced in.
  app.querySelectorAll("[data-factor]").forEach((button) => button.onclick = () => {
    if (factorDragged) return;
    const key = button.dataset.factor;
    // A fact the landlord added is removed outright; a built-in one is turned off.
    if (key.startsWith(CUSTOM)) { rentUi.custom = rentUi.custom.filter((label) => CUSTOM + label !== key); rentUi.order = (rentUi.order || []).filter((k) => k !== key); }
    else if (rentUi.factors[key] === "excluded") delete rentUi.factors[key]; else rentUi.factors[key] = "excluded";
    redraw();
  });
  app.querySelector("[data-add-factor]")?.addEventListener("click", () => { rentUi.adding = true; redraw(); app.querySelector("[data-factor-form] input")?.focus(); });
  app.querySelector("[data-cancel-factor]")?.addEventListener("click", () => { rentUi.adding = false; redraw(); });
  app.querySelector("[data-factor-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const label = event.currentTarget.querySelector("input").value.trim().replace(/\s+/g, " ");
    const taken = [...ROOM_FACTORS.map((f) => f.label), ...rentUi.custom].some((name) => name.toLowerCase() === label.toLowerCase());
    if (label && !taken) rentUi.custom = [...rentUi.custom, label];
    rentUi.adding = false; redraw();
  });
  // Ranking: press a fact and drag it onto another to take its place (mouse, pen or
  // touch), or move the focused one with the arrow keys. A press that doesn't travel
  // stays a click.
  const place = (key, index) => {
    const on = rentOrder().filter((k) => rentUi.factors[k] !== "excluded" && k !== key);
    on.splice(Math.max(0, Math.min(index, on.length)), 0, key);
    rentUi.order = [...on, ...rentOrder().filter((k) => !on.includes(k))]; rentUi.ranked = true;
    redraw(); app.querySelector(`[data-factor="${CSS.escape(key)}"]`)?.focus();
  };
  const rankOf = (key) => rentOrder().filter((k) => rentUi.factors[k] !== "excluded").indexOf(key);
  const ranked = [...app.querySelectorAll('.factor[aria-pressed="true"]')];
  ranked.forEach((chip) => {
    chip.addEventListener("pointerdown", (down) => {
      if (down.button !== 0) return;
      const from = rankOf(chip.dataset.factor); let dragging = false, target = null;
      const move = (event) => {
        const dx = event.clientX - down.clientX, dy = event.clientY - down.clientY;
        if (!dragging && Math.hypot(dx, dy) < 6) return;
        dragging = true; chip.classList.add("dragging"); chip.style.transform = `translate(${dx}px, ${dy}px)`;
        target = ranked.find((other) => { if (other === chip) return false; const r = other.getBoundingClientRect(); return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top - 8 && event.clientY <= r.bottom + 8; }) || null;
        ranked.forEach((other) => { const to = other === target ? rankOf(other.dataset.factor) : -1; other.classList.toggle("drop-before", to >= 0 && to < from); other.classList.toggle("drop-after", to > from); });
      };
      const up = () => {
        window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
        if (!dragging) return;
        // The click that follows this release is part of the drag, not a toggle.
        factorDragged = true; setTimeout(() => { factorDragged = false; }, 0);
        if (target) place(chip.dataset.factor, rankOf(target.dataset.factor));
        else { chip.classList.remove("dragging"); chip.style.transform = ""; ranked.forEach((other) => other.classList.remove("drop-before", "drop-after")); }
      };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
    });
    chip.addEventListener("keydown", (event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); place(chip.dataset.factor, rankOf(chip.dataset.factor) + (event.key === "ArrowLeft" ? -1 : 1)); });
  });
  app.querySelector("[data-ai-draft]")?.addEventListener("click", (event) => { const button = event.currentTarget, context = rankingContext(); button.innerHTML = `${icon("magic-wand")}Thinking…`; post("ai-draft", { factorSelection: rentUi.factors, ...(context ? { context } : {}) }, button, 0); });
  app.querySelector("[data-feedback-toggle]")?.addEventListener("click", () => { rentUi.feedback = !rentUi.feedback; redraw(); });
  app.querySelector("[data-send-feedback]")?.addEventListener("click", (event) => {
    const form = event.currentTarget.closest(".feedback");
    const feedback = { personId: form.querySelector("[data-feedback-person]").value, rating: Number(form.querySelector("[data-feedback-rating]").value), factor: form.querySelector("[data-feedback-factor]").value, direction: form.querySelector("[data-feedback-direction]").value };
    rentUi.feedback = false;
    event.currentTarget.innerHTML = `${icon("magic-wand")}Thinking…`;
    const context = rankingContext();
    post("ai-redraft", { feedback, factorSelection: rentUi.factors, ...(context ? { context } : {}) }, event.currentTarget, 0);
  });
  app.querySelector("[data-revise]")?.addEventListener("click", () => { rentUi.revising = true; redraw(0); });

  app.querySelectorAll("[data-publish]").forEach((button) => button.onclick = () => post("publish", {}, button, 1));
  app.querySelector("[data-approve]")?.addEventListener("click", (event) => { rentUi.revising = false; post("approve", {}, event.currentTarget, 2); });
  app.querySelectorAll("[data-confirm]").forEach((button) => button.onclick = () => post("confirm", { personId: button.dataset.confirm }, button));
  app.querySelector("[data-confirm-all]")?.addEventListener("click", (event) => each(event.currentTarget, "Confirming…", view.lines.filter((line) => !line.confirmed && !line.confirmedBySeed), (line) => call("confirm", { personId: line.personId }), (n) => `${n} confirmed`));

  // Payment actions stay on the payments API. Allocation never touches an invoice.
  const draftOne = (line) => paymentsApi("draft", { method: "POST", body: JSON.stringify({ propertyId: p.id, personId: line.personId, allocationVersion: v.canonical }) });
  app.querySelectorAll("[data-draft]").forEach((button) => button.onclick = async () => {
    button.disabled = true; button.textContent = "Preparing…";
    try { const result = await draftOne(view.lines.find((line) => line.personId === button.dataset.draft)); await reload(); openInvoiceReview(p, result.review, reload); }
    catch (error) { button.disabled = false; button.textContent = "Prepare"; showError("rentError", error); }
  });
  app.querySelector("[data-draft-all]")?.addEventListener("click", (event) => each(event.currentTarget, "Preparing…", view.lines.filter((line) => !line.invoice && line.recipientMapped), draftOne, (n) => `${n} ${n === 1 ? "draft" : "drafts"} ready · nothing sent`));
  // Two clicks, like a single send: the first says exactly what is about to go out.
  app.querySelector("[data-send-all]")?.addEventListener("click", (event) => {
    const button = event.currentTarget, ready = view.lines.filter((line) => line.invoice?.localState === "created");
    if (!button.dataset.confirming) {
      const cents = ready.reduce((sum, line) => sum + (line.amountCents || 0), 0);
      button.dataset.confirming = "1"; button.textContent = `Confirm — send ${ready.length} ${ready.length === 1 ? "invoice" : "invoices"} for ${centsLabel(cents)}`;
      setTimeout(() => { if (button.isConnected && button.dataset.confirming) { delete button.dataset.confirming; button.innerHTML = `${icon("send")}Send ${ready.length} ${ready.length === 1 ? "invoice" : "invoices"}`; } }, 8000);
      return;
    }
    each(button, "Sending…", ready, (line) => paymentsApi("send", { method: "POST", body: JSON.stringify({ propertyId: p.id, personId: line.personId, allocationVersion: v.canonical, confirmed: true }) }), (n) => `${n} ${n === 1 ? "invoice" : "invoices"} sent · not paid yet`);
  });
  app.querySelectorAll("[data-review]").forEach((button) => button.onclick = async () => {
    try { openInvoiceReview(p, (await paymentsApi("refresh", { method: "POST", body: JSON.stringify({ propertyId: p.id, personId: button.dataset.review }) })).review, reload); }
    catch (error) { showError("rentError", error); }
  });
  app.querySelector("[data-refresh-all]")?.addEventListener("click", (event) => each(event.currentTarget, "Checking…", view.lines.filter((line) => line.invoice?.localState === "sent"), (line) => paymentsApi("refresh", { method: "POST", body: JSON.stringify({ propertyId: p.id, personId: line.personId }) }), () => "Statuses updated"));
  app.querySelectorAll("[data-ledger]").forEach((button) => button.onclick = () => openLedger(p, view, view.lines.find((line) => line.personId === button.dataset.ledger)));

  app.querySelector("[data-restart]")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    // Two clicks: the first asks, the second resets. The server refuses if any
    // invoice exists at the provider.
    if (!button.dataset.confirming) { button.dataset.confirming = "1"; button.textContent = "Confirm: reset this split to the starting example"; setTimeout(() => { if (button.isConnected && button.dataset.confirming) { delete button.dataset.confirming; button.textContent = "Start the walkthrough over"; } }, 5000); return; }
    Object.assign(rentUi, { step: null, revising: false, feedback: false });
    // The offline demo keeps everything in page memory, simulated invoices too, so
    // reloading IS the reset.
    if (view.provider.simulated && OFFLINE_MODE) { location.reload(); return; }
    post("reset", {}, button);
  });
}

// A ring of coloured arcs, one per part, with a figure in the middle.
function donut(parts, big, small) {
  const r = 54, c = 2 * Math.PI * r, total = parts.reduce((sum, part) => sum + part.value, 0) || 1;
  let offset = 0;
  const arcs = parts.filter((part) => part.value > 0).map((part) => { const len = (part.value / total) * c; const arc = `<circle cx="66" cy="66" r="${r}" fill="none" style="stroke:${part.color}" stroke-width="16" stroke-dasharray="${Math.max(0, len - (len < c ? 2 : 0))} ${c}" stroke-dashoffset="${-offset}"/>`; offset += len; return arc; }).join("");
  return `<div class="donut"><svg viewBox="0 0 132 132" width="132" height="132" aria-hidden="true"><circle cx="66" cy="66" r="${r}" fill="none" stroke="#e8ebf4" stroke-width="16"/>${arcs}</svg><div class="donut-mid"><strong>${esc(big)}</strong><small>${esc(small)}</small></div></div>`;
}

// Everything a person needs before authorizing money to be asked for: who it goes
// to, how much, for which period, and who it comes from.
function openInvoiceReview(property, review, reload, { justSent = false } = {}) {
  const invoice = review.invoice || {};
  const sent = invoice.localState === "sent";
  const uncertain = invoice.localState === "send_uncertain";
  const kind = review.simulated ? "Simulated invoice" : "PayPal invoice";
  openSheet(`${kind} · ${review.recipient.name}`, '<div id="invoiceSlot"></div>');
  const slot = document.querySelector("#invoiceSlot");
  const share = state.demoMeta?.rentActivity?.[property.id]?.illustrative ? "illustrative household total" : "monthly rent";
  slot.innerHTML = `<section class="invoice-review receipt">
<header class="receipt-head"><span class="receipt-kind">${icon("receipt-text")}${esc(kind)} · ${sent ? "sent" : uncertain ? "send result unknown" : "review before sending"}</span>${sent ? invoiceStatusChip(invoice) : ""}</header>
<div class="receipt-amount"><span>Amount</span><strong>${esc(review.amountLabel)}</strong><small>share of the ${esc(review.allocation.totalLabel)} ${share}</small></div>
<dl class="receipt-lines">
  <div><dt>To</dt><dd><strong>${esc(review.recipient.name)}</strong><span>${esc(review.recipient.email || "no sandbox recipient mapped")}</span></dd></div>
  <div><dt>From</dt><dd><strong>${esc(review.seller?.name || "—")}</strong><span>${esc(review.seller?.email || "—")}</span></dd></div>
  <div><dt>For</dt><dd>${esc(review.period.label)} · due ${esc(review.period.due || "—")}</dd></div>
  <div><dt>Approved split</dt><dd><span class="version-label">${esc(review.allocation.versionLabel)}</span><span>Approval is bound to these exact numbers</span></dd></div>
  ${review.invoiceNumber ? `<div><dt>Invoice number</dt><dd>${esc(review.invoiceNumber)}</dd></div>` : ""}
  ${invoice.providerInvoiceId ? `<div><dt>${esc(kind)}</dt><dd>${esc(invoice.providerInvoiceId)} · ${esc(invoice.providerStatus || "—")}</dd></div>` : ""}
  ${sent && invoice.paidCents != null ? `<div><dt>Paid so far</dt><dd><strong>${esc(centsLabel(invoice.paidCents))}</strong>${invoice.dueCents != null ? `<span>Still due ${esc(centsLabel(invoice.dueCents))}</span>` : ""}</dd></div>` : ""}
  <div><dt>Environment</dt><dd>${esc(review.environment)}</dd></div>
</dl>
${errorLine("invoiceError")}
${uncertain ? `<p class="blocked-banner" role="alert">The last send attempt did not return a result, so Hearth does not know whether this went out. Check the provider before trying again.</p><div class="sheet-actions"><button id="invoiceRefresh">Check with ${review.simulated ? "the simulated provider" : "PayPal"}</button></div>` : ""}
${!sent && !uncertain ? `<p class="receipt-note">Nothing has been sent yet. This is a draft at the provider; sending it is a separate, deliberate step.</p><div class="sheet-actions"><button id="invoiceSend">Send invoice</button><button class="secondary" id="invoiceCancel">Not now</button></div>` : ""}
${sent ? `<p class="receipt-note">${invoice.lastCheckedAt ? `Status read ${esc(date(invoice.lastCheckedAt))}. ` : ""}${invoice.paymentState === "paid" ? `Paid in full, as the ${review.simulated ? "simulated provider" : "PayPal"} status read reports.` : `Sent is not paid. ${review.simulated ? "In this offline demo the simulated resident pays when you next refresh the status; no money exists." : "Only a status read from PayPal can say whether any money arrived."}`}</p><div class="sheet-actions"><button class="secondary" id="invoiceRefresh">${review.simulated ? "Refresh status (simulated)" : "Refresh status from PayPal"}</button>${invoice.recipientViewUrl ? `<button class="secondary" id="invoiceText">Draft text with the payment link</button><a class="button secondary" href="${esc(invoice.recipientViewUrl)}" target="_blank" rel="noreferrer">${icon("external-link")}Open the payment page</a>` : ""}</div>` : ""}
<div id="invoiceAction"></div></section>`;
  slot.scrollIntoView({ block: "nearest" });

  const send = slot.querySelector("#invoiceSend");
  if (send) send.onclick = async () => {
    // Two steps on purpose: the first click says what is about to happen in the
    // words of the actual amounts, the second one does it.
    if (!send.dataset.confirming) {
      send.dataset.confirming = "1";
      send.textContent = `Confirm — send ${review.amountLabel} invoice to ${first(review.recipient.name)}`;
      setTimeout(() => { if (send.isConnected && send.dataset.confirming) { delete send.dataset.confirming; send.textContent = "Send invoice"; } }, 8000);
      return;
    }
    send.disabled = true; send.textContent = "Sending…";
    try {
      const result = await paymentsApi("send", { method: "POST", body: JSON.stringify({ propertyId: property.id, personId: review.recipient.personId, allocationVersion: review.allocation.version, confirmed: true }) });
      toast(result.alreadySent ? "Already sent · not sent again" : "Invoice sent · not paid");
      await reload();
      openInvoiceReview(property, result.review, reload, { justSent: true });
    } catch (error) {
      // A refusal (4xx) means nothing was sent. Anything else — a 5xx, a timeout, a
      // dropped connection — means the outcome is unknown: the panel must stop
      // offering "Send" and show the unknown state, whose only action is to check.
      const refused = error.status >= 400 && error.status < 500;
      if (!refused) {
        await reload().catch(() => {});
        openInvoiceReview(property, { ...review, invoice: { ...review.invoice, localState: "send_uncertain" } }, reload);
        showError("invoiceError", error);
        return;
      }
      send.disabled = false; delete send.dataset.confirming; send.textContent = "Send invoice"; showError("invoiceError", error);
    }
  };
  const cancel = slot.querySelector("#invoiceCancel");
  if (cancel) cancel.onclick = () => sheet.close();
  const refresh = slot.querySelector("#invoiceRefresh");
  // Right after a send, Refresh appears where the Confirm button was. A double click
  // on Confirm must not land on it: in the offline demo a refresh is when the
  // simulated resident pays, so "sent" would jump straight to "paid".
  if (refresh && justSent) { refresh.disabled = true; setTimeout(() => { refresh.disabled = false; }, 1000); }
  if (refresh) refresh.onclick = async () => {
    refresh.disabled = true;
    try {
      const result = await paymentsApi("refresh", { method: "POST", body: JSON.stringify({ propertyId: property.id, personId: review.recipient.personId }) });
      toast(`${result.review.simulated ? "Simulated provider (offline demo) says" : "Provider says"}: ${result.review.invoice?.paymentStateLabel || result.paymentState}`);
      await reload();
      openInvoiceReview(property, result.review, reload);
    } catch (error) { refresh.disabled = false; showError("invoiceError", error); }
  };
  // The text is simulated, as every message in this demo is. The LINK in it is real.
  const text = slot.querySelector("#invoiceText");
  if (text) text.onclick = () => {
    const person = (property.people || []).find((x) => x.id === review.recipient.personId) || { name: review.recipient.name };
    const action = slot.querySelector("#invoiceAction");
    action.innerHTML = `<p class="muted small-text"><span class="demo-flag">Simulated message</span> Nothing is sent. The payment link in it is a real PayPal sandbox invoice.</p>${composer({ person, buttonLabel: "Approve reminder (records a dry run)", placeholder: "Exact reminder text" })}`;
    action.querySelector("#composeBody").value = `Hi ${first(person.name)}, your ${review.amountLabel} share for ${review.period.label} can be paid here: ${invoice.recipientViewUrl}`;
    action.querySelector("#composeSend").onclick = () => sendText({ personId: review.recipient.personId, reason: `Rent invoice reminder for ${review.period.label}` }, async () => { action.innerHTML = '<p class="muted small-text">Reminder recorded as a dry run · nothing was sent.</p>'; });
  };
}
// Today: one sentence on what to do next, four numbers that cover the house — rent,
// what needs you, the residents, next year's lease — and then the detail behind each.
async function today() {
  const summaries = await api("overview"); state.summaries = Object.fromEntries(summaries.map((item) => [item.id, item])); updateChrome();
  const p = current();
  if (!p) { app.innerHTML = emptyState("No properties yet", "Once a property is set up, Today shows what needs you there.", "", ""); return; }
  const [escalations, decisions, messages, requestLists, allocation] = await Promise.all([
    api(`escalations?propertyId=${p.id}`), api(`needs-human?propertyId=${p.id}`), api(`messages?propertyId=${p.id}`),
    Promise.all(state.properties.map((x) => loadRequests(x.id))),
    // Rent's status comes from the allocation API, exactly as the Rent page's does. A
    // property with no rent period set up returns NO_PERIOD and gets no rent figures,
    // which is true; anything else gets them.
    loadWorkspace(p.id).catch((error) => absentOnly(error, null)),
  ]);
  state.properties.forEach((x, i) => { state.openRequests[x.id] = openRequestCount(requestLists[i].requests, requestLists[i].groups); }); updateChrome();
  const requestData = requestLists[state.properties.indexOf(p)] || { requests: [], groups: [] };
  // Rent has its own banner and figures, so it is not also a row in the queue.
  const items = attentionItems({ escalations, decisions, messages, ...requestData, allocation }).filter((item) => item.kind !== "rent");
  const reasons = new Map(escalations.map((row) => [row.id, row.reason]));
  // The viewer's own clock, so it reads right wherever they are; past midnight
  // and before dawn is still the evening.
  const hour = new Date().getHours(), greeting = hour >= 5 && hour < 12 ? "Good morning" : hour >= 12 && hour < 18 ? "Good afternoon" : "Good evening";
  const threads = conversations(messages, new Set(decisions.map((d) => d.id))).slice(0, 3);
  const progress = allocation ? rentProgress(allocation) : null;
  const next = nextRentAction(allocation, progress);
  const people = residentsOf(p), renew = renewalSummary(p);
  const tiers = { t3: 0, t2: 0, t1: 0 }; items.forEach((item) => { tiers[tierOf(item)] += 1; });
  const worst = tiers.t3 ? "t3" : tiers.t2 ? "t2" : tiers.t1 ? "t1" : "ok";
  const others = state.properties.filter((x) => x.id !== p.id).map((x) => ({ property: x, open: openCount(x.id) || 0 })).filter((x) => x.open);

  // Rent's four steps as a house's four windows, lit as each one is finished.
  const ring = progress ? (() => {
    const at = Math.min(progress.at, 3), all = progress.at >= 4, pct = progress.required ? Math.round((progress.collected / progress.required) * 100) : 0;
    const spots = [[50, 74], [124, 74], [50, 106], [124, 106]];
    const panes = progress.steps.map((step, i) => `<g class="pane ${step.done ? "lit" : !all && i === at ? "next" : ""}"><rect x="${spots[i][0]}" y="${spots[i][1]}" width="26" height="22" rx="3"><title>${esc(RENT_STEPS[i])}${step.done ? " · done" : ""}</title></rect><path d="M${spots[i][0] + 13} ${spots[i][1]}v22M${spots[i][0]} ${spots[i][1] + 11}h26"/></g>`).join("");
    const label = (i) => i === 3 && progress.sentCount ? `Collect · ${pct}%` : RENT_STEPS[i];
    return `<div class="house-progress"><svg class="house" viewBox="0 0 200 150" width="178" height="134" role="img" aria-label="${progress.steps.filter((x) => x.done).length} of 4 rent steps done"><ellipse class="ground" cx="100" cy="141" rx="86" ry="6"/><rect class="chimney" x="134" y="20" width="16" height="34" rx="2"/><rect class="front" x="34" y="58" width="132" height="82" rx="3"/><path class="roof" d="M22 66 100 14l78 52z"/><path class="eave" d="M22 66h156"/><circle class="attic" cx="100" cy="46" r="8"/><path class="door" d="M88 140v-32a12 12 0 0 1 24 0v32z"/><circle class="knob" cx="107" cy="126" r="1.8"/>${panes}</svg>
      <div><p class="house-title">Rent steps · ${progress.steps.filter((x) => x.done).length} of 4 done</p><ol class="house-steps">${progress.steps.map((step, i) => `<li class="${step.done ? "done" : !all && i === at ? "cur" : ""}">${step.done ? icon("check") : `<span class="dot"></span>`}${esc(label(i))}</li>`).join("")}</ol></div></div>`;
  })() : "";
  const welcome = `<section class="welcome"><div><h2>${greeting}</h2><p class="welcome-line">${esc(next ? next.line : "No rent period is set up here yet.")} ${items.length ? `${items.length} ${items.length === 1 ? "thing needs" : "things need"} you.` : "Nothing else needs you."}</p>
    <div class="welcome-actions">${next ? `<button type="button" data-rent-step="${next.step}" class="money">${icon("hand-coins")}${esc(next.label)}</button>` : ""}${items.length ? `<a class="button ghost" href="#messages">${icon("message-circle")}Open messages</a>` : ""}</div></div>${ring}</section>`;

  const collected = progress?.sentCount ? progress.collected : 0;
  const stat = (href, ic, tone, label, num, sub, extra = "") => `<a class="card stat" href="${href}"><div class="stat-top"><span class="stat-label">${esc(label)}</span><span class="tile-ic ${tone}">${icon(ic)}</span></div><div class="stat-num">${num}</div>${extra}<div class="stat-sub">${sub}</div></a>`;
  const renewing = renew ? renew.READY + renew.IN_PROGRESS : 0;
  const stats = `<div class="stats">
    ${stat("#rent", "hand-coins", "ok", "Rent collected", allocation ? `${esc(money(collected / 100))} <small>of ${esc(allocation.total.requiredLabel)}</small>` : "—", allocation ? esc(allocation.period.label) : "No rent period", progress ? meter(progress) : "")}
    ${stat("#residents", "users", "", "Residents", String(people.length), `${p.rooms?.length || people.length} rooms`)}
    ${stat("#messages", "bell", worst, "Needs you", String(items.length), items.length ? [tiers.t3 && `${tiers.t3} urgent`, tiers.t2 && `${tiers.t2} repair${tiers.t2 === 1 ? "" : "s"}`, tiers.t1 && `${tiers.t1} question${tiers.t1 === 1 ? "" : "s"}`].filter(Boolean).join(" · ") : "All quiet")}
    ${stat("#leasing", "signature", "", "Renewing next year", renew ? `${renewing} <small>of ${renew.total}</small>` : "—", renew ? `${renew.UNDECIDED} undecided · ${renew.MOVING_OUT} moving out` : "No renewal records")}
  </div>`;

  const needs = `<section class="card"><div class="card-head"><h3 class="tone-${worst}">${icon("bell")}Needs you</h3>${items.length ? `<span class="count-pill">${items.length}</span>` : ""}</div>${items.length ? needsList(items, reasons) : `<p class="quiet-line">${icon("circle-check")}Nothing waiting on you.</p>`}</section>`;
  const texts = `<section class="card"><div class="card-head"><h3>${icon("message-circle")}Latest texts</h3><a class="card-link" href="#messages">All messages${icon("chevron-right")}</a></div>${threads.length ? `<ul class="mini-threads compact">${threads.map((t) => `<li><a href="#messages" data-mini-thread="${esc(t.personId)}"><span class="avatar" aria-hidden="true">${esc(initials(t.name))}</span><span class="mini-who"><strong>${esc(t.name)}</strong><small>${esc(t.lastInbound?.body || t.last.body)}</small></span><time datetime="${esc(t.last.created_at)}">${esc(ago(t.last.created_at))}</time></a></li>`).join("")}</ul>` : `<p class="quiet-line">No texts from residents yet.</p>`}</section>`;
  const rentByResident = allocation ? (() => {
    const lines = allocation.lines, n = lines.length;
    const paid = lines.filter((line) => line.invoice?.paidCents >= line.amountCents && line.amountCents > 0).length;
    const waiting = lines.filter((line) => line.invoice?.localState === "sent").length - paid;
    const shared = lines.filter((line) => line.amountCents != null).length;
    const rest = n - paid - Math.max(0, waiting), collectedCents = lines.reduce((sum, line) => sum + (line.invoice?.paidCents || 0), 0);
    const parts = [["Paid", paid, "var(--g1)"], ["Invoiced, waiting", Math.max(0, waiting), "var(--g2)"], [shared ? "Not invoiced" : "No share yet", rest, "var(--g3)"]];
    return `<section class="card rent-card"><div class="card-head"><h3 class="tone-ok">${icon("chart-donut")}Rent by resident</h3><a class="card-link" href="#rent">Open rent${icon("chevron-right")}</a></div>
      <div class="donut-row">${donut(parts.map(([, value, color]) => ({ value, color })), `${paid}/${n}`, "paid")}
      <div class="rent-card-side"><p class="rent-card-num"><strong>${esc(centsLabel(collectedCents))}</strong> of ${esc(allocation.total.requiredLabel)} collected</p>
      <ul class="legend">${parts.map(([label, value, color]) => `<li><i style="background:${color}"></i>${label}<b>${value}</b></li>`).join("")}</ul></div></div></section>`;
  })() : "";
  const lease = renew ? (() => {
    const record = (id) => (p.releasing_status || []).find((row) => row.current_person_id === id);
    const undecided = people.filter((r) => renewalState(record(r.id)).stage === "UNDECIDED").map((r) => first(r.name));
    const parts = [["READY", "Signed", "var(--g1)"], ["IN_PROGRESS", "Signing", "var(--g2)"], ["UNDECIDED", "Still deciding", "var(--brand-2)"], ["MOVING_OUT", "Moving out", "var(--brand-3)"]];
    return `<section class="card lease-card"><div class="card-head"><h3>${icon("key")}Next year's lease</h3><a class="card-link" href="#leasing">Open leasing${icon("chevron-right")}</a></div>
      <div class="lease-line"><strong>${renew.READY} of ${renew.total}</strong><span>signed for next year</span></div>
      <div class="seg" role="img" aria-label="${parts.map(([key, label]) => `${renew[key]} ${label.toLowerCase()}`).join(", ")}">${parts.map(([key, , color]) => renew[key] ? `<span style="flex:${renew[key]};background:${color}"></span>` : "").join("")}</div>
      <ul class="legend">${parts.map(([key, label, color]) => `<li${key === "UNDECIDED" && undecided.length ? ` title="${esc(undecided.join(", "))}"` : ""}><i style="background:${color}"></i>${label}<b>${renew[key]}</b></li>`).join("")}</ul></section>`;
  })() : "";
  const elsewhere = others.length ? `<section class="card"><div class="card-head"><h3>${icon("house")}Your other properties</h3></div>${others.map((x) => `<button class="other secondary" data-switch="${esc(x.property.id)}"><strong>${esc(x.property.display_name)}</strong><span>${x.open} need${x.open === 1 ? "s" : ""} you</span></button>`).join("")}</section>` : "";

  app.innerHTML = `${errorLine("pageError")}${welcome}${stats}<div class="dash"><div>${rentByResident}${texts}</div><div>${needs}${lease}${elsewhere}</div></div>`;
  wireAttention(items, { decisions, messages, requestData }, today);
  app.querySelector("[data-rent-step]")?.addEventListener("click", (event) => openRentActivity(p, { step: Number(event.currentTarget.dataset.rentStep) }));
  app.querySelectorAll("[data-mini-thread]").forEach((link) => link.onclick = (event) => { event.preventDefault(); state.openThread = link.dataset.miniThread; state.messageView = "all"; location.hash = "#messages"; });
  app.querySelectorAll("[data-switch]").forEach((button) => button.onclick = () => { selectProperty(button.dataset.switch); render(); });
}
// Where a person's attention goes first: red is safety, orange a repair, yellow a
// question only the landlord can answer.
const tierOf = (item) => item.kind === "urgent" ? (item.tier >= 3 ? "t3" : "t2") : item.kind === "failed" ? "t3" : "t1";
const NEED_ICON = { urgent: (item) => item.tier >= 3 ? "flame" : "wrench", decision: () => "question", failed: () => "triangle-alert", request: () => "clipboard" };
const NEED_KEY = { flame: "Emergency", wrench: "Repair", question: "Question", "triangle-alert": "Not delivered", clipboard: "Application" };
function needsList(items, reasons) {
  const headline = (item) => { const reason = item.kind === "urgent" && reasons.get(item.id); return reason ? reason.split("·")[0].trim().replace(/^./, (c) => c.toUpperCase()) : item.kind === "request" ? item.what : `“${item.what}”`; };
  const mark = (item) => NEED_ICON[item.kind](item), shown = [...new Set(items.map(mark))];
  return `<ul class="needs">${items.map((item) => `<li><span class="emblem ${tierOf(item)}" role="img" aria-label="${esc(NEED_KEY[mark(item)])}" title="${esc(NEED_KEY[mark(item)])}">${icon(mark(item))}</span><span class="need-text"><strong title="${esc(item.what)}">${esc(headline(item))}</strong><small>${esc(item.who)}${item.since ? ` · ${esc(ago(item.since))} ago` : ""}</small></span><button class="secondary small" data-attention="${esc(item.id)}" data-action="${item.action}">${ACTION_LABEL[item.action]}</button></li>`).join("")}</ul>
    <ul class="need-key" aria-hidden="true">${Object.keys(NEED_KEY).filter((name) => shown.includes(name)).map((name) => `<li class="${tierOf(items.find((item) => mark(item) === name))}">${icon(name)}${esc(NEED_KEY[name])}</li>`).join("")}</ul>`;
}
// The one thing to do next about rent, said as a button.
function nextRentAction(view, progress) {
  if (!view) return null;
  const v = view.version, month = String(view.period.label || "This month").split(" ")[0], n = view.lines.length;
  if (!v) return { step: 0, label: `Split ${month} rent`, line: `${month} rent isn't split yet.` };
  if (v.state === "draft") return { step: 0, label: "Finish the split", line: `${month}'s split is drafted, not sent.` };
  if (v.state === "proposed") { const confirmed = view.lines.filter((line) => line.confirmed || line.confirmedBySeed).length; return { step: 1, label: "Collect confirmations", line: `${confirmed} of ${n} residents have confirmed their share.` }; }
  if (progress.sentCount < n && view.provider.available) return { step: 2, label: "Send invoices", line: `${month}'s split is approved. ${progress.sentCount} of ${n} invoices sent.` };
  if (progress.tone !== "paid") return { step: 3, label: "Track payments", line: `${centsLabel(progress.collected)} of ${view.total.requiredLabel} collected.` };
  return { step: 3, label: "See who paid", line: `All ${month} rent is in.` };
}
const initials = (name) => String(name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const icon = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// Who produced the split, said only as far as the version itself proves it. A seeded
// example carries AI-shaped fields but is marked as a fixture, and is never called
// a model's work.
function splitSource(v) {
  if (!v) return null;
  if (!v.aiWeights) return { kind: "hand", label: "Set by hand" };
  if (!v.modelId || v.modelId === "fictional-demo-fixture") return { kind: "example", label: "Example split · not a model's output" };
  return { kind: "ai", label: "Suggested by AI from the room facts" };
}
// Where the month's rent stands, in one colour. Before anything is invoiced there is
// nothing to be late on, so it stays calm; once invoices are out it moves from red
// (nothing in) through yellow (some in) to green (all in), and only on money a
// provider read reports — never on what the household says.
function rentProgress(view) {
  const v = view.version, n = view.lines.length, sent = view.lines.filter((line) => line.invoice?.localState === "sent");
  const collected = view.lines.reduce((sum, line) => sum + (line.invoice?.paidCents || 0), 0);
  const required = view.total.requiredCents;
  const tone = !sent.length ? "calm" : collected >= required && required > 0 ? "paid" : collected > 0 ? "partial" : "unpaid";
  const confirmed = view.lines.filter((line) => line.confirmed || line.confirmedBySeed).length;
  const steps = [
    { label: "Split", done: Boolean(v) && view.total.balances, detail: !v ? "Not started" : view.total.balances ? (splitSource(v).kind === "ai" ? "Suggested by AI" : "Adds up") : `${view.total.differenceLabel} ${view.total.differenceCents < 0 ? "short" : "over"}` },
    { label: "Agree", done: v?.state === "agreed", detail: v?.state === "agreed" ? "Approved" : v?.state === "proposed" ? `${confirmed} of ${n} confirmed` : "Residents confirm" },
    { label: "Invoice", done: sent.length === n && n > 0, detail: view.provider.available ? `${sent.length} of ${n} sent` : "No provider here" },
    { label: "Collect", done: tone === "paid", detail: sent.length ? `${centsLabel(collected)} in` : "Nothing yet" },
  ];
  const at = steps.findIndex((step) => !step.done);
  return { tone, collected, required, steps, at: at === -1 ? steps.length : at, sentCount: sent.length };
}
function meter(progress) {
  const pct = progress.required > 0 ? Math.max(0, Math.min(100, Math.round((progress.collected / progress.required) * 100))) : 0;
  return `<div class="meter tone-${progress.tone}" role="img" aria-label="${pct}% of the rent collected"><span style="width:${pct}%"></span></div>`;
}

// ---------- Messages ----------
// An inbox: conversations on the left, the open one on the right. Whatever needs
// you rises to the top, tagged on the same ladder as everywhere else — red for
// safety or a text that never arrived, orange for a repair, yellow for a question
// only you can answer.
function threadFlags(thread, decisions, escalations) {
  const ids = new Set(thread.messages.map((m) => m.id));
  const open = escalations.filter((e) => e.status === "open" && ids.has(e.message_id));
  const tier = open.reduce((max, e) => Math.max(max, e.tier || 0), 0);
  const asks = decisions.filter((d) => ids.has(d.id));
  const failed = thread.messages.some((m) => deliveryLabel(m)?.kind === "blocked");
  const tone = tier >= 3 || failed ? "t3" : tier === 2 ? "t2" : asks.length ? "t1" : null;
  const tag = tier >= 3 ? ["flame", "Emergency"] : failed ? ["triangle-alert", "Not delivered"] : tier === 2 ? ["wrench", "Repair"] : asks.length ? ["question", "Question"] : null;
  return { tone, tag, open, asks, failed, rank: tier >= 3 || failed ? 3 : tier === 2 ? 2 : asks.length ? 1 : 0 };
}
const dayLabel = (s) => { const d = new Date(s), diff = Math.round((new Date(new Date().toDateString()) - new Date(d.toDateString())) / 864e5); return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(d); };
const clock = (s) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(s));

async function messages() {
  const p = current(); if (!p) { app.innerHTML = emptyState("No property selected", "Choose a property first.", "", ""); return; }
  const [rows, decisions, escalations] = await Promise.all([api(`messages?propertyId=${p.id}`), api(`needs-human?propertyId=${p.id}`), api(`escalations?propertyId=${p.id}`)]);
  if (state.summaries[p.id]) { state.summaries[p.id].needs_human = decisions.length; state.summaries[p.id].open_escalations = escalations.filter((x) => x.status === "open").length; updateChrome(); }
  const thread = (t) => ({ ...t, flags: threadFlags(t, decisions, escalations) });
  // Most serious first; within a level, conversations() already gives most recent first.
  const all = conversations(rows, new Set(decisions.map((d) => d.id))).map(thread).sort((a, b) => b.flags.rank - a.flags.rank);
  if (!all.some((t) => t.flags.rank) && state.messageView === "needs") state.messageView = "all";
  drawInbox({ p, decisions, escalations, all, thread, found: null, query: "" });
}

function drawInbox(ctx) {
  const { p, all } = ctx, view = state.messageView;
  const needing = all.filter((t) => t.flags.rank);
  const shown = ctx.found || (view === "needs" ? needing : all);
  // On a wide screen the first conversation opens by itself, so the right side is
  // never empty; on a phone the list comes first and a tap opens one.
  if (!state.openThread && shown.length && window.innerWidth > 980) state.openThread = shown[0].personId;
  const active = all.find((t) => t.personId === state.openThread) || null;
  const row = (t) => `<li><button type="button" class="convo${t.flags.tone ? ` flag-${t.flags.tone}` : ""}${active?.personId === t.personId ? " on" : ""}" data-thread="${esc(t.personId)}"${active?.personId === t.personId ? ' aria-current="true"' : ""}>
    <span class="avatar" aria-hidden="true">${esc(initials(t.name))}</span>
    <span class="convo-main"><span class="convo-top"><strong>${esc(t.name)}</strong><time datetime="${esc(t.last.created_at)}">${esc(ago(t.last.created_at))}</time></span>
    <span class="convo-last">${esc(t.lastInbound?.body || t.last.body)}</span>
    ${t.flags.tag ? `<span class="chip ${t.flags.tone}">${icon(t.flags.tag[0])}${esc(t.flags.tag[1])}</span>` : `<span class="convo-room">${esc(roomOf(p, t.roomId)?.label || (t.role === "guarantor" ? "Guarantor" : ""))}</span>`}</span></button></li>`;
  const emptyList = ctx.found ? `<p class="inbox-empty">No texts match “${esc(ctx.query)}”.</p>` : view === "needs" ? `<p class="inbox-empty">${icon("circle-check")}Nothing needs you.</p>` : `<p class="inbox-empty">${p.phone_numbers?.some((n) => n.active) ? "Conversations appear here when residents text the property number." : "This property has no texting number connected yet."}</p>`;

  app.innerHTML = `${errorLine("pageError")}<div class="inbox${active ? " reading" : ""}">
    <section class="inbox-list" aria-label="Conversations">
      <div class="inbox-tools"><div class="segmented" role="tablist" aria-label="Messages view"><button type="button" role="tab" aria-selected="${view === "needs" && !ctx.found}" data-view="needs">Needs you${needing.length ? ` <span class="count">${needing.length}</span>` : ""}</button><button type="button" role="tab" aria-selected="${view === "all" && !ctx.found}" data-view="all">All <span class="count muted">${all.length}</span></button></div><button type="button" id="newMessage" class="small">${icon("plus")}New text</button></div>
      <form class="inbox-search" role="search">${icon("search")}<input id="search" type="search" placeholder="Search texts" aria-label="Search texts" value="${esc(ctx.query)}"></form>
      ${shown.length ? `<ul class="convos">${shown.map(row).join("")}</ul>` : emptyList}
    </section>
    <section class="inbox-pane" aria-label="Conversation">${active ? convoPane(active, ctx) : `<div class="pane-empty"><span class="tile-ic">${icon("message-circle")}</span><h3>Pick a conversation</h3><p>Texts from residents show up on the left.</p></div>`}</section>
  </div>`;

  const redraw = () => drawInbox(ctx);
  app.querySelectorAll("[data-view]").forEach((b) => b.onclick = () => { state.messageView = b.dataset.view; ctx.found = null; ctx.query = ""; state.openThread = null; redraw(); });
  app.querySelectorAll("[data-thread]").forEach((b) => b.onclick = () => { state.openThread = b.dataset.thread; redraw(); app.querySelector(".transcript-scroll")?.focus({ preventScroll: true }); });
  app.querySelector("[data-back]")?.addEventListener("click", () => { state.openThread = null; redraw(); });
  app.querySelector(".inbox-search").onsubmit = async (event) => {
    event.preventDefault();
    const q = document.querySelector("#search").value.trim();
    if (!q) { ctx.found = null; ctx.query = ""; return redraw(); }
    try { const found = await api(`messages?propertyId=${p.id}&q=${encodeURIComponent(q)}`); ctx.found = conversations(found, new Set(ctx.decisions.map((d) => d.id))).map(ctx.thread); ctx.query = q; redraw(); }
    catch (error) { showError("pageError", error); }
  };
  document.querySelector("#newMessage").onclick = () => newText(p);
  if (active) wireConvo(active, ctx);
}

function convoPane(thread, { p }) {
  const person = p.people.find((x) => x.id === thread.personId) || { name: thread.name };
  const consent = consentLabel(person);
  const alerts = [
    ...thread.flags.open.map((e) => `<div class="alert ${e.tier >= 3 ? "t3" : "t2"}"><span class="emblem ${e.tier >= 3 ? "t3" : "t2"}">${icon(e.tier >= 3 ? "flame" : "wrench")}</span><span class="alert-text"><strong>${esc(urgencyLabel(e.tier))}</strong><small>${esc(String(e.reason || "").replace(/^./, (c) => c.toUpperCase()))} · flagged from the wording of the text</small></span><button type="button" class="secondary small" data-resolve="${esc(e.id)}">Mark handled</button></div>`),
    ...thread.flags.asks.map((d) => `<div class="alert t1"><span class="emblem t1">${icon("question")}</span><span class="alert-text"><strong>Only you can answer this</strong><small>${d.acknowledgement ? "Hearth told them it's with you" : "No reply on record yet"}</small></span><button type="button" class="small" data-answer="${esc(d.id)}">Answer</button></div>`),
  ].join("");
  let day = "";
  const lines = thread.messages.map((m) => {
    const label = dayLabel(m.created_at), sep = label !== day ? `<li class="day"><span>${esc(label)}</span></li>` : ""; day = label;
    const d = deliveryLabel(m);
    return `${sep}<li class="bubble ${m.direction}"><p>${esc(m.body)}</p><span class="bubble-meta">${m.direction === "inbound" ? esc(first(thread.name)) : "Hearth"} · ${esc(clock(m.created_at))}${d ? ` · ${esc(d.label)}` : ""}</span></li>`;
  }).join("");
  return `<header class="convo-head"><button type="button" class="quiet back" data-back aria-label="Back to conversations">${icon("arrow-left")}</button><span class="avatar lg" aria-hidden="true">${esc(initials(thread.name))}</span><div class="convo-who"><h2>${esc(thread.name)}</h2><p>${esc(roomOf(p, person.room_id)?.label || (thread.role === "guarantor" ? "Guarantor" : "No room"))}${person.phone ? ` · ${esc(person.phone)}` : ""}</p></div>${status(consent.kind, consent.label)}</header>
    ${alerts ? `<div class="alerts">${alerts}</div>` : ""}
    <div class="transcript-scroll" tabindex="-1"><ol class="bubbles">${lines}</ol></div>
    ${errorLine("threadError")}${composer({ person })}`;
}

function wireConvo(thread, ctx) {
  const scroller = app.querySelector(".transcript-scroll"); if (scroller) scroller.scrollTop = scroller.scrollHeight;
  const asks = new Map(ctx.decisions.map((d) => [d.id, d]));
  app.querySelectorAll("[data-resolve]").forEach((b) => b.onclick = async () => {
    // Two steps: handling it moves it out of the queue (it stays in the record).
    if (!b.dataset.confirming) { b.dataset.confirming = "1"; b.textContent = "Confirm — moves it to History"; setTimeout(() => { if (b.isConnected && b.dataset.confirming) { delete b.dataset.confirming; b.textContent = "Mark handled"; } }, 5000); return; }
    b.disabled = true;
    try { await api("resolve-escalation", { method: "POST", body: JSON.stringify({ id: b.dataset.resolve }) }); toast("Marked handled · kept in the record"); await loadProperties(); await messages(); }
    catch (error) { b.disabled = false; showError("threadError", error); }
  });
  app.querySelectorAll("[data-answer]").forEach((b) => b.onclick = () => answerDecision(asks.get(b.dataset.answer), messages));
  const send = app.querySelector("#composeSend");
  if (send) send.onclick = () => sendText({ personId: thread.personId, conversationId: thread.conversationId || undefined, reason: "Operator reply from conversation" }, async () => { await messages(); });
}
async function newText(p) {
  const recipients = await api(`recipients?propertyId=${p.id}`);
  openSheet("New text", recipients.length ? `<label for="recipient">To</label><select id="recipient">${recipients.map((x) => `<option value="${esc(x.id)}" data-conversation="${esc(x.conversation_id || "")}">${esc(x.name)} · ${esc(x.role === "student" ? roomOf(p, p.people.find((y) => y.id === x.id)?.room_id)?.label || "Resident" : x.role)}</option>`).join("")}</select><label for="reason">Why (kept in the record)</label><input id="reason" placeholder="e.g. Water shut-off notice">${composer({ person: recipients[0] })}` : calm("Nobody to text yet", "People appear here once they’ve opted in to texts. Opted-out people are never listed."));
  const send = document.querySelector("#composeSend"); if (!send) return;
  document.querySelector("#composeBody").previousElementSibling.textContent = "Exact text";
  send.onclick = () => { const option = document.querySelector("#recipient").selectedOptions[0], reason = document.querySelector("#reason").value.trim(); if (!reason) return showError("composeError", new Error("Say why this text is needed; it’s kept in the record.")); sendText({ personId: option.value, conversationId: option.dataset.conversation || undefined, reason }, async () => { sheet.close(); if (location.hash === "#messages") await messages(); }); };
}

// ---------- Residents ----------
async function residents() {
  const p = current(); if (!p) { app.innerHTML = emptyState("No property selected", "Choose a property first.", "", ""); return; }
  const list = residentsOf(p).slice().sort((a, b) => String(roomOf(p, a.room_id)?.label || "~").localeCompare(String(roomOf(p, b.room_id)?.label || "~"), undefined, { numeric: true }));
  if (!list.length) { app.innerHTML = leasingTabs("residents") + calm(`No residents yet at ${p.display_name}`, "Residents appear once they’re added to this lease."); return; }
  const record = (id) => (p.releasing_status || []).find((row) => row.current_person_id === id);

  // Each row carries the two things a landlord most often wants from a resident —
  // what they owe this period, and a text — so the common cases do not require
  // opening the person first. Opening them still shows everything.
  const allocation = await loadWorkspace(p.id).catch((error) => absentOnly(error, null));
  const shareOf = new Map((allocation?.lines || []).map((line) => [line.personId, line]));

  app.innerHTML = `${leasingTabs("residents")}${errorLine("pageError")}<ul class="residents">${list.map((r) => {
    const c = consentLabel(r), g = guarantorsOf(p, r.id), rs = renewalState(record(r.id));
    const line = shareOf.get(r.id);
    // Three distinct states, never collapsed into one another: no rent period at
    // all (property has nothing to divide), a period with no split decided yet
    // (line exists, amountCents is null), and an actual agreed share.
    const rentChip = !line
      ? `<span class="resident-chip muted">No rent period</span>`
      : line.amountCents == null
      ? `<span class="resident-chip muted">No split yet</span>`
      : `<span class="resident-chip" title="${esc(line.invoice ? `Invoice ${line.invoice.providerInvoiceId || ""} · ${line.invoice.paymentStateLabel || line.invoice.localState}` : "No invoice for this period")}">
           <strong>${esc(line.amountLabel)}</strong>${line.invoice ? invoiceStatusChip(line.invoice) : status("pending", "Not invoiced")}</span>`;
    const blocked = c.kind === "blocked";
    return `<li><div class="resident">
      <button type="button" class="resident-open" data-resident="${esc(r.id)}" aria-label="Open ${esc(r.name)}"><span class="resident-name"><strong>${esc(r.name)}</strong><small>${esc(roomOf(p, r.room_id)?.label || "No room")} · ${esc(r.phone)}${g.length ? ` · guarantor ${esc(g.map((x) => first(x.name)).join(", "))}` : ""}</small></span></button>
      <span class="resident-mid">${rentChip}<small class="muted">${esc(rs.label)}</small></span>
      <span class="resident-actions">${status(c.kind, c.label)}
        <button type="button" class="row-action" data-rent="${esc(r.id)}" aria-label="Open this period's rent for ${esc(r.name)}">Rent</button>
        <button type="button" class="row-action" data-text="${esc(r.id)}" aria-label="Text ${esc(r.name)}"${blocked ? ' disabled aria-disabled="true" title="This resident opted out of texts"' : ""}>Text</button>
      </span></div></li>`;
  }).join("")}</ul>
  <p class="muted note">Rent shown is this period's agreed share and, separately, whatever the payment provider last said about it.</p>`;

  // Three separate buttons per row, each with one meaning: open the person, open
  // their rent, text them. None is nested inside another, so keyboard and screen
  // reader users get the same three controls a mouse user does.
  app.querySelectorAll("[data-resident]").forEach((b) => b.onclick = () => openResident(p, b.dataset.resident));
  const rowAction = (selector, run) => app.querySelectorAll(selector).forEach((el) => { el.onclick = () => { if (!el.disabled) run(el); }; });
  rowAction("[data-rent]", () => openRentActivity(p).catch((error) => showError("pageError", error)));
  rowAction("[data-text]", (el) => { openResident(p, el.dataset.text); setTimeout(() => document.querySelector("#textResident")?.click(), 0); });
}

// One dated record line per text, call, photo or recorded change (Property → History and the resident sheet).
const historyKind = (x) => x.type === "message" ? (x.direction === "inbound" ? "Text received" : `Text to resident · ${deliveryLabel(x).label}`) : x.type === "call" ? "Call logged" : x.type === "evidence" ? "Photos received" : x.metadata?.summary ? (x.actor && !["operator", "seed", "system"].includes(x.actor) ? `Recorded by ${x.actor}` : "Recorded by you") : "Change made";
const historyList = (rows, withNames) => `<ol class="history">${rows.map((x) => `<li><p class="line-meta">${esc(historyKind(x))} · ${esc(date(x.at))}${withNames && x.people?.name ? ` · ${esc(x.people.name)}` : ""}</p><p>${esc(x.body || x.summary || x.notes || x.metadata?.summary || String(x.action || "").replaceAll("_", " "))}</p></li>`).join("")}</ol>`;
async function openResident(p, id) {
  const r = p.people.find((x) => x.id === id), room = roomOf(p, r.room_id), rec = (p.releasing_status || []).find((row) => row.current_person_id === id), rs = renewalState(rec), g = guarantorsOf(p, id), lease = activeLease(p);
  const body = openSheet(r.name, `<p class="sheet-meta">${esc(room?.label || "No room")} · ${esc(r.phone)} · ${status(consentLabel(r).kind, consentLabel(r).label)}</p><dl class="facts"><dt>Lease</dt><dd>${lease ? `${esc(lease.academic_year)} · ${esc(dateOnly(lease.term_start))} – ${esc(dateOnly(lease.term_end))}` : "No lease term set"}</dd>${room?.rent_share != null ? `<dt>Rent share</dt><dd>${esc(money(room.rent_share))} <small class="muted">as entered on the lease</small></dd>` : ""}<dt>Next year</dt><dd>${esc(rs.label)}${rs.missing.length ? ` <small class="muted">· still needed: ${esc(rs.missing.join(", "))}</small>` : ""}</dd>${g.length || rec?.guarantor_confirmed ? `<dt>Guarantor</dt><dd>${g.length ? g.map((x) => `${esc(x.name)} · ${esc(x.phone)}`).join("<br>") : "Confirmed (no contact on file)"}</dd>` : ""}</dl><div class="sheet-actions"><button id="textResident">Text ${esc(first(r.name))}</button><button class="secondary" id="logCall">Log a call</button></div><div id="residentAction"></div><h3>Record with ${esc(first(r.name))}</h3><p class="muted note">Texts, calls and photos for ${esc(first(r.name))}, newest first. Kept in Hearth only.</p><div id="residentTexts"><p class="loading">Loading…</p></div><h3>Photos on file</h3><div id="residentEvidence"><p class="loading">Loading…</p></div>`);
  body.querySelector("#textResident").onclick = () => { body.querySelector("#residentAction").innerHTML = composer({ person: r }); const send = body.querySelector("#composeSend"); if (send) send.onclick = () => sendText({ personId: r.id, reason: "Operator text from resident record" }, async () => { body.querySelector("#residentAction").innerHTML = ""; await openResident(p, id); }); };
  body.querySelector("#logCall").onclick = () => { body.querySelector("#residentAction").innerHTML = `<div class="composer">${errorLine("callError")}<label for="callSummary">What happened on the call?</label><textarea id="callSummary"></textarea><div class="composer-foot"><span class="muted">Saved to ${esc(p.display_name)}’s record.</span><button id="saveCall">Save call</button></div></div>`; body.querySelector("#saveCall").onclick = async () => { const summary = body.querySelector("#callSummary").value.trim(); if (!summary) return showError("callError", new Error("Write a short summary first.")); try { await api("call-log", { method: "POST", body: JSON.stringify({ personId: r.id, summary }) }); toast("Call saved to the record"); body.querySelector("#residentAction").innerHTML = ""; await openResident(p, id); } catch (error) { showError("callError", error); } }; };
  try {
    const [trail, evidence] = await Promise.all([api(`timeline?propertyId=${p.id}&personId=${encodeURIComponent(id)}`), api(`evidence?propertyId=${p.id}`)]);
    if (!sheet.open) return;
    const texts = trail.filter((x) => x.type === "message").length;
    body.querySelector("#residentTexts").innerHTML = trail.length ? `${historyList(trail.slice(0, 8), false)}${trail.length > 8 ? `<p class="muted">${trail.length - 8} older ${trail.length - 8 === 1 ? "entry" : "entries"} in Property → History.</p>` : ""}${texts ? `<p><a href="#messages" data-thread-link>Open the text thread (${texts})</a></p>` : ""}` : `<p class="muted">Nothing recorded with ${esc(first(r.name))} yet. Log a call or send a text and it appears here.</p>`;
    const mine = evidence.filter((x) => x.person_id === id);
    body.querySelector("#residentEvidence").innerHTML = mine.length ? `<ul class="plain">${mine.map((x) => `<li>${esc(x.kind)} · ${esc(date(x.captured_at))} · ${x.signed_url ? `<a href="${esc(x.signed_url)}" target="_blank" rel="noreferrer">View (link expires in 5 min)</a>` : "media unavailable"}</li>`).join("")}</ul>` : '<p class="muted">No photos from this resident yet.</p>';
    const link = body.querySelector("[data-thread-link]"); if (link) link.onclick = () => { state.openThread = id; state.messageView = "all"; sheet.close(); state.openThread = id; };
  } catch (error) { body.querySelector("#residentTexts").innerHTML = `<p class="error-banner">${esc(error.message)}</p>`; }
}

// ---------- Leasing ----------
// Next year's lease on the Renewals page, one colour per stage: greens for signed
// and signing, honey for a decision still owed, slate for someone leaving.
const RENEWAL_TONE = { READY: "g1", IN_PROGRESS: "g2", UNDECIDED: "t1", MOVING_OUT: "slate", "NO RECORD": "none" };
async function leasing() {
  const p = current(); if (!p) { app.innerHTML = emptyState("No property selected", "Choose a property first.", "", ""); return; }
  const lease = activeLease(p), list = residentsOf(p), renew = renewalSummary(p);
  const rows = list.map((r) => ({ r, rec: (p.releasing_status || []).find((x) => x.current_person_id === r.id) })).map((x) => ({ ...x, st: renewalState(x.rec) }));
  const requestData = await loadRequests(p.id), requests = requestData.requests;
  // The most settled first, the same order as Today's lease card.
  const groups = [["READY", "Signed", "seal-check"], ["IN_PROGRESS", "Signing", "signature"], ["UNDECIDED", "Still deciding", "question"], ["MOVING_OUT", "Moving out", "door"], ["NO RECORD", "No renewal record", "info"]];
  // The four counts sit in the same order, and the same colours, as the cards below.
  const tally = renew ? `<div class="stats">${groups.slice(0, 4).map(([key, label, ic]) => `<div class="card stat"><div class="stat-top"><span class="stat-label">${label}</span><span class="tile-ic ${RENEWAL_TONE[key]}">${icon(ic)}</span></div><div class="stat-num">${renew[key]} <small>of ${renew.total}</small></div><div class="meter stage" role="img" aria-label="${renew[key]} of ${renew.total}"><span style="width:${renew.total ? Math.round((renew[key] / renew.total) * 100) : 0}%;background:var(--${RENEWAL_TONE[key]})"></span></div></div>`).join("")}</div>` : "";
  const term = `<section class="card lease-term"><span class="tile-ic">${icon("calendar-check")}</span><div><h3>${esc(lease?.academic_year || "No lease term set")}</h3><p>${lease ? `${esc(dateOnly(lease.term_start))} – ${esc(dateOnly(lease.term_end))}` : "Add a lease term to see move-in and move-out dates."}</p></div><span class="hint">Signatures are tracked by hand here. Hearth doesn’t send leases for e-signature.</span></section>`;
  const fileRow = (name, sub, chip, attr) => `<div class="person-row"><span class="avatar" aria-hidden="true">${esc(initials(name))}</span><span class="person-text"><strong>${esc(name)}</strong><small>${sub}</small></span>${chip}<button type="button" class="secondary small" ${attr}>Open</button></div>`;
  const applicants = [
    ...requestData.groups.map((g) => { const gs = groupState(g, requests.filter((r) => r.group_id === g.id)); return fileRow(g.label, esc(gs.why || ""), status(gs.stage === "DECIDED" ? (g.decision === "approve" ? "complete" : g.decision === "hold" ? "pending" : "blocked") : gs.stage === "READY" ? "needs-decision" : "overdue", gs.label), `data-group="${esc(g.id)}"`); }),
    ...requests.filter((r) => !r.group_id).map((r) => { const st = requestState(r); return fileRow(r.subject_name, `${esc(r.request_templates?.title || "Request")}${r.rooms?.label ? ` · ${esc(r.rooms.label)}` : ""}`, status(st.stage === "DECIDED" ? (r.decision === "approve" ? "complete" : r.decision === "hold" ? "pending" : "blocked") : st.needsYou ? (st.stage === "READY" ? "needs-decision" : "overdue") : "pending", st.label), `data-request="${esc(r.id)}"`); }),
  ];
  // Every stage card has the same shape — header, then one row per resident with
  // the same three columns — and its status pills carry the stage's own colour.
  const sections = groups.map(([stage, heading, ic]) => {
    const g = rows.filter((x) => x.st.stage === stage), tone = RENEWAL_TONE[stage]; if (!g.length && stage === "NO RECORD") return "";
    return `<section class="card stage-card"><div class="card-head"><h3><span class="tile-ic ${tone}">${icon(ic)}</span>${esc(heading)}</h3><span class="count-pill">${g.length}</span></div>${g.length ? `<div class="person-list">${g.map(({ r, rec, st }) => {
      const room = roomOf(p, r.room_id)?.label || "No room", next = rec?.next_room_id && rec.renewal === "renewing" ? (rec.next_room_id === r.room_id ? " · same room" : ` → ${esc(roomOf(p, rec.next_room_id)?.label || "")}`) : "";
      const label = st.missing.length ? `Needs ${st.missing.join(", ")}` : stage === "READY" ? "All set" : stage === "MOVING_OUT" ? "Not renewing" : st.label;
      return `<div class="person-row"><span class="avatar" aria-hidden="true">${esc(initials(r.name))}</span><span class="person-text"><strong>${esc(r.name)}</strong><small>${esc(room)}${next}</small></span><span class="chip ${tone}">${stage === "READY" ? icon("check") : ""}${esc(label)}</span>${rec ? `<button type="button" class="secondary small" data-edit="${esc(rec.id)}">Update</button>` : ""}</div>`;
    }).join("")}</div>` : `<p class="quiet-line">Nobody here.</p>`}</section>`;
  }).join("");
  app.innerHTML = `${leasingTabs("leasing")}${errorLine("pageError")}${tally}${term}<div class="lease-groups">${rows.length ? sections : calm("No residents on this lease yet")}${applicants.length ? `<section class="card"><div class="card-head"><h3><span class="tile-ic">${icon("clipboard")}</span>Applicants</h3><span class="count-pill">${applicants.length}</span></div><div class="person-list">${applicants.join("")}</div></section>` : ""}</div>`;
  // Past three people a stage scrolls inside its card, with a fade while more is below.
  app.querySelectorAll(".stage-card .person-list").forEach((list) => { const fade = () => list.classList.toggle("more", list.scrollTop + list.clientHeight < list.scrollHeight - 2); fade(); list.addEventListener("scroll", fade, { passive: true }); });
  app.querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => editRenewal(p, (p.releasing_status || []).find((x) => x.id === b.dataset.edit)));
  app.querySelectorAll("[data-request]").forEach((b) => b.onclick = () => openRequest(requests.find((r) => r.id === b.dataset.request), leasing));
  app.querySelectorAll("[data-group]").forEach((b) => b.onclick = () => openGroup(requestData.groups.find((g) => g.id === b.dataset.group), requestData, leasing));
}
function editRenewal(p, rec) {
  const person = p.people.find((x) => x.id === rec.current_person_id);
  const sel = (key, options, labels) => `<select data-key="${key}">${options.map((o, i) => `<option value="${o}" ${rec[key] === o ? "selected" : ""}>${labels[i]}</option>`).join("")}</select>`;
  const check = (key, label) => `<label class="check"><input type="checkbox" data-key="${key}" ${rec[key] ? "checked" : ""}> ${label}</label>`;
  const body = openSheet(`${person?.name || "Resident"} · next year`, `${errorLine("renewError")}<div class="form-grid"><label>Decision ${sel("renewal", ["undecided", "renewing", "leaving"], ["Hasn’t decided", "Renewing", "Moving out"])}</label><label>Lease ${sel("signature_status", ["not_sent", "sent", "signed"], ["Not sent", "Sent", "Signed"])}</label><label>Next room <select data-key="next_room_id"><option value="">Not chosen</option>${p.rooms.map((room) => `<option value="${room.id}" ${room.id === rec.next_room_id ? "selected" : ""}>${esc(room.label)}</option>`).join("")}</select></label>${check("guarantor_confirmed", "Guarantor confirmed")}${check("rent_share_agreed", "Rent share agreed")}${check("reminder_acknowledged_at", "Resident acknowledged the renewal reminder")}</div><p class="muted">Changes save as you make them.</p>`);
  body.querySelectorAll("[data-key]").forEach((el) => el.onchange = async () => {
    try { const val = el.type === "checkbox" ? (el.dataset.key.endsWith("_at") ? (el.checked ? new Date().toISOString() : null) : el.checked) : el.value || null; const saved = await api("releasing", { method: "POST", body: JSON.stringify({ id: rec.id, changes: { [el.dataset.key]: val } }) }); Object.assign(rec, saved); await loadProperties(); await leasing(); toast("Saved"); }
    catch (error) { showError("renewError", error); }
  });
}

// ---------- Turnover ----------
const TURNOVER_REMINDERS={
  requirements:{why:"Move-in requirements incomplete (guarantor information and move-in form)",message:(first,property)=>`Hi ${first}, please finish the guarantor details and move-in form for ${property}. Reply here if you need help.`},
  arrival:{why:"No arrival window on file — needed to stagger move-in day",message:(first,property)=>`Hi ${first}, what arrival window works for move-in at ${property}? Reply with a date and time.`},
  conditionIn:{why:"Move-in condition photos not yet submitted",message:(first,property)=>`Hi ${first}, please text clear photos of your room at ${property} before moving in so its starting condition is recorded.`},
  keysIn:{why:"Keys not yet issued",message:(first,property)=>`Hi ${first}, your keys for ${property} are ready. Please pick them up before move-in.`},
  conditionOut:{why:"Move-out condition photos not yet submitted",message:(first,property)=>`Hi ${first}, please text clear photos of your room at ${property} after clearing it and before returning keys.`},
  keysOut:{why:"Keys have not been returned",message:(first,property)=>`Hi ${first}, please return every key for ${property} by move-out. Reply here to coordinate.`},
};
async function turnover() {
  const data = await api(`turnover?propertyId=${state.propertyId}`), p = current();
  const phase = state.turnoverPhase || defaultTurnoverPhase(p), moveIn = phase === "movein", lease = data.property.lease_groups.find((g) => g.id === data.property.active_lease_group_id) || data.property.lease_groups[0];
  const students = data.students.map((s) => ({ s, st: turnoverState(s, phase) })).sort((a, b) => (a.st.stage === "COMPLETE") - (b.st.stage === "COMPLETE") || a.s.name.localeCompare(b.s.name));
  const sum = turnoverSummary(data.students, phase), keys = (s) => s.tasks.key_status?.value_text || "not issued", done = (t) => t?.status === "complete";
  const row = (student, label, taskKey, control, reminder, complete) => `<div class="task-row ${complete ? "complete" : ""}"><span class="task-label">${complete ? "✓ " : ""}${label}</span><span class="task-control">${control}</span>${complete ? "<span></span>" : `<button class="secondary remind small" data-remind="${reminder}" data-person="${student.id}">Remind</button>`}</div>`;
  // A photo set arrives as a file. This demo records the file's name as the proof of
  // receipt; it does not keep the file itself.
  const upload = (student, key, received, label) => received
    ? `<span class="upload done">${icon("paperclip")}<span>${esc(student.tasks[key]?.value_text || "Received")}</span><button type="button" class="quiet" data-unupload="${key}" aria-label="Remove ${esc(label.toLowerCase())}">${icon("x")}</button></span>`
    : `<label class="upload">${icon("upload")}<span>Upload photos or PDF</span><input type="file" accept="image/*,application/pdf" data-upload="${key}" aria-label="${esc(label)}"></label>`;
  const keySelect = (k) => `<select data-task="key_status" aria-label="Key status">${["not issued", "issued", "returned"].map((v) => `<option ${k === v ? "selected" : ""}>${v}</option>`).join("")}</select>`;
  app.innerHTML = `${leasingTabs("turnover")}<div id="turnoverError" class="turnover-error" role="alert"></div><section class="card turnover-head"><span class="tile-ic">${icon("door")}</span><div class="turnover-sum"><h3>${moveIn ? "Move-in" : "Move-out"} · ${esc(dateOnly(moveIn ? lease?.term_start : lease?.term_end))}</h3><p>${sum.total ? (sum.open ? `${sum.total - sum.open} of ${sum.total} residents finished` : `All ${sum.total} residents finished`) : "No residents on this lease"}</p>${sum.total ? `<div class="meter progress" role="img" aria-label="${sum.total - sum.open} of ${sum.total} finished"><span style="width:${Math.round(((sum.total - sum.open) / sum.total) * 100)}%"></span></div>` : ""}</div><div class="segmented" role="tablist" aria-label="Turnover phase"><button role="tab" data-phase="moveout" aria-selected="${!moveIn}">Move-out</button><button role="tab" data-phase="movein" aria-selected="${moveIn}">Move-in</button></div></section><p class="turnover-hint">${moveIn ? "On move-in day each resident sends photos of their room. Upload them here and Hearth files them by person and date." : "Each resident sends photos after clearing out. Upload them here; with both sets on file, compare start and end side by side."}</p><div class="turnover-list">${students.map(({ s: student, st }) => { const req = done(student.tasks.requirements_complete), arrival = done(student.tasks.arrival_window), cin = done(student.tasks["move-in_condition_evidence"]), cout = done(student.tasks["move-out_condition_evidence"]), k = keys(student), compare = student.evidence.moveIn.length && student.evidence.moveOut.length; return `<section class="turnover-student" data-student="${student.id}"><div class="student-head"><span class="avatar" aria-hidden="true">${esc(initials(student.name))}</span><div><div class="student-name">${esc(student.name)}</div><div class="student-room">${esc(student.room?.label || "No room assigned")}</div></div>${status(st.stage === "COMPLETE" ? "complete" : st.stage === "NOT_STARTED" ? "pending" : "overdue", st.label)}${compare ? `<button class="secondary small" data-compare="${student.id}">Compare photos</button>` : ""}</div><div class="task-grid">${moveIn ? [
    row(student, "Move-in paperwork", "requirements_complete", `<input type="checkbox" data-task="requirements_complete" aria-label="Move-in paperwork complete" ${req ? "checked" : ""}>`, "requirements", req),
    row(student, "Arrival time", "arrival_window", `<input data-task="arrival_window" aria-label="Arrival time" value="${esc(student.tasks.arrival_window?.value_text || "")}" placeholder="e.g. Move-in day, 10am–12pm">`, "arrival", arrival),
    row(student, "Move-in photos", "move-in_condition_evidence", upload(student, "move-in_condition_evidence", cin, "Move-in photos"), "conditionIn", cin),
    row(student, "Keys", "key_status", keySelect(k), "keysIn", ["issued", "returned"].includes(k)),
  ].join("") : [
    row(student, "Move-out photos", "move-out_condition_evidence", upload(student, "move-out_condition_evidence", cout, "Move-out photos"), "conditionOut", cout),
    row(student, "Keys", "key_status", keySelect(k), "keysOut", k === "returned"),
  ].join("")}</div></section>`; }).join("") || calm("No residents on this lease yet", "Turnover tasks appear once residents are added.")}</div><dialog id="turnoverReminder" class="turnover-modal"><form method="dialog"><p class="eyebrow">Text for your approval</p><dl><dt>To</dt><dd id="reminderTo"></dd><dt>Why</dt><dd id="reminderWhy"></dd><dt>Texts</dt><dd id="reminderConsent"></dd></dl><div class="sms-copy" id="reminderCopy"></div><div class="modal-actions"><button type="button" id="approveReminder">Approve &amp; send</button><button class="secondary" value="cancel">Cancel</button></div><p class="muted">Hearth drafts it; nothing goes out until you approve.</p></form></dialog><dialog id="conditionCompare" class="turnover-modal"><form method="dialog"><p class="eyebrow">Move-in vs. move-out</p><h2 id="compareName"></h2><div class="compare-grid"><div class="compare-panel"><strong>Move-in</strong><div id="compareIn"></div></div><div class="compare-panel"><strong>Move-out</strong><div id="compareOut"></div></div></div><p><button class="secondary">Close</button></p></form></dialog>`;
  app.querySelectorAll("[data-phase]").forEach((button) => button.onclick = () => { state.turnoverPhase = button.dataset.phase; turnover().catch(showTurnoverError); });
  app.querySelectorAll("[data-task]").forEach((control) => { const save = async () => { const taskKey = control.dataset.task, studentId = control.closest("[data-student]").dataset.student; const valueText = control.type === "checkbox" ? null : control.value.trim(), st = control.type === "checkbox" ? (control.checked ? "complete" : "pending") : (taskKey === "key_status" ? (valueText === "not issued" ? "pending" : "complete") : (valueText ? "complete" : "pending")); try { await api("workflow-task", { method: "POST", body: JSON.stringify({ propertyId: state.propertyId, personId: studentId, taskKey, status: st, valueText }) }); await turnover(); toast("Saved"); } catch (error) { showTurnoverError(error); } }; control.onchange = save; if (control.dataset.task === "arrival_window") control.onblur = save; });
  const record = async (control, taskKey, st, valueText, note) => { try { await api("workflow-task", { method: "POST", body: JSON.stringify({ propertyId: state.propertyId, personId: control.closest("[data-student]").dataset.student, taskKey, status: st, valueText }) }); await turnover(); toast(note); } catch (error) { showTurnoverError(error); } };
  app.querySelectorAll("[data-upload]").forEach((input) => input.onchange = () => { const file = input.files[0]; if (file) record(input, input.dataset.upload, "complete", file.name, `${file.name} recorded`); });
  app.querySelectorAll("[data-unupload]").forEach((button) => button.onclick = () => record(button, button.dataset.unupload, "pending", null, "Removed"));
  app.querySelectorAll("[data-remind]").forEach((button) => button.onclick = () => openTurnoverReminder(data, button.dataset.person, button.dataset.remind));
  app.querySelectorAll("[data-compare]").forEach((button) => button.onclick = () => openConditionCompare(data, button.dataset.compare));
}
function showTurnoverError(error) { const target = document.querySelector("#turnoverError"); if (target) target.textContent = error.message || "Unable to update turnover"; toast(error.message || "Unable to update turnover"); }
function openTurnoverReminder(data, personId, kind) {
  const student = data.students.find((item) => item.id === personId), copy = TURNOVER_REMINDERS[kind], modal = document.querySelector("#turnoverReminder");
  if (!student || !copy) return showTurnoverError(new Error("Reminder details are unavailable"));
  const message = copy.message(first(student.name), data.property.display_name), consent = consentLabel(student);
  document.querySelector("#reminderTo").textContent = `${student.name} · ${student.room?.label || "No room"} · ${data.property.display_name}`;
  document.querySelector("#reminderWhy").textContent = copy.why;
  document.querySelector("#reminderConsent").innerHTML = status(consent.kind, consent.label);
  document.querySelector("#reminderCopy").textContent = message;
  const approve = document.querySelector("#approveReminder"); approve.disabled = consent.kind === "blocked";
  approve.onclick = async () => { try { const sent = await api("manual-reply", { method: "POST", body: JSON.stringify({ propertyId: state.propertyId, personId: student.id, reason: copy.why, body: message }) }); modal.close(); toast(`Reminder recorded · ${deliveryLabel(sent)?.label || "Queued"}`); } catch (error) { showTurnoverError(error); } };
  modal.showModal();
}
function evidenceTiles(items) { return items.map((item) => `<p><a href="${esc(item.signed_url || "")}" target="_blank" rel="noreferrer">${esc(date(item.captured_at))} · ${esc(item.notes || "Condition photos")}</a></p>`).join(""); }
function openConditionCompare(data, personId) { const student = data.students.find((item) => item.id === personId); if (!student || !student.evidence.moveIn.length || !student.evidence.moveOut.length) return showTurnoverError(new Error("Both photo sets are needed to compare")); document.querySelector("#compareName").textContent = student.name; document.querySelector("#compareIn").innerHTML = evidenceTiles(student.evidence.moveIn); document.querySelector("#compareOut").innerHTML = evidenceTiles(student.evidence.moveOut); document.querySelector("#conditionCompare").showModal(); }

// ---------- Property ----------
async function property() {
  let p = current(); if (!p) { await loadProperties(); p = current(); }
  if (!p) { app.innerHTML = emptyState("Property unavailable", "Choose an available property to continue.", "#today", "Return to Today"); return; }
  const lease = activeLease(p), number = p.phone_numbers?.find((x) => x.active)?.sms_number, rent = rentFacts(p), tab = state.propertyTab;
  const occupant = (roomId) => residentsOf(p).filter((r) => r.room_id === roomId).map((r) => r.name).join(", ");
  app.innerHTML = `${errorLine("pageError")}<section class="lease-card"><div><p class="eyebrow">Address</p><h2>${esc(p.display_name)}</h2><p>${esc(p.address)}</p></div><div><p class="eyebrow">Hearth texting number</p><p><strong>${esc(number || "Not connected")}</strong></p><p class="muted">${number ? "Fictional demo number. Nothing is texted from this build, and nothing answers residents automatically." : "Residents can’t text Hearth for this property yet."}</p></div><div><p class="eyebrow">Lease</p><p>${lease ? `${esc(lease.academic_year)}<br>${esc(dateOnly(lease.term_start))} – ${esc(dateOnly(lease.term_end))}` : "No lease term set"}</p>${rent?.leaseTotal != null ? `<p class="muted">Lease total ${esc(money(rent.leaseTotal))} as entered · payments not tracked</p>` : ""}</div></section><div class="segmented" role="tablist" aria-label="Property records"><button role="tab" data-tab="overview" aria-selected="${tab === "overview"}">Rooms</button><button role="tab" data-tab="history" aria-selected="${tab === "history"}">History</button><button role="tab" data-tab="photos" aria-selected="${tab === "photos"}">Photos</button><button role="tab" data-tab="export" aria-selected="${tab === "export"}">Export</button></div><div id="propertyBody"><p class="loading">Loading…</p></div>`;
  app.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { state.propertyTab = b.dataset.tab; property(); });
  const target = document.querySelector("#propertyBody");
  if (tab === "overview") target.innerHTML = p.rooms.length ? `<ul class="plain-rows">${p.rooms.slice().sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })).map((room) => `<li><span><strong>${esc(room.label)}</strong><small>${esc(occupant(room.id) || "Vacant")}</small></span><span class="muted room-facts">${esc(roomFactsLine(room.facts))}</span></li>`).join("")}</ul>` : calm("No rooms set up", "Rooms appear once they’re added to this property.");
  if (tab === "history") { const rows = await api(`timeline?propertyId=${p.id}`); target.innerHTML = rows.length ? historyList(rows, true) : calm("Nothing recorded yet", "Texts, calls, photos and changes build this record."); }
  if (tab === "photos") { const rows = await api(`evidence?propertyId=${p.id}`); target.innerHTML = rows.length ? `<ul class="plain-rows">${rows.map((x) => `<li><span><strong>${esc(x.people?.name || "Unknown")}</strong><small>${esc(x.rooms?.label || "No room")} · ${esc(x.kind)} · ${esc(date(x.captured_at))}</small></span><span class="muted">${esc(x.notes || "")}</span>${x.signed_url ? `<a class="button secondary small" href="${esc(x.signed_url)}" target="_blank" rel="noreferrer">View</a>` : "<span class=\"muted\">Media unavailable</span>"}</li>`).join("")}</ul><p class="muted note">Photo links expire after five minutes; reopen this tab for fresh ones.</p>` : calm("No photos yet", "Move-in, move-out and repair photos appear here once residents text them."); }
  if (tab === "export") await exportInto(p, target);
}
function printableRecord(data){const p=data.property,people=new Map(p.people.map(x=>[x.id,x])),rooms=new Map(p.rooms.map(x=>[x.id,x])),personName=id=>people.get(id)?.name||"—",rows=(items,cells)=>items.length?items.map(item=>`<tr>${cells(item).map(value=>`<td>${value}</td>`).join("")}</tr>`).join(""):'<tr><td colspan="8">None recorded</td></tr>';return`<!doctype html><html><head><meta charset="utf-8"><title>Hearth record — ${esc(p.display_name)}</title><style>body{font:13px/1.45 system-ui;color:#20241f;margin:40px}h1,h2{font-family:Georgia,serif}h2{margin-top:30px;border-bottom:1px solid #bbb;padding-bottom:5px}table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #ddd;padding:7px;overflow-wrap:anywhere}th{font-size:10px;text-transform:uppercase}@media print{button{display:none}body{margin:18mm}}</style></head><body><button onclick="window.print()">Print / Save as PDF</button><h1>${esc(p.display_name)}</h1><p>${esc(p.address)}<br>Exported ${esc(date(data.exported_at))}</p><h2>People</h2><table><tr><th>Name</th><th>Role</th><th>Phone</th><th>Room</th><th>Consent</th></tr>${rows(p.people,x=>[esc(x.name),esc(x.role),esc(x.phone),esc(rooms.get(x.room_id)?.label||"—"),esc(x.consent_status)])}</table><h2>Rooms</h2><table><tr><th>Room</th><th>Rent share</th></tr>${rows(p.rooms,x=>[esc(x.label),esc(x.rent_share??"—")])}</table><h2>Re-leasing progress</h2><table><tr><th>Person</th><th>Renewal</th><th>Guarantor</th><th>Signature</th><th>Next room</th><th>Rent agreed</th><th>Acknowledged</th></tr>${rows(p.releasing_status,x=>[esc(personName(x.current_person_id)),esc(x.renewal),x.guarantor_confirmed?"Yes":"No",esc(x.signature_status),esc(rooms.get(x.next_room_id)?.label||"—"),x.rent_share_agreed?"Yes":"No",esc(date(x.reminder_acknowledged_at))])}</table><h2>Messages</h2><table><tr><th>When</th><th>Person</th><th>Direction</th><th>Body</th><th>Delivery</th></tr>${rows(p.messages,x=>[esc(date(x.created_at)),esc(personName(x.person_id)),esc(x.direction),esc(x.body),esc(x.delivery_status)])}</table><h2>Escalations</h2><table><tr><th>When</th><th>Tier</th><th>Status</th><th>Reason</th></tr>${rows(p.escalations,x=>[esc(date(x.created_at)),esc(x.tier),esc(x.status),esc(x.reason)])}</table><h2>Calls</h2><table><tr><th>When</th><th>Person</th><th>Summary</th></tr>${rows(p.call_logs,x=>[esc(date(x.occurred_at)),esc(personName(x.person_id)),esc(x.summary)])}</table><h2>Evidence</h2><table><tr><th>When</th><th>Person</th><th>Room</th><th>Kind</th><th>Reference</th><th>Notes</th></tr>${rows(p.evidence,x=>[esc(date(x.captured_at)),esc(personName(x.person_id)),esc(rooms.get(x.room_id)?.label||"—"),esc(x.kind),x.signed_url?`<a href="${esc(x.signed_url)}">Private media link</a>`:esc(x.media_path),esc(x.notes||"")])}</table><h2>Audit events</h2><table><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th></tr>${rows(p.audit_events,x=>[esc(date(x.created_at)),esc(x.actor),esc(x.action),`${esc(x.entity_type)} · ${esc(x.entity_id)}`])}</table></body></html>`}
async function exportInto(p, target) {
  const slug = p.display_name.replace(/[^a-z0-9]+/gi, "-").toLowerCase(), data = await api(`export?propertyId=${p.id}`), htmlUrl = URL.createObjectURL(new Blob([printableRecord(data)], { type: "text/html" })), jsonUrl = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  target.innerHTML = `<div class="card"><h3>Complete property record</h3><p>People, rooms, renewals, texts, urgent messages, calls, photo references and every change, in one printable file. Open it and use Print to save a PDF.</p><a class="button" id="printRecord" href="${htmlUrl}" download="hearth-${slug}-record.html">Download printable record</a> <a class="button secondary" id="downloadJson" href="${jsonUrl}" download="hearth-${slug}.json">Download data (JSON)</a></div>`;
}

// ---------- Settings ----------
// Deliberately small, and honest about what is and is not real in this build.
async function settings() {
  const meta = state.demoMeta || {};
  const p = current();
  const view = p ? await loadWorkspace(p.id).catch((error) => absentOnly(error, null)) : null;
  const row = (term, detail) => `<dt>${esc(term)}:</dt><dd>${detail}</dd>`;
  app.innerHTML = `${errorLine("pageError")}
    <section class="panel">
      <h2 class="section-title">This demo</h2>
      <dl class="facts tight">
        ${row("Scenario", esc(meta.label || "—"))}
        ${row("Mode", OFFLINE_MODE ? "Offline · runs entirely in this page" : "Local server")}
        ${row("Payments", view ? esc(view.provider.available ? (view.provider.simulated ? "Simulated (offline demo) · nothing is sent or paid" : "PayPal sandbox") : view.provider.reason || "Not connected") : "—")}
        ${row("Storage", OFFLINE_MODE ? "In this page · cleared on reload" : "Local files · survive a restart")}
      </dl>
      <p class="muted note">${esc(meta.disclaimer || "")}</p>
      ${OFFLINE_MODE ? "" : `<div class="sheet-actions"><button type="button" class="secondary" id="startOver">${icon("refresh-cw")}Start the demo over</button></div>
      <p class="muted note">Clears every rent split and invoice for everyone using this demo, then opens Today as new. Invoices already sent stay in PayPal's sandbox.</p>`}
    </section>
    <section class="panel">
      <h2 class="section-title">Not in this build</h2>
      <ul class="plain-list muted">
        <li>Live SMS. Messages are shown as drafts and never sent.</li>
        <li>Production sign-in. Role switching here is simulated identity.</li>
        ${state.demoMeta?.storageNote ? "" : "<li>A hosted database. Everything is local to this machine.</li>"}
      </ul>
    </section>`;
  const startOver = app.querySelector("#startOver");
  if (startOver) startOver.onclick = async () => {
    // Two steps, like Mark handled: this clears the rent work of everyone on the demo.
    if (!startOver.dataset.confirming) {
      startOver.dataset.confirming = "1"; startOver.textContent = "Confirm: clear everything and start over";
      setTimeout(() => { if (startOver.isConnected && startOver.dataset.confirming) { delete startOver.dataset.confirming; startOver.innerHTML = `${icon("refresh-cw")}Start the demo over`; } }, 5000);
      return;
    }
    startOver.disabled = true;
    try { await api("start-over", { method: "POST" }, "/api/demo/"); location.replace("/#today"); location.reload(); }
    catch (error) { startOver.disabled = false; showError("pageError", error); }
  };
}

// One resident's ledger: what they owe, what they agreed to, and what the provider
// says about their invoice. Read-only; every action stays in the workspace.
function openLedger(p, view, line) {
  const v = view.version, inv = line.invoice;
  const row = (label, value) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
  const body = openSheet(line.name, `<div class="ledger-head"><div><p class="muted">${esc(roomOf(p, line.roomId)?.label || "No room")} · ${esc(view.period.label)}</p><p class="ledger-amount">${line.amountLabel != null ? esc(line.amountLabel) : "No share yet"}</p><p class="muted">Share of the ${esc(view.total.requiredLabel)} ${esc(totalLabel(view.total.illustrative).toLowerCase())}</p></div>${inv ? invoiceStatusChip(inv) : ""}</div>
    <dl class="receipt-lines">
      ${row("Why this amount", v?.aiBasis?.[line.personId] ? `${esc(v.aiBasis[line.personId])}${splitSource(v).kind === "example" ? `<span>Example reasoning, not a model's output</span>` : ""}` : v ? "Set by hand" : "Not drafted yet")}
      ${row("Agreement", line.confirmedBySeed || line.confirmed ? `Confirmed${line.confirmedOn ? ` ${esc(shortDate(line.confirmedOn))}` : ""} · v${v.n}` : line.confirmedOtherVersion ? "Confirmed different numbers" : "Not confirmed yet")}
      ${row(view.provider.simulated ? "Invoice (simulated)" : "PayPal invoice", inv?.providerInvoiceId ? esc(inv.providerInvoiceId) : "Not invoiced yet")}
      ${inv?.sentAt ? row("Sent", esc(date(inv.sentAt))) : ""}
      ${inv ? row("Paid", `<strong>${esc(centsLabel(inv.paidCents || 0))}</strong>${inv.dueCents != null ? `<span>Still due ${esc(centsLabel(inv.dueCents))}</span>` : ""}`) : ""}
      ${inv?.lastCheckedAt ? row("Last read from the provider", esc(date(inv.lastCheckedAt))) : ""}
    </dl>
    ${inv?.recipientViewUrl ? `<p><a class="button secondary" href="${esc(inv.recipientViewUrl)}" target="_blank" rel="noreferrer">${icon("external-link")}Open the payment page</a></p>` : ""}
    <div class="sheet-actions"><button data-ledger-workspace>${inv ? "Open the invoice" : "Open the split"}</button></div>`);
  body.querySelector("[data-ledger-workspace]").onclick = () => { if (!inv) sheet.close(); openRentActivity(p, { invoiceFor: inv ? line.personId : null, step: inv ? null : 0 }).catch((error) => showError("rentError", error)); };
}

// A confirmation date may be a fixture label ("Oct 24") or a real ISO timestamp.
const shortDate = (value) => /^\d{4}-/.test(String(value)) ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value)) : String(value);

const routes = { home: ["Today", today], today: ["Today", today], rent: ["Rent", rent], messages: ["Messages", messages], residents: ["Leasing", residents], leasing: ["Leasing", leasing], turnover: ["Leasing", turnover], property: ["Property", property], settings: ["Settings", settings] };
const ENTRY = { needs: () => { state.messageView = "needs"; }, escalations: () => { state.messageView = "needs"; }, timeline: () => { state.propertyTab = "history"; }, evidence: () => { state.propertyTab = "photos"; }, export: () => { state.propertyTab = "export"; } };
const NAV_OF = { home: "today", residents: "leasing", leasing: "leasing", turnover: "leasing" };
// Leasing is one place with three views: who lives here, who is staying next year,
// and moving in and out.
const LEASING_TABS = [["residents", "Residents", "users"], ["leasing", "Renewals", "signature"], ["turnover", "Move-in and move-out", "door"]];
const leasingTabs = (active) => `<nav class="subtabs" aria-label="Leasing">${LEASING_TABS.map(([key, label, ic]) => `<a href="#${key}"${key === active ? ' aria-current="page"' : ""}>${icon(ic)}${label}</a>`).join("")}</nav>`;
// Renders run one at a time, so a slow page can't overwrite the page the landlord switched to.
let renderQueue = Promise.resolve();
function render() { return renderQueue = renderQueue.then(renderNow, renderNow); }
async function renderNow() {
  const requested = location.hash.slice(1) || "today", key = resolveRoute(requested, Object.keys(routes)), route = routes[key];
  ENTRY[requested]?.();
  title.textContent = route[0]; document.title = `${route[0]} · Hearth`; milestoneLine.textContent = pageSubtitle(current());
  document.querySelectorAll("[data-nav]").forEach((a) => { const on = a.dataset.nav === (NAV_OF[key] || key); a.classList.toggle("active", on); if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  if (sheet.open && key !== "messages") sheet.close();
  // Keep the last good screen of THIS page, so a failed refresh does not wipe it.
  const previous = app.dataset.page === key && !app.querySelector(".load-failed") ? app.innerHTML : "";
  app.innerHTML = '<p class="loading">Loading…</p>';
  // Until the property list has loaded once, every render retries it. Rendering a
  // page with the empty list after a failed load would say "No properties yet".
  try { if (!state.propertiesLoaded) await loadProperties(); await route[1](); app.dataset.page = key; if (requested === "reply") await newText(current()); }
  catch (error) {
    if (error instanceof AccessError) return;
    const banner = `<div class="load-failed" role="alert"><p><strong>Couldn’t load ${esc(route[0])}.</strong> ${esc(error.message || "Hearth hit an unexpected error.")}${previous ? " Showing what was on screen before; it may be out of date." : ""}</p><button type="button" class="secondary small" data-retry>Try again</button></div>`;
    app.innerHTML = banner + (previous || "");
    app.dataset.page = key;
    app.querySelector("[data-retry]").onclick = () => render();
    toast(error.message || "Unable to load Hearth");
  }
}
window.onhashchange = () => { render().then(() => app.focus({ preventScroll: true })); window.scrollTo(0, 0); };
dialog.addEventListener("close",async()=>{const input=document.querySelector("#token");const token=input.value;input.value="";if(token){document.querySelector("#accessError").hidden=true;state.token=token;sessionStorage.setItem("hearth_token",token);try{await loadProperties();await render()}catch(error){loadFailed(error)}}});
loadProperties().then(render).catch(loadFailed);
