// What /roadmap/ reports under "Status now". Each capability sits in exactly one state. A claim
// about what deploys comes from main; one about development comes from the v2 branch;
// one about the design comes from specs/, with its phase from specs/roadmap.md.

export const LOCAL_CI_SOURCE = "https://github.com/fractalboxdev/flare-dispatch/tree/v2/packages/local-ci";
export const IMPL_PR = "https://github.com/fractalboxdev/flare-dispatch/pull/246";

export interface Capability {
  readonly what: string;
  readonly detail: string;
}

export interface State {
  readonly id: string;
  readonly title: string;
  readonly lede: string;
  readonly capabilities: readonly Capability[];
}

export const states: readonly State[] = [
  {
    id: "deploys-today",
    title: "Deploys today",
    lede: "v1, from main. A Dispatcher Worker and a GitHub App in your own Cloudflare account.",
    capabilities: [
      { what: "Jobs in Cloudflare Containers, from Actions, webhook or cron", detail: "Workflows orchestrate; R2 holds cache and artifacts" },
      { what: "CI, scheduled tasks and agents", detail: "The run catalog, including the eight agentic recipes" },
      { what: "flare-dispatch/<run> check runs and tokened logs", detail: "Dispatcher" },
      { what: "HMAC-verified dispatch and webhook signatures", detail: "Dispatcher" },
      { what: "Access-gated dashboard", detail: "Dispatcher" },
      { what: "Containers with no internet access and reviewed egress grants", detail: "The substrate. It ships off: a deployment opts in, and by default runs use the Dispatcher's own containers, without this control" },
    ],
  },
  {
    id: "in-development",
    title: "Runs today in development",
    lede: "v2, on the v2 branch. Nothing here deploys, and none of it is for production.",
    capabilities: [
      { what: "Control plane on mameko's host-cloudflare", detail: "Under wrangler dev, with local D1 and Durable Objects" },
      { what: "One owned machine, through mameko's Rust device executor", detail: "batch class, one run (check)" },
      { what: "Connect-signed device sessions", detail: "The upgrade's signature is verified against the enrolled device key" },
      { what: "Device-key enrollment", detail: "Software key under development only. Production requires an attested Secure Enclave key and no verifier is wired, so it refuses every key" },
      { what: "Leases with epochs", detail: "The record names the accepted epoch" },
      { what: "Production refuses host execution and software keys", detail: "The route answers 403, and the runner's catalog is empty outside development" },
      { what: "Allow-listed job environment", detail: "The command strips credentials from every child process" },
      { what: "Application profile and check-run applier", detail: "Packages on #246; nothing drains the outbox to them" },
    ],
  },
  {
    id: "specified",
    title: "Specified",
    lede: "v2, in specs/. None of this runs yet. The number is the roadmap phase.",
    capabilities: [
      { what: "Cloudflare Containers under the v2 control plane", detail: "Phase 0" },
      { what: "The GitHub path end to end, from an execution to a check run", detail: "Phase 0" },
      { what: "Spend meter: holds, class lines, burn lanes and an operator halt", detail: "Phase 0" },
      { what: "Queue, then fail: named reasons, never a neutral conclusion", detail: "Phase 0" },
      { what: "Lean 4 models of the kernels", detail: "ADR-0018. FlareDispatch holds no model yet" },
      { what: "Reclaim after a lost device, with stale results rejected", detail: "Phase 1; no schedule wired yet" },
      { what: "Owned devices for batch work, capacity leases, local scheduler", detail: "Phase 1" },
      { what: "A job sandbox per job on a device", detail: "MAMEKO-ISO-001. Phase 1 waits on it" },
      { what: "Deny-all egress on devices and per-lease credentials", detail: "Phase 1" },
      { what: "Interactive work on owned devices with a 300 s claim deadline", detail: "Phase 2" },
      { what: "Egress profiles, staged writeback and local model routes", detail: "Phase 2" },
      { what: "Required checks with a 60 s claim deadline, and the AWS launcher", detail: "Phase 3" },
      { what: "Device attestation, provenance tiers and confidential mode", detail: "Phase 4" },
      { what: "macOS VM jobs and the GitHub Actions launcher", detail: "Phase 4" },
    ],
  },
];

/** What `pnpm ci:local` shows, from its own verification record. */
export const proves: readonly string[] = [
  "A device enrolls by key, connects with a signed upgrade and takes a real execution lease from the control plane.",
  "The check run installs, lints, typechecks and tests one commit in a clean directory.",
  "The verdict printed is the coordinator's record, for success and for deliberately failing commits.",
];

export const doesNotProve: readonly string[] = [
  "A real deployment: the control plane runs under wrangler dev and deploys nothing.",
  "Job isolation: the job runs on the host under your own user, which MAMEKO-ISO-001 forbids in a conformant deployment. No conformant macOS runtime exists yet, and production refuses the run.",
  "Reclaim and the outbox drain: neither is exercised, so nothing reaches GitHub.",
  "Anything about the cloud path, spend or warm-run speed.",
];
