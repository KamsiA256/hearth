# Decision log

Newest first. Each entry says what was decided, why, and what would change it.

## 2026-11-02 — Scope: Hearth with rent allocation, not a settlement CLI

The submission is the Hearth application extended with shared-house rent
allocation and PayPal sandbox invoicing. The standalone "Settle" CLI and the
"Turnover" deposit-return product are both out of scope.

The pitch that argued for the deposit-return direction was retired with it. It is
in this repository's history (`docs/archive/`, removed 2026-11-12).

Note on the word *turnover*: the **Turnover page** in the interface is move-in and
move-out coordination — keys, arrival windows, condition photos — and it stays.
The superseded "Turnover" product concept was deposit-return settlement. Different
things with the same name.

## 2026-11-02 — Baseline: the pilot's reviewed demo branch

The starting point is the most recent reviewed demo branch of the private Hearth
pilot: clean, in sync with its remote, every test passing. Nothing is written into
it. Files are read and copied out by hand (`docs/REUSE.md`).

## 2026-11-02 — The local Node server is the baseline run mode

The pilot's demo runs two ways: a browser-only bundle with no server, and a local
Node server running the real API against an in-memory database. PayPal requires
server-side OAuth, which a browser-only page cannot hold.

So the local server is the primary mode, and the browser-only bundle becomes the
**offline mode** — the credential-free way to review the interface. This is also
why missing credentials must fail loudly rather than fall back: a silent fallback
would make offline mode and sandbox mode indistinguishable, which is the one
confusion this project cannot afford.

## 2026-11-02 — One database module, not a loader-hook swap

The pilot swapped its real database client for an in-memory one using a Node
module loader hook, because the real client had to stay in the repository. Here
there is no real client at all, so `server/_shared/db.mjs` **is** the in-memory
implementation. Same for messaging and the access gate.

This removes a class of failure where a reader cannot tell whether the swap
actually applied, and it lets one file serve both the server and the browser
bundle. It also means the fixture is imported directly rather than chosen by an
environment variable, which is why `node:fs` is gone from that path.

## 2026-11-02 — Verified PayPal behaviour that shaped the design

Verified against PayPal's published documentation, not from memory:

- **Create and send are separate calls.** `POST /v2/invoicing/invoices` creates a
  draft; `POST /v2/invoicing/invoices/{id}/send` sends it. The human approval gate
  sits naturally between them.
- **`INVOICING.INVOICE.PAID` does not mean paid.** PayPal's event-names reference
  states it fires when an invoice is paid, **partially paid, or payment is
  pending**, and there is no separate partial-payment event. So payment state is
  never read from an event name: on every event, re-read the invoice and use
  `status` plus `due_amount` / `payments.paid_amount`.
- **Statuses** are `DRAFT, SENT, SCHEDULED, PAID, MARKED_AS_PAID, CANCELLED,
  REFUNDED, PARTIALLY_PAID, PARTIALLY_REFUNDED, MARKED_AS_REFUNDED, UNPAID,
  PAYMENT_PENDING`. "Sent" and "paid" are distinct states and are kept distinct.
- **Idempotency** is the `PayPal-Request-Id` header, reusable for about 45 days,
  UUID recommended; two simultaneous requests with the same ID may fail the
  second. A retry without it is the documented cause of duplicate invoices.
- **The hosted payer link** is `detail.metadata.recipient_view_url`.
- **Sandbox accounts:** a business account with invoicing is the invoicer; the
  recipient must be a sandbox personal account, because the sandbox does not
  deliver mail outside itself.
- **Webhook verification** uses the `PAYPAL-TRANSMISSION-*` headers over the raw
  body with the webhook ID, rejecting anything older than five minutes. The
  Webhooks Simulator uses a special ID, so simulated events fail verification and
  cannot prove the verification path.

## 2026-11-02 — Observed against the live sandbox (not documentation)

Everything above under "Verified PayPal behaviour" came from PayPal's published
documentation. These four came from calls actually made, and two of them contradict
what the documentation led us to build.

**1. The create response is not the invoice.** `POST /v2/invoicing/invoices` returns,
by default, a bare link object — `{rel, href, method}` — with no `id` and no
`status`. Reading `created.id` yields `undefined`, which then travels as though it
were an invoice id until a later call requests `.../invoices/undefined` and 404s. The
fix is `Prefer: return=representation` on the create, with a fallback that extracts
the id from the link, and a hard error if neither yields one. An absent id is now
never returned as an id.

**2. `PayPal-Request-Id` did not deduplicate the create.** Replaying an identical
create with the identical header did not return the original response. It returned
`DUPLICATE_INVOICE_NUMBER`, and the client resolved it by looking the invoice number
up and adopting the existing invoice. So on this account, idempotency on create is
enforced by the uniqueness of `detail.invoice_number`, **not** by the header. The
header is still sent — it costs nothing and may behave differently elsewhere — but it
is not what is relied on. The deterministic invoice number is load-bearing; this is
the reason it is derived rather than random.

**3. `recipient_view_url` IS present on an unsent draft.** This was an open question.
It means the hosted link exists before anyone approves anything, so the interface must
not treat "a link exists" as "the invoice was sent". Status, and the amounts, remain
the only authority.

**4. The Invoicing feature is not enabled on a new sandbox app by default.** Without
it, authentication returns a clean `HTTP 200` and the token carries 28 scopes, none
of them invoicing; every invoicing call then returns `403 NOT_AUTHORIZED`. Since the
handshake looks perfectly healthy, this reads as a code fault. The client now attaches
the dashboard path to that 403 and says the credentials need no change.

**What this says about the tests.** All of this passed 137 tests. The suite mocked
the client's three methods everywhere and never once exercised its parsing of a real
reply, so the one bug that reached the live API was in the only layer with no direct
test. `tests/paypal-client.test.js` now drives the client through an injected `fetch`
against these observed response shapes, including the link-only create and the
no-id-at-all case.

## 2026-11-02 — Known constraints on PayPal as a production provider

Recorded because they are real, even though this phase is a sandbox demo.

