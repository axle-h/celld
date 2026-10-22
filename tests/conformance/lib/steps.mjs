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
    case "otlp":
      return `otlp ${step.spans.join(", ")}`;
    case "deploy":
      return `deploy ${[step.worker, ...step.args].join(" ")}`;
  }
}

async function runStep(session, step) {
  switch (step.kind) {
    case "path":
      return fetchStep(session.origin, step);
    case "ws":
      return webSocketStep(session.origin, step);
    case "restart":
      await session.restart();
      return { restart: true };
    case "otlp":
      return { otlp: await session.otlp.take(step.spans, STEP_TIMEOUT_MS) };
    case "deploy":
      return session.deploy(step, STEP_TIMEOUT_MS);
  }
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

function webSocketStep(origin, step) {
  if (step.raw) return rawWebSocketStep(origin, step);
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
        finish(step.protocols === undefined ? result : { protocol: socket.protocol, ...result });
      }
    });
  });
}

// A `ws` step with "raw" or "shutdown": a raw socket, because Node's
// WebSocket drops frames that arrive after its own Close and cannot shut
// down its side of the connection. After its Close the client keeps reading
// (and with "shutdown" sends FIN), and waits up to RAW_WAIT_MS for the server
// to end the connection. The transcript records every frame (binary as
// `{"binary": "<base64>"}`; a fragment fails the step), the server's Close
// (null without one), and whether the server ended the connection.
const RAW_WAIT_MS = 3000;

function rawWebSocketStep(origin, step) {
  const url = new URL(step.path, origin);
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
      reject(new Error(`timed out waiting for ${step.receive} frames; received ${JSON.stringify(frames)}`));
    }, STEP_TIMEOUT_MS);
    const closeIfDone = () => {
      if (closing || frames.length < step.receive) return;
      closing = true;
      socket.write(encodeFrame(CLOSE, closePayload(step.close), true));
      if (step.shutdown) socket.end();
      clearTimeout(timer);
      timer = setTimeout(() => {
        socket.destroy();
        resolve({ frames, close: reply, ended: false });
      }, RAW_WAIT_MS);
    };
    const onFrames = (chunk) => {
      for (const frame of reader.push(chunk)) {
        if (isFragment(frame)) {
          clearTimeout(timer);
          socket.destroy();
          return reject(new Error("the server sent a fragmented message, which the raw client does not reassemble"));
        }
        if (frame.opcode === TEXT) frames.push(frame.payload.toString());
        else if (frame.opcode === BINARY) frames.push({ binary: frame.payload.toString("base64") });
        else if (frame.opcode === CLOSE && reply === null) reply = readClose(frame.payload);
        else if (frame.opcode === PING) socket.write(encodeFrame(PONG, frame.payload, true));
      }
      closeIfDone();
    };
    socket.on("connect", () => {
      socket.write(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
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
      for (const frame of step.send) socket.write(encodeFrame(TEXT, frame, true));
      onFrames(head.subarray(end + 4));
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      if (!upgraded) return reject(new Error("the connection ended before the upgrade"));
      if (!closing) return reject(new Error(`the server ended the connection; received ${JSON.stringify(frames)}`));
      resolve({ frames, close: reply, ended: true });
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
