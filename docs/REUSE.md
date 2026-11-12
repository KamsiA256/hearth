# Reuse record

What was copied into this public repository, what was deliberately left behind,
and how each file was checked. Required by `docs/BOUNDARIES.md`.

- **Source reviewed:** the most recent reviewed demo branch of the private Hearth
  pilot repository, reviewed 2026-11-02.
- **Method:** files were read in full and copied by hand. No git operation ever
  connected the two repositories: no remote, no fetch, no merge, no cherry-pick.
  This repository's history begins at its own initial commit.

## Reused

### Application interface

| File here | Why it was reused |
|---|---|
| `public/index.html` | the Hearth shell: navigation, property bar, sheet dialog, access dialog, dataset banner |
| `public/app.js` | the operator app — Today, Messages, Residents, Leasing, Turnover, Property |
| `public/model.js` | derived state for the interface: attention items, renewal state, turnover state, lease facts |
| `public/styles.css`, `export-links.css`, `requests.css`, `turnover.css` | the visual system the screens are built against |

### Server

| File here | Why it was reused |
|---|---|
| `server/operator-api.mjs` | the read/write API the interface runs on, including per-organization scoping on every query |
| `server/_shared/http.mjs` | JSON response helper |
| `server/_shared/safety.mjs` | life-safety and opt-out classification that runs before any model call |

### Local demo harness

| File here | Why it was reused |
|---|---|
| `data/in-memory-db.mjs` | the whole storage layer: an in-memory query builder, free of `node:*` imports so one tested implementation serves both the local server and the browser bundle |
| `data/builder.mjs` | fixture builder: emits rows shaped like the real tables so a fixture states data and never application logic |
| `server/_shared/db.mjs` | in-memory database module (adapted from the pilot's browser demo adapter) |
| `server/_shared/messaging.mjs` | records an outbound message as a dry run; contains no messaging SDK and cannot send (adapted from the pilot's browser demo adapter) |
| `server/_shared/operator-auth.mjs` | the simulated access gate (adapted from the pilot's browser demo adapter) |
| `scripts/demo-server.mjs` | local server on `127.0.0.1` that strips service credentials from its own environment |
| `scripts/build-offline-bundle.mjs`, `scripts/offline-entry.mjs` | build the credential-free offline bundle |

### Tests

`tests/isolation.test.js`, `scoping.test.js`, `safety.test.js`, `offline-mode.test.js`,
`interface.test.js`, `fixture.test.js` — the guardrail tests that make the isolation
claims checkable rather than asserted. Adapted from the pilot's equivalents.

### From this repository's own earlier work

`src/money.js` keeps `toCents`, `money`, `allocate` (largest-remainder, so shares
always sum to the total) and `prorate` from the earlier `src/split.js`. These are
this repository's own MIT code and raise no boundary question. `settle()` and the
charge-attribution model were dropped with the deposit-settlement scope.

## Excluded

| Not copied | Reason |
|---|---|
| `netlify/functions/sms-inbound.mjs`, `_shared/messaging.mjs` (the real one), `_shared/delivery.mjs` | live messaging integration; out of scope for this phase |
| `netlify/functions/_shared/llm.mjs` | pilot model client and prompts |
| `netlify/functions/_shared/db.mjs` (the real one) | live database client |
| `netlify/functions/_shared/operator-auth.mjs` (the real one) | the pilot's access-control design, and it carries an operator name in an example |
| `supabase/**` | pilot schema, and its reset script is destructive |
| `netlify.toml`, `.netlify/`, `deploy:*` scripts | deployment configuration tied to the pilot |
| the pilot deployment project ID and site names | production identifiers |
| `docs/INCIDENT_2026-10-20_SECRETS.md` | incident report |
| a prospect discovery brief, prospect demo notes, lead-capture material | internal business material |
| internal review, pilot, UI and walkthrough documents | internal documents; one also names the deployment project and states that a visitor password exists |
| a prospect scenario script | scenario built on a real company's public listings — real company name, real address, real listed rents, external citations. Replaced by an independently fictional scenario |
| `scripts/demo/fictional-portfolio.mjs`, `scripts/demo/datasets.mjs` | already fictional, but the multi-fixture loader is unnecessary here and used `node:fs`, which the browser bundle cannot. One fixture, imported directly |
| `scripts/pipeline/**` | unrelated to this submission |
| the feedback dialog, its form handler and its email fallback | posted to the pilot's form service and contained a real business email address |
| `publicFactsCard` and the fixture's `publicFacts` | existed to cite a real company's listings; an independently fictional property has nothing to cite |
| `package-lock.json`, `node_modules/` | fresh dependency set resolved here |
| the pilot `.env.example` | names service variables this repository does not use |

## Scrubbed on copy

Every identifying string found by the scan below was removed. The scan was run
over the reuse candidates before copying and is re-run after any further copy:

```sh
# 1. the pilot's identifying terms (tests/fixture.test.js checks their hashes)
grep -rnoiE '<the pilot terms>' public server data scripts tests
# 2. URLs, email addresses and credential-shaped strings
grep -rnoiE 'https?://[a-z0-9./_-]+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|(sk|pk|xox|AC|SK|AKIA)[a-zA-Z0-9_-]{12,}|[0-9a-f]{32,}|eyJ[A-Za-z0-9_-]{10,}' public server data scripts tests src
```

Found and removed: a real business email address in the feedback handler; two
operator first names; a real company name in interface copy and in the demo
adapter; the demo's project name in a version string and in the page markup; the
pilot deployment project ID (in excluded files only). The pilot's database column
name `phone_numbers.twilio_number` was kept, because renaming it would ripple
through the fixture builder and the relation inference in `in-memory-db.mjs` for
no safety gain; no messaging SDK is present.

## Third-party licenses

Checked from the installed packages at copy time, 2026-11-02:

| Package | License | Status |
|---|---|---|
| `esbuild` | MIT | used, to build the offline bundle |
| `zod` | MIT | used, for request validation |
| `@supabase/supabase-js` | MIT | not used here |
| `twilio` | MIT | not used here |
| `netlify-cli` | MIT | not used here |

Nothing is vendored, so no `NOTICE` file is required. There are no bundled binary
assets: the only image the demo serves is an SVG generated inline in
`scripts/demo-server.mjs`.
