// The spend view `GET /v1/spend` answers (FD-SPD-057): mameko's view of MAMEKO-SPD-060 over the D1 read model, the
// profile and the spend configuration the operator overlay delivers (specs/profile.md § Spend configuration,
// FD-PROF-054), in the shape of the operability route's body. A store read that fails is `spend_unreadable` (FD-SPD-058).
import { SpendUnreadable, SpendView, type SpendViewBody } from "@fractalboxdev/flare-dispatch-ops";
import {
  reservesOf,
  spendSettings,
  type Profile,
  type SpendConfig,
} from "@fractalboxdev/flare-dispatch-profile";
import {
  OperatorViewSource,
  spendView,
  type SpendSettings,
  type SpendView as CoordinatorSpendView,
} from "@fractalboxdev/mameko-coordinator";
import { d1OperatorReadModel, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Layer } from "effect";
import { profileOf, spendConfigOf, type ControlPlaneEnv } from "./config.ts";

/**
 * The spend settings the view reads. Every executor this deploy leases is a device, which the burn lanes count at 0
 * (MAMEKO-SPD-050), so the rate card holds no hourly list rate; nothing measures `M` and `r`, so the measured reserve's
 * runway is unknown.
 */
export const spendSettingsOf = (profile: Profile, spend: SpendConfig): SpendSettings => ({
  budgetMicroUsd: spend.budget,
  fixedMicroUsd: spend.fixed,
  reservesMicroUsd: reservesOf(profile, spend),
  lanesMicroUsdPerHour: spendSettings.burn_lanes_per_hour,
  listRateMicroUsdPerHour: {},
  measured: null,
});

/**
 * mameko's view as the route's body. The coordinator reads no control state, and this deploy supplies no operator
 * transaction that could set one (`Operations` answers `unavailable`), so the state is `run`.
 */
export const spendBodyOf = (view: CoordinatorSpendView): SpendViewBody => ({
  month: view.month,
  budget: view.budgetMicroUsd,
  settled: view.settledMicroUsd,
  reserved: view.reservedMicroUsd,
  committed: view.committedMicroUsd,
  classes: view.classes.map((c) => ({
    class: c.name,
    line: c.lineMicroUsd,
    lane: c.laneMicroUsdPerHour,
    admitted_list_rate: c.admittedListRateMicroUsdPerHour,
    reserve: c.reserveMicroUsd,
  })),
  floor: view.floorMicroUsd,
  measured_reserve_runway_days: view.measured?.runwayDays ?? null,
  control_state: "run",
  resets_at: view.resetsAt,
});

/** The window the other operator views count final rows in; the spend view reads none. */
const VIEW_WINDOW_MS = 3_600_000;

/** `SpendView` over one D1 database, one profile and the spend configuration the operator overlay delivers. */
export const spendViewLayer = (
  db: D1Like,
  profile: Profile,
  spend: SpendConfig,
): Layer.Layer<SpendView> => {
  const source = Layer.succeed(OperatorViewSource)({
    profile: Effect.succeed(profile),
    spend: Effect.succeed(spendSettingsOf(profile, spend)),
    windowMs: VIEW_WINDOW_MS,
  });
  const services = Layer.merge(source, d1OperatorReadModel(db));
  return Layer.succeed(SpendView)({
    view: (month) =>
      spendView(month).pipe(
        Effect.map(spendBodyOf),
        Effect.catchTag("SpendUnreadable", (e) =>
          Effect.fail(new SpendUnreadable({ reason: e.operation })),
        ),
        Effect.provide(services),
      ),
  });
};

/**
 * The Worker's spend view, over its D1 binding, the deployment's profile and the spend configuration the operator
 * overlay delivers in the `SPEND` var (FD-PROF-054). A `SPEND` var that does not decode answers `spend_unreadable`.
 */
export const spendViewOf = (env: ControlPlaneEnv): Layer.Layer<SpendView> =>
  Layer.succeed(SpendView)({
    view: (month) =>
      Effect.gen(function* () {
        const spend = yield* spendConfigOf(env);
        const views = yield* SpendView.pipe(
          Effect.provide(spendViewLayer(env.DB, profileOf(env), spend)),
        );
        return yield* views.view(month);
      }),
  });
