// The local-work scenarios of the `sim` job (specs/verification.md § V-SIM, specs/local-scheduler.md). A device's local
// scheduler runs a seeded fleet of local executions through FlareDispatch's local run context, against the control
// plane's registration port, writeback gate and outbox over one D1 database (local-plane.test-support.ts), on a
// virtual clock. Each seed fixes every interleaving and fault; each `check*` asserts its requirement on one seed and
// throws on a violation, as the `sim` job requires of a scenario.
//
// - `local-grant-rejection` (FD-LOCAL-071): capacity grants arrive at renewals and each rejects a seeded subset of the
//   registered in-flight executions, while offline windows open and close and each sent request reaches the control
//   plane after a seeded delay, some twice.
// - `local-registration` (FD-LOCAL-075): executions ask for reuse, writeback, both or neither, in a seeded order,
//   under stale leases, failed D1 writes and a device that sends `local.register` for an execution that wants neither.
import { Effect } from "effect";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import { needsRegistration, type RegistrationWants } from "../../src/local/registration.ts";
import {
  appendIntent,
  DECORATION_KINDS,
  type LocalRunContext,
  type WritebackRequest,
} from "../../src/local/run-context.ts";
import {
  localPlane,
  MANIFEST,
  registrationPayload,
  type LocalPlane,
} from "../local-plane.test-support.ts";

export const GRANT_SCENARIO = "local-grant-rejection";
export const REGISTRATION_SCENARIO = "local-registration";

const MINUTE_MS = 60_000;

const rng = (seed: number) => {
  const next = seededRandom(seed);
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    chance: (p: number) => next() < p,
  };
};
type Rng = ReturnType<typeof rng>;

const KINDS = ["pr.propose", "review", "check.summary", "check.annotations"] as const;
const payloadOf = (kind: string) =>
  kind === "pr.propose" ? { manifest: MANIFEST } : kind === "review" ? { body: "LGTM" } : {};

/** One `Intents` append of a step: `index` is its place among the step's appends. */
interface Append {
  readonly at: number;
  readonly step: string;
  readonly index: number;
  readonly kind: string;
}

/** The appends of one execution's steps, at increasing virtual times from `start`. */
const appendsOf = (r: Rng, start: number): Append[] => {
  const out: Append[] = [];
  let at = start;
  const steps = 1 + r.int(4);
  for (let s = 0; s < steps; s++) {
    const count = 1 + r.int(3);
    for (let index = 0; index < count; index++) {
      at += 1 + r.int(40_000);
      out.push({ at, step: `step-${s}`, index, kind: KINDS[r.int(KINDS.length)]! });
    }
  }
  return out;
};

const isWriteback = (kind: string) => !DECORATION_KINDS.includes(kind);

/** Runs one append through the local run context; answers why it failed, or null when it succeeded. */
const append = (ctx: LocalRunContext, a: Append): Promise<string | null> =>
  Effect.runPromise(
    appendIntent(ctx, a.step, a.index, a.kind, payloadOf(a.kind)).pipe(
      Effect.as(null),
      Effect.catchTags({
        RegistrationRequired: () => Effect.succeed("RegistrationRequired"),
        WritebackHeld: (e) => Effect.succeed(`WritebackHeld:${e.reason}`),
      }),
    ),
  );

// ---------------------------------------------------------------------------------------------------------------------
// local-grant-rejection (FD-LOCAL-071)

/** One event on the virtual clock. */
type GrantEvent =
  | {
      readonly type: "append";
      readonly at: number;
      readonly execution: number;
      readonly append: Append;
    }
  | { readonly type: "grant"; readonly at: number; readonly rejects: readonly number[] }
  | { readonly type: "offline"; readonly at: number; readonly on: boolean }
  | {
      readonly type: "arrive";
      readonly at: number;
      readonly request: WritebackRequest;
      readonly sentAt: number;
    };

/** What one seed reached, for a run over many seeds to show the property was exercised. */
export interface GrantOutcome {
  /** A rejected execution appended a writeback kind after the grant that rejected it. */
  readonly heldAfterRejection: boolean;
  /** A request sent before its execution's rejecting grant reached the control plane after it. */
  readonly inFlightAtGrant: boolean;
  /** A request reached the control plane twice and the second wrote nothing. */
  readonly redelivered: boolean;
  readonly heldOffline: boolean;
}

