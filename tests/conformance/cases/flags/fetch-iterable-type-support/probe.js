// What a Request or Response makes of an iterable body. With
// fetch_iterable_type_support a sync or async iterable is read as a stream of
// its values; with fetch_iterable_type_support_override_adjustment too, a
// sync iterable that is not an Array but has its own toString or
// Symbol.toPrimitive is stringified instead. Without them every such object
// is stringified.
const bytes = (text) => new TextEncoder().encode(text);

const BODIES = {
  arrayOfViews: () => [bytes("ab"), bytes("cd").buffer],
  emptyArray: () => [],
  arrayOfStrings: () => ["a", "b"],
  arrayOfNumbers: () => [1, 2],
  set: () => new Set([bytes("set")]),
  map: () => new Map([["k", "v"]]),
  generator: () => (function* () { yield bytes("gen"); yield bytes("erator"); })(),
  asyncGenerator: () => (async function* () { yield bytes("async"); })(),
  asyncIterable: () => ({
    [Symbol.asyncIterator]() {
      let done = false;
      return { next: async () => done ? { done: true } : (done = true, { value: bytes("it"), done: false }) };
    },
  }),
  promises: () => (function* () { yield Promise.resolve(bytes("promised")); })(),
  customToString: () => ({
    *[Symbol.iterator]() { yield bytes("iterated"); },
    toString() { return "stringified"; },
  }),
  customToPrimitive: () => ({
    *[Symbol.iterator]() { yield bytes("iterated"); },
    [Symbol.toPrimitive]() { return "primitive"; },
  }),
  arrayWithToString: () => Object.assign([bytes("array")], { toString() { return "stringified"; } }),
  toStringOnly: () => ({ toString() { return "plain"; } }),
  stringObject: () => new String("boxed"),
  throwingIterator: () => ({ [Symbol.iterator]() { throw new Error("no iterator"); } }),
  throwsMidway: () => (function* () { yield bytes("a"); throw new Error("midway"); })(),
};

const describe = (error) => `${error.name}: ${error.message}`;

async function outcome(make) {
  let body;
  try {
    body = make();
  } catch (error) {
    return { constructed: describe(error) };
  }
  try {
    return { text: await body.text() };
  } catch (error) {
    return { read: describe(error) };
  }
}

export default {
  async fetch(request) {
    // A served body of an ArrayBuffer and of a view whose elements are wider
    // than a byte: each crosses as its bytes.
    if (new URL(request.url).pathname === "/served") {
      return new Response([bytes("ab").buffer, new Uint16Array([0x6463])]);
    }
    const results = {};
    for (const [name, make] of Object.entries(BODIES)) {
      results[name] = {
        response: await outcome(() => new Response(make())),
        request: await outcome(() => new Request("http://x/", { method: "POST", body: make() })),
      };
    }
    let iteratorCalls = 0;
    const counted = { [Symbol.iterator]() { iteratorCalls++; return [bytes("x")][Symbol.iterator](); } };
    new Response(counted);
    return Response.json({
      results,
      iteratorCalls,
      reported: {
        support: Cloudflare.compatibilityFlags.fetch_iterable_type_support ?? null,
        adjustment: Cloudflare.compatibilityFlags.fetch_iterable_type_support_override_adjustment ?? null,
      },
    });
  },
};
