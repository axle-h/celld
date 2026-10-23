// A stateless Worker whose request holds buffers past the budget. `poisoned`
// marks the isolate that did: a later request reports whether it runs there.
import { buffers } from "./buffers.js";

let poisoned = false;

import { DurableObject } from "cloudflare:workers";
import { pbkdf2Sync } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

// A Durable Object that echoes a forwarded body, or keeps SQL blobs.
export class Store extends DurableObject {
  async fetch(request) {
    if (new URL(request.url).pathname === "/sql-blobs") {
      const keep = [];
      for (let i = 0; i < 200; i++)
        keep.push(this.ctx.storage.sql.exec("SELECT zeroblob(1048576) AS blob").one().blob);
      return new Response(`kept ${keep.length}`);
    }
    return new Response(await request.text());
  }
}

// Synchronous host calls that each hand the isolate a buffer the host built,
// kept in one turn: an 8 MiB inflate of an 8 KB bomb, and the longest key
// PBKDF2 derives with SHA-512, about 16 KB. Each is refused once the buffers pass the budget, within one buffer,
// rather than when the turn ends.
const synchronous = {
  zlib() {
    const bomb = deflateSync(new Uint8Array(8 << 20));
    const keep = [];
    for (let i = 0; i < 150; i++) keep.push(inflateSync(bomb));
    return keep.length;
  },
  pbkdf2() {
    const keep = [];
    for (let i = 0; i < 20000; i++) keep.push(pbkdf2Sync("password", "salt", 1, 16320, "sha512"));
    return keep.length;
  },
};

// A host buffer past the budget: AES-GCM output the host builds for a
// 100 MiB input, which JavaScript still holds. No JavaScript allocation is
// refused, so the turn's end finds the two past the budget.
async function encrypted() {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const data = new Uint8Array(100 << 20);
  const iv = new Uint8Array(12);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return new Response(`encrypted ${data.byteLength} into ${sealed.byteLength}`);
}

// Reads of an R2 object written as a stream of `mb` MiB, whole or streamed.
// A whole read holds the body once, so one of 100 MiB fits the 128 MiB
// budget; one of 200 MiB does not, and streaming it does. A text read also
// decodes the body into a heap string, so it reads 60 MiB, well within the
// heap limit.
async function bodies(env, url) {
  const mb = Number(url.searchParams.get("mb"));
  const read = url.searchParams.get("read");
  const key = `object-${mb}`;
  if (read === "put") {
    let left = mb;
    const body = new ReadableStream({
      pull(controller) {
        if (left-- > 0) controller.enqueue(new Uint8Array(1 << 20).fill(97));
        else controller.close();
      },
    });
    await env.BUCKET.put(key, body);
    return new Response("put");
  }
  const object = await env.BUCKET.get(key);
  if (read === "stream") {
    let length = 0;
    for await (const chunk of object.body) length += chunk.byteLength;
    return new Response(`stream ${length}`);
  }
  if (read === "concurrent") {
    // Three whole reads at once are each charged as their chunks arrive,
    // so together they cannot outgrow the budget on the host's side.
    const objects = await Promise.all([0, 1, 2].map(() => env.BUCKET.get(key)));
    const lengths = await Promise.all(objects.map((each) => each.arrayBuffer()));
    return new Response(`concurrent ${lengths.map((buffer) => buffer.byteLength)}`);
  }
  if (read === "twice") {
    // The buffer is handed over, not copied, so the body cannot be read again.
    const response = new Response(object.body);
    const buffer = await response.arrayBuffer();
    let again;
    try {
      await response.text();
      again = "read again";
    } catch (error) {
      again = `${error.name}: ${error.message}`;
    }
    return new Response(`twice ${buffer.byteLength} ${again}`);
  }
  const source = read.startsWith("response-") ? new Response(object.body) : object;
  const method = read.replace("response-", "");
  const value = await source[method]();
  return new Response(`${read} ${value.byteLength ?? value.size ?? value.length}`);
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/r2") return bodies(env, url);
    if (url.pathname === "/crypto") return encrypted();
    if (url.pathname === "/sync") return new Response(`kept ${synchronous[url.searchParams.get("kind")]()}`);
    if (url.pathname === "/sql-blobs") return env.STORE.getByName("blobs").fetch("http://store/sql-blobs");
    if (url.pathname === "/forwarded") return forwarded(env);
    const kind = url.searchParams.get("kind");
    if (kind === "check") return Response.json({ poisoned });
    poisoned = true;
    buffers[kind]();
    return new Response("allocated");
  },
};

// A request with a JavaScript stream body, forwarded to a Durable Object,
// which drains the body into a buffer. The drained buffer is not shared:
// after the forward, a clone and a read of the request both refuse, as in
// workerd, so neither reaches it.
async function forwarded(env) {
  const text = "forwarded body";
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  const request = new Request("http://store/echo", { method: "POST", body, duplex: "half" });
  const echoed = await (await env.STORE.getByName("store").fetch(request)).text();
  let clone;
  try {
    clone = request.clone();
  } catch (error) {
    clone = error;
  }
  let read;
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    bytes.fill(0);
    read = bytes.length;
  } catch (error) {
    read = `${error.name}: ${error.message}`;
  }
  const cloned = clone instanceof Request ? await clone.text() : `${clone.name}: ${clone.message}`;
  return Response.json({ echoed, read, cloned });
}
