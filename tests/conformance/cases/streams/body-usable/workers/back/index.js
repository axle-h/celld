export default {
  async fetch(request) {
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
