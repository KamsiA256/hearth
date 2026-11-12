// The allocation workspace: versions, confirmations, approval, and the one status
// line that describes where a household's rent split stands.
//
// Pure logic. No I/O, no provider, no Node built-in, so the SAME module runs on the
// local server and inside the offline browser bundle. That is the point of it: the
// offline demo used to compute its own view of the allocation, which meant an
// unbalanced draft looked issuable there and blocked in server mode. One module
// cannot disagree with itself.
//
// Vocabulary, kept distinct because they are different facts:
//   draft      — saved, editable, not shown to residents. May be unbalanced.
//   proposed   — published to residents for confirmation. Must balance.
//   agreed     — every resident confirmed THIS version and the landlord approved it.
//   superseded — a later version exists.
//
// A confirmation is bound to the exact version confirmed. Editing a share creates a
// new version, and confirmations do not carry across: four people agreeing to one
// set of numbers is not agreement to a different set.
import { money } from "./money.js";

/** Shares of one version, as a canonical sorted list of [personId, cents]. */
const canonicalLines = (lines) =>
  Object.entries(lines)
    .map(([personId, cents]) => [personId, Math.round(Number(cents) || 0)])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

/**
 * The seed version for a property, from the dataset. Datasets state the household's
 * opening proposal; everything after that is recorded in the store.
 *
 * No entries is not a proposal of zero shares — it is no proposal at all. A
 * household can know its lease total, its due date and its period and still not
 * have divided it yet, and that is a different fact from "divided it evenly into
 * nothing." Returning null here, rather than a version with empty `lines`, is
 * what lets everything downstream (workspaceFor, allocationStatus, the API) tell
 * "no split yet" apart from "a split that happens to be zero."
 */
// A seed may describe a version an assistant authored, not merely a set of numbers.
// view() (server/allocation-api.mjs) reads the account of HOW a split was reached —
// the per-person basis lines, the relative weights behind them, which factors were
// left out, what produced it — straight off the current version, so a seed that
// dropped them would render a drafted split as if someone had typed it, silently
// discarding the only explanation of the numbers.
//
// The activity names these with an `ai` prefix because `activity.basis` is already
// taken: view() maps it to `allocationBasis` and the page renders it as a single
// line of prose. These are a different thing — one sentence per resident — and
// collapsing the two would put an object where a string is printed.
const SEEDED_AI_FIELDS = {
  aiBasis: "basis",
  aiWeights: "weights",
  aiUnknowns: "unknowns",
  aiExcludedFactors: "excludedFactors",
  aiFactorSelection: "factorSelection",
  aiModelId: "modelId",
};

export function seedVersion(activity) {
  if (!activity || !(activity.entries || []).length) return null;
  const lines = {};
  for (const entry of activity.entries || []) lines[entry.personId] = Math.round(Number(entry.amount) * 100);
  const version = { n: 1, state: activity.seedState || "proposed", lines, createdAt: null, note: activity.source || null };
  // Copied only where the activity states one, so a plain numeric seed is unchanged
  // and keeps rendering as exactly what it is: a split with no account of itself.
  for (const [onActivity, onVersion] of Object.entries(SEEDED_AI_FIELDS)) {
    if (activity[onActivity] !== undefined) version[onVersion] = activity[onActivity];
  }
  return version;
}

/**
 * Fold the stored workspace over the dataset seed and report the current state.
 *
 * `stored` is whatever the allocation store holds for this property and period, or
 * null. Returning the seed untouched when nothing is stored is what keeps an
 * existing scenario — and any invoice already approved against its version —
 * exactly as it was.
 */
export function workspaceFor({ activity, stored }) {
  const seed = seedVersion(activity);
  // No seed does not mean no workspace: a household with no entries can still
  // have had its first share typed, or its first AI draft made, after the
  // dataset loaded — that lives in `stored`, not in the seed. Only when NEITHER
  // exists is there truly nothing yet.
  const versions = stored?.versions?.length ? stored.versions : (seed ? [seed] : null);
  if (!versions) return null;
  const current = versions[versions.length - 1];
  const confirmations = stored?.confirmations || {};
  const approval = stored?.approval || null;
  return { versions, current, confirmations, approval, requiredCents: Math.round(Number(activity.total) * 100) };
}

