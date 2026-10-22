// A WebSocketPair's binaryType, and what a binary message arrives as, before
// and after the receiver sets binaryType to "arraybuffer".
const kind = (data) => Object.prototype.toString.call(data).slice(8, -1);

async function receive(socket, peer) {
  const message = new Promise((resolve) =>
    socket.addEventListener("message", (event) => resolve(event.data), { once: true }));
  peer.send(new Uint8Array([1, 2, 3]));
  const data = await message;
  const bytes = data instanceof Blob ? await data.arrayBuffer() : data;
  return { kind: kind(data), bytes: [...new Uint8Array(bytes)] };
}

export default {
  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    client.accept();
    const initial = server.binaryType;
    const first = await receive(server, client);
    server.binaryType = "arraybuffer";
    const second = await receive(server, client);
    return Response.json({
      initial,
      first,
      second,
      reported: Cloudflare.compatibilityFlags.websocket_standard_binary_type,
    });
  },
};
