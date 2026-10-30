// In a request workerd's code-generation callback (jsg/setup.c++
// modifyCodeGenCallback) refuses eval() of any value but undefined, a string
// or not, and lets `new Function()` with no arguments through, its source
// holding no code. celld turns code generation off on the context, which
// V8 checks for strings only and for every Function constructor: rusty_v8
// does not bind the callback.
const attempt = (call) => {
  try {
    const value = call();
    return value === undefined ? "undefined" : typeof value === "object" ? "object" : value;
  } catch (error) {
    return `${error.constructor.name}: ${error.message}`;
  }
};

class Callable extends Function {
  constructor() {
    super();
  }
}

export default {
  fetch() {
    return Response.json({
      number: attempt(() => globalThis.eval(5)),
      object: attempt(() => globalThis.eval({ a: 1 })),
      undefined: attempt(() => globalThis.eval(undefined)),
      none: attempt(() => globalThis.eval()),
      emptyFunction: attempt(() => typeof new Function()),
      emptyCall: attempt(() => typeof Function()),
      subclass: attempt(() => typeof new Callable()),
      emptyAsync: attempt(() => typeof new (async function () {}).constructor()),
    });
  },
};
