#!/usr/bin/env bash
#
# Verify a deployed substrate. This is the BYOC health check ADR-0011 asks for
# — run it against any org's substrate, from CI or by hand:
#
#   apps/substrate/scripts/verify-deploy.sh https://<substrate-host> canary
#   apps/substrate/scripts/verify-deploy.sh https://<substrate-host> dogfood
#   apps/substrate/scripts/verify-deploy.sh https://<substrate-host> health
#
#   canary  — a container fetch to an unlisted host must die 520. The egress
#             floor, proven on the build that is actually running.
#   dogfood — the facade round trip: ensure → exec → replay → checkpoint → abort.
#   health  — asserts the worker reports `ok`, which it only does once the
#             canary has passed for this deployment.
#
# `deferred` (the pool was full, nothing ran) is retried, not failed: a busy
# fleet is not a verdict about the floor. Everything else is decided on the
# first answer — a `failed` canary means egress got out, and retrying it would
# only spend containers to be told the same thing.
#
# Only curl is required; `jq` is used when present and grep stands in when it
# is not, so an operator can run this on a bare machine.
set -euo pipefail

BASE_URL="${1:?usage: verify-deploy.sh <base-url> <canary|dogfood|health>}"
CHECK="${2:?usage: verify-deploy.sh <base-url> <canary|dogfood|health>}"
ATTEMPTS="${VERIFY_ATTEMPTS:-10}"
SLEEP_SECONDS="${VERIFY_SLEEP_SECONDS:-30}"
# A cold canary pays an image pull plus a container boot before its two curls.
TIMEOUT_SECONDS="${VERIFY_TIMEOUT_SECONDS:-240}"

json_field() {
  # $1 = field name, stdin = JSON body.
  local field="$1" body
  body="$(cat)"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$body" | jq -r --arg f "$field" '.[$f] // ""'
  else
    printf '%s' "$body" | grep -oE "\"${field}\":\"[^\"]*\"" | head -1 | cut -d'"' -f4
  fi
}

case "$CHECK" in
  canary | dogfood) METHOD=POST; PATH_="/$CHECK" ;;
  health) METHOD=GET; PATH_="/health" ;;
  *)
    echo "unknown check '$CHECK' — expected canary, dogfood or health" >&2
    exit 2
    ;;
esac

for attempt in $(seq 1 "$ATTEMPTS"); do
  body_file="$(mktemp)"
  code="$(curl -sS -X "$METHOD" -m "$TIMEOUT_SECONDS" -o "$body_file" -w '%{http_code}' \
    "${BASE_URL}${PATH_}" || echo 000)"
  body="$(cat "$body_file")"
  rm -f "$body_file"
  status="$(printf '%s' "$body" | json_field status)"

  echo "[$CHECK] attempt ${attempt}/${ATTEMPTS}: HTTP ${code} status=${status:-<none>}"

  if [ "$code" = "200" ] && { [ "$status" = "passed" ] || [ "$status" = "ok" ]; }; then
    printf '%s\n' "$body"
    exit 0
  fi

  # Retry only what a later attempt could plausibly answer differently: nothing
  # ran (a busy pool), nothing answered (the worker is still coming up), or the
  # verdict has not landed yet. `inconclusive` is NOT retried — it is a recorded
  # verdict, so the next call would be served the same cached answer without
  # re-probing, and the usual cause (no curl in the image, no artifacts mount)
  # does not fix itself.
  case "${status:-}" in
    deferred | unverified | "") ;;
    *)
      echo "[$CHECK] decided: ${status}" >&2
      printf '%s\n' "$body" >&2
      exit 1
      ;;
  esac

  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep "$SLEEP_SECONDS"
  fi
done

echo "[$CHECK] never reached a passing verdict after ${ATTEMPTS} attempts" >&2
exit 1
