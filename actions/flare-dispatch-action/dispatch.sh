#!/usr/bin/env bash
#
# flare-dispatch-action — sign a dispatch body and POST it to a FlareDispatch
# Dispatcher. Consumed by action.yml (a composite action); every knob arrives
# as an `INPUT_*` env var, exactly as GitHub Actions exposes `with:` inputs.
#
# The contract this implements is specs/04-gha-integration.md § Action mode and
# apps/dispatcher/src/routes/dispatch.ts:
#
#   POST ${endpoint}/v1/dispatch/${run}
#     X-FlareDispatch-Signature: sha256=<hex over the RAW body bytes>
#     Idempotency-Key: <run>-<repo>-<sha12>
#   202 { executionId, detailsUrl?, logsUrl? }   → outputs, success
#   401                                           → HMAC drift, no retry
#   400 / 404                                     → config bug, no retry
#   000 / 429 / 5xx                               → transient, retry ≤3×
#
# The run executes ASYNCHRONOUSLY on Cloudflare; its verdict lands on the PR as
# a `flare-dispatch/<run>` check-run, NOT via this step. This step succeeds the
# moment the dispatch is accepted (202) — gate branch protection on the
# check-run name, not this job.
#
# Raw-bytes HMAC contract: the compact JSON is written to a file ONCE, and that
# exact file is both signed and sent (`--data-binary`), so signer and verifier
# see identical octets without agreeing on a canonical JSON form (hmac.ts).
#
# Deps: bash, jq, openssl, curl — all preinstalled on GitHub-hosted runners.

set -euo pipefail

# --- log helpers -------------------------------------------------------------

# GitHub error annotation. Values are stripped of CR/LF so a hostile field can
# never inject a second `::workflow-command::` into the runner log.
err() { printf '::error::%s\n' "$(printf '%s' "$*" | tr -d '\r\n')" >&2; }
note() { printf '%s\n' "$(printf '%s' "$*" | tr -d '\r\n')"; }

# --- required deps -----------------------------------------------------------

for bin in jq openssl curl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    err "'$bin' is required but not on PATH."
    exit 1
  fi
done

# --- mode gate ---------------------------------------------------------------
# V0 ships fire-and-forget only; reject anything else BEFORE touching the
# network so a typo'd `await` fails loud instead of dispatching silently.

MODE="${INPUT_MODE:-fire-and-forget}"
if [ "$MODE" != "fire-and-forget" ]; then
  err "mode='${MODE}' — only 'fire-and-forget' is supported (await mode is deferred). Set mode: fire-and-forget."
  exit 1
fi

# --- required inputs ---------------------------------------------------------

require() { # name value
  if [ -z "${2:-}" ]; then
    err "'${1}' input is required"
    exit 1
  fi
}
require run "${INPUT_RUN:-}"
require endpoint "${INPUT_ENDPOINT:-}"
require hmac-secret "${INPUT_HMAC_SECRET:-}"

# --- endpoint validation -----------------------------------------------------
# Strip a single trailing slash and reject any non-http(s) scheme before it can
# reach curl (keeps file://, data:, and metadata-only URLs out).

ENDPOINT="${INPUT_ENDPOINT%/}"
case "$ENDPOINT" in
  https://* | http://*) : ;;
  *)
    err "'endpoint' must start with http:// or https:// — got: ${ENDPOINT}"
    exit 1
    ;;
esac

# --- resolve the head SHA ----------------------------------------------------
# On pull_request events GITHUB_SHA is the ephemeral test-merge commit; a
# check-run posted there is invisible on the PR head and branch protection
# can't gate it. The verdict belongs on the PR head SHA — read it off the event
# payload, falling back to GITHUB_SHA for push events / when unreadable.

resolve_head_sha() {
  local fallback="${GITHUB_SHA:-}"
  case "${GITHUB_EVENT_NAME:-}" in
    pull_request | pull_request_target) : ;;
    *)
      printf '%s' "$fallback"
      return
      ;;
  esac
  if [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "${GITHUB_EVENT_PATH}" ]; then
    local head
    head="$(jq -r '.pull_request.head.sha // empty' "${GITHUB_EVENT_PATH}" 2>/dev/null || true)"
    if [ -n "$head" ]; then
      printf '%s' "$head"
      return
    fi
  fi
  printf '%s' "$fallback"
}
SHA="$(resolve_head_sha)"

