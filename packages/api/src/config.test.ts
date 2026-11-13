// The API configuration's key distinctness: the provenance key against the OIDC key, the log key and every
// capability-token key (specs/provenance.md § Keys), and the verdict record signing key against the webhook secret,
// the link key, the OIDC key and the provenance key (specs/github-output.md § Job and verdict records).
import { describe, expect, it } from "vitest";
import {
  apiConfigFromEnv,
  ConfigInvalid,
  distinctProvenanceKey,
  distinctRecordsKey,
  PROVENANCE_KEY_DISTINCT_FROM,
  RECORDS_KEY_DISTINCT_FROM,
} from "./config.ts";

const ORIGIN = "https://fd.example.com";

/** A private ES256 JWK with private scalar `d`; the coordinates are placeholders. */
const jwk = (d: string, kid: string) => ({ kty: "EC", crv: "P-256", x: "x", y: "y", d, kid });

describe("provenance key distinctness", () => {
  it("[FD-PROV-033] the API configuration refuses a provenance key equal to the OIDC key, the log key or any capability-token key, naming the binding and never the value", () => {
    expect(PROVENANCE_KEY_DISTINCT_FROM).toEqual([
      "OIDC_SIGNING_JWK",
      "LOG_KEY",
      "LINK_KEY",
      "COMPILE_CACHE_SECRET",
      "CACHE_TOKEN_SECRET",
      "INSTALL_STATE_KEY",
    ]);
    // LINK_KEY is set apart from the provenance key, so the link key's own check (FD-IFC-023) passes first.
    for (const name of PROVENANCE_KEY_DISTINCT_FROM.filter((n) => n !== "LINK_KEY")) {
      const refused = apiConfigFromEnv(
        { PROVENANCE_KEY: "prov-secret-value", [name]: " prov-secret-value " },
        ORIGIN,
      );
      expect(refused, name).toBeInstanceOf(ConfigInvalid);
      expect((refused as ConfigInvalid).path).toBe("PROVENANCE_KEY");
      expect((refused as ConfigInvalid).message).toBe(`the provenance key equals ${name}`);
      expect((refused as ConfigInvalid).message).not.toContain("prov-secret-value");
    }
    expect(distinctProvenanceKey({ PROVENANCE_KEY: "k", LINK_KEY: "k" })).toMatchObject({
      path: "PROVENANCE_KEY",
      message: "the provenance key equals LINK_KEY",
    });

    const distinct = apiConfigFromEnv(
      {
        PROVENANCE_KEY: "prov",
        OIDC_SIGNING_JWK: "oidc",
        LOG_KEY: "log",
        LINK_KEY: "link",
        COMPILE_CACHE_SECRET: "compile",
        CACHE_TOKEN_SECRET: "cache",
        INSTALL_STATE_KEY: "install",
      },
      ORIGIN,
    );
    expect(distinct).not.toBeInstanceOf(ConfigInvalid);
    expect(distinctProvenanceKey({ OIDC_SIGNING_JWK: "k", LOG_KEY: "k" })).toBeUndefined();
  });

  it("[FD-PROV-033] a provenance key whose private JWK is the OIDC key set's current or retired key is refused however each secret is written", () => {
    const provenance = JSON.stringify(jwk("shared-scalar", "prov-1"));
    const current = JSON.stringify({ current: jwk("shared-scalar", "oidc-2"), retired: [] });
    expect(
      distinctProvenanceKey({ PROVENANCE_KEY: provenance, OIDC_SIGNING_JWK: current }),
    ).toMatchObject({ message: "the provenance key equals OIDC_SIGNING_JWK" });
    const retired = JSON.stringify({
      current: jwk("other-scalar", "oidc-3"),
      retired: [{ jwk: jwk("shared-scalar", "oidc-2"), retiredAt: 1 }],
    });
    expect(
      distinctProvenanceKey({ PROVENANCE_KEY: provenance, OIDC_SIGNING_JWK: retired }),
    ).toBeInstanceOf(ConfigInvalid);
    expect(
      distinctProvenanceKey({
        PROVENANCE_KEY: provenance,
        LOG_KEY: JSON.stringify(jwk("log-scalar", "prov-1")),
        OIDC_SIGNING_JWK: JSON.stringify({ current: jwk("other-scalar", "oidc-3"), retired: [] }),
      }),
    ).toBeUndefined();
  });
});