- **Merchant of record.** For a platform to invoice on behalf of a landlord,
  PayPal requires partner onboarding, a `PayPal-Auth-Assertion` header, the
  features `INVOICE_READ_WRITE` and `ACCESS_MERCHANT_INFORMATION`, and the
  invoicer email must be the merchant's own. Partner invoicing is open to select
  partners only. PayPal's developer policies separately prohibit payment
  aggregation. In production the landlord must be the merchant, not Hearth.
- **Fees, per resident transaction.** Rent is invoiced per resident, so the fee is
  charged per resident payment and the bank-payment cap applies **per transaction**,
  not per month. US invoicing, per PayPal's fee page updated 2026-10-01: 3.49% +
  $0.49 for PayPal, Venmo or guest checkout; 2.99% + $0.49 for card or Apple Pay;
  4.99% + $0.49 for Pay Later; 1% capped at $10 per transaction for bank payments;
  +1.5% international.

  Worked example — four residents paying $900 each toward a $3,600 month:

  | Rail | Per payment | Four payments |
  |---|---|---|
  | Bank (1%, $10 cap per transaction) | $9.00 | **$36.00** |
  | PayPal / Venmo / guest (3.49% + $0.49) | $31.90 | **$127.60** |
  | Card / Apple Pay (2.99% + $0.49) | $27.40 | **$109.60** |

  The $10 cap does not bind at $900: 1% is $9. It would only bind above $1,000 per
  payment. An earlier version of this log said four such payments cost about $10 in
  total, which was wrong — it applied the cap once to the month instead of once to
  each transaction.

Consequence for the build: PayPal is the hackathon provider, not a selected
production provider. Provider code stays behind a narrow interface and the
allocation logic stays deterministic and provider-free, so a different provider
can be added without touching it.

## 2026-11-02 — Scoped reuse authorization replaces the blanket copy ban

`docs/BOUNDARIES.md` previously forbade copying any Hearth code. The owner
replaced that with a scoped authorization covering specific reviewed components.
The protections that were actually load-bearing — no shared git history, no
private data, no credentials, no production identifiers — are unchanged and now
stated more precisely. `docs/REUSE.md` is the record.

## 2026-11-02 — How the invoice slice is built

Decisions taken while implementing it, each one a response to a specific way this
could mislead someone.

**The approval is bound to a version, and the version is computed from exactly what a
human authorizes:** property, billing period, monthly total, and the set of
(resident, amount) pairs. Not the order they arrive in, and not whether the household
says someone has paid in — neither of those is something a landlord approves. Change
any amount or any recipient and the version changes, every prior approval stops
being valid, and both create and send are refused with `STALE_ALLOCATION`.

**Idempotency keys are derived, not random.** PayPal's guidance says to generate a
stable id per logical operation and store it before the request. A random key lost to
a crash between generating and storing it would let a retry create a second invoice.
The key is `sha256(scope, property, period, person, allocationVersion)` formatted as
a UUID, so the same logical operation always produces the same key — and a changed
amount produces a different one, because replaying an old key against new numbers
would hand back the wrong invoice. Create and send get separate scopes.

**A failed send is not a failed send.** If the send call throws, we do not know
whether the invoice went out; only that we did not hear back. The record is marked
`send_uncertain`, never `sent` and never `send_failed`, and the next attempt reads
provider state BEFORE doing anything. An invoice that already left is recorded as
sent rather than sent again. This is the one case where getting it wrong means a
resident is asked for rent twice.

**Deterministic invoice numbers, as a second line of defence.**
`detail.invoice_number` is derived from the same inputs and must be unique per
merchant, so a duplicate attempt is caught by PayPal as well as by the header. A
`DUPLICATE_INVOICE_NUMBER` response means the invoice already exists, so it is
adopted rather than treated as an error — the alternative is creating a second
invoice under a new number, which is exactly the failure being avoided.

**The payment store is durable; the demo data is not.** Two separate files,
deliberately. The fictional dataset resets on every restart. Provider invoice ids,
request keys, approval details and send outcomes persist. The store refuses to
accept anything whose field name or shape looks like a credential.

**Offline mode refuses rather than pretends.** The old `src/paypal.js` fell back to a
dry run when credentials were absent, returning a `DRYRUN-…` id indistinguishable
from a real one a few screens later. That file is deleted. The offline provider
throws, sandbox mode with missing credentials or a missing recipient mapping stops
the server at startup, and the two failures are reported separately because they need
different fixes.

**Allocation logic holds no provider detail.** `src/allocation.js` and `src/money.js`
import nothing from `src/payments/`. The provider is three methods — `createDraft`,
`send`, `get` — behind one resolver. Adding a provider means writing those three, not
touching allocation.

## 2026-11-02 — Payment plan, as decided by the owner

- **The seller is a fictional landlord, not Hearth.** One sandbox business account
  represents the fictional landlord as the seller of record, and the invoicer on
  every invoice is that account. Partner onboarding and `PayPal-Auth-Assertion` are
  **not** implemented. This keeps the demo's money flow shaped like the production
  one — landlord as merchant — without the partner machinery.
- **Payment records persist; fictional data does not.** Provider invoice IDs,
  idempotency keys, approval versions and send outcomes are written to a small local
  store that survives a server restart. The fictional UI dataset still resets on
  restart. Resetting that data must never make Hearth forget an invoice that really
  exists at the provider, so the two stores are separate and only the payment store
  is durable. No credential is ever written into it.
- **Status comes from an operator-triggered refresh.** A "Refresh status from
  PayPal" action re-reads the invoice. The webhook receiver is **deferred**, not
  faked: with no receiver, there is no code path that could accept an unverified
  payment claim.
- **Idempotency is verified per endpoint, not assumed.** `PayPal-Request-Id` is
  documented on invoice creation. Whether the send endpoint honours it is a separate
  empirical question, and the same goes for what a replayed request actually returns.
  Each endpoint gets its own check against the sandbox before it is relied on.

## 2026-11-02 — Hackathon rules, confirmed by the owner

The official rules allow a significantly updated existing project. Deadline:
**November 12, noon Pacific / 3:00 p.m. Eastern.** This resolves the open question
that had blocked the reuse plan.

## 2026-11-03 — What the live sandbox run actually proves

