import { checkAll, payload } from "#byob";

// The payload written in 10 000-byte parts, each write waiting for the
// readable to take it. A write that fails ends the writing.
function written(parts = [payload()]) {
  const { readable, writable } = new IdentityTransformStream();
  const writer = writable.getWriter();
  (async () => {
    for (const part of parts)
      for (let offset = 0; offset < part.byteLength; offset += 10_000)
        await writer.write(part.slice(offset, offset + 10_000));
    await writer.close();
  })().catch(() => {});
  return readable;
}

const settle = (promise) => promise.then(
  (result) => result === undefined ? "resolved" : {
    done: result.done,
    type: result.value?.constructor.name ?? null,
    bytes: result.value?.byteLength ?? null,
  },
  (error) => `${error.name}: ${error.message}`);

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

// One read with each kind of view on 8 written bytes (5 for `oddBytes`), and
// the read after the end.
const VIEWS = {
  Uint8Array: () => new Uint8Array(8),
  Int8Array: () => new Int8Array(8),
  Uint16Array: () => new Uint16Array(4),
  Uint32Array: () => new Uint32Array(2),
  Float64Array: () => new Float64Array(1),
  DataView: () => new DataView(new ArrayBuffer(8)),
  oddBytes: () => new Uint16Array(4),
};

async function views() {
  const out = {};
  for (const [name, view] of Object.entries(VIEWS)) {
    const reader = written([payload(name === "oddBytes" ? 5 : 8)])
      .getReader({ mode: "byob" });
    out[name] = {
      read: await settle(reader.read(view())),
      end: await settle(reader.read(view())),
    };
  }
  // readAtLeast counts elements of the view: 2 of a Uint16Array is 4 bytes,
  // more than the first 3-byte write holds.
  const reader = written([payload(3), payload(3)]).getReader({ mode: "byob" });
  out.readAtLeast = await settle(reader.readAtLeast(2, new Uint16Array(4)));
  // A tee() branch takes a BYOB reader.
  const [left, right] = written().tee();
  out.tee = {
    left: attempt(() => left.getReader({ mode: "byob" })),
    right: attempt(() => right.getReader({ mode: "byob" })),
  };
  return out;
}

// releaseLock() with a read in flight, for each kind of reader, and once the
// read has settled.
async function release() {
  const out = {};
  for (const mode of ["default", "byob"]) {
    const { readable, writable } = new IdentityTransformStream();
    const reader = mode === "byob"
      ? readable.getReader({ mode: "byob" })
      : readable.getReader();
    const read = mode === "byob" ? reader.read(new Uint8Array(8)) : reader.read();
    const released = attempt(() => reader.releaseLock());
    const pending = {
      released,
      read: await within(read),
      locked: readable.locked,
      closed: await within(reader.closed),
    };
    const writer = writable.getWriter();
    writer.write(payload(4)).catch(() => {});
    pending.written = await within(read);
    pending.after = attempt(() => reader.releaseLock());
    pending.unlocked = !readable.locked;
    out[mode] = pending;
  }
  // With written bytes waiting: a read still settles on a later turn, so a
  // second read, a releaseLock() and a cancel in the read's turn each meet it
  // in flight.
  for (const mode of ["default", "byob"]) {
    const make = () => {
      const readable = written([payload(8)]);
      const reader = mode === "byob"
        ? readable.getReader({ mode: "byob" })
        : readable.getReader();
      const read = () => mode === "byob" ? reader.read(new Uint8Array(4)) : reader.read();
      return { readable, reader, read };
    };
    const row = {};
    {
      const { reader, read } = make();
      // Let the first write arrive.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const first = read();
      const second = read();
      row.second = { first: await settle(first), second: await settle(second) };
    }
    {
      const { readable, reader, read } = make();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const first = read();
      row.release = { released: attempt(() => reader.releaseLock()), read: await settle(first), locked: readable.locked };
    }
    {
      const { reader, read } = make();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const first = read();
      const cancelled = reader.cancel("stop");
      row.cancel = { read: await settle(first), cancelled: await settle(cancelled) };
    }
    out[`${mode} written`] = row;
  }
  return out;
}

export default {
  async fetch(request) {
    switch (new URL(request.url).pathname) {
      case "/checks":
        return Response.json(await checkAll(async () => written()));
      case "/views":
        return Response.json(await views());
      case "/release":
        return Response.json(await release());
    }
    return new Response("not found", { status: 404 });
  },
};
