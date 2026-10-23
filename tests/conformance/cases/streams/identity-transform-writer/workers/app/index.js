const settle = (promise) => promise.then(
  () => "resolved",
  (error) => `${error.name}: ${error.message}`);

const within = (promise, ms = 100) => Promise.race([
  settle(promise),
  new Promise((resolve) => setTimeout(() => resolve("waiting"), ms)),
]);

export default {
  async fetch() {
    const out = {};
    {
      // No read and no write in flight.
      const { readable, writable } = new IdentityTransformStream();
      const writer = writable.getWriter();
      await readable.cancel("stop");
      out.idle = {
        write: await within(writer.write(new Uint8Array(1))),
        closed: await within(writer.closed),
      };
    }
    {
      // A read in flight.
      const { readable, writable } = new IdentityTransformStream();
      const writer = writable.getWriter();
      const reader = readable.getReader();
      const read = reader.read();
      await reader.cancel("stop");
      out.reading = {
        read: await within(read),
        write: await within(writer.write(new Uint8Array(1))),
        closed: await within(writer.closed),
      };
    }
    {
      // A write in flight, then another write, and a close.
      const { readable, writable } = new IdentityTransformStream();
      const writer = writable.getWriter();
      const written = writer.write(new Uint8Array(4));
      await readable.cancel("stop");
      out.writing = {
        write: await within(written),
        next: await within(writer.write(new Uint8Array(1))),
        close: await within(writer.close()),
        closed: await within(writer.closed),
      };
    }
    return Response.json(out);
  },
};
