// The Queue cell mints each message id from crypto.getRandomValues and each
// lease id from crypto.randomUUID. This script replaces both at module scope.
// The KV, Queue and D1 cells run in an isolate with no script's code (plan
// 1.49), so its messages still get random, distinct ids. When they ran in
// the first script's isolates, every id carried this script's zeros.
crypto.getRandomValues = (array) => array.fill(0);
crypto.randomUUID = () => "00000000-0000-4000-8000-000000000000";

const ZEROS = /-8000-000000000000$/;

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/patched") {
      // The script's own isolate has the replacements.
      return Response.json({
        bytes: [...crypto.getRandomValues(new Uint8Array(4))],
        uuid: crypto.randomUUID(),
      });
    }
    if (path !== "/send") return new Response("not found", { status: 404 });
    await env.JOBS.sendBatch([{ body: "a" }, { body: "b" }, { body: "c" }]);
    for (let attempt = 0; attempt < 200; attempt++) {
      const ids = await Promise.all(["a", "b", "c"].map((body) => env.KV.get(body)));
      if (ids.every((id) => id !== null)) {
        return Response.json({
          delivered: ids.length,
          random: ids.every((id) => !ZEROS.test(id)),
          distinct: new Set(ids).size,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return new Response("the messages were never delivered", { status: 500 });
  },

  async queue(batch, env) {
    for (const message of batch.messages) await env.KV.put(String(message.body), message.id);
  },
};
