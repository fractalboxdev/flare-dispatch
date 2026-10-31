// The run catalogue's one runner entry (FD-RUN-063): the device executor starts it as the runner child of each lease,
// so the catalogue and the runner carry one copy of `effect`.
import { runnerMain } from "@fractalboxdev/mameko-runner";
import { deploymentOf } from "./spec.ts";
import { runsFor } from "./runs.ts";

process.exit(await runnerMain({ runs: runsFor(deploymentOf(process.env["FD_DEPLOYMENT"])) }));
