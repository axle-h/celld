// The backlog a send() or sendBatch() reports. Miniflare's queue service
// counts the queue before the message it is sending; celld's counts it after
// (plan 1.64).
const shape = (metrics) => [metrics.backlogCount, metrics.backlogBytes, "oldestMessageTimestamp" in metrics];

export default {
  async fetch(request, env) {
    const first = await env.QUEUE.send("x");
    const second = await env.QUEUE.send("y");
    const batch = await env.QUEUE.sendBatch([{ body: "z" }]);
    const metrics = await env.QUEUE.metrics();
    return Response.json([first, second, batch].map((sent) => shape(sent.metadata.metrics)).concat([shape(metrics)]));
  },
  queue() {},
};
