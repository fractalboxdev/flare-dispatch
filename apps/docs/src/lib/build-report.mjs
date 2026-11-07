// @ts-check
// Problems the Markdown plugin records while pages render. The content layer logs a render error
// instead of failing, so the plugin records here and the site check fails the build at
// `astro:build:done`. The report lives on `globalThis` because the config and the content layer
// can load this module through different module graphs in one process.

/** @typedef {{ problems: string[] }} BuildReport */

const KEY = Symbol.for("flare-dispatch-docs.build-report");

/** @returns {BuildReport} */
export const buildReport = () => {
  const holder = /** @type {Record<symbol, BuildReport | undefined>} */ (/** @type {unknown} */ (globalThis));
  holder[KEY] ??= { problems: [] };
  return holder[KEY];
};