/** The activity object `allocationFor` expects, with the current version's amounts. */
export function activityForVersion(activity, version) {
  if (!activity || !version) return activity;
  const covered = new Set((activity.entries || []).map((entry) => entry.personId));
  const updated = (activity.entries || []).map((entry) => ({
    ...entry,
    amount: Object.hasOwn(version.lines, entry.personId) ? version.lines[entry.personId] / 100 : entry.amount,
  }));
  // A version can name a resident the base activity had no entry for at all —
  // a household seeded with no split (or no seed at all) that has since had a
  // share typed or an AI draft made. Synthesize a bare entry for them so
  // allocationFor still sees it; without this, a from-scratch version's lines
  // would silently vanish rather than just lacking the seed's extra fields
  // (state, confirmedOn) a synthesized entry has no claim to either way.
  const added = Object.keys(version.lines)
    .filter((personId) => !covered.has(personId))
    .map((personId) => ({ personId, amount: version.lines[personId] / 100 }));
  return { ...activity, entries: [...updated, ...added] };
}

/** Residents who have confirmed exactly this version. */
export function confirmedFor(workspace, versionCanonical) {
  return Object.entries(workspace?.confirmations || {})
    .filter(([, record]) => record.versionCanonical === versionCanonical)
    .map(([personId]) => personId);
}

/**
 * Where this allocation stands, as one row.
 *
 * Shared by the dashboard card and the workspace header so the two can never
 * disagree. Two rules are encoded here:
 *
 *   - The row names the next action or who it waits on. "Awaiting review, 2 of 4"
 *     says it is the household's turn; "ready for your approval" says it is yours.
 *     A status that cannot tell those apart is decoration.
 *   - Attention outranks progress. A household at 90% collected with one uncertain
 *     send reports the uncertain send, not the 90%.
 *
 * It is never empty. An empty widget is a claim that nothing needs attention, and
 * if that claim cannot be made truthfully the state is shown instead of nothing.
 */
export function allocationStatus({ snapshot, workspace, invoices = [], residentCount, provider = {} }) {
  const none = { tone: "pending", headline: "No rent split yet", detail: "Nothing has been proposed for this period.", waitingOn: "landlord" };
  if (!snapshot || !workspace) return none;

  const version = workspace.current;
  const label = `v${version.n}`;
  const people = residentCount ?? snapshot.lines.length;
  const confirmed = confirmedFor(workspace, snapshot.version);
  const issued = invoices.filter((invoice) => invoice && invoice.providerInvoiceId);

  // --- Attention first, in order of how wrong it would be to bury it. ---
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

  // --- Allocation not yet settled. ---
  if (!snapshot.balances) {
    const short = snapshot.differenceCents < 0;
    return {
      tone: "blocked",
      headline: `Draft ${label} · ${money(Math.abs(snapshot.differenceCents))} ${short ? "short" : "over"}`,
      detail: `Saved, but it cannot go to residents or be collected until the shares total ${snapshot.totalLabel}.`,
      waitingOn: "landlord", label,
    };
  }
  if (version.state === "draft") {
    return { tone: "needs-decision", headline: `Draft ${label} balanced · not sent to residents`, detail: `${snapshot.totalLabel} allocated across ${people} ${people === 1 ? "resident" : "residents"}. Publish it for confirmation.`, waitingOn: "landlord", label };
  }
  if (version.state === "proposed") {
    if (confirmed.length < people) {
      return { tone: "pending", headline: `Rent proposal awaiting review · ${confirmed.length} of ${people} confirmed`, detail: confirmed.length ? `Waiting on ${people - confirmed.length} resident${people - confirmed.length === 1 ? "" : "s"}.` : "Shared with residents to confirm. Nobody has confirmed yet.", waitingOn: "residents", label };
    }
    return { tone: "needs-decision", headline: `Ready for your approval · ${label}`, detail: `All ${people} residents confirmed these numbers. Approving authorizes collection.`, waitingOn: "landlord", label };
  }

  // --- Agreed. Now collection, which is a separate story. ---
  const collectable = snapshot.lines.length;
  if (!provider.available) {
    return { tone: "complete", headline: `Approved ${label} · collection unavailable`, detail: provider.reason || "No payment provider is connected in this mode.", waitingOn: "nobody", label };
  }
  const mappedCount = provider.mappedCount ?? collectable;
  // A draft at the provider is not an invoice anyone has received. Only sent ones
  // count as "sent"; drafts are named separately.
  const sent = issued.filter((invoice) => invoice.localState === "sent");
  const drafts = issued.length - sent.length;
  const draftNote = drafts ? ` ${drafts} draft${drafts === 1 ? "" : "s"} prepared, not sent.` : "";
  if (!sent.length) {
    return mappedCount
      ? { tone: "needs-decision", headline: `Approved ${label} · ${collectable} invoice${collectable === 1 ? "" : "s"} not yet sent`, detail: `The split is agreed. Nothing has been sent for this period.${draftNote}`, waitingOn: "landlord", label }
      : { tone: "pending", headline: `Approved ${label} · no billing destination yet`, detail: "Collection needs a billing destination for each resident.", waitingOn: "landlord", label };
  }
  const paidCents = issued.reduce((sum, invoice) => sum + (invoice.paidCents || 0), 0);
  if (paidCents >= snapshot.totalCents && sent.length >= collectable) {
    return { tone: "complete", headline: `${snapshot.period.label} collected in full`, detail: `${snapshot.totalLabel} received from ${collectable} ${collectable === 1 ? "resident" : "residents"}.`, waitingOn: "nobody", label };
  }
  if (sent.length < collectable) {
    const remaining = collectable - sent.length;
    return { tone: "needs-decision", headline: `Approved ${label} · ${remaining} invoice${remaining === 1 ? "" : "s"} not yet sent`, detail: `${money(paidCents)} of ${snapshot.totalLabel} collected so far.${draftNote}`, waitingOn: "landlord", label };
  }
  return { tone: "pending", headline: `${money(paidCents)} of ${snapshot.totalLabel} collected`, detail: `All ${collectable} invoices are out. Waiting on residents to pay.`, waitingOn: "residents", label };
}

