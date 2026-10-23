const settle = (promise) => promise.then(
  (result) => result === undefined
    ? "resolved"
    : { done: result.done, bytes: result.value?.byteLength ?? null },
  (error) => `${error.name}: ${error.message}`);

// A pending timer, not a promise nothing settles, which workerd would cancel
// as a hung Worker.
const within = (promise, ms = 100) => Promise.race([
  settle(promise),
  new Promise((resolve) => setTimeout(() => resolve("waiting"), ms)),
]);

const attempt = (fn) => {
  try {
    fn();
    return "done";
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

// Each source makes a fresh stream. `waits` says a read on it stays pending
// until the stream is cancelled: the fetched body after its first chunk, an
// IdentityTransformStream nothing writes to, and a DecompressionStream given
// no input.
const SOURCES = {
  fetched: {
    waits: true,
    async make(env) {
      const body = (await env.BACK.fetch("http://back/stalled")).body;
      const reader = body.getReader();
      await reader.read();
      reader.releaseLock();
      return body;
    },
  },
  identity: { waits: true, make: async () => new IdentityTransformStream().readable },
  decompressed: { waits: true, make: async () => new DecompressionStream("gzip").readable },
  blob: { waits: false, make: async () => new Blob(["the blob's bytes"]).stream() },
};

const REASONS = {
  string: "stop",
  error: new RangeError("stop"),
  none: undefined,
};

// The checks a stream whose reads wait can take: what a later read, a
// cancel and a releaseLock do to the read in flight.
async function waiting(make) {
  const out = {};
  {
    const reader = (await make()).getReader();
    const first = reader.read();
    const second = settle(reader.read());
    out.second = { first: await within(first), second: await second };
    await reader.cancel();
  }
  for (const [name, reason] of Object.entries(REASONS)) {
    const reader = (await make()).getReader();
    const read = reader.read();
    const waited = await within(read, 20);
    const cancelled = await settle(reader.cancel(reason));
    out[`cancel ${name}`] = {
      waited,
      cancelled,
      read: await within(read),
      after: await within(reader.read()),
      closed: await within(reader.closed),
    };
  }
  {
    const stream = await make();
    const reader = stream.getReader();
    const read = reader.read();
    await within(read, 20);
    const released = attempt(() => reader.releaseLock());
    out.release = {
      released,
      read: await within(read),
      locked: stream.locked,
      closed: await within(reader.closed),
    };
    await reader.cancel().catch(() => {});
  }
  return out;
}

// The checks every stream can take, all in the turn the read is made, so
// the read is still in flight whatever the source.
async function sameTurn(make) {
  const out = {};
  {
    const reader = (await make()).getReader();
    const first = reader.read();
    const second = reader.read();
    out.second = { first: await within(first), second: await within(second) };
    await reader.cancel().catch(() => {});
  }
  {
    const reader = (await make()).getReader();
    const read = reader.read();
    const cancelled = reader.cancel("stop");
    out.cancel = {
      read: await within(read),
      cancelled: await within(cancelled),
      after: await within(reader.read()),
    };
  }
  {
    const stream = await make();
    const reader = stream.getReader();
    const read = reader.read();
    const released = attempt(() => reader.releaseLock());
    out.release = { released, read: await within(read), locked: stream.locked };
    if (stream.locked) await reader.cancel().catch(() => {});
    else await stream.cancel().catch(() => {});
  }
  {
    const stream = await make();
    const cancelled = await settle(stream.cancel("stop"));
    const reader = stream.getReader();
    out.cancelled = {
      cancelled,
      read: await within(reader.read()),
      closed: await within(reader.closed),
    };
  }
  return out;
}

// The reader is the standard ReadableStreamDefaultReader, from getReader()
// or from its constructor, and the constructor's has the same contract.
async function identity(make) {
  const stream = await make();
  const reader = stream.getReader();
  const out = {
    name: reader.constructor.name,
    constructor: reader.constructor === ReadableStreamDefaultReader,
    prototype: Object.getPrototypeOf(reader) === ReadableStreamDefaultReader.prototype,
    tag: Object.prototype.toString.call(reader),
  };
  reader.releaseLock();
  const constructed = new ReadableStreamDefaultReader(stream);
  const first = constructed.read();
  const second = settle(constructed.read());
  out.constructed = {
    prototype: Object.getPrototypeOf(constructed) === ReadableStreamDefaultReader.prototype,
    first: await within(first),
    second: await second,
  };
  const read = constructed.read();
  out.constructed.release = attempt(() => constructed.releaseLock());
  out.constructed.cancel = { cancelled: await within(constructed.cancel("stop")), read: await within(read) };
  return out;
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/reader") {
      const out = {};
      for (const [name, source] of Object.entries(SOURCES))
        out[name] = await identity(() => source.make(env));
      return Response.json(out);
    }
    if (new URL(request.url).pathname === "/request") {
      // The streamed request body, read once per check: each check takes
      // the next part of what is left.
      const body = request.body;
      const reader = body.getReader();
      const first = reader.read();
      const second = settle(reader.read());
      const out = { second: { first: (await first).done, second: await second } };
      const read = reader.read();
      out.release = { released: attempt(() => reader.releaseLock()), locked: body.locked };
      const cancelled = reader.cancel("stop");
      out.cancel = { read: await settle(read), cancelled: await settle(cancelled) };
      return Response.json(out);
    }
    const out = {};
    for (const [name, source] of Object.entries(SOURCES)) {
      const make = () => source.make(env);
      out[name] = { sameTurn: await sameTurn(make) };
      if (source.waits) out[name].waiting = await waiting(make);
    }
    return Response.json(out);
  },
};
