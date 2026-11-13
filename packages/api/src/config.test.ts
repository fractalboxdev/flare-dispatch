// The API configuration's key distinctness: the provenance key against the OIDC key, the log key and every
// capability-token key (specs/provenance.md § Keys).
import { describe, expect, it } from "vitest";
import {
  apiConfigFromEnv,
  ConfigInvalid,
  distinctProvenanceKey,
  PROVENANCE_KEY_DISTINCT_FROM,
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
