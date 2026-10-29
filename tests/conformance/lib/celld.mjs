// Runs a case on celld with `celld dev`, one supervisor process per start.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { FLUSH_MS, startOtlpReceiver } from "./otlp.mjs";

const READY_TIMEOUT_MS = 120_000;
// Variables a case's run never inherits from the shell.
const RUNNER_OWNED = /^(CELLD_OTEL|OTEL_|CELLD_FETCH_PRIVATE_ALLOW$)/;
const EXIT_TIMEOUT_MS = 45_000;

const running = new Set();
// A runner that dies mid-case must not leave nodes behind. SIGKILL reaches
// the node too: `celld dev` sets PR_SET_PDEATHSIG on it.
process.on("exit", () => {
  for (const child of running) child.kill("SIGKILL");
});
// A signal ends the run through process.exit, so the "exit" handlers run:
// the one above, and Miniflare's, which stops workerd.
for (const [signal, number] of [["SIGHUP", 1], ["SIGINT", 2], ["SIGTERM", 15]]) {
  process.once(signal, () => {
    console.error(`\ninterrupted by ${signal}`);
    process.exit(128 + number);
  });
}

/**
 * Starts the case's workers from `dir` (a temp copy of the case) and returns a
 * session for runSteps. `logs()` returns the supervisor's stderr so far. With
 * `observability`, celld exports telemetry to a receiver the session owns.
 * The public listener takes `publicPort`, or a free port when it is 0, and
 * the operator listener `internalPort`, or a free port at each start.
 */
export async function startCelld({ binary, esbuild, dir, workers, env, publicPort = 0, internalPort, observability, watchPorts = [] }) {
  const configs = [
    ...workers.flatMap((name) => ["-c", `workers/${name}/wrangler.jsonc`]),
    ...(internalPort === undefined ? [] : ["--internal-port", String(internalPort)]),
  ];
  const stderr = [];
  // Telemetry is off unless the case turns it on, and the egress allowlist
  // is empty unless the case sets one, whatever the shell has.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !RUNNER_OWNED.test(name)));
  const otlp = observability ? await startOtlpReceiver() : undefined;
  const telemetry = otlp ? { CELLD_OTEL: otlp.url, CELLD_OTEL_FLUSH_MS: String(FLUSH_MS) } : {};
  const environment = { ...inherited, ...env, ...telemetry, CELLD_ESBUILD: esbuild };
  // A failed start has no session to read the logs from, so its error
  // carries them.
  const start = (args) =>
    launch({ binary, dir, env: environment, args: ["--port", String(publicPort), ...args], stderr }).catch((error) => {
      throw new Error(`${error.message}\n--- celld dev stderr ---\n${stderr.join("").trim()}`, { cause: error });
    });
  let node;
  try {
    node = await start(["--clean", ...configs]);
  } catch (error) {
    await otlp?.close();
    throw error;
  }
  let baseline;
  let socketBaseline;
  let baselineInodes;
  const watched = new Set(watchPorts);
  const session = {
    origin: node.ready.public,
    // The operator listener, for `internal` steps.
    internal: node.ready.internal,
    otlp,
    // `"baseline"` resets the node's peak resident memory and notes where it
    // stands; a number then checks how far the peak has grown since, in MiB.
    // The transcript keeps the verdict, not the sizes, which vary by run.
    async rss(limit) {
      const pid = nodePid(node.child.pid);
      if (limit === "baseline") {
        writeFileSync(`/proc/${pid}/clear_refs`, "5");
        baseline = memoryKiB(pid, "VmRSS");
        return "baseline";
      }
      const grown = Math.ceil((memoryKiB(pid, "VmHWM") - baseline) / 1024);
      return grown <= limit ? `grew at most ${limit} MiB` : `grew ${grown} MiB, more than ${limit} MiB`;
    },
    // The CPU the node uses in one second while the case leaves it alone,
    // after `wait` ms: a task that spins shows as most of a core. The
    // transcript keeps the verdict, not the time, which varies by run.
    async cpu(limit, wait) {
      const pid = nodePid(node.child.pid);
      await new Promise((resolve) => setTimeout(resolve, wait));
      const before = cpuMs(pid);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const used = cpuMs(pid) - before;
      return used <= limit ? `at most ${limit} ms in 1 s` : `${used} ms in 1 s, past ${limit} ms`;
    },
    // Counts the node's connections to the ports `watch` names: the
    // upstream's, and the client ports of the raw `ws` steps. `"baseline"`
    // notes the count; a number then waits up to `within` ms for the node
    // to hold at most that many more.
    async sockets(limit, within) {
      const pid = nodePid(node.child.pid);
      if (limit === "baseline") {
        socketBaseline = watchedConnections(pid, watched);
        baselineInodes = socketInodes(pid);
        return "baseline";
      }
      const deadline = Date.now() + within;
      const held = () => watchedConnections(pid, watched) - socketBaseline + orphanSockets(pid, baselineInodes);
      let extra;
      while ((extra = held()) > limit && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return extra <= limit ? `at most ${limit} more` : `${extra} more, past ${limit}`;
    },
    watch(port) {
      watched.add(port);
    },
    async restart() {
      await stop(node);
      node = await start(configs);
      session.origin = node.ready.public;
      session.internal = node.ready.internal;
    },
    async stop() {
      try {
        await stop(node);
      } finally {
        await otlp?.close();
      }
    },
    kill() {
      node.child.kill("SIGKILL");
      return otlp?.close();
    },
    logs: () => stderr.join(""),
  };
  return session;
}

// The node process that `celld dev` supervises, its only child.
function nodePid(supervisor) {
  const children = readFileSync(`/proc/${supervisor}/task/${supervisor}/children`, "utf8").trim().split(/\s+/);
  if (children.length !== 1 || children[0] === "") throw new Error(`celld dev has ${children.length} child processes, not its node alone`);
  return Number(children[0]);
}

// The inodes of the node's open sockets.
function socketInodes(pid) {
  const inodes = new Set();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
      if (match) inodes.add(match[1]);
    } catch {
      // The fd closed while it was read.
    }
  }
  return inodes;
}