/**
 * Runs one seed of `local-grant-rejection` and asserts FD-LOCAL-071 on it: once a grant rejects a registered in-flight
 * execution, the local scheduler sends no `local.writeback` request for it, and every later writeback append of it is
 * held as `grant-rejected` (or `offline`); a request sent before that grant may still arrive, and the control plane's
 * outbox holds no intent the execution appended after it. Liveness: every writeback append of an execution no grant
 * rejected, made online, is sent.
 */
export const checkGrantRejection = async (seed: number): Promise<GrantOutcome> => {
  const r = rng(seed);
  // A rate past the fleet's requests, so the gate's rate window does not hide what the device sends.
  const plane = await localPlane({ rate: 10_000 });
  try {
    const fleet = 2 + r.int(4);
    const ids: string[] = [];
    for (let e = 0; e < fleet; e++) {
      const answer = await plane.register(
        true,
        registrationPayload(`rk-${e}`, { reuse: r.chance(0.5), writeback: true }),
      );
      if (!("execution_id" in answer)) throw new Error(`seed ${seed}: registration ${e} rejected`);
      ids.push(answer.execution_id);
      // The verdict is recorded up front so the gate's success check does not hide what the device sends.
      await plane.conclude(answer.execution_id, "success");
    }

    // Each event carries a seeded tie-break, so events at one instant run in an order the seed fixes.
    const events: { readonly ev: GrantEvent; readonly order: number }[] = [];
    const push = (ev: GrantEvent) => events.push({ ev, order: r.next() });
    const plans = ids.map(() => appendsOf(r, r.int(MINUTE_MS)));
    plans.forEach((appends, e) =>
      appends.forEach((a) => push({ type: "append", at: a.at, execution: e, append: a })),
    );
    const horizon = Math.max(...plans.flatMap((p) => p.map((a) => a.at)));
    for (let at = MINUTE_MS; at <= horizon; at += MINUTE_MS)
      if (r.chance(0.6))
        push({ type: "grant", at, rejects: ids.flatMap((_, e) => (r.chance(0.3) ? [e] : [])) });
    for (let w = r.int(3); w > 0; w--) {
      const at = r.int(horizon);
      push({ type: "offline", at, on: true });
      push({ type: "offline", at: at + 1 + r.int(90_000), on: false });
    }

    let offline = false;
    const rejectedAt = new Map<number, number>();
    const finished = new Set<number>();
    const lastAppend = plans.map((p) => p.at(-1)?.at ?? 0);
    const sent: { execution: number; at: number; request: WritebackRequest }[] = [];
    const acks = new Map<string, string[]>();
    const violations: SimViolation[] = [];
    const outcome = {
      heldAfterRejection: false,
      inFlightAtGrant: false,
      redelivered: false,
      heldOffline: false,
    };
    const v = (message: string) => violations.push({ id: "FD-LOCAL-071", message });

    const queue = () => events.sort((a, b) => a.ev.at - b.ev.at || a.order - b.order);
    queue();
    while (events.length > 0) {
      const { ev } = events.shift()!;
      if (ev.type === "offline") offline = ev.on;
      else if (ev.type === "grant") {
        // The newest grant rejects a seeded subset of the registered executions still in flight.
        for (const e of ev.rejects)
          if (!finished.has(e) && !rejectedAt.has(e)) rejectedAt.set(e, ev.at);
      } else if (ev.type === "arrive") {
        const key = JSON.stringify(ev.request);
        const fromEffect = plane.effects.length;
        const fromCall = plane.repo.calls.length;
        const ack = await plane.receive(ev.request);
        const statuses = acks.get(key) ?? [];
        // The gate port absorbs a redelivered accepted request: no GitHub call, D1 write or intent.
        if (statuses[0] === "accepted") {
          const wrote = [...plane.effects.slice(fromEffect), ...plane.githubFrom(fromCall)];
          if (wrote.length > 0) v(`a redelivered request wrote ${JSON.stringify(wrote)}: ${key}`);
        }
        acks.set(key, [...statuses, ack.status]);
        const e = ids.indexOf(ev.request.execution_id);
        const rejected = rejectedAt.get(e);
        if (rejected !== undefined && ev.sentAt < rejected && ev.at >= rejected)
          outcome.inFlightAtGrant = true;
      } else {
        const e = ev.execution;
        const a = ev.append;
        const outbox: WritebackRequest[] = [];
        const ctx: LocalRunContext = {
          executionId: ids[e]!,
          registered: true,
          journal: () => {},
          send: (request) => Effect.sync(() => void outbox.push(request)),
          scheduler: {
            offline: () => offline,
            grantRejected: (id) => rejectedAt.has(ids.indexOf(id)),
          },
        };
        const failed = await append(ctx, a);
        const rejected = rejectedAt.get(e);
        for (const request of outbox) {
          sent.push({ execution: e, at: ev.at, request });
          const delay = r.int(90_000);
          push({ type: "arrive", at: ev.at + delay, request, sentAt: ev.at });
          if (r.chance(0.2))
            push({ type: "arrive", at: ev.at + delay + r.int(60_000), request, sentAt: ev.at });
          queue();
        }
        if (isWriteback(a.kind)) {
          if (rejected !== undefined) {
            outcome.heldAfterRejection = true;
            if (outbox.length > 0)
              v(
                `execution ${e} sent ${a.step}:${a.index} at ${ev.at} after a grant rejected it at ${rejected}`,
              );
            if (failed !== "WritebackHeld:grant-rejected" && failed !== "WritebackHeld:offline")
              v(
                `execution ${e}'s ${a.step}:${a.index} after rejection answered ${failed ?? "sent"}`,
              );
          } else if (offline) {
            outcome.heldOffline = true;
            if (outbox.length > 0) v(`execution ${e} sent ${a.step}:${a.index} while offline`);
          } else if (outbox.length !== 1 || failed !== null)
            v(`execution ${e}'s online ${a.step}:${a.index} was not sent (${failed})`);
        } else if (outbox.length > 0) v(`execution ${e} sent the decoration ${a.kind}`);
        if (ev.at >= lastAppend[e]!) finished.add(e);
      }
    }

    for (const [key, statuses] of acks)
      if (statuses.length > 1) {
        outcome.redelivered = true;
        if (statuses.some((s) => s !== statuses[0]))
          v(`a redelivered request answered ${statuses.join(", ")}: ${key}`);
      }
    // The outbox holds exactly the intents the device sent, none appended after a rejecting grant.
    const expected = sent
      .flatMap((s) => s.request.intents.map((i) => `${s.request.execution_id}/${i.intent_key}`))
      .sort();
    const held = plane.outbox().map((o) => `${o.executionId}/${o.intentKey}`);
    if (JSON.stringify(held) !== JSON.stringify([...new Set(expected)].sort()))
      v(`the outbox holds ${JSON.stringify(held)}, the device sent ${JSON.stringify(expected)}`);
    for (const s of sent) {
      const rejected = rejectedAt.get(s.execution);
      if (rejected !== undefined && s.at >= rejected)
        v(
          `execution ${s.execution} has a request sent at ${s.at}, after its rejection at ${rejected}`,
        );
    }
    throwOnViolations(violations.map((x) => ({ ...x, message: `seed ${seed}: ${x.message}` })));
    return outcome;
  } finally {
    plane.close();
  }
};