Recorded as evidence, separated from what it does **not** show. Invoice
`INV2-G3MC-Q3PB-28UZ-E7MM`, $680.00, allocation version `b6af47b9`.

**Proven: duplicate prevention survives total local memory loss.** The draft was
first created by `scripts/verify-paypal-sandbox.mjs`, which writes nothing to the
payment store. The store file did not exist. The server was then restarted on new
code. Hearth was asked to prepare the same invoice and returned `adopted: true`
bound to the *same* `providerInvoiceId` — no second invoice at PayPal.

This works because the invoice number is **derived**, not remembered:
`H-WC3A-ER2026-DEVI-b6af` is a function of property, period, resident and the
allocation version hash. PayPal rejects the duplicate number, Hearth lists and
adopts. So the guarantee does not depend on local state being intact, which is the
only version of that guarantee worth having. `PayPal-Request-Id` did **not** dedupe
the create on this account (2026-11-02), so `detail.invoice_number` uniqueness is
load-bearing and this run is what confirms it end to end.

**Proven: the approval binds to an exact allocation.** `POST send` without
`allocationVersion` is refused (`VERSION_REQUIRED`); with a stale one, refused
(`STALE_ALLOCATION`). A draft created against different amounts is refused
(`STALE_DRAFT`). Approving is authorization for one set of numbers, not for the
resident in general.

**Proven: sending needs a separate, explicit act.** `POST send` without
`confirmed: true` returns `CONFIRMATION_REQUIRED` (400). Preparing a draft and
authorizing a send are two decisions with two API calls.

**Not shown by this run, and not to be claimed:**

- **Nothing has been sent.** `providerStatus` is `DRAFT`, `paymentState` `draft`.
- **Nothing has been paid.** `paidCents: 0`, `dueCents: 68000`.
- The `recipient_view_url` is live on an *unsent* draft. A reachable link is
  therefore not evidence that an invoice was sent, and not evidence of payment.
- Whether the **send** endpoint honours `PayPal-Request-Id` is still unverified.
  It is a separate empirical question from create, and is not relied on: the
  `send_uncertain` state exists precisely because it is unknown.
- Payment state will be taken from a `GET` against PayPal, never from the browser.

## 2026-11-03 — A derived-identifier collision that would have mis-bound invoices

**Found by review, not by a test.** All 154 tests passed with this present.

`invoiceNumberFor` built the invoice number from readable parts:

```js
const slug = (v, l) => String(v).replace(/[^a-zA-Z0-9]/g, "").slice(-l).toUpperCase();
`H-${slug(propertyId,5)}-${slug(periodKey,6)}-${slug(personId,4)}-${versionLabel.slice(0,4)}`
```

Two defects, which compound:

1. **`slug` takes the TAIL.** Every month ending in "ber" collapses to the same six
   characters. `september-2026`, `october-2026`, `november-2026` and
   `december-2026` **all** slug to `ER2026`. Four of twelve months.
2. **The version label was cut to four hex characters** — 65,536 values — so two
   different allocations collide at roughly 1 in 65,536.

Together: two different months for the same resident could produce one invoice
number. `createDraft` would then get `DUPLICATE_INVOICE_NUMBER`, call
`findByInvoiceNumber`, match **on the number alone**, and adopt the *other month's*
invoice. The store would bind December's record to November's invoice. **Hearth
would report a resident as invoiced for a month they were never invoiced for**, and
the hosted link in the review panel would be the wrong month's.

A third defect in the same path: `findByInvoiceNumber` listed the **first 100**
invoices and scanned them, so adoption silently stopped working once the merchant
had more than 100 invoices.

### What changed

- **The readable prefix is now cosmetic.** `H-WC3A-NOV2026-<10 hex>`, exactly 25
  characters, never truncated. The month is head-sliced, so NOV and DEC differ.
- **All uniqueness lives in the digest**, over property, period, resident,
  allocation version **and billing destination**.
- **The destination joined both derivations.** It was absent before, which made "the
  resident changed their billing address" indistinguishable from "retry the last
  request" — a replayed `PayPal-Request-Id` could have returned the invoice
  addressed to the old address while Hearth reported the new one.
- **Adoption now verifies before binding.** `assertSameInvoice` compares
  `detail.reference` (which carries the FULL version label, unlike the number),
  amount, currency and recipient. A mismatch raises `ADOPTION_REFUSED` rather than
  binding. A recipient mismatch is a refusal, not a correction.
- **Lookup is by server-side filter**, `POST /v2/invoicing/search-invoices` with
  `invoice_number`, not a list-and-scan.
- Eight regression tests, including one that asserts the four "ber" months produce
  four distinct numbers.

### What this says about the tests, again

The same lesson as 2026-11-02 in a new place. Every test that touched invoice
numbers asserted a **property** of the output — "at most 25 characters" — and none
asserted **distinctness across inputs**. A length assertion cannot fail on a
collision. The new tests compare outputs for inputs that must differ.

## 2026-11-03 — Verified external facts (primary sources)

- **`billing_info.email_address` is OPTIONAL** on a PayPal invoice. PayPal's own
  OpenAPI specification declares no required fields on `billing_info`, and the
  reference page lists `email_address` as optional. So an invoice **can** be created
  without any email address. `phones` is also optional; when a phone is supplied,
  `country_code`, `national_number` and `phone_type` are required on it.
  **Consequence:** a phone-first billing contact is possible. With no email,
  PayPal has nothing to notify, so the send must use `send_to_recipient: false` and
  the hosted `recipient_view_url` becomes the only delivery route — which is Hearth
  sending the link over SMS. Not yet confirmed empirically against the sandbox.
- **`POST /v2/invoicing/search-invoices` accepts `invoice_number`** in its request
  body, `maxLength` 25. Confirmed in PayPal's OpenAPI specification. This replaces
  the list-and-scan adoption lookup.
