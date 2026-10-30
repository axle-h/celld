// The Python Worker bundle starts its interpreter in the isolate's one
// startup window (`startInterpreter` from celld:python), where eval() and
// Wasm compilation are allowed as while workerd starts a Worker. Only the
// isolates of a Python Worker that `celld deploy` built from a `.py` main
// resolve celld:python: for a JavaScript Worker, with python_workers or
// without, the specifier names no module, so no script can open the window.
// What the window does once open is pinned by the unit tests in js.rs
// (`python_startup_tests`), which run on a Python Worker's configuration.
// Imported at run time: celld deploy bundles a JavaScript Worker without
// celld:python, which only the Python Worker build leaves external.
const host = () => import(["celld", "python"].join(":"));

const outcome = async () => {
  try {
    const { startInterpreter } = await host();
    return { value: await startInterpreter(async () => globalThis.eval("1")) };
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/python") return env.PYTHON.fetch(request);
    return Response.json({
      open: await outcome(),
      eval: (() => {
        try {
          return globalThis.eval("2");
        } catch (error) {
          return `${error.name}: ${error.message}`;
        }
      })(),
    });
  },
};
