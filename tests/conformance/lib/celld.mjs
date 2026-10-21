// Runs a case on celld with `celld dev`, one supervisor process per start.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

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
 * session for runSteps. `logs()` returns the supervisor's stderr so far.
 */
export async function startCelld({ binary, esbuild, dir, workers, env }) {
  const configs = workers.flatMap((name) => ["-c", `workers/${name}/wrangler.jsonc`]);
  const stderr = [];
  const environment = { ...process.env, ...env, CELLD_ESBUILD: esbuild };
  // A failed start has no session to read the logs from, so its error
  // carries them.
  const start = (args) =>
    launch({ binary, dir, env: environment, args, stderr }).catch((error) => {
      throw new Error(`${error.message}\n--- celld dev stderr ---\n${stderr.join("").trim()}`, { cause: error });
    });
  let node = await start(["--clean", ...configs]);
  const session = {
    origin: node.ready.public,
    async restart() {
      await stop(node);
      node = await start(configs);
      session.origin = node.ready.public;
    },
    stop: () => stop(node),
    kill: () => node.child.kill("SIGKILL"),
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
        return;
      }
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
  return { child, ready, exited };
}

// The same request `celld dev` sends its own node on a reload: the node
// stops, its state stays, and the supervisor exits once the node has.
async function stop({ child, ready, exited }) {
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
}
