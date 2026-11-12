# Hearth

Rent for shared student houses: split it fairly, get everyone to agree, and collect
it through PayPal. A PayPal AI Hackathon 2026 submission by Kamsi Anienwelu and
Shane Reiss.

**Try it live:** <https://hearth-hackathon-demo.vercel.app>. No sign-in; payments run
in PayPal's sandbox.

Twelve students sign one lease. The landlord is owed one monthly total, the rooms
are not the same, and every month somebody has to work out who owes what. Today that
is a group chat and an argument, and the landlord sees none of it until rent is late.

Hearth is the landlord's side of that house. It drafts an uneven split with AI,
records every resident's agreement to the exact numbers, and sends each resident
their own PayPal invoice, but only after the landlord approves it.

## What you can do in it

- **Today.** One screen for the house: rent collected so far, who has paid, what
  needs the landlord (a possible gas leak, a repair, a question only they can
  answer) and who is renewing next year.
- **Rent.** Four steps, in order.
  1. **Split.** Rank what matters most (natural light, room size, a private bathroom),
     add your own factors, and let Claude draft each resident's share with a reason
     a tenant can read. Or type the shares yourself. The split must add up to the
     total to the cent before it can go further.
  2. **Agree.** Each resident's confirmation is tied to the exact numbers. Change a
     cent and the confirmations no longer count.
  3. **Invoice.** One PayPal sandbox invoice per resident. Each is drafted, shown
     with its recipient and amount, and sent only when the landlord approves it.
  4. **Collect.** Payment status is read back from PayPal. *Sent* and *paid* are
     different facts and are never shown as the same thing.
- **Messages.** Residents' texts in one inbox, most urgent first. Replies are
  recorded, not sent: this demo has no texting provider.
- **Leasing.** Residents, next year's renewals (signed, signing, still deciding,
  moving out) and move-in/move-out.

## How it uses AI and PayPal

**Claude drafts; code does the math.** The model reads the room facts and the
landlord's ranking and returns a relative weight and a one-line reason per resident.
It never sees or returns a dollar amount: `src/ai/proposal.js` refuses any reply that
names one. Deterministic code (`src/ai/weights.js`, `src/money.js`) turns weights
into cents that always add up to the total. If the model can't find something the
landlord asked it to weigh, it says so, and the page shows it. An AI draft goes
through the same agree-and-approve steps as a typed one.

**PayPal sandbox invoicing.** The server drafts a real PayPal invoice for each
resident, sends it on approval, and reads its status back. Nothing reaches live
PayPal: the client has no live endpoint and refuses to start unless the environment
says `sandbox`. There is no webhook yet, so status updates when someone refreshes it.

## What is real and what is invented

| Real | Invented |
|---|---|
| The PayPal sandbox invoices and their hosted payment pages | The household: names, rooms, rents, messages, dates |
| The Claude call that drafts a split (with your key) | Every resident's phone number (reserved 555-01xx range) |
| The street address 140 College Ave, Ithaca, NY | The landlord company |

No text message is ever sent. Approved replies are stored as dry runs and shown as
recorded, never as delivered.

## Run it

Needs Node 20 or newer.

```sh
npm install
npm test
npm run demo
```

Open <http://127.0.0.1:8888>. It opens straight onto the
twelve-person house at 140 College Ave with November's rent not yet split.

Without keys, everything works except drafting with AI and sending invoices; those
say they are unavailable rather than pretending. To turn them on, copy `.env.example`
to `.env` and fill in:

- `AI_MODE=anthropic` and `ANTHROPIC_API_KEY`, then check it with `npm run verify:ai`.
- `PAYMENTS_MODE=paypal_sandbox`, `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`,
  plus the sandbox buyer addresses in `.hearth-local/sandbox-recipients.json`. Then
  check it with `npm run verify:paypal`. [docs/SANDBOX_SETUP.md](docs/SANDBOX_SETUP.md)
  walks through it.

Other ways to run it:

