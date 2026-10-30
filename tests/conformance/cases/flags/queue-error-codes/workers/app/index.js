// The cause and code of each refusal of celld's queue service, which
// queue_expose_error_codes shows: Cloudflare's documented ones.
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
    const big = "x".repeat(128_001);
    const part = "x".repeat(100_000);
    return Response.json({
      large: await attempt(() => env.QUEUE.send(big, { contentType: "text" })),
      batchCount: await attempt(() => env.QUEUE.sendBatch(Array.from({ length: 101 }, () => ({ body: "x" })))),
      batchLarge: await attempt(() => env.QUEUE.sendBatch([{ body: big, contentType: "text" }])),
      batchTotal: await attempt(() => env.QUEUE.sendBatch([part, part, part].map((body) => ({ body, contentType: "text" })))),
    });
  },
  queue() {},
};
