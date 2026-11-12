# PayPal sandbox setup

What to create at PayPal, and exactly which local fields to fill in. **Nothing in
this file should ever be pasted into a chat, an issue or a commit.**

## What you need at PayPal

| Thing | Role here |
|---|---|
| Sandbox **Business** account (US) | the **fictional landlord**, seller of record on every invoice |
| Sandbox **Personal** account (US) | the fictional resident who receives and pays the invoice |
| Sandbox **Merchant REST app**, associated with that Business account | supplies the client ID and secret the server authenticates with |
| The **Invoicing** feature, enabled on that REST app | without it the app authenticates and every invoicing call returns `403 NOT_AUTHORIZED` |

**Invoicing is not on by default.** A new sandbox app is created with a feature set
that includes Payouts but not Invoicing, and the difference is invisible until a
call is refused: authentication still returns `HTTP 200`, and the access token's
scope list simply has no invoicing entry. Enable it at **Apps & Credentials →
Sandbox → your app → Features → Invoicing → Save**. The client ID and secret are
unchanged by this; only the scopes on newly minted tokens change.

The REST app must belong to the Business account. PayPal only delivers webhook
events to the app that performed the action, and an app tied to the wrong account
cannot invoice as that account.

## Field 1 and 2 — `.env`

```sh
cp .env.example .env
```

Fill in, from the REST app's credentials page:

| Field | Value |
|---|---|
| `PAYPAL_CLIENT_ID` | the sandbox app's **Client ID** |
| `PAYPAL_CLIENT_SECRET` | the sandbox app's **Secret** |
| `PAYMENTS_MODE` | leave `offline` until the mapping below is filled in, then set `paypal_sandbox` |
| `PAYPAL_ENV` | leave as `sandbox` |

`.env` is gitignored, and `npm run demo` and `npm run verify:paypal` load it
automatically (`node --env-file-if-exists=.env`) — you do not need to export
anything into your shell. With `PAYMENTS_MODE=paypal_sandbox` and either credential
missing, the server **refuses to start** and says which one is absent. It never
falls back to a fake success — that is the whole point of having two named modes.

## Field 3 and 4 — the local account mapping

```sh
mkdir -p .hearth-local
cp docs/sandbox-recipients.example.json .hearth-local/sandbox-recipients.json
```

| Field | Value |
|---|---|
| `invoicer.sandboxBusinessEmail` | the sandbox **Business** account's email (looks like `sb-xxxxx@business.example.com`) |
| `invoicer.givenName` / `surname` | how the landlord's name should read on the invoice — any fictional name |
| `recipients["p-3a-devi"]` | the sandbox **Personal** account's email (looks like `sb-yyyyy@personal.example.com`) |

**Edit the copy, not the original.** `docs/sandbox-recipients.example.json` is
tracked by Git and must only ever contain `REPLACE` placeholders. The live values go
in `.hearth-local/sandbox-recipients.json`, which is gitignored. Filling in the
example file instead is an easy mistake — it is the file the instructions name — and
it puts your account addresses in the repository. `scripts/check-secrets.sh` now
blocks a commit that contains an email address in either path.

`.hearth-local/` is gitignored. `p-3a-devi` is Devi Sharma, the one resident in the
fictional scenario whose November share is still outstanding, which makes her the
natural first invoice. Map more residents only when you want more invoices.

Where to find the addresses: PayPal Developer Dashboard → **Testing Tools → Sandbox
Accounts**. The email shown there is the login, and it is the address to use.

## If calls fail with `403 NOT_AUTHORIZED`

Authentication succeeded and the app lacks the Invoicing feature. Enable it as
above, then run `npm run verify:paypal` again. To confirm what a token actually
grants, the scope list comes back with the token itself and an invoicing-enabled app
includes an entry containing `invoicing`.

## If authentication fails with `invalid_client`

PayPal returns `invalid_client` both for an unknown client ID and for a wrong
secret, so the error cannot say which. Check in this order:

1. **Sandbox, not Live.** The developer dashboard has a Sandbox/Live toggle. A Live
   app's credentials fail against the sandbox token endpoint with exactly this
   error. This is the most common cause.
2. **The secret is complete.** PayPal reveals a secret only when you ask it to, and
   a partial copy looks plausible but is not valid.
3. **Both values from the same app.** An ID from one app with a secret from another
   produces the same error.

To tell a bad ID from a bad secret: a client ID is public by design, so
`https://www.sandbox.paypal.com/sdk/js?client-id=<id>` returns HTTP 200 for a real
sandbox ID and an error for one that does not exist there. If the ID checks out, the
secret is the problem.

