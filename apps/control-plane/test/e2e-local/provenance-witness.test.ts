// The private log's witness over the deployed Worker (FD-PROV-039): an operator publishes a verification policy that
// names a witness, the `TransparencyLog` object's alarm signs the checkpoint over the policy's leaf and sends it to
// that witness over C2SP tlog-witness, and the private log's inclusion-proof route then serves the checkpoint with the
// witness's cosignature, which `fd verify`'s witness check accepts (FD-PROV-055). The witness is a local stub that
// answers as C2SP tlog-witness specifies: it checks the log key's signature and the consistency proof from the size
// it last cosigned, and cosigns with its Ed25519 key.
import { createServer, type Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import {
  fromBase64,
  parseCheckpoint,
  verifyCheckpoint,
  verifyConsistency,
} from "@fractalboxdev/flare-dispatch-cache";
import { POLICY_PAYLOAD_TYPE } from "@fractalboxdev/flare-dispatch-cache/provenance-policy";
import { cosignedBy, parseNote } from "@fractalboxdev/flare-dispatch-fd/verify";
import { witnessKey } from "@fractalboxdev/flare-dispatch-fd/verify-test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPERATOR } from "../support.ts";
import { PLANE_ID, startStack, type Stack } from "./stack.ts";

/** One `add-checkpoint` request the witness received, and its answer's status. */
interface Received {
  readonly path: string;
  readonly old: number;
  readonly proof: readonly Uint8Array[];
  readonly checkpoint: string;
  readonly status: number;
}

/** A C2SP tlog-witness for one log whose checkpoints `logJwk` signs. */
const startWitness = async (logJwk: JsonWebKey & { kid: string }) => {
  const key = await witnessKey("witness.e2e.example");
  const received: Received[] = [];
  let size = 0;
  let root: Uint8Array | undefined;
  const answer = async (path: string, body: string): Promise<[number, string]> => {
    const split = body.indexOf("\n\n");
    const [oldLine, ...proofLines] = body.slice(0, split).split("\n");
    const old = /^old (0|[1-9][0-9]*)$/.exec(oldLine ?? "");
    const proof = proofLines.map((l) => fromBase64(l));
    const text = body.slice(split + 2);
    const checkpoint = parseCheckpoint(text);
    if (path !== "/add-checkpoint" || old === null || checkpoint === undefined)
      return [400, "bad request\n"];
    if (!proof.every((h): h is Uint8Array => h?.byteLength === 32)) return [400, "bad proof\n"];
    const record = (status: number) =>
      received.push({ path, old: Number(old[1]), proof, checkpoint: text, status });
    if (checkpoint.origin !== `${PLANE_ID}/private-log`)
      return (record(404), [404, "unknown log\n"]);
    if (!(await verifyCheckpoint(checkpoint, logJwk)))
      return (record(403), [403, "bad signature\n"]);
    if (Number(old[1]) !== size) return (record(409), [409, `${size}\n`]);
    if (
      size > 0 &&
      !(await verifyConsistency(size, checkpoint.size, root!, checkpoint.root, proof))
    )
      return (record(422), [422, "inconsistent\n"]);
    size = checkpoint.size;
    root = checkpoint.root;
    record(200);
    return [200, `${await key.cosign(checkpoint.body, Math.floor(Date.now() / 1000))}\n`];
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void answer(req.url ?? "/", Buffer.concat(chunks).toString("utf8")).then(([status, text]) =>
        res
          .writeHead(status, {
            "content-type": status === 409 ? "text/x.tlog.size" : "text/plain; charset=utf-8",
          })
          .end(text),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    key,
    received,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

/** A private ES256 JWK with its `kid`, as the `PROVENANCE_KEY` and `LOG_KEY` secrets hold it, and its public half. */
const secretKey = (kid: string) => {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
    format: "jwk",
  });
  return {
    secret: JSON.stringify({ ...jwk, kid }),
    public: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid } as JsonWebKey & { kid: string },
  };
};

const LOG = secretKey("log-e2e");
const PROVENANCE = secretKey("prov-e2e");

let stack: Stack;
let witness: Awaited<ReturnType<typeof startWitness>>;

beforeAll(async () => {
  witness = await startWitness(LOG.public);
  stack = await startStack({ secrets: { PROVENANCE_KEY: PROVENANCE.secret, LOG_KEY: LOG.secret } });
});

afterAll(async () => {
  await stack?.close();
  await witness?.close();
});

interface KeyHistory {
  readonly provenance_keys: readonly unknown[];
  readonly log_keys: readonly unknown[];
}

const keyHistory = async (): Promise<KeyHistory> => {
  const answer = await fetch(`${stack.url}/v1/provenance-policy/key-history`, {
    headers: await stack.access(OPERATOR),
  });
  expect(answer.status).toBe(200);
  return (await answer.json()) as KeyHistory;
};

const envelope = (version: string, history: KeyHistory) => ({
  payloadType: POLICY_PAYLOAD_TYPE,
  payload: Buffer.from(
    JSON.stringify({
      policy_version: version,
      issued_at: Date.now(),
      provenance_keys: history.provenance_keys,
      logs: [
        {
          kind: "private",
          keys: history.log_keys,
          witnesses: [{ name: witness.key.name, key: witness.key.vkey, url: witness.url }],
        },
      ],
      devices: [],
      required_tiers: {
        release: "reproduced",
        package: "platform",
        image: "platform",
        "pr-artifact": "platform",
        preview: "platform",
        verdict: "device-signed",
      },
      slsa_build_levels: { cloud: 3, "attested-dedicated": 2, "managed-workstation": 1 },
    }),
  ).toString("base64"),
  signatures: [{ keyid: "policy-root", sig: "MEUCIQ==" }],
});

const publish = async (body: object) => {
  const answer = await fetch(`${stack.url}/v1/provenance-policy`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(await stack.access(OPERATOR)) },
    body: JSON.stringify({ envelope: body }),
  });
  expect(answer.status).toBe(200);
  return (await answer.json()) as { log_index: number };
};

