// The payments API. Orchestration only: it holds no arithmetic and no provider
// detail, and it is the single place that decides whether an invoice may be created
// or sent.
//
// Mounted at /api/payments/. Same simulated access gate and the same
// organization scoping as the operator API: a property outside the operator's
// organizations is reported exactly like one that does not exist.
//
// The rules it enforces, each of which exists because of a specific way this can go
// wrong:
//   - Allocation must reconcile to the cent before any invoice is created.
//   - Every create and send carries the allocation version the human actually saw.
//     A stale version is refused rather than silently authorizing new numbers.
//   - Creating a draft and sending it are two requests, never one.
//   - A send whose outcome is unknown is NEVER retried blind: provider state is read
//     first, and an invoice that already went out is recorded, not re-sent.
//   - An already-sent invoice is returned as-is. Retrying cannot produce a second one.
import { json } from "./_shared/http.mjs";
import { resolveOperator } from "./_shared/operator-auth.mjs";
import { db, must, audit } from "./_shared/db.mjs";
import { allocationFor, blockedReason, lineFor, periodKey } from "../src/allocation.js";
import { activityForVersion, workspaceFor } from "../src/allocation-state.js";
import { demoMeta } from "./_shared/db.mjs";
import { idempotencyKey } from "../src/payments/idempotency.js";
import { invoiceNumberFor } from "../src/payments/paypal-sandbox.js";
import { PAYMENT_STATE_LABEL, paymentStateOf } from "../src/payments/state.js";
import { unmappedRecipientMessage } from "../src/payments/config.js";

const routeOf = (event) => (event.path.split("/api/payments/")[1] || "").replace(/\/$/, "");
const bodyOf = (event) => { if (!event.body) return {}; try { return JSON.parse(event.body); } catch { return null; } };

// Draft and send requests in flight, per resident. Two tabs (or two operators)
// pressing the same button must not both reach the provider: the in-flight marker
// in the store looks exactly like an earlier failed attempt. This one holds within
// one process; hosted, the lock is a database row (src/postgres-stores.js).
export function inProcessLock() {
  const held = new Set();
  return {
    async acquire(key) {
      if (held.has(key)) return null;
      held.add(key);
      return async () => { held.delete(key); };
    },
  };
}

/**
 * Build the handler. `payments` is the resolved provider bundle and `store` the
 * durable payment store, both injected so tests can supply their own.
 *
 * A store with a `flush` (the Postgres one) keeps writes in memory until flushed.
 * The handler flushes at the two points where durability is the point: the key
 * written down before a provider call, and the outcome before the lock is let go.
 */
