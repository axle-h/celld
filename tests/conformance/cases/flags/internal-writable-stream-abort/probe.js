// internal_writable_stream_abort_clears_queue: aborting the writable side of
// an internal stream (IdentityTransformStream, FixedLengthStream) with writes
// queued rejects them and errors the stream at once with the flag; without
// it the abort waits until the write in flight is read, which then
// completes.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function trace(make, reason) {
  const log = [];
  const { writable, readable } = make();
  const writer = writable.getWriter();
  const note = (name, promise) => promise.then(
    () => log.push(`${name} resolved`),
    (error) => log.push(`${name} rejected ${error}`));
  note("w1", writer.write(new Uint8Array([1])));
  note("w2", writer.write(new Uint8Array([2])));
  await settle();
  note("abort", writer.abort(reason));
  await settle();
  log.push("after abort");
  note("closed", writer.closed);
  await settle();
  // When the read settles against the writes depends on how each runtime
  // moves the bytes, so it is recorded apart.
  const read = await readable.getReader().read().then(
    (result) => result.done ? "done" : result.value.join(),
    (error) => `rejected ${error}`);
  await settle();
  return { log, read };
}

export default {
  async fetch() {
    return Response.json({
      identity: await trace(() => new IdentityTransformStream(), new Error("why")),
      fixed: await trace(() => new FixedLengthStream(10), new TypeError("why")),
      empty: await (async () => {
        const { writable } = new IdentityTransformStream();
        const writer = writable.getWriter();
        return writer.abort(new Error("why")).then(() => "resolved", (error) => `rejected ${error}`);
      })(),
      reported: Cloudflare.compatibilityFlags.internal_writable_stream_abort_clears_queue ?? null,
    });
  },
};
