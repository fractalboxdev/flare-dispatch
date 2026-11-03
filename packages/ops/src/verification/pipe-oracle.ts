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
  const waiting: ((line: string) => void)[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => waiting.shift()?.(line));
  return {
    ask: (input) =>
      new Promise((resolve, reject) => {
        waiting.push((line) => {
          try {
            resolve(JSON.parse(line) as O);
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
        child.stdin.write(`${JSON.stringify(input)}\n`);
      }),
    close: () => child.stdin.end(),
  };
};
