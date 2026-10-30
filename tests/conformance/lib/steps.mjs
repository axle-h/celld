// Runs a case's steps against a started runtime and returns the transcript:
// one entry per step, in the shape expect.json stores.

import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { connect, createServer } from "node:net";
import { BINARY, CLOSE, PING, PONG, TEXT, closePayload, encodeFrame, frameReader, isFragment, readClose } from "./ws-frames.mjs";

const STEP_TIMEOUT_MS = 30_000;

// Both runtimes listen on a port the OS picks, so a Worker that echoes its
// request URL would differ from run to run. The runner replaces the origin it
// connected to with this one in every string of the transcript.
export const STABLE_ORIGIN = "http://origin.test";

/**
 * `session` has `origin` (the runtime's current public origin) and
 * `restart()`, which stops the runtime with its state kept, starts it again
 * and updates `origin`. A celld session with observability on also has
 * `otlp`, its OTLP receiver.
 */
export async function runSteps(session, steps, normalize) {
  const transcript = [];
  for (const [index, step] of steps.entries()) {
    let entry;
    try {
      entry = await runStep(session, step);
    } catch (error) {
      throw new Error(`steps[${index}] (${describeStep(step)}) failed: ${error.message}`, { cause: error });
    }
    transcript.push(normalizeStrings(entry, session.origin, normalize));
  }
  return transcript;
}

/**
 * Puts the ports the runner picked for this run into the case's `env` values
 * and step paths, where they appear as `${NAME}`. Each port also gets a
 * normalize rule that turns it back into its placeholder in the transcript,
 * as the origin becomes http://origin.test, so a Worker or an error message
 * that names one records the same text on every run.
 */
export function bindPlaceholders(testCase, ports) {
  const bind = (text) =>
    text.replace(/\$\{([^}]*)\}/g, (placeholder, name) => {
      const port = ports[name];
      if (port === undefined) throw new Error(`${placeholder} has no value on this runtime`);
      return String(port);
    });
  const env = Object.fromEntries(Object.entries(testCase.env).map(([name, value]) => [name, bind(value)]));
  const steps = testCase.steps.map((step) => (step.path === undefined ? step : { ...step, path: bind(step.path) }));
  const rules = Object.entries(ports)
    .filter(([, port]) => port !== undefined)
    .map(([name, port]) => ({ regex: new RegExp(`(?<=[:=])${port}(?![0-9])`, "g"), replace: `\${${name}}` }));
  return { env, steps, normalize: [...rules, ...testCase.normalize] };
}

