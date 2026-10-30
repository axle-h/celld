// A JSON body is serialized as workerd's binding does it (api/queue.c++
// `serialize`, jsg JsValue::toJson): V8's JSON.stringify, whose own errors
// reject the send as they are, and whose undefined result (a function, a
// Symbol) is sent as the text "undefined". JSON is the default content type
// at this date (queues_json_messages).
const outcome = (call) => {
  let promise;
  try {
    promise = call();
  } catch (error) {
    return Promise.resolve(`threw ${error.constructor.name}: ${error.message}`);
  }
  return promise.then(
    () => "sent",
    (error) => `rejected ${error.constructor.name}: ${error.message}`);
};

class Throws {
  toJSON() {
    throw new RangeError("from toJSON");
  }
}

export default {
  async fetch(request, env) {
    const cyclic = {};
    cyclic.self = cyclic;
    const bodies = {
      bigint: 1n,
      nested: { value: [2n] },
      cyclic,
      toJSON: new Throws(),
      function: () => 1,
      symbol: Symbol("x"),
      plain: { a: 1 },
    };
    const out = {};
    for (const [name, body] of Object.entries(bodies)) {
      out[name] = {
        json: await outcome(() => env.QUEUE.send(body, { contentType: "json" })),
        default: await outcome(() => env.QUEUE.send(body)),
        batch: await outcome(() => env.QUEUE.sendBatch([{ body: "x" }, { body, contentType: "json" }])),
        batchDefault: await outcome(() => env.QUEUE.sendBatch([{ body }])),
      };
    }
    return Response.json(out);
  },
};