/** Why this version cannot be published to residents, or null. */
export function publishBlockedReason(snapshot, version) {
  if (!snapshot || !version) return "There is no allocation to publish yet. Draft one first.";
  if (!snapshot.balances) {
    const short = snapshot.differenceCents < 0;
    return `The shares are ${snapshot.differenceLabel} ${short ? "short of" : "over"} the ${snapshot.totalLabel} total. A draft can be saved unbalanced; it cannot be sent to residents until it matches exactly.`;
  }
  if (version.state === "proposed") return "This version has already been published to residents.";
  if (version.state === "agreed") return "This version is already agreed.";
  return null;
}

/** Why this version cannot be approved for collection, or null. */
export function approveBlockedReason(snapshot, workspace) {
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

/**
 * Apply one share edit, returning the next version. Does not persist.
 *
 * A version number changes only when the people who have to agree to the numbers
 * change. So:
 *
 *   - Editing a DRAFT stays in that version. A draft is private working state; it
 *     has not been shown to anyone, so moving money around inside it is one person
 *     adjusting one proposal, not a new thing to agree to. Nudging a share four
 *     times should not produce v2, v3, v4 and v5.
 *
 *   - Editing a version residents have already been SHOWN — proposed, or agreed —
 *     always creates a new one. Those numbers are what somebody confirmed, and
 *     changing them in place would silently rewrite what they agreed to.
 *
 * Safety does not rest on the version number either way. A confirmation is bound to
 * the canonical form of the exact numbers confirmed (see `confirmedFor`), and that
 * fingerprint changes on EVERY edit, draft included. So an edit inside a draft still
 * invalidates any confirmation that happened to match it; the version number is for
 * people to talk about, the fingerprint is what the rules run on.
 *
 * An edit that lands on the same numbers is not a change and creates nothing, so
 * tabbing through a field without altering it leaves no trace.
 */
export function withShare(workspace, { personId, cents }) {
  const current = workspace?.current;
  // No allocation exists yet — not even a draft. Typing the first share is how
  // one starts: version 1, same as a dataset's seed would have been, had there
  // been one.
  if (!current) return { version: { n: 1, state: "draft", lines: { [personId]: Math.round(cents) }, createdAt: new Date().toISOString(), note: null }, created: true };
  const lines = { ...current.lines, [personId]: Math.round(cents) };
  if (JSON.stringify(canonicalLines(lines)) === JSON.stringify(canonicalLines(current.lines))) {
    return { version: current, created: false };
  }
  if (current.state === "draft") {
    return { version: { ...current, lines, updatedAt: new Date().toISOString() }, created: false };
  }
  return { version: { n: current.n + 1, state: "draft", lines, createdAt: new Date().toISOString(), note: null }, created: true };
}
