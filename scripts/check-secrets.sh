#!/bin/sh
# Block obvious secrets and tenant documents from being committed.
#
# Run manually:        sh scripts/check-secrets.sh
# Install as a hook:    ln -s ../../scripts/check-secrets.sh .git/hooks/pre-commit
#                       chmod +x scripts/check-secrets.sh
#
# This is a seatbelt, not a guarantee. It checks staged content only.

set -e

# --- self-test: sh scripts/check-secrets.sh --self-test -----------------------
# Run this after editing $patterns. It catches dead patterns, which fail silently
# and are therefore worse than no pattern at all.
if [ "$1" = "--self-test" ]; then
  pats=$(sed -n "s/^patterns='\(.*\)'\$/\1/p" "$0")
  [ -n "$pats" ] || { echo "self-test: could not read \$patterns"; exit 1; }
  rc=0
  # The Twilio samples are written in two pieces so GitHub's secret scanning does
  # not mistake this file's own test data for real keys.
  for c in 'sk_live_abcdef1234567890' \
           'sk_test_abcdefghij1234567890' \
           'AC''0123456789abcdef0123456789abcdef' \
           'SK''0123456789abcdef0123456789abcdef' \
           'sk-ant-api03-xyz' \
           'AKIAIOSFODNN7EXAMPLE' \
           'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345' \
           'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' \
           '-----BEGIN RSA PRIVATE KEY-----' \
           '"access_token": "ya29.AbCdEfGhIjKlMnOpQrStUvWx"' \
           'client_secret=EOq1LmN2oP3qR4sT5uV6wX7yZ8aB9cD0'; do
    echo "$c" | grep -qE "$pats" || { echo "MISSED: $c"; rc=1; }
  done
  for s in 'PAYPAL_CLIENT_ID=your_sandbox_client_id_here' \
           'PAYPAL_CLIENT_SECRET=your_sandbox_client_secret_here' \
           'import { allocate } from "./src/money.js";' \
           'phone: "555-0142"'; do
    echo "$s" | grep -qE "$pats" && { echo "FALSE POSITIVE: $s"; rc=1; }
  done
  [ "$rc" -eq 0 ] && echo "self-test: all patterns live, no false positives"
  exit "$rc"
fi
# -----------------------------------------------------------------------------

staged=$(git diff --cached --name-only --diff-filter=ACM)
[ -z "$staged" ] && exit 0

fail=0

# 1. File types that must never be committed.
for f in $staged; do
  case "$f" in
    *.pdf|*.docx|*.pem|*.key|*.p12|.env|.env.*)
      case "$f" in
        .env.example) ;;
        *) echo "BLOCKED: $f must not be committed (see docs/BOUNDARIES.md)"; fail=1 ;;
      esac
      ;;
  esac
done

# 2. Credential-shaped strings in staged content.
# NOTE: these are ERE (grep -E). Use {n} for repeats, never \{n\} — a
# backslashed brace is a LITERAL brace in ERE, so \{32\} silently matches
# nothing and the pattern becomes dead. Add a case to the self-test below
# for every pattern you add here.
patterns='sk_live_|sk_test_[A-Za-z0-9]{16,}|AC[0-9a-f]{32}|SK[0-9a-f]{32}|sk-ant-|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|eyJhbGciOi|-----BEGIN [A-Z ]*PRIVATE KEY-----|(access_token|refresh_token|api_key|apikey|client_secret|password)[^[:alnum:]]{1,4}[A-Za-z0-9_/+.=-]{20,}'
# This script defines the patterns it searches for, so it must not scan itself.
scan="git diff --cached -U0 -- . :(exclude)scripts/check-secrets.sh"

if $scan | grep -E "^\+" | grep -qE "$patterns"; then
  echo "BLOCKED: staged changes contain something shaped like a credential:"
  $scan | grep -E "^\+" | grep -nE "$patterns" | cut -c1-120
  fail=1
fi

# 3. Real-looking US phone numbers outside the fictional 555-01xx range.
if $scan | grep -E "^\+" \
   | grep -oE "\(?[2-9][0-9]{2}\)?[ .-]?[2-9][0-9]{2}[ .-]?[0-9]{4}" \
   | grep -vE "555[ .-]?01[0-9]{2}" | grep -q .; then
  echo "WARNING: a phone number outside the fictional 555-0100-0199 range is staged."
  echo "         Confirm it is not a real person's number before committing."
fi

# 4. A real sandbox account address in a file that is meant to stay a placeholder.
# This happened: the example file is the obvious thing to edit, and it is tracked,
# so filling it in puts a real account address into the repository. The live values
# belong in .hearth-local/, which is gitignored.
for f in $staged; do
  case "$f" in
    docs/sandbox-recipients.example.json|.hearth-local/*)
      if git diff --cached -U0 -- "$f" | grep -E "^\+" \
         | grep -qE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"; then
        echo "BLOCKED: $f contains an email address and must only contain placeholders."
        echo "         Put real sandbox account addresses in .hearth-local/sandbox-recipients.json"
        echo "         (gitignored) and restore the REPLACE placeholders here."
        fail=1
      fi
      ;;
  esac
done

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Commit aborted. Fix the above, or override deliberately with --no-verify."
  exit 1
fi

echo "check-secrets: clean"
exit 0
