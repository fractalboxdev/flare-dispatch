#!/bin/sh
# Trust the Cloudflare Containers interception CA, then hand off to the sandbox
# server. Shared by Dockerfile.substrate and Dockerfile.task.
#
# The substrate's DO classes run `interceptHttps = true`, so every HTTPS request
# a container makes is terminated by `ContainerProxy` and re-issued by the
# outbound handler (ADR-0005). The certificate a tool validates is therefore the
# platform's, not the origin's, and the container has to trust its issuer.
#
# This cannot be a Docker layer. The CA is materialised into the container at
# RUNTIME and does not exist during the image build — so the copy has to happen
# on every boot, before anything a workload runs. That is the whole reason this
# file exists rather than another `RUN` in the Dockerfile.
#
# Both bases are Ubuntu jammy, which is why the destination directory and the
# refresh command are the Debian/Ubuntu pair. A base that moved to Alpine keeps
# working (same pair); one that moved to RHEL or Arch would need the matching
# `update-ca-trust` / `trust extract-compat`, and the missing-tool branch below
# is what would say so in the logs.
set -eu

CA_SRC=/etc/cloudflare/certs/cloudflare-containers-ca.crt
CA_DST=/usr/local/share/ca-certificates/cloudflare-containers-ca.crt

# Deliberately non-fatal. A boot that dies here takes the whole execution with
# it and reports a container that never started; a boot that continues without
# the CA fails every HTTPS request with a TLS error the substrate's own canary
# is built to name (`POST /canary` → the HTTPS probe, ADR-0011), and `/health`
# answers 503 `unverified` until it passes. The gate is where this fails closed,
# not the entrypoint — and that keeps a platform change in where the CA is
# mounted from bricking a fleet that would otherwise still serve HTTP.
if [ -r "$CA_SRC" ] && [ -s "$CA_SRC" ]; then
  if command -v update-ca-certificates >/dev/null 2>&1; then
    cp "$CA_SRC" "$CA_DST"
    update-ca-certificates >/dev/null
    echo "substrate-entrypoint: interception CA installed into the system trust store" >&2
  else
    echo "substrate-entrypoint: WARNING no update-ca-certificates on this base — HTTPS interception will fail TLS" >&2
  fi
else
  echo "substrate-entrypoint: WARNING $CA_SRC absent or empty — HTTPS interception will fail TLS" >&2
fi

# `exec`, so the sandbox server keeps PID 1 and receives the SIGTERM the
# platform sends at idle-stop. A wrapper left in the process tree would swallow
# it and turn every sleep into a kill.
exec /container-server/sandbox "$@"