describe("records signing key distinctness", () => {
  /** Every key distinct; each clash below shares the records key with one of them. */
  const DISTINCT = {
    RECORDS_SIGNING_KEY: "records-secret-value",
    WEBHOOK_SECRET: "webhook",
    LINK_KEY: "link",
    OIDC_SIGNING_JWK: "oidc",
    PROVENANCE_KEY: "prov",
  };

  it("[FD-GH-099] the API configuration refuses a records signing key equal to the webhook secret, the link key, the OIDC key or the provenance key, naming the binding and never the value", () => {
    expect(RECORDS_KEY_DISTINCT_FROM).toEqual([
      "WEBHOOK_SECRET",
      "LINK_KEY",
      "OIDC_SIGNING_JWK",
      "PROVENANCE_KEY",
    ]);
    expect(apiConfigFromEnv(DISTINCT, ORIGIN)).not.toBeInstanceOf(ConfigInvalid);
    for (const name of RECORDS_KEY_DISTINCT_FROM) {
      const refused = apiConfigFromEnv({ ...DISTINCT, [name]: " records-secret-value " }, ORIGIN);
      expect(refused, name).toBeInstanceOf(ConfigInvalid);
      expect((refused as ConfigInvalid).path, name).toBe("RECORDS_SIGNING_KEY");
      expect((refused as ConfigInvalid).message).toBe(`the records signing key equals ${name}`);
      expect((refused as ConfigInvalid).message).not.toContain("records-secret-value");
    }
    // No records key, nothing to compare; the other keys' own checks are theirs.
    expect(distinctRecordsKey({ WEBHOOK_SECRET: "k", LINK_KEY: "other" })).toBeUndefined();
    // The log key and the capability-token keys are outside this rule.
    expect(
      distinctRecordsKey({ RECORDS_SIGNING_KEY: "k", LOG_KEY: "k", CACHE_TOKEN_SECRET: "k" }),
    ).toBeUndefined();
  });

  it("[FD-GH-099] a records key whose private JWK is the OIDC key set's current key is refused however each secret is written", () => {
    const records = JSON.stringify(jwk("shared-scalar", "records-1"));
    const oidc = JSON.stringify({ current: jwk("shared-scalar", "oidc-2"), retired: [] });
    expect(
      distinctRecordsKey({ RECORDS_SIGNING_KEY: records, OIDC_SIGNING_JWK: oidc }),
    ).toMatchObject({
      path: "RECORDS_SIGNING_KEY",
      message: "the records signing key equals OIDC_SIGNING_JWK",
    });
  });
});

describe("containment identities", () => {
  it("[FD-IFC-095] reads the overlay's containment identities from CONTAINMENT, lowercased, and none where it names none", () => {
    const config = apiConfigFromEnv(
      { CONTAINMENT: JSON.stringify([" Responder@Example.com ", "oncall@example.com"]) },
      ORIGIN,
    );
    expect(config).not.toBeInstanceOf(ConfigInvalid);
    expect((config as { containment: readonly string[] }).containment).toEqual([
      "responder@example.com",
      "oncall@example.com",
    ]);
    expect(
      (apiConfigFromEnv({}, ORIGIN) as { containment: readonly string[] }).containment,
    ).toEqual([]);
  });

  it("[FD-IFC-095] refuses a CONTAINMENT value that is not a JSON array of identities", () => {
    expect(apiConfigFromEnv({ CONTAINMENT: "responder@example.com" }, ORIGIN)).toMatchObject({
      _tag: "ConfigInvalid",
      path: "CONTAINMENT",
    });
  });
});
