// Loads and validates a case directory. Every malformed field is an error that
// names the case and the field: a case that quietly runs less than it says
// would pin nothing.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REQUIREMENTS } from "./requirements.mjs";

const CASE_KEYS = new Set(["kind", "reason", "workers", "env", "upstream", "observability", "nodes", "xfail", "requires", "steps", "normalize"]);
const STEP_KEYS = {
  path: new Set(["path", "method", "headers", "body", "chunked", "responseHeaders"]),
  ws: new Set(["ws", "send", "receive", "close", "protocols"]),
  restart: new Set(["restart"]),
  otlp: new Set(["otlp"]),
  deploy: new Set(["deploy", "args"]),
};
// The `celld deploy` flags a deploy step may add. The step always passes
// --dry-run --json, so nothing is written.
const DEPLOY_ARGS = new Set(["--no-build"]);
const OTLP_KEYS = new Set(["spans"]);
// The runner owns telemetry: "observability" turns it on for both runtimes.
const RUNNER_ENV = /^(CELLD_OTEL|OTEL_)/;
// Ports the runner picks for a run, which `env` values and step paths name as
// `${NAME}`. The upstream ports need "upstream": true. The public and
// internal ports are celld's own listeners, so they need a celld-only case.
const PLACEHOLDER = /\$\{([^}]*)\}/g;
const PLACEHOLDERS = new Set(["UPSTREAM_PORT", "UPSTREAM_PORT_2", "PUBLIC_PORT", "INTERNAL_PORT"]);
const NORMALIZE_KEYS = new Set(["pattern", "replace", "why"]);

export class CaseError extends Error {}

/** Every case directory under `root`, as ids like `examples/rpc`, sorted. */
export function findCases(root) {
  const ids = [];
  const walk = (dir) => {
    if (existsSync(join(dir, "case.json"))) {
      ids.push(relative(root, dir).split("\\").join("/"));
      return;
    }
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
    }
  };
  walk(root);
  return ids;
}

