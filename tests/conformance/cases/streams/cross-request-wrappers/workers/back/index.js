import { parts, payload } from "#byob";

// 16 bytes, then a pull that waits two seconds for the next 16 (a pending
// timer, not a promise nothing settles, which workerd would cancel as a hung
// Worker). The reader cancels before then.
function stalled() {
  let sent = 0;
  let timer;
  return new ReadableStream({
    async pull(controller) {
      if (sent++ > 0)
        await new Promise((resolve) => { timer = setTimeout(resolve, 2000); });
      if (sent > 2) return controller.close();
      controller.enqueue(payload(16));
    },
    cancel() { clearTimeout(timer); },
  });
}

export default {
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/parts") return new Response(parts());
    if (path === "/stalled") return new Response(stalled());
    return new Response("not found", { status: 404 });
  },
};
