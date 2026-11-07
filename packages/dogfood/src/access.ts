// The dogfood command's own Access team. The control plane's routes admit only a verified Cloudflare Access identity,
// and a local run has no Access edge, so the command holds an RS256 key, serves its JWKS on a local port at Access's
// certs path and signs the operator's JWT. The control plane verifies it exactly as it verifies Access's.
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Effect } from "effect";

/** The identity the command enrolls and dispatches as; the deployment lists it in `operators` and `dispatchers`. */
export const DOGFOOD_IDENTITY = "dogfood@localhost";

/** How long the operator's JWT verifies: longer than any dogfood run. */
const JWT_LIFETIME_SEC = 4 * 3600;

const base64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

export interface LocalAccessTeam {
  /** The team domain the deployment reads: the issuer and the origin of the certs endpoint. */
  readonly teamDomain: string;
  readonly aud: string;
  /** The operator's Access JWT. */
  readonly jwt: string;
}

/** Starts the team's certs endpoint for the command's scope and signs the operator's JWT. */
export const startAccessTeam = Effect.acquireRelease(
  Effect.callback<{ readonly team: LocalAccessTeam; readonly close: () => void }>((resume) => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = randomBytes(8).toString("hex");
    const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/cdn-cgi/access/certs") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const teamDomain = `http://127.0.0.1:${port}`;
      const aud = randomBytes(16).toString("hex");
      const now = Math.floor(Date.now() / 1000);
      const signing = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }))}.${base64url(
        JSON.stringify({
          iss: teamDomain,
          aud: [aud],
          email: DOGFOOD_IDENTITY,
          iat: now,
          exp: now + JWT_LIFETIME_SEC,
        }),
      )}`;
      const signature = createSign("RSA-SHA256").update(signing).sign(privateKey);
      resume(
        Effect.succeed({
          team: { teamDomain, aud, jwt: `${signing}.${base64url(signature)}` },
          close: () => server.close(),
        }),
      );
    });
  }),
  ({ close }) => Effect.sync(close),
).pipe(Effect.map(({ team }) => team));
