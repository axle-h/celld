// structuredClone() of an object that only claims a Request's, a
// Response's or an AbortSignal's prototype: workerd's serializer finds no
// instance behind it and writes it as plain data.
const attempt = (fn) => {
  try {
    const copy = fn();
    return { plain: Object.getPrototypeOf(copy) === Object.prototype, keys: Object.keys(copy) };
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

export default {
  fetch() {
    const out = {};
    for (const [name, cls] of [["request", Request], ["response", Response], ["signal", AbortSignal]]) {
      out[name] = attempt(() => structuredClone(Object.create(cls.prototype)));
      out[`${name} with data`] = attempt(() =>
        structuredClone(Object.assign(Object.create(cls.prototype), { a: 1, b: "x" })));
    }
    out.realSignal = attempt(() => structuredClone(new AbortController().signal));
    return Response.json(out);
  },
};
