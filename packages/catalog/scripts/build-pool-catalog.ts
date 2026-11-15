// Builds the run-catalogue bundle a Container pool's device executor pins (MAMEKO-EXEC-144): the cloud runner entry
// (`src/cloud-runner-entry.ts`) bundled with the runner. `infra/v2/Dockerfile.gate` runs it at image build time:
//
//   node --experimental-strip-types --no-warnings packages/catalog/scripts/build-pool-catalog.ts <out dir>
//
// It writes `<out>/bundle` (`catalog.mjs`, `manifest.json`, `manifest.sig`), `<out>/pin` (the bundle's SHA-256) and
// `<out>/key` (the base64 SPKI of the manifest's signing key). Each build generates its signing key and discards the
// private half: the gate image's digest pins the bundle, the pin and the key together, so the signature proves no more
// than the image digest already does, and no key outlives the build that made it.
//
// Every run the manifest lists must carry the run-definition digest `src/run-digests.json` holds, which is the
// `run_digest` the control plane writes on a lease; otherwise the build fails and writes no pin or key.
import { webcrypto } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalogBundle } from "@fractalboxdev/mameko-runner";

const ENTRY = fileURLToPath(new URL("../src/cloud-runner-entry.ts", import.meta.url));
const RUN_DIGESTS = fileURLToPath(new URL("../src/run-digests.json", import.meta.url));

const out = process.argv[2];
if (out === undefined || out === "") {
  process.stderr.write("usage: build-pool-catalog.ts <out dir>\n");
  process.exit(64);
}
const outDir = resolve(out);

const pair = (await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
])) as webcrypto.CryptoKeyPair;
const manifest = await buildCatalogBundle({
  catalog: ENTRY,
  outDir: join(outDir, "bundle"),
  signingKey: pair.privateKey,
});

const committed = JSON.parse(readFileSync(RUN_DIGESTS, "utf8")) as Readonly<Record<string, string>>;
const mismatched = manifest.runs.filter((run) => committed[run.name] !== run.run_digest);
if (manifest.runs.length === 0 || mismatched.length > 0) {
  for (const run of mismatched)
    process.stderr.write(
      `${run.name}: the bundle's run digest ${run.run_digest} differs from run-digests.json's ${committed[run.name] ?? "(none)"}\n`,
    );
  if (manifest.runs.length === 0) process.stderr.write("the bundle lists no run\n");
  process.exit(1);
}

const spki = Buffer.from(await webcrypto.subtle.exportKey("spki", pair.publicKey)).toString(
  "base64",
);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "pin"), `${manifest.bundle_sha256}\n`);
writeFileSync(join(outDir, "key"), `${spki}\n`);
process.stdout.write(
  `${JSON.stringify({ bundle_sha256: manifest.bundle_sha256, runs: manifest.runs.map((r) => r.name) })}\n`,
);
