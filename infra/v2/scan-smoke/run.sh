#!/bin/sh
# One smoke command of the gate image (specs/runs/gate.md FD-GATE-114, FD-GATE-115): runs one scanner on one fixture
# the way `security-gate` runs it, and exits 0 only when the scanner's exit code maps to the fixture's expected scan
# result.
#
# A fixture is `fixtures/<scanner>/<result>/`: `base/` and `head/` trees, committed as a target-branch commit and a
# pull-request commit of a scratch repository, and the scan bundle's configuration file for the scanner, if it takes
# one. A `finding` fixture plants a finding together with a head suppression of it. Before the scanner runs, the
# script restores each suppression file the range changes from the base commit, or deletes it where the base has none
# (step 3 of § Security gate); the scanner's invocation removes the other head inputs.
#
# Usage: run.sh <gitleaks|zizmor|osv-scanner> <finding|tool-error>
set -eu

scanner=${1:?usage: run.sh <scanner> <expected result>}
expected=${2:?usage: run.sh <scanner> <expected result>}
here=$(cd "$(dirname "$0")" && pwd)
fixture="$here/fixtures/$scanner/$expected"
if [ ! -d "$fixture/head" ]; then
  echo "scan-smoke: no fixture $scanner/$expected" >&2
  exit 2
fi

# Each exit code's scan result: the exit-code table of specs/runs/gate.md § Security gate.
result_of() {
  case "$1:$2" in
    gitleaks:0 | zizmor:0 | osv-scanner:0) echo clean ;;
    gitleaks:42 | zizmor:1[1-4] | osv-scanner:1) echo finding ;;
    gitleaks:1 | zizmor:[1-3] | osv-scanner:127) echo tool-error ;;
    osv-scanner:128) echo nothing-in-scope ;;
    *) echo unmapped ;;
  esac
}

# The suppression files the recipe restores from the base commit (`suppression.files`).
SUPPRESSION_FILES=".gitleaksignore osv-scanner.toml"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
repo="$work/repo"
mkdir "$repo"
in_repo() {
  git -C "$repo" -c user.name=scan-smoke -c user.email=scan-smoke@example.invalid -c commit.gpgsign=false "$@"
}
in_repo init -q
if [ -d "$fixture/base" ]; then cp -R "$fixture/base/." "$repo/"; fi
in_repo add -A
in_repo commit -q --allow-empty -m base
base=$(in_repo rev-parse HEAD)
cp -R "$fixture/head/." "$repo/"
in_repo add -A
in_repo commit -q -m head
head=$(in_repo rev-parse HEAD)
changed=$(in_repo diff --name-only --diff-filter=AM "$base" "$head")

for path in $(in_repo diff --name-only "$base" "$head"); do
  for name in $SUPPRESSION_FILES; do
    [ "$(basename "$path")" = "$name" ] || continue
    if in_repo cat-file -e "$base:$path" 2>/dev/null; then
      in_repo checkout -q "$base" -- "$path"
    else
      rm -f "$repo/$path"
    fi
  done
done

set +e
case "$scanner" in
  gitleaks)
    (cd "$repo" && gitleaks git --log-opts="$base..$head" --config "$fixture/config.toml" --ignore-gitleaks-allow \
      --redact=100 --exit-code 42 --report-format json) >"$work/out" 2>&1
    code=$?
    ;;
  zizmor)
    files=""
    for path in $changed; do
      case "$path" in
        .github/workflows/*.yml | .github/workflows/*.yaml | action.yml | action.yaml | */action.yml | */action.yaml)
          files="$files $path"
          ;;
      esac
    done
    # Word splitting of $files is intended: one argument per workflow, and no path holds a space.
    # shellcheck disable=SC2086
    (cd "$repo" && zizmor --offline --no-progress --format json --config "$fixture/config.yml" $files) >"$work/out" 2>&1
    code=$?
    ;;
  osv-scanner)
    # OSV-Scanner 2 reads `<cache directory>/osv-scalibr/<ecosystem>/all.zip`.
    db="$work/advisories"
    mkdir -p "$db/osv-scalibr/npm"
    node "$here/zip.mjs" "$db/osv-scalibr/npm/all.zip" "$here"/fixtures/osv-db/npm/*.json
    lockfiles=""
    for path in $changed; do
      case "$(basename "$path")" in
        package-lock.json | pnpm-lock.yaml | yarn.lock) lockfiles="$lockfiles -L $path" ;;
      esac
    done
    # shellcheck disable=SC2086
    (cd "$repo" && OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY="$db" osv-scanner scan source --offline-vulnerabilities \
      --format json $lockfiles) >"$work/out" 2>&1
    code=$?
    ;;
  *)
    echo "scan-smoke: unknown scanner $scanner" >&2
    exit 2
    ;;
esac
set -e

tail -n 40 "$work/out" >&2
got=$(result_of "$scanner" "$code")
echo "scan-smoke: $scanner $expected fixture exited $code, which maps to $got"
[ "$got" = "$expected" ]
