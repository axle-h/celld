// `bytes()` on a Response and a Request: a Uint8Array of the body, which
// then counts as used, as `arrayBuffer()` does. Only a streamed body is read
// twice: a buffered one reads again on celld (plan 1.43).
async function read(body, twice = false) {
  const first = await body.bytes();
  let again;
  if (twice) {
    try {
      await body.bytes();
      again = "read";
    } catch (error) {
      again = `${error.name}: ${error.message}`;
    }
  }
  return {
    type: Object.prototype.toString.call(first),
    bytes: Array.from(first),
    offset: first.byteOffset,
    bufferLength: first.buffer.byteLength,
    bodyUsed: body.bodyUsed,
    again,
  };
}

export default {
  async fetch(request) {
    const describe = (proto) => ({
      type: typeof proto.bytes,
      length: proto.bytes.length,
      name: proto.bytes.name,
      sameAsArrayBuffersOwner:
        Object.hasOwn(proto, "bytes") === Object.hasOwn(proto, "arrayBuffer"),
    });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    return Response.json({
      responseMethod: describe(Response.prototype),
      requestMethod: describe(Request.prototype),
      text: await read(new Response("héllo")),
      stream: await read(new Response(stream), true),
      empty: await read(new Response(null)),
      request: await read(new Request("http://x/", { method: "POST", body: "req" })),
      received: await read(request),
    });
  },
};
