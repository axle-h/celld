export default {
  fetch() {
    let sent = false;
    return new Response(new ReadableStream({
      pull(controller) {
        if (sent) return new Promise(() => {});
        sent = true;
        controller.enqueue(new TextEncoder().encode("first"));
      },
    }));
  },
};