- **TCPA: rent messages need prior express consent, not prior express *written*
  consent.** 47 CFR 64.1200(a)(1) applies the prior-express-consent standard to
  autodialed or prerecorded calls and texts to wireless numbers, and does not
  specify a form. (a)(2) requires prior express **written** consent only for calls
  or texts that "include or introduce an advertisement" or "constitute
  telemarketing", with written consent defined at (f)(9).
  **The compliance boundary is therefore CONTENT, not purpose:** a rent reminder
  carrying a payment link is informational; the same message that also promotes
  renters insurance, a referral bonus or an amenity becomes telemarketing and needs
  a different, written consent.
  Also load-bearing:
  - **(a)(10)** — consent may be revoked "by using any reasonable method", requests
    must be honoured within **ten business days**, and a sender **may not designate
    an exclusive means** of revocation. So "Reply STOP" may be *offered* but cannot
    be the only route Hearth honours.
  - **(a)(11)** — revocation by another route, such as a reply to an email, creates
    a rebuttable presumption that consent was revoked.
  - **(a)(12)** — a single confirmation text acknowledging a revocation is
    permitted, provided it carries no marketing content.
  This is a reading of the regulation text, not legal advice, and recent FCC
  amendments in this area were not verified against the Federal Register.

## 2026-11-03 — Decisions taken by the owner

- **SQLite for durable records; Postgres later.** `node:sqlite` is built into the
  installed Node (v24.19.0, verified available unflagged with working transactions).
  Durable records get real transactions and real foreign keys without adding a
  dependency. The pilot migration is deferred and is **not** to be applied.
- **The README's storage claim is reworded, not quietly kept.** It previously said
  "It cannot reach a database. There is no driver and no connection string." A
  SQLite-backed store makes that false. It now claims what stays true: all storage
  is local, there is no connection string and no remote host, and no row leaves the
  machine. Changing the storage while leaving the old sentence standing would have
  been worse than not changing the storage.
- **The hackathon submission may behave as a PayPal mirror; the product must be a
  ledger.** For the submission, invoice and payment state read from PayPal is
  enough to show the workflow. For the real product Hearth needs its own ledger,
  because a mirror cannot represent an off-platform payment, a partial settlement
  between housemates, or a second payment provider. The ledger is the thing that
  makes a second provider an addition rather than a rewrite.

## 2026-11-03 — Mutation audit: testing the tests

Prompted by the owner's objection, which was the right one to raise: the suite keeps
going green while real defects ship, so what is a passing run actually worth?

The method: break the payment code on purpose, one change at a time, and check that
the suite notices. Kept as `npm run test:mutation` so the claim is repeatable rather
than a one-off. 16 mutations, including three written specifically to be sneaky (a
comparison pointed at the wrong field, a filter that never reports, a comparison of
a value against itself).

**First run: 15 killed, 1 survived.**

### Finding 1 — the currency check was not covered at all

Deleting the currency comparison from `assertSameInvoice` broke **no test**. $680 USD
and $680 CAD would have been treated as the same invoice.

### Finding 2 — a test was passing for the wrong reason

This is the more important one, and it is exactly the failure mode the owner named.

`adoption is REFUSED when the existing invoice is not the one we meant` varied the
reference **and** the amount. So with the reference check deleted the test still
failed — but on the error message, not the behaviour. The captured assertion proves
it:

```
AssertionError: ... it was NOT adopted. amount: existing "700.00", intended "680.00"
```

Reference is not mentioned. The amount caught it.

**Why that matters here specifically:** rent is the same every month. The same
resident owes the same share in November and December, so `amount`, `currency` and
`recipient` are all **identical** between the two. `detail.reference` is the *only*
field that can distinguish them. A test that also varies the amount is therefore
testing a case that cannot occur, and leaving the real one — identical rent, one
month apart — uncovered. That is the exact scenario the invoice-number collision
produced.

### Finding 3 — one assertion is defence in depth, not live coverage, and now says so

`the four 'ber' months cannot share an invoice number` cannot fail from an ambiguous
readable prefix alone, because the digest carries the uniqueness. The audit shows it
only fails when the prefix is ambiguous **and** the digest is removed. It is kept —
it states the property that matters and would catch uniqueness moving back into the
readable part — but the test now says in its own comment that this is what it is.
A guard that cannot fire should not look like one that can.

### What was added

Four tests. The three refusal tests each isolate **one** discriminator and assert
`mismatches` is *exactly* that field, so deleting any single check fails exactly one
test:

- `adoption is refused when ONLY the month differs, at identical rent` — the real case
- `adoption is refused when ONLY the amount differs`
- `adoption is refused when ONLY the currency differs`
- `the readable part names the month unambiguously` — split out from the distinctness
  assertion so each has one job

**Second run: 16 killed, 0 survived, 0 skipped.** 165 tests pass, 1 todo.

### The rule this gives us

> A refusal test that varies two fields at once still passes when one of the two
> checks is deleted. Isolate one field per test, and assert *which* field caused the
> refusal, not just that one did.

