// An in-process OTLP/HTTP receiver for the `otlp` step. celld exports
// protobuf (crates/celld/otlp.rs), so this decodes exactly that: the
// trace and log export requests, by hand, as celld encodes them. Field
// numbers follow opentelemetry-proto v1.

import { createServer } from "node:http";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
// celld flushes every CELLD_OTEL_FLUSH_MS (the runner sets 100). Once the
// spans a step waits for have arrived, it waits this long for anything else
// the same requests produced, so a span the step did not name still shows in
// the transcript instead of in the next step's.
export const FLUSH_MS = 100;
const QUIET_MS = 5 * FLUSH_MS;

// Attributes whose values differ from run to run.
const VOLATILE_ATTRIBUTES = new Set(["celld.request_id", "celld.isolate", "celld.queue_wait_us", "celld.epoch"]);
const KINDS = ["unspecified", "internal", "server", "client", "producer", "consumer"];
const STATUS_CODES = ["unset", "ok", "error"];

/** Starts the receiver on a loopback port. `url` is the CELLD_OTEL value. */
export async function startOtlpReceiver() {
  const received = { spans: [], logs: [], errors: [] };
  const waiters = new Set();
  const notify = () => {
    for (const waiter of waiters) waiter();
  };
  const server = createServer((request, response) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    request.on("end", () => {
      const fail = (status, message) => {
        received.errors.push(`${request.method} ${request.url}: ${message}`);
        response.writeHead(status, { "content-type": "text/plain" }).end(message);
        notify();
      };
      if (request.method !== "POST") return fail(405, "only POST is an OTLP export");
      if (size > MAX_BODY_BYTES) return fail(413, `the body is over ${MAX_BODY_BYTES} bytes`);
      if (request.headers["content-type"] !== "application/x-protobuf") {
        return fail(415, `content-type ${request.headers["content-type"]} is not application/x-protobuf`);
      }
      const body = Buffer.concat(chunks);
      try {
        if (request.url === "/v1/traces") received.spans.push(...decodeTraces(body));
        else if (request.url === "/v1/logs") received.logs.push(...decodeLogs(body));
        else return fail(404, "not an OTLP signal path");
      } catch (error) {
        return fail(400, `malformed export request: ${error.message}`);
      }
      // An empty Export*ServiceResponse: full success.
      response.writeHead(200, { "content-type": "application/x-protobuf" }).end();
      notify();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    /**
     * Waits until spans named `names` (a multiset) have arrived, then for
     * the export to go quiet, and returns everything received since the last
     * call as a span forest for the transcript.
     */
    async take(names, timeoutMs) {
      const missing = () => {
        const counts = new Map();
        for (const span of received.spans) counts.set(span.name, (counts.get(span.name) ?? 0) + 1);
        return names.filter((name) => {
          const left = counts.get(name) ?? 0;
          counts.set(name, left - 1);
          return left <= 0;
        });
      };
      const deadline = Date.now() + timeoutMs;
      let quietSince = null;
      let seen = -1;
      for (;;) {
        if (received.errors.length) throw new Error(`the OTLP receiver refused an export: ${received.errors.join("; ")}`);
        const count = received.spans.length + received.logs.length;
        if (count !== seen) {
          seen = count;
          quietSince = Date.now();
        }
        if (missing().length === 0 && Date.now() - quietSince >= QUIET_MS) break;
        if (Date.now() >= deadline) {
          throw new Error(
            `timed out waiting for spans ${JSON.stringify(missing())}; received ${JSON.stringify(received.spans.map((span) => span.name))}`,
          );
        }
        await new Promise((resolve) => {
          const waiter = () => {
            waiters.delete(waiter);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(waiter, FLUSH_MS);
          waiters.add(waiter);
        });
      }
      const spans = received.spans.splice(0);
      const logs = received.logs.splice(0);
      return forest(spans, logs);
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * The spans as trees, each node `{name, kind, status?, attributes?, events?,
 * logs?, children?}`. ids and times differ between runs, so structure stands
 * in for them: a child sits under its parent, a log line under the span that
 * wrote it. Siblings sort by content; a span whose parent was not exported
 * is a root, marked `"parent": "remote"` when it had one.
 */
function forest(spans, logs) {
  const nodes = new Map();
  for (const span of spans) {
    const node = { name: span.name, kind: span.kind };
    if (span.status.code !== "unset") node.status = span.status;
    const attributes = Object.fromEntries(
      Object.entries(span.attributes)
        .filter(([key]) => !VOLATILE_ATTRIBUTES.has(key))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    if (Object.keys(attributes).length) node.attributes = attributes;
    if (span.events.length) node.events = span.events;
    nodes.set(span.spanId, { span, node, children: [], logs: [] });
  }
  const orphanLogs = [];
  for (const log of logs) {
    const owner = nodes.get(log.spanId);
    if (owner) owner.logs.push(log.body);
    else orphanLogs.push(log.body);
  }
  const roots = [];
  for (const entry of nodes.values()) {
    const parent = entry.span.parentSpanId && nodes.get(entry.span.parentSpanId);
    if (parent) parent.children.push(entry);
    else {
      if (entry.span.parentSpanId) entry.node.parent = "remote";
      roots.push(entry);
    }
  }
  const build = (entry) => {
    const node = { ...entry.node };
    if (entry.logs.length) node.logs = entry.logs;
    if (entry.children.length) node.children = sortNodes(entry.children.map(build));
    return node;
  };
  const result = { spans: sortNodes(roots.map(build)) };
  if (orphanLogs.length) result.logs = orphanLogs;
  return result;
}

function sortNodes(nodes) {
  return nodes
    .map((node) => [JSON.stringify(node), node])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, node]) => node);
}

// ---- protobuf --------------------------------------------------------------
//
// Each message is decoded against a schema of the fields celld sends: field
// number -> [name, wire type, "one" | "many"]. A field outside the schema, a
// field with the wrong wire type, or a singular field sent twice is refused,
// so an encoding mistake fails the step instead of slipping by. `skip` names
// fields celld may send that the transcript does not use.

const VARINT = 0;
const FIXED64 = 1;
const LEN = 2;

/** The fields of one message, as [number, wire type, value] in order. */
function fields(buffer) {
  const out = [];
  let offset = 0;
  const varint = () => {
    let result = 0n;
    for (let shift = 0n; ; shift += 7n) {
      if (offset >= buffer.length) throw new Error("truncated varint");
      if (shift > 63n) throw new Error("varint longer than 64 bits");
      const byte = buffer[offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
    }
  };
  const take = (length) => {
    if (offset + length > buffer.length) throw new Error("truncated field");
    const value = buffer.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  while (offset < buffer.length) {
    const key = varint();
    const number = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === VARINT) out.push([number, wire, varint()]);
    else if (wire === FIXED64) out.push([number, wire, take(8)]);
    else if (wire === LEN) out.push([number, wire, take(Number(varint()))]);
    else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

/** `bytes` decoded as `message`: an object of field values by name. */
function decode(message, schema, bytes, { skip = [], required = [] } = {}) {
  const out = {};
  for (const [number, wire, value] of fields(bytes)) {
    const field = schema[number];
    if (field === undefined) {
      if (skip.includes(number)) continue;
      throw new Error(`${message} field ${number} is not one celld sends`);
    }
    const [name, expected, arity] = field;
    if (wire !== expected) throw new Error(`${message}.${name} has wire type ${wire}, not ${expected}`);
    if (arity === "many") (out[name] ??= []).push(value);
    else if (name in out) throw new Error(`${message}.${name} is sent twice`);
    else out[name] = value;
  }
  for (const name of required) {
    if (!(name in out)) throw new Error(`${message} has no ${name}`);
  }
  return out;
}

const text = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const hex = (bytes, length, what) => {
  if (bytes.length !== length) throw new Error(`${what} is ${bytes.length} bytes, not ${length}`);
  return Buffer.from(bytes).toString("hex");
};
const nanos = (bytes) => Buffer.from(bytes).readBigUInt64LE();

/** common.v1.AnyValue, as a JSON value: exactly one of the kinds celld sends. */
function anyValue(bytes) {
  const value = decode("AnyValue", {
    1: ["string", LEN, "one"],
    2: ["bool", VARINT, "one"],
    3: ["int", VARINT, "one"],
    4: ["double", FIXED64, "one"],
  }, bytes);
  const kinds = Object.keys(value);
  if (kinds.length !== 1) throw new Error(`an AnyValue holds ${kinds.length} values, not one`);
  switch (kinds[0]) {
    case "string":
      return text(value.string);
    case "bool":
      if (value.bool > 1n) throw new Error(`a bool AnyValue is ${value.bool}`);
      return value.bool === 1n;
    case "int":
      return Number(BigInt.asIntN(64, value.int));
    case "double":
      return Buffer.from(value.double).readDoubleLE();
  }
}

/** repeated common.v1.KeyValue, as an object whose keys are unique. */
function keyValues(list = [], what) {
  const out = {};
  for (const bytes of list) {
    const pair = decode("KeyValue", { 1: ["key", LEN, "one"], 2: ["value", LEN, "one"] }, bytes, {
      required: ["key", "value"],
    });
    const key = text(pair.key);
    if (Object.hasOwn(out, key)) throw new Error(`${what} sends the key "${key}" twice`);
    out[key] = anyValue(pair.value);
  }
  return out;
}

function decodeTraces(body) {
  const spans = [];
  const request = decode("ExportTraceServiceRequest", { 1: ["resourceSpans", LEN, "many"] }, body);
  for (const resourceSpans of request.resourceSpans ?? []) {
    const resource = decode("ResourceSpans", { 1: ["resource", LEN, "one"], 2: ["scopeSpans", LEN, "many"] }, resourceSpans, {
      skip: [3],
    });
    for (const scopeSpans of resource.scopeSpans ?? []) {
      const scope = decode("ScopeSpans", { 1: ["scope", LEN, "one"], 2: ["spans", LEN, "many"] }, scopeSpans, { skip: [3] });
      for (const bytes of scope.spans ?? []) spans.push(decodeSpan(bytes));
    }
  }
  return spans;
}

const SPAN = {
  1: ["traceId", LEN, "one"],
  2: ["spanId", LEN, "one"],
  4: ["parentSpanId", LEN, "one"],
  5: ["name", LEN, "one"],
  6: ["kind", VARINT, "one"],
  7: ["start", FIXED64, "one"],
  8: ["end", FIXED64, "one"],
  9: ["attributes", LEN, "many"],
  11: ["events", LEN, "many"],
  15: ["status", LEN, "one"],
};

function decodeSpan(bytes) {
  const raw = decode("Span", SPAN, bytes, { required: ["traceId", "spanId", "name", "kind", "start", "end"] });
  const name = text(raw.name);
  const span = {
    traceId: hex(raw.traceId, 16, "a trace id"),
    spanId: hex(raw.spanId, 8, "a span id"),
    name,
    kind: KINDS[Number(raw.kind)] ?? `kind ${raw.kind}`,
    attributes: keyValues(raw.attributes, `span "${name}"`),
    events: (raw.events ?? []).map((event) => decodeEvent(event, name)),
    status: raw.status === undefined ? { code: "unset" } : decodeStatus(raw.status),
  };
  if (raw.parentSpanId !== undefined) span.parentSpanId = hex(raw.parentSpanId, 8, "a parent span id");
  if (nanos(raw.end) < nanos(raw.start)) throw new Error(`span "${name}" ends before it starts`);
  return span;
}

function decodeEvent(bytes, span) {
  const event = decode("Event", { 1: ["time", FIXED64, "one"], 2: ["name", LEN, "one"], 3: ["attributes", LEN, "many"] }, bytes, {
    required: ["time", "name"],
  });
  const name = text(event.name);
  return { name, attributes: keyValues(event.attributes, `event "${name}" of span "${span}"`) };
}

function decodeStatus(bytes) {
  const raw = decode("Status", { 2: ["message", LEN, "one"], 3: ["code", VARINT, "one"] }, bytes, { required: ["code"] });
  const status = { code: STATUS_CODES[Number(raw.code)] ?? `code ${raw.code}` };
  if (raw.message !== undefined) status.message = text(raw.message);
  return status;
}

const LOG_RECORD = {
  1: ["time", FIXED64, "one"],
  2: ["severityNumber", VARINT, "one"],
  3: ["severityText", LEN, "one"],
  5: ["body", LEN, "one"],
  9: ["traceId", LEN, "one"],
  10: ["spanId", LEN, "one"],
  11: ["observedTime", FIXED64, "one"],
};

function decodeLogs(body) {
  const logs = [];
  const request = decode("ExportLogsServiceRequest", { 1: ["resourceLogs", LEN, "many"] }, body);
  for (const resourceLogs of request.resourceLogs ?? []) {
    const resource = decode("ResourceLogs", { 1: ["resource", LEN, "one"], 2: ["scopeLogs", LEN, "many"] }, resourceLogs, {
      skip: [3],
    });
    for (const scopeLogs of resource.scopeLogs ?? []) {
      const scope = decode("ScopeLogs", { 1: ["scope", LEN, "one"], 2: ["logRecords", LEN, "many"] }, scopeLogs, { skip: [3] });
      for (const bytes of scope.logRecords ?? []) {
        const record = decode("LogRecord", LOG_RECORD, bytes, { required: ["time", "body"] });
        const log = { body: anyValue(record.body) };
        if (record.traceId !== undefined) log.traceId = hex(record.traceId, 16, "a log's trace id");
        if (record.spanId !== undefined) log.spanId = hex(record.spanId, 8, "a log's span id");
        logs.push(log);
      }
    }
  }
  return logs;
}