| Command | What it is |
|---|---|
| `npm run review:college` | A static copy of the same house later in the month (split agreed, invoices part-paid). No server or keys; invoicing is a labelled simulation. Serves <http://127.0.0.1:8897>. |
| `npm run demo:offline` | The whole app in the browser with the smaller Willow Court scenario. No keys. Serves <http://127.0.0.1:8889>. |
| `HEARTH_DATASET=willow-court npm run demo` | Server mode with the Willow Court scenario instead. |

### Hosting on Vercel

The same server runs as one function (`api/hearth.mjs`) beside the static pages.
Rent splits and invoice records live in Postgres there (`src/postgres-stores.js`),
because a hosted function has no disk that lasts. The rest of the demo data resets
when a server starts.

1. `vercel link`, then connect a Postgres database from the project's **Storage** tab.
   That sets `DATABASE_URL`; tables are created on the first request.
2. In the project's environment variables, set `HEARTH_DATASET=college-ave-twelve`,
   the AI and PayPal keys above, and `SANDBOX_RECIPIENTS_JSON` (the recipients file
   on one line).
3. `vercel deploy`. `.vercelignore` uploads only what the app needs.

The hosted copy asks for no code, so anyone with the link can draft splits with AI.
Put a monthly spend limit on the Anthropic key it uses. To put a code in front of a
copy, set `HEARTH_ACCESS_CODE` and the page will ask for it.

## Guarantees the tests check

- The model cannot set an amount, and the split always sums to the total.
- An invoice cannot be sent without an explicit approval, and two clicks cannot send
  it twice.
- *Paid* is only ever written from PayPal's own status, never because an invoice was
  sent.
- Missing keys fail loudly instead of falling back to fake results.
- Nothing credential-shaped is ever stored, and no message is recorded as delivered.

`npm test` runs these. Tests marked `todo` are known gaps, recorded so they are not
forgotten; see [docs/KNOWN_GAPS.md](docs/KNOWN_GAPS.md). `npm run test:mutation`
breaks the payment code on purpose and checks that the tests notice.

## Reading the code

| Path | Contents |
|---|---|
| `public/` | the interface: Today, Rent, Messages, Leasing, House details, Settings |
| `server/handlers.mjs` | the API, wired once for both the local server and the hosted function |
| `server/allocation-api.mjs` | rent splits: drafts, versions, confirmations, approval |
| `server/payments-api.mjs` | the only place that decides whether an invoice may be created or sent |
| `server/operator-api.mjs` | messages, residents and leasing, scoped to one organization on every query |
| `src/ai/` | the Claude prompt, reply validation, and weights-to-cents |
| `src/allocation*.js`, `src/money.js` | the split and its arithmetic, in integer cents |
| `src/payments/` | the PayPal sandbox client, payment states, idempotency, the invoice store |
| `src/postgres-stores.js`, `api/` | hosting on Vercel |
| `data/` | the in-memory database and the fictional scenarios |
| `scripts/` | the local server, offline and review builds, the pre-commit secrets check |

| Doc | What it covers |
|---|---|
| [docs/DECISIONS.md](docs/DECISIONS.md) | why things are built the way they are, including verified PayPal behaviour |
| [docs/SANDBOX_SETUP.md](docs/SANDBOX_SETUP.md) | setting up PayPal sandbox accounts and the local fields |
| [docs/KNOWN_GAPS.md](docs/KNOWN_GAPS.md) | defects we know about and have not fixed |
| [docs/BOUNDARIES.md](docs/BOUNDARIES.md) | what may and may not enter this repository |
| [docs/REUSE.md](docs/REUSE.md) | what was reused from the private Hearth pilot, and how it was checked |

## Relationship to Hearth

This submission grows out of Hearth, a separate and private product for
student-housing landlords. Reviewed parts of its interface, API and local demo
harness were copied here by hand and are recorded file by file in
[docs/REUSE.md](docs/REUSE.md). No private data, credential or production
identifier came with them.

PayPal is the hackathon's payment provider, not a final choice for Hearth. Provider
code sits behind a narrow interface and the split logic knows nothing about it.

The MIT license covers the code in this repository only.

## License

MIT. See [LICENSE](LICENSE).
