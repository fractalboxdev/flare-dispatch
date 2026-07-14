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

/** A git-ref dropdown option — `value` is the full ref, `label` the display. */
export interface RefOption {
  readonly value: string;
  readonly label: string;
}

/** A commit dropdown option. */
export interface CommitOption {
  readonly sha: string;
  readonly label: string;
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
  /** Repository options (`owner/name`) — first is the one refs/commits describe. */
  readonly repos: readonly string[];
  /** Ref options for the active repo. */
  readonly refs: readonly RefOption[];
  /** Recent commit options for the active repo + ref (may be empty). */
  readonly commits: readonly CommitOption[];
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
  .who p { margin: 0; }
  .who h3 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .07em;
    color: #7c8598; margin: .8rem 0 .35rem; }
  ul.groups { list-style: none; margin: 0; padding: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  ul.groups li { color: #a9b2c2; padding: .2rem 0; border-top: 1px solid #1b2030; }
  ul.groups li:first-child { border-top: 0; }
  ul.groups li.empty { color: #8a93a5; font-style: italic; }
  .notice { margin: 0 0 1.5rem; padding: .7rem .9rem; border-radius: 8px;
    background: #0f2417; border: 1px solid #1f5133; color: #b7f0cf; font-size: 14px; }
  label { display: block; margin: 0 0 .9rem; }
  label span { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #9aa3b2; margin-bottom: .3rem; }
  input, select {
    width: 100%; padding: .5rem .6rem; font: inherit; color: #e7e9ee;
    background: #0b0e14; border: 1px solid #232838; border-radius: 6px;
    appearance: none; -webkit-appearance: none;
  }
  select {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%239aa3b2' d='M1 1l5 5 5-5'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right .7rem center; padding-right: 2rem; cursor: pointer;
  }
  input:focus, select:focus { outline: none; border-color: #3b5bdb; }
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
  // A list, one group per row — an operator copies a row verbatim into the
  // `githubTeams` policy, so the value must be readable on its own line rather
  // than run together with the others.
  const groupList =
    data.groups.length > 0
      ? data.groups.map((g) => `<li>${esc(g)}</li>`).join("")
      : `<li class="empty">(none)</li>`;

  const notice =
    data.notice !== undefined && data.notice !== null && data.notice.length > 0
      ? `<p class="notice">${esc(data.notice)}</p>`
      : "";

  const option = (value: string, label: string): string =>
    `<option value="${esc(value)}">${esc(label)}</option>`;

  const repoSelect = `<select name="repo">${data.repos
    .map((r) => option(r, r))
    .join("")}</select>`;
  const refSelect = `<select name="ref">${data.refs
    .map((r) => option(r.value, r.label))
    .join("")}</select>`;
  // The Commit dropdown always offers "latest on the selected ref" (resolved
  // server-side at POST), plus specific recent commits when available.
  const shaSelect = `<select name="sha">${[
    option("", "Latest commit on the selected ref"),
    ...data.commits.map((c) => option(c.sha, c.label)),
  ].join("")}</select>`;

  const body =
    data.envs.length === 0
      ? `<p class="none">Your identity isn't authorized to deploy any environment. Ask an operator to add your GitHub team (or email) to the <code>deploy.env-authz</code> policy.</p>`
      : `<form method="POST" action="/deploy">
      <label><span>Repository</span>${repoSelect}</label>
      <label><span>Ref</span>${refSelect}</label>
      <label><span>Commit</span>${shaSelect}</label>
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
<div class="who">
<p>Signed in as <b>${esc(data.email)}</b> via <b>${esc(data.idp)}</b>.</p>
<h3>Groups</h3>
<ul class="groups">${groupList}</ul>
</div>
${body}
</body>
</html>`;
};
