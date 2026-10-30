// I/O at module scope through R2, Queues, D1 and the Cache API, and in a
// getter on the default export, which workerd reads while the Worker starts,
// still in global scope and with eval() as module scope has it. Each refusal
// is workerd's global-scope error, thrown or rejected as its method does,
// and comes after the conversions workerd makes before it asks for the
// request and before the method's other checks of its arguments. Resuming a
// multipart upload starts no I/O, so it answers a handle. `/state` shows
// that nothing refused was written.
import { env } from "cloudflare:workers";

const outcomes = {};
const describe = (error) =>
  error.message.startsWith("Disallowed operation called within global scope.")
    ? `${error.constructor.name}: <global scope>`
    : `${error.constructor.name}: ${error.message}`;
const attempt = (name, call) => {
  try {
    const value = call();
    if (value instanceof Promise) {
      outcomes[name] = "pending";
      value.then(
        () => { outcomes[name] = "resolved"; },
        (error) => { outcomes[name] = `rejected ${describe(error)}`; });
    } else {
      outcomes[name] = typeof value;
    }
  } catch (error) {
    outcomes[name] = `threw ${describe(error)}`;
  }
};

attempt("queueSend", () => env.Q.send("m"));
attempt("queueSendUndefined", () => env.Q.send(undefined));
attempt("queueSendBadType", () => env.Q.send("m", { contentType: "bogus" }));
attempt("queueSendBatch", () => env.Q.sendBatch([{ body: "m" }]));
attempt("queueSendBatchEmpty", () => env.Q.sendBatch([]));
attempt("queueSendBadOptions", () => env.Q.send("m", 5));
attempt("queueSendBatchBadEntry", () => env.Q.sendBatch([1]));
attempt("r2Put", () => env.R2.put("k", "v"));
attempt("r2Get", () => env.R2.get("k"));
attempt("r2Head", () => env.R2.head("k"));
attempt("r2List", () => env.R2.list());
attempt("r2Delete", () => env.R2.delete("k"));
attempt("r2CreateMultipart", () => env.R2.createMultipartUpload("k"));
attempt("r2ResumeMultipart", () => env.R2.resumeMultipartUpload("k", "id"));
attempt("r2ResumedAbort", () => env.R2.resumeMultipartUpload("k", "id").abort());
attempt("d1Run", () => env.DB.prepare("select 1").run());
attempt("d1First", () => env.DB.prepare("select 1").first());
attempt("d1Exec", () => env.DB.exec("select 1"));
attempt("d1Batch", () => env.DB.batch([env.DB.prepare("select 1")]));
attempt("d1BatchNull", () => env.DB.batch(null));
attempt("d1ExecUndefined", () => env.DB.exec(undefined));
attempt("d1Session", () => env.DB.withSession().prepare("select 1").first());
attempt("kvGetWithMetadata", () => env.KV.getWithMetadata("k"));
// The responses have no body: workerd refuses to make one at module scope
// (1.39), and that would throw before put() is called.
attempt("cachePut", () => caches.default.put("http://x/", new Response(null)));
attempt("cachePutNotResponse", () => caches.default.put("http://x/", "x"));
attempt("cachePutBadKey", () => caches.default.put("ftp://x/", new Response(null)));
attempt("cachePutError", () => caches.default.put("http://x/", Response.error()));
attempt("cachePutIllegalThis",
  () => Cache.prototype.put.call({}, "http://x/", new Response(null)));
attempt("cacheMatch", () => caches.default.match("http://x/"));
attempt("cacheMatchBadKey", () => caches.default.match("ftp://x/"));
attempt("cacheMatchIllegalThis", () => Cache.prototype.match.call({}, "http://x/"));
attempt("cacheDelete", () => caches.default.delete("http://x/"));
attempt("cacheOpen", () => caches.open("a"));

let read = false;
export default {
  get fetch() {
    if (!read) {
      read = true;
      attempt("getterKvPut", () => env.KV.put("getter", "x"));
      attempt("getterR2Put", () => env.R2.put("getter", "x"));
      try {
        outcomes.getterEval = eval("1 + 1");
      } catch (error) {
        outcomes.getterEval = `threw ${describe(error)}`;
      }
    }
    return handle;
  },
};

async function handle(request, env) {
  const path = new URL(request.url).pathname;
  if (path === "/proxied") return env.PROXIED.fetch("http://proxied/");
  if (path === "/state") {
    return Response.json({
      kv: await env.KV.get("getter"),
      kvFromProxy: await env.KV.get("proxy"),
      r2: await env.R2.head("k"),
      r2FromGetter: await env.R2.head("getter"),
    });
  }
  return Response.json(outcomes);
}
