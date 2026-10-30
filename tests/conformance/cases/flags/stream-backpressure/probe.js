// When a TransformStream's writes settle while nobody reads its readable
// side. fixup-transform-stream-backpressure makes an enqueue that fills the
// readable side's queue apply backpressure, so the next write waits for a
// read. encoder_stream_spec_compliant_backpressure gives TextEncoderStream
// and TextDecoderStream a readable side with a high water mark of 0, not 1,
// so that their first write waits for a read too.
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

async function trace(stream, chunks) {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const log = [];
  const state = () => `desired=${writer.desiredSize}`;
  await settle();
  log.push(`start ${state()}`);
  chunks.forEach((chunk, index) => {
    writer.write(chunk).then(() => log.push(`write ${index} settled`), (error) => log.push(`write ${index} failed: ${error}`));
  });
  await settle();
  log.push(`written ${state()}`);
  for (let read = 0; read < chunks.length; read++) {
    const { value } = await reader.read();
    log.push(`read ${typeof value === "string" ? value : new TextDecoder().decode(value)}`);
    await settle();
    log.push(`after read ${read} ${state()}`);
  }
  return log;
}

const identity = () => new TransformStream();
const doubling = () => new TransformStream({
  transform(chunk, controller) {
    controller.enqueue(chunk);
    controller.enqueue(chunk);
  },
});

export default {
  async fetch() {
    const bytes = (text) => new TextEncoder().encode(text);
    const reported = {
      transform: Cloudflare.compatibilityFlags["fixup-transform-stream-backpressure"] ?? null,
      encoder: Cloudflare.compatibilityFlags.encoder_stream_spec_compliant_backpressure ?? null,
    };
    // With backpressure fixed and a readable side whose high water mark is
    // 1, when a write runs depends on when a read that the queue satisfies
    // pulls, which streams/pull-after-queued-read covers.
    const queued = reported.transform && !reported.encoder;
    return Response.json({
      identity: await trace(identity(), ["a", "b", "c"]),
      doubling: await trace(doubling(), ["a", "b"]),
      encoder: queued ? null : await trace(new TextEncoderStream(), ["a", "b", "c"]),
      decoder: queued ? null : await trace(new TextDecoderStream(), [bytes("a"), bytes("b"), bytes("c")]),
      reported,
    });
  },
};
