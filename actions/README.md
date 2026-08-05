# FlareDispatch GitHub Actions

Reusable GitHub Actions for consuming [FlareDispatch](../README.md) from your own
repositories. Both are self-contained composite actions — no bundled runtime, no
`npm install`, nothing to keep in sync.

| Action                                                    | What it does                                                                                                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`flare-dispatch-action`](./flare-dispatch-action/)       | **Dispatch a run.** HMAC-signs a dispatch body and POSTs it to your Dispatcher Worker from a CI workflow. The run executes on Cloudflare and reports back via a `flare-dispatch/<run>` check-run. |
| [`deploy-dispatcher-action`](./deploy-dispatcher-action/) | **Ship the Worker.** Deploys the dispatcher into your Cloudflare account via an operator-overlay `wrangler.jsonc` + a pinned upstream SHA.                                                        |

The two are complementary: `deploy-dispatcher-action` stands up the Dispatcher in
your account once; `flare-dispatch-action` runs in each consumer repo's CI to
offload heavy jobs onto it.

```yaml
# consumer repo — offload the test suite onto your Dispatcher
- uses: fractalboxdev/flare-dispatch/actions/flare-dispatch-action@<sha>
  with:
    run: offload-test
    endpoint: ${{ vars.FLAREDISPATCH_ENDPOINT }}
    hmac-secret: ${{ secrets.FLAREDISPATCH_HMAC }}
    inputs: |
      { "repo": "${{ github.repository }}", "sha": "${{ github.sha }}", "command": "pnpm test" }
```

Pin every `uses:` by commit SHA (`@<sha>`), not `@main` — a moving ref is not
reproducible. See each action's README for the full input/output contract.
