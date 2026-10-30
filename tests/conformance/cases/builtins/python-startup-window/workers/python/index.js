// See plain/index.js: python_workers does not make a JavaScript Worker the
// Python Worker bundle, so celld:python is not a module here either.
const host = () => import(["celld", "python"].join(":"));

export default {
  async fetch() {
    try {
      const { startInterpreter } = await host();
      return Response.json({ open: { value: await startInterpreter(async () => globalThis.eval("1")) } });
    } catch (error) {
      return Response.json({ open: `${error.name}: ${error.message}` });
    }
  },
};
