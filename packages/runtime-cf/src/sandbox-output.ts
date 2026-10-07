/** Secret values leave the process only after exact-substring removal. */
export const redact = (text: string, values?: readonly string[]): string => {
  let out = text;
  for (const value of [...(values ?? [])]
    .filter((v) => v.length > 0)
    .sort((a, b) => b.length - a.length))
    out = out.split(value).join("***");
  return out;
};
