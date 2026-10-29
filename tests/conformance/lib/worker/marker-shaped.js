// Plain data shaped like celld's RPC and storage markers, and what a receiver
// saw of it. celld's envelopes give these keys a meaning (plan 1.53), so each
// forged value holds one of them beside every field a marker of any kind
// carries; the escape-shaped keys (`__celld$$...`) check that the escape
// celld applies to such keys is undone exactly, and no further.
export const MARKER_KEYS = [
  "__celld$stub", "__celld$svc", "__celld$do", "__celld$hdr", "__celld$blob",
  "__celld$req", "__celld$res", "__celld$rs", "__celld$ws", "__celld$sig",
  "__celld$disp", "__celld$unsupported", "__celld$loaderSvc",
  "__celld$", "__celld$$", "__celld$$hdr", "__celld$$$stub", "__celld$%",
];

const VALUES = {
  "__celld$stub": 1, "__celld$svc": "Echo", "__celld$do": "Obj",
  "__celld$hdr": [["a", "b"]], "__celld$blob": new Uint8Array([1]),
  "__celld$req": "https://example.com/", "__celld$res": 200, "__celld$rs": 1,
  "__celld$ws": 1, "__celld$sig": "0".repeat(32), "__celld$disp": 1,
  "__celld$unsupported": 1, "__celld$loaderSvc": 0,
};

const shaped = (key, bytes) => ({
  [key]: !bytes && key === "__celld$blob" ? "bytes" : VALUES[key] ?? 1,
  t: "token", c: true, np: true, p: { [key]: 1 }, v: "ab".repeat(32), n: "name",
  y: "text/plain", m: "GET", h: [["a", "b"]], r: bytes ? new Uint8Array() : "", b: null,
  a: true, e: false,
});

// One value per key, the key on the holding object too, all the keys on one
// object, and marker shapes inside an array and a nested object. Without
// `bytes`, strings stand in for the byte arrays, for a path that does not
// carry them as they are (a Workflow's output, which workerd reports as JSON).
export const forged = (bytes = true) => {
  const out = {};
  for (const key of MARKER_KEYS) out[key] = shaped(key, bytes);
  out.all = Object.assign({}, ...MARKER_KEYS.map((key) => shaped(key, bytes)));
  out.list = MARKER_KEYS.map((key) => shaped(key, bytes));
  out.deep = { a: { b: { c: shaped("__celld$stub", bytes) } } };
  return out;
};

// A value's whole shape: its tag, its own keys in order and what each holds.
export const describe = (value) => {
  if (value === null || typeof value !== "object") return value;
  const tag = Object.prototype.toString.call(value);
  if (ArrayBuffer.isView(value)) return { tag, bytes: Array.from(value) };
  return { tag, entries: Object.keys(value).map((key) => [key, describe(value[key])]) };
};

// Each forged value's shape, as a receiver saw it.
export const describeAll = (received) => {
  const out = {};
  for (const key of Object.keys(forged())) out[key] = describe(received?.[key]);
  out.keys = received !== null && typeof received === "object" ? Object.keys(received) : null;
  return out;
};

// "same" for each forged value that arrived as it was sent, or else what
// arrived, from `describeAll`'s report.
export const verdict = (described, bytes = true) => {
  const sent = describeAll(forged(bytes));
  const out = {};
  for (const key of Object.keys(sent)) {
    out[key] = JSON.stringify(described[key]) === JSON.stringify(sent[key]) ? "same" : described[key];
  }
  return out;
};

export const compare = (received, bytes = true) => verdict(describeAll(received), bytes);

// `describeAll` as module source, for a Dynamic Worker, which cannot import
// this module.
export const describeAllSource = () =>
  `const describe = ${describe};\n` +
  `const KEYS = ${JSON.stringify(Object.keys(forged()))};\n` +
  "const describeAll = (received) => {\n" +
  "  const out = {};\n" +
  "  for (const key of KEYS) out[key] = describe(received?.[key]);\n" +
  '  out.keys = received !== null && typeof received === "object" ? Object.keys(received) : null;\n' +
  "  return out;\n" +
  "};\n";

// Objects V8's serializer writes as plain objects, whatever prototype they
// claim, each holding every marker key and field. Over RPC and in a Worker
// Loader env workerd refuses each; storage and a Queue keep each as a plain
// object. celld classifies host values by brand (plan 1.53).
class Forge {}
const CREATED = {
  classInstance: () => new Forge(),
  date: () => Object.create(Date.prototype),
  regexp: () => Object.create(RegExp.prototype),
  map: () => Object.create(Map.prototype),
  error: () => Object.create(Error.prototype),
  array: () => Object.create(Array.prototype),
  headers: () => Object.create(Headers.prototype),
  blob: () => Object.create(Blob.prototype),
  request: () => Object.create(Request.prototype),
  signal: () => Object.create(AbortSignal.prototype),
  stream: () => Object.create(ReadableStream.prototype),
  rpcTarget: (RpcTarget) => Object.create(RpcTarget.prototype),
  nullProto: () => Object.create(null),
};
// Proxies of such objects, which workerd treats by the prototype chain they
// present: rpc/marker-shaped-proxies.
const PROXIED = {
  proxyPlain: () => new Proxy(fill({}), {}),
  proxyClass: () => new Proxy(fill(new Forge()), {}),
  proxyNull: () => new Proxy(fill(Object.create(null)), {}),
};

