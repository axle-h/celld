// Runs a case's steps against a started runtime and returns the transcript:
// one entry per step, in the shape expect.json stores.

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
  }
}

async function fetchStep(origin, step) {
  const response = await fetch(new URL(step.path, origin), {
    method: step.method,
    headers: step.headers,
    body: step.body,
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

function webSocketStep(origin, step) {
  const url = new URL(step.path, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
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
      if (frames.length >= step.receive) socket.close(step.close);
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
      else finish({ frames, close: { code: event.code, reason: event.reason } });
    });
  });
}

function normalizeStrings(value, origin, rules) {
  if (typeof value === "string") {
    const { host } = new URL(origin);
    let text = value
      .replaceAll(origin, STABLE_ORIGIN)
      .replaceAll(`ws://${host}`, STABLE_ORIGIN.replace(/^http/, "ws"))
      .replaceAll(host, new URL(STABLE_ORIGIN).host);
    for (const { regex, replace } of rules) text = text.replace(regex, replace);
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeStrings(item, origin, rules));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeStrings(item, origin, rules)]));
  }
  return value;
}
