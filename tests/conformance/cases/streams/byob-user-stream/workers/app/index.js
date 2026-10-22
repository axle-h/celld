import { checkAll, payload } from "#byob";

const attempt = (fn) => {
  try {
    const value = fn();
    return value?.constructor?.name ?? String(value);
  } catch (error) {
    return `${error?.name}: ${error?.message}`;
  }
};

// A default stream: no BYOB reader, on the stream, on a tee branch, or
// through the reader's constructor. A bad mode is refused before the stream
// type matters.
function refusals() {
  const make = () => new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(4)); },
  });
  const stream = make();
  return {
    byob: attempt(() => stream.getReader({ mode: "byob" })),
    locked: stream.locked,
    constructor: attempt(() => new ReadableStreamBYOBReader(make())),
    teeBranch: attempt(() => make().tee()[0].getReader({ mode: "byob" })),
    from: attempt(() =>
      ReadableStream.from([new Uint8Array(4)]).getReader({ mode: "byob" })),
    badMode: attempt(() => make().getReader({ mode: "nope" })),
    upperCase: attempt(() => make().getReader({ mode: "BYOB" })),
    defaultMode: attempt(() => make().getReader({ mode: undefined })),
  };
}

// A byte stream whose source fills the BYOB request when there is one, and
// enqueues 10 000-byte chunks otherwise.
function bytes() {
  const content = payload();
  let offset = 0;
  return new ReadableStream({
    type: "bytes",
    pull(controller) {
      if (offset >= content.byteLength) {
        controller.close();
        controller.byobRequest?.respond(0);
        return;
      }
      const request = controller.byobRequest;
      if (request !== null) {
        const n = Math.min(request.view.byteLength, content.byteLength - offset);
        request.view.set(content.subarray(offset, offset + n));
        offset += n;
        request.respond(n);
        return;
      }
      const end = Math.min(offset + 10_000, content.byteLength);
      controller.enqueue(content.slice(offset, end));
      offset = end;
    },
  });
}

export default {
  async fetch(request) {
    switch (new URL(request.url).pathname) {
      case "/refusals":
        return Response.json(refusals());
      case "/bytes":
        return Response.json(await checkAll(bytes));
      case "/badmode-bytes":
        return Response.json({
          badMode: attempt(() => bytes().getReader({ mode: "nope" })),
        });
    }
    return new Response("not found", { status: 404 });
  },
};
