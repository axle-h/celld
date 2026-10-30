// enable_fast_jsg_struct: the structs workerd's APIs return keep their
// members in declaration order, and with the flag an absent optional member
// is there as undefined; without it, it is left out. Each entry is the keys
// of what an API returned.
import { DurableObject } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { MIMEType } from "node:util";

const keys = (value) => Object.keys(value);

async function iterated(iterator) {
  const steps = [];
  for (;;) {
    const step = await iterator.next();
    steps.push(keys(step));
    if (step.done) return steps;
  }
}

export class Store extends DurableObject {
  probe() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS t (x)");
    sql.exec("DELETE FROM t");
    sql.exec("INSERT INTO t VALUES (1)");
    const next = sql.exec("SELECT x FROM t");
    const raw = sql.exec("SELECT x FROM t").raw();
    const each = sql.exec("SELECT x FROM t")[Symbol.iterator]();
    this.ctx.storage.kv.put("k", 1);
    return {
      next: [keys(next.next()), keys(next.next())],
      raw: [keys(raw.next()), keys(raw.next())],
      iterator: [keys(each.next()), keys(each.next())],
      kvList: (() => {
        const list = this.ctx.storage.kv.list();
        return [keys(list.next()), keys(list.next())];
      })(),
    };
  }
}

export default {
  async fetch(request, env) {
    const out = {};
    // Stream reads.
    {
      const reader = new ReadableStream({ start(c) { c.enqueue("a"); c.close(); } }).getReader();
      out.defaultRead = [keys(await reader.read()), keys(await reader.read())];
      const bytes = new Response("ab").body.getReader();
      out.bodyRead = [keys(await bytes.read()), keys(await bytes.read())];
      const byob = new ReadableStream({
        type: "bytes",
        start(c) { c.enqueue(new Uint8Array([1])); c.close(); },
      }).getReader({ mode: "byob" });
      out.byobRead = [keys(await byob.read(new Uint8Array(4))), keys(await byob.read(new Uint8Array(4)))];
      const { readable, writable } = new IdentityTransformStream();
      const writer = writable.getWriter();
      writer.write(new Uint8Array([1]));
      writer.close();
      const identity = readable.getReader();
      out.identityRead = [keys(await identity.read()), keys(await identity.read())];
      out.values = await iterated(new ReadableStream({ start(c) { c.enqueue(1); c.close(); } }).values());
      const early = new ReadableStream({ start(c) { c.enqueue(1); } }).values();
      out.valuesReturn = keys(await early.return("r"));
    }
    // Sync iterators.
    const headers = new Headers({ a: "1" });
    out.headers = await iterated(headers.entries());
    out.headerKeys = await iterated(headers.keys());
    out.searchParams = await iterated(new URLSearchParams("a=1").entries());
    const form = new FormData();
    form.append("a", "1");
    out.formData = await iterated(form.entries());
    out.webSocketPair = await iterated(new WebSocketPair()[Symbol.iterator]());
    out.mimeParams = await iterated(new MIMEType("text/plain;a=b").params.entries());
    // HTMLRewriter's attributes.
    let attributes;
    await new HTMLRewriter().on("p", {
      element(element) { attributes = [...[element.attributes.next(), element.attributes.next(), element.attributes.next()].map(keys)]; },
    }).transform(new Response('<p a="1">x</p>')).text();
    out.attributes = attributes;
    // URLPattern's inputs.
    out.patternInputs = keys(new URLPattern({ pathname: "/a/:x" }).exec({ pathname: "/a/b" }).inputs[0]);
    // A socket's info.
    const socket = connect(`127.0.0.1:${new URL(request.url).searchParams.get("port")}`);
    out.socketOpened = keys(await socket.opened);
    await socket.close();
    // Queue metrics, once the queue has a message (queues/send-metrics).
    await env.QUEUE.send("x");
    const sent = await env.QUEUE.send("x");
    out.sendMetrics = keys(sent.metadata.metrics);
    out.sendBatchMetrics = keys((await env.QUEUE.sendBatch([{ body: "x" }])).metadata.metrics);
    out.queueMetrics = keys(await env.QUEUE.metrics());
    // R2.
    await env.BUCKET.put("one", "hello", { httpMetadata: { contentType: "text/plain" }, md5: await crypto.subtle.digest("MD5", new TextEncoder().encode("hello")) });
    await env.BUCKET.put("two", "hi");
    const one = await env.BUCKET.get("one", { range: { offset: 1, length: 2 } });
    out.r2HttpMetadata = keys(one.httpMetadata);
    out.r2EmptyHttpMetadata = keys((await env.BUCKET.head("two")).httpMetadata);
    out.r2Range = keys(one.range);
    out.r2Checksums = keys(one.checksums.toJSON());
    out.r2List = keys(await env.BUCKET.list());
    out.r2ListTruncated = keys(await env.BUCKET.list({ limit: 1 }));
    // node:crypto's key details.
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const ed = generateKeyPairSync("ed25519");
    out.keyDetails = [rsa, ec, ed].map(({ publicKey }) => keys(createPublicKey(publicKey.export({ type: "spki", format: "pem" })).asymmetricKeyDetails));
    // A Durable Object's SQL cursor and synchronous KV.
    out.durableObject = await env.STORE.getByName("a").probe();
    out.reported = Cloudflare.compatibilityFlags.enable_fast_jsg_struct ?? null;
    return Response.json(out);
  },
  queue() {},
};
