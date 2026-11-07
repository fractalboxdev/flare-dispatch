// A compiled oracle over a pipe: the `oracle` executable `lake build oracle` produces reads one JSON input per line on
// stdin and writes one JSON output per line on stdout, in order.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface PipeOracle<I, O> {
  readonly ask: (input: I) => Promise<O>;
  readonly close: () => void;
}

export const pipeOracle = <I, O>(
  command: string,
  args: readonly string[] = [],
): PipeOracle<I, O> => {
  const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "inherit"] });
  const waiting: { readonly answer: (line: string) => void; readonly fail: (e: Error) => void }[] =
    [];
  let ended: Error | null = null;
  // An oracle that exits or cannot start fails every question still waiting, so a run never hangs on it.
  const end = (e: Error) => {
    ended ??= e;
    for (const w of waiting.splice(0)) w.fail(ended);
  };
  child.on("error", end);
  child.on("exit", (code, signal) =>
    end(new Error(`oracle ${command} exited (${signal ?? `code ${String(code)}`})`)),
  );
  createInterface({ input: child.stdout }).on("line", (line) => waiting.shift()?.answer(line));
  return {
    ask: (input) =>
      new Promise((resolve, reject) => {
        if (ended !== null) return reject(ended);
        waiting.push({
          fail: reject,
          answer: (line) => {
            try {
              resolve(JSON.parse(line) as O);
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)));
            }
          },
        });
        child.stdin.write(`${JSON.stringify(input)}\n`);
      }),
    close: () => {
      child.removeAllListeners("exit");
      child.stdin.end();
    },
  };
};
