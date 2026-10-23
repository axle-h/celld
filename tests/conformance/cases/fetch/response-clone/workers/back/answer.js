// The bodies back and front's Durable Object answer with.
const encoder = new TextEncoder();

// A body in three chunks, each sent after a turn of the event loop.
const chunks = () => {
  const parts = ["one,", "two,", "three"];
  return new ReadableStream({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const part = parts.shift();
      if (part === undefined) controller.close();
      else controller.enqueue(encoder.encode(part));
    },
  });
};

// `n` chunks of 64 KiB.
const big = (n) => {
  const chunk = new Uint8Array(64 * 1024).fill(120);
  return new ReadableStream({
    pull(controller) {
      if (n-- === 0) controller.close();
      else controller.enqueue(chunk.slice());
    },
  });
};

export const answer = (request) => {
  const url = new URL(request.url);
  switch (url.pathname) {
    case "/body":
      return new Response(chunks(), {
        status: 201,
        headers: { "x-from": "back", "content-type": "text/plain" },
      });
    case "/ok":
      return new Response(chunks(), { headers: { "x-from": "back" } });
    case "/bytes":
      return new Response("fixed bytes", {
        headers: { "x-from": "back", "content-type": "text/plain;charset=UTF-8" },
      });
    case "/redirect":
      return new Response(null, { status: 302, headers: { location: "/ok?landed" } });
    case "/big":
      return new Response(big(Number(url.searchParams.get("n"))));
    case "/ws": {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      return new Response(null, { status: 101, webSocket: client });
    }
  }
  return new Response("not found", { status: 404 });
};

