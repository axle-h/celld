// Dynamic Workers that do I/O, or use randomness or a timer, or make a body
// or a stream, at module scope. workerd refuses each as a disallowed
// operation in global scope (an EventSource with its own error), which fails
// the Worker's start with the caller's frames. loader/global-scope-ops
// covers what each operation does when the module catches.
const handler = `export default { fetch() { return new Response("loaded"); } };`;

const children = {
  timer: `await new Promise((resolve) => setTimeout(resolve, 0));`,
  "scheduler-wait": `await scheduler.wait(0);`,
  random: `crypto.getRandomValues(new Uint8Array(1));`,
  "response-text": `await new Response("x").text();`,
  "transform-stream": `const { readable, writable } = new TransformStream();
const writer = writable.getWriter();
writer.write(new TextEncoder().encode("x"));
writer.close();
await new Response(readable).text();`,
  fetch: `await fetch("http://example.com/");`,
  "fetch-data-url": `await fetch("data:,x");`,
  interval: `setInterval(() => {}, 1000);`,
  "clear-timeout": `clearTimeout(1);`,
  "abort-signal-timeout": `AbortSignal.timeout(10);`,
  "random-uuid": `crypto.randomUUID();`,
  "generate-key": `await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"]);`,
  "generate-key-unawaited": `crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"]);`,
  "request-body": `new Request("http://example.com/", { method: "POST", body: "x" });`,
  "response-json": `Response.json({});`,
  "response-redirect": `Response.redirect("http://example.com/");`,
  "blob-stream": `new Blob(["x"]).stream();`,
  "compression-stream": `new CompressionStream("gzip");`,
  "fixed-length-stream": `new FixedLengthStream(1);`,
  "websocket-pair": `new WebSocketPair();`,
  "event-source": `new EventSource("http://example.com/");`,
  "rpc-stub": `import { RpcStub } from "cloudflare:workers";\nnew RpcStub({});`,
  "wait-until": `import { waitUntil } from "cloudflare:workers";\nwaitUntil(Promise.resolve());`,
  "set-immediate": { flags: ["nodejs_compat"], src: `setImmediate(() => {});` },
  "diagnostics-publish": {
    flags: ["nodejs_compat"],
    src: `import dc from "node:diagnostics_channel";\ndc.channel("x").publish(1);`,
  },
};

export default {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("child");
    if (!(name in children)) return new Response("unknown child", { status: 400 });
    try {
      const child = typeof children[name] === "string" ? { src: children[name] } : children[name];
      const worker = env.LOADER.load({
        compatibilityDate: "2026-01-01",
        compatibilityFlags: child.flags ?? [],
        mainModule: "main.js",
        modules: { "main.js": `${handler}\n${child.src}\n` },
      });
      const response = await worker.getEntrypoint().fetch("http://child/");
      return Response.json({ child: name, status: response.status, body: await response.text() });
    } catch (error) {
      return Response.json({ child: name, error: error.name, message: error.message });
    }
  },
};
