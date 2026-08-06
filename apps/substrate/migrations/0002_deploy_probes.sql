-- Deploy-probe verdicts (ADR-0011): what the SDK-pin canary and the facade
-- dogfood observed, keyed by the Worker version that was probed.
--
-- One row per (deployment, probe). It is both the audit record `/health` reads
-- and the rate limit that lets the probe endpoints stay credential-free — see
-- src/verify/store-d1.ts.

CREATE TABLE IF NOT EXISTS sub_deploy_probes (
  deployment_id     TEXT NOT NULL, -- Worker version id, or `v<semver>` when unbound
  probe             TEXT NOT NULL CHECK (probe IN ('canary', 'dogfood')),
  status            TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'inconclusive')),
  evidence          TEXT NOT NULL,
  substrate_version TEXT NOT NULL,
  checked_at        INTEGER NOT NULL,
  PRIMARY KEY (deployment_id, probe)
);
