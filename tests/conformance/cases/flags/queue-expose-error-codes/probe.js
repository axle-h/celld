// What a queue send the queue service refuses throws: with
// queue_expose_error_codes the service's cause and code; without it
// "Queue send failed: " or "Queue sendBatch failed: " and the HTTP status
// text. Miniflare's service sends no code, so workerd reads every refusal
// as "Unknown Internal Error (15000)" with the flag, where celld's sends
// Cloudflare's: flags/queue-error-codes covers those. The binding's own
// checks throw TypeErrors either way.
const attempt = async (call) => {
  try {
    await call();
    return "sent";
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

export default {
  async fetch(request, env) {
    const big = "x".repeat(128 * 1024 + 1);
    const reported = Cloudflare.compatibilityFlags.queue_expose_error_codes ?? null;
    const refused = reported ? {} : {
      large: await attempt(() => env.QUEUE.send(big, { contentType: "text" })),
      batchCount: await attempt(() => env.QUEUE.sendBatch(Array.from({ length: 101 }, () => ({ body: "x" })))),
      batchLarge: await attempt(() => env.QUEUE.sendBatch([{ body: big, contentType: "text" }])),
      // The count is checked first.
      both: await attempt(() => env.QUEUE.sendBatch(Array.from({ length: 101 }, () => ({ body: big, contentType: "text" })))),
    };
    const bytes = new Uint8Array([1, 2]);
    return Response.json({
      ...refused,
      contentType: await attempt(() => env.QUEUE.send("x", { contentType: "nope" })),
      upperCase: await attempt(() => env.QUEUE.send("x", { contentType: "TEXT" })),
      textType: await attempt(() => env.QUEUE.send(1, { contentType: "text" })),
      bytesType: await attempt(() => env.QUEUE.send(new ArrayBuffer(1), { contentType: "bytes" })),
      bytes: [await attempt(() => env.QUEUE.send(bytes, { contentType: "bytes" })), bytes.byteLength],
      undefinedBody: await attempt(() => env.QUEUE.send(undefined)),
      batchUndefined: await attempt(() => env.QUEUE.sendBatch([{ body: "x" }, {}])),
      batchEmpty: await attempt(() => env.QUEUE.sendBatch([])),
      batchUpperCase: await attempt(() => env.QUEUE.sendBatch([{ body: "x", contentType: "TEXT" }])),
      ok: await attempt(() => env.QUEUE.send("x")),
      reported,
    });
  },
};