export function loadCase(root, id) {
  const dir = join(root, id);
  const fail = (message) => {
    throw new CaseError(`${id}/case.json: ${message}`);
  };
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
  } catch (error) {
    fail(`cannot be read as JSON: ${error.message}`);
  }
  if (!isObject(raw)) fail("must be a JSON object");
  for (const key of Object.keys(raw)) {
    if (!CASE_KEYS.has(key)) fail(`unknown key "${key}"`);
  }

  const kind = raw.kind ?? "differential";
  if (kind !== "differential" && kind !== "celld-only") {
    fail(`"kind" must be "differential" or "celld-only", not ${JSON.stringify(kind)}`);
  }
  if (kind === "celld-only" && !nonEmptyString(raw.reason)) {
    fail(`a celld-only case needs a "reason" saying why workerd cannot run it`);
  }
  if (kind === "differential" && "reason" in raw) {
    fail(`"reason" is only for celld-only cases`);
  }

  if (!Array.isArray(raw.workers) || raw.workers.length === 0) {
    fail(`"workers" must be a non-empty array of worker directory names; the first is the primary`);
  }
  for (const name of raw.workers) {
    if (!nonEmptyString(name) || !/^[A-Za-z0-9_-]+$/.test(name)) {
      fail(`worker name ${JSON.stringify(name)} must be a plain directory name`);
    }
    if (!existsSync(join(dir, "workers", name, "wrangler.jsonc"))) {
      fail(`worker "${name}" has no workers/${name}/wrangler.jsonc`);
    }
  }
  if (new Set(raw.workers).size !== raw.workers.length) fail(`"workers" names a worker twice`);

  const env = raw.env ?? {};
  if (!isObject(env)) fail(`"env" must be an object of strings`);
  for (const [name, value] of Object.entries(env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) fail(`"env" name ${JSON.stringify(name)} is not an environment variable name`);
    if (typeof value !== "string") fail(`"env.${name}" must be a string`);
    if (RUNNER_ENV.test(name)) fail(`"env.${name}" is the runner's to set; use "observability"`);
  }

  if ("upstream" in raw && typeof raw.upstream !== "boolean") fail(`"upstream" must be true or false`);
  const upstream = raw.upstream ?? false;

  if ("observability" in raw && typeof raw.observability !== "boolean") fail(`"observability" must be true or false`);
  const observability = raw.observability ?? false;

  if ("nodes" in raw) {
    if (!Number.isInteger(raw.nodes) || raw.nodes < 1) fail(`"nodes" must be a positive integer`);
    if (raw.nodes > 1) {
      fail(
        `"nodes": ${raw.nodes} is not supported yet. Multi-node cases (plan 0.2) arrive with the ` +
          `first case that needs one; add the fleet bring-up to lib/ in that change`,
      );
    }
  }

  const requires = raw.requires ?? [];
  if (!Array.isArray(requires) || requires.some((name) => !Object.hasOwn(REQUIREMENTS, name))) {
    fail(`"requires" must be an array of ${Object.keys(REQUIREMENTS).map((name) => `"${name}"`).join(", ")}`);
  }
  if (new Set(requires).size !== requires.length) fail(`"requires" names a requirement twice`);

  if ("xfail" in raw && !nonEmptyString(raw.xfail)) {
    fail(`"xfail" must name the plan item that fixes the case, such as "1.7"`);
  }

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) fail(`"steps" must be a non-empty array`);
  const steps = raw.steps.map((step, index) => validateStep(step, (message) => fail(`steps[${index}]: ${message}`)));
  const deploys = steps.filter((step) => step.kind === "deploy").length;
  if (deploys > 0) {
    // A deploy step runs `celld deploy`, not a node: workerd has nothing to
    // compare, and a case that also serves would start a node for configs
    // the deploy steps may refuse.
    if (kind !== "celld-only") fail(`a "deploy" step runs \`celld deploy\`, so it needs "kind": "celld-only"`);
    if (deploys !== steps.length) fail(`a case with a "deploy" step can have only "deploy" steps`);
    if (observability) fail(`a case with "deploy" steps starts no node, so "observability" does nothing`);
    steps.forEach((step, index) => {
      if (!raw.workers.includes(step.worker)) fail(`steps[${index}]: "deploy" must name one of "workers"`);
    });
  }
  steps.forEach((step, index) => {
    if (step.kind !== "otlp") return;
    // workerd's spans go to Miniflare's own collector, not to this runner.
    if (kind !== "celld-only") fail(`steps[${index}]: an "otlp" step reads celld's export, so it needs "kind": "celld-only"`);
    if (!observability) fail(`steps[${index}]: an "otlp" step needs "observability": true`);
  });

  const placeholderSources = [
    ...Object.entries(env).map(([name, value]) => [`"env.${name}"`, value]),
    ...steps.flatMap((step, index) => (step.path === undefined ? [] : [[`steps[${index}]`, step.path]])),
  ];
  const placeholders = new Set();
  for (const [where, text] of placeholderSources) {
    for (const [, name] of text.matchAll(PLACEHOLDER)) {
      if (!PLACEHOLDERS.has(name)) fail(`${where} names \${${name}}, which is not one of ${[...PLACEHOLDERS].map((p) => `\${${p}}`).join(", ")}`);
      if (name.startsWith("UPSTREAM_") && !upstream) fail(`${where} names \${${name}}, which needs "upstream": true`);
      if (!name.startsWith("UPSTREAM_") && kind !== "celld-only") fail(`${where} names \${${name}}, a celld listener, so the case needs "kind": "celld-only"`);
      placeholders.add(name);
    }
  }
  if (upstream && ![...placeholders].some((name) => name.startsWith("UPSTREAM_"))) {
    fail(`"upstream": true starts a server that no \${UPSTREAM_PORT} or \${UPSTREAM_PORT_2} names`);
  }

  const normalize = raw.normalize ?? [];
  if (!Array.isArray(normalize)) fail(`"normalize" must be an array`);
  const rules = normalize.map((rule, index) => {
    const at = (message) => fail(`normalize[${index}]: ${message}`);
    if (!isObject(rule)) at("must be an object");
    for (const key of Object.keys(rule)) if (!NORMALIZE_KEYS.has(key)) at(`unknown key "${key}"`);
    if (!nonEmptyString(rule.pattern)) at(`"pattern" must be a non-empty regular expression`);
    if (typeof rule.replace !== "string") at(`"replace" must be a string`);
    if (!nonEmptyString(rule.why)) at(`"why" must say which value is nondeterministic and why`);
    let regex;
    try {
      regex = new RegExp(rule.pattern, "g");
    } catch (error) {
      at(`"pattern" is not a valid regular expression: ${error.message}`);
    }
    return { regex, replace: rule.replace };
  });

  const expectPath = join(dir, "expect.json");
  const expected = existsSync(expectPath) ? readExpect(id, expectPath, kind) : null;

  return {
    id,
    dir,
    kind,
    reason: raw.reason,
    workers: raw.workers,
    env,
    upstream,
    publicPort: placeholders.has("PUBLIC_PORT"),
    internalPort: placeholders.has("INTERNAL_PORT"),
    observability,
    xfail: raw.xfail,
    requires,
    steps,
    deployOnly: deploys > 0,
    normalize: rules,
    expectPath,
    expected,
  };
}

