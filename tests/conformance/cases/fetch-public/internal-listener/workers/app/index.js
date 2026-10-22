// The node's internal listener carries the unauthenticated operator routes,
// so no Worker reaches it, even though CELLD_FETCH_PRIVATE_ALLOW names it
// here: by its address, through a name, through the unspecified address, or
// over a WebSocket. The upstream entry beside it still works, so the
// allowlist itself is in force.
async function probe(url) {
  try {
    const response = await fetch(url);
    return { url, status: response.status, body: await response.text() };
  } catch (error) {
    return { url, error: error.name, message: error.message };
  }
}

function dial(url) {
  return new Promise((resolve) => {
    const events = [];
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => socket.close(1000));
    socket.addEventListener("error", (event) => {
      events.push({ type: "error", message: event.message, error: event.error?.name });
    });
    socket.addEventListener("close", (event) => {
      events.push({ type: "close", code: event.code });
      resolve({ url, events });
    });
  });
}

export default {
  async fetch(request) {
    const params = new URL(request.url).searchParams;
    const internal = params.get("internal");
    return Response.json([
      await probe(`http://127.0.0.1:${params.get("upstream")}/`),
      await probe(`http://127.0.0.1:${internal}/state`),
      await probe(`http://localhost:${internal}/state`),
      await probe(`http://[::ffff:127.0.0.1]:${internal}/state`),
      await probe(`http://0.0.0.0:${internal}/state`),
      await dial(`ws://127.0.0.1:${internal}/`),
    ]);
  },
};
