// A Dynamic Worker that throws a DOMException subclass at module scope.
// workerd reports the subclass constructor's frame, where V8 starts an Error
// subclass's stack below it: celld's DOMException is a JS class.
const handler = `export default { fetch() { return new Response("loaded"); } };`;
const source = `${handler}
class Mine extends DOMException { constructor() { super("sub", "DataError"); } }
throw new Mine();
`;

export default {
  async fetch(request, env) {
    try {
      const worker = env.LOADER.load({
        compatibilityDate: "2026-01-01",
        mainModule: "main.js",
        modules: { "main.js": source },
      });
      const response = await worker.getEntrypoint().fetch("http://child/");
      return Response.json({ status: response.status, body: await response.text() });
    } catch (error) {
      return Response.json({ error: error.name, message: error.message });
    }
  },
};
