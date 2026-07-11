// @fractalbox/flare-dispatch-github-app/testing — test-only exports.
//
// A PKCS#8 RSA key pair for exercising the RS256 JWT signer in *consumer*
// package tests (e.g. `@fractalbox/flare-dispatch-runtime-cf`'s `ChecksGithubLive` suite),
// so they don't have to ship their own fixture. NOT a real GitHub App key —
// never used at runtime.

export { TEST_APP_PRIVATE_KEY } from "./__fixtures__/test-key";
