// An outbound WebSocket to an address the policy refuses never connects:
// `new WebSocket()` reports the refusal as an error event and a 1006 close,
// and fetch() with `Upgrade: websocket` rejects with it. The runner's upstream
// server is listening on the port, so a refusal is the policy and not a
// closed port.
function dial(url) {
  return new Promise((resolve) => {
    const events = [];
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      events.push({ type: "open" });
      socket.close(1000);
    });
    socket.addEventListener("error", (event) => {
      events.push({ type: "error", message: event.message, error: event.error?.name });
    });
    socket.addEventListener("close", (event) => {
      events.push({ type: "close", code: event.code });
      resolve({ url, events });
    });
  });
}

async function upgrade(url) {
  try {
    const response = await fetch(url, { headers: { upgrade: "websocket" } });
    return { url, status: response.status };
  } catch (error) {
    return { url, error: error.name, message: error.message };
  }
}

export default {
  async fetch(request) {
    const port = new URL(request.url).searchParams.get("port");
    return Response.json({
      literal: await dial(`ws://127.0.0.1:${port}/`),
      name: await dial(`ws://localhost:${port}/`),
      upgrade: await upgrade(`http://127.0.0.1:${port}/`),
    });
  },
};
