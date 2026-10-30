// A gzip body that inflates a thousandfold (1 GiB of zeros in 1 MiB),
// returned by a Durable Object with `Content-Encoding: gzip` and decoded by
// the caller's fetch(), and the same bytes written to a DecompressionStream
// in one write: each is read in full, a bounded chunk at a time, and the
// node's memory grows by far less than what was decoded: under 256 MiB, a
// quarter of it, which leaves room for a loaded machine and still fails a
// decoder that inflates a write at once (one peaked at 2.1 GB).
import { DurableObject } from "cloudflare:workers";

const SIZE = 1024 * 1024 * 1024;
let bomb = null;
const makeBomb = async () => {
  if (bomb !== null) return bomb;
  const zeros = new Uint8Array(64 * 1024);
  let left = SIZE / zeros.length;
  const source = new ReadableStream({
    pull(controller) {
      if (left-- > 0) controller.enqueue(zeros);
      else controller.close();
    },
  });
  bomb = new Uint8Array(await new Response(source.pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  return bomb;
};

const drain = async (stream) => {
  const reader = stream.getReader();
  let bytes = 0;
  let largest = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    largest = Math.max(largest, value.byteLength);
  }
  return { bytes, boundedChunks: largest <= 1024 * 1024 };
};

export class Source extends DurableObject {
  async fetch(request) {
    const body = await makeBomb();
    if (new URL(request.url).pathname === "/prepare") return new Response("ready");
    return new Response(body, { headers: { "content-encoding": "gzip" }, encodeBody: "manual" });
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const stub = env.SOURCE.getByName("bomb");
    if (path === "/prepare") {
      await makeBomb();
      return stub.fetch("http://do/prepare");
    }
    if (path === "/fetch") {
      const response = await stub.fetch("http://do/bomb");
      return Response.json(await drain(response.body));
    }
    // /stream
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    const written = writer.write(await makeBomb()).then(() => writer.close());
    const result = await drain(ds.readable);
    await written;
    return Response.json(result);
  },
};
