// Dynamic Workers that do I/O, or use randomness or a timer, at module
// scope. workerd refuses each as a disallowed operation in global scope,
// which fails the Worker's start.
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
};

export default {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("child");
    if (!(name in children)) return new Response("unknown child", { status: 400 });
    try {
      const worker = env.LOADER.load({
        compatibilityDate: "2026-01-01",
        mainModule: "main.js",
        modules: { "main.js": `${handler}\n${children[name]}\n` },
      });
      const response = await worker.getEntrypoint().fetch("http://child/");
      return Response.json({ child: name, status: response.status, body: await response.text() });
    } catch (error) {
      return Response.json({ child: name, error: error.name, message: error.message });
    }
  },
};