## Why the account emails are not in the fixture

The fictional residents in `data/willow-court.mjs` are invented people. Your sandbox
account addresses are real account details belonging to you. Mixing them would put
your account identifiers in a public commit and would make the fixture stop being
purely fictional. They are joined at runtime by resident id instead.

## What is NOT needed

- No live PayPal credentials. Ever.
- No partner or platform onboarding, no `PayPal-Auth-Assertion`. The Business
  account invoices as itself.
- No webhook configuration yet. Payment status is read by an operator-triggered
  refresh; the webhook receiver is deferred.
- No public URL or tunnel, for the same reason.

## Checking it before you rely on it

Once the four fields are in place:

```sh
npm test
npm run demo
```

The connection is proved by a real call, not by configuration looking right. The
first thing built against these credentials gets its own check: authenticate, create
one draft invoice, read it back, and confirm the draft is `DRAFT` and unsent. Until
that check passes, treat the setup as unverified.

---

# Walkthrough: one sandbox invoice, paid, then refreshed

Devi Sharma's **$680 November share** is the one share outstanding in the fictional
scenario, so it is the natural first invoice. Map her and nobody else.

## Step 0 — prove the connection before using the interface

```bash
npm run verify:paypal
```

This authenticates, creates one draft, **replays the create with the same
idempotency key**, and reads the invoice back. It prints what PayPal actually
returned at each step. If the replay comes back with the same invoice id, retries
cannot duplicate. It does not send anything.

A draft is created in your sandbox. The interface will adopt that same draft rather
than making a second one, because it derives the same key.

## Step 1 — open the rent allocation

```bash
npm run demo
```

Open <http://127.0.0.1:8888> and on Today click the
**Rent · November 2026** card.

You should see the monthly rent of $3,200.00, allocated $3,200.00, difference
$0.00 · matches, and an allocation version. Invoicing is blocked unless that
difference is exactly zero. The banner at the top names the seller — the sandbox
Business account — so you can see who the invoice comes from before sending one.

Ada, Bo and Cam show "No sandbox recipient mapped". That is correct: Hearth will not
substitute an address.

## Step 2 — prepare the draft

Click **Prepare invoice** on Devi's row.

Nothing has been sent. A draft now exists at PayPal, and the review panel shows the
four things being authorized: recipient and email, amount, billing period, and
seller — plus the allocation version the approval is bound to, and the provider's
invoice id with status `DRAFT`.

Her row now reads **Draft ready · not sent**.

## Step 3 — send it

Click **Send invoice**. The button changes to *"Confirm — send $680.00 invoice to
Devi"*. Click again.

Her row becomes **Invoice sent · not paid**. That wording is deliberate: sending
proves an invoice left, and nothing else. The hosted payment page link appears.

## Step 4 — pay it as the resident

Open the hosted payment link in a private window, or sign in at
<https://www.sandbox.paypal.com> as your **sandbox Personal** account and pay the
invoice from there.

To see a *partial* payment distinguished from a full one, pay less than $680 if the
sandbox offers a partial option; otherwise pay in full.

## Step 5 — refresh the status

Back in Hearth, click **Refresh status from PayPal**.

The row updates from what PayPal says, not from anything the browser claims:

| What PayPal returns | What Hearth shows |
|---|---|
| `SENT` / `UNPAID` | Invoice sent · not paid |
| `PAYMENT_PENDING` | Payment pending |
| `PARTIALLY_PAID`, or paid with an amount still due | Partly paid, with paid and still-due amounts |
| `PAID` with nothing due | Paid in full |

There is no webhook in this build, so nothing updates on its own: status changes when
you ask for it. That is a deliberate limitation, not a bug — see `docs/DECISIONS.md`.

## Step 6 — the simulated text

With the invoice sent, **Draft text with the payment link** composes a reminder
containing the real sandbox payment URL. Approving it records a dry run. **No
message is sent** — there is no messaging provider in this repository at all.

## Step 7 — restart, and check nothing was forgotten

Stop the server and run `npm run demo` again. The fictional data resets, but Devi's
row still shows her invoice, its id and its last known status, because the payment
store is a separate durable file. Resetting demo data must never make Hearth forget
an invoice PayPal actually holds.

## If a send times out

You will see *"The send result is unknown"*. Hearth has **not** recorded it as sent.
Click **Check with PayPal**: it reads the invoice first, and if it actually went out
it is recorded as sent rather than sent a second time. Retrying never sends blind.
