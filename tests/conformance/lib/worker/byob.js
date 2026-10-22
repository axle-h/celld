// The BYOB reader checks the streams/byob-* cases share. A case's Worker
// imports this module as `#byob` (package.json "imports"), names a stream
// source, and answers each check with its transcript. Each check takes a fresh
// stream from `make()`.
//
// Chunk boundaries differ between runtimes, so no check records them: a check
// records the bytes it read (as a match against the expected content), the
// bounds every read kept, and how the reader behaved.

/** The content every source carries unless a case says otherwise. */
export const LENGTH = 100_000;

export function payload(length = LENGTH) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + (i >> 8)) & 255;
  return bytes;
}

/**
 * A default stream of the payload in 10 000-byte parts, one per pull: as a
 * body, it has no length and arrives in parts.
 */
export function parts() {
  const content = payload();
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= content.byteLength) return controller.close();
      const end = Math.min(offset + 10_000, content.byteLength);
      controller.enqueue(content.slice(offset, end));
      offset = end;
    },
  });
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

export const equal = (a, b) =>
  a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);

const bytesOf = (view) =>
  new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

const outcome = (promise) =>
  promise.then(
    (result) =>
      result === undefined
        ? "resolved"
        : {
            done: result.done,
            bytes: result.value === undefined ? null : result.value.byteLength,
          },
    (error) => ({ error: `${error?.name}: ${error?.message}` }),
  );

const failure = (error) => ({ error: `${error?.name}: ${error?.message}` });

/**
 * Reads `reader` to the end with fresh views from `view()`, checking each read
 * against `bound(value)`. Returns the bytes, whether every read kept the bound
 * and detached the view passed in, the view types the reads returned, and the
 * end read's view.
 */
async function drain(reader, view, bound) {
  const parts = [];
  let bounded = true;
  let detached = true;
  const types = new Set();
  for (;;) {
    const passed = view();
    const result = await reader.read(passed);
    if (passed.buffer.byteLength !== 0) detached = false;
    if (result.done) {
      return {
        bytes: concat(parts),
        bounded,
        detached,
        types: [...types].sort(),
        end: result.value === undefined ? null : {
          type: result.value.constructor.name,
          bytes: result.value.byteLength,
        },
      };
    }
    types.add(result.value.constructor.name);
    if (!bound(result.value)) bounded = false;
    parts.push(new Uint8Array(bytesOf(result.value)));
  }
}

