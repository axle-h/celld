// send() and sendBatch() arguments that are not the dictionaries and
// sequences workerd's binding declares (api/queue.h): the conversion fails
// before the method runs, so the call rejects with JSG's TypeError.
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

export default {
  async fetch(request, env) {
    const q = env.QUEUE;
    const calls = {
      sendOptionsNumber: () => q.send("m", 5),
      sendOptionsString: () => q.send("m", "json"),
      sendOptionsNull: () => q.send("m", null),
      batchNumber: () => q.sendBatch(5),
      batchNull: () => q.sendBatch(null),
      batchEntryNumber: () => q.sendBatch([1]),
      batchEntryNull: () => q.sendBatch([{ body: "m" }, null]),
      batchOptionsNumber: () => q.sendBatch([{ body: "m" }], 5),
    };
    const out = {};
    for (const [name, call] of Object.entries(calls)) out[name] = await outcome(call);
    return Response.json(out);
  },
};
