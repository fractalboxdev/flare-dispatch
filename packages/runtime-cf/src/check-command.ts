import { Schema } from "effect";
import {
  CheckCommandHandle,
  CheckCommandObservation,
  CheckCommandChunk,
  CheckCommandLogState,
  ExecResultSchema,
  type CheckCommandOwner,
  type ExecResult,
} from "@fractalboxdev/flare-dispatch-core";

export interface CheckCommandStorage {
  load(key: string): Promise<unknown>;
  reserve(key: string, value: unknown): Promise<boolean>;
  save(key: string, value: unknown, expected: unknown): Promise<boolean>;
}
/** Only the pinned SDK's public methods reach the container. */
export interface CheckCommandBox {
  writeFile(path: string, content: string): Promise<{ success: boolean }>;
  startProcess(
    command: string,
    options: {
      processId: string;
      autoCleanup: boolean;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): Promise<unknown>;
  getProcess(id: string): Promise<{ status: string; exitCode?: number } | null>;
  exec(
    command: string,
    options: { timeout: number },
  ): Promise<{ exitCode: number; stdout: string }>;
}
const Terminal = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Number),
  timedOut: Schema.Boolean,
  logExceeded: Schema.optional(Schema.Boolean),
  endedAt: Schema.Number,
});
const Intent = Schema.Struct({
  handle: CheckCommandHandle,
  receipt: Schema.optional(ExecResultSchema),
  logs: CheckCommandLogState,
});
const emptyLogs: typeof CheckCommandLogState.Type = {
  stdoutOffset: 0,
  stderrOffset: 0,
  stdoutTail: "",
  stderrTail: "",
  chunks: [],
};
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const path = (h: CheckCommandHandle) => `/tmp/flare-check-${h.id}`;
export const commandSpool = path;
export async function commandFingerprint(
  command: string,
  cwd?: string,
  env: Record<string, string> = {},
  timeoutSec = 600,
  containerId = "",
): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        command,
        cwd ?? "",
        Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        timeoutSec,
        containerId,
      ]),
    ),
  );
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Node is present in the pinned SDK Dockerfile and the checked-in sandbox image. */
export function commandSupervisor(handle: CheckCommandHandle, command: string): string {
  return `const fs=require('node:fs'),{spawn}=require('node:child_process');
const dir=${JSON.stringify(path(handle))};fs.mkdirSync(dir,{recursive:true});
const out=fs.openSync(dir+'/stdout','a'),err=fs.openSync(dir+'/stderr','a');
const child=spawn('/bin/sh',['-lc',${JSON.stringify(command)}],{detached: true,stdio:['ignore','pipe','pipe'],env:process.env});
let timedOut=false,logExceeded=false,killTimer,bytes=0,cleanupComplete=false,closed=false,closeCode=null,endedAt;
const publish=()=>{if(!closed||(killTimer&&!cleanupComplete))return;const value={exitCode:closeCode,timedOut,logExceeded,endedAt:endedAt??Date.now()};fs.writeFileSync(dir+'/terminal.tmp',JSON.stringify(value));fs.renameSync(dir+'/terminal.tmp',dir+'/terminal.json');process.exitCode=closeCode===null?1:closeCode;};
const stop=()=>{if(killTimer)return;try{process.kill(-child.pid,0)}catch{return};try{process.kill(-child.pid,'SIGTERM')}catch{};killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{};cleanupComplete=true;publish()},1000)};
const capture=(fd,data)=>{const count=Math.min(data.length,Math.max(0,64*1024*1024-bytes));if(count)fs.writeSync(fd,data,0,count);bytes+=count;if(count<data.length){logExceeded=true;stop()}};
child.stdout.on('data',data=>capture(out,data));child.stderr.on('data',data=>capture(err,data));
const timer=setTimeout(()=>{timedOut=true;stop()},Math.max(0,${handle.deadline}-Date.now()));
child.on('exit',()=>{endedAt=Date.now();clearTimeout(timer);stop()});
child.on('close',(code)=>{closed=true;closeCode=code;clearTimeout(timer);stop();publish()});`;
}