# --- inputs (JSON) -----------------------------------------------------------

RAW_INPUTS="${INPUT_INPUTS:-}"
[ -z "$RAW_INPUTS" ] && RAW_INPUTS='{}'
if ! printf '%s' "$RAW_INPUTS" | jq -e . >/dev/null 2>&1; then
  err "'inputs' is not valid JSON: ${RAW_INPUTS}"
  exit 1
fi
INPUTS="$(printf '%s' "$RAW_INPUTS" | jq -c .)"

# --- collect-command: fold consumer-side observability signals into inputs ---
# Optional. The command runs in the workspace and must print ONLY signals/v1
# JSON to stdout (a bare array, or { "signals": [...] }) and exit 0. A broken
# collector fails the Action HERE, before anything is signed or sent.

if [ -n "${INPUT_COLLECT_COMMAND:-}" ]; then
  if [ "$(printf '%s' "$INPUTS" | jq -r 'type')" != "object" ]; then
    err "collect-command requires 'inputs' to be a JSON object (signals are merged into it) — got a non-object."
    exit 1
  fi

  collect_err="$(mktemp)"
  collect_out="$(mktemp)"
  set +e
  (cd "${GITHUB_WORKSPACE:-$PWD}" && bash -c "$INPUT_COLLECT_COMMAND") \
    >"$collect_out" 2>"$collect_err"
  collect_rc=$?
  set -e
  if [ "$collect_rc" -ne 0 ]; then
    err "collect-command exited ${collect_rc} — a signals collector must exit 0 with valid signals/v1 JSON. stderr tail: $(tail -c 1000 "$collect_err" 2>/dev/null || true)"
    exit 1
  fi

  # Normalize a bare array or a { signals: [...] } wrapper to a plain array.
  if ! collected="$(jq -c '
        if type == "array" then .
        elif (type == "object" and (.signals | type) == "array") then .signals
        else error("not signals/v1")
        end' "$collect_out" 2>/dev/null)"; then
    err "collect-command output is not signals/v1 (expected a JSON array or an object with a 'signals' array)."
    exit 1
  fi

  # Client-side shape check (the Dispatcher re-validates and would 400 anyway —
  # this just fails faster with a precise reason). Caps mirror
  # schemas/signals.v1.schema.json.
  reason="$(printf '%s' "$collected" | jq -r '
    def cap(f; n): if (has(f) and (.[f] | type) == "string" and (.[f] | length) > n)
                   then "\(f) exceeds \(n) chars" else empty end;
    if (length > 50) then "too many signals (\(length) > 50)"
    else ( to_entries[] | .key as $i | .value |
      if (type != "object") then "signal[\($i)] is not an object"
      elif ((has("source") and (.source | type) == "string") | not) then "signal[\($i)] needs a string \"source\""
      elif ((has("title")  and (.title  | type) == "string") | not) then "signal[\($i)] needs a string \"title\""
      elif ((has("detail") and (.detail | type) == "string") | not) then "signal[\($i)] needs a string \"detail\""
      else (cap("source"; 120), cap("title"; 200), cap("detail"; 2000), cap("url"; 1000))
      end )
    end' | head -n1)"
  if [ -n "$reason" ]; then
    err "collected signals are invalid: ${reason}"
    exit 1
  fi

  # Merge: caller-provided signals first, then collected. Re-check the combined
  # 50-item cap (each side can be ≤50 yet exceed it together).
  INPUTS="$(printf '%s' "$INPUTS" | jq -c --argjson collected "$collected" '
    .signals = ((.signals // []) + $collected)')"
  merged_count="$(printf '%s' "$INPUTS" | jq '.signals | length')"
  if [ "$merged_count" -gt 50 ]; then
    err "merged signals exceed the 50-item cap (${merged_count}). Cluster per failure, don't enumerate raw events."
    exit 1
  fi

  # A signals run (e.g. ci-triage-pr) keys on firedAt; default it to now (ms)
  # when signals are present but the caller didn't set one.
  now_ms="$(date +%s)000"
  INPUTS="$(printf '%s' "$INPUTS" | jq -c --argjson now "$now_ms" '
    if ((.signals // []) | length) > 0 and (has("firedAt") | not)
    then .firedAt = $now else . end')"
fi

# --- notify recipients -------------------------------------------------------
# Accept a JSON array or a comma/whitespace-separated string; drop blanks.

NOTIFY_RAW="${INPUT_NOTIFY_EMAILS:-}"
if [ -z "$NOTIFY_RAW" ]; then
  emails='[]'
elif printf '%s' "$NOTIFY_RAW" | jq -e 'type == "array"' >/dev/null 2>&1; then
  emails="$(printf '%s' "$NOTIFY_RAW" | jq -c '[.[] | select(. != "")]')"
else
  emails="$(printf '%s' "$NOTIFY_RAW" | jq -Rc 'split("[,\\s]+"; "") | map(select(length > 0))')"
fi

# --- installation id + trigger metadata --------------------------------------
# installation_id is OMITTED when unset/0 — the dispatch schema is
# `positive | undefined` (a literal 0 is a 400), and the Dispatcher resolves it
# server-side from the App's webhook-registered installation map when absent.

INSTALL_ID="$(printf '%s' "${INPUT_INSTALLATION_ID:-0}" | grep -E '^[0-9]+$' || echo 0)"
RUN_ID="$(printf '%s' "${GITHUB_RUN_ID:-0}" | grep -E '^[0-9]+$' || echo 0)"

github_ctx="$(jq -cn \
  --arg repo "${GITHUB_REPOSITORY:-}" \
  --arg ref "${GITHUB_REF:-refs/heads/main}" \
  --arg sha "$SHA" \
  --arg actor "${GITHUB_ACTOR:-}" \
  --argjson iid "$INSTALL_ID" \
  '{ repo: $repo, ref: $ref, sha: $sha }
   + (if $actor != "" then { actor: $actor } else {} end)
   + (if $iid > 0 then { installation_id: $iid } else {} end)')"

trigger_ctx="$(jq -cn \
  --argjson rid "$RUN_ID" \
  --arg job "${GITHUB_JOB:-}" \
  '{}
   + (if $rid > 0 then { workflow_run_id: $rid } else {} end)
   + (if $job != "" then { job_id: $job } else {} end)')"

# --- assemble the body -------------------------------------------------------

BODY_FILE="$(mktemp)"
RESP_FILE="$(mktemp)"
jq -cn \
  --arg run "$INPUT_RUN" \
  --argjson github "$github_ctx" \
  --argjson inputs "$INPUTS" \
  --argjson trigger "$trigger_ctx" \
  --argjson emails "$emails" \
  '{ run: $run, github: $github, inputs: $inputs, trigger: $trigger }
   + (if ($emails | length) > 0 then { notify: { emails: $emails } } else {} end)' \
  | tr -d '\n' >"$BODY_FILE"

# --- sign the exact bytes ----------------------------------------------------
# stdin form (not a filename arg) so openssl emits no `HMAC-SHA256(file)=`
# prefix; `$NF` also tolerates the `(stdin)=` prefix older openssl prints.

SIG_HEX="$(openssl dgst -sha256 -hmac "$INPUT_HMAC_SECRET" <"$BODY_FILE" | awk '{ print $NF }')"
SIGNATURE="sha256=${SIG_HEX}"
LOCAL_FP="$(printf '%s' "$INPUT_HMAC_SECRET" | openssl dgst -sha256 | awk '{ print $NF }' | cut -c1-8)"

# --- idempotency key ---------------------------------------------------------
# {run}-{repo}-{sha12} so a re-run of the same step collapses onto one execution
# at the receiver. Randomized fallback when repo/sha are absent (local act runs).

if [ -n "${GITHUB_REPOSITORY:-}" ] && [ -n "$SHA" ]; then
  repo_safe="${GITHUB_REPOSITORY//\//_}"
  IDEMPOTENCY_KEY="${INPUT_RUN}-${repo_safe}-${SHA:0:12}"
else
  IDEMPOTENCY_KEY="${INPUT_RUN}-$(date +%s)-${RANDOM}"
fi

RUN_ENC="$(jq -rn --arg r "$INPUT_RUN" '$r | @uri')"
URL="${ENDPOINT}/v1/dispatch/${RUN_ENC}"

# --- POST with bounded retry -------------------------------------------------
# 3 attempts total; 401/400/404 are permanent (no retry). Transient (000/429/
# 5xx) backs off attempt*base ms. base overridable via FLARE_RETRY_BACKOFF_MS.

BASE_BACKOFF_MS="${FLARE_RETRY_BACKOFF_MS:-5000}"
MAX_ATTEMPTS=3
attempt=0
http_code=000
resp=""

while :; do
  attempt=$((attempt + 1))
  set +e
  http_code="$(curl -sS \
    -o "$RESP_FILE" \
    -w '%{http_code}' \
    -X POST "$URL" \
    -H 'Content-Type: application/json' \
    -H "X-FlareDispatch-Signature: ${SIGNATURE}" \
    -H "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
    --data-binary "@${BODY_FILE}")"
  curl_rc=$?
  set -e
  if [ "$curl_rc" -ne 0 ]; then http_code=000; fi
  resp="$(cat "$RESP_FILE" 2>/dev/null || true)"

  case "$http_code" in
    202) break ;;
    401)
      err "FlareDispatch dispatch failed (HTTP 401): ${resp}"
      dispatcher_fp="$(printf '%s' "$resp" | jq -r '.dispatcher_secret_fingerprint // "<not provided>"' 2>/dev/null || echo '<not provided>')"
      err "HMAC drift between flare-dispatch-action and the Dispatcher Worker."
      note "  local secret fingerprint      = ${LOCAL_FP}"
      note "  dispatcher secret fingerprint = ${dispatcher_fp}"
      note "  If they differ, re-sync HMAC_SECRET on the mismatching side (a trailing newline is the usual culprit)."
      exit 1
      ;;
    400 | 404)
      err "FlareDispatch dispatch failed (HTTP ${http_code}): ${resp}"
      exit 1
      ;;
    *)
      if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
        err "FlareDispatch dispatch failed after ${attempt} attempts (last HTTP ${http_code}): ${resp}"
        exit 1
      fi
      delay="$(awk -v ms="$((attempt * BASE_BACKOFF_MS))" 'BEGIN { printf "%.3f", ms / 1000 }')"
      note "FlareDispatch: transient failure (HTTP ${http_code}), retry ${attempt}/$((MAX_ATTEMPTS - 1)) in ${delay}s..."
      sleep "$delay"
      ;;
  esac
