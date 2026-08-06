import { describe, expect, it } from "vitest";
import {
  CANARY_PROBE_HOST_DEFAULT,
  canaryProbeScript,
  DENIED_STATUS,
  interpretCanary,
  parseProbeLines,
  resolveProbeHost,
} from "./probe";

const line = (url: string, code: string, body = "", err = "") =>
  `PROBE|${url}|${code}|${body}|${err}`;

describe("resolveProbeHost", () => {
  it("keeps a plain hostname", () => {
    expect(resolveProbeHost("example.org")).toBe("example.org");
    expect(resolveProbeHost("  Deep.Sub.Example.COM ")).toBe("deep.sub.example.com");
  });

  it("degrades to the default rather than interpolating shell metacharacters", () => {
    // A typo must read as "operator misconfigured the probe", never as a
    // command injected into the script the container runs.
    for (const hostile of [
      '"; curl https://evil.example/ #',
      "example.com/../../",
      "$(whoami).example.com",
      "example.com`id`",
      "localhost",
      "",
      undefined,
    ])
      expect(resolveProbeHost(hostile)).toBe(CANARY_PROBE_HOST_DEFAULT);
  });
});

describe("canaryProbeScript", () => {
  it("probes both schemes, since https additionally depends on TLS interception", () => {
    const script = canaryProbeScript("example.com");
    expect(script).toContain('probe "https://example.com/"');
    expect(script).toContain('probe "http://example.com/"');
  });

  it("never lets a failing curl abort the script", () => {
    // `set -e` here would swallow the second probe whenever the first one
    // fails at the transport — which is the common case on a working gate.
    const script = canaryProbeScript("example.com");
    expect(script).not.toMatch(/^set -e\b/m);
    expect(script).toContain("|| code=");
  });
});

describe("parseProbeLines", () => {
  it("reads the fields and ignores everything else on the tail", () => {
    const parsed = parseProbeLines(
      [
        "some unrelated log noise",
        line("https://example.com/", "520", "Origin is disallowed"),
        "PROBE-END",
      ].join("\n"),
    );
    expect(parsed).toEqual([
      { url: "https://example.com/", code: 520, body: "Origin is disallowed", err: "" },
    ]);
  });

  it("reports a curl transport failure as code 0, not as a missing probe", () => {
    expect(
      parseProbeLines(line("https://example.com/", "000", "", "SSL peer handshake failed")),
    ).toEqual([
      { url: "https://example.com/", code: 0, body: "", err: "SSL peer handshake failed" },
    ]);
  });
});

describe("interpretCanary", () => {
  it("passes on a 520 from the HTTPS probe — the protocol every grant is written in", () => {
    const verdict = interpretCanary({
      exitCode: 0,
      output: [
        line("https://example.com/", String(DENIED_STATUS), "Origin is disallowed"),
        line("http://example.com/", String(DENIED_STATUS), "Origin is disallowed"),
      ].join("\n"),
    });
    expect(verdict.status).toBe("passed");
    expect(verdict.evidence).toContain("HTTPS interception engaged");
  });

  it("does not pass on an http-only 520 — that is the untrusted-CA signature (#72)", () => {
    // `interceptAllOutboundHttp` is registered unconditionally, so http answers
    // 520 whether or not the container trusts the interception CA. An https
    // probe dying at the handshake alongside it means every granted host is
    // unreachable and no denial is recorded — not a verified deploy.
    const verdict = interpretCanary({
      exitCode: 0,
      output: [
        line("https://example.com/", "000", "", "SSL certificate problem: unable to get issuer"),
        line("http://example.com/", String(DENIED_STATUS), "Origin is disallowed"),
      ].join("\n"),
    });
    expect(verdict.status).toBe("inconclusive");
    expect(verdict.evidence).toContain("unable to get issuer");
    expect(verdict.evidence).toContain("no granted host is reachable");
  });

  it("fails when anything reached the host — the direction ADR-0011 names", () => {
    const verdict = interpretCanary({
      exitCode: 0,
      output: line("https://example.com/", "200", "<html>"),
    });
    expect(verdict.status).toBe("failed");
    expect(verdict.evidence).toContain("deny-all gate is not engaged");
  });

  it("treats a redirect as reached: a 3xx is a completed round trip to an unadmitted origin", () => {
    expect(
      interpretCanary({ exitCode: 0, output: line("http://example.com/", "301") }).status,
    ).toBe("failed");
  });

  it("prefers the failure verdict when one scheme got through and the other was denied", () => {
    const verdict = interpretCanary({
      exitCode: 0,
      output: [
        line("https://example.com/", String(DENIED_STATUS), "Origin is disallowed"),
        line("http://example.com/", "200", "<html>"),
      ].join("\n"),
    });
    expect(verdict.status).toBe("failed");
  });

  it("is inconclusive when nothing answered — absence of egress is not proof of interception", () => {
    // A container with no network at all also reaches nothing. Calling that a
    // pass would let a broken proxy hide behind a broken container.
    const verdict = interpretCanary({
      exitCode: 7,
      output: [
        line("https://example.com/", "000", "", "Could not resolve host"),
        line("http://example.com/", "000"),
      ].join("\n"),
    });
    expect(verdict.status).toBe("inconclusive");
    expect(verdict.evidence).toContain("Could not resolve host");
  });

  it("is inconclusive when the command produced no probe output at all", () => {
    const verdict = interpretCanary({ exitCode: 2, output: "sh: curl: not found\n" });
    expect(verdict.status).toBe("inconclusive");
    expect(verdict.evidence).toContain("exit 2");
  });
});
