// Runs a case on celld with `celld dev`, one supervisor process per start.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { FLUSH_MS, startOtlpReceiver } from "./otlp.mjs";

const READY_TIMEOUT_MS = 120_000;
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
 */
export async function startCelld({ binary, esbuild, dir, workers, env, observability }) {
  const configs = workers.flatMap((name) => ["-c", `workers/${name}/wrangler.jsonc`]);
  const stderr = [];
  // Telemetry is off unless the case turns it on, whatever the shell has.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CELLD_OTEL|OTEL_)/.test(name)));
  const otlp = observability ? await startOtlpReceiver() : undefined;
  const telemetry = otlp ? { CELLD_OTEL: otlp.url, CELLD_OTEL_FLUSH_MS: String(FLUSH_MS) } : {};
  const environment = { ...inherited, ...env, ...telemetry, CELLD_ESBUILD: esbuild };
  // A failed start has no session to read the logs from, so its error
  // carries them.
  const start = (args) =>
    launch({ binary, dir, env: environment, args, stderr }).catch((error) => {
      throw new Error(`${error.message}\n--- celld dev stderr ---\n${stderr.join("").trim()}`, { cause: error });
    });
  let node;
  try {
    node = await start(["--clean", ...configs]);
  } catch (error) {
    await otlp?.close();
    throw error;
  }
  const session = {
    origin: node.ready.public,
    otlp,
    async restart() {
      await stop(node);
      node = await start(configs);
      session.origin = node.ready.public;
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

async function launch({ binary, dir, env, args, stderr }) {
  const child = spawn(binary, ["dev", "--no-watch", "--port", "0", ...args], {
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
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CELLD_OTEL|OTEL_)/.test(name)));
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
