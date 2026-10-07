import type { CheckCommandStorage } from "./check-command";

/** Storage transactions own reservation and comparison; isolate-local maps do not. */
export const checkCommandStorage = (storage: DurableObjectStorage): CheckCommandStorage => ({
  load: (key) => storage.get(key),
  reserve: (key, value) =>
    storage.transaction(async (tx) => {
      if ((await tx.get(key)) !== undefined) return false;
      await tx.put(key, value);
      return true;
    }),
  save: (key, value, expected) =>
    storage.transaction(async (tx) => {
      if (JSON.stringify(await tx.get(key)) !== JSON.stringify(expected)) return false;
      await tx.put(key, value);
      return true;
    }),
});