// Where each protocol table of the network namespace keeps a socket's inode.
const INODE_COLUMNS = { tcp: 9, tcp6: 9, udp: 9, udp6: 9, raw: 9, raw6: 9, unix: 6, netlink: 9 };

// The node's sockets opened since the baseline that no protocol table lists:
// a TCP connection that a reset removed from the table while the node kept
// its fd open.
function orphanSockets(pid, baseline) {
  const listed = new Set();
  for (const [table, column] of Object.entries(INODE_COLUMNS)) {
    let text;
    try {
      text = readFileSync(`/proc/${pid}/net/${table}`, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const inode = line.trim().split(/\s+/)[column];
      if (inode !== undefined) listed.add(inode);
    }
  }
  return [...socketInodes(pid)].filter((inode) => !baseline.has(inode) && !listed.has(inode)).length;
}

// The node's TCP connections whose remote port is in `ports`: its sockets'
// inodes, matched in the network namespace's TCP tables. Listeners and
// connections to anything else (the runner's keep-alive HTTP connections
// among them) are not counted.
function watchedConnections(pid, ports) {
  const inodes = socketInodes(pid);
  let count = 0;
  for (const table of ["tcp", "tcp6"]) {
    for (const line of readFileSync(`/proc/${pid}/net/${table}`, "utf8").split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10 || fields[3] === "0A") continue;
      const remotePort = parseInt(fields[2].split(":")[1], 16);
      if (inodes.has(fields[9]) && ports.has(remotePort)) count += 1;
    }
  }
  return count;
}

// The CPU time all the node's threads have used, user and system, in ms
// (`/proc/<pid>/stat` fields 14 and 15, in clock ticks of 10 ms).
function cpuMs(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  // The command name is in parentheses and can hold spaces.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return (Number(fields[11]) + Number(fields[12])) * 10;
}

function memoryKiB(pid, field) {
  const line = readFileSync(`/proc/${pid}/status`, "utf8").split("\n").find((entry) => entry.startsWith(`${field}:`));
  if (line === undefined) throw new Error(`/proc/${pid}/status has no ${field}`);
  return Number(line.split(/\s+/)[1]);
}

