// What `process.env` holds under a Worker's compatibility date and flags, which
// each node/process-env Worker sets in its wrangler.jsonc. Every Worker
// re-exports this module's default handler.
//
// With `nodejs_compat`, workerd copies the Worker's `env` into `process.env`
// from compatibility date 2025-04-01 (`nodejs_compat_populate_process_env`,
// turned off by `nodejs_compat_do_not_populate_process_env`): a string as it
// is, a value JSON can carry as its JSON text, and nothing else
// (src/node/internal/internal_process.ts, getInitialEnv). Without Node.js
// compatibility workerd has no `process`, so the snapshot is empty, as it is
// when nothing is copied.

const snapshot = () => ({ ...(globalThis.process?.env ?? {}) });

// Taken while the module evaluates: a dependency reads `process.env` at
// module scope.
const atLoad = snapshot();

export function report() {
  return {
    flag:
      globalThis.Cloudflare?.compatibilityFlags?.nodejs_compat_populate_process_env ?? null,
    atLoad,
    now: snapshot(),
  };
}

export default {
  fetch() {
    return Response.json(report());
  },
};