/** A port nothing listens on now. Another process can take it before use. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export function describeStep(step) {
  switch (step.kind) {
    case "path":
      return `${step.method} ${step.path}`;
    case "ws":
      return `ws ${step.path}`;
    case "restart":
      return "restart";
    case "rss":
      return `rss ${step.rss}`;
    case "cpu":
      return `cpu ${step.cpu}${step.wait ? ` after ${step.wait} ms` : ""}`;
    case "sockets":
      return `sockets ${step.sockets}`;
    case "otlp":
      return `otlp ${step.spans.join(", ")}`;
    case "deploy":
      return `deploy ${[step.worker, ...step.args].join(" ")}`;
    case "internal":
      return `internal ${step.path}`;
  }
}

async function runStep(session, step) {
  switch (step.kind) {
    case "path":
      if (step.probe !== undefined) return probedFetchStep(session, step);
      return fetchStep(session.origin, step);
    case "ws":
      return webSocketStep(session, step);
    case "restart":
      await session.restart();
      return { restart: true };
    case "rss":
      return { rss: await session.rss(step.rss) };
    case "cpu":
      return { cpu: await session.cpu(step.cpu, step.wait) };
    case "sockets":
      return { sockets: await session.sockets(step.sockets, step.within) };
    case "otlp":
      return { otlp: await session.otlp.take(step.spans, STEP_TIMEOUT_MS) };
    case "deploy":
      return session.deploy(step, STEP_TIMEOUT_MS);
    case "internal":
      return internalStep(session.internal, step);
  }
}

// A GET to celld's operator listener, which must answer within `within` ms:
// a node whose listener threads are all taken answers late or not at all.
// With `until`, it asks again every 100 ms until the JSON answer has each
// value, within the same bound. The transcript keeps the verdict, the last
// status and the `record` paths, not the times, which vary by run.
async function internalStep(origin, step) {
  const started = Date.now();
  const pick = (body, path) => path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), body) ?? null;
  const matches = (body) => Object.entries(step.until).every(([path, value]) => JSON.stringify(pick(body, path)) === JSON.stringify(value));
  let status = null;
  let body = null;
  for (;;) {
    const remaining = step.within - (Date.now() - started);
    if (remaining <= 0) break;
    try {
      const response = await fetch(new URL(step.path, origin), { signal: AbortSignal.timeout(remaining) });
      status = response.status;
      const text = await response.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    } catch {
      break;
    }
    if (matches(body) && Date.now() - started <= step.within) {
      return {
        status,
        internal: `answered within ${step.within} ms`,
        ...(step.record.length ? { values: Object.fromEntries(step.record.map((path) => [path, pick(body, path)])) } : {}),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const last = Object.fromEntries([...Object.keys(step.until), ...step.record].map((path) => [path, pick(body, path)]));
  return { status, internal: `no answer within ${step.within} ms`, after: `${Date.now() - started} ms`, last };
}

// A path step with a "probe": the operator listener must answer each probe
// within its bound while the request is in flight. The transcript records the
// verdict; the slowest probe only when it is over.
async function probedFetchStep(session, step) {
  let done = false;
  const request = fetchStep(session.origin, step).finally(() => (done = true));
  let probes = 0;
  let slowest = 0;
  let unanswered = 0;
  while (!done) {
    const started = Date.now();
    try {
      const response = await fetch(new URL(step.probe.path, session.internal), {
        signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
      });
      await response.arrayBuffer();
    } catch {
      unanswered++;
    }
    probes++;
    slowest = Math.max(slowest, Date.now() - started);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const entry = await request;
  const within = probes > 0 && unanswered === 0 && slowest <= step.probe.within;
  return {
    ...entry,
    probe: within
      ? `answered within ${step.probe.within} ms`
      : `${probes} probes, ${unanswered} unanswered, slowest ${slowest} ms, past ${step.probe.within} ms`,
  };
}

async function fetchStep(origin, step) {
  // fetch() replaces a `sec-fetch-mode` header with its own, so a step that
  // sets one, to send a navigation, goes out through node:http instead.
  const send = Object.keys(step.headers ?? {}).some((name) => /^sec-fetch-/i.test(name))
    ? httpFetch
    : fetch;
  // A chunked body has no length, so the runtime streams it to the Worker.
  const requestBody = step.chunked
    ? new Blob([step.body]).stream()
    : step.body;
  const response = await send(new URL(step.path, origin), {
    method: step.method,
    headers: step.headers,
    body: requestBody,
    ...(step.chunked ? { duplex: "half" } : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  });
  const text = await response.text();
  const json = /^application\/([\w.+-]+\+)?json\b/i.test(response.headers.get("content-type") ?? "");
  let body = text;
  if (json) {
    try {
      body = JSON.parse(text);
    } catch {
      // A body labelled JSON that does not parse is recorded as text, so the
      // diff shows it instead of the runner failing on it.
    }
  }
  if (step.responseHeaders === undefined) return { status: response.status, body };
  // Only the headers the step names: the rest (date, server, content-length)
  // differ between runtimes without meaning anything.
  const headers = Object.fromEntries(step.responseHeaders.map((name) => [name, response.headers.get(name)]));
  return { status: response.status, headers, body };
}

// The part of fetch() a step uses, over node:http, which sends the headers
// it is given and no others but `host` and `connection`. It sends a string
// body only; a chunked step uses fetch().
function httpFetch(url, { method = "GET", headers = {}, body, signal }) {
  if (body !== undefined && typeof body !== "string") {
    return Promise.reject(new Error("a step with a sec-fetch- header takes only a string body"));
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers, signal }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          for (const item of [value].flat()) responseHeaders.append(name, item);
        }
        resolve({ status: response.statusCode, headers: responseHeaders, text: async () => text });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

function webSocketStep(session, step) {
  const { origin } = session;
  if (step.raw) return rawWebSocketStep(session, step);
  const url = new URL(step.path, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, step.protocols);
    socket.binaryType = "arraybuffer";
    const frames = [];
    let done = false;
    const finish = (result, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };
    const timer = setTimeout(() => {
      const waiting = step.close === undefined ? "for the server to close" : `for ${step.receive} frames`;
      finish(null, new Error(`timed out waiting ${waiting}; received ${JSON.stringify(frames)}`));
    }, STEP_TIMEOUT_MS);
    const closeIfDone = () => {
      if (frames.length >= step.receive) socket.close(step.close ?? undefined);
    };
    let opened = false;
    socket.addEventListener("open", () => {
      opened = true;
      for (const frame of step.send) socket.send(frame);
      closeIfDone();
    });
    socket.addEventListener("message", (event) => {
      frames.push(typeof event.data === "string" ? event.data : { binary: Buffer.from(event.data).toString("base64") });
      closeIfDone();
    });
    // A refused upgrade is a broken step, not a close to record. Node's
    // WebSocket hides the response, so a `path` step to the same URL is the
    // way to see what the server answered.
    const refused = () => new Error("the server did not accept the WebSocket upgrade");
    socket.addEventListener("error", () => {
      if (!opened) finish(null, refused());
    });
    // Once open, a close the server starts before the frames the step waits
    // for is part of the transcript, not a runner failure: the diff shows it.
    socket.addEventListener("close", (event) => {
      if (!opened) finish(null, refused());
      else {
        const result = { frames, close: { code: event.code, reason: event.reason } };
        if (step.extensions) result.extensions = socket.extensions;
        finish(step.protocols === undefined ? result : { protocol: socket.protocol, ...result });
      }
    });
  });
}

// A `ws` step with "raw", "shutdown", "stall" or "record": a raw socket,
// because Node's WebSocket drops frames that arrive after its own Close,
// cannot shut down its side of the connection, and reads whatever arrives.
// After its Close the client keeps reading (and with "shutdown" sends FIN),
// and waits up to RAW_WAIT_MS for the server to end the connection. A Close
// the server sends first gets the same code back, as a client answers it.
// With "stall" the client reads nothing for that long once its frames are
// sent. The transcript records every frame (binary as
// `{"binary": "<base64>"}`; a fragment fails the step), or what "record"
// keeps of them, the server's Close (null without one), and whether the
// server ended the connection. With "reset" the client reads nothing after
// its Close and resets the connection later, and records only that.
const RAW_WAIT_MS = 3000;

function rawWebSocketStep(session, step) {
  const url = new URL(step.path, session.origin);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    const key = randomBytes(16).toString("base64");
    const frames = [];
    let reply = null;
    let upgraded = false;
    let closing = false;
    let head = Buffer.alloc(0);
    const reader = frameReader();
    let timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out waiting for ${step.receive} frames; received ${count}`));
    }, STEP_TIMEOUT_MS);
    let count = 0;
    let bytes = 0;
    const result = (ended) => {
      if (step.drop) return { ended };
      const received = step.record === "frames" ? { frames } : step.record === "count" ? { frames: { count, bytes } } : {};
      return { ...received, close: reply, ended };
    };
    const sendClose = (code) => {
      closing = true;
      socket.write(encodeFrame(CLOSE, closePayload(code), true));
      if (step.shutdown) socket.end();
      clearTimeout(timer);
      if (step.reset > 0) {
        socket.pause();
        timer = setTimeout(() => {
          socket.resetAndDestroy();
          resolve({ reset: true });
        }, step.reset);
        return;
      }
      timer = setTimeout(() => {
        socket.destroy();
        resolve(result(false));
      }, RAW_WAIT_MS);
    };
    const closeIfDone = () => {
      if (closing || count < step.receive) return;
      sendClose(step.close);
    };
    const onFrames = (chunk) => {
      for (const frame of reader.push(chunk)) {
        if (isFragment(frame)) {
          clearTimeout(timer);
          socket.destroy();
          return reject(new Error("the server sent a fragmented message, which the raw client does not reassemble"));
        }
        if (frame.opcode === TEXT || frame.opcode === BINARY) {
          count += 1;
          bytes += frame.payload.length;
          if (step.record === "frames") {
            frames.push(frame.opcode === TEXT ? frame.payload.toString() : { binary: frame.payload.toString("base64") });
          }
        } else if (frame.opcode === CLOSE && reply === null) {
          reply = readClose(frame.payload);
          if (!closing) sendClose(reply.code === 1005 ? null : reply.code);
        }
        // A client that shut down its side cannot answer a Ping any more.
        else if (frame.opcode === PING && !socket.writableEnded) socket.write(encodeFrame(PONG, frame.payload, true));
      }
      closeIfDone();
    };
    socket.on("connect", () => {
      // A "sockets" step counts the node's end of this connection.
      session.watch?.(socket.localPort);
      socket.write(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      // A dropping client reads nothing after its frames.
      if (upgraded && step.drop) return;
      if (upgraded) return onFrames(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      const status = head.subarray(0, head.indexOf("\r\n")).toString();
      if (!/^HTTP\/1\.1 101 /.test(status)) {
        clearTimeout(timer);
        socket.destroy();
        return reject(new Error("the server did not accept the WebSocket upgrade"));
      }
      upgraded = true;
      const frames = step.send.flatMap((frame) => Array.from({ length: step.repeat }, () => encodeFrame(TEXT, frame, true)));
      if (frames.length > 0) socket.write(Buffer.concat(frames));
      if (step.drop) {
        closing = true;
        socket.end();
        clearTimeout(timer);
        timer = setTimeout(() => {
          socket.destroy();
          resolve(result(false));
        }, RAW_WAIT_MS);
        return;
      }
      const rest = head.subarray(end + 4);
      if (step.stall > 0) {
        socket.pause();
        setTimeout(() => {
          onFrames(rest);
          socket.resume();
        }, step.stall);
      } else {
        onFrames(rest);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      if (!upgraded) return reject(new Error("the connection ended before the upgrade"));
      // A server may drop a peer that does not read, so a stalled client
      // records that end instead of failing.
      if (!closing && step.stall === 0) return reject(new Error(`the server ended the connection; received ${count} frames`));
      resolve(result(true));
    });
  });
}

function normalizeStrings(value, origin, rules) {
  if (typeof value === "string") {
    let text = value;
    // A deploy session has no origin.
    if (origin !== undefined) {
      const { host } = new URL(origin);
      text = text
        .replaceAll(origin, STABLE_ORIGIN)
        .replaceAll(`ws://${host}`, STABLE_ORIGIN.replace(/^http/, "ws"))
        .replaceAll(host, new URL(STABLE_ORIGIN).host);
    }
    for (const { regex, replace } of rules) text = text.replace(regex, replace);
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeStrings(item, origin, rules));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeStrings(item, origin, rules)]));
  }
  return value;
}
