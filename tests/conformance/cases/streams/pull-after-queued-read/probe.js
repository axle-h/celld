// When a ReadableStream pulls its source. workerd pulls on start, after an
// enqueue, and when a read finds the queue empty; a read that the queue
// satisfies does not pull, as the Streams Standard says it should while the
// queue is below its high water mark. So a stream whose high water mark is
// above 0 refills only once its queue is empty, and a TransformStream whose
// readable side has one (a TextEncoderStream before
// encoder_stream_spec_compliant_backpressure) runs its next write only then.
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

async function source() {
  const log = [];
  let next = 0;
  const stream = new ReadableStream({
    pull(controller) {
      log.push(`pull ${next}`);
      controller.enqueue(next++);
      if (next === 6) controller.close();
    },
  }, { highWaterMark: 2 });
  const reader = stream.getReader();
  await settle();
  log.push("started");
  for (let read = 0; read < 3; read++) {
    const { value } = await reader.read();
    log.push(`read ${value}`);
    await settle();
  }
  return log;
}

async function encoder() {
  const stream = new TextEncoderStream();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const log = [];
  ["a", "b", "c"].forEach((chunk, index) => {
    writer.write(chunk).then(() => log.push(`write ${index} settled`));
  });
  await settle();
  for (let read = 0; read < 3; read++) {
    const { value } = await reader.read();
    log.push(`read ${new TextDecoder().decode(value)}`);
    await settle();
  }
  return log;
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/encoder" && env.ENCODER) {
      return env.ENCODER.fetch(request);
    }
    return Response.json({ source: await source(), encoder: await encoder() });
  },
};
