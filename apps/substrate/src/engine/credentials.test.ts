import { describe, expect, it } from "vitest";
import type { CredentialDescriptor } from "@fractalboxdev/flare-dispatch-substrate-contract";
import {
  CONTAINER_AUTHORED_AUTH_HEADERS,
  CREDENTIAL_CATALOG,
  INJECTABLE_SECRETS,
  credentialsByHost,
  isInjectableSecret,
  parseHeaderTemplate,
  renderCredential,
  resolveCredential,
} from "./credentials";

const CF: CredentialDescriptor = {
  secretName: "CLOUDFLARE_API_TOKEN",
  host: "api.cloudflare.com",
  headerTemplate: "authorization: Bearer {{secret}}",
};

describe("parseHeaderTemplate", () => {
  it("splits `Name: value` and lowercases the name", () => {
    const parsed = parseHeaderTemplate("Authorization: Bearer {{secret}}");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.template.name).toBe("authorization");
      expect(parsed.template.valueTemplate).toBe("Bearer {{secret}}");
    }
  });

  it("refuses a template carrying a CR or LF — a second header is a forged one", () => {
    expect(parseHeaderTemplate("authorization: Bearer {{secret}}\r\nx-evil: 1").ok).toBe(false);
    expect(parseHeaderTemplate("authorization: Bearer {{secret}}\nx-evil: 1").ok).toBe(false);
  });

  it("refuses a name that is not a header token", () => {
    expect(parseHeaderTemplate("auth orization: {{secret}}").ok).toBe(false);
    expect(parseHeaderTemplate(": {{secret}}").ok).toBe(false);
  });

  it("requires exactly one {{secret}}", () => {
    expect(parseHeaderTemplate("authorization: Bearer").ok).toBe(false);
    expect(parseHeaderTemplate("authorization: {{secret}} {{secret}}").ok).toBe(false);
  });
});

describe("renderCredential", () => {
  it("substitutes the value into the template", () => {
    const out = renderCredential(CF, "cf_token_value");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.header).toEqual({ name: "authorization", value: "Bearer cf_token_value" });
  });

  it("refuses a secret with a trailing newline rather than trimming it", () => {
    const out = renderCredential(CF, "cf_token_value\n");
    expect(out.ok).toBe(false);
    // The reason names the binding, never the value.
    if (!out.ok) expect(out.reason).not.toContain("cf_token_value");
  });

  it("refuses an empty secret", () => {
    expect(renderCredential(CF, "").ok).toBe(false);
  });
});

describe("resolveCredential", () => {
  it("resolves a descriptor whose secret is on the allowlist and set", () => {
    const out = resolveCredential(CF, (name) =>
      name === "CLOUDFLARE_API_TOKEN" ? "tok" : undefined,
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.header.value).toBe("Bearer tok");
  });

  it("refuses a secret name off the allowlist even when the resolver would answer", () => {
    const ticketReader: CredentialDescriptor = { ...CF, secretName: "TICKET_SECRET" };
    const out = resolveCredential(ticketReader, () => "the-ticket-signing-key");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("not injectable");
  });

  it("fails closed when the binding is unset — never sends the request bare", () => {
    const out = resolveCredential(CF, () => undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("not configured");
  });
});

describe("the catalog", () => {
  it("names only injectable secrets", () => {
    for (const descriptors of Object.values(CREDENTIAL_CATALOG))
      for (const d of descriptors) expect(isInjectableSecret(d.secretName)).toBe(true);
  });

  it("carries no glob host and no unparseable template", () => {
    for (const descriptors of Object.values(CREDENTIAL_CATALOG))
      for (const d of descriptors) {
        expect(d.host).not.toContain("*");
        expect(parseHeaderTemplate(d.headerTemplate).ok).toBe(true);
      }
  });

  it("attaches CLOUDFLARE_API_TOKEN to api.cloudflare.com under cf-api", () => {
    const byHost = credentialsByHost(["cf-api"]);
    expect(byHost.get("api.cloudflare.com")?.secretName).toBe("CLOUDFLARE_API_TOKEN");
  });

  it("contributes nothing for a profile that takes no credential", () => {
    expect(credentialsByHost(["public-repo-read"]).size).toBe(0);
    expect(credentialsByHost(undefined).size).toBe(0);
  });

  it("keeps every allowlisted secret reachable from some profile", () => {
    const named = new Set(
      Object.values(CREDENTIAL_CATALOG).flatMap((ds) => ds.map((d) => d.secretName)),
    );
    for (const secret of INJECTABLE_SECRETS) expect(named.has(secret)).toBe(true);
  });
});

describe("container-authored auth headers", () => {
  it("lists the headers a container could smuggle a credential in", () => {
    expect(CONTAINER_AUTHORED_AUTH_HEADERS).toContain("authorization");
    expect(CONTAINER_AUTHORED_AUTH_HEADERS).toContain("cookie");
    expect(CONTAINER_AUTHORED_AUTH_HEADERS).toContain("x-auth-key");
  });
});