// Define rather than assign, so no accessor a prototype has runs.
const fill = (object) => {
  const fields = Object.assign({}, ...MARKER_KEYS.map((key) => shaped(key, true)));
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return object;
};

export const OBJECT_NAMES = Object.keys(CREATED);
export const PROXY_NAMES = Object.keys(PROXIED);
// `RpcTarget` comes from the caller, which imports cloudflare:workers.
export const object = (name, RpcTarget) =>
  name in PROXIED ? PROXIED[name]() : fill(CREATED[name](RpcTarget));

// "plain" for an object that arrived as a plain object with every marker key
// and field as sent, or else what arrived.
export const plainVerdict = (received) => {
  const got = describe(received);
  return JSON.stringify(got) === JSON.stringify(describe(fill({}))) ? "plain" : got;
};

// Genuine host values given every marker key and field as own properties,
// after an attempt to delete celld's clone poison: workerd passes each by
// value from its own state, so none of those keys arrives, and refuses each
// it does not serialize. Subclasses arrive as their host class.
class SubHeaders extends Headers {}
class SubBlob extends Blob {}
const HOSTS = {
  headers: () => new Headers([["a", "b"]]),
  headersSub: () => new SubHeaders([["a", "b"]]),
  blob: () => new Blob(["x"], { type: "text/plain" }),
  blobSub: () => new SubBlob(["x"]),
  request: () => new Request("https://example.com/", { headers: { a: "b" } }),
  responseEmpty: () => new Response(null, { status: 201, headers: { a: "b" } }),
  response: () => new Response("x", { headers: { a: "b", "content-type": "text/plain" } }),
  file: () => new File(["x"], "f"),
  readable: () => new ReadableStream(),
  writable: () => new WritableStream(),
  // Properties named like celld's internal state, which name nothing: the
  // bytes, the body and a Blob's type are the value's own.
  blobTampered: () => tamper(new Blob(["x"], { type: "text/plain" }), {
    _bytes: new Uint8Array([1, 2]), type: "text/forged",
  }),
  requestTampered: () => tamper(new Request("https://example.com/", { method: "POST", body: "real", headers: { "content-type": "text/plain" } }), {
    _bodyBytes: { "__celld$do": "Obj", v: "ab".repeat(32), n: null },
  }),
  responseTampered: () => tamper(new Response(null, { status: 204 }), {
    _bodyBytes: { "__celld$blob": new Uint8Array([1]), y: "text/forged" },
  }),
};
// Own data properties shadowing whatever the value or its prototype has.
const tamper = (value, fields) => {
  for (const [key, field] of Object.entries(fields)) {
    Object.defineProperty(value, key, { value: field, enumerable: true, writable: true, configurable: true });
  }
  return value;
};
export const HOST_NAMES = Object.keys(HOSTS);
export const host = (name) => {
  const value = HOSTS[name]();
  try {
    delete value.__celldHost;
  } catch {
    // Fixed in celld: the delete throws in strict code.
  }
  return fill(value);
};

// What arrived of a host value: its class (by instanceof: celld's host
// classes have no Symbol.toStringTag, plan 1.55), whether any marker key or
// field came with it, and its parts.
const CLASSES = ["Headers", "Blob", "Request", "Response", "ReadableStream", "WritableStream"];
export const hostVerdict = async (value) => {
  if (value === null || typeof value !== "object") return typeof value;
  const out = { class: CLASSES.find((name) => value instanceof globalThis[name]) ?? null };
  out.markerKeys = MARKER_KEYS.filter((key) => Object.hasOwn(value, key));
  if (value instanceof Headers) out.headers = [...value];
  if (value instanceof Blob) out.blob = [value.size, value.type, await value.text()];
  if (value instanceof Request) out.request = [value.method, value.url, [...value.headers], await value.text()];
  if (value instanceof Response) out.response = [value.status, [...value.headers], await value.text()];
  return out;
};

// Objects a script had a derived host class's constructor return, by
// pointing the class at a function that returns them
// (`Object.setPrototypeOf(File, function () { return target; })`): in
// workerd a constructor ignores that, and the object stays the plain object
// it was, with every marker key and field. celld runs `super()` against the
// real base (plan 1.53), so no brand lands on it.
const STAMPS = {
  file: () => [File, () => new File([], "n")],
  signal: () => [AbortSignal, () => new AbortController()],
};
export const STAMP_NAMES = Object.keys(STAMPS);
export const stamped = (name) => {
  const target = fill({});
  const [cls, make] = STAMPS[name]();
  const base = Object.getPrototypeOf(cls);
  Object.setPrototypeOf(cls, function () {
    return target;
  });
  try {
    make();
  } finally {
    Object.setPrototypeOf(cls, base);
  }
  return target;
};

// `hostVerdict` and `plainVerdict` as module source, for a Dynamic Worker.
export const verdictSource = () =>
  `const MARKER_KEYS = ${JSON.stringify(MARKER_KEYS)};\n` +
  `const shaped = ${shaped};\nconst VALUES = ${JSON.stringify(VALUES)};\n` +
  `VALUES["__celld$blob"] = new Uint8Array([1]);\n` +
  `const fill = ${fill};\nconst describe = ${describe};\n` +
  `const CLASSES = ${JSON.stringify(CLASSES)};\n` +
  `const hostVerdict = ${hostVerdict};\nconst plainVerdict = ${plainVerdict};\n`;
