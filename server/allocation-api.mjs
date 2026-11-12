// The allocation API: editing a household's rent split, publishing it for
// confirmation, recording confirmations, and the landlord's approval.
//
// Mounted at /api/allocation/. It runs in BOTH modes — the local server and the
// offline browser bundle — which is the point. Offline mode used to compute its own
// view of the allocation in the page, so a draft that server mode refused to issue
// looked publishable there. The arithmetic, the version rules and the blocking
// reasons now come from src/allocation-state.js in both.
//
// What differs between the modes is storage, injected here: a local JSON file on
// the server, memory in the page. Not the rules.
//
// It knows nothing about any payment provider. Invoices are a separate API with a
// separate store, because an agreed split and a collected payment are different
// facts and a correction to one is not a correction to the other.
import { json } from "./_shared/http.mjs";
import { resolveOperator } from "./_shared/operator-auth.mjs";
import { db, demoMeta, audit } from "./_shared/db.mjs";
import { allocationFor, periodKey } from "../src/allocation.js";
import {
  activityForVersion, allocationStatus, approveBlockedReason, confirmedFor,
  publishBlockedReason, withShare, workspaceFor,
} from "../src/allocation-state.js";
import { money, toCents } from "../src/money.js";

const routeOf = (event) => (event.path.split("/api/allocation/")[1] || "").replace(/\/$/, "");
const bodyOf = (event) => { if (!event.body) return {}; try { return JSON.parse(event.body); } catch { return null; } };

/**
 * `store` is an allocation store.
 *
 * `invoicesFor(propertyId, periodKey)` is optional and supplies what the payment
 * provider last said, one entry per `personId`. It is a plain array of
 * `{ personId, localState, providerInvoiceId, providerStatus, paymentState,
 * paymentStateLabel, paidCents, dueCents, approvedAllocationVersion }` — shaped by
 * the caller, so no payment module is imported here and none goes into the offline
 * browser bundle. Offline mode passes nothing, because there is no provider to ask.
 *
 * `ai`, `proposeAiDraft` and `proposeAiRedraft` follow the exact same shape, for
 * the exact same reason: no src/ai module is imported here, so none goes into
 * the offline browser bundle either. `ai` is `{ available, reason }`.
 * `proposeAiDraft({ personIds, rooms, context, totalCents, factorSelection })`
 * and `proposeAiRedraft({ ..., previousWeights, feedback })` are the caller's
 * model call plus the deterministic weights-to-cents conversion (see
 * src/ai/propose.js); this file never sees a weight, only the balanced cents
 * draft that comes back — which carries `excludedFactors`, `factorSelection` and
 * `modelId`, so every AI-authored version can say what produced it, and (on a
 * redraft) `feedback`, the complaint that produced THIS version specifically.
 * Thrown errors are distinguished by `.code` rather than `instanceof`, on
 * purpose — the error classes themselves live in src/ai/ and data/room-facts.mjs,
 * and importing either here (even just to catch it) is one import away from
 * pulling the wrong thing into the offline bundle for no real benefit.
 */
// An invoice exists at the provider, or one is being created at this moment.
const blocksEditing = (invoice) => Boolean(invoice.providerInvoiceId) || invoice.localState === "draft_proposed";

