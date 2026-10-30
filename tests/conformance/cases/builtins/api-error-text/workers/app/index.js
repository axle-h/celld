// The errors runtime APIs throw, by type and message (plan 1.40): the calls a
// program gets wrong most often, one area per step. Each probe reports the
// error's name and message, or what it returned when it did not throw.
const bytes = (n) => new Uint8Array(n);
const pair = () => Object.values(new WebSocketPair());
// A POST Request with `body`, which a copy's init may inherit.
const post = (body) => new Request("http://a/", { method: "POST", body });
// The fields a call reads of its CacheQueryOptions, in order, and what it
// then did; `given` names the one field that has a value.
const fieldOrder = async (call, given) => {
  const read = [];
  const options = {};
  for (const name of ["cacheName", "ignoreVary", "ignoreSearch", "ignoreMethod"]) {
    Object.defineProperty(options, name, {
      get() { read.push(name); return name === given ? true : undefined; },
    });
  }
  let outcome;
  try { outcome = `returned ${await call(options)}`; } catch (error) { outcome = `${error.name}: ${error.message}`; }
  return `${read.join(",")} | ${outcome}`;
};

const AREAS = {
  url: {
    "new URL('bad')": () => new URL("bad"),
    "new URL('x', 'bad')": () => new URL("x", "bad"),
    "new URL()": () => new URL(),
    "new URL('http://[::1')": () => new URL("http://[::1"),
    "new URL(Symbol())": () => new URL(Symbol()),
    "href = 'bad'": () => { const url = new URL("http://a/"); url.href = "bad"; },
    "URL.canParse()": () => URL.canParse(),
    "URL.parse('bad')": () => URL.parse("bad"),
    "URL.parse()": () => URL.parse(),
    "search = Symbol()": () => { new URL("http://a/").search = Symbol(); },
    "new URLSearchParams(null)": () => new URLSearchParams(null).toString(),
    "new URLSearchParams(1)": () => new URLSearchParams(1).toString(),
    "new URLSearchParams(['ab'])": () => new URLSearchParams(["ab"]),
    "new URLSearchParams([['a']])": () => new URLSearchParams([["a"]]),
    "new URLSearchParams([['a', 'b', 'c']])": () => new URLSearchParams([["a", "b", "c"]]),
    "new URLSearchParams([1])": () => new URLSearchParams([1]),
    "params.append('a')": () => new URLSearchParams().append("a"),
    "params.get()": () => new URLSearchParams().get(),
    "params.forEach(1)": () => new URLSearchParams("a=1").forEach(1),
    "new URLPattern('(')": () => new URLPattern("("),
    "new URLPattern({ protocol: '(' })": () => new URLPattern({ protocol: "(" }),
    "new URLPattern(1)": () => new URLPattern(1),
    "new URLPattern('/a', 'bad')": () => new URLPattern("/a", "bad"),
    "new URLPattern('http://a/', { ignoreCase: 1 }, 1)": () => new URLPattern("http://a/", "http://b/", 1),
    "pattern.test('/a', 'bad')": () => new URLPattern({ pathname: "/a" }).test("/a", "bad"),
    "pattern.exec(1, 2)": () => new URLPattern({ pathname: "/a" }).exec({ pathname: "/a" }, "http://b/"),
    "new URLPattern('/a', 'http://a/', null)": () => new URLPattern("/a", "http://a/", null).pathname,
    "new URLSearchParams(() => {})": () => new URLSearchParams(() => {}).toString(),
  },
  base64: {
    "atob('@@')": () => atob("@@"),
    "atob('abcde')": () => atob("abcde"),
    "atob()": () => atob(),
    "atob(undefined)": () => atob(undefined),
    "btoa('é€')": () => btoa("é€"),
    "btoa()": () => btoa(),
  },
  headers: {
    "new Headers([['a']])": () => new Headers([["a"]]),
    "new Headers([['a', 'b', 'c']])": () => new Headers([["a", "b", "c"]]),
    "new Headers([1])": () => new Headers([1]),
    "new Headers(1)": () => new Headers(1),
    "new Headers('x')": () => new Headers("x"),
    "new Headers(null)": () => new Headers(null),
    "new Headers(() => {})": () => JSON.stringify([...new Headers(() => {})]),
    "new Headers(['ab'])": () => new Headers(["ab"]),
    "new Headers({ [Symbol()]: 'x', a: 'b' })": () => JSON.stringify([...new Headers({ [Symbol()]: "x", a: "b" })]),
    "append(Symbol(), 'a')": () => new Headers().append(Symbol(), "a"),
    "new Headers({ 'a b': 'c' })": () => new Headers({ "a b": "c" }),
    "append('a b', 'c')": () => new Headers().append("a b", "c"),
    "append('a', '\\0')": () => new Headers().append("a", "\0"),
    "append('a', '\\n')": () => new Headers().append("a", "x\ny"),
    "append('a', 'é€')": () => new Headers().append("a", "é€"),
    "set('a')": () => new Headers().set("a"),
    "get()": () => new Headers().get(),
    "get('a b')": () => new Headers().get("a b"),
    "delete('a b')": () => new Headers().delete("a b"),
    "forEach(1)": () => new Headers({ a: "b" }).forEach(1),
  },
  request: {
    "new Request()": () => new Request(),
    "new Request('bad')": () => new Request("bad"),
    "new Request('http://u:p@a/')": () => new Request("http://u:p@a/"),
    "method 'bad method'": () => new Request("http://a/", { method: "bad method" }),
    "method 'CONNECT'": () => new Request("http://a/", { method: "CONNECT" }),
    "method 'patch2'": () => new Request("http://a/", { method: "patch2" }).method,
    "GET with body": () => new Request("http://a/", { body: "x" }),
    "HEAD with body": () => new Request("http://a/", { method: "HEAD", body: "x" }),
    "redirect 'bad'": () => new Request("http://a/", { redirect: "bad" }),
    "cache 'bad'": () => new Request("http://a/", { cache: "bad" }),
    "cache 'no-cache'": () => new Request("http://a/", { cache: "no-cache" }),
    "mode 'navigate'": () => new Request("http://a/", { mode: "navigate" }).mode,
    "credentials 'bad'": () => new Request("http://a/", { credentials: "bad" }).credentials,
    "integrity 'x'": () => new Request("http://a/", { integrity: "x" }),
    "signal 1": () => new Request("http://a/", { signal: 1 }),
    "headers 1": () => new Request("http://a/", { headers: 1 }),
    "init 1": () => new Request("http://a/", 1),
    "Request()": () => Request("http://a/"),
    "init null": () => new Request("http://a/", null).method,
    "GET with empty body": () => new Request("http://a/", { body: "" }),
    "headers null": () => new Request("http://a/", { headers: null }),
    "url normalized": () => new Request("HTTP://A/b/../c?d#e").url,
    "bad url and bad init": () => new Request("bad", 1),
    "clone after use": async () => { const r = new Request("http://a/", { method: "POST", body: "x" }); await r.text(); return r.clone(); },
    "url getter on {}": () => Object.getOwnPropertyDescriptor(Request.prototype, "url").get.call({}),
    // A body a copy inherits from its input counts as the init's when the
    // init sets the method or the body (http.c++ `Request::constructor`).
    "GET from POST with body": () => new Request(post("x"), { method: "GET" }),
    "HEAD from POST with body": () => new Request(post("x"), { method: "HEAD" }),
    "GET from POST with empty body": () => new Request(post(""), { method: "GET" }),
    "GET from POST with stream body": () => new Request(post(new ReadableStream()), { method: "GET" }),
    "GET from POST without body": () => new Request(post(undefined), { method: "GET" }).method,
    "GET from POST with body, body null": () => new Request(post("x"), { method: "GET", body: null }).method,
    "GET from GET": () => new Request(new Request("http://a/"), { method: "GET" }).method,
    "headers from POST with body": () => new Request(post("x"), { headers: { a: "b" } }).method,
    "input used after GET refusal": () => {
      const input = post("x");
      try { new Request(input, { method: "GET" }); } catch { /* refused */ }
      return input.bodyUsed;
    },
  },
  response: {
    "status 99": () => new Response(null, { status: 99 }),
    "status 600": () => new Response(null, { status: 600 }),
    "status 204 with body": () => new Response("x", { status: 204 }),
    "statusText '\\n'": () => new Response(null, { statusText: "\n" }),
    "statusText 'é€'": () => new Response(null, { statusText: "é€" }),
    "headers [['a']]": () => new Response(null, { headers: [["a"]] }),
    "init 1": () => new Response(null, 1),
    "body Symbol()": () => new Response(Symbol()),
    "Response.redirect('bad')": () => Response.redirect("bad"),
    "Response.redirect(url, 200)": () => Response.redirect("http://a/", 200),
    "Response.json(1n)": () => Response.json(1n),
    "Response.json(undefined)": () => Response.json(undefined),
    "Response.json(cycle)": () => { const a = {}; a.a = a; return Response.json(a); },
    "Response.json(x, 1)": () => Response.json(1, 1),
    "clone after use": async () => { const r = new Response("x"); await r.text(); return r.clone(); },
    "json invalid": async () => new Response("{").json(),
    "Response()": () => Response(),
    "init null": () => new Response(null, null).status,
    "status 204 with empty body": () => new Response("", { status: 204 }).body,
    "status 204 with stream": () => new Response(new ReadableStream(), { status: 204 }),
    "status 304 with empty buffer": () => new Response(new Uint8Array(0), { status: 304 }).body,
    "statusText '\t'": () => new Response(null, { statusText: "a\tb" }),
    "headers 1": () => new Response(null, { headers: 1 }),
    "status getter on {}": () => Object.getOwnPropertyDescriptor(Response.prototype, "status").get.call({}),
  },
  encoding: {
    "new TextDecoder('bogus')": () => new TextDecoder("bogus"),
    "new TextDecoder('replacement')": () => new TextDecoder("replacement"),
    "new TextDecoder('utf-8', 1)": () => new TextDecoder("utf-8", 1),
    "fatal decode": () => new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xff])),
    "fatal utf-16le decode": () => new TextDecoder("utf-16le", { fatal: true }).decode(new Uint8Array([0x00, 0xd8])),
    "decode('str')": () => new TextDecoder().decode("str"),
    "decode(1)": () => new TextDecoder().decode(1),
    "decode(null)": () => new TextDecoder().decode(null),
    "decode(bytes, 1)": () => new TextDecoder().decode(bytes(1), 1),
    "new TextDecoder(' Bogus ')": () => new TextDecoder(" Bogus "),
    "new TextDecoder(null)": () => new TextDecoder(null),
    "new TextDecoder('utf-8', null)": () => new TextDecoder("utf-8", null).encoding,
    "encodeInto('a', [])": () => new TextEncoder().encodeInto("a", []),
    "encodeInto()": () => new TextEncoder().encodeInto(),
    "encodeInto('a')": () => new TextEncoder().encodeInto("a"),
    "new TextDecoderStream('bogus')": () => new TextDecoderStream("bogus"),
  },
  streams: {
    "new ReadableStream(1)": () => new ReadableStream(1),
    "new ReadableStream(null)": () => new ReadableStream(null),
    "byte enqueue ArrayBuffer": () => { let c; new ReadableStream({ type: "bytes", start(x) { c = x; } }); c.enqueue(new ArrayBuffer(2)); return c.desiredSize; },
    "byte enqueue empty": () => { let c; new ReadableStream({ type: "bytes", start(x) { c = x; } }); c.enqueue(new Uint8Array(0)); },
    "byte enqueue after close": () => { let c; new ReadableStream({ type: "bytes", start(x) { c = x; } }); c.close(); c.enqueue(new Uint8Array(1)); },
    "byte close twice": () => { let c; new ReadableStream({ type: "bytes", start(x) { c = x; } }); c.close(); c.close(); },
    "byte start 1": () => new ReadableStream({ type: "bytes", start: 1 }),
    "highWaterMark 2n": () => { let c; new ReadableStream({ start(x) { c = x; } }, { highWaterMark: 2n }); return c.desiredSize; },
    "pipeThrough(null)": () => new ReadableStream().pipeThrough(null),
    "pipeThrough({})": () => new ReadableStream().pipeThrough({}),
    "pipeTo locked writable": async () => { const w = new WritableStream(); w.getWriter(); return new ReadableStream().pipeTo(w); },
    "new CountQueuingStrategy(null)": () => new CountQueuingStrategy(null),
    "CountQueuingStrategy highWaterMark '3'": () => new CountQueuingStrategy({ highWaterMark: "3" }).highWaterMark,
    "WritableStream close locked": async () => { const s = new WritableStream(); s.getWriter(); return s.close(); },
    "writer.close after error": async () => { let c; const s = new WritableStream({ start(x) { c = x; } }); const w = s.getWriter(); await null; c.error(new RangeError("boom")); return w.close(); },
    "new WritableStreamDefaultWriter(1)": () => new WritableStreamDefaultWriter(1),
    "TransformStream writableType": () => new TransformStream({ writableType: "bytes" }),
    "new TransformStream(null)": () => typeof new TransformStream(null).readable,
    "new FixedLengthStream(1.5)": () => typeof new FixedLengthStream(1.5).readable,
    "new FixedLengthStream(2 ** 53)": () => new FixedLengthStream(2 ** 53),
    "new CompressionStream()": () => new CompressionStream(),
    "structuredClone(WritableStream)": () => structuredClone(new WritableStream()),
    "start 1": () => new ReadableStream({ start: 1 }),
    "pull 1": () => new ReadableStream({ pull: 1 }),
    "cancel 1": () => new ReadableStream({ cancel: 1 }),
    "strategy size 1": () => new ReadableStream({}, { size: 1 }),
    "strategy 1": () => new ReadableStream({}, 1),
    "highWaterMark Infinity": () => new ReadableStream({}, { highWaterMark: Infinity }),
    "highWaterMark 1.5": () => { let c; new ReadableStream({ start(x) { c = x; } }, { highWaterMark: 1.5 }); return c.desiredSize; },
    "highWaterMark '2'": () => { let c; new ReadableStream({ start(x) { c = x; } }, { highWaterMark: "2" }); return c.desiredSize; },
    "WritableStream write 1": () => new WritableStream({ write: 1 }),
    "WritableStream highWaterMark -1": () => new WritableStream({}, { highWaterMark: -1 }),
    "TransformStream transform 1": () => new TransformStream({ transform: 1 }),
    "new ReadableStreamDefaultReader(1)": () => new ReadableStreamDefaultReader(1),
    "enqueue after error": () => { let c; new ReadableStream({ start(x) { c = x; } }); c.error(new Error("x")); c.enqueue("a"); },
    "close after error": () => { let c; new ReadableStream({ start(x) { c = x; } }); c.error(new Error("x")); c.close(); },
    "writer.close twice": async () => { const w = new WritableStream().getWriter(); w.close(); return w.close(); },
    "writer.write after release": async () => { const w = new WritableStream().getWriter(); w.releaseLock(); return w.write("a"); },
    "type 'bad'": () => new ReadableStream({ type: "bad" }),
    "highWaterMark -1": () => new ReadableStream({}, { highWaterMark: -1 }),
    "highWaterMark NaN": () => new ReadableStream({}, { highWaterMark: NaN }),
    "size with bytes": () => new ReadableStream({ type: "bytes" }, { size: () => 1 }),
    "getReader twice": () => { const s = new ReadableStream(); s.getReader(); return s.getReader(); },
    "getReader mode 'bad'": () => new ReadableStream().getReader({ mode: "bad" }),
    "getReader byob on default": () => new ReadableStream().getReader({ mode: "byob" }),
    "read after releaseLock": async () => { const r = new ReadableStream().getReader(); r.releaseLock(); return r.read(); },
    "byob read(empty)": async () => new ReadableStream({ type: "bytes" }).getReader({ mode: "byob" }).read(bytes(0)),
    "byob read()": async () => new ReadableStream({ type: "bytes" }).getReader({ mode: "byob" }).read(),
    "cancel locked": async () => { const s = new ReadableStream(); s.getReader(); return s.cancel(); },
    "tee locked": () => { const s = new ReadableStream(); s.getReader(); return s.tee(); },
    "pipeTo(1)": async () => new ReadableStream().pipeTo(1),
    "pipeThrough(1)": () => new ReadableStream().pipeThrough(1),
    "enqueue after close": () => { let c; new ReadableStream({ start(x) { c = x; } }); c.close(); c.enqueue("a"); },
    "close twice": () => { let c; new ReadableStream({ start(x) { c = x; } }); c.close(); c.close(); },
    "byte enqueue string": () => { let c; new ReadableStream({ type: "bytes", start(x) { c = x; } }); c.enqueue("a"); },
    "ReadableStream.from(1)": () => ReadableStream.from(1),
    "getWriter twice": () => { const s = new WritableStream(); s.getWriter(); return s.getWriter(); },
    "write after close": async () => { const w = new WritableStream().getWriter(); w.close(); return w.write("a"); },
    "abort locked": async () => { const s = new WritableStream(); s.getWriter(); return s.abort(); },
    "new WritableStream(1)": () => new WritableStream(1),
    "new WritableStream({ type: 'bytes' })": () => new WritableStream({ type: "bytes" }),
    "new TransformStream(1)": () => new TransformStream(1),
    "TransformStream readableType": () => new TransformStream({ readableType: "bytes" }),
    "new CountQueuingStrategy()": () => new CountQueuingStrategy(),
    "new ByteLengthQueuingStrategy({})": () => new ByteLengthQueuingStrategy({}),
    "new FixedLengthStream(-1)": () => new FixedLengthStream(-1),
    "new FixedLengthStream()": () => new FixedLengthStream(),
    "new CompressionStream('bad')": () => new CompressionStream("bad"),
    "new DecompressionStream()": () => new DecompressionStream(),
    "ReadableStream()": () => ReadableStream(),
  },
  blob: {
    "new Blob(1)": () => new Blob(1),
    "new Blob('ab')": () => new Blob("ab"),
    "endings 'bad'": () => new Blob([], { endings: "bad" }),
    "new File()": () => new File(),
    "new File([])": () => new File([]),
    "new File(1, 'a')": () => new File(1, "a"),
    "new File([], 'a', 1)": () => new File([], "a", 1),
    "new Blob([], 1)": () => new Blob([], 1),
    "new Blob(null)": () => new Blob(null),
    "new Blob(['a'], null)": () => new Blob(["a"], null).size,
    "formData() bad terminator": async () => new Response("--bxx", { headers: { "content-type": "multipart/form-data; boundary=b" } }).formData(),
    "formData() no header end": async () => new Response("--b\r\nContent-Disposition: form-data; name=a\r\n--b--", { headers: { "content-type": "multipart/form-data; boundary=b" } }).formData(),
    "formData() no name": async () => new Response("--b\r\nContent-Disposition: form-data\r\n\r\nv\r\n--b--", { headers: { "content-type": "multipart/form-data; boundary=b" } }).formData(),
    "formData() no disposition": async () => new Response("--b\r\nX-A: 1\r\n\r\nv\r\n--b--", { headers: { "content-type": "multipart/form-data; boundary=b" } }).formData(),
    "formData() no closing": async () => new Response("--b\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\nv", { headers: { "content-type": "multipart/form-data; boundary=b" } }).formData(),
    "formData() latin1 urlencoded": async () => new Response("a=b", { headers: { "content-type": "application/x-www-form-urlencoded; charset=latin1" } }).formData(),
    "fd.has()": () => new FormData().has(),
    "fd.set('a')": () => new FormData().set("a"),
    "new FormData(1)": () => new FormData(1),
    "fd.append('a')": () => new FormData().append("a"),
    "fd.append('a', 'b', 'c')": () => new FormData().append("a", "b", "c"),
    "fd.get()": () => new FormData().get(),
    "fd.forEach(1)": () => new FormData().forEach(1),
    "formData() bad multipart": async () => new Response("x", { headers: { "content-type": "multipart/form-data; boundary=b" } }).formData(),
    "formData() no boundary": async () => new Response("x", { headers: { "content-type": "multipart/form-data" } }).formData(),
  },
  abort: {
    "new AbortSignal()": () => new AbortSignal(),
    "AbortSignal.timeout(-1)": () => AbortSignal.timeout(-1),
    "AbortSignal.timeout()": () => AbortSignal.timeout(),
    "AbortSignal.any(1)": () => AbortSignal.any(1),
    "AbortSignal.any([1])": () => AbortSignal.any([1]),
    "AbortSignal.any([aborted, 1])": () => AbortSignal.any([AbortSignal.abort(), 1]),
    "abort().reason": () => { throw AbortSignal.abort().reason; },
    "throwIfAborted": () => AbortSignal.abort().throwIfAborted(),
    "controller.abort() reason": () => { const c = new AbortController(); c.abort(); throw c.signal.reason; },
  },
  events: {
    "new Event()": () => new Event(),
    "new Event('x', 1)": () => new Event("x", 1),
    "new CustomEvent()": () => new CustomEvent(),
    "addEventListener('x', 1)": () => new EventTarget().addEventListener("x", 1),
    "addEventListener('x')": () => new EventTarget().addEventListener("x"),
    "addEventListener('x', {})": () => new EventTarget().addEventListener("x", {}),
    "addEventListener('x', undefined)": () => new EventTarget().addEventListener("x", undefined),
    "addEventListener capture true": () => new EventTarget().addEventListener("x", () => {}, true),
    "addEventListener options.capture": () => new EventTarget().addEventListener("x", () => {}, { capture: true }),
    "addEventListener options.passive": () => new EventTarget().addEventListener("x", () => {}, { passive: true }),
    "removeEventListener capture true": () => new EventTarget().removeEventListener("x", () => {}, true),
    "removeEventListener options.capture": () => new EventTarget().removeEventListener("x", () => {}, { capture: true }),
    "removeEventListener('x')": () => new EventTarget().removeEventListener("x"),
    "new CustomEvent('x', 1)": () => new CustomEvent("x", 1),
    "removeEventListener('x', 1)": () => new EventTarget().removeEventListener("x", 1),
    "dispatchEvent(1)": () => new EventTarget().dispatchEvent(1),
    "dispatchEvent()": () => new EventTarget().dispatchEvent(),
    "dispatch while dispatching": () => {
      const t = new EventTarget();
      const e = new Event("x");
      t.addEventListener("x", () => t.dispatchEvent(e));
      let caught;
      t.addEventListener("x", () => {});
      try { t.dispatchEvent(e); } catch (error) { caught = error; }
      if (caught) throw caught;
      return "dispatched";
    },
  },
  clone: {
    "structuredClone()": () => structuredClone(),
    "structuredClone(function)": () => structuredClone(() => {}),
    "structuredClone(Symbol())": () => structuredClone(Symbol()),
    "structuredClone(WeakMap)": () => structuredClone(new WeakMap()),
    "structuredClone(stream)": () => structuredClone(new ReadableStream()),
    "structuredClone(Request)": () => structuredClone(new Request("http://a/")),
    "structuredClone(x, 1)": () => structuredClone(1, 1),
    "structuredClone transfer 1": () => structuredClone(1, { transfer: 1 }),
  },
  crypto: {
    "getRandomValues(Float32Array)": () => crypto.getRandomValues(new Float32Array(1)),
    "getRandomValues(70000)": () => crypto.getRandomValues(bytes(70000)),
    "getRandomValues()": () => crypto.getRandomValues(),
    "getRandomValues([])": () => crypto.getRandomValues([]),
    "getRandomValues(DataView)": () => crypto.getRandomValues(new DataView(new ArrayBuffer(1))),
    "digest('SHA-256')": async () => crypto.subtle.digest("SHA-256"),
    "importKey('raw', 'x')": async () => crypto.subtle.importKey("raw", "x", "AES-GCM", false, ["encrypt"]),
    "importKey format 'bad' and alg 'bad'": async () => crypto.subtle.importKey("bad", bytes(16), "bad", false, ["encrypt"]),
    "importKey { name: 'Bad' }": async () => crypto.subtle.importKey("raw", bytes(16), { name: "Bad" }, false, ["encrypt"]),
    "generateKey { name: 'PBKDF2' }": async () => crypto.subtle.generateKey({ name: "PBKDF2" }, false, ["deriveBits"]),
    "AES-CBC no iv": async () => {
      const key = await crypto.subtle.importKey("raw", bytes(16), "AES-CBC", false, ["encrypt"]);
      return crypto.subtle.encrypt({ name: "AES-CBC" }, key, bytes(1));
    },
    "exportKey not extractable HMAC": async () => {
      const key = await crypto.subtle.importKey("raw", bytes(16), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return crypto.subtle.exportKey("jwk", key);
    },
    "DigestStream()": () => new crypto.DigestStream(),
    "randomUUID on {}": () => crypto.randomUUID.call({}),
    "digest('bad')": async () => crypto.subtle.digest("bad", bytes(1)),
    "digest('SHA-256', 'str')": async () => crypto.subtle.digest("SHA-256", "str"),
    "digest()": async () => crypto.subtle.digest(),
    "importKey('bad')": async () => crypto.subtle.importKey("bad", bytes(16), "AES-GCM", false, ["encrypt"]),
    "importKey alg 'bad'": async () => crypto.subtle.importKey("raw", bytes(16), "bad", false, ["encrypt"]),
    "importKey HMAC no hash": async () => crypto.subtle.importKey("raw", bytes(16), { name: "HMAC" }, false, ["sign"]),
    "importKey raw jwk data": async () => crypto.subtle.importKey("raw", {}, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    "importKey empty usages ECDSA private": async () => crypto.subtle.importKey("pkcs8", bytes(10), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
    "generateKey HMAC no hash": async () => crypto.subtle.generateKey({ name: "HMAC" }, false, ["sign"]),
    "generateKey 'bad'": async () => crypto.subtle.generateKey("bad", false, ["sign"]),
    "generateKey ECDSA bad curve": async () => crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-1" }, false, ["sign"]),
    "decrypt bad tag": async () => {
      const key = await crypto.subtle.importKey("raw", bytes(16), "AES-GCM", false, ["decrypt"]);
      return crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(12) }, key, bytes(32));
    },
    "AES-GCM no iv": async () => {
      const key = await crypto.subtle.importKey("raw", bytes(16), "AES-GCM", false, ["encrypt"]);
      return crypto.subtle.encrypt({ name: "AES-GCM" }, key, bytes(1));
    },
    "exportKey not extractable": async () => {
      const key = await crypto.subtle.importKey("raw", bytes(16), "AES-GCM", false, ["encrypt"]);
      return crypto.subtle.exportKey("raw", key);
    },
    "exportKey(raw, 1)": async () => crypto.subtle.exportKey("raw", 1),
    "timingSafeEqual lengths": () => crypto.subtle.timingSafeEqual(bytes(1), bytes(2)),
    "timingSafeEqual('a', 'a')": () => crypto.subtle.timingSafeEqual("a", "a"),
    "new DigestStream('bad')": () => new crypto.DigestStream("bad"),
    "new CryptoKey()": () => new CryptoKey(),
    "new SubtleCrypto()": () => new SubtleCrypto(),
  },
  timers: {
    "setTimeout('code')": () => typeof setTimeout("1", 0),
    "setTimeout()": () => setTimeout(),
    "setTimeout(1)": () => setTimeout(1),
    "setInterval({})": () => setInterval({}),
    "clearTimeout('x')": () => clearTimeout("x"),
    "queueMicrotask(1)": () => queueMicrotask(1),
    "queueMicrotask()": () => queueMicrotask(),
    "setTimeout(1, 0) type": () => typeof setTimeout(1, 0),
    "scheduler.wait('a')": async () => scheduler.wait("a"),
  },
  websocket: {
    "new WebSocket('bad')": () => new WebSocket("bad"),
    "new WebSocket('http://a/')": () => new WebSocket("ftp://a/"),
    "new WebSocket()": () => new WebSocket(),
    "send before accept": () => { const [, server] = pair(); server.send("a"); },
    "accept twice": () => { const [, server] = pair(); server.accept(); server.accept(); },
    "close(5000)": () => { const [, server] = pair(); server.accept(); server.close(5000); },
    "close(1000, long)": () => { const [, server] = pair(); server.accept(); server.close(1000, "x".repeat(124)); },
    "close('a')": () => { const [, server] = pair(); server.accept(); server.close("a"); },
    "send after close": () => { const [, server] = pair(); server.accept(); server.close(); server.send("a"); },
    "send(1)": () => { const [, server] = pair(); server.accept(); return server.send(1); },
    "new WebSocketPair(1)": () => WebSocketPair(),
    "Response webSocket 200": () => { const [client] = pair(); return new Response(null, { status: 200, webSocket: client }); },
  },
  cache: {
    "caches.open()": async () => caches.open(),
    "put('bad')": async () => caches.default.put("bad", new Response("x")),
    "put POST": async () => caches.default.put(new Request("http://a/", { method: "POST" }), new Response("x")),
    "put 206": async () => caches.default.put("http://a/", new Response("x", { status: 206 })),
    "put vary *": async () => caches.default.put("http://a/", new Response("x", { headers: { vary: "*" } })),
    "put(url, 1)": async () => caches.default.put("http://a/", 1),
    "put used body": async () => { const r = new Response("x"); await r.text(); return caches.default.put("http://a/", r); },
    "match(1)": async () => caches.default.match(1),
    "match('bad')": async () => caches.default.match("bad"),
    "delete('bad')": async () => caches.default.delete("bad"),
    "match ignoreMethod 1": async () => caches.default.match("http://a/", { ignoreSearch: true }),
    "new Cache()": () => new Cache(),
    "match ignoreVary false": async () => caches.default.match("http://a/", { ignoreVary: false }),
    "delete ignoreSearch": async () => caches.default.delete("http://a/", { ignoreSearch: true }),
    "put('ftp://a/')": async () => caches.default.put("ftp://a/", new Response("x")),
    // CacheQueryOptions is a dictionary whose fields JSG reads in the order
    // of its struct: ignoreMethod, then the three it won't implement.
    "match(url, 1)": async () => caches.default.match("http://a/", 1),
    "match(url, 'x')": async () => caches.default.match("http://a/", "x"),
    "delete(url, true)": async () => caches.default.delete("http://a/", true),
    "match(url, null)": async () => caches.default.match("http://a/", null),
    "match(url, () => {})": async () => caches.default.match("http://a/", () => {}),
    "match cacheName": async () => caches.default.match("http://a/", { cacheName: "x" }),
    "match ignoreSearch null": async () => caches.default.match("http://a/", { ignoreSearch: null }),
    "match ignoreMethod 'x'": async () => caches.default.match(new Request("http://a/", { method: "POST" }), { ignoreMethod: "x" }),
    "match ignoreMethod throws": async () => caches.default.match("http://a/", { get ignoreMethod() { throw new RangeError("boom"); } }),
    "match field order": async () => fieldOrder((options) => caches.default.match("http://a/", options), undefined),
    "match field order with ignoreSearch": async () => fieldOrder((options) => caches.default.match("http://a/", options), "ignoreSearch"),
    "delete field order with cacheName": async () => fieldOrder((options) => caches.default.delete("http://a/", options), "cacheName"),
  },
  fetch: {
    "fetch()": async () => fetch(),
    "fetch('bad')": async () => fetch("bad"),
    "fetch('ftp://a/')": async () => fetch("ftp://a/"),
    "fetch('data:,x')": async () => (await fetch("data:,x")).text(),
    "fetch('blob:x')": async () => fetch("blob:x"),
    "fetch('wss://a/')": async () => fetch("wss://a/"),
    "fetch('/relative')": async () => fetch("/relative"),
    "fetch GET with body": async () => fetch("http://a/", { body: "x" }),
    "fetch method 'bad method'": async () => fetch("http://a/", { method: "bad method" }),
    "fetch redirect 'bad'": async () => fetch("http://a/", { redirect: "bad" }),
    "fetch aborted": async () => fetch("http://a/", { signal: AbortSignal.abort() }),
  },
  misc: {
    "reportError()": () => reportError(),
    "new HTMLRewriter().on('a', 1)": () => new HTMLRewriter().on("a", 1),
    "new HTMLRewriter().transform(1)": () => new HTMLRewriter().transform(1),
    "new HTMLRewriter().on('a')": () => new HTMLRewriter().on("a"),
    "new HTMLRewriter().onDocument(1)": () => new HTMLRewriter().onDocument(1),
    "new DOMException(1, Symbol())": () => new DOMException("a", Symbol()),
    "new MessageChannel().port1.postMessage(function)": () => new MessageChannel().port1.postMessage(() => {}),
    "new EventSource('bad')": () => new EventSource("bad"),
    "navigator.sendBeacon()": () => navigator.sendBeacon(),
    "performance.mark()": () => performance.mark(),
    "performance.measure('a', 'nope')": () => performance.measure("a", "nope"),
    "new Performance()": () => new Performance(),
    // transform() copies the Response's own state, not what its
    // properties say (html-rewriter.c++ `HTMLRewriter::transform`).
    "transform overridden status": async () => {
      const response = new Response("<p>x</p>", { headers: { "content-type": "text/html" } });
      Object.defineProperty(response, "status", { value: 99 });
      Object.defineProperty(response, "statusText", { value: "a\nb" });
      Object.defineProperty(response, "headers", { value: new Headers({ "content-type": "text/plain", x: "y" }) });
      const out = new HTMLRewriter().transform(response);
      return `${out.status} ${JSON.stringify(out.statusText)} ${out.headers.get("content-type")} ${out.headers.get("x")} ${await out.text()}`;
    },
    "transform overridden body": async () => {
      const response = new Response("<p>x</p>");
      Object.defineProperty(response, "body", { value: new Response("<p>y</p>").body });
      return new HTMLRewriter().transform(response).text();
    },
    "transform statusText": async () => {
      const out = new HTMLRewriter().transform(new Response("x", { status: 201, statusText: "Made" }));
      return `${out.status} ${out.statusText}`;
    },
    "transform null body": () => { const response = new Response(null, { status: 204 }); return new HTMLRewriter().transform(response) === response; },
    "transform error response": () => new HTMLRewriter().transform(Response.error()),
    "connect('bad')": () => {
      // A cloudflare:sockets connect at request time, refused for its address.
      return import("cloudflare:sockets").then(({ connect }) => connect("bad"));
    },
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
