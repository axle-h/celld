export default {
  async fetch(request) {
    // /echo answers with the request body it got.
    if (new URL(request.url).pathname === "/echo")
      return new Response(await request.text());
    return new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("back's body"));
        controller.close();
      },
    }));
  },
};
