export default {
  fetch(request) {
    let n = Number(new URL(request.url).searchParams.get("mb")) * 16;
    const chunk = new Uint8Array(64 * 1024).fill(120);
    return new Response(new ReadableStream({
      pull(controller) {
        if (n-- === 0) controller.close();
        else controller.enqueue(chunk.slice());
      },
    }));
  },
};