export function makeCheckCommandOwner(
  storage: CheckCommandStorage,
  box: CheckCommandBox,
  now = Date.now,
): CheckCommandOwner {
  const key = (h: CheckCommandHandle) => `check-command:${h.id}`;
  const load = async (raw: CheckCommandHandle) => {
    const h = Schema.decodeUnknownSync(CheckCommandHandle)(raw);
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(h.id) ||
      !Number.isSafeInteger(h.startedAt) ||
      !Number.isSafeInteger(h.deadline) ||
      h.deadline <= h.startedAt
    )
      throw new Error("invalid check command identity");
    const value = await storage.load(key(h));
    if (value === undefined) throw new Error("uncertain check command: no durable launch intent");
    const entry = Schema.decodeUnknownSync(Intent)(value);
    if (JSON.stringify(entry.handle) !== JSON.stringify(h))
      throw new Error("check command identity changed");
    return entry;
  };
  const execJson = async (script: string): Promise<unknown> => {
    const result = await box.exec(`node -e ${quote(script)}`, { timeout: 10000 });
    if (result.exitCode !== 0) throw new Error("check command spool unavailable");
    return JSON.parse(result.stdout);
  };
  return {
    async start(opts) {
      const h = Schema.decodeUnknownSync(CheckCommandHandle)(opts.handle);
      if (
        !/^[a-zA-Z0-9_-]{1,100}$/.test(h.id) ||
        !Number.isSafeInteger(h.startedAt) ||
        !Number.isSafeInteger(h.deadline) ||
        h.deadline <= h.startedAt
      )
        throw new Error("invalid check command identity");
      Schema.decodeUnknownSync(Schema.String)(opts.command);
      const env = Schema.decodeUnknownSync(
        Schema.Record({ key: Schema.String, value: Schema.String }),
      )(opts.env ?? {});
      if (
        h.fingerprint !==
        (await commandFingerprint(
          opts.command,
          opts.cwd,
          env,
          (h.deadline - h.startedAt) / 1000,
          h.container.id,
        ))
      )
        throw new Error("check command identity changed");
      const claimed = await storage.reserve(key(h), { handle: h, logs: emptyLogs });
      if (!claimed) {
        const entry = await load(h);
        if (entry.receipt !== undefined) return;
        if ((await box.getProcess(h.id)) === null)
          throw new Error(
            "uncertain check command: launch response or process was lost; no relaunch",
          );
        return;
      }
      if (now() >= h.deadline) throw new Error("check command deadline expired before launch");
      const file = `${path(h)}.cjs`;
      const written = await box.writeFile(file, commandSupervisor(h, opts.command));
      if (!written.success) throw new Error("check command supervisor could not be written");
      await box.startProcess(`node ${quote(file)}`, {
        processId: h.id,
        autoCleanup: false,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
      });
    },
    async observe(h) {
      const entry = await load(h);
      if (entry.receipt !== undefined)
        return {
          state: "exited",
          exitCode: entry.receipt.exitCode,
          durationMs: entry.receipt.durationMs,
        };
      const proc = await box.getProcess(h.id);
      if (proc === null) return { state: "missing" };
      if (proc.status === "running" || proc.status === "starting")
        return { state: now() >= h.deadline + 1500 ? "timeout" : "running" };
      const terminal = Schema.decodeUnknownSync(Terminal)(
        await execJson(
          `const fs=require('node:fs');process.stdout.write(fs.readFileSync(${JSON.stringify(path(h) + "/terminal.json")},'utf8'))`,
        ),
      );
      if (terminal.logExceeded)
        throw new Error("check command output exceeds bounded spool; no verdict published");
      if (terminal.timedOut || terminal.endedAt > h.deadline) return { state: "timeout" };
      if (
        terminal.exitCode === null ||
        !Number.isInteger(terminal.exitCode) ||
        terminal.exitCode !== proc.exitCode
      )
        return { state: "missing" };
      return Schema.decodeUnknownSync(CheckCommandObservation)({
        state: "exited",
        exitCode: terminal.exitCode,
        durationMs: terminal.endedAt - h.startedAt,
      });
    },
    async read(h, stream, offset, length) {
      await load(h);
      Schema.decodeUnknownSync(Schema.Literal("stdout", "stderr"))(stream);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 1 ||
        length > 65536
      )
        throw new Error("invalid bounded check log read");
      return Schema.decodeUnknownSync(CheckCommandChunk)(
        await execJson(
          `const fs=require('node:fs'),p=${JSON.stringify(path(h) + "/" + stream)};if(!fs.existsSync(p)){process.stdout.write(JSON.stringify({text:'',bytes:0}))}else{const f=fs.openSync(p,'r'),b=Buffer.alloc(${length}+4),n=fs.readSync(f,b,0,b.length,${offset});fs.closeSync(f);let end=Math.min(n,${length});if(end<n){while(end>0&&(b[end]&192)===128)end--;}process.stdout.write(JSON.stringify({text:b.subarray(0,end).toString('utf8'),bytes:end}))}`,
        ),
      );
    },
    async logs(h) {
      return (await load(h)).logs;
    },
    async advanceLogs(h, expected, next) {
      const entry = await load(h);
      if (JSON.stringify(entry.logs) !== JSON.stringify(expected))
        throw new Error("check log progress changed concurrently");
      if (
        !(await storage.save(
          key(h),
          { ...entry, logs: Schema.decodeUnknownSync(CheckCommandLogState)(next) },
          entry,
        ))
      )
        throw new Error("check log progress changed concurrently");
    },
    async receipt(h) {
      return (await load(h)).receipt;
    },
    async finish(h, result) {
      const entry = await load(h);
      if (entry.receipt !== undefined) return entry.receipt;
      const status = await this.observe(h);
      if (
        status.state !== "exited" ||
        status.exitCode !== result.exitCode ||
        status.durationMs !== result.durationMs
      )
        throw new Error("check command has no matching actual exit receipt");
      const receipt: ExecResult = Schema.decodeUnknownSync(ExecResultSchema)(result);
      if (!(await storage.save(key(h), { ...entry, receipt }, entry))) {
        const current = await load(h);
        if (current.receipt !== undefined) return current.receipt;
        throw new Error("check command receipt changed concurrently");
      }
      return receipt;
    },
  };
}
