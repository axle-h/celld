#!/usr/bin/env node
// The conformance runner. See README.md for usage and the case format.

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { CaseError, findCases, loadCase } from "./lib/case.mjs";
import { startCelld, startDeploySession } from "./lib/celld.mjs";
import { bindPlaceholders, describeStep, freePort, runSteps } from "./lib/steps.mjs";
import { mandatoryRequirements, missingRequirement } from "./lib/requirements.mjs";
import { startUpstream } from "./lib/upstream.mjs";
import { startWorkerd } from "./lib/workerd.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const CASES = join(HERE, "cases");
// Inside this package, so a Worker that imports a package (capnweb) resolves
// it from this package's node_modules on both runtimes.
const SCRATCH = join(HERE, ".run");
const USAGE = `usage: node run.mjs [--runtime=celld|workerd|both] [--update] [--filter GLOB]... [--profile NAME] [--esbuild VERSION]

  --runtime   which runtime to run the cases on (default: both)
  --update    record expect.json from workerd for the differential cases
  --filter    run only the cases whose id (area/case) matches GLOB; repeatable
  --profile   the cargo profile whose celld binary to run (default: lab)
  --esbuild   celld's esbuild: the esbuild-VERSION package this package pins
              besides esbuild, one per version celld supports (default: esbuild)

  CONFORMANCE_REQUIRE=docker[,...]  fail, instead of skip, a case whose
                                    "requires" names a requirement this
                                    machine does not meet`;

// An error in how the runner was invoked or set up: its message is the whole
// report.
class SetupError extends Error {}

function parseOptions() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        runtime: { type: "string" },
        update: { type: "boolean", default: false },
        filter: { type: "string", multiple: true, default: [] },
        profile: { type: "string", default: "lab" },
        esbuild: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
  } catch (error) {
    usage(error.message);
  }
  const { values } = parsed;
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (values.update && values.runtime !== undefined && values.runtime !== "workerd") {
    usage("--update records from workerd only; drop --runtime or pass --runtime=workerd");
  }
  const runtime = values.update ? "workerd" : (values.runtime ?? "both");
  if (!["celld", "workerd", "both"].includes(runtime)) usage(`--runtime must be celld, workerd or both, not "${runtime}"`);
  if (!/^[\w-]+$/.test(values.profile)) usage(`--profile "${values.profile}" is not a cargo profile name`);
  if (values.esbuild !== undefined && !/^\d+\.\d+\.\d+$/.test(values.esbuild)) usage(`--esbuild "${values.esbuild}" is not a version`);
  let required;
  try {
    required = mandatoryRequirements();
  } catch (error) {
    usage(error.message);
  }
  return { runtime, update: values.update, filters: values.filter, profile: values.profile, esbuild: values.esbuild, required };
}

