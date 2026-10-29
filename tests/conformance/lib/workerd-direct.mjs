// Records a celld-only case's transcript from workerd run directly, for a
// case that workerd can run but wrangler's harness can't show: the harness
// sends every global fetch() through a Node outbound service that follows
// redirects itself. Usage, from tests/conformance:
//
//   node lib/workerd-direct.mjs <case id> [--write]
//
// The case has `workerd.capnp` beside case.json: a workerd config whose
// socket is named "http" and whose globalOutbound is a network service. This
// starts the upstream, runs `workerd serve` on that config with the socket on
// a free port, and runs the case's `path` steps as the runner does, with the
// same placeholders and normalization. It prints the transcript, and with
// --write stores it as the case's expect.json. Review it before committing.

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCase } from "./case.mjs";
import { bindPlaceholders, freePort, runSteps } from "./steps.mjs";
import { startUpstream } from "./upstream.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKERD = join(ROOT, "node_modules", ".bin", "workerd");

const [id, ...flags] = process.argv.slice(2);
if (id === undefined || flags.some((flag) => flag !== "--write")) {
  console.error("usage: node lib/workerd-direct.mjs <case id> [--write]");
  process.exit(2);
}
const testCase = loadCase(join(ROOT, "cases"), id);
const config = join(testCase.dir, "workerd.capnp");
if (!existsSync(config)) throw new Error(`${id} has no workerd.capnp`);
if (testCase.kind !== "celld-only") throw new Error(`${id} is differential: record it with run.mjs --update`);
if (testCase.steps.some((step) => step.kind !== "path")) throw new Error(`${id} has a step other than "path"`);

const upstream = testCase.upstream ? await startUpstream() : null;
const port = await freePort();
const workerd = spawn(WORKERD, ["serve", config, "--socket-addr", `http=127.0.0.1:${port}`], {
  stdio: ["ignore", "inherit", "inherit"],
});
try {
  const origin = `http://127.0.0.1:${port}`;
  for (let tries = 0; ; tries++) {
    try {
      await fetch(origin, { method: "HEAD" });
      break;
    } catch (error) {
      if (tries >= 100 || workerd.exitCode !== null) throw new Error(`workerd did not start: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const { steps, normalize } = bindPlaceholders(testCase, {
    UPSTREAM_PORT: upstream?.ports[0],
    UPSTREAM_PORT_2: upstream?.ports[1],
    UPSTREAM_ECHO_PORT: upstream?.ports[2],
  });
  // The version it came from, as a differential case's recording has.
  const require = createRequire(join(ROOT, "package.json"));
  const version = createRequire(require.resolve("wrangler"))("workerd/package.json").version;
  const transcript = { workerd: version, steps: await runSteps({ origin }, steps, normalize) };
  const text = `${JSON.stringify(transcript, null, 2)}\n`;
  process.stdout.write(text);
  if (flags.includes("--write")) writeFileSync(join(testCase.dir, "expect.json"), text);
} finally {
  workerd.kill();
  await upstream?.close();
}
