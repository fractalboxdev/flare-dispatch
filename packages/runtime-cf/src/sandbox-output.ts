/** Secret values leave the process only after exact-substring removal. */
export const redact = (text: string, values?: readonly string[]): string => {
  let out = text;
  for (const value of values ?? []) {
    if (value.length > 0) out = out.split(value).join("***");
  }
  return out;
};

/** Long-check chunks remove longer overlapping values before shorter values. */
export const redactLongestFirst = (text: string, values?: readonly string[]): string =>
  redact(
    text,
    [...(values ?? [])].sort((a, b) => b.length - a.length),
  );
