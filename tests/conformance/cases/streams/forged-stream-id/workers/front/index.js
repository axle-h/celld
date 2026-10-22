// front's own stream, claiming the id of back's body, which is still unread.
async function forged(env) {
  const held = await env.BACK.fetch("http://back/");
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("front's body"));
      controller.close();
    },
  });
  Object.defineProperty(stream, "__celldStreamId", {
    value: held.body.__celldStreamId ?? 1,
  });
  return { held, stream };
}

export default {
  async fetch(request, env) {
    const { held, stream } = await forged(env);
    // As the response body, and as a subrequest body back echoes.
    const response = new URL(request.url).pathname === "/response"
      ? new Response(stream)
      : await env.BACK.fetch("http://back/echo", { method: "POST", body: stream });
    await held.body.cancel();
    return response;
  },
};
