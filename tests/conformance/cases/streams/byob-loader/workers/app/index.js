import { checkAll } from "#byob";

// Serves the shared payload (byob.js's formula) as bytes at /bytes, and in
// 10 000-byte parts at /parts.
const SOURCE = `
const payload = () => {
  const bytes = new Uint8Array(100_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 8)) & 255;
  return bytes;
};
export default {
  fetch(request) {
    if (new URL(request.url).pathname === "/bytes") return new Response(payload());
    const content = payload();
    let offset = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (offset >= content.byteLength) return controller.close();
        const end = Math.min(offset + 10_000, content.byteLength);
        controller.enqueue(content.slice(offset, end));
        offset = end;
      },
    }));
  },
};
`;

export default {
  async fetch(request, env) {
    const worker = env.LOADER.get("byob", () => ({
      compatibilityDate: "2026-01-01",
      mainModule: "main.js",
      modules: { "main.js": SOURCE },
    }));
    const body = (path) => async () =>
      (await worker.getEntrypoint().fetch(`http://dynamic${path}`)).body;
    return Response.json({
      bytes: await checkAll(body("/bytes")),
      parts: await checkAll(body("/parts")),
    });
  },
};