export function createPaymentsHandler({ payments, store, allocationStore = null, lock = inProcessLock() }) {
  const { mode, provider, mapping } = payments;

  async function scopedProperty(propertyId, orgs) {
    if (!propertyId) return null;
    const { data } = await db().from("properties").select("id,organization_id,display_name").eq("id", propertyId).in("organization_id", orgs).single();
    return data || null;
  }

  // The allocation payments act on is the CURRENT version in the allocation
  // workspace, not the dataset seed. Reading the seed here meant an edited,
  // unapproved or unbalanced split on screen could still be invoiced at the seed's
  // amounts, and an approved edit could never be invoiced at all.
  async function workspaceOf(property) {
    const seed = demoMeta.rentActivity?.[property.id];
    if (!seed) return { seed, workspace: null };
    const stored = allocationStore?.get({ propertyId: property.id, periodKey: periodKey(seed.period) }) || null;
    return { seed, workspace: workspaceFor({ activity: seed, stored }) };
  }

  async function snapshotFor(property) {
    const { data: people } = await db().from("people").select("id,name,room_id,role").eq("property_id", property.id);
    const { seed, workspace } = await workspaceOf(property);
    const activity = workspace ? activityForVersion(seed, workspace.current) : seed;
    return allocationFor({ propertyId: property.id, activity, people: people || [] });
  }

  // Invoicing needs the landlord's approval of exactly these numbers. A seed that
  // is already agreed carries no stored approval record; a stored approval must name
  // the version on screen.
  async function notApproved(property, snapshot) {
    const { workspace } = await workspaceOf(property);
    if (!workspace) return null;
    if (workspace.current.state !== "agreed") {
      return json(409, { error: `This split is ${workspace.current.state === "draft" ? "still a draft" : "waiting for residents to confirm"}. Invoices can only be prepared from a split you have approved.`, code: "NOT_APPROVED" });
    }
    if (workspace.approval && workspace.approval.versionCanonical !== snapshot.version) {
      return json(409, { error: "Your approval was for different numbers. Approve the current split before invoicing.", code: "NOT_APPROVED" });
    }
    return null;
  }

  const identityFor = (snapshot, personId) => ({ propertyId: snapshot.propertyId, periodKey: snapshot.period.key, personId });

  // What the interface shows for one resident: the household's own record, plus
  // whatever the provider last told us. These are never merged into one word.
  function lineView(snapshot, line) {
    const record = store.get(identityFor(snapshot, line.personId));
    const recipientEmail = mapping?.recipientFor(line.personId) || null;
    return {
      ...line,
      recipientMapped: Boolean(recipientEmail),
      recipientEmail,
      unmappedReason: recipientEmail ? null : (mode === "offline" ? null : unmappedRecipientMessage(line.personId, line.name)),
      invoice: record ? {
        localState: record.localState,
        providerInvoiceId: record.providerInvoiceId || null,
        providerStatus: record.providerStatus || null,
        paymentState: record.paymentState || null,
        paymentStateLabel: record.paymentState ? PAYMENT_STATE_LABEL[record.paymentState] : null,
        paidCents: record.paidCents ?? null,
        dueCents: record.dueCents ?? null,
        recipientViewUrl: record.recipientViewUrl || null,
        approvedAllocationVersion: record.approvedAllocationVersion || null,
        // An invoice approved against different numbers than the ones on screen now.
        stale: Boolean(record.approvedAllocationVersion && record.approvedAllocationVersion !== snapshot.version),
        lastError: record.lastError || null,
        lastCheckedAt: record.lastCheckedAt || null,
        sentAt: record.sentAt || null,
      } : null,
    };
  }

  function overview(property, snapshot) {
    return {
      mode,
      providerLabel: provider.describe(),
      providerAvailable: provider.available,
      seller: mapping ? { name: mapping.invoicer.displayName, email: mapping.invoicer.sandboxBusinessEmail } : null,
      property: { id: property.id, display_name: property.display_name },
      allocation: snapshot && {
        period: snapshot.period,
        totalCents: snapshot.totalCents, totalLabel: snapshot.totalLabel,
        allocatedCents: snapshot.allocatedCents, allocatedLabel: snapshot.allocatedLabel,
        differenceCents: snapshot.differenceCents, differenceLabel: snapshot.differenceLabel,
        balances: snapshot.balances,
        version: snapshot.version, versionLabel: snapshot.versionLabel,
        source: snapshot.source,
      },
      blockedReason: blockedReason(snapshot),
      lines: snapshot ? snapshot.lines.map((line) => lineView(snapshot, line)) : [],
    };
  }

  // Shared preamble for the three write routes: resolve, scope, reconcile, bind.
  async function prepare(payload, orgs, { requireApproval = false } = {}) {
    const property = await scopedProperty(payload.propertyId, orgs);
    if (!property) return { error: json(404, { error: "property not found" }) };
    const snapshot = await snapshotFor(property);
    const blocked = blockedReason(snapshot);
    if (blocked) return { error: json(409, { error: blocked, code: "ALLOCATION_DOES_NOT_BALANCE" }) };
    if (requireApproval) {
      const unapproved = await notApproved(property, snapshot);
      if (unapproved) return { error: unapproved };
    }
    const line = lineFor(snapshot, payload.personId);
    if (!line) return { error: json(404, { error: "resident not found in this allocation" }) };
    return { property, snapshot, line, identity: identityFor(snapshot, payload.personId) };
  }

  // The approval binding. A human approved a specific version; anything else is a
  // different authorization and has to be re-reviewed.
  function versionMismatch(snapshot, payload) {
    if (!payload.allocationVersion) return json(400, { error: "allocationVersion is required: an approval has to name the exact allocation it authorizes.", code: "VERSION_REQUIRED" });
    if (payload.allocationVersion !== snapshot.version) {
      return json(409, {
        error: `The allocation changed since you reviewed it. Version ${snapshot.versionLabel} is current. Review the new amounts and approve again.`,
        code: "STALE_ALLOCATION",
        currentVersion: snapshot.version,
        currentVersionLabel: snapshot.versionLabel,
      });
    }
    return null;
  }

  const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
  // The billing destination a stored draft was created for, versus the one mapped
  // now. A draft addressed to an old address must never be reused or sent as if it
  // were addressed to the new one: PayPal would deliver it to the old address while
  // Hearth showed the new one.
  function recipientChanged(record, line, currentEmail) {
    if (!record?.providerInvoiceId || !record.recipientEmail) return null;
    if (normalizeEmail(record.recipientEmail) === normalizeEmail(currentEmail)) return null;
    return json(409, {
      error: `${line.name}'s billing address changed after invoice ${record.providerInvoiceId} was created for the old one. Hearth will not reuse or send it. Void it in PayPal, then prepare a new invoice.`,
      code: "RECIPIENT_CHANGED",
    });
  }

  function requireRecipient(line) {
    const email = mapping?.recipientFor(line.personId);
    if (!email) return { error: json(409, { error: unmappedRecipientMessage(line.personId, line.name), code: "RECIPIENT_NOT_MAPPED" }) };
    return { email };
  }

  // Record what the provider last said, in both the durable store and the demo's
  // own activity trail. The store survives a restart; the trail does not, which is
  // why the store is the authority.
  async function recordProviderState(identity, property, read, extra = {}) {
    // A read naming a DIFFERENT invoice than the one on record is not about our
    // invoice. Keep the stored id and say nothing about its state.
    const existing = store.get(identity);
    if (existing?.providerInvoiceId && read?.providerInvoiceId && read.providerInvoiceId !== existing.providerInvoiceId) {
      return store.put(identity, { lastCheckedAt: new Date().toISOString(), lastError: `PayPal returned invoice ${read.providerInvoiceId} when asked for ${existing.providerInvoiceId}; nothing was recorded from it.` }, { event: "provider_read_mismatch", expected: existing.providerInvoiceId, got: read.providerInvoiceId });
    }
    const payment = paymentStateOf(read.invoice || {});
    // A read that came back without an id or status says nothing about the invoice.
    // It must never erase the only local reference to one the provider holds.
    const known = {};
    if (read.providerInvoiceId) known.providerInvoiceId = read.providerInvoiceId;
    if (read.providerStatus) known.providerStatus = read.providerStatus;
    return store.put(identity, {
      ...known,
      recipientViewUrl: read.recipientViewUrl || null,
      paymentState: payment.state,
      paidCents: payment.paidCents,
      dueCents: payment.dueCents,
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
      ...extra,
    }, { event: "provider_state_read", providerStatus: read.providerStatus, paymentState: payment.state, paidCents: payment.paidCents });
  }

  return async function handler(event) {
    const operator = resolveOperator(event);
    if (!operator) return json(401, { error: "Operator token required" });
    const orgs = operator.organizationIds, actor = operator.name;
    const route = routeOf(event);

    try {
      if (event.httpMethod === "GET" && route === "allocation") {
        const property = await scopedProperty((event.queryStringParameters || {}).propertyId, orgs);
        if (!property) return json(404, { error: "property not found" });
        return json(200, overview(property, await snapshotFor(property)));
      }

      const payload = bodyOf(event);
      if (payload === null) return json(400, { error: "Request body must be JSON" });

      // ---- Create a draft at the provider. Does not send anything. ----
      if (event.httpMethod === "POST" && (route === "draft" || route === "send")) {
        // One lock for draft AND send: a draft racing a send for the same resident
        // can otherwise send an invoice the draft is replacing.
        const release = await lock.acquire(`${payload.propertyId}:${payload.personId}`);
        if (!release) return json(409, { error: "This invoice is already being processed. Wait for that result before trying again.", code: "IN_PROGRESS" });
        try {
          const result = await (route === "draft" ? draftRoute(payload, orgs, actor) : sendRoute(payload, orgs, actor));
          await store.flush?.();
          return result;
        } finally { await release(); }
      }

      // ---- Re-read provider state. The only thing allowed to say what was paid. ----
      if (event.httpMethod === "POST" && route === "refresh") {
        return await refreshRoute(payload, orgs, actor);
      }

      return json(404, { error: "Not found" });
    } catch (error) {
      if (error.code === "CONCURRENT_WRITE") return json(409, { error: error.message, code: error.code });
      console.error("payments_api_error", error);
      return json(500, { error: error.message });
    }
  };

  // ---- Create a draft at the provider. Does not send anything. ----
  async function draftRoute(payload, orgs, actor) {
      {
        const prepared = await prepare(payload, orgs, { requireApproval: true });
        if (prepared.error) return prepared.error;
        const { property, snapshot, line, identity } = prepared;
        const stale = versionMismatch(snapshot, payload);
        if (stale) return stale;
        if (!provider.available) return json(409, { error: provider.describe() === "Offline — no payment provider configured" ? "Offline mode: no payment provider is configured, so no invoice can be created. Set PAYMENTS_MODE=paypal_sandbox with sandbox credentials." : "No payment provider available.", code: "PROVIDER_UNAVAILABLE" });
        const recipient = requireRecipient(line);
        if (recipient.error) return recipient.error;

        const existing = store.get(identity);
        const changed = recipientChanged(existing, line, recipient.email);
        if (changed) return changed;
        // Already sent against these exact numbers: nothing to create, and nothing
        // to re-send. Return what exists.
        if (existing && existing.localState === "sent" && existing.approvedAllocationVersion === snapshot.version) {
          // Every write route returns `review`, so the interface can open the review
          // panel from any of them. This branch used to return `record` instead,
          // which made the panel read `review.invoice` off undefined and render
          // blank with no error. Reachable with two operators: one prepares and
          // sends while the other still has a stale sheet showing "Prepare invoice".
          // `record` is kept alongside it so nothing depending on it breaks.
          return json(200, { alreadySent: true, record: lineView(snapshot, line).invoice, review: await reviewPayload(snapshot, line, recipient.email, identity) });
        }
        // An invoice already exists at the provider for this resident and period,
        // against different numbers. Creating another would bill them twice for one
        // month. It has to be voided at PayPal first; Hearth does not do that.
        if (existing && existing.providerInvoiceId && existing.allocationVersion !== snapshot.version) {
          return json(409, { error: `${line.name} already has an invoice for ${snapshot.period.label} (${existing.providerInvoiceId}) for different numbers. Void it in PayPal before invoicing the revised split. Hearth will not issue a second invoice for the same month.`, code: "INVOICE_EXISTS_FOR_OTHER_NUMBERS" });
        }
        if (existing && existing.providerInvoiceId && existing.allocationVersion === snapshot.version) {
          // The draft exists. Re-read it rather than creating a second one.
          const read = await provider.get(existing.providerInvoiceId);
          await recordProviderState(identity, property, read);
          return json(200, { reused: true, review: await reviewPayload(snapshot, line, recipient.email, identity) });
        }

        // The billing destination is part of both derivations: a different address
        // is a different logical operation, not a retry of the last one.
        const derivation = { propertyId: snapshot.propertyId, periodKey: snapshot.period.key, personId: line.personId, allocationVersion: snapshot.version, destination: recipient.email };
        const requestId = idempotencyKey({ scope: "invoice-create", ...derivation });
        const invoiceNumber = invoiceNumberFor(derivation);
        const invoice = provider.buildInvoice({ line, snapshot, property, invoicer: mapping.invoicer, recipientEmail: recipient.email, invoiceNumber });

        // Write the key down BEFORE the call, as PayPal's own guidance says: a
        // crash after the request must not lose the key that makes a retry safe.
        store.put(identity, {
          localState: "draft_proposed", provider: provider.name,
          amountCents: line.amountCents, recipientEmail: recipient.email,
          allocationVersion: snapshot.version, allocationVersionLabel: snapshot.versionLabel,
          period: snapshot.period.label, invoiceNumber, createRequestId: requestId,
          sellerEmail: mapping.invoicer.sandboxBusinessEmail, lastError: null,
        }, { event: "draft_requested", actor, amountCents: line.amountCents, invoiceNumber });
        await store.flush?.();

        let created;
        try {
          created = await provider.createDraft(invoice, requestId);
        } catch (error) {
          store.put(identity, { localState: "create_failed", lastError: describeError(error) }, { event: "draft_failed", actor, error: describeError(error) });
          // A timeout is not a refusal: the draft may exist. Retrying is safe because
          // it reuses the same request id and invoice number and adopts a match.
          return json(502, { error: `Creating the draft did not complete (${describeError(error)}). It may or may not exist at PayPal; preparing it again is safe and will not create a second one.`, code: "CREATE_FAILED" });
        }

        const read = await provider.get(created.providerInvoiceId);
        await recordProviderState(identity, property, read, { localState: "created", adopted: created.adopted || false });
        await audit(property.organization_id, "invoice_draft_created", "property", property.id, { personId: line.personId, summary: provider.name === "offline_demo" ? `Simulated invoice draft created for ${line.name} (offline demo): ${line.amountLabel} for ${snapshot.period.label} (${created.providerInvoiceId}). Nothing left this page.` : `Sandbox invoice draft created for ${line.name}: ${line.amountLabel} for ${snapshot.period.label} (${created.providerInvoiceId})` }, actor);
        return json(201, { created: true, adopted: created.adopted || false, review: await reviewPayload(snapshot, line, recipient.email, identity) });
      }
  }

  // An explicit non-DRAFT status for the SAME invoice id is the only read that
  // proves a send went out. An empty or mismatched read proves nothing.
  function provesSent(read, record) {
    return Boolean(read && read.providerStatus && String(read.providerStatus).toUpperCase() !== "DRAFT"
      && read.providerInvoiceId && read.providerInvoiceId === record.providerInvoiceId);
  }
  function provesDraft(read, record) {
    return Boolean(read && String(read.providerStatus || "").toUpperCase() === "DRAFT"
      && read.providerInvoiceId === record.providerInvoiceId);
  }

  // ---- Approve and send an existing draft. A separate, explicit request. ----
  async function sendRoute(payload, orgs, actor) {
      {
        const prepared = await prepare(payload, orgs, { requireApproval: true });
        if (prepared.error) return prepared.error;
        const { property, snapshot, line, identity } = prepared;
        const stale = versionMismatch(snapshot, payload);
        if (stale) return stale;
        if (!payload.confirmed) return json(400, { error: "Sending needs an explicit confirmation.", code: "CONFIRMATION_REQUIRED" });

        const record = store.get(identity);
        if (!record || !record.providerInvoiceId) return json(409, { error: "There is no draft to send yet. Create the draft first and review it.", code: "NO_DRAFT" });
        if (record.allocationVersion !== snapshot.version) return json(409, { error: "The draft was created against different amounts. Create a new draft for the current allocation.", code: "STALE_DRAFT" });
        if (!["created", "send_uncertain", "sent"].includes(record.localState)) return json(409, { error: "There is no reviewed draft to send. Prepare the invoice and review it first.", code: "NO_DRAFT" });
        const changed = recipientChanged(record, line, mapping?.recipientFor(line.personId));
        if (changed) return changed;
        // Already sent. Returning it is the whole point: a retry must not resend.
        if (record.localState === "sent") return json(200, { alreadySent: true, review: await reviewPayload(snapshot, line, record.recipientEmail, identity) });

        // An earlier send whose outcome we never learned. Read provider state
        // BEFORE trying again, so an invoice that actually went out is recorded
        // rather than sent a second time.
        if (record.localState === "send_uncertain") {
          const read = await provider.get(record.providerInvoiceId);
          if (provesSent(read, record)) {
            await recordProviderState(identity, property, read, { localState: "sent", sentAt: record.sentAt || new Date().toISOString() });
            return json(200, { alreadySent: true, recoveredFromUncertainty: true, review: await reviewPayload(snapshot, line, record.recipientEmail, identity) });
          }
          if (!provesDraft(read, record)) {
            await recordProviderState(identity, property, read);
            return json(502, { error: "PayPal's answer did not say whether this invoice was sent. Hearth has not resent it. Check the status again before retrying.", code: "SEND_UNCERTAIN" });
          }
          await recordProviderState(identity, property, read, { localState: "created" });
        }

        const sendRequestId = idempotencyKey({ scope: "invoice-send", propertyId: snapshot.propertyId, periodKey: snapshot.period.key, personId: line.personId, allocationVersion: snapshot.version, destination: record.recipientEmail });
        // Who announces the invoice. Default: PayPal emails the recipient as well as
        // Hearth texting them, because a resident who misses one has the other.
        // Passing notifyRecipient: false makes the hosted link the only notice, which
        // is the mode where Hearth is the sole sender. It changes nothing about who
        // owes what, so it is recorded with the approval rather than bound into the
        // allocation version.
        const notifyRecipient = payload.notifyRecipient !== false;
        store.put(identity, {
          approvedAllocationVersion: snapshot.version, approvedAt: new Date().toISOString(), approvedBy: actor,
          sendRequestId, localState: "send_uncertain", notifyRecipient,
        }, { event: "send_approved", actor, allocationVersionLabel: snapshot.versionLabel, amountCents: line.amountCents, recipientEmail: record.recipientEmail, notifyRecipient });
        await store.flush?.();

        let read;
        try {
          read = await provider.send(record.providerInvoiceId, sendRequestId, { notifyRecipient });
        } catch (error) {
          // Deliberately NOT marked send_failed: we do not know that it failed. The
          // record stays uncertain so the next attempt reads provider state first.
          store.put(identity, { localState: "send_uncertain", lastError: describeError(error) }, { event: "send_outcome_unknown", actor, error: describeError(error) });
          return json(502, {
            error: `The send result is unknown: ${describeError(error)}. Hearth has not recorded this as sent. Refresh the status to find out what actually happened before trying again.`,
            code: "SEND_UNCERTAIN",
          });
        }

        // The send call returning is not proof. Only PayPal's own read-back of THIS
        // invoice, past DRAFT, is. Anything else stays unknown and is never retried
        // automatically.
        if (!provesSent(read, record)) {
          await recordProviderState(identity, property, read, { localState: "send_uncertain", lastError: "PayPal's reply did not confirm this invoice left DRAFT." });
          store.put(identity, { localState: "send_uncertain" }, { event: "send_outcome_unknown", actor, error: "unconfirmed send response" });
          return json(502, {
            error: "PayPal accepted the send request but its reply did not confirm the invoice went out. Hearth has not recorded it as sent. Refresh the status before trying again.",
            code: "SEND_UNCERTAIN",
          });
        }
        await recordProviderState(identity, property, read, { localState: "sent", sentAt: new Date().toISOString() });
        await audit(property.organization_id, "invoice_sent", "property", property.id, { personId: line.personId, summary: provider.name === "offline_demo" ? `Simulated invoice marked sent to ${line.name} (offline demo): ${line.amountLabel} for ${snapshot.period.label} (${record.providerInvoiceId}). Nothing was emailed or paid. Sent is not paid.` : `Sandbox invoice sent to ${line.name}: ${line.amountLabel} for ${snapshot.period.label} (${record.providerInvoiceId}). ${notifyRecipient ? "PayPal emailed the recipient." : "PayPal sent no email; the hosted link is the only notice."} Sent is not paid.` }, actor);
        return json(200, { sent: true, review: await reviewPayload(snapshot, line, record.recipientEmail, identity) });
      }
  }

  async function refreshRoute(payload, orgs, actor) {
      {
        const prepared = await prepare(payload, orgs);
        if (prepared.error) return prepared.error;
        const { property, snapshot, line, identity } = prepared;
        const record = store.get(identity);
        if (!record || !record.providerInvoiceId) return json(409, { error: "There is no invoice to refresh yet.", code: "NO_INVOICE" });
        if (!provider.available) return json(409, { error: "Offline mode: there is no provider to read status from.", code: "PROVIDER_UNAVAILABLE" });

        let read;
        try { read = await provider.get(record.providerInvoiceId); }
        catch (error) {
          store.put(identity, { lastError: describeError(error) }, { event: "refresh_failed", actor, error: describeError(error) });
          return json(502, { error: `Could not read the invoice from the provider: ${describeError(error)}`, code: "REFRESH_FAILED" });
        }
        const wasUncertain = record.localState === "send_uncertain";
        const sent = wasUncertain && provesSent(read, record);
        // PayPal proving the SAME invoice is still DRAFT resolves the uncertainty the
        // other way: nothing went out, so a deliberate send is allowed again.
        const stillDraft = wasUncertain && !sent && provesDraft(read, record);
        const updated = await recordProviderState(identity, property, read, sent ? { localState: "sent", sentAt: record.sentAt || new Date().toISOString() } : stillDraft ? { localState: "created" } : {});
        return json(200, { refreshed: true, resolvedUncertainty: sent || stillDraft, paymentState: updated.paymentState, review: await reviewPayload(snapshot, line, record.recipientEmail, identity) });
      }
  }

  // The exact facts shown before approval: who it goes to, how much, which period,
  // and who it comes from.
  async function reviewPayload(snapshot, line, recipientEmail, identity) {
    const record = store.get(identity);
    return {
      // The address the draft was actually created for, when one exists.
      recipient: { personId: line.personId, name: line.name, email: record?.recipientEmail || recipientEmail },
      seller: mapping ? { name: mapping.invoicer.displayName, email: mapping.invoicer.sandboxBusinessEmail } : null,
      amountCents: line.amountCents, amountLabel: line.amountLabel,
      period: snapshot.period,
      allocation: { version: snapshot.version, versionLabel: snapshot.versionLabel, totalLabel: snapshot.totalLabel },
      invoice: lineView(snapshot, line).invoice,
      invoiceNumber: record?.invoiceNumber || null,
      environment: provider.describe(),
      // True only for the offline reviewer build's simulated provider.
      simulated: provider.name === "offline_demo",
    };
  }
}

const describeError = (error) => {
  const issue = error?.issue ? ` (${error.issue})` : "";
  return `${error?.message || String(error)}${issue}`;
};
