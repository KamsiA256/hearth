# Boundaries — read before writing any code or inviting anyone in

This repository is a **PayPal AI Hackathon 2026 submission**. It will be **public**
and **MIT licensed**. That one fact drives every rule below.

Note on the name: this repository is called `Hearth-Hackathon-Demo`, but it is
**not** a copy, fork, or branch of any Hearth repository, and it must never
become one. It shares no git history with any Hearth repository and never will.

## What changed on 2026-11-02

This file previously said that **no** Hearth code could enter this repository.
That blanket rule has been replaced by a **scoped reuse authorization** from the
repository owner. The reasoning behind the old rule still holds — it was about
git history and about data, not about the idea that Hearth code is untouchable —
so the parts that protect history and data are unchanged and now stated more
precisely.

The authorization covers **specific, individually reviewed components**. It does
**not** authorize copying the pilot repository, publishing its history, or
copying anything the exclusion list below names.

## Why this is a new repository and not a Hearth branch

A branch of `Hearth-Pilot` would carry Hearth's entire git history into a public
repo. History is not optional — `git clone` brings all of it, and deleting a file
in a later commit does not remove it from the objects. Publishing a Hearth branch
would publish:

- the proprietary pilot system that Hearth is being built as a company around;
- the secrets incident recorded on 2026-10-20 and anything it touched;
- a lease PDF containing a co-tenant's personal information.

So: **fresh repository, zero shared history.** Never add a Hearth remote here,
and never merge or cherry-pick from one. Reuse happens by copying reviewed files
into a working tree, never by any git operation that joins the two histories.

## Hard rules

1. **Only reviewed components may be copied, and only through the review process
   below.** No bulk copy, no directory-level copy, no "it was easier to bring the
   whole folder."
2. **Never copied, under any circumstance:** credentials and `.env` files; private
   records of any kind; internal business documents; incident reports; production
   identifiers (deployment project IDs, site names, hosted URLs, phone numbers in
   service); deployment configuration tied to the pilot; and git history.
3. **No real people, ever.** No real tenant, landlord, guarantor, applicant or
   prospect names, phone numbers, addresses, emails or lease terms. Every fixture
   is invented. Phone numbers use the reserved 555-0100–0199 range.
4. **No real company or property, even from public sources.** The pilot's demo
   fixture cited a real company's public listings. That scenario does not come
   here. This repository's scenario is independently fictional: invented company,
   invented address, invented rents, invented residents, no external citations.
5. **No lease documents.** `.pdf` and `.docx` are gitignored on purpose. Do not
   add an exception.
6. **PayPal sandbox only.** No live credentials, no real money movement, no
   production keys. Sandbox keys go in `.env`, which is gitignored; document them
   in `.env.example` with placeholder values only.
7. **Sandbox account emails are local-only.** Sandbox recipient addresses are
   personal account details, not fixture data. They live in a gitignored local
   mapping file and never appear in a fixture or a commit.
8. **Secrets never land in a commit.** Run `scripts/check-secrets.sh` before every
   commit, or install it as a pre-commit hook.

## The review process for reusing a component

Every copied file goes through all five steps. `docs/REUSE.md` is the record.

1. **Identify** the exact file needed, and why this repository needs it.
2. **Review** its contents line by line, plus its imports, any bundled asset it
   pulls in, and any configuration it reads.
3. **Record** it in `docs/REUSE.md` — what was reused, what was excluded, and a
   brief reason for each.
4. **Copy** only the reviewed file, then scrub it: identifying strings, real
   addresses and emails, pilot-specific copy, and references to excluded systems.
5. **Scan** with `scripts/check-secrets.sh` and the pattern scan in
   `docs/REUSE.md` before committing.

A component that fails review is excluded and recorded as excluded. "Reimplement
it instead" is always an acceptable outcome.

## Third-party components

Reused npm dependencies are declared in `package.json` and are not vendored into
this repository, so their own license files travel with them. Licenses were
checked at copy time and are recorded in `docs/REUSE.md`. If anything is ever
vendored — a font, an icon set, a snippet — its license and attribution go in a
`NOTICE` file in the same commit.

**The MIT license in this repository covers the code in this repository only.**
Hearth itself is a separate, private, differently-licensed product, and nothing
here grants any rights to it.

## If someone else contributes

Before granting repository access, settle these:

- **Devpost registration.** Hackathons generally require every team member to be
  registered on the hackathon's Devpost; an unregistered contributor can
  invalidate a submission or complicate a prize. Confirm against the official
  rules.
- **Prize split.** Agree in writing, before building, how any prize is divided.
- **Scope of their access.** This repo only. Access here is not access to
  `Hearth-Pilot` or any Hearth data. Hearth proper needs its own contributor
  arrangement, decided separately and not under an MIT license.
- **What they may not use.** Make the hard rules above explicit with them in
  writing.