function usage(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function toolchain(options) {
  const require = createRequire(join(HERE, "package.json"));
  let wrangler;
  let workerd;
  let esbuild;
  try {
    wrangler = require("wrangler/package.json").version;
    workerd = createRequire(require.resolve("wrangler"))("workerd/package.json").version;
    const name = options.esbuild === undefined ? "esbuild" : `esbuild-${options.esbuild}`;
    esbuild = join(dirname(require.resolve(`${name}/package.json`)), "bin", "esbuild");
  } catch (error) {
    throw new SetupError(`the runner's dependencies are missing (${error.message}); run pnpm install in tests/conformance`);
  }
  const celld = join(REPO, "target", options.profile, "celld");
  if (options.runtime !== "workerd" && !existsSync(celld)) {
    throw new SetupError(`${celld} does not exist; build it with cargo build --profile ${options.profile} -p celld`);
  }
  return { wrangler, workerd, esbuild, celld };
}

async function main() {
  const options = parseOptions();
  const tools = toolchain(options);
  const ids = findCases(CASES).filter(
    (id) => options.filters.length === 0 || options.filters.some((glob) => matchesGlob(id, glob) || matchesGlob(id, `${glob}/**`)),
  );
  if (ids.length === 0) throw new SetupError(`no case matches ${options.filters.join(", ") || "anything"}`);
  // Every selected case is validated before any runs, so a malformed one
  // fails the run at once instead of after the others.
  const cases = ids.map((id) => loadCase(CASES, id));

  console.log(`workerd ${tools.workerd} (wrangler ${tools.wrangler}); celld ${options.runtime === "workerd" ? "not run" : tools.celld}\n`);
  const tally = {};
  for (const testCase of cases) {
    const { status, detail, kept } = await runCase(testCase, options, tools);
    tally[status] = (tally[status] ?? 0) + 1;
    console.log(`${status.padEnd(8)} ${testCase.id}${detail ? `\n${indent(detail)}` : ""}${kept ? `\n${indent(`kept ${kept}`)}` : ""}`);
  }
  console.log(`\n${Object.entries(tally).map(([status, count]) => `${count} ${status}`).join(", ")}`);
  return tally.FAIL || tally.XPASS ? 1 : 0;
}

async function runCase(testCase, options, tools) {
  if (options.update) {
    if (testCase.kind !== "differential") return { status: "SKIP", detail: "celld-only: expect.json is written by hand" };
    // Two recordings that disagree mean the case is nondeterministic: fix
    // the Worker, or add a normalize rule for the value that varies.
    const first = await execute("workerd", testCase, tools);
    if (first.error) return failure(first.error, first);
    first.cleanup();
    const second = await execute("workerd", testCase, tools);
    if (second.error) return failure(second.error, second);
    const diff = compare(testCase, first.transcript, second.transcript, "first recording", "second recording");
    if (diff) return failure(`two recordings on workerd differ, so the case is nondeterministic\n${diff}`, second);
    second.cleanup();
    const expected = { workerd: tools.workerd, wrangler: tools.wrangler, steps: second.transcript };
    writeFileSync(testCase.expectPath, `${JSON.stringify(expected, null, 2)}\n`);
    return { status: "RECORDED" };
  }

  if (!testCase.expected) {
    const how = testCase.kind === "differential" ? "record it with --update" : "write it by hand";
    return { status: "FAIL", detail: `no expect.json; ${how}` };
  }
  if (testCase.kind === "differential" && testCase.expected.workerd !== tools.workerd) {
    return {
      status: "FAIL",
      detail: `expect.json was recorded on workerd ${testCase.expected.workerd}, but workerd ${tools.workerd} is installed; re-record with --update`,
    };
  }

  if (testCase.kind === "celld-only" && options.runtime === "workerd") {
    return { status: "SKIP", detail: `celld-only: ${testCase.reason}` };
  }
  for (const name of testCase.requires) {
    const missing = missingRequirement(name);
    if (!missing) continue;
    if (options.required.has(name)) {
      return { status: "FAIL", detail: `requires ${name}, which CONFORMANCE_REQUIRE makes mandatory: ${missing}` };
    }
    return { status: "SKIP", detail: `requires ${name}: ${missing}` };
  }
  if (testCase.kind === "differential" && options.runtime !== "celld") {
    const run = await execute("workerd", testCase, tools);
    if (run.error) return failure(run.error, run);
    const diff = compare(testCase, testCase.expected.steps, run.transcript, "expect.json", "workerd");
    if (diff) return failure(`workerd no longer matches expect.json; check the change and re-record with --update\n${diff}`, run);
    run.cleanup();
    if (options.runtime === "workerd") return { status: "PASS" };
    return judge(testCase, await execute("celld", testCase, tools), run.transcript, "workerd");
  }
  return judge(testCase, await execute("celld", testCase, tools), testCase.expected.steps, "expect.json");
}

// The verdict on a celld run, which an xfail marker inverts.
function judge(testCase, run, expected, expectedLabel) {
  const problem = run.error ?? compare(testCase, expected, run.transcript, expectedLabel, "celld");
  if (testCase.xfail) {
    run.cleanup();
    if (!problem) return { status: "XPASS", detail: `the case passes; remove "xfail": "${testCase.xfail}" in the change that fixed it` };
    return { status: "XFAIL", detail: `until ${testCase.xfail}` };
  }
  if (problem) return failure(problem, run);
  run.cleanup();
  return { status: "PASS" };
}

function failure(detail, run) {
  const logs = run.logs?.trim();
  const tail = logs ? `\n--- ${run.runtime} logs (last 40 lines) ---\n${logs.split("\n").slice(-40).join("\n")}` : "";
  return { status: "FAIL", detail: `${detail}${tail}`, kept: run.dir };
}

/** Runs the case on one runtime in a fresh copy of its directory. */
async function execute(runtime, testCase, tools) {
  mkdirSync(SCRATCH, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH, `${testCase.id.replaceAll("/", "__")}-${runtime}-`));
  cpSync(testCase.dir, dir, {
    recursive: true,
    filter: (source) => !/[\\/](\.celld|\.wrangler|node_modules)$/.test(source),
  });
  const run = { runtime, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  let session;
  let upstream;
  try {
    upstream = testCase.upstream ? await startUpstream() : undefined;
    const ports = {
      UPSTREAM_PORT: upstream?.ports[0],
      UPSTREAM_PORT_2: upstream?.ports[1],
      UPSTREAM_ECHO_PORT: upstream?.ports[2],
      // celld's own listeners, for celld-only cases.
      PUBLIC_PORT: testCase.publicPort && runtime === "celld" ? await freePort() : undefined,
      INTERNAL_PORT: testCase.internalPort && runtime === "celld" ? await freePort() : undefined,
    };
    const { env, steps, normalize } = bindPlaceholders(testCase, ports);
    session =
      runtime === "celld" && testCase.deployOnly
        ? startDeploySession({ binary: tools.celld, esbuild: tools.esbuild, dir, env })
        : runtime === "celld"
        ? await startCelld({
            binary: tools.celld,
            esbuild: tools.esbuild,
            dir,
            workers: testCase.workers,
            env,
            publicPort: ports.PUBLIC_PORT,
            internalPort: ports.INTERNAL_PORT,
            observability: testCase.observability,
            watchPorts: upstream?.ports ?? [],
          })
        : await startWorkerd({ dir, workers: testCase.workers, observability: testCase.observability });
    run.transcript = await runSteps(session, steps, normalize);
    await session.stop();
  } catch (error) {
    run.error = `${runtime}: ${error.message}`;
    await Promise.resolve(session?.kill()).catch(() => {});
  } finally {
    await upstream?.close();
  }
  run.logs = session?.logs();
  return run;
}

function compare(testCase, expected, actual, expectedLabel, actualLabel) {
  const lines = [];
  const count = Math.max(expected.length, actual.length);
  for (let index = 0; index < count; index++) {
    if (isDeepStrictEqual(expected[index], actual[index])) continue;
    const step = testCase.steps[index];
    lines.push(`steps[${index}] (${step ? describeStep(step) : "no such step"}):`);
    lines.push(`  ${expectedLabel}: ${JSON.stringify(expected[index])}`);
    lines.push(`  ${actualLabel}: ${JSON.stringify(actual[index])}`);
  }
  return lines.length ? lines.join("\n") : null;
}

const indent = (text) => text.replace(/^/gm, "    ");

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof CaseError || error instanceof SetupError ? error.message : error);
    process.exit(2);
  },
);