done

# --- parse the 202 + emit outputs --------------------------------------------

sanitize() { printf '%s' "$1" | tr -d '\r\n'; }
EXECUTION_ID="$(sanitize "$(printf '%s' "$resp" | jq -r '.executionId // ""' 2>/dev/null || true)")"
DETAILS_URL="$(sanitize "$(printf '%s' "$resp" | jq -r '.detailsUrl // ""' 2>/dev/null || true)")"
LOGS_URL="$(sanitize "$(printf '%s' "$resp" | jq -r '.logsUrl // ""' 2>/dev/null || true)")"
SKIPPED="$(printf '%s' "$resp" | jq -r '.skipped // ""' 2>/dev/null || true)"

if [ "$SKIPPED" = "cooldown" ]; then
  note "FlareDispatch: '${INPUT_RUN}' within its cooldown window — reusing execution ${EXECUTION_ID} (no new run)."
else
  note "FlareDispatch: dispatched '${INPUT_RUN}' — executionId=${EXECUTION_ID}"
fi
[ -n "$DETAILS_URL" ] && note "FlareDispatch: Cloudflare Workflows run — ${DETAILS_URL}"
[ -n "$LOGS_URL" ] && note "FlareDispatch: full logs — ${LOGS_URL}"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    printf 'execution-id=%s\n' "$EXECUTION_ID"
    printf 'details-url=%s\n' "$DETAILS_URL"
    printf 'logs-url=%s\n' "$LOGS_URL"
  } >>"$GITHUB_OUTPUT"
fi
