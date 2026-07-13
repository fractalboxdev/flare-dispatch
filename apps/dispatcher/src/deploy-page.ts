// FlareDispatch Dispatcher — the `/deploy` console page (SSR, zero-JS).
//
// A self-contained HTML form served behind the deploy Access app: it shows who
// the operator is signed in as (email + login method + resolved groups, so the
// per-env policy is debuggable), and renders ONE deploy button per environment
// the caller is authorized for (deploy-authz.ts `allowedEnvs`). Submitting POSTs
// back to `/deploy` with the chosen `env` (multiple submit buttons, one form —
// no JavaScript). Environments requiring approval (production) are labelled.
//
// PURE: `renderDeployPage` is data → HTML string with no I/O, so it stays
// trivially testable (deploy-page.test.ts). routes/deploy.ts feeds it.

/** One deployable environment row on the page. */
export interface DeployEnvOption {
  readonly name: string;
  /** Production-class env — gated by the approval + cooldown path. */
  readonly requiresApproval: boolean;
}

export interface DeployPageData {
  /** The signed-in identity's email (from get-identity). */
  readonly email: string;
  /** The login method — "github" | "onetimepin" | … (shown for transparency). */
  readonly idp: string;
  /** The identity's resolved groups — rendered so policy setup is debuggable. */
  readonly groups: readonly string[];
  /** The environments the caller may deploy to (already authorization-filtered). */
  readonly envs: readonly DeployEnvOption[];
  /** Default repository slug prefilled in the form (`owner/name`). */
  readonly repoDefault: string;
  /** Default git ref prefilled in the form (e.g. `refs/heads/main`). */
  readonly refDefault: string;
  /** A one-shot notice to surface (e.g. after a queued deploy), or null. */
  readonly notice?: string | null;
}

/** HTML-escape a value for safe interpolation into element text / attributes. */
const esc = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
    color: #e7e9ee; background: #0d1017; max-width: 48rem; margin-inline: auto;
  }
  a { color: #6ea8fe; text-decoration: none; }
  a:hover { text-decoration: underline; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; letter-spacing: -0.01em; }
  .tagline { color: #9aa3b2; margin: 0 0 1.75rem; }
  .who { font-size: 13.5px; color: #9aa3b2; margin: 0 0 1.5rem; padding: .75rem .9rem;
    background: #11151f; border: 1px solid #232838; border-radius: 8px; }
  .who b { color: #c4cad6; font-weight: 600; }
  .who .groups { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: #8a93a5; }
  .notice { margin: 0 0 1.5rem; padding: .7rem .9rem; border-radius: 8px;
    background: #0f2417; border: 1px solid #1f5133; color: #b7f0cf; font-size: 14px; }
  label { display: block; margin: 0 0 .9rem; }
  label span { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #9aa3b2; margin-bottom: .3rem; }
  input {
    width: 100%; padding: .5rem .6rem; font: inherit; color: #e7e9ee;
    background: #0b0e14; border: 1px solid #232838; border-radius: 6px;
  }
  input:focus { outline: none; border-color: #3b5bdb; }
  h2 { font-size: .82rem; text-transform: uppercase; letter-spacing: .08em; color: #9aa3b2; margin: 1.75rem 0 .6rem; }
  .envs { display: flex; flex-wrap: wrap; gap: .6rem; }
  button {
    font: inherit; font-weight: 600; cursor: pointer; padding: .55rem .95rem;
    color: #e7e9ee; background: #1c2333; border: 1px solid #2c3550; border-radius: 7px;
  }
  button:hover { background: #232c42; border-color: #3b5bdb; }
  button.prod { background: #2a1c12; border-color: #5a3a1c; }
  button.prod:hover { background: #362415; border-color: #a5641c; }
  button .req { font-weight: 400; color: #b58a5a; margin-left: .4rem; font-size: 12.5px; }
  .none { color: #c98a8a; padding: .75rem .9rem; background: #1c1114; border: 1px solid #4a1f26; border-radius: 8px; }
`;

/**
 * Render the deploy console. When `envs` is empty the caller is authenticated
 * but authorized for nothing — a legible message, not an empty form.
 */
export const renderDeployPage = (data: DeployPageData): string => {
  const groupsText = data.groups.length > 0 ? data.groups.join(", ") : "(none)";

  const notice =
    data.notice !== undefined && data.notice !== null && data.notice.length > 0
      ? `<p class="notice">${esc(data.notice)}</p>`
      : "";

  const body =
    data.envs.length === 0
      ? `<p class="none">Your identity isn't authorized to deploy any environment. Ask an operator to add your GitHub team (or email) to the <code>deploy.env-authz</code> policy.</p>`
      : `<form method="POST" action="/deploy">
      <label><span>Repository</span><input name="repo" value="${esc(data.repoDefault)}" autocomplete="off" spellcheck="false"></label>
      <label><span>Ref</span><input name="ref" value="${esc(data.refDefault)}" autocomplete="off" spellcheck="false"></label>
      <label><span>Commit SHA</span><input name="sha" placeholder="the commit to deploy" autocomplete="off" spellcheck="false"></label>
      <h2>Deploy to</h2>
      <div class="envs">
        ${data.envs
          .map(
            (e) =>
              `<button type="submit" name="env" value="${esc(e.name)}"${
                e.requiresApproval ? ' class="prod"' : ""
              }>${esc(e.name)}${
                e.requiresApproval ? '<span class="req">approval + cooldown</span>' : ""
              }</button>`,
          )
          .join("\n        ")}
      </div>
    </form>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Deploy · FlareDispatch</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Deploy console</h1>
<p class="tagline">Trigger a deploy to an environment you're authorized for.</p>
${notice}
<p class="who">Signed in as <b>${esc(data.email)}</b> via <b>${esc(data.idp)}</b>.<br>
<span class="groups">groups: ${esc(groupsText)}</span></p>
${body}
</body>
</html>`;
};
