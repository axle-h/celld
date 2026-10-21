// Runs a case on workerd through wrangler's test harness, the API Cloudflare
// OS's own integration tests use.

import { createTestHarness } from "wrangler";

const START_TIMEOUT_MS = 120_000;

// wrangler's switch for local observability, which attaches Miniflare's trace
// collector to each Worker. It decides whether `tracing` spans are traced, so
// a case's "observability" sets it, for the life of the session: wrangler
// reads it whenever it builds the workerd options, restarts included.
const OBSERVABILITY_ENV = "X_LOCAL_OBSERVABILITY";

/**
 * Starts the case's workers from `dir` (a temp copy of the case) and returns a
 * session for runSteps.
 *
 * Restart: the harness hard-codes `persist: false`, so a second harness can't
 * reopen the first one's storage. `update()` with unchanged options does what
 * a restart needs instead: Miniflare disposes the workerd process and spawns
 * a new one over the same storage directory. Isolates and Durable Object
 * instances start fresh, and durable storage survives.
 */
export async function startWorkerd({ dir, workers, observability }) {
  const options = {
    root: dir,
    workers: workers.map((name) => ({ configPath: `workers/${name}/wrangler.jsonc` })),
  };
  // Cases run one at a time, so the runner's environment is this session's.
  const shell = process.env[OBSERVABILITY_ENV];
  process.env[OBSERVABILITY_ENV] = String(observability);
  const restoreEnv = () => {
    if (shell === undefined) delete process.env[OBSERVABILITY_ENV];
    else process.env[OBSERVABILITY_ENV] = shell;
  };
  let harness;
  try {
    harness = createTestHarness(options);
  } catch (error) {
    restoreEnv();
    throw error;
  }
  const close = () => harness.close().finally(restoreEnv);
  let url;
  try {
    ({ url } = await bounded(harness.listen(), "start"));
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  const session = {
    origin: url.origin,
    async restart() {
      await bounded(harness.update(options), "restart");
      session.origin = (await bounded(harness.listen(), "restart")).url.origin;
    },
    stop: close,
    kill: close,
    logs: () =>
      harness
        .getLogs()
        .map((log) => `${log.level}: ${log.message}`)
        .join("\n"),
  };
  return session;
}

async function bounded(promise, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`workerd did not ${what} within ${START_TIMEOUT_MS / 1000}s`)), START_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