function validateStep(step, fail) {
  if (!isObject(step)) fail("must be an object");
  if ("node" in step) {
    fail(`"node" directs a step in a multi-node case, which is not supported yet (plan 0.2)`);
  }
  const kinds = Object.keys(STEP_KEYS).filter((kind) => kind in step);
  if (kinds.length !== 1) fail(`must have exactly one of ${Object.keys(STEP_KEYS).map((k) => `"${k}"`).join(", ")}`);
  const [kind] = kinds;
  for (const key of Object.keys(step)) {
    if (!STEP_KEYS[kind].has(key)) fail(`unknown key "${key}" in a "${kind}" step`);
  }
  switch (kind) {
    case "path":
      if (!nonEmptyString(step.path) || !step.path.startsWith("/")) fail(`"path" must start with "/"`);
      if ("method" in step && !(typeof step.method === "string" && /^[A-Z]+$/.test(step.method))) fail(`"method" must be an upper-case HTTP method`);
      if ("headers" in step) {
        if (!isObject(step.headers)) fail(`"headers" must be an object of strings`);
        for (const [name, value] of Object.entries(step.headers)) {
          if (typeof value !== "string") fail(`"headers.${name}" must be a string`);
        }
      }
      if ("body" in step && typeof step.body !== "string") fail(`"body" must be a string`);
      if ("body" in step && ["GET", "HEAD"].includes(step.method ?? "GET")) fail(`a ${step.method ?? "GET"} request cannot have a "body"`);
      if ("chunked" in step && step.chunked !== true) fail(`"chunked" must be true when present`);
      if (step.chunked && !("body" in step)) fail(`"chunked" needs a "body"`);
      if ("responseHeaders" in step) {
        const names = step.responseHeaders;
        if (!Array.isArray(names) || names.length === 0 || !names.every((name) => typeof name === "string" && /^[a-z0-9-]+$/.test(name))) {
          fail(`"responseHeaders" must be a non-empty array of lower-case header names`);
        }
        if (new Set(names).size !== names.length) fail(`"responseHeaders" names a header twice`);
      }
      return {
        kind,
        path: step.path,
        method: step.method ?? "GET",
        headers: step.headers ?? {},
        body: step.body,
        chunked: step.chunked ?? false,
        responseHeaders: step.responseHeaders,
      };
    case "ws": {
      if (!nonEmptyString(step.ws) || !step.ws.startsWith("/")) fail(`"ws" must start with "/"`);
      const send = step.send ?? [];
      if (!Array.isArray(send) || !send.every((frame) => typeof frame === "string")) {
        fail(`"send" must be an array of text frames`);
      }
      // Offered subprotocols. With them, the transcript also records the one
      // the server selected.
      const protocols = step.protocols;
      if (protocols !== undefined) {
        if (!Array.isArray(protocols) || protocols.length === 0 || !protocols.every(nonEmptyString)) {
          fail(`"protocols" must be a non-empty array of subprotocol names`);
        }
        if (new Set(protocols).size !== protocols.length) fail(`"protocols" names a subprotocol twice`);
      }
      // With "close", the client closes after "receive" frames (by default
      // one per frame sent). Without it, the step waits for the server to
      // close.
      if (!("close" in step)) {
        if ("receive" in step) fail(`"receive" needs "close"; without "close" the step waits for the server to close`);
        return { kind, path: step.ws, send, receive: Infinity, protocols };
      }
      if (!(Number.isInteger(step.close) && (step.close === 1000 || (step.close >= 3000 && step.close <= 4999)))) {
        fail(`"close" must be 1000 or an application code in 3000-4999`);
      }
      const receive = step.receive ?? send.length;
      if (!Number.isInteger(receive) || receive < 0) fail(`"receive" must be a non-negative integer`);
      return { kind, path: step.ws, send, receive, close: step.close, protocols };
    }
    case "restart":
      if (step.restart !== true) fail(`"restart" must be true`);
      return { kind };
    case "otlp": {
      if (!isObject(step.otlp)) fail(`"otlp" must be an object`);
      for (const key of Object.keys(step.otlp)) {
        if (!OTLP_KEYS.has(key)) fail(`unknown key "otlp.${key}"`);
      }
      const { spans } = step.otlp;
      if (!Array.isArray(spans) || spans.length === 0 || !spans.every(nonEmptyString)) {
        fail(`"otlp.spans" must be a non-empty array of the span names to wait for`);
      }
      return { kind, spans };
    }
    case "deploy": {
      if (!nonEmptyString(step.deploy)) fail(`"deploy" must name a worker`);
      const args = step.args ?? [];
      if (!Array.isArray(args) || !args.every((arg) => DEPLOY_ARGS.has(arg))) {
        fail(`"args" must be an array of ${[...DEPLOY_ARGS].map((arg) => `"${arg}"`).join(", ")}`);
      }
      return { kind, worker: step.deploy, args };
    }
  }
}

function readExpect(id, path, kind) {
  const fail = (message) => {
    throw new CaseError(`${id}/expect.json: ${message}`);
  };
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot be read as JSON: ${error.message}`);
  }
  if (!isObject(raw) || !Array.isArray(raw.steps)) fail(`must be an object with a "steps" array`);
  if (kind === "differential" && !nonEmptyString(raw.workerd)) {
    fail(`a differential case's expectation must record the "workerd" version it came from; re-record it with --update`);
  }
  return raw;
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