const CHECKS = {
  // getReader({ mode: "byob" }) hands back a BYOB reader.
  async reader(stream) {
    const reader = stream.getReader({ mode: "byob" });
    const result = {
      byob: reader instanceof ReadableStreamBYOBReader,
      locked: stream.locked,
      readAtLeast: typeof reader.readAtLeast,
    };
    reader.releaseLock();
    await stream.cancel();
    return result;
  },

  // Views larger than a chunk: each read fills part of the view.
  async partial(stream, matches) {
    const reader = stream.getReader({ mode: "byob" });
    const out = await drain(
      reader,
      () => new Uint8Array(1 << 16),
      (value) => value.byteLength > 0 && value.byteLength <= 1 << 16 &&
        value.buffer.byteLength === 1 << 16,
    );
    return { ...out, bytes: await matches(out.bytes) };
  },

  // A view smaller than the chunk: the rest of the chunk waits for the next
  // read.
  async small(stream, matches) {
    const reader = stream.getReader({ mode: "byob" });
    const out = await drain(
      reader,
      () => new Uint8Array(7),
      (value) => value.byteLength > 0 && value.byteLength <= 7,
    );
    return { ...out, bytes: await matches(out.bytes) };
  },

  // A view at an offset into a larger buffer: the read writes only there.
  async offset(stream, matches) {
    const reader = stream.getReader({ mode: "byob" });
    let untouched = true;
    const out = await drain(
      reader,
      () => new Uint8Array(new ArrayBuffer(64), 16, 32),
      (value) => {
        const whole = new Uint8Array(value.buffer);
        if (value.byteOffset !== 16) untouched = false;
        if (whole.subarray(0, 16).some((b) => b !== 0)) untouched = false;
        if (whole.subarray(48).some((b) => b !== 0)) untouched = false;
        return value.byteLength > 0 && value.byteLength <= 32;
      },
    );
    return { ...out, untouched, bytes: await matches(out.bytes) };
  },

  // A multi-byte element view. A byte stream answers with whole elements of
  // the view's type; workerd's platform streams answer with a Uint8Array of
  // whatever bytes arrived.
  async elements(stream, matches) {
    const reader = stream.getReader({ mode: "byob" });
    const out = await drain(
      reader,
      () => new Uint32Array(3),
      (value) => value.length > 0 && value.length <= 3,
    );
    return { ...out, bytes: await matches(out.bytes) };
  },

  // readAtLeast(min, view): every read before the last holds at least `min`.
  async readAtLeast(stream, matches) {
    const reader = stream.getReader({ mode: "byob" });
    const reads = [];
    for (;;) {
      const result = await reader.readAtLeast(1000, new Uint8Array(4096));
      if (result.done) break;
      reads.push(new Uint8Array(result.value));
    }
    const short = reads.slice(0, -1).filter((r) => r.byteLength < 1000).length;
    const over = reads.filter((r) => r.byteLength > 4096).length;
    return { short, over, bytes: await matches(concat(reads)) };
  },

  // read(view, { min }), the standard spelling of readAtLeast.
  async readMin(stream, matches) {
    const reader = stream.getReader({ mode: "byob" });
    const reads = [];
    for (;;) {
      const result = await reader.read(new Uint8Array(4096), { min: 1000 });
      if (result.done) break;
      reads.push(new Uint8Array(result.value));
    }
    const short = reads.slice(0, -1).filter((r) => r.byteLength < 1000).length;
    return { short, bytes: await matches(concat(reads)) };
  },

  // Bad reads are refused without disturbing the stream.
  async refusals(stream, matches) {
    const reader = stream.getReader({ mode: "byob" });
    const empty = await outcome(reader.read(new Uint8Array(0)));
    const none = await outcome(reader.read());
    const tooMany = await outcome(reader.read(new Uint8Array(4), { min: 5 }));
    const out = await drain(reader, () => new Uint8Array(1 << 16), () => true);
    return { empty, none, tooMany, bytes: await matches(out.bytes) };
  },

  // Cancel with a read in flight: the read settles, later reads are done and
  // the reader's closed promise resolves.
  async cancel(stream) {
    const reader = stream.getReader({ mode: "byob" });
    const first = await reader.read(new Uint8Array(16));
    const inFlight = reader.read(new Uint8Array(1 << 16));
    const cancelled = await outcome(reader.cancel(new Error("stop")));
    const read = await inFlight.then(
      (result) => (result.done ? "done" : "value"),
      (error) => `${error?.name}: ${error?.message}`,
    );
    const after = await outcome(reader.read(new Uint8Array(16)));
    const closed = await outcome(reader.closed);
    return { first: first.value.byteLength > 0, cancelled, read, after, closed };
  },

  // releaseLock: the old reader refuses, the stream unlocks, and a new reader
  // (default, then BYOB again) continues where the first stopped.
  async releaseLock(stream, matches) {
    const byob = stream.getReader({ mode: "byob" });
    const head = await byob.read(new Uint8Array(7));
    byob.releaseLock();
    const released = {
      read: await outcome(byob.read(new Uint8Array(7))),
      closed: await outcome(byob.closed),
      locked: stream.locked,
    };
    const plain = stream.getReader();
    const middle = await plain.read();
    plain.releaseLock();
    const rest = await drain(
      stream.getReader({ mode: "byob" }),
      () => new Uint8Array(1 << 16),
      () => true,
    );
    const bytes = concat([
      bytesOf(head.value),
      middle.done ? new Uint8Array(0) : middle.value,
      rest.bytes,
    ]);
    const first = head.value.byteLength;
    return { head: first > 0 && first <= 7, released, bytes: await matches(bytes) };
  },

  // A second read while the first is in flight.
  async concurrent(stream, matches) {
    const reader = stream.getReader({ mode: "byob" });
    const first = reader.read(new Uint8Array(16));
    const second = reader.read(new Uint8Array(16));
    const [a, b] = [await outcome(first), await outcome(second)];
    const head = [];
    for (const r of [await first, await second.catch(() => null)])
      if (r !== null && !r.done) head.push(bytesOf(r.value));
    const rest = await drain(reader, () => new Uint8Array(1 << 16), () => true);
    return {
      first: a.error ?? a.done,
      second: b.error ?? b.done,
      bytes: await matches(concat([...head, rest.bytes])),
    };
  },

  // releaseLock() while a read is in flight, then once it has settled.
  async releasePending(stream, matches) {
    const reader = stream.getReader({ mode: "byob" });
    const pending = reader.read(new Uint8Array(16));
    let during;
    try {
      reader.releaseLock();
      during = "released";
    } catch (error) {
      during = `${error.name}: ${error.message}`;
    }
    const read = await pending.then(
      (result) => ({ done: result.done }),
      (error) => ({ error: `${error.name}: ${error.message}` }));
    reader.releaseLock();
    const locked = stream.locked;
    const rest = await drain(
      stream.getReader({ mode: "byob" }),
      () => new Uint8Array(1 << 16),
      () => true,
    );
    const head = read.done === false
      ? bytesOf((await pending).value)
      : new Uint8Array(0);
    return {
      during,
      read: read.error ?? read.done,
      locked,
      bytes: await matches(concat([head, rest.bytes])),
    };
  },

  // tee() after a BYOB read took part of a chunk: both branches start where
  // the read stopped.
  async teeAfterRead(stream, matches) {
    const reader = stream.getReader({ mode: "byob" });
    const head = await reader.read(new Uint8Array(7));
    reader.releaseLock();
    const [left, right] = stream.tee();
    const readAll = async (plain) => {
      const parts = [];
      for (;;) {
        const { done, value } = await plain.read();
        if (done) return concat(parts);
        parts.push(new Uint8Array(bytesOf(value)));
      }
    };
    // One branch with a BYOB reader, the other with a default reader.
    const [a, b] = await Promise.all([
      drain(left.getReader({ mode: "byob" }), () => new Uint8Array(1000),
            () => true),
      readAll(right.getReader()),
    ]);
    return {
      left: await matches(concat([bytesOf(head.value), a.bytes])),
      right: await matches(concat([bytesOf(head.value), b])),
    };
  },

  // tee(): both branches take BYOB readers and see every byte.
  async tee(stream, matches) {
    const [left, right] = stream.tee();
    const [a, b] = await Promise.all([
      drain(left.getReader({ mode: "byob" }), () => new Uint8Array(7),
            (v) => v.byteLength <= 7),
      drain(right.getReader({ mode: "byob" }), () => new Uint8Array(1 << 16),
            () => true),
    ]);
    return {
      locked: stream.locked,
      left: { bounded: a.bounded, bytes: await matches(a.bytes) },
      right: await matches(b.bytes),
    };
  },

  // A tee branch tees again, and one branch cancelled leaves the other whole.
  async teeCancel(stream, matches) {
    const [left, right] = stream.tee();
    await left.cancel(new Error("one side"));
    const [x, y] = right.tee();
    const [a, b] = await Promise.all([
      drain(x.getReader({ mode: "byob" }), () => new Uint8Array(1000),
            () => true),
      drain(y.getReader({ mode: "byob" }), () => new Uint8Array(1 << 16),
            () => true),
    ]);
    return { x: await matches(a.bytes), y: await matches(b.bytes) };
  },
};

export const CHECK_NAMES = Object.keys(CHECKS);

/**
 * Runs check `name` on the stream `make()` returns. `expected` is the content
 * as bytes, or a function that says whether bytes read are right (for a
 * source whose bytes differ between runtimes, such as compressed output).
 */
export async function check(name, make, expected = payload()) {
  const run = CHECKS[name];
  if (run === undefined) throw new Error(`no check named ${name}`);
  const matches = typeof expected === "function"
    ? async (bytes) => (await expected(bytes)) ? "match" : "mismatch"
    : (bytes) => equal(bytes, expected) ? "match" : `mismatch (${bytes.byteLength} bytes)`;
  try {
    return await run(await make(), matches);
  } catch (error) {
    return failure(error);
  }
}

/** Runs every check, as one transcript keyed by check name. */
export async function checkAll(make, expected, names = CHECK_NAMES) {
  const out = {};
  for (const name of names) out[name] = await check(name, make, expected);
  return out;
}
