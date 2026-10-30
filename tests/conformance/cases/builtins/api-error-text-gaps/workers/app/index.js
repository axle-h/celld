// The runtime API errors where celld still differs from workerd (plan 1.68):
// each probe reports the error's name and message, or what it returned,
// as builtins/api-error-text does for the ones that match.
const bytes = (n) => new Uint8Array(n);

const AREAS = {
  url: {
    "href getter on {}": () => Object.getOwnPropertyDescriptor(URL.prototype, "href").get.call({}),
    "URL()": () => URL("http://a/"),
  },
  headers: {
    "append('é', 'c')": () => new Headers().append("é", "c"),
    "has('')": () => new Headers().has(""),
    "get on {}": () => Headers.prototype.get.call({}, "a"),
    "Headers()": () => Headers(),
  },
  request: {
    "method 'TRACE'": () => new Request("http://a/", { method: "TRACE" }),
    "text twice": async () => { const r = new Request("http://a/", { method: "POST", body: "x" }); await r.text(); return r.text(); },
    "new Request(used)": async () => { const r = new Request("http://a/", { method: "POST", body: "x" }); await r.text(); return new Request(r); },
    "copy leaves its input used": () => {
      const input = new Request("http://a/", { method: "POST", body: "x" });
      new Request(input, { headers: { a: "b" } });
      return input.bodyUsed;
    },
  },
  response: {
    "text twice": async () => { const r = new Response("x"); await r.text(); return r.text(); },
    "body locked then text": async () => { const r = new Response("x"); r.body.getReader(); return r.text(); },
    "body read after text": async () => {
      const r = new Response("abc");
      await r.text();
      const { done, value } = await r.body.getReader().read();
      return `done ${done}, ${value?.byteLength ?? "no"} bytes`;
    },
    "HTMLRewriter transform of a used Response": async () => {
      const r = new Response("<p>abc</p>");
      await r.text();
      return new HTMLRewriter().transform(r).text();
    },
  },
  encoding: {
    "TextDecoder()": () => TextDecoder(),
  },
  streams: {
    "text() of locked request body": async () => { const r = new Request("http://a/", { method: "POST", body: "x" }); r.body.getReader(); return r.text(); },
    "FixedLengthStream short": async () => {
      const { readable, writable } = new FixedLengthStream(5);
      const w = writable.getWriter();
      readable.pipeTo(new WritableStream()).catch(() => {});
      await w.write(bytes(1));
      return w.close();
    },
    "IdentityTransformStream write string": async () => {
      const { readable, writable } = new IdentityTransformStream();
      readable.pipeTo(new WritableStream()).catch(() => {});
      return writable.getWriter().write("a");
    },
  },
  blob: {
    "formData() on text": async () => new Response("x").formData(),
    "Blob()": () => Blob(),
    "formData() unquoted name": async () => new Response("--b\r\nContent-Disposition: form-data; name=a\r\n\r\nv\r\n--b--", { headers: { "content-type": "multipart/form-data; boundary=b" } }).formData(),
  },
  abort: {
    "AbortController()": () => AbortController(),
  },
  events: {
    "EventTarget()": () => EventTarget(),
    "Event()": () => Event("x"),
    "new ErrorEvent()": () => new ErrorEvent(),
  },
  crypto: {
    "exportKey of an object inheriting a key": async () => {
      const key = await crypto.subtle.importKey("raw", bytes(16), "AES-GCM", false, ["encrypt"]);
      return crypto.subtle.exportKey("raw", Object.create(key));
    },
    "importKey AES length 7": async () => crypto.subtle.importKey("raw", bytes(7), "AES-GCM", false, ["encrypt"]),
    "importKey AES usage 'sign'": async () => crypto.subtle.importKey("raw", bytes(16), "AES-GCM", false, ["sign"]),
    "importKey HMAC usages 'x'": async () => crypto.subtle.importKey("raw", bytes(16), { name: "HMAC", hash: "SHA-256" }, false, ["x"]),
    "importKey jwk bad": async () => crypto.subtle.importKey("jwk", {}, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    "generateKey AES no usages": async () => crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, false, []),
    "encrypt with HMAC key": async () => {
      const key = await crypto.subtle.importKey("raw", bytes(16), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return crypto.subtle.encrypt({ name: "AES-GCM", iv: bytes(12) }, key, bytes(1));
    },
    "sign without usage": async () => {
      const key = await crypto.subtle.importKey("raw", bytes(16), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
      return crypto.subtle.sign("HMAC", key, bytes(1));
    },
    "new Crypto()": () => new Crypto(),
  },
  misc: {
    "new HTMLRewriter().on('[', {})": () => new HTMLRewriter().on("[", {}),
    "DOMException()": () => DOMException(),
  },
};
const describe = (value) => {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object" || typeof value === "function") {
    return Object.prototype.toString.call(value);
  }
  return String(value);
};

const report = (error) => {
  if (error instanceof Error || error instanceof DOMException) {
    return `${error.constructor.name}(${error.name}): ${error.message}`;
  }
  return `threw ${describe(error)}`;
};

const attempt = async (probe) => {
  try {
    const value = probe();
    if (value && typeof value.then === "function") return `returned ${describe(await value)}`;
    return `returned ${describe(value)}`;
  } catch (error) {
    return report(error);
  }
};

export default {
  async fetch(request) {
    const area = new URL(request.url).searchParams.get("area");
    const probes = AREAS[area];
    if (!probes) return new Response("unknown area", { status: 400 });
    const results = {};
    for (const [label, probe] of Object.entries(probes)) results[label] = await attempt(probe);
    return Response.json(results);
  },
};