interface ProofView {
  readonly leaf_index: number;
  readonly tree_size: number;
  readonly checkpoint: string;
}

/** The inclusion proof of `leaf` once the route serves it against a checkpoint of `size` the witness cosigned. */
const cosignedProof = async (leaf: number, size: number): Promise<ProofView | undefined> => {
  for (let waited = 0; waited < 30_000; waited += 250) {
    const answer = await fetch(
      `${stack.url}/v1/provenance/log/proof/inclusion?leaf_index=${leaf}`,
      { headers: await stack.access(OPERATOR) },
    );
    if (answer.status === 200) {
      const proof = (await answer.json()) as ProofView;
      if (proof.tree_size === size && proof.checkpoint.includes(`— ${witness.key.name} `))
        return proof;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return undefined;
};

describe("the private log's witness", () => {
  it("[FD-PROV-039] sends each checkpoint the log publishes to the witness the policy names and stores the cosignature it returns", async () => {
    // A publish records the deploy's keys and is refused until its key history carries them (FD-PROV-047).
    const probe = await fetch(`${stack.url}/v1/provenance-policy`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await stack.access(OPERATOR)) },
      body: JSON.stringify({ envelope: envelope("probe", await keyHistory()) }),
    });
    expect(probe.status).toBe(400);
    const recorded = await keyHistory();
    expect(recorded.log_keys).toMatchObject([{ kid: "log-e2e" }]);

    expect(await publish(envelope("2026-11-01", recorded))).toMatchObject({ log_index: 0 });
    const first = await cosignedProof(0, 1);
    expect(first).toBeDefined();
    // The witness received the checkpoint the log key signed, from size 0 with no proof, and cosigned it.
    expect(witness.received).toMatchObject([{ path: "/add-checkpoint", old: 0, status: 200 }]);
    expect(witness.received[0]!.proof).toEqual([]);
    expect(first!.checkpoint.startsWith(witness.received[0]!.checkpoint)).toBe(true);
    // The served checkpoint carries the cosignature `fd verify` checks for a policy witness.
    const note = parseNote(first!.checkpoint)!;
    expect(await cosignedBy(note, witness.key.vkey)).toBe(true);
    const stored = await (await stack.mf.getR2Bucket("CACHE")).get("tlog/private/checkpoint");
    expect(await stored!.text()).toBe(first!.checkpoint);

    // A second version grows the log; the witness receives the next checkpoint with the consistency proof from size 1.
    expect(await publish(envelope("2026-11-12", recorded))).toMatchObject({ log_index: 1 });
    const second = await cosignedProof(1, 2);
    expect(second).toBeDefined();
    const accepted = witness.received.filter((r) => r.status === 200);
    expect(accepted).toHaveLength(2);
    expect(accepted[1]).toMatchObject({ old: 1 });
    expect(accepted[1]!.proof).toHaveLength(1);
    expect(await cosignedBy(parseNote(second!.checkpoint)!, witness.key.vkey)).toBe(true);
    // A cosignature by a key the policy does not name is no cosignature.
    const stranger = await witnessKey(witness.key.name);
    expect(await cosignedBy(parseNote(second!.checkpoint)!, stranger.vkey)).toBe(false);
  });
});