async function launch({ binary, dir, env, args, stderr }) {
  const child = spawn(binary, ["dev", "--no-watch", ...args], {
    cwd: dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.add(child);
  child.stderr.setEncoding("utf8").on("data", (chunk) => stderr.push(chunk));
  const exited = new Promise((resolve) => {
    // "close", not "exit": the node shares the supervisor's stderr, so this
    // also waits for the node and keeps the last lines of output.
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ code: null, signal: error.message }));
  });
  exited.then(() => running.delete(child));

  const lines = createInterface({ input: child.stdout });
  // stdout carries only ready records (plan 0.1); a build's output or a log
  // line there breaks every tool that reads it.
  const stray = [];
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`celld dev did not print its ready line within ${READY_TIMEOUT_MS / 1000}s`));
    }, READY_TIMEOUT_MS);
    lines.on("line", (line) => {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        stray.push(line);
        return;
      }
      if (record?.event !== "ready") stray.push(line);
      if (record?.event === "ready") {
        clearTimeout(timer);
        resolve(record);
      }
    });
    exited.then(({ code, signal }) => {
      clearTimeout(timer);
      reject(new Error(`celld dev exited before it was ready (${signal ?? `code ${code}`})`));
    });
  });
  if (typeof ready.public !== "string" || typeof ready.internal !== "string") {
    child.kill("SIGKILL");
    throw new Error(`celld dev printed a malformed ready line: ${JSON.stringify(ready)}`);
  }
  return { child, ready, exited, stray };
}

// The same request `celld dev` sends its own node on a reload: the node
// stops, its state stays, and the supervisor exits once the node has.
async function stop({ child, ready, exited, stray }) {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`celld dev had already exited (${child.signalCode ?? `code ${child.exitCode}`})`);
  }
  const response = await fetch(`${ready.internal}/shutdown?handoff=preserve`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    child.kill("SIGKILL");
    throw new Error(`POST /shutdown answered ${response.status}`);
  }
  let timer;
  const result = await Promise.race([
    exited,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), EXIT_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (result === null) {
    child.kill("SIGKILL");
    throw new Error(`celld dev did not exit within ${EXIT_TIMEOUT_MS / 1000}s of POST /shutdown`);
  }
  if (result.code !== 0) {
    throw new Error(`celld dev exited with ${result.signal ?? `code ${result.code}`} after POST /shutdown`);
  }
  if (stray.length > 0) {
    throw new Error(`celld dev printed lines on stdout that are not ready records: ${JSON.stringify(stray.slice(0, 5))}`);
  }
}

/**
 * A session for a case of "deploy" steps: no node, and each step runs
 * `celld deploy --dry-run --json` on one worker from `dir`.
 *
 * The step's transcript is the exit code, the worker the JSON row names, and
 * stderr's lines, with what changes between builds of celld or runs
 * normalized: the case directory, the celld version, sizes and times.
 */
export function startDeploySession({ binary, esbuild, dir, env }) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !RUNNER_OWNED.test(name)));
  const environment = { ...inherited, ...env, CELLD_ESBUILD: esbuild };
  const log = [];
  return {
    origin: undefined,
    async deploy(step, timeoutMs) {
      const args = ["deploy", "--dry-run", "--json", ...step.args, `workers/${step.worker}/wrangler.jsonc`];
      const { code, stdout, stderr } = await run(binary, args, { cwd: dir, env: environment, timeoutMs });
      log.push(`$ celld ${args.join(" ")}\n${stderr}`);
      let worker = null;
      if (code === 0) {
        try {
          worker = JSON.parse(stdout).worker ?? null;
        } catch {
          throw new Error(`celld deploy printed stdout that is not one JSON row: ${JSON.stringify(stdout)}`);
        }
      }
      const output = stderr
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line !== "")
        .map((line) =>
          line
            .replaceAll(dir, "<case>")
            .replace(/^ celld \S+$/, " celld <version>")
            .replace(/\d+\.\d+ KiB/g, "<size>")
            .replace(/\(\d+\.\d+ sec\)/g, "(<time>)"),
        );
      return { exit: code, worker, output };
    },
    async stop() {},
    kill() {},
    logs: () => log.join("\n"),
  };
}

function run(binary, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    running.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`celld deploy did not finish within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      running.delete(child);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      running.delete(child);
      if (signal) reject(new Error(`celld deploy was killed by ${signal}`));
      else resolve({ code, stdout, stderr });
    });
  });
}
