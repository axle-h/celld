// A Proxy as the default export: workerd reads its handlers through the
// trap while the Worker starts, in global scope, so I/O there is refused and
// eval() works as at module scope.
import { env } from "cloudflare:workers";

const outcomes = {};
const describe = (error) =>
  error.message.startsWith("Disallowed operation called within global scope.")
    ? `${error.constructor.name}: <global scope>`
    : `${error.constructor.name}: ${error.message}`;

const handlers = {
  fetch() {
    return Response.json(outcomes);
  },
};

let read = false;
export default new Proxy(handlers, {
  get(target, key, receiver) {
    if (key === "fetch" && !read) {
      read = true;
      try {
        const value = env.KV.put("proxy", "x");
        outcomes.kvPut = "pending";
        value.then(
          () => { outcomes.kvPut = "resolved"; },
          (error) => { outcomes.kvPut = `rejected ${describe(error)}`; });
      } catch (error) {
        outcomes.kvPut = `threw ${describe(error)}`;
      }
      try {
        outcomes.eval = eval("1 + 1");
      } catch (error) {
        outcomes.eval = `threw ${describe(error)}`;
      }
    }
    return Reflect.get(target, key, receiver);
  },
});