And more generally: a test that asserts a **property of one output** ("at most 25
characters", "it throws") cannot catch a collision or a wrong-reason pass. Assert
**relationships between outputs** for inputs that must differ.

A skipped mutation is a stale anchor, not a pass. The script exits non-zero on
either a survivor or a skip, so it cannot quietly degrade.

## 2026-11-03 — Signup captures both email and phone

Decided by the owner. PayPal emailing the recipient stays a **supported channel**,
not a dropped one, so signup must collect **both** an email address and a phone
number rather than one or the other.

Consequence for §11 of the proposal: `billing_profiles` keeps both columns and the
`check (email is not null or phone is not null)` stays as a floor, but the signup
flow asks for both and each is verified **independently** — a token delivered to the
address it verifies. `preferred_channel` then selects delivery without discarding
the other:

- both verified → PayPal emails the invoice **and** Hearth texts the hosted link
  (`send_to_recipient: true`), which is the default agreed on 2026-11-02
- only the phone verified → `send_to_recipient: false`, hosted link by SMS
- only the email verified → PayPal emails it, no text

So an unverified channel degrades delivery rather than blocking it, and a resident is
invoiceable as soon as **one** channel is verified — while the product still asks for
both, because two routes to a payment notice is better than one.

## 2026-11-03 — Live sandbox: invoice sent, and what that established

Invoice `INV2-G3MC-Q3PB-28UZ-E7MM`, $680.00, allocation version `b6af47b9`, sent
through Hearth's own `POST /api/payments/send` on the owner's instruction.

Read back **directly from PayPal**, not from Hearth's report:

```
status:          SENT
amount:          680.00 USD
due_amount:      680.00
payments.paid:   (none)
payments.txns:   0
invoice_number:  H-WC3A-ER2026-DEVI-b6af
reference:       wc-3a/november-2026/b6af47b9
```

- **Sent is recorded as sent, not paid.** `paymentState: "sent"`, label "Invoice
  sent · not paid", `paidCents: 0`, `dueCents: 68000`.
- **A retried send does not resend.** The second call returned `alreadySent: true`
  and made no provider call.
- **A draft request after sending does not create a second invoice.** It returns
  `alreadySent` with the existing record.
- **Still not paid.** Nothing in this run says anything about money arriving.

## 2026-11-03 — Bug found in the adoption fix itself

The fix recorded earlier today introduced a defect that would have broken the very
path it was hardening. Found by probing the live sandbox rather than by any test.

`POST /v2/invoicing/search-invoices` returns a **summary**, not a full invoice:

```
keys: id, status, detail, invoicer, primary_recipients, amount, due_amount, links, unilateral
items: MISSING
```

`assertSameInvoice` compares `items[0].unit_amount.value` and `.currency_code`. Against
a summary those are `undefined`, so an intended amount of `"680.00"` was compared to
`null` — **every legitimate adoption would have been refused** with
`ADOPTION_REFUSED`. The one safety net for a lost create response would have failed
closed.

`fields` does not help: `fields: ["items"]` returns HTTP 200 and still no items, and
`fields: "all"` is a 400 schema error.

**Why no test caught it:** the fake search reply in `tests/paypal-client.test.js` was
written from the *full invoice* shape, so it contained `items`. The test passed
against a response PayPal never sends. This is the 2026-11-02 lesson in a third
place — and it is the limit of the mutation audit, worth stating plainly:

> **Mutation testing checks the tests against the code. It cannot check the code
> against the world.** A fixture that misdescribes an external API passes every
> mutation and every assertion. Only a live probe catches that.

**Fixed:** adoption now re-reads the full invoice with `get(id)` after finding it by
number, and verifies against that. `get` was already documented as the authority.
One extra call on a rare path, in exchange for the path working at all.

Also: every adopt fixture now drops `items`, matching the live shape, and a new
mutation ("adoption verifies the search SUMMARY instead of re-reading") fails the
suite if anyone reverts it. 17 mutations, 0 survive.

## 2026-11-03 — Second bug: a write route the interface could not open

`POST draft` for an invoice that was already sent returned `{ alreadySent, record }`,
while every other write route returns `{ ..., review }`. `public/app.js` calls
`openInvoiceReview(property, result.review, …)`, which then reads `.invoice` off
`undefined`: **a blank panel and no error message.**

Reachable with two operators — one prepares and sends while the other still has a
stale sheet offering "Prepare invoice". That is exactly the concurrency the design
is supposed to handle.

Fixed by returning `review` from that branch as well (`record` kept so nothing
depending on it breaks), with a test asserting all three write routes return a
review the panel can open, and that the already-sent one does not claim paid.

## 2026-11-03 — Open question to settle on payment

`src/payments/state.js` applies "amounts win over the label" in one direction only.
A status of `PAID` with a residual `due_amount` is correctly downgraded to
`partially_paid`. But `PAID` with **no** `payments.paid_amount` stays `paid` while
`paidCents` is recorded as 0 — the label would say "Paid in full" next to a
zero-cent record.

Whether PayPal can actually return that combination is unverified. It should be
checked the moment the sandbox invoice is paid: if `payments.paid_amount` is
populated on a real payment, the case is theoretical; if it can be absent, the
reconciliation needs to report `unknown` rather than `paid`. Recorded rather than
guessed at.

## 2026-11-04 — The sandbox payment completed, and what it resolves

The owner paid invoice `INV2-G3MC-Q3PB-28UZ-E7MM` as the sandbox Devi account. One
refresh, no create, no send:

| | Before paying | After paying |
|---|---|---|
| `providerStatus` | `SENT` | `PAID` |
| `paymentState` | `sent` | `paid` |
| label | Invoice sent · not paid | **Paid in full** |
| `paidCents` | 0 | **68000** |
| `dueCents` | 68000 | **0** |

**This closes the open question recorded on 2026-11-03.** That question was whether
PayPal can return `PAID` with no `payments.paid_amount`, which would have let
`state.js` report "Paid in full" next to a zero-cent record. On a real payment the
field **is** populated: `paidCents` is computed only as
`amountToCents(invoice.payments?.paid_amount) ?? 0`, so a value of 68000 could not
have been produced by an absent field. The defect is therefore theoretical, not
reachable through an ordinary payment, and the one-directional reconciliation stays
as it is.

Deduced from the mapping rather than from a dump of the raw provider object, because
reading it directly needs credentials a new process no longer has. Worth confirming
with one direct read once they are restored — the conclusion is sound but it is an
inference, and this log distinguishes the two.

**The whole collection path is now demonstrated end to end**: authenticate → draft →
version-bound approval → explicit send → pay at the provider → authoritative status
read, with repeat-send protection, duplicate-create protection and restart
persistence along the way. Restart persistence of the **paid** state specifically is
still outstanding, blocked on credentials.

What this does **not** establish: production readiness, webhook-driven status,
multi-household concurrency, correction after issuance, or any payment edge case
beyond a single full payment of a single invoice.

## 2026-11-04 — Mode switching never touches credentials

`.env` had been overwritten with `.env.example`'s placeholders and
`PAYMENTS_MODE=offline`, which made every new process offline and left the sandbox
credentials only in the memory of a server started the previous day. They were not
recoverable from it: `node --env-file` populates `process.env` within the process and
does not alter the OS-level environment, so `ps eww` exposes only the inherited shell
environment, which never carried them.

Settled: **credentials are never erased or replaced to change mode.**

- `.env` holds the real sandbox credentials permanently, mode `paypal_sandbox`.
- Offline mode is a **process-level override**, not a file edit.
- `.env.example` remains the unchanged template.

Verified empirically rather than assumed:

- A shell variable takes precedence over the same key in an env file. In the same
  run the file still supplied an unrelated key, which proves the file was loaded and
  the key overridden rather than the file being ignored.
- `npm run demo:offline` does not read `.env` at all — it sets
  `HEARTH_MODE=offline PAYMENTS_MODE=offline` inline — so it is offline by two
  independent mechanisms.

## Open — awaiting a decision

- **The duplicate repository.** `paypal-hackathon-2026` is a second public remote
  holding a one-commit scaffold of this same submission. The owner has asked that it
  be left **unchanged** for now, so nothing has been done to it. It remains a loose
  end for submission day: a judge following that link would find an empty project.

## Restart persistence, verified against a restored `.env` (2026-11-04)

The check the previous entry said was blocked is done. Order matters here, so it is
recorded as a sequence rather than a result:

1. A fresh process authenticated — HTTP 200, invoicing scope present — before anything
   else ran, so the restart was not attempted on credentials that might not work.
2. The old server (PID 891, holding the only in-memory copy of the credentials) was
   stopped. A new one started and resolved sandbox mode on its own.
3. The new process returned Devi's invoice `INV2-G3MC-Q3PB-28UZ-E7MM`, PAID, $680.00
   paid, $0.00 due, **with `lastCheckedAt` still set to the previous process's reading
   at 21:46:58Z.** A reading the new process had not taken is the evidence: the value
   came off disk.
4. Only then was the provider re-read, which agreed.
5. The store's history was diffed against a pre-restart copy: 6 events before, 7 after,
   the first 6 byte-identical, nothing rewritten.

The sequence is the point. Reading the provider first would have produced the same
numbers and proved nothing about persistence.

### `payments.paid_amount` is no longer an inference

Yesterday this was deduced from the mapping in `state.js`. A direct read now shows
`payments.paid_amount = {"currency_code":"USD","value":"680.00"}` and one transaction
(`PAYPAL` / `SALE` / `SUCCESS`, 2026-11-04T13:00:30Z, $680.00). The theoretical case —
`PAID` with no `paid_amount`, which would have displayed "Paid in full" beside zero
cents — does not arise on an ordinary payment. The guard stays; it is simply not the
path a real payment takes.

### One invoice exists, in total

`GET /v2/invoicing/invoices?total_required=true` reports `total_items: 1` for the entire
sandbox account. That is the strongest available statement about duplicate prevention:
not "the tests say no duplicate was created," but "the provider has one invoice after
every draft, repeat-send, restart and recovery test run against it."

### A limitation the verification exposed

The live invoice's number, `H-WC3A-ER2026-DEVI-b6af`, is from the scheme that was
replaced after the collision bug. Current code computes `H-WC3A-NOV2026-9e4180d68e` for
the same derivation. Two read-only lookups confirmed it: the old number finds the
invoice, the new one returns nothing.

Consequence: adoption-by-number cannot recover *this* invoice if the local store were
lost. The store is what stands between a lost record and a duplicate charge, and it
survived the restart intact. The Nov 3 "store deleted" test passed under the old
numbering; it would not pass against this record now. Proving that would require
creating a second invoice, which was excluded, so it is recorded as reasoned and
unverified rather than as a passing check. A new invoice issued under the current
scheme adopts correctly, so no code change follows from this.

### On `localState` resetting after payment

Raised by the owner: `localState` should keep describing recipient and send
confirmation, and could potentially reset once payment is confirmed. Recorded, not
implemented. The risk is that `localState` is also what prevents a second send, so
resetting it on payment would make a paid invoice look sendable again. If it changes, it
should gain a terminal value (`settled`) rather than return to an earlier one — a
lifecycle that only moves forward. Deferred to the allocation workspace, where the
status ladder will need it.

## The listing-based scenario (removed 2026-11-05), the shared allocation workspace, and three fixed divergences (2026-11-04)

### The two ports

Both modes defaulted to 8888, so starting the second one failed with Node's bare
`EADDRINUSE` — a message naming neither mode nor a remedy. Offline mode now defaults
to **8889**, and the server catches the error and prints what is listening, how to
look, how to pick another port and how to stop it. The two demos are meant to run at
the same time: one to review the interface, one to verify against the sandbox.

### A fixture that silently defeated the invoice numbering

The listing-based fixture (removed 2026-11-05, see below) used `periodKey: "2026-11"`. `invoiceNumberFor` takes the
month from the letters in the period key, so that yielded month `""` and year `2611`:
`H-NIT5-2611-…`, with the readable half gone and nothing thrown. The existing test
"the readable part names the month unambiguously" could not catch it, because it
tests the function against its own inputs, not against a fixture.

Fixed on both sides, deliberately:
- the fixture uses `november-2026` (`2026-11` kept as `periodIso`), and
- `readPeriodKey` now **refuses** a key that does not name a month and a four-digit
  year. A provider invoice number is permanent once PayPal has it, so an unreadable
  key is a configuration error raised where it is introduced. All twelve month names
  are accepted; `"foo-2026"` is not.

### One allocation implementation, because there were two

Offline mode built its own view of the split in the browser (`offlineRentView`), with
`blockedReason` hardcoded to `null`. Server mode refused issuance with
`ALLOCATION_DOES_NOT_BALANCE`. So the listing-based walkthrough's central moment — a draft
that saves while collection stays blocked — was **false in offline mode**, which is
the mode used for interface review.

Now: `src/allocation-state.js` holds the version rules, the blocking reasons and the
status line, with no Node import, and `server/allocation-api.mjs` runs in both the
local server and the offline bundle. Only storage differs, and it differs honestly: a
local JSON file on the server, memory in the page. A test asserts the two modes
produce the same difference, the same canonical version, the same blocking reason and
the same status headline, and differ only in whether a provider is available.

### The dashboard card could not say anything

The Rent card rendered only `if (state.demoMeta.rentActivity[property.id])` — fixture
metadata — while the panel it opened read the API. That scenario had no such entry, so it
would have shown **no Rent card at all**: the blank widget the Rent workspace
proposal ruled out. The card now calls the same status function as the panel.

Two further instances of the same disagreement turned up while testing it:
- Publishing from the sheet left the card behind it reporting the previous version.
  The page behind now refreshes with the sheet.
- "Nothing needs you right now" appeared above a card saying a draft was waiting to be
  published. Rent work the landlord has to do is now an attention item, ranked above a
  routine applicant check when blocked or uncertain and below a person waiting on an
  answer.

### Decisions taken while building

- **A version number changes only when the people who must agree change** (settled by
  the owner, 2026-11-04). Editing a draft stays in that version: a draft is private
  working state, and nudging a share four times should not mint v2 through v5.
  Editing numbers residents have already been *shown* always creates a new version.
  Safety does not rest on the number: a confirmation is bound to the canonical
  fingerprint of the exact amounts confirmed, and that changes on **every** edit,
  draft included — so an edit inside a draft still invalidates a confirmation that
  matched it. The number is for people to talk about; the fingerprint is what the
  rules run on. An edit landing on the same numbers creates nothing.

  (An earlier build incremented on every edit so the walkthrough would read v1 → v2
  → v3 as written in the proposal. The proposal has been corrected instead; the
  walkthrough stays on v1 and the fingerprint beside it moves.)
- **Confirmations bind to the canonical form, not the version number.** Moving $40
  between two residents at an unchanged total drops every confirmation, and the
  earlier confirmation stays visible as "confirmed v3 · not these numbers" rather than
  being erased.
- **A dataset may seed an already-agreed split.** Willow Court's household settled
  before Hearth saw it and an invoice exists against those exact numbers, so its
  residents read "Agreed · on file" instead of being asked to confirm a settled
  figure. Any real confirmation takes over from the seed.
- **Resetting a walkthrough is refused once invoices exist.** Clearing a draft must
  never leave a provider invoice pointing at numbers nobody approved.
- **Dataset choice is fixed at process start or bundle build**, never per request: the
  operator's organization scope is computed once at load and the payment store is
  keyed by property id.

### A build that reported one scenario and shipped another

The first version of the offline dataset define guarded the whole lookup with
`typeof process === "undefined"`, so the browser took the undefined branch and loaded
the default scenario while the build log printed the second scenario's name. Caught by reading
the generated bundle rather than trusting the build message. The compiled value is now
checked first, and the bundle shows `if ("<dataset>") return "<dataset>"` with the chosen name.

### Verified

Willow Court is unchanged: version `b6af47b9`, Devi's invoice
`INV2-G3MC-Q3PB-28UZ-E7MM` still `PAID`, $680.00 paid, $0.00 due, `stale: false`. The
second scenario's ids reach none of it. Allocation edits on `wc-5b` survived a server restart and
were reset afterwards. 183 tests pass. That scenario had no sandbox recipient
mapped, so it cannot issue an invoice at all.

## What the Willow Court sandbox walkthrough can actually show (2026-11-04)

Recorded because the answer is bounded by one fact: **only `p-3a-devi` has a sandbox
recipient mapped**, and Devi's invoice is already paid.

Demonstrable live, today, against the real sandbox:

| Step | What is shown | How it is proven |
|---|---|---|
| Approved split | v1 `agreed`, $3,200.00 allocated, $0.00 difference, fingerprint `b6af47b9` | — |
| The review panel | amount, billing period, seller, allocation version, invoice number, environment, provider invoice id, paid/due | `Open invoice` on Devi's row |
| A real payment | `INV2-G3MC-Q3PB-28UZ-E7MM` · `PAID` · $680.00 paid · $0.00 due | `Refresh status from PayPal` re-reads the provider |
| Duplicate protection | re-preparing Devi returns `alreadySent: true` bound to the same invoice id; no second invoice is created | one API call |
| Refusal, not substitution | Ada returns `RECIPIENT_NOT_MAPPED` and names the file and key to fix | one API call |
| Correction discipline | Devi's share renders as text, "Invoiced · use a correction", not an editable field | the row itself |
| Restart persistence | the PAID state and the nine-event history survive a restart | stop and start the server |

**Not demonstrable live without a decision:** the create → review → send → pay →
refresh arc from scratch. Devi's is already paid and nobody else is mapped, so there
is nothing to issue. Two ways to restore it, neither taken yet:

1. **Map a second sandbox Personal account** to Ada, Bo or Cam. Costs one sandbox
   account; gives a fresh invoice on the same period and household.
2. **Add a December 2026 period.** The store key is `property:period:person`, so a new
   period is a new record and a new invoice number for the same resident. Costs a
   dataset addition; keeps the single mapped account.

Option 1 is the smaller change and keeps November as the one finished story. Option 2
also demonstrates that a period is a real boundary rather than a label. Either way,
nothing should be re-issued against November for Devi.

## Interface pass one: Home, Rent, and the green column (2026-11-04)

Owner's review of the live demo. Pass one covers structure; pass two covers Messages,
Residents and the remaining typography.

### "Agreed · on file" contradicted the pitch

Flagged by the owner: Hearth's case to PayPal is that it *gets households to agree*.
A screen reporting that a household agreed somewhere else, before Hearth, argues the
opposite. Willow Court's fixture now records **when each resident confirmed** — Ada
and Bo on Oct 24, Devi Oct 25, Cam Oct 26, landlord approval Oct 30 — and the rows
read `Confirmed Oct 24`. Same underlying state; it now shows Hearth doing the work
rather than reporting someone else's outcome.

### Rent is a page, not a card

It was reachable only by opening Today and clicking a card. For the feature this
build exists to demonstrate, that was the wrong depth. Rent is now the **second item**
in the navigation, with a page of its own: the collection ring, a bolded-label fact
list, and one row per resident showing their person id, their share, when they
confirmed, and what the provider says. The workspace sheet is one click from there
and unchanged.

### Home

`#home` is now the default route, and Today keeps its attention list. Home is two
hero cards (rent with the ring, and what needs a person), a 2×2 of tiles, then a row
of three. Every card is a door into the page that owns the detail.

### The column is green

The one piece of chrome always on screen. The mark is the home control, the
navigation is inset to its right so the logo reads as what they hang from, and
Settings sits at the foot above Lock. The demo pill shrank to a footnote: it was
competing with the page title.

### Money shows both decimals

`$2,520` and `$680.00` in the same column. The general formatter drops decimals on a
whole number, which is right for a lease figure and wrong beside collected amounts.
Rent and collection surfaces now always show cents.

### Claims removed, because they are no longer true

- Leasing said *"Hearth doesn't track rent payments or balances."* It links to Rent now.
- A resident's sheet said a share was *"as entered · payments not tracked."*
- `model.js` said there is deliberately no collected/outstanding. There is — it
  belongs to a billing period and comes from the provider, not from the lease record.

### Second sandbox recipient

`p-3a-ada` is now a key in the local mapping with a `REPLACE-…` placeholder. `config.js`
filters out any value containing `REPLACE`, so Ada is still reported as unmapped and
the *Prepare invoice* button does not appear until a real sandbox Personal address is
pasted in. A key that looked mapped but was not would be worse than no key.

## Interface pass two, and the Home/Today split (2026-11-04)

### Home is the glance, Today is the queue

Settled with the owner. Home's "Needs you" card used to quote the first attention
item's text, which put a resident's actual message on the resting page and made the
two screens the same screen at different sizes. It now counts and categorises —
"3 things · 1 needs your answer · 1 applicant check · 1 rent · open Today to work
through them" — and stops there. Today is unchanged: it remains the working queue.
Home stays the default route, since that is where a landlord starts.

### Status chips were five warnings at once

Saturated fills on a white list read as five alarms competing. The colour now lives
in a left bar and the dot, the fill is a quiet tint of the same hue, and the text
stays near-black so a row is legible first and categorised second. `urgent` keeps a
solid fill, because it is the one that should interrupt.

### The hover the owner liked, made deliberate

Message threads and resident rows are separate cards now, and hovering lifts them
with a shadow and a green edge — the same response as the Today widgets, rather than
a flat grey wash. Keyboard focus gets the identical treatment, so it is not a
mouse-only affordance, and `prefers-reduced-motion` drops the movement.

### Residents act without opening the person

Each row carries this period's agreed share, what the provider last said about it,
renewal state, consent, and two actions — Rent and Text. A `<button>` cannot nest
inside another, so the actions are `role="button"` spans with Enter/Space handlers
and `aria-disabled` on a resident who opted out of texts.

### A latent bug the Rent page was hiding

`recipientMapped` was never carried by the allocation view, so every row evaluated it
as `undefined` and rendered "No billing destination". That was accidentally correct
while exactly one resident was mapped — and would have stayed wrong the moment Ada
was added. The provider bundle now injects `mappedPersonIds` and the view reports it
per resident. Two tests pin it: with one id mapped only that resident reports true,
and with no provider nobody does.

### Narrow widths

The green had to come with the column when it becomes a bottom bar, and the
vertical-only touches — the inset nav, the divider above Property, the stacked
footer — had to come off, or Property sat below the row it belongs to.

## Palette: white and green, with warning colour earned (2026-11-04)

Owner's direction: the goal is a product a landlord *wants*, not one that satisfies a
checklist. Three changes.

**Five hues were doing categorisation work** — green, blue, purple, amber, red — and
on a white list they all shouted at once. Blue was carrying "needs your decision",
which in a green product is just the product's own colour. Purple was carrying
"undelivered", which is a warning, not a third family. Both are gone: `--blue` and
`--blocked` now resolve to the green and amber already in use, so nothing in the app
can reintroduce them by referencing a token. Green is the interface. Amber and red
appear only where something has escalated — an urgent message, a text that never
arrived, a payment Hearth cannot account for. If everything is coloured, nothing is.

**The column met the page at a 1px line**, which reads as two applications side by
side. It now carries its own soft inner highlight, throws a wide low-opacity shadow
onto the canvas, and a 30px gradient carries the green a little way into the page
before fading out. The canvas itself gained a breath of the brand (`#f3f6f4`) so the
green does not meet a clinical white, and the column's own fill runs light at the top
to deep at the foot rather than sitting flat.

**The cumulative difference needed a click to see.** It is now a row of its own on
the Rent page, shown *even when it is zero* — `$0.00 · matches` in green, `$50.00
short` in amber — alongside a Collected row with what is outstanding. Balanced is a
fact a landlord should be able to read, not infer from an absence, and finding it
should not require opening the workspace. The Home hero carries the shortfall too
when there is one.

## Meeting demonstrations without real property data in the tree (2026-11-05)

The listing-based scenario added on 2026-11-04 put a real address, a public listing
URL and the advertised rent into the committed tree. `docs/BOUNDARIES.md` rule 4
forbids exactly that ("no real company or property, even from public sources"), and
the rule is kept rather than weakened. The scenario, its source note and its
proposal mockups are removed from the tree. They remain in git history, so a public
version still needs the clean-history export described in the README.

What replaces it is a capability, not a property:

- `data/meeting-scenario.mjs` builds a scenario from a small profile: a property
  label as given for the meeting, an illustrative household total, a period and a
  fictional household with opening shares. Unknown keys are refused, so there is no
  field for a lease term, a contact or a listing source; text with a common contact,
  account or listing shape (email, URL or domain, phone, long digit runs, `$`) is
  refused, labels are plain ASCII, names carry no digits, and the period must be a
  month and year. This is a seatbelt, not proof: code cannot tell whether a name is
  fictional, so keeping resident names fictional stays the presenter's job.
- Every id is fixed in that module and shares nothing with Willow Court, so a meeting
  profile cannot attach to an existing organization, resident, invoice, payment
  record or recipient mapping.
- The interface says what is given for the meeting (the address only), what is
  invented, and what is unknown: the actual rent, bedrooms and bathrooms, room sizes,
  the lease and its dates, the payment schedule, availability and how the property is
  managed today.
- `fixtures/meeting-profile.example.json` is committed and fictional. A real
  meeting's profile lives in `.hearth-local/meeting-profile.json` (gitignored), and
  only `npm run build:meeting` reads it, into `dist/meeting/` (also gitignored). That
  build is the offline page with the simulated provider only; it carries no other
  scenario, and it refuses to build if any local path or Willow Court text reaches
  the bundle.

What Kamsi's scenario asked for is kept: separate ids, an unpublished draft as the
opening state, an illustrative total labelled as such on screen, unknown room facts
shown as unknown, and no invoice or recipient mapping inherited from Willow Court.
What changed is that the household total no longer comes from a listing, and the
address is no longer in the repository.