export function createAllocationHandler({
  store, invoicesFor = () => [],
  provider = { available: false, reason: "No payment provider is connected in this mode." },
  ai = { available: false, reason: "No AI is connected in this mode." },
  proposeAiDraft = async () => { throw new Error("AI is not connected in this mode."); },
  proposeAiRedraft = async () => { throw new Error("AI is not connected in this mode."); },
}) {

  async function scopedProperty(propertyId, orgs) {
    if (!propertyId) return null;
    const { data } = await db().from("properties").select("id,organization_id,display_name,address").eq("id", propertyId).in("organization_id", orgs).single();
    return data || null;
  }

  // Resolve everything a route needs: the property, the seed, the stored workspace,
  // the current version's snapshot, and the status. One place, so no route can
  // compute a different version than the one it writes against.
  //
  // `workspace` and `snapshot` are both null when the household has a rent
  // period but has not yet divided it — a dataset with no entries, or a fresh
  // property that has never had a share typed or drafted. That is a real,
  // ordinary state, not an error: NO_PERIOD below means "nothing is even set up
  // for this property"; a null workspace means "it is set up, and empty."
  async function resolve(propertyId, orgs) {
    const property = await scopedProperty(propertyId, orgs);
    if (!property) return { error: json(404, { error: "property not found" }) };
    const seedActivity = demoMeta.rentActivity?.[property.id];
    if (!seedActivity) return { error: json(409, { error: "This property has no rent period set up.", code: "NO_PERIOD" }) };
    const identity = { propertyId: property.id, periodKey: periodKey(seedActivity.period) };
    const stored = store.get(identity);
    const workspace = workspaceFor({ activity: seedActivity, stored });
    const { data: people } = await db().from("people").select("id,name,room_id,role").eq("property_id", property.id);
    const snapshot = workspace
      ? allocationFor({ propertyId: property.id, activity: activityForVersion(seedActivity, workspace.current), people: people || [] })
      : null;
    return { property, seedActivity, identity, stored, workspace, snapshot, people: people || [] };
  }

  // Residents only (never a guarantor) — the set a split divides across, derived
  // the same way whether or not one exists yet.
  const residentsOf = (people) => (people || []).filter((person) => person.role === "student" || !person.role);

  function view({ property, seedActivity, identity, workspace, snapshot, people }) {
    const hasAllocation = Boolean(workspace && snapshot);
    const invoices = invoicesFor(identity.propertyId, identity.periodKey);
    // `stale` is decided here rather than by the caller: it means "approved against
    // numbers other than the ones on screen", and this is the only place that knows
    // what is on screen.
    const withStaleness = invoices.map((invoice) => ({
      ...invoice,
      stale: Boolean(hasAllocation && invoice.approvedAllocationVersion && invoice.approvedAllocationVersion !== snapshot.version),
    }));
    const invoiceFor = new Map(withStaleness.filter((invoice) => invoice.personId).map((invoice) => [invoice.personId, invoice]));
    const confirmed = hasAllocation ? confirmedFor(workspace, snapshot.version) : [];
    // A dataset whose seed is already `agreed` is asserting that this household
    // went through the whole flow IN HEARTH before this demo opened: each resident
    // confirmed these exact numbers on a recorded date, and the landlord approved.
    // Rendering them as "awaiting confirmation" would invent an outstanding step
    // that does not exist. A confirmation recorded here takes over from the seed.
    const agreedOnFile = hasAllocation && workspace.current.state === "agreed" && Object.keys(workspace.confirmations).length === 0;
    const seedConfirmedOn = new Map((seedActivity.entries || []).map((entry) => [entry.personId, entry.confirmedOn || null]));
    const status = allocationStatus({ snapshot, workspace, invoices: withStaleness, residentCount: hasAllocation ? snapshot.lines.length : residentsOf(people).length, provider });
    const requiredCents = hasAllocation ? snapshot.totalCents : toCents(seedActivity.total);
    return {
      property: { id: property.id, display_name: property.display_name, address: property.address },
      dataset: { label: demoMeta.label, disclaimer: demoMeta.disclaimer, provenance: demoMeta.provenance || null },
      period: hasAllocation ? snapshot.period : { label: seedActivity.period, key: periodKey(seedActivity.period), due: seedActivity.due, followUp: seedActivity.followUp },
      total: hasAllocation ? {
        requiredCents, requiredLabel: money(requiredCents),
        allocatedCents: snapshot.allocatedCents, allocatedLabel: snapshot.allocatedLabel,
        differenceCents: snapshot.differenceCents, differenceLabel: snapshot.differenceLabel,
        balances: snapshot.balances,
        basis: seedActivity.source || null, illustrative: Boolean(seedActivity.illustrative), allocationBasis: seedActivity.basis || null,
      } : {
        // No allocatedCents/differenceCents here at all, deliberately — not 0,
        // not null disguised as a number. "$0.00 collected" and "$0.00 short" are
        // both claims about a split that exists; this property has none yet, and
        // the only honest numbers to show are the ones the household already
        // knows: the lease total, and nothing it hasn't decided.
        requiredCents, requiredLabel: money(requiredCents),
        allocatedCents: null, allocatedLabel: null, differenceCents: null, differenceLabel: null, balances: false,
        basis: seedActivity.source || null, illustrative: Boolean(seedActivity.illustrative), allocationBasis: seedActivity.basis || null,
      },
      version: hasAllocation ? {
        n: workspace.current.n, state: workspace.current.state, label: snapshot.versionLabel, canonical: snapshot.version, count: workspace.versions.length,
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
        rating: workspace.current.rating ?? null,
      } : null,
      // The previous version, for comparison. Only the previous version's own
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
          answeredFeedback: workspace.current.feedback || null,
        };
      })(),
      status,
      approval: hasAllocation ? (workspace.approval || (agreedOnFile && seedActivity.approvedOn ? { actor: "Demo operator", on: seedActivity.approvedOn, versionLabel: snapshot.versionLabel, seeded: true } : null)) : null,
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
              personId: person.id, name: person.name, roomId: person.room_id,
              amountCents: null, amountLabel: null,
              recipientMapped: provider.mappedPersonIds ? provider.mappedPersonIds.includes(person.id) : false,
              invoice: null, confirmed: false, confirmedBySeed: false, confirmedOn: null, confirmedAt: null, confirmedOtherVersion: null,
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
            confirmedOn: workspace.confirmations[line.personId]?.versionCanonical === snapshot.version
              ? workspace.confirmations[line.personId].at
              : (agreedOnFile ? seedConfirmedOn.get(line.personId) : null),
            confirmedAt: workspace.confirmations[line.personId]?.versionCanonical === snapshot.version ? workspace.confirmations[line.personId].at : null,
            // A confirmation of an EARLIER version is shown as such rather than as
            // nothing: "they agreed, to different numbers" is useful to the landlord.
            confirmedOtherVersion: Boolean(workspace.confirmations[line.personId] && workspace.confirmations[line.personId].versionCanonical !== snapshot.version)
              ? workspace.confirmations[line.personId].versionLabel : null,
          };
        });
      })(),
      blocked: {
        publish: hasAllocation ? publishBlockedReason(snapshot, workspace.current) : "There is no allocation yet. Draft one first.",
        approve: hasAllocation ? approveBlockedReason(snapshot, workspace) : "There is no allocation yet. Draft one first.",
      },
      history: (store.get(identity)?.history || []).slice(-20),
      provider,
      ai,
    };
  }

  return async function handler(event) {
    const operator = resolveOperator(event);
    if (!operator) return json(401, { error: "Operator token required" });
    const orgs = operator.organizationIds, actor = operator.name;
    const route = routeOf(event);

    try {
      if (event.httpMethod === "GET" && route === "workspace") {
        const resolved = await resolve((event.queryStringParameters || {}).propertyId, orgs);
        if (resolved.error) return resolved.error;
        return json(200, view(resolved));
      }

      const payload = bodyOf(event);
      if (payload === null) return json(400, { error: "Request body must be JSON" });

      const resolved = await resolve(payload.propertyId, orgs);
      if (resolved.error) return resolved.error;
      const { property, seedActivity, identity, workspace, snapshot, people } = resolved;

      // Every write names the exact numbers the person was looking at. A missing or
      // stale version is refused, so nobody publishes, confirms or approves numbers
      // they were not shown. (Reset is exempt: it discards, it does not authorize.)
      // When there is no allocation yet, there are no numbers to name — "share"
      // and "ai-draft" are the two routes allowed to start one from nothing, so
      // they are exempt from naming a version THAT DOESN'T EXIST; the others
      // need an allocation to act on regardless, and say so plainly below.
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

      // ---- Change one resident's share. Saves even when it does not balance.
      // Also how a FIRST share gets typed when there is no allocation yet —
      // withShare() bootstraps version 1 from nothing (src/allocation-state.js). ----
      if (event.httpMethod === "POST" && route === "share") {
        const residentExists = snapshot ? snapshot.lines.some((x) => x.personId === payload.personId) : residentsOf(people).some((p) => p.id === payload.personId);
        if (!residentExists) return json(404, { error: "resident not found in this allocation" });
        const cents = Number(payload.amountCents);
        if (!Number.isSafeInteger(cents)) return json(400, { error: "amountCents must be a whole number of cents.", code: "NOT_INTEGER_CENTS" });
        if (cents < 0) return json(400, { error: "A share cannot be negative.", code: "NEGATIVE_SHARE" });
        const requiredCents = snapshot ? snapshot.totalCents : toCents(seedActivity.total);
        if (cents > requiredCents) return json(400, { error: `One share cannot be more than the whole rent (${money(requiredCents)}).`, code: "SHARE_EXCEEDS_RENT" });
        // Once anything is invoiced for this period, the split is fixed. Editing it
        // would let the same resident be invoiced again for the same month.
        // An invoice being created right now counts too: its draft may land a moment
        // later against the numbers this edit is about to change.
        if (invoicesFor(identity.propertyId, identity.periodKey).some(blocksEditing)) {
          return json(409, { error: provider.simulated
            ? "Invoices already exist for this period, so the split cannot be edited here. In this offline demo, reload the page to start over."
            : "Invoices already exist for this period, so the split cannot be edited here. Void them in PayPal and record a correction instead.", code: "HAS_INVOICES" });
        }
        const { version, created } = withShare(workspace, { personId: payload.personId, cents });
        store.putVersion(identity, version, { event: created ? "version_created" : "share_edited", actor, personId: payload.personId, amountCents: cents, versionNumber: version.n });
        await audit(property.organization_id, created ? "allocation_version_created" : "allocation_share_edited", "property", property.id, { personId: payload.personId, amountCents: cents, versionNumber: version.n }, actor);
        const after = await resolve(payload.propertyId, orgs);
        return json(200, { ...view(after), createdVersion: created });
      }

      // ---- Ask the model for a weight proposal. Writes a brand new draft version,
      // never an edit of the current one — a model-authored re-proposal is not the
      // same act as a person nudging one number, and version history should say so.
      // From here it goes through the same publish/confirm/approve pipeline as any
      // other draft; nothing about approval is different because AI proposed it. ----
      if (event.httpMethod === "POST" && route === "ai-draft") {
        if (!ai.available) return json(409, { error: ai.reason || "No AI is connected in this mode.", code: "AI_UNAVAILABLE" });
        if (invoicesFor(identity.propertyId, identity.periodKey).some(blocksEditing)) {
          return json(409, { error: "Invoices already exist for this period, so a new split cannot be proposed here.", code: "HAS_INVOICES" });
        }
        // Structured room facts and labels — never rent_share, which is a dollar
        // figure. The model sees what kind of room each resident has, not what
        // anyone currently pays. What src/ai/propose.js actually sends the model
        // is governed by factorSelection below: a withheld factor is dropped
        // there, before any room reaches the model.
        const { data: rooms } = await db().from("rooms").select("id,label,facts").eq("property_id", property.id);
        const roomFor = new Map((rooms || []).map((room) => [room.id, room]));
        const roomFacts = payload.roomFacts && typeof payload.roomFacts === "object" ? payload.roomFacts : {};
        // Residents, not snapshot.lines — this route works whether or not an
        // allocation already exists; a fresh property has no lines to read yet.
        const residents = residentsOf(people);
        const personIds = residents.map((person) => person.id);
        const roomInputs = residents.map((person) => {
          const extra = typeof roomFacts[person.id] === "string" ? roomFacts[person.id].trim() : "";
          const room = person.room_id ? roomFor.get(person.room_id) : null;
          return { personId: person.id, name: person.name, facts: room?.facts || null, label: room?.label || "", extra };
        });
        const context = typeof payload.context === "string" ? payload.context.trim() : undefined;
        const factorSelection = payload.factorSelection && typeof payload.factorSelection === "object" ? payload.factorSelection : undefined;
        const totalCents = snapshot ? snapshot.totalCents : toCents(seedActivity.total);
        let draft;
        try {
          draft = await proposeAiDraft({ personIds, rooms: roomInputs, context, totalCents, factorSelection });
        } catch (error) {
          // A bad selection (unknown factor, everything withheld) is the caller's
          // mistake, named plainly, before any model was ever asked anything.
          if (error.code === "BAD_FACTOR_SELECTION") return json(400, { error: error.message, code: error.code });
          // A refused or unreachable model is reported, never papered over with the
          // last balanced draft or an empty one that looks like a real answer.
          return json(502, { error: `The model's proposal was refused: ${error.message}`, code: "AI_PROPOSAL_REFUSED" });
        }
        const version = {
          n: workspace ? workspace.current.n + 1 : 1, state: "draft", lines: draft.lines, createdAt: new Date().toISOString(),
          note: "Proposed by AI — review before publishing.", basis: draft.basis, unknowns: draft.unknowns, weights: draft.weights,
          excludedFactors: draft.excludedFactors, factorSelection: draft.factorSelection, modelId: draft.modelId,
        };
        store.putVersion(identity, version, { event: "ai_draft_proposed", actor, versionNumber: version.n });
        await audit(property.organization_id, "allocation_ai_draft_proposed", "property", property.id, { versionNumber: version.n }, actor);
        return json(200, { ...view(await resolve(payload.propertyId, orgs)), createdVersion: true });
      }

      // ---- A redraft: feedback on the CURRENT version produces the next one.
      // Starts from this version's weights, not a blank re-proposal — that is
      // what makes it a redraft and not another fresh first guess. The isolation
      // (residents whose room doesn't carry the flagged factor must hold) is
      // enforced inside src/ai/propose.js, not here: this route only ever sees
      // the result after that check already passed, or the error after it
      // didn't — it never has to re-derive the check itself. ----
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
        const context = typeof payload.context === "string" ? payload.context.trim() : undefined;
        const factorSelection = payload.factorSelection && typeof payload.factorSelection === "object" ? payload.factorSelection : undefined;
        const feedback = payload.feedback && typeof payload.feedback === "object" ? payload.feedback : undefined;
        let draft;
        try {
          draft = await proposeAiRedraft({
            personIds, rooms: roomInputs, context, totalCents: snapshot.totalCents, factorSelection,
            previousWeights: workspace.current.weights, feedback,
          });
        } catch (error) {
          // The caller's mistake (bad selection, bad feedback) is a 400, named
          // plainly. A redraft the isolation check refused, and any other model
          // failure, are both reported as a 502 — neither is ever papered over
          // with the previous version's draft dressed up as a new one.
          if (error.code === "BAD_FACTOR_SELECTION" || error.code === "BAD_FEEDBACK") return json(400, { error: error.message, code: error.code });
          if (error.code === "REDRAFT_REFUSED") return json(502, { error: error.message, code: error.code });
          return json(502, { error: `The model's proposal was refused: ${error.message}`, code: "AI_PROPOSAL_REFUSED" });
        }
        const version = {
          n: workspace.current.n + 1, state: "draft", lines: draft.lines, createdAt: new Date().toISOString(),
          note: "Redrafted after feedback — review before publishing.", basis: draft.basis, unknowns: draft.unknowns, weights: draft.weights,
          excludedFactors: draft.excludedFactors, factorSelection: draft.factorSelection, modelId: draft.modelId,
          feedback: draft.feedback, rating: draft.feedback?.rating ?? null,
        };
        store.putVersion(identity, version, { event: "ai_redraft_proposed", actor, versionNumber: version.n, feedback: draft.feedback });
        await audit(property.organization_id, "allocation_ai_redraft_proposed", "property", property.id, { versionNumber: version.n, feedback: draft.feedback }, actor);
        return json(200, { ...view(await resolve(payload.propertyId, orgs)), createdVersion: true });
      }

      // ---- Publish for resident confirmation. Requires an exact balance. ----
      if (event.httpMethod === "POST" && route === "publish") {
        if (!workspace) return json(409, { error: "There is no allocation yet. Draft one first.", code: "NO_ALLOCATION" });
        const blocked = publishBlockedReason(snapshot, workspace.current);
        if (blocked) return json(409, { error: blocked, code: snapshot.balances ? "ALREADY_PUBLISHED" : "ALLOCATION_DOES_NOT_BALANCE" });
        store.putVersion(identity, { ...workspace.current, state: "proposed", publishedAt: new Date().toISOString() }, { event: "version_published", actor, versionNumber: workspace.current.n, versionLabel: snapshot.versionLabel });
        await audit(property.organization_id, "allocation_published", "property", property.id, { versionNumber: workspace.current.n, versionLabel: snapshot.versionLabel }, actor);
        return json(200, view(await resolve(payload.propertyId, orgs)));
      }

      // ---- One resident confirms THIS version. ----
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

      // ---- Landlord approval. Everyone must have confirmed this exact version. ----
      if (event.httpMethod === "POST" && route === "approve") {
        const blocked = approveBlockedReason(snapshot, workspace);
        if (blocked) return json(409, { error: blocked, code: "APPROVAL_BLOCKED" });
        store.putVersion(identity, { ...workspace.current, state: "agreed", agreedAt: new Date().toISOString() }, { event: "landlord_approved", actor, versionNumber: workspace.current.n, versionLabel: snapshot.versionLabel });
        store.putApproval(identity, { actor, at: new Date().toISOString(), versionCanonical: snapshot.version, versionLabel: snapshot.versionLabel, totalCents: snapshot.totalCents }, { event: "approval_recorded", actor, versionLabel: snapshot.versionLabel });
        await audit(property.organization_id, "allocation_approved", "property", property.id, { versionLabel: snapshot.versionLabel, totalCents: snapshot.totalCents }, actor);
        return json(200, view(await resolve(payload.propertyId, orgs)));
      }

      // ---- Restart the walkthrough. Allocation only; never touches invoices. ----
      if (event.httpMethod === "POST" && route === "reset") {
        const invoices = invoicesFor(identity.propertyId, identity.periodKey);
        if (invoices.some(blocksEditing)) {
          return json(409, {
            error: `This period already has ${invoices.length} invoice(s) at the payment provider. Resetting the allocation would leave them pointing at numbers nobody approved. Use a correction instead.`,
            code: "HAS_INVOICES",
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

export { money };