// ---------------------------------------------------------------------------------------------------------------------
// local-registration (FD-LOCAL-075)

/** What one seed reached, for a run over many seeds to show every path was exercised. */
export interface RegistrationOutcome {
  readonly wants: ReadonlySet<string>;
  readonly staleLease: boolean;
  readonly d1Failure: boolean;
  /** A device sent `local.register` for an execution that wants neither reuse nor writeback. */
  readonly unwantedRegister: boolean;
}

const wantsKey = (w: RegistrationWants) =>
  `${w.reuse ? "reuse" : "-"}/${w.writeback ? "writeback" : "-"}`;

/**
 * Runs one seed of `local-registration` and asserts FD-LOCAL-075 on it: the local scheduler sends `local.register` for
 * exactly the executions that request reuse or writeback, and the control plane holds a registration for exactly the
 * ones of those it answered, with the wants they sent, never for one that wants neither, even when a device sends it.
 * An execution left unregistered sends no writeback request: each writeback append fails with `RegistrationRequired`,
 * while a registered one's writeback appends each become one request.
 */
export const checkRegistration = async (seed: number): Promise<RegistrationOutcome> => {
  const r = rng(seed);
  const plane: LocalPlane = await localPlane();
  try {
    const fleet = 3 + r.int(6);
    const executions = Array.from({ length: fleet }, (_, e) => ({
      e,
      reuseKey: `rk-${e}`,
      wants: { reuse: r.chance(0.5), writeback: r.chance(0.5) },
      staleLease: r.chance(0.15),
      d1Failure: r.chance(0.15),
      unwanted: r.chance(0.3),
      appends: appendsOf(r, 0),
    }));
    // The seeded order in which executions reach `registering`.
    for (let i = executions.length - 1; i > 0; i--) {
      const j = r.int(i + 1);
      [executions[i], executions[j]] = [executions[j]!, executions[i]!];
    }

    const violations: SimViolation[] = [];
    const v = (message: string) => violations.push({ id: "FD-LOCAL-075", message });
    const outcome = {
      wants: new Set<string>(),
      staleLease: false,
      d1Failure: false,
      unwantedRegister: false,
    };
    const answered = new Map<string, RegistrationWants>();
    const runs: { x: (typeof executions)[number]; executionId: string | null }[] = [];

    for (const x of executions) {
      outcome.wants.add(wantsKey(x.wants));
      // A conforming device applies the predicate; the seeded device sends `local.register` regardless.
      const sends = needsRegistration(x.wants) || x.unwanted;
      let executionId: string | null = null;
      if (sends) {
        if (!needsRegistration(x.wants)) outcome.unwantedRegister = true;
        if (x.staleLease) outcome.staleLease = true;
        if (x.d1Failure && !x.staleLease) outcome.d1Failure = true;
        plane.fail.on = x.d1Failure;
        const answer = await plane.register(
          !x.staleLease,
          registrationPayload(x.reuseKey, x.wants),
        );
        plane.fail.on = false;
        if ("execution_id" in answer) {
          executionId = answer.execution_id;
          answered.set(x.reuseKey, x.wants);
        }
      }
      runs.push({ x, executionId });
    }

    // The control plane holds a registration for exactly the executions it answered, each wanting reuse or writeback.
    const stored = [...plane.registrations().values()];
    const storedKeys = stored.map((s) => s.reuseKey).sort();
    const expectedKeys = executions
      .filter((x) => needsRegistration(x.wants) && !x.staleLease && !x.d1Failure)
      .map((x) => x.reuseKey)
      .sort();
    if (JSON.stringify(storedKeys) !== JSON.stringify(expectedKeys))
      v(`the store holds ${storedKeys.join(",")}, expected ${expectedKeys.join(",")}`);
    if (JSON.stringify([...answered.keys()].sort()) !== JSON.stringify(expectedKeys))
      v(
        `the control plane answered ${[...answered.keys()].join(",")}, expected ${expectedKeys.join(",")}`,
      );
    for (const s of stored) {
      if (!s.reuse && !s.writeback)
        v(`${s.reuseKey} registered wanting neither reuse nor writeback`);
      const w = answered.get(s.reuseKey);
      if (w === undefined || w.reuse !== s.reuse || w.writeback !== s.writeback)
        v(
          `${s.reuseKey} stored wants ${wantsKey(s)}, sent ${w === undefined ? "none" : wantsKey(w)}`,
        );
    }

    // Each execution then runs; only a registered one sends writeback requests.
    for (const { x, executionId } of runs) {
      const requests: WritebackRequest[] = [];
      const ctx: LocalRunContext = {
        executionId: executionId ?? `unregistered-${x.e}`,
        registered: executionId !== null,
        journal: () => {},
        send: (request) => Effect.sync(() => void requests.push(request)),
        scheduler: { offline: () => false, grantRejected: () => false },
      };
      for (const a of x.appends) {
        const before = requests.length;
        const failed = await append(ctx, a);
        const writes = isWriteback(a.kind);
        if (executionId === null && writes && failed !== "RegistrationRequired")
          v(`unregistered ${x.reuseKey}'s ${a.kind} answered ${failed ?? "sent"}`);
        if (executionId !== null && writes && (failed !== null || requests.length !== before + 1))
          v(`registered ${x.reuseKey}'s ${a.kind} was not sent (${failed})`);
        if (!writes && (failed !== null || requests.length !== before))
          v(`${x.reuseKey}'s decoration ${a.kind} answered ${failed ?? "sent"}`);
      }
      for (const request of requests) await plane.receive(request);
    }
    throwOnViolations(violations.map((x) => ({ ...x, message: `seed ${seed}: ${x.message}` })));
    return outcome;
  } finally {
    plane.close();
  }
};

export const scenarios: readonly SimScenario[] = [
  {
    name: GRANT_SCENARIO,
    ids: ["FD-LOCAL-071"],
    run: async (seed) => {
      await checkGrantRejection(seed);
    },
  },
  {
    name: REGISTRATION_SCENARIO,
    ids: ["FD-LOCAL-075"],
    run: async (seed) => {
      await checkRegistration(seed);
    },
  },
];
