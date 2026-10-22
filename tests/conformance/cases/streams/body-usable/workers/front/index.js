const attempt = async (fn) => {
  try {
    const value = await fn();
    return value instanceof Response ? `Response: ${await value.text()}` : "accepted";
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

const user = () => new ReadableStream({
  pull(controller) {
    controller.enqueue(new TextEncoder().encode("front's body"));
    controller.close();
  },
});

// Each source in each state: untouched, locked, a read in flight, read from
// and released, cancelled, and (for a platform stream) left holding part of
// a chunk by a BYOB read.
const SOURCES = {
  user,
  blob: () => new Blob(["front's body"]).stream(),
  fetched: async (env) => (await env.BACK.fetch("http://back/")).body,
};

const STATES = {
  untouched: async () => {},
  locked: async (stream) => { stream.getReader(); },
  reading: async (stream) => { stream.getReader().read(); },
  read: async (stream) => {
    const reader = stream.getReader();
    await reader.read();
    reader.releaseLock();
  },
  cancelled: async (stream) => { await stream.cancel(); },
  byobLeftover: async (stream) => {
    const reader = stream.getReader({ mode: "byob" });
    await reader.read(new Uint8Array(3));
    reader.releaseLock();
  },
};

export default {
  async fetch(request, env) {
    const out = {};
    for (const [source, make] of Object.entries(SOURCES)) {
      for (const [state, prepare] of Object.entries(STATES)) {
        if (source === "user" && state === "byobLeftover") continue;
        const row = {};
        let stream = await make(env);
        await prepare(stream);
        row.response = await attempt(() => new Response(stream));
        stream = await make(env);
        await prepare(stream);
        let sent;
        row.request = await attempt(() => {
          sent = new Request("http://back/echo", { method: "POST", body: stream });
        });
        stream = await make(env);
        await prepare(stream);
        row.text = await attempt(async () => {
          const text = await new Request("http://x/", { method: "POST", body: stream }).text();
          return new Response(text);
        });
        // celld refuses to send a fetched body on as a subrequest body ("the
        // body stream is not owned"), a separate gap, so that row stops here.
        if (sent !== undefined && !(source === "fetched" && state === "untouched"))
          row.fetch = await attempt(() => env.BACK.fetch(sent));
        out[`${source} ${state}`] = row;
      }
    }
    return Response.json(out);
  },
};
