// The DO object model and the Cloudflare-compatible runtime surface, run
// once per isolate by `js.rs::install_harness` after the Web-API prelude.
// Lived as a 4,000-line raw string inside js.rs until 2026-07-29; it is a
// JavaScript program and belongs in a .js file, like the rest of src/js/.
//
// Intrinsics the handed-over WebSocket path uses, captured before any
// application code runs, as tracing.js does, so that a Worker that replaces
// JSON.parse or the WeakMap methods does not see that path's host results.
const __ReflectApply = Reflect.apply;
const __JSONParse = JSON.parse;
const __jsonParse = (text) => __ReflectApply(__JSONParse, JSON, [text]);
const __SafeWeakMap = WeakMap;
const __WeakMapGet = WeakMap.prototype.get;
const __WeakMapSet = WeakMap.prototype.set;
const __WeakMapHas = WeakMap.prototype.has;
const __WeakMapDelete = WeakMap.prototype.delete;
const __SafeWeakSet = WeakSet;
const __WeakSetAdd = WeakSet.prototype.add;
const __WeakSetHas = WeakSet.prototype.has;
const __SafeMap = Map;
const __MapGet = Map.prototype.get;
const __MapSet = Map.prototype.set;
const __MapDelete = Map.prototype.delete;
const __JSONStringify = JSON.stringify;
const __jsonStringify = (value) => __ReflectApply(__JSONStringify, JSON, [value]);
const __ArrayFrom = Array.from;
const __ArraySort = Array.prototype.sort;
const __FunctionBind = Function.prototype.bind;
const __ObjectDefineProperty = Object.defineProperty;
const __ObjectHasOwn = Object.hasOwn;
const __ObjectKeys = Object.keys;
const __ObjectGetPrototypeOf = Object.getPrototypeOf;
const __ObjectPrototype = Object.prototype;
const __ArrayPush = Array.prototype.push;
// A derived class's `super()` calls whatever the class's [[Prototype]] is
// at that moment, which a script can set (`Object.setPrototypeOf(File,
// function () { return target; })`), and the class's private fields then
// land on the object that call returned: a script could have any object
// stamped with a host class's brand. Each derived host class records its real
// base (`__recordBase`, from a static block) and runs its `super()` between
// `__pinBase` and `__unpinBase`, which point it at that base for the call
// and then restore whatever the script set, so the script still sees its own
// change and every instance is one its base really constructed. A class the
// script made non-extensible after changing its prototype cannot be pinned,
// and its construction throws.
const __realBases = new __SafeWeakMap();
const __recordBase = (cls) => __ReflectApply(__WeakMapSet, __realBases,
  [cls, { base: __ObjectGetPrototypeOf(cls), name: cls.name }]);
const __pinBase = (cls) => {
  const current = __ObjectGetPrototypeOf(cls);
  const { base, name } = __ReflectApply(__WeakMapGet, __realBases, [cls]);
  if (current !== base) {
    try {
      __ObjectSetPrototypeOf(cls, base);
    } catch {
      throw new TypeError("Failed to construct '" + name + "': its " +
        "prototype was replaced and it was made non-extensible.");
    }
  }
  return current;
};
// A script that set the prototype again during `super()` and made the class
// non-extensible keeps what it set last.
const __unpinBase = (cls, current) => {
  if (current === __ReflectApply(__WeakMapGet, __realBases, [cls]).base)
    return;
  try {
    __ObjectSetPrototypeOf(cls, current);
  } catch {
    // The class is non-extensible with the script's own prototype.
  }
};
// The brands of the harness's own host classes, set by each class's static
// block (`__hostKind`).
let __isRequest, __isResponse, __isBlob, __isFile, __isAbortSignal,
  __isRpcTarget;
// A Request's or Response's buffered body (null for a stream body), and a
// Blob's bytes: private, so what a subrequest, a lift or a read sends is
// the value's own, never a property a script set. undefined for an object
// that is no Request, Response or Blob.
let __requestBodyBytes, __setRequestBodyBytes, __responseBodyBytes,
  __setResponseBodyBytes, __blobBytesOf, __blobTypeOf, __setBlobBytes;
const __bodyBytesOf = (owner) =>
  owner === null || typeof owner !== "object" ? undefined
    : __isRequest(owner) ? __requestBodyBytes(owner)
    : __isResponse(owner) ? __responseBodyBytes(owner)
    : undefined;
const __setBodyBytes = (owner, bytes) => {
  if (__isRequest(owner)) __setRequestBodyBytes(owner, bytes);
  else __setResponseBodyBytes(owner, bytes);
};
const __Array = Array;
const __ArrayFill = Array.prototype.fill;
const __ObjectSetPrototypeOf = Object.setPrototypeOf;
// A property of a host result only if the result has it itself, so a getter
// a Worker put on Object.prototype never answers for a missing one.
const __own = (object, key) =>
  __ObjectHasOwn(object, key) ? object[key] : undefined;
// JSON for host op arguments, built from primitives only: JSON.stringify
// would consult a `toJSON` a Worker put on Object.prototype or
// Array.prototype.
const __jsonString = (value) => __jsonStringify(String(value));
const __jsonStringList = (values) => {
  let out = "[";
  for (let index = 0; index < values.length; index++) {
    if (index > 0) out += ",";
    out += __jsonString(values[index]);
  }
  return out + "]";
};
function __bodyBytes(body) {
  if (body == null) return new Uint8Array();
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body))
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
  return new TextEncoder().encode(String(body));
}
// Bodies that carry their own Content-Type. A Blob's is its `type`, a
// FormData serializes to multipart with a generated boundary, and a
// URLSearchParams to urlencoded. Returns null for every other body so the
// caller falls through to __bodyBytes. Blob, File, FormData and
// URLSearchParams are all installed later in this file; this runs per
// request, long after that.
function __typedBody(body) {
  if (body == null || typeof body !== "object") return null;
  if (globalThis.Blob && __isBlob(body))
    return { bytes: __blobBytesOf(body).slice(), type: __blobTypeOf(body) };
  if (globalThis.FormData && body instanceof FormData)
    return __multipartBody(body);
  if (globalThis.URLSearchParams && body instanceof URLSearchParams)
    return {
      bytes: new TextEncoder().encode(String(body)),
      type: "application/x-www-form-urlencoded;charset=UTF-8",
    };
  return null;
}
// The WHATWG escape for a multipart field name or filename. It is one-way:
// a parser does not undo it, so a name containing a quote round-trips as
// `%22` rather than the original character.
function __mimeEscape(value) {
  value = String(value);
  // A trailing backslash would escape the closing quote of the parameter and
  // run the header into the part body, so it is refused rather than encoded.
  // Workerd refuses it with this exact message.
  if (value.endsWith("\\"))
    throw new TypeError("Name or filename can't end with backslash");
  return value
    .replace(/\n/g, "%0A").replace(/\r/g, "%0D").replace(/"/g, "%22");
}
// Serialize a FormData into a multipart/form-data body. The boundary must
// not occur in any part; 16 random bytes make that collision unreachable,
// and the delimiter stays unquoted so a `boundary=` parameter needs no
// quoting.
function __multipartBody(form) {
  const random = new Uint8Array(16);
  if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(random);
  else for (let i = 0; i < random.length; i++)
    random[i] = Math.floor(Math.random() * 256);
  const boundary = "----celldFormBoundary" +
    Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const encoder = new TextEncoder();
  const chunks = [];
  for (const [name, value] of form) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${
      __mimeEscape(name)
    }"`;
    if (__isBlob(value)) {
      header += `; filename="${__mimeEscape(value.name)}"`;
      header += `\r\nContent-Type: ${value.type || "application/octet-stream"}`;
    }
    chunks.push(encoder.encode(`${header}\r\n\r\n`));
    chunks.push(__isBlob(value) ? __blobBytesOf(value) : encoder.encode(value));
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, type: `multipart/form-data; boundary=${boundary}` };
}
function __chunkBytes(chunk) {
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk))
    return new Uint8Array(
      chunk.buffer, chunk.byteOffset, chunk.byteLength);
  throw new TypeError(
    "Iterable bodies must produce ArrayBuffer or " +
    "ArrayBufferView chunks");
}
// Workerd's "gen" bodies: async iterables become a body stream;
// sync iterables of buffers/views concatenate eagerly. Called only
// for object bodies that are not streams or Blobs -- an object with
// a custom toString/@@toPrimitive stringifies instead, unless it is
// an array or async-iterable (Workerd's precedence). Returns null
// for the string-coercion path.
function __iterableBody(body) {
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body))
    return null;
  const asyncIter = body[Symbol.asyncIterator];
  if (typeof asyncIter === "function") {
    const iterator = asyncIter.call(body);
    return new ReadableStream({
      async pull(controller) {
        const result = await iterator.next();
        if (result.done) { controller.close(); return; }
        controller.enqueue(__chunkBytes(result.value));
      },
      cancel(reason) {
        if (typeof iterator.return === "function")
          iterator.return(reason);
      },
    }, { highWaterMark: 0 });
  }
  if (!Array.isArray(body) &&
      (body.toString !== Object.prototype.toString ||
       body[Symbol.toPrimitive] !== undefined))
    return null;
  if (typeof body[Symbol.iterator] !== "function") return null;
  const chunks = [];
  let length = 0;
  for (const chunk of body) {
    if (!(chunk instanceof ArrayBuffer) && !ArrayBuffer.isView(chunk))
      return null;
    const view = __chunkBytes(chunk);
    chunks.push(view);
    length += view.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const view of chunks) {
    bytes.set(view, offset);
    offset += view.byteLength;
  }
  return bytes;
}
// Drain a Request/Response body stream, caching the result on the
// instance so later consumers see the materialized bytes.
// Bodies drained into a buffer nothing else holds, which a whole-body read
// can hand over instead of copying (`__handOverBody`).
const __ownedBodies = new WeakSet();
// Requests and responses whose drained buffer was handed over. Their body is
// used: a later read throws, as in workerd, where it would otherwise see
// what the reader did to the buffer.
const __handedOverBodies = new WeakSet();
const __BODY_USED =
  "Body has already been used. It can only be used once. " +
  "Use tee() first if you need to read it multiple times.";
// The drained body as an ArrayBuffer the caller may keep, without a copy
// when nothing else holds it, so a whole-body read holds the body once.
const __handOverBody = (target, bytes) => {
  if (!__ownedBodies.delete(bytes) ||
      bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength)
    return bytes.slice().buffer;
  __handedOverBodies.add(target);
  __setBodyBytes(target, new Uint8Array(0));
  return bytes.buffer;
};
// The rest of a body stream, as one buffer nothing else holds. A host
// stream is read whole by the host, so the body is held once rather than as
// chunks and then a copy. `expected` is its length when known, which the
// host refuses at once past the isolate's memory limit.
async function __drainStream(stream, expected = stream?._expectedLength) {
  const id = __hostStreamId(stream);
  if (id !== undefined && !stream.locked) {
    // Locked as a read would lock it: the host reads it now.
    stream.getReader();
    return __http_stream_read_all(id, expected);
  }
  const chunks = [];
  let length = 0;
  const reader = stream.getReader();
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    length += result.value.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
async function __drainBody(target) {
  const bytes = await __drainStream(target.body);
  __ownedBodies.add(bytes);
  __setBodyBytes(target, bytes);
  // text() memoizes into _body on demand. Decoding here charges every
  // binary passthrough the cost of a string it never reads.
  target._body = undefined;
  return bytes;
}
// The next chunk of a platform stream, for either kind of reader: what a BYOB
// read left of a chunk comes first, then the source. `null` is the end.
const __chunkTake = (st) => {
  const rest = st.rest;
  if (rest !== null) {
    st.rest = null;
    return rest;
  }
  if (st.done) return null;
  const pulled = st.pulling = Promise.resolve(st.pull()).then(
    (chunk) => {
      st.pulling = null;
      if (chunk === null) st.done = true;
      return chunk;
    },
    (error) => {
      st.pulling = null;
      throw error;
    },
  );
  return pulled;
};
const __chunkCopy = (chunk) => ArrayBuffer.isView(chunk)
  ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice()
  : chunk;
// workerd converts a cancel reason into an Error before it rejects the read
// in flight with it (cancelErrorTypePropagation).
const __cancelError = (reason) => reason instanceof Error
  ? reason
  : new Error(reason === undefined ? "Stream was cancelled." : String(reason));
// A platform stream: a body, a Blob's stream, a compression stream's output, a
// stream received over RPC. In workerd these are internal byte streams, so a
// BYOB reader works on them. `pull()` returns the next chunk (or a promise of
// it), `null` at the end; `cancel(reason)` stops the source.
//
// A default reader reads through the ordinary stream machinery, with the
// internal-stream contract streams.js gives the streams registered with
// `__streamIo.internal`. A BYOB reader reads through `_ictl`, an internal
// controller over the same chunks (see ChunkedInternalController in
// byte_streams.js). Both have workerd's internal-stream semantics: one read
// at a time, a cancel that rejects the read in flight, and for BYOB a
// Uint8Array whatever the view's type. `_ictl` names ReadableStreamBYOBReader, which compiles the lazy
// byte-stream prelude, so a Worker that never asks for a BYOB reader never
// pays for it.
class CelldChunkStream extends ReadableStream {
  static { __recordBase(this); }
  constructor(pull, cancel) {
    const st = {
      pull, rest: null, done: false, pulling: null, cancelled: false,
    };
    const set = __pinBase(CelldChunkStream);
    try {
      super({
        async pull(controller) {
          const chunk = await __chunkTake(st);
          // A cancel while the source was pulled has closed the stream.
          if (st.cancelled) return;
          if (chunk === null) controller.close();
          else controller.enqueue(chunk);
        },
        cancel(reason) {
          if (st.cancelled) return;
          st.cancelled = true;
          st.rest = null;
          if (st.done) return;
          st.done = true;
          return cancel?.(reason);
        },
      }, { highWaterMark: 0 });
    } finally {
      __unpinBase(CelldChunkStream, set);
    }
    this._chunks = st;
    __celld.__streamIo.internal(this);
  }
  getReader(options) {
    if (options !== undefined && options !== null &&
        options.mode !== undefined) {
      if (String(options.mode) !== "byob")
        throw new TypeError(
          "mode must be undefined or 'byob' in call to getReader().");
      return new ReadableStreamBYOBReader(this);
    }
    return super.getReader();
  }
  // The internal controller BYOB readers use, made on the first one.
  get _ictl() {
    return this._byob ??= ReadableStreamBYOBReader._chunked(this);
  }
  _take() { return __chunkTake(this._chunks); }
  _cancel(reason) {
    this._byob?._cancelled(reason);
    if (this._readRequests.length > 0) {
      const error = __cancelError(reason);
      for (const request of this._readRequests) request.reject(error);
      this._readRequests = [];
    }
    return super._cancel(reason);
  }
  // Branches of the same kind, read from one default reader on this stream.
  // A chunk goes to both. While both are live the second gets a copy, as a
  // spec byte-stream tee clones its chunks, so neither branch's reader can
  // detach or change what the other reads; `cloneForBranch2` makes that a
  // structured clone. A branch that is not read buffers what the other one
  // reads, as in a spec tee.
  tee(cloneForBranch2 = false) {
    const reader = this.getReader();
    const queues = [[], []];
    const cancelled = [false, false];
    const reasons = [undefined, undefined];
    let ended = false;
    let reading = null;
    const read = () => reader.read().then(({ done, value }) => {
      reading = null;
      if (done) {
        ended = true;
        return;
      }
      if (!cancelled[0]) queues[0].push(value);
      if (!cancelled[1])
        queues[1].push(cloneForBranch2 ? structuredClone(value)
          : cancelled[0] ? value : __chunkCopy(value));
    }, (error) => {
      reading = null;
      throw error;
    });
    const branch = (i) => new CelldChunkStream(async () => {
      for (;;) {
        if (queues[i].length > 0) return queues[i].shift();
        if (ended) return null;
        await (reading ??= read());
      }
    }, (reason) => {
      cancelled[i] = true;
      reasons[i] = reason;
      queues[i] = [];
      if (cancelled[0] && cancelled[1]) return reader.cancel(reasons);
    });
    const branches = [branch(0), branch(1)];
    reader.closed.catch((error) => {
      for (const b of branches)
        if (!b._closed && !b._errored) b._controller.error(error);
    });
    return branches;
  }
}
// workerd refuses, as a Request or Response body, a stream that has been
// read from (a read in flight counts), and, for a Response, one locked to a
// reader. A fetch() refuses a Request whose body is locked.
const __BODY_DISTURBED = "This ReadableStream is disturbed (has already " +
  "been read from), and cannot be used as a body.";
const __usableBody = (stream, response) => {
  if (stream._disturbed) throw new TypeError(__BODY_DISTURBED);
  if (response && stream._locked)
    throw new TypeError("This ReadableStream is currently locked to a reader.");
  return stream;
};
// A subrequest takes its body's stream over, so the stream must be free.
const __unlockedBody = (req) => {
  if (req.body?._locked)
    throw new TypeError("The ReadableStream has been locked to a reader.");
};
// A body whose bytes are in the isolate. Chunks are views of those bytes.
class CelldBodyStream extends CelldChunkStream {
  static { __recordBase(this); }
  constructor(owner) {
    // Couple the stream to its buffered owner, so _bodyBytes and the stream
    // cannot be installed from different arrays. Copying the owner's bytes
    // again here doubles the external memory held for every constructed body.
    if (!(owner instanceof globalThis.Request) &&
        !(owner instanceof globalThis.Response))
      throw new TypeError("CelldBodyStream requires a buffered body owner");
    const bytes = __bodyBytesOf(owner);
    if (!(bytes instanceof Uint8Array))
      throw new TypeError("CelldBodyStream owner requires buffered body bytes");
    const st = { bytes, off: 0 };
    const set = __pinBase(CelldBodyStream);
    try {
      super(() => {
        if (st.off >= st.bytes.byteLength) return null;
        const end = Math.min(st.off + 64 * 1024, st.bytes.byteLength);
        const chunk = st.bytes.subarray(st.off, end);
        st.off = end;
        return chunk;
      });
    } finally {
      __unpinBase(CelldBodyStream, set);
    }
    this._st = st;
    // Known length, so re-using this stream as a subrequest body
    // still advertises Content-Length.
    this._expectedLength = bytes.byteLength;
  }
  // Cancelling a body stream poisons later consumption: text()
  // and friends reject, as they would over a real socket.
  _cancel(reason) {
    this._cancelled = true;
    return super._cancel(reason);
  }
}
// The host stream behind `body`, for a consumer that can take it over (a
// subrequest or response body, a tee), or undefined. Only a host body has
// one, and only while none of its bytes are held here: the part of a chunk a
// BYOB read left, or a read in flight. A brand check, not a property: a
// stream id is a capability for whatever body the host holds under it, and a
// Worker can put any property on its own stream. A body another request or
// Durable Object owns throws workerd's error, so no consumer takes it over.
let __hostStreamId;
// A body the host holds: a fetched body, a streamed request body, an R2
// object's body, a Dynamic Worker's response. Each chunk is a Uint8Array the
// host moved in without a copy.
//
// The body belongs to the request or Durable Object that received it, as in
// workerd, where it is an I/O object of that IoContext: reading, cancelling,
// teeing or sending it on from any other fails with workerd's cross-request
// error, before the stream's own state is consulted (`__streamIo.own` in
// streams.js). The host refuses the id the same way (plan 1.26).
class CelldHttpBodyStream extends CelldChunkStream {
  #id;
  static {
    __recordBase(this);
    __hostStreamId = (body) => {
      if (typeof body !== "object" || body === null || !(#id in body))
        return undefined;
      __celld.__streamIo.check(body);
      const st = body._chunks;
      return st.rest === null && st.pulling === null && !st.done &&
          body._queue.length === 0
        ? body.#id
        : undefined;
    };
  }
  constructor(streamId) {
    const id = Number(streamId);
    const set = __pinBase(CelldHttpBodyStream);
    try {
      super(async () => {
        // The end of the stream arrives as a string.
        const chunk = await __http_stream_read(id);
        return typeof chunk === "string" ? null : chunk;
      }, () => { __http_stream_cancel(id); });
    } finally {
      __unpinBase(CelldHttpBodyStream, set);
    }
    this.#id = id;
    __celld.__streamIo.own(this, "ReadableStreamSource");
  }
  tee(cloneForBranch2 = false) {
    __celld.__streamIo.check(this);
    if (this.locked) throw new TypeError("ReadableStream is locked");
    const id = __hostStreamId(this);
    if (id === undefined) return super.tee(cloneForBranch2);
    this._locked = true;
    this._disturbed = true;
    const [left, right] = JSON.parse(__http_stream_tee(id));
    return [
      new CelldHttpBodyStream(left),
      new CelldHttpBodyStream(right),
    ];
  }
}
// Body streams expose the standard constructor to consumers. In particular,
// the Python Workers SDK validates JS body types by constructor.name.
// Keep the internal prototypes and their specialized read/tee behavior.
for (const bodyStream of [CelldChunkStream, CelldBodyStream, CelldHttpBodyStream]) {
  Object.defineProperty(bodyStream.prototype, "constructor", {
    value: ReadableStream, writable: true, configurable: true,
  });
}
__celld.__makeInternalByteStream = (pull, cancel) =>
  new CelldChunkStream(pull, cancel);
// What a body method left: workerd reads the stream to its end, which
// leaves it locked to the reader, so a clone fails on the lock. celld reads a
// buffered body without its stream, so a flag stands in for the lock. A
// stream's own reads and cancels make it disturbed instead. `bodyUsed` is
// either, and only a body has one (`Body::getBodyUsed` in api/http.c++).
const __bodyUsed = (target) => target.body !== null &&
  (target._bodyUsed || target.body._disturbed === true);
// workerd reads a body stream that is closed, and was never read from,
// without a reader: it gives nothing, and the body stays unused (a tee of a
// finished stream has two of them).
const __closedUnread = (body) =>
  body != null && body._closed === true && body._disturbed !== true;
const __markBodyRead = (target) => {
  if (!__closedUnread(target.body)) target._bodyUsed = true;
};
// workerd's clone of a body (`Body::clone` in api/http.c++): the stream is
// teed, the original keeps one branch and the clone gets the other, so both
// are unused again after a partial read. A buffered body nothing has read
// stays buffered in both, as a copy.
const __cloneBody = (target) => {
  const body = target.body;
  if (body === null) return null;
  if (target._bodyUsed || body.locked)
    throw new TypeError("This ReadableStream is currently locked to a reader,");
  if (__bodyBytesOf(target) !== null && body instanceof CelldBodyStream &&
      !body._disturbed)
    return __bodyBytesOf(target);
  const [left, right] = body.tee();
  target.body = left;
  __setBodyBytes(target, null);
  return right;
};
// workerd converts a Response's status as a WebIDL `long`: a value that is
// not a finite number is 0, a fraction truncates (-0.5 to 0, not -0), and a
// value outside the 32-bit range throws.
const __statusOf = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const status = Math.trunc(number);
  if (status < -2147483648 || status > 2147483647)
    throw new TypeError(
      "Value out of range. Must be between -2147483648 and 2147483647 (inclusive).");
  return status === 0 ? 0 : status;
};
// The Response that a network response becomes passes this as the
// constructor's third argument, which no application code can reach. An
// origin can answer with any three-digit status, and workerd builds that
// Response without the constructor's checks.
const __NETWORK_RESPONSE = Object.freeze({ __proto__: null });
const __networkResponse = (body, init) => new __NetworkResponse(body, init, __NETWORK_RESPONSE);
globalThis.Response = class Response {
  // Read-only, as in workerd, so the socket a response carries is the one it
  // was made with.
  #webSocket = null;
  // The buffered body, or null for a stream body (`__bodyBytesOf`).
  #bodyBytes = null;
  // The brand the RPC envelope classifies by (`__hostKind`).
  static {
    __isResponse = (value) =>
      typeof value === "object" && value !== null && #webSocket in value;
    __responseBodyBytes = (response) => response.#bodyBytes;
    __setResponseBodyBytes = (response, bytes) => {
      response.#bodyBytes = bytes;
    };
  }
  get webSocket() { return this.#webSocket; }
  constructor(body, init = {}, origin = undefined) {
    const fromNetwork = origin === __NETWORK_RESPONSE;
    // Streaming/iterable detection runs only for object bodies, so
    // the common string path skips every instanceof below.
    let stream = null;
    let typed = null;
    if (body !== null && typeof body === "object") {
      if (body instanceof ReadableStream) stream = __usableBody(body, true);
      else if ((typed = __typedBody(body)) !== null) { /* bytes and type */ }
      else {
        const iterable = __iterableBody(body);
        if (iterable instanceof ReadableStream) stream = iterable;
        else if (iterable !== null) body = iterable;
      }
    }
    this.#bodyBytes = stream !== null
      ? null
      : typed ? typed.bytes : __bodyBytes(body);
    // Never decoded eagerly: a whole-body UTF-8 decode costs seconds for a
    // large binary body (an archive, a git pack) and can exceed V8's string
    // length. On Response the field is deliberately write-only -- text()
    // decodes fresh from _bodyBytes and only Request.text() memoizes into
    // _body -- but the assignment stays: __drainBody and __adoptBody assign
    // _body on both classes, so defining it here keeps the hidden-class
    // shape stable. Do not add a Response reader; do not "simplify" this
    // away.
    this._body = undefined;
    // Hono rebuilds a response after middleware with
    // `new Response(response.body, response)`; the held stream (or a
    // fresh CelldBodyStream) preserves the payload across that
    // standard clone shape.
    this.body = body == null
      ? null
      : stream !== null
        ? stream
        : new CelldBodyStream(this);
    this.status = init.status === undefined
      ? 200
      : fromNetwork ? Number(init.status) : __statusOf(init.status);
    this.statusText = init.statusText === undefined ? "" : String(init.statusText);
    this.headers = new Headers(init.headers);
    if (typed && typed.type && !this.headers.has("content-type"))
      this.headers.set("content-type", typed.type);
    const webSocket = init.webSocket ?? null;
    if (webSocket !== null && !__wsIsSocket(webSocket))
      throw new TypeError(
        "Failed to construct 'Response': member webSocket is not of type WebSocket.");
    this.#webSocket = webSocket;
    // Workerd admits 101, and only 101, for a response that carries a
    // WebSocket. A cross-isolate upgrade carries a client end made from the
    // target.
    if (fromNetwork) {
      // As the origin sent it.
    } else if (webSocket === null) {
      if (this.status < 200 || this.status > 599)
        throw new RangeError(
          "Responses may only be constructed with status codes in the range " +
          "200 to 599, inclusive.");
    } else if (this.status !== 101) {
      throw new RangeError("Responses with a WebSocket must have status code 101.");
    }
    this.ok = this.status >= 200 && this.status <= 299;
    this.redirected = false;
    this.type = "default";
    this.url = "";
    this._bodyUsed = false;
    if (init.cf !== undefined) this.cf = init.cf;
  }
  static json(data, init = {}) {
    const headers = new Headers(init.headers || {});
    if (!headers.has("content-type"))
      headers.set("content-type", "application/json");
    return new Response(JSON.stringify(data), { ...init, headers });
  }
  static redirect(url, status = 302) {
    const input = String(url);
    const statusCode = Number(status) | 0;
    if (![301, 302, 303, 307, 308].includes(statusCode)) {
      throw new RangeError(
        `${statusCode} is not a redirect status code. ` +
        "It must be one of: 301, 302, 303, 307, or 308.");
    }
    const response = new Response(null, {
      status: statusCode,
      headers: { Location: new URL(input).href },
    });
    // A redirect response owns a guarded header list. Without the guard, an
    // application can rewrite Location after construction, which differs
    // from both Fetch and Workerd even though the initial response is valid.
    Object.defineProperty(response.headers, "_immutable", { value: true });
    return response;
  }
  static error() {
    const response = new Response(null);
    response.status = 0;
    response.ok = false;
    response.type = "error";
    return response;
  }
  async _consume() {
    if (__handedOverBodies.has(this)) throw new TypeError(__BODY_USED);
    if (__closedUnread(this.body)) return new Uint8Array();
    if (__bodyBytesOf(this) !== null) {
      if (this.body !== null && this.body._cancelled)
        throw new TypeError(
          "Body has already been used. It can only be used once. " +
          "Use tee() first if you need to read it multiple times.");
      return __bodyBytesOf(this);
    }
    return __drainBody(this);
  }
  async text() {
    __markBodyRead(this);
    return new TextDecoder().decode(await this._consume());
  }
  async json() { return JSON.parse(await this.text()); }
  async formData() {
    // The undecoded bytes, not `text()`: a UTF-8 decode replaces each invalid
    // sequence in a binary file part with one U+FFFD, so both the bytes and
    // the length change.
    __markBodyRead(this);
    return __celld.__parseFormData(
      await this._consume(), this.headers.get('content-type'));
  }
  async arrayBuffer() {
    __markBodyRead(this);
    return __handOverBody(this, await this._consume());
  }
  async blob() {
    return __celld.__blobOf(await this.arrayBuffer(),
      this.headers.get("content-type") || "");
  }
  get bodyUsed() { return __bodyUsed(this); }
  // workerd's `Response::clone`: the clone has the body's other branch, a
  // copy of the headers with their guard, a copy of `cf`, and the same
  // status, statusText, URL list and type. The constructor's checks don't
  // apply, as a network response's don't, so `Response.error()` clones.
  clone() {
    if (this.#webSocket !== null)
      throw new TypeError("Cannot clone a response to a WebSocket handshake.");
    const body = __cloneBody(this);
    const response = __networkResponse(body, {
      status: this.status,
      statusText: this.statusText,
      // The list, not the iterator, which combines and lower-cases.
      headers: this.headers.__celldHeaderList,
      cf: this.cf === undefined ? undefined : structuredClone(this.cf),
    });
    if (this.headers._immutable)
      Object.defineProperty(response.headers, "_immutable", { value: true });
    response.type = this.type;
    response.url = this.url;
    response.redirected = this.redirected;
    return response;
  }
};
// Captured as it is defined: a Worker that replaces globalThis.Response
// must not receive the network token.
const __NetworkResponse = globalThis.Response;
// Hoisted: this would otherwise allocate an array and scan it on
// every Request construction, which is the HTTP hot path.
const __HTTP_METHODS = new Set(
  ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]);
// workerd parses a redirect mode ignoring ASCII case (`tryParseRedirect` in
// api/http.c++), and has no "error" mode.
const __parseRedirectMode = (value) => {
  const mode = String(value).replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (mode === "follow" || mode === "manual") return mode;
  throw new TypeError(
    'Invalid redirect value, must be one of "follow" or "manual" ("error" ' +
    "won't be implemented since it does not make sense at the edge; use " +
    '"manual" and check the response status code).');
};
globalThis.Request = class Request {
  // The brand the RPC envelope classifies by (`__hostKind`).
  #brand;
  // The buffered body, or null for a stream body (`__bodyBytesOf`).
  #bodyBytes = null;
  static {
    __isRequest = (value) =>
      typeof value === "object" && value !== null && #brand in value;
    __requestBodyBytes = (request) => request.#bodyBytes;
    __setRequestBodyBytes = (request, bytes) => {
      request.#bodyBytes = bytes;
    };
  }
  constructor(input, init = {}) {
    const prior = input instanceof Request ? input : null;
    const suppliedSignal = init.signal !== undefined;
    // The cache option needs the cache_option_enabled compat flag,
    // which Cells does not implement (Workerd's cache-disabled path).
    if (init.cache !== undefined)
      throw new Error("The 'cache' field on 'RequestInitializerDict' " +
        "is not implemented.");
    this.url = prior ? prior.url : String(input);
    {
      // Workers upper-cases every method (the
      // upper_case_all_http_methods flag) but rejects anything outside
      // the known set, reporting the original casing.
      const raw = String(init.method === undefined
        ? (prior ? prior.method : "GET") : init.method);
      const upper = raw.toUpperCase();
      if (!__HTTP_METHODS.has(upper))
        throw new TypeError(`Invalid HTTP method string: ${raw}`);
      this.method = upper;
    }
    const hasBody =
      Object.prototype.hasOwnProperty.call(init, "body");
    let body = hasBody ? init.body : null;
    let stream = null;
    let typed = null;
    if (hasBody && body !== null && typeof body === "object") {
      if (body instanceof ReadableStream) stream = __usableBody(body, false);
      else if ((typed = __typedBody(body)) !== null) { /* bytes and type */ }
      else {
        const iterable = __iterableBody(body);
        if (iterable instanceof ReadableStream) stream = iterable;
        else if (iterable !== null) body = iterable;
      }
    }
    if (!hasBody && prior && __bodyBytesOf(prior) === null) {
      // Adopt the prior request's stream; per spec the prior body
      // is disturbed by the new request.
      stream = prior.body;
      prior._bodyUsed = true;
    }
    this.#bodyBytes = stream !== null
      ? null
      : hasBody
        ? (typed ? typed.bytes : __bodyBytes(body))
        : (prior ? __bodyBytesOf(prior).slice() : new Uint8Array());
    // An incoming request's body is a one-time stream in workerd, even when
    // celld holds it as bytes, so a redirect can't send it again
    // (see __fetchThrough). A copy that adopts the body keeps that.
    this._oneTimeBody = init.__celldOneTimeBody === true ||
      (!hasBody && prior !== null && prior._oneTimeBody);
    // Body text is decoded on the first text()/json(), not here: a request
    // whose body is never read never pays the decode.
    this._body = undefined;
    // Headers are stored raw and built on the first `.headers` access. The
    // hot paths -- a hello world, a Worker that only forwards to a cell --
    // read none, so `new Headers` and the JSON.parse behind it never run.
    if (init.__headersJson !== undefined) {
      this._headersJson = init.__headersJson;
      this._headersInit = undefined;
    } else if (init.headers === undefined && prior) {
      this._headersJson = prior._headersJson;
      // Per spec `new Request(request)` copies the header list. The prior
      // request's `Headers` object cannot stand in for it: `new Headers(h)`
      // reads `h` through its iterator, which sorts, lower-cases and
      // combines, so forwarding a request whose headers were read would
      // undo the wire shape the outbound paths preserve.
      this._headersInit = prior._headers
        ? prior._headers.__celldHeaderList
        : prior._headersInit;
    } else {
      this._headersJson = undefined;
      this._headersInit = init.headers;
    }
    this._headers = null;
    // A typed body's default content-type must land now; only user-built
    // typed bodies reach this, never the incoming request path.
    if (typed && typed.type && !this.headers.has("content-type")) {
      this.headers.set("content-type", typed.type);
    }
    this._bodyUsed = false;
    // The body stream and the signal stay eager, own properties: the RPC and
    // storage serializers fall back to the lift-into-marker path only when a
    // value is not directly structured-cloneable, and a Request's un-cloneable
    // body stream (or AbortSignal) is what triggers that. Making them lazy
    // getters let `__sc_encode` clone the Request into a broken plain object
    // and skip the lift -- the serializeHttpTypes conformance failure.
    this.body = stream !== null
      ? stream
      : ["GET", "HEAD"].includes(this.method)
        ? null : new CelldBodyStream(this);
    this.redirect = init.redirect === undefined
      ? (prior ? prior.redirect : "follow")
      : __parseRedirectMode(init.redirect);
    const cf = init.cf === undefined
      ? (prior ? prior.cf : undefined) : init.cf;
    if (cf !== undefined) this.cf = cf;
    this.signal = suppliedSignal
      ? init.signal
      : (prior ? prior.signal : new AbortController().signal);
    this._signalForSubrequests = init.__celldIncomingSignal
      ? null
      : suppliedSignal
        ? this.signal
        : (prior ? prior._signalForSubrequests : null);
  }
  get headers() {
    if (this._headers === null) {
      const src = this._headersJson !== undefined
        ? JSON.parse(this._headersJson)
        : this._headersInit;
      this._headers = new Headers(src);
      this._headersJson = undefined;
      this._headersInit = undefined;
    }
    return this._headers;
  }
  set headers(value) {
    this._headers = value instanceof Headers ? value : new Headers(value);
    this._headersJson = undefined;
    this._headersInit = undefined;
  }
  async _consume() {
    if (__handedOverBodies.has(this)) throw new TypeError(__BODY_USED);
    if (__closedUnread(this.body)) return new Uint8Array();
    if (__bodyBytesOf(this) !== null) return __bodyBytesOf(this);
    return __drainBody(this);
  }
  async text() {
    __markBodyRead(this);
    const bytes = await this._consume();
    return this._body ??= new TextDecoder().decode(bytes);
  }
  async json() { return JSON.parse(await this.text()); }
  async formData() {
    // The undecoded bytes, not `text()`: a UTF-8 decode replaces each invalid
    // sequence in a binary file part with one U+FFFD, so both the bytes and
    // the length change.
    __markBodyRead(this);
    return __celld.__parseFormData(
      await this._consume(), this.headers.get('content-type'));
  }
  async arrayBuffer() {
    __markBodyRead(this);
    return __handOverBody(this, await this._consume());
  }
  async blob() {
    return __celld.__blobOf(await this.arrayBuffer(),
      this.headers.get("content-type") || "");
  }
  get bodyUsed() { return __bodyUsed(this); }
  // workerd's `Request::clone`: the clone has the body's other branch, a
  // copy of the headers with their guard and of `cf`, and the same method,
  // URL and redirect mode. It shares the signal the request was made with;
  // without one, as for a request the Worker received, it has its own.
  clone() {
    const body = __cloneBody(this);
    const init = {
      method: this.method,
      headers: this.headers.__celldHeaderList,
      redirect: this.redirect,
    };
    if (this._signalForSubrequests !== null)
      init.signal = this._signalForSubrequests;
    if (body !== null) init.body = body;
    if (this.cf !== undefined) init.cf = structuredClone(this.cf);
    const request = new Request(this.url, init);
    if (this.headers._immutable)
      Object.defineProperty(request.headers, "_immutable", { value: true });
    request._oneTimeBody = this._oneTimeBody;
    return request;
  }
};
const __makeRequest = __celld.__makeRequest = (
  url, method, body, headersJson = "[]", signal = undefined,
  incomingSignal = false,
) => new Request(url, {
  // The raw header JSON, not a parsed object: an incoming request whose
  // handler never reads `.headers` (a hello world, or a Worker that only
  // routes to a cell) then never parses it. See `get headers()`.
  // celld cannot prove Cloudflare edge metadata, so the object stays empty.
  // In particular, no client-controlled header becomes a country or a colo;
  // the forwarded-authority trust flag does not establish geolocation trust.
  // Every incoming request has redirect mode "manual", as in workerd
  // (`ServiceWorkerGlobalScope::request`): a Worker that forwards the request
  // it received then hands a redirect back to its own client instead of
  // following it.
  method, body, __headersJson: headersJson, signal, cf: {}, redirect: "manual",
  __celldIncomingSignal: incomingSignal, __celldOneTimeBody: true,
});
const __fmt = (a) => a.map((x) => {
  if (typeof x === "string") return x;
  if (x instanceof Error) return x.stack || (x.name + ": " + x.message);
  try { return JSON.stringify(x); } catch { return String(x); }
}).join(" ");
const __consoleNoop = () => {};
globalThis.console = {
  debug: (...a) => __log("debug", __fmt(a)),
  error: (...a) => __log("error", __fmt(a)),
  info: (...a) => __log("info", __fmt(a)),
  log: (...a) => __log("log", __fmt(a)),
  warn: (...a) => __log("warn", __fmt(a)),
  clear: __consoleNoop,
  count: __consoleNoop,
  group: __consoleNoop,
  table: __consoleNoop,
  trace: __consoleNoop,
  assert: __consoleNoop,
  countReset: __consoleNoop,
  dir: __consoleNoop,
  dirxml: __consoleNoop,
  groupCollapsed: __consoleNoop,
  groupEnd: __consoleNoop,
  profile: __consoleNoop,
  profileEnd: __consoleNoop,
  time: __consoleNoop,
  timeEnd: __consoleNoop,
  timeLog: __consoleNoop,
  timeStamp: __consoleNoop,
  createTask: () => {
    throw new Error("console.createTask() is not implemented");
  },
};

// async-op shims: outbound fetch + timers, driven by the host event loop.
// Move one request body through a host subrequest seam. A body that already
// names a host stream keeps that stream incremental. An ordinary JavaScript
// stream has no host owner, so it uses the existing byte fallback.
const __subrequestBody = async (req, absent = false) => {
  if (absent) return { body: undefined, streamId: undefined };
  if (__bodyBytesOf(req) !== null)
    return { body: __bodyBytesOf(req), streamId: undefined };
  __unlockedBody(req);
  const streamId = __hostStreamId(req.body);
  if (streamId === undefined) {
    req._bodyUsed = true;
    return { body: await req._consume(), streamId: undefined };
  }
  // The receiver now owns the one host source. Lock the wrapper so a later
  // read fails instead of racing the receiver, and expose the transfer through
  // the standard Body flag, and on the stream: a Response whose body was sent
  // on reads as used, as in workerd.
  req._bodyUsed = true;
  req.body._disturbed = true;
  req.body.getReader();
  return { body: new Uint8Array(), streamId };
};
// A data: URL carries its response inline; RFC 2397 percent-decoding
// happens byte-wise, so a payload that is deliberately invalid UTF-8
// survives to the consumer (HTMLRewriter's own suite depends on it).
const __dataUrlResponse = (url) => {
  // The URL parser strips leading and trailing C0 controls and spaces
  // before doing anything else; a literal trailing space in a data: URL
  // is therefore not part of the payload, while an encoded %20 is.
  url = url.replace(/^[\x00-\x20]+/, "").replace(/[\x00-\x20]+$/, "");
  const match = /^data:([^,]*),([\s\S]*)$/.exec(url);
  if (!match) throw new TypeError("Invalid data: URL");
  let [, meta, payload] = match;
  const base64 = /;base64$/i.test(meta);
  if (base64) meta = meta.replace(/;base64$/i, "");
  let bytes;
  if (base64) {
    // The data: URL processor percent-decodes the body before it decodes the
    // base64, so `data:text/plain;base64,YQ%3D%3D` carries the padding of
    // "YQ==". Decode byte-wise, as the non-base64 branch below does: a `%`
    // that does not start a valid escape stays literal and the base64 decode
    // rejects it.
    payload = payload.replace(
      /%([0-9a-f]{2})/gi,
      (_, hex) => String.fromCharCode(parseInt(hex, 16)),
    );
    const bin = atob(payload);
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } else {
    const out = [];
    for (let i = 0; i < payload.length; i++) {
      const c = payload[i];
      if (c === "%" && /^[0-9A-Fa-f]{2}$/.test(payload.slice(i + 1, i + 3))) {
        out.push(parseInt(payload.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        out.push(payload.charCodeAt(i) & 0xff);
      }
    }
    bytes = Uint8Array.from(out);
  }
  return new Response(bytes, {
    headers: { "content-type": meta || "text/plain;charset=US-ASCII" },
  });
};
// Intrinsics the redirect loop uses, captured before any application code
// runs: workerd follows natively, so a Worker that replaces Request, URL or a
// Headers method doesn't change how a redirect is followed.
const __Request = Request;
const __Headers = Headers;
const __URL = URL;
const __URLHref = Object.getOwnPropertyDescriptor(URL.prototype, "href").get;
const __URLOrigin = Object.getOwnPropertyDescriptor(URL.prototype, "origin").get;
const __HeadersGet = Headers.prototype.get;
const __HeadersDelete = Headers.prototype.delete;
const __HeadersList =
  Object.getOwnPropertyDescriptor(Headers.prototype, "__celldHeaderList").get;
const __StreamCancel = ReadableStream.prototype.cancel;
const __StringIndexOf = String.prototype.indexOf;
const __StringSlice = String.prototype.slice;
// workerd's limit (MAX_REDIRECT_COUNT in api/http.c++, the Fetch Standard's
// 20).
const __MAX_REDIRECTS = 20;
const __ONE_TIME_BODY_REDIRECT =
  "A request with a one-time-use body (it was initialized from a stream, not " +
  "a buffer) encountered a redirect requiring the body to be retransmitted. " +
  "To avoid this error in the future, construct this request from a " +
  "buffer-like body initializer.";
// The statuses a Fetcher follows.
const __isRedirectStatus = (status) =>
  status === 301 || status === 302 || status === 303 || status === 307 ||
  status === 308;
// A URL as a Fetcher sends it and a response reports it: without a fragment.
const __withoutFragment = (url) => {
  const at = __ReflectApply(__StringIndexOf, url, ["#"]);
  return at === -1 ? url : __ReflectApply(__StringSlice, url, [0, at]);
};
// Send `req` through one Fetcher, following redirects through that same
// Fetcher, as workerd's fetchImpl does (api/http.c++). `send(request, chain)`
// makes one request and never follows; `chain` is one object per call, for
// state a Fetcher keeps across its hops. So a service binding's Location goes
// back to the same service whatever host it names, and each hop of a global
// fetch() is a request of its own, which the host checks against the egress
// policy and charges as a subrequest. The rules are workerd's: the method and
// body each status keeps, Authorization dropped on a hop to another origin
// (strip_authorization_on_cross_origin_redirect, which celld always has), and
// no second send of a body that can't be replayed. `req` is the caller's own
// copy, made by its fetch(), so it is changed in place.
const __fetchThrough = async (req, send) => {
  // A Fetcher sends no fragment.
  req.url = __withoutFragment(req.url);
  const chain = { __proto__: null };
  if (req.redirect !== "follow")
    return __fetchedFrom(await send(req, chain), [req.url]);
  // What a hop sends again, read before `send`, which can take over the body.
  // A byte body is never consumed in place: every send copies it. No send
  // changes `req`'s headers, so they are read only once a redirect needs them.
  const replayable = req.body === null ||
    (__bodyBytesOf(req) !== null && !req._oneTimeBody);
  let body = req.body === null ? undefined : __bodyBytesOf(req);
  let method = req.method;
  const signal = req._signalForSubrequests;
  const cf = req.cf;
  const urls = [req.url];
  let response = await send(req, chain);
  let headers = null;
  for (;;) {
    const status = response.status;
    if (!__isRedirectStatus(status)) break;
    const location = __ReflectApply(__HeadersGet, response.headers, ["location"]);
    if (location === null) break;
    // Nobody can read the redirect's body after this. Cancelling it releases
    // a cross-isolate body stream instead of waiting for its idle TTL.
    if (response.body !== null) {
      try {
        await __ReflectApply(__StreamCancel, response.body, []);
      } catch { /* the redirect still wins */ }
    }
    const current = urls[urls.length - 1];
    let next;
    try {
      next = new __URL(location, current);
    } catch {
      throw new TypeError("Invalid Location header; unable to follow redirect.");
    }
    if (urls.length - 1 >= __MAX_REDIRECTS) {
      let list = urls[0];
      for (let at = 1; at < urls.length; at++) list += ", " + urls[at];
      throw new TypeError("Too many redirects." + list);
    }
    headers ??= new __Headers(req._headersJson !== undefined
      ? __jsonParse(req._headersJson)
      : __ReflectApply(__HeadersList, req.headers, []));
    if (__ReflectApply(__URLOrigin, next, []) !==
        __ReflectApply(__URLOrigin, new __URL(current), []))
      __ReflectApply(__HeadersDelete, headers, ["authorization"]);
    urls[urls.length] = __withoutFragment(__ReflectApply(__URLHref, next, []));
    if (status !== 303 && !replayable)
      throw new TypeError(__ONE_TIME_BODY_REDIRECT);
    // Only the method and the body change: workerd keeps every header,
    // Content-Type and Content-Length included.
    if ((status === 301 || status === 302) && method === "POST" ||
        status === 303 && method !== "HEAD") {
      method = "GET";
      body = undefined;
    }
    const init = {
      __proto__: null,
      method,
      headers: __ReflectApply(__HeadersList, headers, []),
      redirect: "follow",
    };
    if (body !== undefined) init.body = body;
    if (signal !== null) init.signal = signal;
    if (cf !== undefined) init.cf = cf;
    response = await send(new __Request(urls[urls.length - 1], init), chain);
  }
  return __fetchedFrom(response, urls);
};
const __fetchedFrom = (response, urls) => {
  response.url = urls[urls.length - 1];
  response.redirected = urls.length > 1;
  return response;
};
globalThis.fetch = async (input, init) => {
  const rawUrl = typeof input === "string" ? input : input?.url;
  if (typeof rawUrl === "string" && rawUrl.startsWith("data:")) {
    return __dataUrlResponse(rawUrl);
  }
  return __fetchThrough(new __Request(input, init), __fetchNetwork);
};
// One request to the network, which never follows a redirect: global fetch(),
// and the fetch() of a container's getTcpPort(), which names its port as
// `container`: the host then lets that port of the running object's own
// container past the egress policy. Nothing else can pass it. The host answers
// with the fetch()'s deadline, which `chain` carries to the next hop, so one
// CELLD_FETCH_TIMEOUT_S bounds every hop together.
const __fetchNetwork = async (req, chain, container) => {
  // `fetch(url, { headers: { Upgrade: "websocket" } })` is the other way
  // Cloudflare opens an outbound socket, and the one most examples use.
  if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
    const upgraded = await __fetchWebSocketUpgrade(req, container);
    // A globalOutbound Fetcher takes the upgrade as an ordinary request.
    if (upgraded !== null) return upgraded;
  }
  // The caller's signal, never the incoming request's own.
  const signal = req._signalForSubrequests;
  if (signal?.aborted) throw signal.reason;
  // The bytes go to the host as a typed array, the same way every other
  // subrequest op takes a body. Encoding them as a JSON number array cost
  // roughly ten times the body in transient allocation, and it corrupted
  // nothing only because the host decoded the same shape back.
  const { body, streamId } = await __subrequestBody(
    req, ["GET", "HEAD"].includes(req.method));
  // The header list, not the iterator: the iterator sorts, lower-cases and
  // combines, so `Array.from(req.headers)` would send one `X-Trace: a, b`
  // for two appends and put celld's casing on the wire in place of the
  // author's. `op_fetch` builds the request with `RequestBuilder::header`,
  // which appends, so repeats survive.
  const dispatch = __op_fetch(
    req.method, req.url, body,
    JSON.stringify(req.headers.__celldHeaderList),
    streamId, signal != null,
    container, chain.deadline,
  );
  if (signal) {
    // An abort and the response can cross, leaving a body stream nobody
    // reads holding its upstream connection until the sweeper expires it.
    // Every arm is silenced because the caller already owns both outcomes.
    dispatch.then((late) => {
      if (!signal.aborted) return;
      const abandoned = JSON.parse(late).streamId;
      if (abandoned !== undefined) __http_stream_cancel(abandoned);
    }, () => {}).catch(() => {});
  }
  const r = __jsonParse(
    await (signal ? __awaitCancellableDoCall(dispatch, signal) : dispatch));
  if (r.deadline !== undefined) chain.deadline = r.deadline;
  // The node's egress policy refused the destination, before anything left.
  // A network error, so a TypeError, with the host's message.
  if (r.refused !== undefined) throw new TypeError(r.refused);
  // A server may answer 101 to a request that did not ask to upgrade. There
  // is no socket to give the caller, so say what happened instead of
  // letting the Response constructor refuse the status.
  if (r.status === 101 && !r.wsTarget && r.wsWorker === undefined) {
    throw new TypeError(
      `fetch: ${req.url} answered 101 Switching Protocols to a request ` +
      'that did not ask to upgrade; send "Upgrade: websocket" to open a WebSocket');
  }
  // Direct network responses always carry a stream id. A transferred
  // globalOutbound Fetcher can answer with an inline body, as service
  // bindings do, so preserve both response representations.
  const responseBody = r.streamId !== undefined
    ? new CelldHttpBodyStream(r.streamId)
    : r.body !== undefined ? r.body : Uint8Array.from(r.bodyBytes || []);
  // A globalOutbound Fetcher is a service binding, so its target can answer
  // with a WebSocket the same way.
  const response = __networkResponse(
    responseBody,
    {
      status: r.status,
      headers: r.headers,
      webSocket: __responseSocket(r),
    },
  );
  // The server's headers, which the Worker can read but not change.
  Object.defineProperty(response.headers, "_immutable", { value: true });
  response.url = req.url;
  return response;
};
const __fetchWebSocketUpgrade = __celld.__fetchWebSocketUpgrade =
  async (req, container) => {
  const scope = __currentActorScope();
  // The host allocates the id as it registers the socket.
  const socket = __wsCreate({
    __proto__: null,
    outbound: true,
    polled: !scope,
    url: req.url,
    readyState: __WS_CONNECTING,
  });
  const state = __wsState(socket);
  let id = 0;
  let raw;
  try {
    const upgrade = __ws_upgrade(
      req.url,
      // The iterator, not the header list, unlike every other outbound
      // path. The handshake builder on the host side puts these into a
      // `HeaderMap` with `insert`, which replaces, and it reads the
      // offered subprotocols with a first-match `find`. Both would drop
      // every repeat but one. Sending the combined form keeps
      // `Sec-WebSocket-Protocol: a` plus `: b` meaning `a, b`, which is
      // what the peer must see. Moving this to the header list needs the
      // host to append instead, so it is a separate change.
      JSON.stringify(Array.from(req.headers)),
      container,
    );
    // This isolate's network is a globalOutbound Fetcher.
    if (upgrade === null) return null;
    id = upgrade.id;
    state.id = id;
    __socketSet(id, socket);
    raw = __jsonParse(await upgrade.ready);
  } catch (error) {
    __socketDelete(id);
    throw error;
  }
  if (raw.refused !== undefined) {
    __socketDelete(id);
    throw new TypeError(raw.refused);
  }
  if (!raw.upgraded) {
    // The server answered without upgrading. That is an ordinary response,
    // not a connection error, and it is returned unchanged.
    __socketDelete(id);
    const response = __networkResponse(new Uint8Array(raw.body), {
      status: raw.status,
      headers: raw.headers,
    });
    Object.defineProperty(response.headers, "_immutable", { value: true });
    response.url = req.url;
    return response;
  }
  state.protocol = raw.protocol ?? "";
  const response = new Response(null, { status: 101, webSocket: socket });
  response.url = req.url;
  return response;
};
__celld.__makeAssetsBinding = (script) => {
  // One request to the assets; fetch() follows their redirects back through
  // them (see __fetchThrough).
  const send = async (req) => {
    const r = JSON.parse(await __asset_fetch(
      script,
      req.method,
      req.url,
      JSON.stringify(Array.from(req.headers)),
    ));
    const responseBody = r.streamId !== undefined
      ? new CelldHttpBodyStream(r.streamId)
      : r.body !== undefined ? r.body : Uint8Array.from(r.bodyBytes || []);
    return new Response(
      responseBody,
      { status: r.status, headers: r.headers },
    );
  };
  return {
    async fetch(input, init) {
      return __fetchThrough(new __Request(input, init), send);
    },
  };
};
// An `r2_buckets` binding, served out of the fleet bucket under the
// reserved `r2/<bucketName>/` prefix. celld runs on blob storage rather
// than providing it, so a binding gets the store the node already holds
// credentials for; a node started without a bucket has nowhere to put a
// blob and every method says so.
//
// The whole `R2Bucket` surface is here: `head`, `get`, `put`, `delete`,
// `list`, `createMultipartUpload` and `resumeMultipartUpload`, with
// `httpMetadata`, `customMetadata`, `checksums`, `storageClass`, `onlyIf`
// and every range spelling. What celld cannot honor still fails loudly
// rather than pretending -- a silent gap is the failure mode the binding
// is written to avoid. Those are `ssecKey` (celld has no customer-key
// encryption), a conditional `put` of a body too big for one request, and
// a multipart upload resumed on a node other than the one that opened it.
const __r2Reject = (bucket, method, detail) => {
  throw new Error(
    `R2 ${method} is not implemented in celld (binding ${bucket})` +
      (detail ? `: ${detail}` : ""),
  );
};
// R2's key rules, checked here so a key the real thing refuses is refused
// here too rather than quietly written.
const __r2Key = (binding, method, key) => {
  const text = String(key);
  const length = new TextEncoder().encode(text).length;
  if (length === 0 || length > 1024) {
    throw new Error(
      `R2 ${method} (binding ${binding}): a key is 1 to 1024 bytes, not ${length}`,
    );
  }
  return text;
};
const __r2Hex = (value) => {
  if (typeof value === "string") return value.trim().toLowerCase();
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : null;
  if (!bytes) return null;
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
};
const __r2Bytes = (hex) => {
  const out = new Uint8Array(hex.length >> 1);
  for (let at = 0; at < out.length; at++) {
    out[at] = parseInt(hex.substr(at * 2, 2), 16);
  }
  return out.buffer;
};
// Read a `ReadableStream` to one `Uint8Array`. Bodies drained this way
// are the ones the caller asked to have whole.
const __r2Drain = (stream, size) => __drainStream(stream, size);
const __r2Ms = (value) => {
  if (value === undefined || value === null) return undefined;
  const ms = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(ms) ? ms : undefined;
};
// `httpMetadata` is either an `R2HTTPMetadata` or a `Headers`, and R2
// takes both on the way in.
const __r2Http = (value) => {
  if (value === undefined || value === null) return {};
  const from = (name, key) =>
    typeof value.get === "function" ? value.get(name) ?? undefined : value[key];
  const http = {
    contentType: from("content-type", "contentType"),
    contentLanguage: from("content-language", "contentLanguage"),
    contentDisposition: from("content-disposition", "contentDisposition"),
    contentEncoding: from("content-encoding", "contentEncoding"),
    cacheControl: from("cache-control", "cacheControl"),
    cacheExpiry: __r2Ms(
      typeof value.get === "function" ? value.get("expires") : value.cacheExpiry,
    ),
  };
  for (const [name, entry] of Object.entries(http)) {
    if (entry === undefined || entry === null) delete http[name];
    else if (name !== "cacheExpiry") http[name] = String(entry);
  }
  return http;
};
// `onlyIf` is either an `R2Conditional` or a `Headers`; the header
// spelling of "only if it has not changed since" is If-Unmodified-Since,
// which is `uploadedBefore`.
const __r2OnlyIf = (value) => {
  if (value === undefined || value === null) return undefined;
  const only = typeof value.get === "function"
    ? {
      etagMatches: value.get("if-match") ?? undefined,
      etagDoesNotMatch: value.get("if-none-match") ?? undefined,
      uploadedAfter: __r2Ms(Date.parse(value.get("if-modified-since") ?? "")),
      uploadedBefore: __r2Ms(Date.parse(value.get("if-unmodified-since") ?? "")),
    }
    : {
      etagMatches: value.etagMatches,
      etagDoesNotMatch: value.etagDoesNotMatch,
      uploadedAfter: __r2Ms(value.uploadedAfter),
      uploadedBefore: __r2Ms(value.uploadedBefore),
    };
  for (const [name, entry] of Object.entries(only)) {
    if (entry === undefined || entry === null || Number.isNaN(entry)) {
      delete only[name];
    } else if (name.startsWith("etag")) only[name] = String(entry);
  }
  return Object.keys(only).length ? only : undefined;
};
// A range is an `R2Range` or a `Headers` carrying a Range header. R2
// takes `offset` alone, `length` alone, both, or `suffix`.
const __r2Range = (binding, value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value.get === "function") {
    const header = value.get("range");
    if (!header) return undefined;
    const parsed = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!parsed) {
      __r2Reject(binding, "get(range)", `celld cannot parse ${header}`);
    }
    const [, first, last] = parsed;
    if (first === "") return { suffix: Number(last) };
    if (last === "") return { offset: Number(first) };
    return { offset: Number(first), length: Number(last) - Number(first) + 1 };
  }
  const range = {};
  if (value.suffix !== undefined && value.suffix !== null) {
    range.suffix = Number(value.suffix);
  }
  if (value.offset !== undefined && value.offset !== null) {
    range.offset = Number(value.offset);
  }
  if (value.length !== undefined && value.length !== null) {
    range.length = Number(value.length);
  }
  for (const [name, entry] of Object.entries(range)) {
    if (!Number.isFinite(entry) || entry < 0) {
      __r2Reject(binding, "get(range)", `\`${name}\` must be a whole number`);
    }
  }
  return Object.keys(range).length ? range : undefined;
};
// R2 hashes an object's bytes and hands the digests back as
// `ArrayBuffer`s, with a `toJSON()` that spells them in hex.
const __r2Checksums = (hex) => {
  const checksums = {
    toJSON() {
      const json = {};
      for (const [name, digest] of Object.entries(hex)) json[name] = digest;
      return json;
    },
  };
  for (const [name, digest] of Object.entries(hex)) {
    checksums[name] = __r2Bytes(digest);
  }
  return checksums;
};
// One object as R2 describes it. `object` is the host's record; `body`,
// when there is one, makes this an `R2ObjectBody`.
const __r2Object = (object, body) => {
  const http = { ...object.http };
  if (http.cacheExpiry !== undefined) {
    http.cacheExpiry = new Date(http.cacheExpiry);
  }
  const etag = object.etag ? String(object.etag).replace(/^"|"$/g, "") : "";
  const r2 = {
    key: object.key,
    version: object.version ?? etag,
    size: object.size,
    etag,
    httpEtag: etag ? `"${etag}"` : "",
    uploaded: new Date(object.uploaded),
    httpMetadata: http,
    customMetadata: object.custom ?? {},
    checksums: __r2Checksums(object.checksums ?? {}),
    storageClass: object.storageClass ?? "Standard",
    // R2 fills the response headers from the object's own metadata, which
    // is what makes `return new Response(object.body, { headers })` serve
    // a stored file correctly.
    writeHttpMetadata(headers) {
      const write = (name, value) => {
        if (value !== undefined && value !== null) headers.set(name, value);
      };
      write("content-type", http.contentType);
      write("content-language", http.contentLanguage);
      write("content-disposition", http.contentDisposition);
      write("content-encoding", http.contentEncoding);
      write("cache-control", http.cacheControl);
      if (http.cacheExpiry !== undefined) {
        headers.set("expires", http.cacheExpiry.toUTCString());
      }
    },
  };
  if (object.range) r2.range = { ...object.range };
  if (!body) return r2;
  // The body's length: the object's size, or the range of it that was read.
  const range = object.range;
  const length = !range ? r2.size
    : range.length !== undefined ? range.length
    : range.suffix !== undefined ? Math.min(range.suffix, r2.size)
    : r2.size - (range.offset ?? 0);
  const drain = () => __r2Drain(body, length);
  r2.body = body;
  Object.defineProperty(r2, "bodyUsed", {
    get: () => body.locked || body._disturbed === true,
  });
  r2.arrayBuffer = async () => (await drain()).buffer;
  r2.bytes = drain;
  r2.text = async () => new TextDecoder().decode(await drain());
  r2.json = async () => JSON.parse(new TextDecoder().decode(await drain()));
  r2.blob = async () => __celld.__blobOf((await drain()).buffer, "");
  return r2;
};
// The write-side options every writing method shares, in the shape the
// host ops read.
const __r2WriteOptions = (binding, method, options) => {
  const o = options ?? {};
  if (o.ssecKey !== undefined) {
    __r2Reject(
      binding,
      `${method}(ssecKey)`,
      "celld has no customer-key encryption",
    );
  }
  const custom = {};
  for (const [name, value] of Object.entries(o.customMetadata ?? {})) {
    custom[name] = String(value);
  }
  const verify = {};
  for (const name of ["md5", "sha1", "sha256", "sha384", "sha512"]) {
    if (o[name] === undefined || o[name] === null) continue;
    const hex = __r2Hex(o[name]);
    if (hex === null) {
      __r2Reject(
        binding,
        `${method}(${name})`,
        "a checksum is hex or an ArrayBuffer",
      );
    }
    verify[name] = hex;
  }
  const storageClass = o.storageClass === undefined || o.storageClass === null
    ? undefined
    : String(o.storageClass);
  if (storageClass !== undefined &&
    !["Standard", "InfrequentAccess"].includes(storageClass)
  ) {
    __r2Reject(
      binding,
      `${method}(storageClass)`,
      `${storageClass} is not an R2 storage class`,
    );
  }
  return {
    http: __r2Http(o.httpMetadata),
    custom,
    storageClass,
    onlyIf: __r2OnlyIf(o.onlyIf),
    verify,
  };
};
// A `put` body, as either the bytes to send in one request or the stream
// to feed the host chunk by chunk. R2 takes all of these.
const __r2Value = async (binding, value) => {
  if (value === undefined || value === null) return new Uint8Array(0);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  if (value && typeof value.getReader === "function") return value;
  return __r2Reject(
    binding,
    "put",
    "a body is a string, an ArrayBuffer, a view, a Blob, a ReadableStream, or null",
  );
};
// Feed a `ReadableStream` body to the host one chunk at a time. The host
// writes one request when the whole body fits in a part and a multipart
// upload when it does not, so a Worker can stream a body far larger than
// its heap.
const __r2PutStream = async (bucketName, key, stream, options) => {
  const id = Number(await __r2_put_begin(bucketName, key, JSON.stringify(options)));
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      await __r2_put_chunk(
        id,
        value instanceof Uint8Array
          ? value
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      );
    }
  } catch (error) {
    await __r2_put_end(id, true);
    throw error;
  }
  return JSON.parse(await __r2_put_end(id, false));
};
// One open multipart upload. `id` resolves to the host's upload id, so
// `resumeMultipartUpload` can hand back a handle without awaiting -- as R2
// does -- and surface a bad id on the first method that uses it.
const __r2Multipart = (binding, bucketName, key, id) => ({
  key,
  get uploadId() {
    return String(id.value ?? "");
  },
  async uploadPart(partNumber, value, options) {
    if (options?.ssecKey !== undefined) {
      __r2Reject(binding, "uploadPart(ssecKey)", "celld has no customer-key encryption");
    }
    const body = await __r2Value(binding, value);
    const bytes = body instanceof Uint8Array ? body : await __r2Drain(body);
    const r = JSON.parse(await __r2_mp_part(await id.host, partNumber | 0, bytes));
    // The object store owns the part list this completion acts on, so it
    // never hands back a part etag to name one with.
    return { partNumber: r.partNumber, etag: "" };
  },
  async complete(parts) {
    const numbers = (parts ?? []).map((part) => part.partNumber | 0);
    return __r2Object(JSON.parse(
      await __r2_mp_complete(await id.host, JSON.stringify(numbers)),
    ));
  },
  async abort() {
    await __r2_mp_abort(await id.host);
  },
});
__celld.__makeR2Bucket = (binding, bucketName) => ({
  async head(key) {
    const name = __r2Key(binding, "head", key);
    const r = JSON.parse(await __r2_head(bucketName, name));
    return r.state === "miss" ? null : __r2Object(r.object);
  },
  async get(key, options) {
    const name = __r2Key(binding, "get", key);
    const o = options ?? {};
    if (o.ssecKey !== undefined) {
      __r2Reject(binding, "get(ssecKey)", "celld has no customer-key encryption");
    }
    const request = {
      range: __r2Range(binding, o.range),
      onlyIf: __r2OnlyIf(o.onlyIf),
    };
    const r = JSON.parse(await __r2_get(bucketName, name, JSON.stringify(request)));
    if (r.state === "miss") return null;
    // A refused `onlyIf` answers the object without its body, which is how
    // a caller tells "not modified" from "not there".
    if (r.state === "unmet") return __r2Object(r.object);
    return __r2Object(r.object, new CelldHttpBodyStream(r.streamId));
  },
  async put(key, value, options) {
    const name = __r2Key(binding, "put", key);
    const write = __r2WriteOptions(binding, "put", options);
    const body = await __r2Value(binding, value);
    const r = body instanceof Uint8Array
      ? JSON.parse(await __r2_put(bucketName, name, body, JSON.stringify(write)))
      : await __r2PutStream(bucketName, name, body, write);
    // R2 answers a refused `onlyIf` with `null` rather than throwing.
    return r.stored ? __r2Object(r.object) : null;
  },
  async delete(keys) {
    const list = (Array.isArray(keys) ? keys : [keys]).map((key) =>
      __r2Key(binding, "delete", key)
    );
    if (list.length > 1000) {
      throw new Error(
        `R2 delete (binding ${binding}) takes at most 1000 keys, not ${list.length}`,
      );
    }
    if (list.length) await __r2_delete(bucketName, JSON.stringify(list));
  },
  async list(options) {
    const o = options ?? {};
    const include = Array.isArray(o.include) ? o.include : [];
    for (const entry of include) {
      if (!["httpMetadata", "customMetadata"].includes(entry)) {
        __r2Reject(binding, "list(include)", `${entry} is not an R2 listing extra`);
      }
    }
    const request = {
      prefix: o.prefix === undefined || o.prefix === null ? "" : String(o.prefix),
      cursor: o.cursor === undefined || o.cursor === null ? null : String(o.cursor),
      startAfter: o.startAfter === undefined || o.startAfter === null
        ? null
        : String(o.startAfter),
      limit: o.limit === undefined || o.limit === null ? 0 : o.limit | 0,
      delimiter: o.delimiter === undefined || o.delimiter === null
        ? null
        : String(o.delimiter),
      include: include.length > 0,
    };
    const r = JSON.parse(await __r2_list(bucketName, JSON.stringify(request)));
    const objects = r.objects.map((object) => {
      // A listing carries the extras it was asked for and nothing else,
      // so a caller cannot mistake an empty map for an empty object.
      if (!include.includes("httpMetadata")) object.http = {};
      if (!include.includes("customMetadata")) object.custom = {};
      return __r2Object(object);
    });
    // R2 omits `cursor` entirely when the listing is complete, and callers
    // test `truncated` before reading it.
    const page = { objects, truncated: r.truncated, delimitedPrefixes: r.prefixes };
    if (r.truncated && r.cursor) page.cursor = r.cursor;
    return page;
  },
  async createMultipartUpload(key, options) {
    const name = __r2Key(binding, "createMultipartUpload", key);
    const write = __r2WriteOptions(binding, "createMultipartUpload", options);
    if (write.onlyIf) {
      __r2Reject(
        binding,
        "createMultipartUpload(onlyIf)",
        "a multipart completion takes no precondition",
      );
    }
    // R2 takes a checksum on `put`, which sees the whole body, and not on a
    // multipart upload, which never does.
    for (const name of Object.keys(write.verify)) {
      __r2Reject(binding, `createMultipartUpload(${name})`, "R2 takes a checksum on `put`");
    }
    const uploadId = await __r2_mp_begin(bucketName, name, JSON.stringify(write));
    return __r2Multipart(binding, bucketName, name, {
      value: uploadId,
      host: Promise.resolve(Number(uploadId)),
    });
  },
  // R2 hands back a handle without checking it; so does this, and the
  // first method that uses it says whether the upload is still open.
  resumeMultipartUpload(key, uploadId) {
    const name = __r2Key(binding, "resumeMultipartUpload", key);
    const id = String(uploadId);
    const host = __r2_mp_resume(bucketName, name, id).then(Number);
    // A handle nobody uses must not become an unhandled rejection; the
    // first method that awaits `host` still sees the failure.
    host.catch(() => {});
    return __r2Multipart(binding, bucketName, name, { value: id, host });
  },
});
// A host timer op resolves once, so an interval arms a new one after every
// round. `__timers` maps the id the caller holds to the op that is armed
// right now: for a timeout that is the same id, and for an interval it is a
// fresh id each round. Clearing therefore cancels the armed op, not the id.
const __timers = new Map();
const __clearTimer = (id) => {
  const armed = __timers.get(id);
  if (armed === undefined) return;
  __timers.delete(id);
  __timer_cancel(armed);
};
globalThis.setTimeout = (cb, ms, ...a) => {
  const id = __timer_alloc();
  __timers.set(id, id);
  __op_timer(id, ms | 0).then(() => {
    if (!__timers.delete(id)) return;
    cb(...a);
  });
  return id;
};
globalThis.setInterval = (cb, ms, ...a) => {
  const id = __timer_alloc();
  const delay = ms | 0;
  const arm = (armed) => {
    __timers.set(id, armed);
    __op_timer(armed, delay).then(() => {
      // Cancelling drops the entry and cancelling then re-arming replaces
      // it, so a round whose op is no longer the armed one is dead and
      // stops here. A cancelled op still resolves, which is why this test
      // is on identity and not on the op alone.
      if (__timers.get(id) !== armed) return;
      // Arm the next round before the callback runs. A `clearInterval`
      // inside the callback must end the interval, and arming after the
      // callback would undo it.
      arm(__timer_alloc());
      cb(...a);
    });
  };
  arm(id);
  return id;
};
// One id space and one cancel, because a caller can cross the two.
globalThis.clearTimeout = __clearTimer;
globalThis.clearInterval = __clearTimer;

const __sqlCursorFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry((cursorId) => __sql_cursor_close(cursorId))
  : null;

// A `SqlStorageCursor` over one exec's result (Cloudflare DO SQL API). Its
// state is private, the host cursor id and the row it read ahead above all,
// and only `SqlStorage.exec` constructs one ("Illegal constructor").
class SqlCursor {
  #columns;
  #rowsRead;
  #rowsWritten;
  #reusedCachedQuery;
  #deferredError = null;
  #cursorId;
  #prefetched;
  #finalizerToken = null;
  // `res` is what `__sql_cursor_start` returns: V8 values throughout, with the
  // first row already stepped. A failing query throws out of the op, so there
  // is no in-band error field to test here.
  constructor(brand, res) {
    if (brand !== __kStorage) throw new TypeError("Illegal constructor");
    this.#columns = res.columns;
    this.#rowsWritten = Number(res.rowsWritten || 0);
    this.#reusedCachedQuery = Boolean(res.reusedCachedQuery);
    this.#cursorId = Number(res.cursorId || 0);
    this.#prefetched = res.row;
    this.#rowsRead = this.#prefetched === null ? 0 : 1;
    if (this.#cursorId && __sqlCursorFinalizer) {
      this.#finalizerToken = {};
      __sqlCursorFinalizer.register(
        this, this.#cursorId, this.#finalizerToken,
      );
    }
  }
  #obj(r) {
    const o = {};
    for (let i = 0; i < this.#columns.length; i++) o[this.#columns[i]] = r[i];
    return o;
  }
  #finishNative() {
    if (this.#finalizerToken && __sqlCursorFinalizer)
      __sqlCursorFinalizer.unregister(this.#finalizerToken);
    this.#finalizerToken = null;
    this.#cursorId = 0;
  }
  #advanceNative() {
    if (!this.#cursorId) {
      this.#prefetched = null;
      return;
    }
    // The op answers with V8 values, not JSON: an array is a row, a number is
    // the cursor's final rowsWritten, and a failure throws. The throw is
    // caught and deferred, because a consumer must still receive the last good
    // row -- the error belongs to the call after it, not to this one.
    let result;
    try {
      result = __sql_cursor_next(this.#cursorId);
    } catch (error) {
      this.#deferredError = error;
      this.#prefetched = null;
      this.#finishNative();
      return;
    }
    if (Array.isArray(result)) {
      this.#prefetched = result;
      this.#rowsRead++;
      return;
    }
    this.#rowsWritten = Number(result || this.#rowsWritten);
    this.#prefetched = null;
    this.#finishNative();
  }
  #nextRaw() {
    if (this.#deferredError) {
      const error = this.#deferredError;
      this.#deferredError = null;
      throw error;
    }
    if (this.#prefetched === null) return { done: true };
    // Each row is prefetched one step ahead -- the row returned here was read
    // by the op during the previous step, in whichever event ran then. A
    // cursor used from another object must throw before that buffered row is
    // handed out, so ownership is checked here against the running object, for
    // every row and not only the first. A stale cursor (its final row read,
    // id now 0) owns nothing and needs no check.
    if (this.#cursorId) __sql_cursor_check(this.#cursorId);
    const value = this.#prefetched;
    this.#advanceNative();
    return { done: false, value };
  }
  toArray() {
    const rows = [];
    while (true) {
      const result = this.next();
      if (result.done) return rows;
      rows.push(result.value);
    }
  }
  one() {
    const first = this.next();
    if (first.done)
      throw new Error("Expected exactly one result from SQL query, but got no results");
    if (!this.next().done)
      throw new Error("Expected exactly one result from SQL query, but got multiple results");
    return first.value;
  }
  *raw() {
    while (true) {
      const result = this.#nextRaw();
      if (result.done) return;
      yield result.value;
    }
  }
  get columnNames() { return this.#columns; }
  get rowsRead() { return this.#rowsRead; }
  get rowsWritten() { return this.#rowsWritten; }
  get reusedCachedQueryForTest() { return this.#reusedCachedQuery; }
  next() {
    const result = this.#nextRaw();
    return result.done ? result : { done: false, value: this.#obj(result.value) };
  }
  [Symbol.iterator]() { return this; }
}
// The state is private, and only the root storage object constructs one
// ("Illegal constructor").
class SqlStorage {
  #scope;
  #storage;
  // The state is what the abort guard in `exec` reads; a storage built
  // without one would bypass the guard silently.
  constructor(brand, scope, state, storage) {
    if (brand !== __kStorage) throw new TypeError("Illegal constructor");
    if (!state) throw new TypeError("SqlStorage requires its DurableObjectState");
    this.#scope = scope;
    this.#storage = storage;
  }
  prepare(query) {
    __storageInternals.assertActive(this.#storage, "sql.prepare");
    const storage = this;
    const source = String(query);
    return (...binds) => storage.exec(source, ...binds);
  }
  exec(query, ...binds) {
    __storageInternals.assertActive(this.#storage, "sql.exec");
    const jsonBinds = [];
    const byteBinds = [];
    for (let index = 0; index < binds.length; index++) {
      const value = binds[index];
      let bytes;
      if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value);
      } else if (ArrayBuffer.isView(value)) {
        bytes = new Uint8Array(
          value.buffer, value.byteOffset, value.byteLength,
        );
      }
      if (bytes === undefined) {
        jsonBinds.push(value);
      } else {
        // Copy every buffer before JSON.stringify can call a later value's
        // toJSON(). That callback can resize, detach, or mutate this backing
        // buffer, but exec() has already accepted the bytes at this point.
        byteBinds.push([index, new Uint8Array(bytes)]);
        jsonBinds.push(null);
      }
    }
    const json = JSON.stringify(jsonBinds);
    return new SqlCursor(__kStorage, byteBinds.length === 0
      ? __sql_cursor_start(this.#scope, query, json)
      : __sql_cursor_start(this.#scope, query, json, byteBinds));
  }
  ingest(input) {
    __storageInternals.assertActive(this.#storage, "sql.ingest");
    const result = JSON.parse(__sql_ingest(this.#scope, String(input)));
    if (result.error) throw new Error("SQL error: " + result.error);
    return result;
  }
  get databaseSize() {
    __storageInternals.assertActive(this.#storage, "sql.databaseSize");
    return __sql_database_size(this.#scope);
  }
  setMaxPageCountForTest(pages) {
    if (typeof __sql_set_max_page_count_for_test !== "function")
      throw new Error("setMaxPageCountForTest is only available in tests");
    __sql_set_max_page_count_for_test(this.#scope, Number(pages));
  }
  setWriteFaultForTest(enabled) {
    if (typeof __sql_set_write_fault_for_test !== "function")
      throw new Error("setWriteFaultForTest is only available in tests");
    __sql_set_write_fault_for_test(!!enabled);
  }
  setCacheSizeForTest(pages) {
    if (typeof __sql_set_cache_size_for_test !== "function")
      throw new Error("setCacheSizeForTest is only available in tests");
    __sql_set_cache_size_for_test(this.#scope, Number(pages));
  }
  setInterruptFaultForTest(enabled) {
    if (typeof __sql_set_interrupt_fault_for_test !== "function")
      throw new Error(
        "setInterruptFaultForTest is only available in tests");
    __sql_set_interrupt_fault_for_test(this.#scope, !!enabled);
  }
  registerNomemFunctionForTest() {
    if (typeof __sql_register_nomem_function_for_test !== "function")
      throw new Error(
        "registerNomemFunctionForTest is only available in tests");
    __sql_register_nomem_function_for_test(this.#scope);
  }
}
function __readStoredValue(scope, key, read) {
  try {
    return read();
  } catch (error) {
    const message = String(error && error.message || error);
    if (!message.toLowerCase().includes("deserialize cloned data"))
      throw error;
    const contextual = new Error(
      "actor storage deserialization failed; actorId = " +
      scope + "; key = " + key + "; " + message,
    );
    contextual.cause = error;
    throw contextual;
  }
}
// kv.list()'s iterator and `storage.kv`. Their state is private and only
// the storage object constructs them ("Illegal constructor").
class SyncKvListIterator {
  #storage;
  #generation;
  #cursor;
  constructor(brand, storage, generation, cursor) {
    if (brand !== __kStorage) throw new TypeError("Illegal constructor");
    this.#storage = storage;
    this.#generation = generation;
    this.#cursor = cursor;
  }
  [Symbol.iterator]() { return this; }
  next() {
    if (this.#generation !== __storageInternals.listGeneration(this.#storage)) {
      throw new Error(
        "kv.list() iterator was invalidated because a new call to kv.list() was started. " +
        "Only one kv.list() iterator can exist at a time.",
      );
    }
    const value =
      __storage_sync_list_next(this.#cursor, __storedSentinel);
    if (value === null) return { done: true, value: undefined };
    value[1] = __unwrapStored(value[1]);
    return { done: false, value };
  }
}
class SyncKvStorage {
  #storage;
  constructor(brand, storage) {
    if (brand !== __kStorage) throw new TypeError("Illegal constructor");
    this.#storage = storage;
  }
  get(key) {
    __storageInternals.assertActive(this.#storage, "kv.get");
    key = String(key);
    const scope = __storageInternals.scope(this.#storage);
    return __unwrapStored(__readStoredValue(
      scope, key,
      () => __storage_get(scope, key, __storedSentinel),
    ));
  }
  put(key, value) {
    __storageInternals.assertActive(this.#storage, "kv.put");
    key = String(key);
    const scope = __storageInternals.scope(this.#storage);
    try {
      __storage_put(scope, key, value);
    } catch (error) {
      __storage_put_serialized(scope, key, __storedBytes(value, error));
    }
  }
  delete(key) {
    __storageInternals.assertActive(this.#storage, "kv.delete");
    return __storage_delete(
      __storageInternals.scope(this.#storage), String(key));
  }
  list(options = {}) {
    __storageInternals.assertActive(this.#storage, "kv.list");
    const generation = __storageInternals.nextListGeneration(this.#storage);
    const cursor = __storage_sync_list_start(
      __storageInternals.scope(this.#storage), JSON.stringify(options),
    );
    return new SyncKvListIterator(
      __kStorage, this.#storage, generation, cursor,
    );
  }
}
// workerd's text (ExplicitTxn::rollback()).
const __NESTED_TRANSACTION_RUNNING_ROLLBACK =
  "Cannot roll back an outer transaction while a nested transaction is still running.";
// workerd fails this case with an internal error.
const __NESTED_TRANSACTION_RUNNING_COMMIT =
  "Cannot commit an outer transaction while a nested transaction is still running.";
// Resolves after the current turn: the microtasks queued so far have run and
// the event loop has moved on, which is when workerd lets a nested critical
// section start.
const __afterTurn = () => __op_timer(__timer_alloc(), 0);
// What `ctx.storage` and a transaction callback's view share. Only the root,
// a DurableObjectStorage, has transaction(): workerd's DurableObjectTransaction
// (actor-state.h) has none, and a nested transaction starts through
// `ctx.storage`, which places it inside the innermost open layer.
//
// Every field is private, the scope above all: a storage object a script
// could point at another object would read and write that object's state.
// Only the object's state and a transaction construct one; `new
// storage.constructor()` throws "Illegal constructor", as in workerd. The
// root's `kv` and `sql` are its own properties, as workerd's are; a
// transaction view has none, and reaches them through the getters.
const __kStorage = Symbol("DurableObjectStorage");
// The harness's view of a storage object, which no script reaches.
let __storageInternals;
class __DurableObjectStorageBase {
  #scope;
  #state;
  #sql;
  #kv;
  #transactionRoot;
  #transactionDepth;
  #transactionControl;
  #transactionSerial = 0;
  #transactionTail = Promise.resolve();
  #activeTransaction = null;
  #activeSyncTransaction = null;
  #syncKvListGeneration = 0;
  constructor(
    brand,
    scope,
    state = null,
    transactionRoot = null,
    transactionDepth = 0,
    transactionControl = null,
  ) {
    if (brand !== __kStorage) throw new TypeError("Illegal constructor");
    this.#scope = scope;
    this.#state = state;
    this.#transactionRoot = transactionRoot || this;
    this.#transactionDepth = transactionDepth;
    this.#transactionControl = transactionControl;
    this.#kv = new SyncKvStorage(__kStorage, this);
    this.#sql = new SqlStorage(__kStorage, scope, state, this);
    if (!transactionRoot) {
      for (const [name, value] of [["kv", this.#kv], ["sql", this.#sql]])
        __ObjectDefineProperty(this, name, {
          value, writable: true, enumerable: true, configurable: true,
        });
    }
  }
  get kv() { return this.#kv; }
  get sql() { return this.#sql; }
  static {
    __storageInternals = {
      scope: (storage) => storage.#scope,
      assertActive: (storage, operation) =>
        storage.#assertTransactionActive(operation),
      abandonOpenTransactions: (storage, error) =>
        storage.#abandonOpenTransactions(error),
      transaction: (storage, f) => {
        storage.#assertTransactionActive("transaction");
        const root = storage.#transactionRoot;
        // A transaction started while another is open nests inside it,
        // whichever event started it: the callback's own helpers reach the
        // root handle instead of its view, and an event that was already in
        // flight when the gate shut can resume inside the transaction.
        // Workerd keeps one savepoint stack per object, so both join it:
        // each sees the other's uncommitted writes, and the outer layer's
        // rollback discards both.
        if (root.#activeTransaction !== null)
          return storage.#nestedTransaction(
            root.#activeTransaction.#transactionControl, f);
        return storage.#topLevelTransaction(f);
      },
      // kv.list()'s iterators: a new list invalidates the ones before it.
      nextListGeneration: (storage) =>
        ++storage.#transactionRoot.#syncKvListGeneration,
      listGeneration: (storage) =>
        storage.#transactionRoot.#syncKvListGeneration,
    };
  }
  #transactionStatus() {
    let status = null;
    for (let control = this.#transactionControl; control; control = control.parent) {
      if (control.rolledBack) return "rolled back";
      if (control.committed) status = "committed";
    }
    return status;
  }
  #assertTransactionActive(operation) {
    // A reset object's storage is closed, as a broken actor's is in workerd:
    // the replacement uses the same connection, so a write from an event of
    // the old instance would land in its state, or inside its transaction.
    if (this.#state && __objectState.aborted(this.#state))
      throw __objectState.resetFailure(this.#state);
    const status = this.#transactionStatus();
    // workerd's wording, which applications match on.
    if (status === "committed")
      throw new Error(
        "Cannot call " + operation + "() on transaction that has already committed: " +
          "did you move `txn` outside of the closure?",
      );
    if (status) throw new Error("Cannot " + operation + "() on " + status + " transaction");
  }
  #flushPendingPuts() {
    // An admitted put can resume after its boundary flushed and ended the
    // transaction. Its promise completes without flushing a later scope.
    if (this.#transactionStatus()) return false;
    if (this.#state && __objectState.aborted(this.#state)) return false;
    __storage_flush_pending_puts(this.#scope);
    return true;
  }
  async get(k) {
    this.#assertTransactionActive("get");
    // Transaction operations reach SQLite before their caller can roll back.
    if (!this.#transactionControl) await Promise.resolve();
    if (!this.#flushPendingPuts()) return;
    const key = Array.isArray(k) ? JSON.stringify(k) : String(k);
    return __readStoredValue(this.#scope, key, () => {
      if (Array.isArray(k))
        return __unwrapStoredMap(
          __storage_get_many(this.#scope, k, __storedSentinel));
      return __unwrapStored(
        __storage_get(this.#scope, k, __storedSentinel));
    });
  }
  async put(k, val) {
    this.#assertTransactionActive("put");
    if (typeof k === "string") {
      try {
        __storage_queue_put(this.#scope, k, val);
      } catch (error) {
        __storage_queue_put_serialized(this.#scope, k,
                                       __storedBytes(val, error));
      }
      await Promise.resolve();
      this.#flushPendingPuts();
      return;
    }
    const source = k instanceof Map ? Array.from(k) : Object.entries(k);
    if (source.length === 0) return;
    const entries =
      source.map(([key, value]) => [String(key), value]);
    try {
      __storage_queue_put_many(this.#scope, entries);
    } catch (error) {
      // A batch with a stub entry: encode every entry first (plain
      // entries keep their native clone bytes, stub entries take
      // the stored-stub envelope), then queue -- so a genuinely
      // uncloneable entry still queues nothing, like the batch op,
      // which serializes fully before queueing.
      const encoded = entries.map(([key, value]) => {
        try {
          return [key, __sc_encode(value)];
        } catch (error_) {
          return [key, __storedBytes(value, error_)];
        }
      });
      for (const [key, bytes] of encoded)
        __storage_queue_put_serialized(this.#scope, key, bytes);
    }
    await Promise.resolve();
    this.#flushPendingPuts();
  }
  async delete(k) {
    this.#assertTransactionActive("delete");
    if (!this.#transactionControl) await Promise.resolve();
    if (!this.#flushPendingPuts()) return;
    if (Array.isArray(k)) {
      if (k.length === 0) return 0;
      return __storage_delete_many(this.#scope, k);
    }
    return __storage_delete(this.#scope, k);
  }
  async list(options = {}) {
    this.#assertTransactionActive("list");
    if (!this.#transactionControl) await Promise.resolve();
    if (!this.#flushPendingPuts()) return new Map();
    return __unwrapStoredMap(__storage_list(
      this.#scope, JSON.stringify(options), __storedSentinel));
  }
  async deleteAll() {
    this.#assertTransactionActive("deleteAll");
    if (!this.#transactionControl) await Promise.resolve();
    if (!this.#flushPendingPuts()) return;
    __storage_delete_all(this.#scope, __cell.deleteAllDeletesAlarm);
  }
  // Resolves once every write this cell committed before the call is
  // proven durable, by the proof the output gate requires before it releases
  // an egress. Workerd resolves when the pending writes have completed; on
  // celld the local file is a cache, so "completed" is "proven". The host op
  // rejects when that proof fails or times out, so an application never
  // treats a lost write as safe.
  async sync() {
    this.#assertTransactionActive("sync");
    await Promise.resolve();
    const status = this.#transactionStatus();
    // An admitted sync can resume after transactionSync commits or rolls
    // back. Its boundary settled the queued puts, so prove the surviving
    // state without flushing a later transaction through this handle. A
    // new call after that boundary still fails the entry guard above.
    if ((this.#state && __objectState.aborted(this.#state)) ||
        (status === null && !this.#flushPendingPuts()))
      throw new Error(
        "storage.sync: " + this.#scope + " was aborted; the object is no " +
        "longer running");
    await __storage_sync(this.#scope);
  }
  async setAlarm(t) {
    this.#assertTransactionActive("setAlarm");
    if (!this.#transactionControl) await Promise.resolve();
    if (!this.#flushPendingPuts()) return;
    if (this.#state && __objectState.facetDepth(this.#state) > 0)
      throw new Error("Facets currently cannot set alarms.");
    __alarm_set(this.#scope, t instanceof Date ? t.getTime() : Number(t));
  }
  async getAlarm() {
    this.#assertTransactionActive("getAlarm");
    if (!this.#transactionControl) await Promise.resolve();
    if (!this.#flushPendingPuts()) return null;
    const v = __alarm_get(this.#scope);
    return v === null ? null : v;
  }
  async deleteAlarm() {
    this.#assertTransactionActive("deleteAlarm");
    if (!this.#transactionControl) await Promise.resolve();
    if (!this.#flushPendingPuts()) return;
    __alarm_delete(this.#scope);
  }
  #transactionStart() {
    const root = this.#transactionRoot;
    const savepoint = "cells_tx_" + (++root.#transactionSerial);
    __storage_transaction_control(
      this.#scope, "start", this.#transactionDepth > 0, savepoint,
    );
    return savepoint;
  }
  #transactionCommit(savepoint) {
    __storage_transaction_control(
      this.#scope, "commit", this.#transactionDepth > 0, savepoint,
    );
  }
  #transactionRollback(savepoint, explicit = false) {
    __storage_transaction_control(
      this.#scope,
      explicit ? "rollback_explicit" : "rollback",
      this.#transactionDepth > 0,
      savepoint,
    );
  }
  #transactionView(transactionControl) {
    return new DurableObjectTransaction(
      __kStorage,
      this.#scope,
      this.#state,
      this.#transactionRoot,
      this.#transactionDepth + 1,
      transactionControl,
    );
  }
  rollback() {
    const control = this.#transactionControl;
    if (!control)
      throw new TypeError("rollback() must be called on a transaction");
    if (control.rolledBack) return;
    this.#assertTransactionActive("rollback");
    // A running nested transaction holds a savepoint inside this layer's.
    // workerd's ExplicitTxn::rollback() refuses, and this layer stays open.
    if (control.hasChild) throw new Error(__NESTED_TRANSACTION_RUNNING_ROLLBACK);
    control.rollback();
    control.rolledBack = true;
  }
  transactionSync(f) {
    return this.#transactionSync(f);
  }
  #transactionSync(f) {
    this.#assertTransactionActive("transactionSync");
    const root = this.#transactionRoot;
    if (this.#transactionDepth === 0) {
      // A callback can call a helper that reaches the root `ctx.storage`
      // handle instead of the transaction view, and the helper starts its own
      // synchronous transaction. Workerd nests that one under the open
      // transaction; celld attempted a second top-level BEGIN and failed with
      // "cannot start a transaction within a transaction"
      // (denoland/celld#226). The open view takes the call instead, so it
      // becomes a savepoint: an inner rollback then discards only the inner
      // writes, and an outer rollback discards both layers.
      //
      // The open layer belongs to the object, not to the event that opened
      // it: an event already in flight when another event's asynchronous
      // transaction opened nests its transaction inside that one too, as
      // workerd's savepoint stack does. See `transaction()`.
      //
      // The synchronous transaction is preferred over an asynchronous one,
      // because it is the innermost open layer whenever both are open.
      if (root.#activeSyncTransaction !== null)
        return root.#activeSyncTransaction.#transactionSync(f);
      if (root.#activeTransaction !== null)
        return root.#activeTransaction.#transactionSync(f);
    }
    const savepoint = this.#transactionStart();
    const control = this.#newTransactionControl(savepoint);
    const view = this.#transactionView(control);
    // The callback below runs to its end before any other code runs, so the
    // restore below runs at exactly the point the savepoint ends.
    const previousSync = root.#activeSyncTransaction;
    root.#activeSyncTransaction = view;
    try {
      // workerd hands the callback nothing: the root's own methods write
      // inside the transaction, and a throw rolls it back.
      const value = f();
      // The object was reset under the callback, which rolled this back.
      if (control.failure !== null) throw control.failure;
      if (!control.rolledBack) {
        this.#transactionCommit(savepoint);
        control.committed = true;
      }
      return value;
    } catch (error) {
      if (!control.rolledBack) {
        try {
          this.#transactionRollback(savepoint);
          control.rolledBack = true;
        } catch (rollbackError) {
          this.#abortAfterFailedRollback(rollbackError, error);
        }
      }
      throw error;
    } finally {
      root.#activeSyncTransaction = previousSync;
    }
  }
  #newTransactionControl(savepoint) {
    const control = {
      rolledBack: false,
      rollbackPerformed: false,
      committed: false,
      parent: this.#transactionControl,
      // A nested transaction has started inside this layer and not ended,
      // and the promise that resolves when it does.
      hasChild: false,
      childEnded: null,
      // Set when the callback failed while a nested transaction ran: the
      // layer's rollback, which waits for that transaction to end.
      ended: null,
      // The error the object was reset with when this layer was abandoned.
      failure: null,
      // Orders the nested transactions started inside this layer.
      childTail: Promise.resolve(),
      rollback: () => {
        this.#transactionRollback(savepoint, true);
        control.rollbackPerformed = true;
      },
    };
    return control;
  }
  async #runTransactionWith(f, savepoint, control) {
    const view = this.#transactionView(control);
    const root = this.#transactionRoot;
    const previousActive = root.#activeTransaction;
    root.#activeTransaction = view;
    try {
      const value = await f(view);
      this.#requireNoRunningChild(control);
      if (!control.rolledBack) {
        this.#transactionCommit(savepoint);
        control.committed = true;
      } else if (!control.rollbackPerformed) {
        control.rollback();
      }
      return value;
    } catch (error) {
      if (control.failure !== null) throw control.failure;
      // workerd rejects a failed layer at once, but the nested transaction
      // still holds it: the layer rolls back, with the nested writes, only
      // when that one ends. `ended` is that rollback; whoever started this
      // layer waits for it before treating the layer as gone, and keeps the
      // gate shut until then.
      if (control.hasChild) {
        control.ended = (async () => {
          while (control.hasChild) await control.childEnded;
          if (control.failure === null && !control.rollbackPerformed)
            this.#rollbackLayer(savepoint, control, error);
          if (root.#activeTransaction === view)
            root.#activeTransaction = previousActive;
        })();
        throw error;
      }
      if (!control.rollbackPerformed) this.#rollbackLayer(savepoint, control, error);
      throw error;
    } finally {
      if (root.#activeTransaction === view)
        root.#activeTransaction = previousActive;
    }
  }
  // Rolls one layer back after its callback failed with `cause`.
  #rollbackLayer(savepoint, control, cause) {
    // The flag records a rollback that happened, not one that was attempted:
    // a rollback that fails leaves the savepoint open, and a later
    // transaction on the same connection would commit its writes. Nothing
    // can be said about the connection then, so the object is aborted
    // rather than left to serve from it.
    try {
      this.#transactionRollback(savepoint);
      control.rolledBack = true;
      control.rollbackPerformed = true;
    } catch (rollbackError) {
      this.#abortAfterFailedRollback(rollbackError, cause);
    }
  }
  // `cause` is the failure that led to the rollback; the abort's error keeps
  // it, so a debugger can walk back to the callback's own throw. The
  // rollback failure is reported even when the object is already aborted,
  // as it is after a block's limit: the abort then changes nothing, and the
  // log line is the only trace the failure leaves.
  #abortAfterFailedRollback(rollbackError, cause) {
    // Inside a catch, so the log must not become the throw that leaves it:
    // the slot release after the caller's rethrow depends on that.
    try { console.error("transaction rollback failed", rollbackError); } catch {}
    const state = this.#transactionRoot.#state;
    if (state && !__objectState.aborted(state)) {
      __objectState.abort(state,
        new Error(
          "a transaction rollback failed: " + __describeFailure(rollbackError),
          { cause },
        ),
      );
    }
  }
  // A nested transaction starts once the current turn has ended, as workerd's
  // nested critical section does, and only then picks its place: inside the
  // innermost layer still open, or on its own when the layer it was started
  // in has ended by then. So a layer whose callback finishes in the turn
  // that started a nested transaction commits without it, and a nested
  // transaction started inside `transactionSync()` begins after that
  // savepoint has ended rather than inside it. Nested transactions started
  // in one layer run one after another, in call order.
  async #nestedTransaction(parent, f) {
    const root = this.#transactionRoot;
    const previous = parent.childTail;
    let release;
    parent.childTail = new Promise((resolve) => { release = resolve; });
    // A child that failed under its own nested transaction is rejected at
    // once, but holds its layer and the sibling slot until its deferred
    // rollback ends.
    let ended = null;
    try {
      await __afterTurn();
      await previous;
      if (__objectState.aborted(root.#state))
        throw new Error("the Durable Object was reset before the transaction started");
      const current = root.#activeTransaction;
      if (current === null) return await this.#topLevelTransaction(f);
      const control = current.#transactionControl;
      let childEnded;
      control.hasChild = true;
      control.childEnded = new Promise((resolve) => { childEnded = resolve; });
      let child = null;
      try {
        const savepoint = current.#transactionStart();
        child = current.#newTransactionControl(savepoint);
        return await current.#runTransactionWith(f, savepoint, child);
      } finally {
        const end = () => {
          control.hasChild = false;
          childEnded();
        };
        if (child !== null && child.ended !== null) {
          ended = child.ended;
          ended.then(end);
        } else {
          end();
        }
      }
    } finally {
      if (ended === null) release();
      else ended.then(release);
    }
  }
  // A layer whose callback has returned cannot commit while a nested
  // transaction still runs inside it: the nested savepoint would end with
  // it. workerd fails the critical section there (ExplicitTxn::commit()
  // requires no child), which resets the object, so celld rolls the whole
  // transaction back and resets the object as a failed block does. The
  // transaction's block then fails with the same error.
  #requireNoRunningChild(control) {
    if (control.failure !== null) throw control.failure;
    if (!control.hasChild) return;
    const error = new Error(__NESTED_TRANSACTION_RUNNING_COMMIT);
    this.#abandonOpenTransactions(error);
    __objectState.resetAfterConcurrencyFailure(
      this.#transactionRoot.#state, error);
    throw error;
  }
  // Ends every open layer at once, from the innermost one up the chain of
  // its parents: the outermost rollback discards them all on the connection,
  // and each layer's runner then reports `error` instead of touching SQLite.
  #abandonOpenTransactions(error) {
    const root = this.#transactionRoot;
    // A synchronous layer is the innermost whenever one is open.
    const active = root.#activeSyncTransaction ?? root.#activeTransaction;
    let outermost = null;
    for (let control = active && active.#transactionControl; control; control = control.parent) {
      control.failure = error;
      if (!control.rolledBack) outermost = control;
      control.rolledBack = true;
    }
    if (outermost === null) return;
    try {
      outermost.rollback();
    } catch (rollbackError) {
      this.#abortAfterFailedRollback(rollbackError, error);
    }
    for (let control = active.#transactionControl; control; control = control.parent)
      control.rollbackPerformed = true;
  }
  async #topLevelTransaction(f) {
    const root = this.#transactionRoot;
    // Workerd runs the callback under blockConcurrencyWhile: the input gate
    // shuts, so no other event starts in the object while the transaction is
    // open. Without it another event's reads saw uncommitted rows, its
    // writes joined the open transaction on the same connection, and a
    // rollback discarded a write celld had already acknowledged (#714). The
    // callback's failure is caught inside the block: a failed transaction
    // rolls back and rejects, and must not reset the object the way a failed
    // critical section does.
    //
    // The tail orders transactions one event starts concurrently, which the
    // gate does not separate. Its slot is taken here, in call order: taken
    // inside the block it would be taken in the order the gate woke the
    // callers, which is not theirs to keep. It is released inside the block,
    // when the callback has settled, and not when the block has: a second
    // transaction the same event starts while the first runs rides the
    // outer hold as a nested block, and the outer block waits for nested
    // ones before it releases, so a slot held until the block's end would
    // wait on itself.
    const previous = root.#transactionTail;
    let release;
    root.#transactionTail = new Promise((resolve) => { release = resolve; });
    let control = null;
    let started = false;
    let abandoned = null;
    // Settles the caller's promise before the block ends, when the callback
    // failed while a nested transaction ran: workerd rejects the transaction
    // at once, and the block holds the gate until the deferred rollback.
    const early = Promise.withResolvers();
    const guarded = async () => {
      started = true;
      let ownsTransaction = false;
      try {
        await previous;
        // The block ended while this waited for its slot, or the object was
        // reset under it by an enclosing block that failed: the caller has
        // its rejection and the gate is open again, so starting the
        // transaction now would run it beside whatever the object serves.
        if (abandoned !== null) return { error: abandoned };
        if (__objectState.aborted(root.#state)) {
          return { error: new Error("the Durable Object was reset before the transaction started") };
        }
        ownsTransaction = true;
        // The start is a host op that can fail like any other statement, and
        // a failure there is the transaction's to report, not the block's:
        // a throw that escaped here would reset the object.
        try {
          const savepoint = this.#transactionStart();
          control = this.#newTransactionControl(savepoint);
          return { value: await this.#runTransactionWith(f, savepoint, control) };
        } catch (error) {
          // A layer that ended under a running nested transaction aborted
          // the object; the block fails with it, as workerd's does.
          if (control !== null && control.failure === error) throw error;
          if (control !== null && control.ended !== null) {
            early.resolve({ error });
            await control.ended;
          }
          return { error };
        }
      } finally {
        if (ownsTransaction) root.#activeTransaction = null;
        release();
      }
    };
    const block = (async () => {
      try {
        return await __objectState.blockConcurrencyWhile(root.#state, guarded);
      } catch (error) {
        // The block itself failed: its limit ended the callback while it still
        // ran, or the block ahead of it failed and this one never started. A
        // transaction the callback still holds would otherwise stay open on
        // the connection the object's replacement uses, and the callback's
        // late commit would carry the replacement's writes with it. Roll it
        // back now, unless the callback's continuation committed in the same
        // tick the limit won; the callback's own commit is skipped from here
        // on. The slot stays with the callback until it settles: the callback
        // still runs on the connection, and a transaction started beside it
        // would interleave with its remaining statements. Nested transactions
        // still running end with it. A block that failed before the callback
        // started holds nothing, so its slot is released here or nothing ever
        // would.
        abandoned = error;
        if (control && !control.rolledBack && !control.committed) {
          if (control.hasChild) {
            this.#abandonOpenTransactions(error);
          } else {
            try {
              control.rollback();
              control.rolledBack = true;
            } catch (rollbackError) {
              this.#abortAfterFailedRollback(rollbackError, error);
            }
          }
        }
        if (!started) release();
        throw error;
      }
    })();
    // The block can fail after `early` has answered the caller.
    block.catch(() => {});
    const outcome = await Promise.race([early.promise, block]);
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }
}
class DurableObjectStorage extends __DurableObjectStorageBase {
  static { __recordBase(this); }
  constructor(...args) {
    const set = __pinBase(DurableObjectStorage);
    try {
      super(...args);
    } finally {
      __unpinBase(DurableObjectStorage, set);
    }
  }
  async transaction(f) {
    return __storageInternals.transaction(this, f);
  }
}
// The view a transaction callback receives.
class DurableObjectTransaction extends __DurableObjectStorageBase {
  static { __recordBase(this); }
  constructor(...args) {
    const set = __pinBase(DurableObjectTransaction);
    try {
      super(...args);
    } finally {
      __unpinBase(DurableObjectTransaction, set);
    }
  }
}
// The storage methods as the harness defined them, for celld's own cells that
// run in a script's isolate (a workflow instance, the cron schedule). A
// script can replace these methods on the prototypes, and the replacement
// would then receive the cell's storage objects; the harness calls the ones
// captured here instead, before any script ran. `__ownStorage(state)` is
// that cell's storage with these methods and its scope, and `kv.list()`
// answers an array of `{ key, value }` rows, which the cells walk with a
// counted loop: an array iterator is a script's to replace too.
const __ownStorage = (() => {
  const base = __DurableObjectStorageBase.prototype;
  const kv = SyncKvStorage.prototype;
  const listNext = SyncKvListIterator.prototype.next;
  const { get, put, getAlarm, setAlarm, deleteAlarm, transactionSync } = base;
  const { get: kvGet, put: kvPut, delete: kvDelete, list: kvList } = kv;
  return (state) => {
    const storage = state.storage;
    const kvStorage = storage.kv;
    const call = (method, target) =>
      (...args) => __ReflectApply(method, target, args);
    const kvView = {
      __proto__: null,
      get: call(kvGet, kvStorage),
      put: call(kvPut, kvStorage),
      delete: call(kvDelete, kvStorage),
    };
    kvView.list = (options) => {
      const iterator = __ReflectApply(kvList, kvStorage, [options]);
      const rows = [];
      for (;;) {
        const row = __ReflectApply(listNext, iterator, []);
        if (row.done) return rows;
        rows[rows.length] = { __proto__: null, key: row.value[0], value: row.value[1] };
      }
    };
    return {
      __proto__: null,
      get: call(get, storage),
      put: call(put, storage),
      getAlarm: call(getAlarm, storage),
      setAlarm: call(setAlarm, storage),
      deleteAlarm: call(deleteAlarm, storage),
      transactionSync: call(transactionSync, storage),
      kv: kvView,
      scope: __storageInternals.scope(storage),
    };
  };
})();
// A Durable Object id. Its class and value are private, as workerd's are,
// and only the harness constructs one (`__newDoId`): `new id.constructor()`
// throws "Illegal constructor", as in workerd.
const __kDoId = Symbol("DurableObjectId");
let __isDoId, __doIdClass, __doIdScope;
class DurableObjectId {
  #className;
  #value;
  // workerd's own properties, in its order, as fields: an assignment would
  // run a setter a script put on Object.prototype.
  jurisdiction = undefined;
  name;
  constructor(brand, className, value, name = undefined) {
    if (brand !== __kDoId) throw new TypeError("Illegal constructor");
    this.#className = className;
    this.#value = value;
    this.name = name;
  }
  toString() { return this.#value; }
  equals(other) {
    return __isDoId(other) && other.#value === this.#value;
  }
  static {
    __isDoId = (value) =>
      value !== null && typeof value === "object" && #value in value;
    __doIdClass = (id) => id.#className;
    __doIdScope = (id) => id.#className + ":" + id.#value;
  }
}
const __newDoId = (className, value, name) =>
  new DurableObjectId(__kDoId, className, value, name);
globalThis.DurableObjectRoutingError = class DurableObjectRoutingError
  extends Error {
  constructor(detail = {}) {
    super("The Durable Object owner is currently unreachable");
    this.name = "DurableObjectRoutingError";
    this.code = "owner_unreachable";
    this.retryable = true;
    if (typeof detail.scope === "string") this.scope = detail.scope;
    if (typeof detail.owner === "string") this.owner = detail.owner;
  }
};
const __durableObjectRoutingError = (error) => {
  const marker = "__CELLD_DO_ROUTING_ERROR__:";
  const message = String(error && error.message || error);
  const offset = message.indexOf(marker);
  if (offset < 0) return null;
  try {
    return new DurableObjectRoutingError(
      JSON.parse(message.slice(offset + marker.length)),
    );
  } catch {
    return new DurableObjectRoutingError();
  }
};
// A cell's input gate as the isolate sees it, for the one delivery
// point that is inside the isolate rather than in front of it: an
// RPC stub op. `events` records every block that has asked for the
// gate, so no window exists in which a block has started and the
// isolate still thinks the cell is open. `holder` names the block
// actually running; another event can still be queued.
//
// A stub minted while a block runs carries that block's token and
// re-enters it instead of queueing behind it. That is Workerd's
// `IoContext::makeReentryCallback`, and without it a callback the
// block itself sent out could never come back.
const __cellBlocks = new Map();
const __blockEnter = (scope, event, owner) => {
  let settleReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    settleReady = resolve;
    rejectReady = reject;
  });
  const record = {
    owner,
    reaction: String(__io_context_id()),
    actorEvent: __currentActorEvent(),
    retired: false,
    ready,
    settleReady,
    rejectReady,
  };
  const block = __cellBlocks.get(scope);
  if (block !== undefined) {
    block.events.set(event, record);
    return { block, record };
  }
  const fresh = {
    holder: null,
    events: new Map([[event, record]]),
  };
  __cellBlocks.set(scope, fresh);
  return { block: fresh, record };
};
const __blockLeave = (scope, block, event) => {
  if (!block.events.delete(event)) return;
  if (block.holder === event) block.holder = null;
  if (block.events.size === 0 && __cellBlocks.get(scope) === block)
    __cellBlocks.delete(scope);
};
const __durableClassMeta = new WeakMap();
let __nextFacetOwner = 1;
// Takes encoded props, not the caller's options bag: an options bag reaching
// here is a bag nothing validated, and reading one key out of it is how every
// other key came to be dropped in silence. The loader stub validates the bag
// and encodes its value before it creates the class.
const __makeDurableObjectClass = (loadPromise, name, propsSc) => {
  const value = {};
  __durableClassMeta.set(value, {
    loadPromise,
    name: name === null || name === undefined ? "default" : String(name),
    propsSc,
  });
  return value;
};
// Loopback classes are callable; a specialized class is only a handle. Capture
// props now, so later mutation of the caller's options cannot change startup.
const __makeLoopbackDurableObjectClass = (name) => {
  const loadPromise = Promise.resolve({ id: 0 });
  const specialize = function(options) {
    if (arguments.length === 0)
      throw new TypeError("DurableObjectClass requires an options argument.");
    if (options !== undefined && options !== null &&
        typeof options !== "object" && typeof options !== "function")
      throw new TypeError("DurableObjectClass options must be an object.");
    const props = options?.props;
    if (props !== undefined &&
        (props === null || (typeof props !== "object" && typeof props !== "function")))
      throw new TypeError("DurableObjectClass props must be an object.");
    return __makeDurableObjectClass(
      loadPromise, name, __rpcOut(props === undefined ? {} : props, false));
  };
  __durableClassMeta.set(specialize, {
    loadPromise, name, propsSc: __rpcOut({}, false),
  });
  return specialize;
};
// `ctx.facets`. Its state is private, the manager's object above all: a
// manager a script could point at another object would start, abort and
// delete that object's facets. Only the object's state constructs one
// ("Illegal constructor", as in workerd).
const __kFacets = Symbol("DurableObjectFacets");
let __facetsRelease;
class DurableObjectFacets {
  #state;
  #owner;
  #next = 1;
  #running = new Map();
  #barriers = new Map();
  constructor(brand, state) {
    if (brand !== __kFacets) throw new TypeError("Illegal constructor");
    this.#state = state;
    this.#owner = String(__nextFacetOwner++);
  }
  static {
    __facetsRelease = (facets) => facets.#release();
  }
  #validName(name) {
    name = String(name);
    if (new TextEncoder().encode(name).length > 256)
      throw new TypeError("Facet name is too long (max 256 characters).");
    return name;
  }
  get(name, getStartupOptions) {
    name = this.#validName(name);
    if (__objectState.facetDepth(this.#state) >= 3)
      throw new Error(
        "Facet nesting depth limit exceeded. The maximum depth including the root Durable Object is 4.");
    if (typeof getStartupOptions !== "function")
      throw new TypeError("The facet startup callback must be a function.");
    let record = this.#running.get(name);
    if (record !== undefined) return record.stub;
    // Each run gets a distinct host scope. An aborted request can still have
    // a pending continuation, so reusing its scope would let that continuation
    // enter the replacement instance after the abort barrier opens.
    record = {
      aborted: false,
      error: undefined,
      owner: this.#owner + ":" + this.#next++,
      started: null,
      stub: null,
    };
    const barrier = this.#barriers.get(name);
    const start = () => record.started ??= Promise.resolve(barrier)
      .then(getStartupOptions)
      .then(async (options) => {
        const meta = __durableClassMeta.get(options?.class);
        if (meta === undefined)
          throw new TypeError(
            "FacetStartupOptions.class must be a DurableObjectClass.");
        const { id: loader } = await meta.loadPromise;
        const id = options.id === undefined
          ? __objectState.id(this.#state) : options.id;
        // Keep the ID kind and name in one clone. A string round-trip erases
        // named IDs and turns a literal string ID into a DurableObjectId.
        const idSc = __sc_encode(__isDoId(id)
          ? [__doIdClass(id), id.toString(), id.name] : String(id));
        // Keep the load alive after the startup callback and class are gone.
        return [loader, meta.name, idSc, meta.propsSc, meta];
      });
    const invoke = async (operation) => {
      if (record.aborted) throw record.error;
      return operation(await start());
    };
    const target = {};
    // Methods share the loaded-worker RPC transport. A facet stub is not
    // awaitable, and a property is a single callable pipeline node.
    const session = {
      get: () => Promise.reject(new Error(
        "Awaitable properties on facets are not supported yet.")),
      call: (path, args) => invoke(async ([loader, className, id, propsSc]) => {
        if (path.length !== 1)
          throw new Error(
            "Pipelined property paths on facets are not supported yet.");
        return __rpcDes(await __facet_rpc(
          loader, className, __objectState.scope(this.#state), record.owner,
          name, id, propsSc, path[0], __rpcOut(args, false)));
      }),
    };
    // Arrow closures retain the manager because `target.fetch`'s method
    // receiver is the target object, not the DurableObjectFacets instance.
    const manager = this;
    // One request to the facet; fetch() follows its redirects back through
    // it (see __fetchThrough).
    const send = async ([loader, className, id, propsSc], req) => {
      const headers = JSON.stringify(req.headers.__celldHeaderList);
      const { body, streamId } = await __subrequestBody(req);
      const response = __jsonParse(await __facet_fetch(
        loader, className, __objectState.scope(manager.#state), record.owner,
        name, id, propsSc, req.url, req.method, body, headers, streamId));
      const responseBody = response.streamId !== undefined
        ? new CelldHttpBodyStream(response.streamId)
        : response.body !== undefined ? response.body
        : Uint8Array.from(response.bodyBytes || []);
      // The facet's socket lives in the facet's isolate. The target lets
      // the root return the upgrade, or accept the client end that the
      // wrapper binds to the facet's socket.
      return __wrapServiceResponse(new Response(responseBody, {
        status: response.status,
        headers: response.headers,
        webSocket: __responseSocket(response),
      }), req.url);
    };
    target.fetch = async function(input, init) {
      return invoke((started) => __fetchThrough(
        new __Request(input, init), (req) => send(started, req)));
    };
    record.stub = new Proxy(target, {
      get(base, prop) {
        if (prop === "then") return undefined;
        if (Reflect.has(base, prop)) return Reflect.get(base, prop);
        if (typeof prop !== "string") return undefined;
        return __makeNode(session, [prop], null);
      },
    });
    this.#running.set(name, record);
    return record.stub;
  }
  #abort(name, reason) {
    name = this.#validName(name);
    const record = this.#running.get(name);
    if (record === undefined) return Promise.resolve();
    record.aborted = true;
    record.error = reason;
    this.#running.delete(name);
    const barrier = record.started === null ? Promise.resolve() : record.started
      .then(([loader, className]) =>
        __facet_abort(
          loader, className, __objectState.scope(this.#state), record.owner,
          name), () => {});
    this.#barriers.set(name, barrier);
    const clear = () => {
      if (this.#barriers.get(name) === barrier) this.#barriers.delete(name);
    };
    barrier.then(clear, clear);
    return barrier;
  }
  abort(name, reason) {
    this.#abort(name, reason);
  }
  delete(name) {
    name = this.#validName(name);
    const barrier = this.#abort(name, new Error("Facet was deleted.")).then(() =>
      __facet_delete(__objectState.scope(this.#state), name));
    this.#barriers.set(name, barrier);
    const clear = () => {
      if (this.#barriers.get(name) === barrier) this.#barriers.delete(name);
    };
    // Keep a failed delete as the name's barrier. Clearing it would let the
    // next get reload the image which the failed operation did not delete.
    barrier.then(clear, () => {});
  }
  #release() {
    // The host closes these facets during give-back. Queuing _abort here
    // leaves an undriven op whose promise retains the manager, its root,
    // and the loaded classes after the root has stopped.
    const reason = new Error("The parent Durable Object was released.");
    for (const record of this.#running.values()) {
      record.aborted = true;
      record.error = reason;
    }
    this.#running.clear();
    this.#barriers.clear();
  }
}
// The reason a failed critical section gives its waiters. It must not throw:
// it runs where a throw would skip the gate's release, and a value with no
// string form, such as `Object.create(null)`, is a legal thing to throw.
function __describeFailure(error) {
  try {
    return String((error && error.message) || error);
  } catch {
    return "critical section failed";
  }
}
// ---- Containers -----------------------------------------------------------
// `ctx.container` for a class named in the deployment's `containers`. The
// surface and every message follow workerd's api/container.c++; the host
// ops perform the effects against the node's container engine. The host
// acts on the container of the Durable Object whose event is running, never
// on one that JavaScript names. As in workerd, a `Container`, its ports and
// its processes are I/O objects of the object that made them: each keeps
// that object's scope as its private owner, which the host only compares
// with the running event's, and use during another object's event throws
// workerd's cross-object I/O error. Their state is private, and the
// intrinsics below are captured before any application code runs.
const __ObjectEntries = Object.entries;
const __ArrayIsArray = Array.isArray;
const __NumberIsInteger = Number.isInteger;
const __String = String;
const __Number = Number;
const __Uint8Array = Uint8Array;
const __ArrayBuffer = ArrayBuffer;
const __ArrayBufferIsView = ArrayBuffer.isView;
const __PromiseThen = Promise.prototype.then;
const __PromiseAll = Promise.all.bind(Promise);
const __RegExpTest = RegExp.prototype.test;
// Settle a host promise nobody waits on, without its `catch` a Worker could
// have replaced.
const __ignoreRejection = (promise) => {
  __ReflectApply(__PromiseThen, promise, [undefined, () => {}]);
};
const __containerEnvList = (env) => {
  const list = [];
  if (env === undefined || env === null) return list;
  for (const [name, value] of __ObjectEntries(env)) {
    const text = __String(value);
    if (name.includes("="))
      throw new Error(`Environment variable names cannot contain '=': ${name}`);
    if (name.includes("\0"))
      throw new Error(`Environment variable names cannot contain '\\0': ${name}`);
    if (text.includes("\0"))
      throw new Error(`Environment variable values cannot contain '\\0': ${name}`);
    list[list.length] = [name, text];
  }
  return list;
};
const __execOutputMode = (mode, kind) => {
  const value = mode === undefined ? "pipe" : __String(mode);
  if (value === "pipe" || value === "ignore" ||
      (kind === "stderr" && value === "combined")) return value;
  throw new TypeError(`Invalid ${kind} option: ${value}`);
};
const __validSignal = (signo) => __NumberIsInteger(signo) && signo > 0 && signo <= 64;
const __execStream = (owner, id, which) => new ReadableStream({
  type: "bytes",
  async pull(controller) {
    const chunk = await __container_exec_read(owner, id, which);
    if (chunk.byteLength === 0) controller.close();
    else controller.enqueue(new __Uint8Array(chunk));
  },
});
class ContainerExecOutput {
  constructor(stdout, stderr, exitCode) {
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}
class ContainerExecProcess {
  #owner;
  #id;
  #outputCalled = false;
  #exitCode = null;
  constructor(owner, id, pid, stdinMode, stdoutMode, stderrMode) {
    this.#owner = owner;
    this.#id = id;
    this.pid = pid;
    this.stdout = stdoutMode === "pipe" ? __execStream(owner, id, 1) : null;
    this.stderr = stderrMode === "pipe" ? __execStream(owner, id, 2) : null;
    this.stdin = stdinMode === "pipe"
      ? new WritableStream({
        write: (chunk) => __container_exec_write(owner, id, __bytesOf(chunk)),
        close: () => __container_exec_close(owner, id),
        abort: () => __container_exec_close(owner, id),
      })
      : null;
  }
  get exitCode() {
    if (this.#exitCode === null) {
      this.#exitCode = __ReflectApply(
        __PromiseThen, __container_exec_wait(this.#owner, this.#id), [__Number]);
    }
    return this.#exitCode;
  }
  async output() {
    if (this.#outputCalled) throw new TypeError("output() can only be called once.");
    this.#outputCalled = true;
    for (const [stream, name] of [[this.stdout, "stdout"], [this.stderr, "stderr"]]) {
      if (stream && stream.locked)
        throw new TypeError(`Cannot call output() after ${name} has started being consumed.`);
    }
    const all = (stream) => stream
      ? new Response(stream).arrayBuffer()
      : new __ArrayBuffer(0);
    const [stdout, stderr] = await __PromiseAll([all(this.stdout), all(this.stderr)]);
    const exitCode = await this.exitCode;
    // Nothing else can read the process now, so the host can forget it.
    __container_exec_drop(this.#owner, this.#id);
    return new ContainerExecOutput(stdout, stderr, exitCode);
  }
  kill(signal = 15) {
    if (!__validSignal(signal)) throw new RangeError("Invalid signal number.");
    __ignoreRejection(__container_exec_kill(this.#owner, this.#id, signal));
  }
}
const __bytesOf = (chunk) => {
  if (chunk instanceof __Uint8Array) return chunk;
  if (chunk instanceof __ArrayBuffer) return new __Uint8Array(chunk);
  if (__ArrayBufferIsView(chunk))
    return new __Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  throw new TypeError("stdin accepts bytes");
};
// The Fetcher `getTcpPort()` returns: `fetch()` speaks HTTP to the port over
// the node's route to the container, and `connect()` is the raw socket.
class ContainerPort {
  #owner;
  #port;
  constructor(owner, port) {
    this.#owner = owner;
    this.#port = port;
  }
  async fetch(input, init) {
    const port = this.#port;
    // Every hop goes to this port, whatever host its URL names, so a
    // redirect comes back to the container, as through any other Fetcher.
    const send = async (hop, chain) => {
      const url = new URL(hop.url);
      if (url.protocol === "https:")
        throw new Error(
          "Connecting to a container using HTTPS is not currently supported; use HTTP " +
          "instead. TLS is unnecessary anyway, as the connection is already secure by default.",
        );
      if (url.protocol !== "http:") throw new TypeError(`Fetch API cannot load: ${url}`);
      const authority = url.host;
      url.host = __container_address(this.#owner, port);
      const forwarded = new Request(url.toString(), hop);
      forwarded.headers.set("host", authority);
      try {
        return await __fetchNetwork(forwarded, chain, port);
      } catch (error) {
        // A refused or reset connection is the port not listening yet, which
        // the `@cloudflare/containers` start loop recognizes by this phrase
        // and retries; any other failure keeps its own message.
        const message = error?.message ?? __String(error);
        if (__ReflectApply(__RegExpTest, /error sending request|connection|connect/i, [message])) {
          throw new Error(
            `The container is not listening on port ${port}: ${message}`,
          );
        }
        throw error;
      }
    };
    return __fetchThrough(new __Request(input, init), send);
  }
  connect(address, options) {
    if (options?.secureTransport === "on")
      throw new Error(
        "Connencting to a container using TLS is not currently supported. It is " +
        "unnecessary anyway, as the connection is already secure by default.",
      );
    return __celld.__cfSockets.connect(
      __container_address(this.#owner, this.#port), options);
  }
}
class Container {
  #owner;
  // Why `destroy()` stopped the container, for the `monitor()` it ends.
  #destroyReason = undefined;
  constructor(owner) {
    this.#owner = owner;
  }
  // The host's answer, not a JavaScript flag: a monitor() promise can be
  // dropped with its event, so the flag it would maintain could go stale.
  get running() { return __container_running(this.#owner); }
  start(options) {
    if (this.running)
      throw new Error("start() cannot be called on a container that is already running.");
    const o = options ?? {};
    const params = { enableInternet: !!o.enableInternet, labels: [] };
    if (o.entrypoint !== undefined) params.entrypoint = __ArrayFrom(o.entrypoint, __String);
    params.env = __containerEnvList(o.env);
    if (o.labels !== undefined) {
      for (const [name, value] of __ObjectEntries(o.labels)) {
        if (name.length === 0) throw new Error("Label names cannot be empty");
        for (const text of [name, __String(value)]) {
          for (let i = 0; i < text.length; i++) {
            if (text.charCodeAt(i) < 0x20)
              throw new Error(`Label names cannot contain control characters (index ${i})`);
          }
        }
        params.labels[params.labels.length] = [name, __String(value)];
      }
    }
    if (o.hardTimeout !== undefined && !(o.hardTimeout > 0))
      throw new RangeError("Hard timeout must be greater than 0");
    // Fire and forget, as on Cloudflare: a start that fails reports
    // through monitor(). The host marks the run as running at once.
    this.#destroyReason = undefined;
    __ignoreRejection(__container_start(this.#owner, __jsonStringify(params)));
  }
  async monitor() {
    if (!this.running)
      throw new Error("monitor() cannot be called on a container that is not running.");
    let raw;
    try {
      raw = await __container_monitor(this.#owner);
    } catch (error) {
      this.#destroyReason = undefined;
      throw error;
    }
    const exitCode = __Number(raw);
    if (this.#destroyReason !== undefined) {
      const reason = this.#destroyReason;
      this.#destroyReason = undefined;
      throw reason;
    }
    if (exitCode !== 0) {
      const error = new Error(`Container exited with unexpected exit code: ${exitCode}`);
      error.exitCode = exitCode;
      throw error;
    }
  }
  async destroy(error) {
    if (!this.running) return;
    if (this.#destroyReason === undefined) this.#destroyReason = error;
    await __container_destroy(this.#owner);
  }
  signal(signo) {
    if (!__validSignal(signo)) throw new RangeError("Invalid signal number.");
    if (!this.running)
      throw new Error("signal() cannot be called on a container that is not running.");
    __ignoreRejection(__container_signal(this.#owner, signo));
  }
  getTcpPort(port) {
    if (!(__NumberIsInteger(port) && port > 0 && port < 65536))
      throw new TypeError(`Invalid port number: ${port}`);
    __container_port(this.#owner);
    return new ContainerPort(this.#owner, port);
  }
  setInactivityTimeout(durationMs) {
    if (!(durationMs > 0))
      throw new Error(`setInactivityTimeout() requires durationMs > 0, got ${durationMs}`);
    return __container_inactivity(this.#owner, durationMs);
  }
  async exec(cmd, options) {
    if (!this.running)
      throw new Error("exec() cannot be called on a container that is not running.");
    if (!__ArrayIsArray(cmd) || cmd.length === 0)
      throw new TypeError("exec() requires a non-empty command array.");
    const o = options ?? {};
    const stdoutMode = __execOutputMode(o.stdout, "stdout");
    const stderrMode = __execOutputMode(o.stderr, "stderr");
    const combined = stderrMode === "combined";
    if (combined && stdoutMode !== "pipe")
      throw new TypeError('stderr: "combined" requires stdout to be "pipe".');
    if (o.cwd !== undefined && __String(o.cwd).includes("\0"))
      throw new TypeError("cwd cannot contain '\\0' characters.");
    if (o.user !== undefined && __String(o.user).includes("\0"))
      throw new TypeError("user cannot contain '\\0' characters.");
    let stdinMode = "none";
    if (o.stdin !== undefined) {
      if (o.stdin === "pipe") stdinMode = "pipe";
      else if (o.stdin instanceof ReadableStream) stdinMode = "stream";
      else throw new TypeError('stdin must be a ReadableStream or the string "pipe".');
    }
    const params = {
      cmd: __ArrayFrom(cmd, __String),
      env: __containerEnvList(o.env),
      combined,
    };
    if (o.cwd !== undefined) params.cwd = __String(o.cwd);
    if (o.user !== undefined) params.user = __String(o.user);
    const owner = this.#owner;
    const started = __jsonParse(await __container_exec(owner, __jsonStringify(params)));
    const id = __own(started, "id");
    const pid = __own(started, "pid");
    if (stdinMode === "stream") {
      // Pump the caller's stream to the process; the pump is pending work
      // of the event, like a subrequest body.
      __ignoreRejection((async () => {
        const reader = o.stdin.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            await __container_exec_write(owner, id, __bytesOf(value));
          }
        } finally {
          await __container_exec_close(owner, id);
        }
      })());
    } else if (stdinMode === "none") {
      __ignoreRejection(__container_exec_close(owner, id));
    }
    return new ContainerExecProcess(owner, id, pid, stdinMode, stdoutMode, stderrMode);
  }
  inspect() {
    return Promise.reject(new Error("inspect() is not implemented in celld"));
  }
  snapshotDirectory() {
    return Promise.reject(new Error("snapshotDirectory() is not implemented in celld"));
  }
  snapshotContainer() {
    return Promise.reject(new Error("snapshotContainer() is not implemented in celld"));
  }
  interceptOutboundHttp() {
    return Promise.reject(new Error("interceptOutboundHttp() is not implemented in celld"));
  }
  interceptOutboundHttps() {
    return Promise.reject(new Error("interceptOutboundHttps() is not implemented in celld"));
  }
  interceptAllOutboundHttp() {
    return Promise.reject(new Error("interceptAllOutboundHttp() is not implemented in celld"));
  }
  interceptOutboundTcp() {
    return Promise.reject(new Error("interceptOutboundTcp() is not implemented in celld"));
  }
}
// Objects reset by a turn that was then terminated, whose running events
// still have to fail. The host calls `__wakeResetEvents` after it handled
// the termination, and runs the microtasks it queues. Each object leaves
// the set before its events fail, so a pass cut short resumes after it.
const __resetWakes = new Set();
__celld.__resetWakesPending = () => __resetWakes.size;
__celld.__wakeResetEvents = () => {
  for (const state of __resetWakes) {
    __resetWakes.delete(state);
    __objectState.failRunningEvents(state);
  }
};
// `ctx` of a Durable Object. Its state is private, the scope above all:
// one object's ctx a script could point at another would reset that object,
// shut its gate or read its storage. Only `_instance` constructs one; `new
// ctx.constructor()` throws "Illegal constructor", as in workerd. The own
// properties are workerd's, in its order.
const __kState = Symbol("DurableObjectState");
// The harness's view of a DurableObjectState, which no script reaches.
let __objectState;
class DurableObjectState {
  #scope;
  #aborted = false;
  // The error this instance was reset with. In workerd a reset breaks the
  // actor: its storage refuses further operations, and every event still
  // running on it fails. Storage throws `#resetError`, and each running
  // event holds a deferred here that a reset rejects (see `#untilReset`).
  #resetError = null;
  #runningEvents = new Set();
  #storage;
  #facets;
  #id;
  #gate = Promise.resolve();
  #blockDepth = 0;
  #facetDepth;
  #nestedBlocks;
  // Workerd worker-rpc.c++ getTargetInfo(): RPC needs `extends
  // DurableObject` unless the js_rpc compat flag is on. Decided once, by
  // `_instance`; dispatch reads a boolean.
  #rpcOk = false;
  // workerd's own properties, in its order, as fields: an assignment would
  // run a setter a script put on Object.prototype, with the object's
  // storage or facets.
  facets;
  container;
  storage;
  id;
  props;
  constructor(brand, scope) {
    if (brand !== __kState) throw new TypeError("Illegal constructor");
    this.#scope = scope;
    this.#storage = new DurableObjectStorage(__kStorage, scope, this);
    this.#facets = new DurableObjectFacets(__kFacets, this);
    const facet = __cell.facetConfigs[scope];
    this.#facetDepth = facet?.depth ?? 0;
    const separator = scope.indexOf(":");
    const className = separator < 0 ? scope : scope.slice(0, separator);
    this.#id = facet === undefined
      ? __newDoId(
        className, separator < 0 ? scope : scope.slice(separator + 1),
        __cell.idNames[scope])
      : typeof facet.id === "string" ? facet.id : __newDoId(...facet.id);
    this.facets = this.#facets;
    // A class outside `containers` has `ctx.container` undefined, which is
    // what the `@cloudflare/containers` constructor checks.
    this.container = __cell.containers[className]
      ? new Container(scope) : undefined;
    this.storage = this.#storage;
    this.id = this.#id;
    this.props = facet?.props;
    // Workerd's DurableObjectState.exports (actor-state.h): the same
    // loopback surface as ctx.exports on stateless entrypoints, built on
    // first read.
    __ObjectDefineProperty(this, "exports", {
      get: () => __ctxExports(),
      enumerable: true,
      configurable: true,
    });
    __withCtxRestore(this);
  }
  static {
    __objectState = {
      scope: (state) => state.#scope,
      id: (state) => state.#id,
      facets: (state) => state.#facets,
      aborted: (state) => state.#aborted,
      facetDepth: (state) => state.#facetDepth,
      rpcOk: (state) => state.#rpcOk,
      setRpcOk: (state, ok) => { state.#rpcOk = ok; },
      ready: (state) => state.#ready(),
      blockConcurrencyWhile: (state, f) =>
        __with_input_gate_context(() => state.#blockConcurrencyWhile(f)),
      untilReset: (state, result) => state.#untilReset(result),
      socket: (state, id) => state.#socket(id),
      markReset: (state, error) => state.#markReset(error),
      failRunningEvents: (state) => state.#failRunningEvents(),
      resetFailure: (state) => state.#resetFailure(),
      abort: (state, error) => state.#abort(error),
      resetAfterConcurrencyFailure: (state, error) =>
        state.#resetAfterConcurrencyFailure(error),
    };
  }
  blockConcurrencyWhile(f) {
    // The native context binds the gate and its operations to one driver.
    // Its async continuations keep that driver even inside a foreign turn.
    return __with_input_gate_context(() => this.#blockConcurrencyWhile(f));
  }
  #blockConcurrencyWhile(f) {
    if (typeof f !== "function")
      throw new TypeError("blockConcurrencyWhile() requires a function");
    if (this.#blockDepth >= 64)
      throw new Error(
        "blockConcurrencyWhile() calls are nested too deeply.",
      );
    if (this.#blockDepth > 0) {
      // A stale reaction can run while an unrelated live block makes this
      // actor's depth nonzero. It cannot ride that hold when either half of
      // its retained [origin, driver] pair has already retired.
      if (__io_context_id() === "" || __io_context_id(true) === "") {
        return Promise.reject(new Error(
          "the cell event ended before it could acquire an input gate",
        ));
      }
      // A nested block rides the outer hold. One the outer body starts and
      // does not await would outlive that hold, and a `transaction()`
      // started that way is the shape that mattered: the outer block
      // returned, the gate opened, and another event wrote into the still
      // open transaction (#714). The outer block drains these before it
      // releases, so the hold lasts as long as any block under it. A nested
      // block that fails resets the object as any block does, and the outer
      // release must carry that failure, or the waiters would be admitted to
      // an object that no longer exists: the drain records it.
      //
      // The callback starts once the current turn has ended, as a nested
      // critical section does in workerd: it waits for the hold the turn
      // runs under. An object reset in the meantime never runs it.
      const nested = __afterTurn().then(() => {
        if (this.#aborted)
          throw new Error("the Durable Object was reset before the block started");
        return this.#runConcurrencyBlock(f);
      });
      (this.#nestedBlocks ||= []).push(nested.then(() => null, __describeFailure));
      return nested;
    }
    // The host owns the gate (celld_logic::gate::InputGate). It replaces a
    // promise chain that could only order blocks against each other; the
    // gate sits at the delivery points, so nothing else is delivered to this
    // cell at all while the block runs.
    //
    // The acquire waits. It used to be synchronous, and had to be: a cell's
    // events came off one channel, so yielding even one microtask reopened a
    // window in which this cell delivered an event that then waited on a
    // gate nothing would release. Events are independent tasks now, so two
    // can reach a block together and the second has to queue -- and nothing
    // nests, so waiting cannot deadlock on an event suspended beneath it.
    // Asked for synchronously, awaited asynchronously, and the split is the
    // whole point. The op shuts the gate in this very call, so no event can
    // be delivered to this cell from here on -- that immediacy is what makes
    // `failCriticalSection()` reject a `ping()` issued right after it.
    // Waiting for the *ticket* is separate: events are independent tasks
    // now, so two of them can reach a block together and the second has to
    // queue behind the first. Calling this inside the async body instead
    // costs one microtask, and an event delivered in that window walks
    // straight into the critical section.
    const [eventText, owner, acquired] = __gate_acquire(this.#scope);
    // An empty owner is an immediate refusal. Return its already-rejected
    // promise before recording the block, because no driver exists to settle
    // native work or to repair a readiness gate installed for stale work.
    if (owner === "") return acquired;
    const event = Number(eventText);
    const { block, record } = __blockEnter(this.#scope, event, owner);
    const next = (async () => {
      try {
        await acquired;
        // A shutdown can retire the promise reaction while another event
        // owns this queued acquisition. The owner still has to consume its
        // ticket, but the retired callback must not run.
        if (record.retired) {
          __gate_release(this.#scope, event, owner, null);
          return;
        }
        block.holder = event;
        // A critical section that fails resets the actor, so whatever queued
        // behind its gate must be refused rather than handed to the reset
        // one -- it was sent to a cell whose state no longer exists. The
        // failure rides with the release for that: waiters are woken with it
        // instead of merely woken.
        let failure = null;
        try {
          return await this.#runConcurrencyBlock(f);
        } catch (error) {
          failure = __describeFailure(error);
          throw error;
        } finally {
          // Nested blocks are drained only after a body that returned: a
          // body that failed has reset the object, its waiters are refused
          // whatever the nested blocks do, and waiting for them would only
          // delay the refusal and a transaction's rollback behind it. Each
          // nested block has its own limit, so a drain is bounded by the
          // last one started, as workerd's nested critical sections are.
          while (failure === null && this.#nestedBlocks && this.#nestedBlocks.length > 0) {
            for (const nestedFailure of await Promise.all(this.#nestedBlocks.splice(0))) {
              if (nestedFailure !== null && failure === null) failure = nestedFailure;
            }
          }
          this.#nestedBlocks = undefined;
          __gate_release(this.#scope, event, owner, failure);
        }
      } finally {
        // Also on a rejected `acquired`: the block ahead failed, this one
        // never ran, and the cell must not stay shut on its behalf.
        __blockLeave(this.#scope, block, event);
      }
    })();
    // `_ready()` awaits this. The host gate stops *other* events, but a
    // block taken in the constructor runs inside the very event that is
    // being delivered, so nothing external can hold that event back -- the
    // promise does. Concurrent blocks within one event go through
    // `_blockDepth` above and never reach here.
    this.#gate = Promise.all([this.#gate, record.ready]).then(() => undefined);
    // `_ready()` observes the original promise. This extra handler prevents
    // a constructor-time rejection from becoming unhandled before an event
    // reaches `_ready()`.
    this.#gate.catch(() => {});
    next.then(record.settleReady, record.rejectReady);
    return next;
  }
  #runConcurrencyBlock(f) {
    this.#blockDepth++;
    let result;
    try {
      result = f();
    } catch (error) {
      this.#blockDepth--;
      this.#resetAfterConcurrencyFailure(error);
      throw error;
    }
    const timerId = __timer_alloc();
    let settled = false;
    const timeout = __op_timer(
      timerId,
      30_000,
    ).then(() => {
      if (!settled) {
        throw new Error(
          "A call to blockConcurrencyWhile() in a Durable Object waited for " +
          "too long. The call was canceled and the Durable Object was reset.",
        );
      }
    });
    return Promise.race([Promise.resolve(result), timeout]).then(
      (value) => {
        settled = true;
        __timer_cancel(timerId);
        this.#blockDepth--;
        return value;
      },
      (error) => {
        settled = true;
        __timer_cancel(timerId);
        this.#blockDepth--;
        this.#resetAfterConcurrencyFailure(error);
        throw error;
      },
    );
  }
  // `terminating`: the caller is about to terminate the running turn, and
  // V8 drops the microtasks queued in it, so rejecting the running events
  // now would lose their reactions. The host rejects them once the turn has
  // ended instead (`__wakeResetEvents`).
  #markReset(error, terminating = false) {
    this.#aborted = true;
    this.#resetError = error;
    // A transaction still open would otherwise stay open on the connection
    // the replacement uses, and commit with its first write.
    __storageInternals.abandonOpenTransactions(this.#storage, error);
    if (terminating) __resetWakes.add(this);
    else this.#failRunningEvents();
  }
  #failRunningEvents() {
    const events = this.#runningEvents;
    this.#runningEvents = new Set();
    for (const event of events) event.reject(this.#resetError);
  }
  #resetFailure() {
    return this.#resetError ??
      new Error("the Durable Object was reset; this event's storage is closed");
  }
  // An event's result, unless the instance resets first. A reset rejects
  // the event's deferred in the resetting turn, so even the event that reset
  // the object and caught the error fails, as in workerd.
  #untilReset(result) {
    if (this.#resetError !== null) return Promise.reject(this.#resetError);
    const event = Promise.withResolvers();
    const events = this.#runningEvents;
    events.add(event);
    Promise.resolve(result).then(
      (value) => {
        events.delete(event);
        event.resolve(value);
      },
      (error) => {
        events.delete(event);
        event.reject(error);
      },
    );
    return event.promise;
  }
  // The cell this reset acts on: the scope only while `this` is the object
  // registered under it, in the instance registry, which user code cannot
  // reach. An instance that a reset already replaced names a cell it no
  // longer is, so its late reset clears, deletes and breaks nothing of its
  // replacement's. `__cellBlocks` is keyed by the same authentic scope
  // (`op_gate_acquire` binds acquisition to the running event), so the
  // host-driven retire path below passes an authentic scope too.
  #ownScope() {
    const scope = this.#scope;
    return __instanceState(__cell.instances[scope]) === this ? scope : undefined;
  }
  #resetAfterConcurrencyFailure(error) {
    if (this.#aborted) return;
    this.#markReset(error);
    const scope = this.#ownScope();
    if (scope === undefined) return;
    __storage_cancel_pending_puts(scope);
    delete __cell.instances[scope];
    // Under a stub-mediated caller (this scope is not the current
    // event) the failure breaks the actor, as Workerd joins it
    // into the on-abort promise; a direct event keeps reset-only
    // semantics -- its caller sees the rejection itself.
    if (__currentActorScope() !== scope)
      __actorBreak(scope, error);
  }
  abort(reason) {
    // workerd takes the reason as a string (DurableObjectState::abort()).
    this.#abort(new Error(reason === undefined
      ? "Application called abort() to reset Durable Object."
      : String(reason)));
  }
  #abort(error) {
    if (this.#aborted) return;
    // See `#ownScope`: an object this is no longer registered under aborts
    // nothing, only itself.
    const scope = this.#ownScope();
    if (scope === undefined) {
      this.#markReset(error);
      return;
    }
    const terminating = __currentActorScope() === scope;
    this.#markReset(error, terminating);
    __storage_cancel_pending_puts(scope);
    delete __cell.instances[scope];
    // Direct host-dispatched event on this actor: the uncatchable
    // terminate_execution path. Under a same-isolate stub caller,
    // termination would unwind the caller too, so break in JS.
    if (terminating) {
      __actor_abort(scope, error.message);
      return;
    }
    __actorBreak(scope, error);
  }
  #ready() { return this.#gate; }
  // The WebSocket methods act on the running Durable Object, whichever
  // object's ctx they are called on, as in workerd: the host takes the
  // object from the running event, never from this state.
  getWebSockets(tag) {
    return __jsonParse(__ws_list(tag)).map((row) => __socketFromRow(row));
  }
  getTags(ws) {
    if (!__wsIsSocket(ws) || !__wsState(ws).hibernatable) {
      throw new Error(
        "you must call 'acceptWebSocket()' before attempting to access " +
        "the tags of a WebSocket.");
    }
    __wsCheckOwner(ws);
    return __ArrayFrom(__wsState(ws).tags);
  }
  acceptWebSocket(ws, tags = []) {
    if (__heap_over_admission_share())
      throw new Error(
        "the isolate is near its V8 heap limit, so it refused a " +
        "WebSocket (see CELLD_V8_HEAP_LIMIT_MB)");
    if (!__wsIsSocket(ws))
      throw new TypeError(
        "Failed to execute 'acceptWebSocket' on 'DurableObjectState': " +
        "parameter 1 is not of type 'WebSocket'.");
    const s = __wsState(ws);
    const accepted = __ArrayFrom(tags, String);
    // A pair's ends share the id the host allocates as it registers them,
    // under the running object, which is also the target's scope.
    const id = __ws_accept(s.id, __jsonStringList(accepted));
    __wsSetId(s, id);
    s.target = { __proto__: null, id, scope: __currentActorScope() };
    s.hibernatable = true;
    s.tags = accepted;
    if (s.peer !== null) {
      const peer = __wsState(s.peer);
      peer.target = s.target;
      peer.hibernatable = true;
    }
    __socketSet(id, ws);
  }
  #socket(id) {
    return __socketGet(Number(id)) ||
      this.getWebSockets().find((ws) => __wsState(ws).id === id) ||
      __wsStub(id);
  }
  // Workerd actor-state.c++ setWebSocketAutoResponse: no pair unsets, and
  // each side is capped at 2048 UTF-8 bytes. The pair itself lives in the
  // shell -- a matched message is answered without waking this cell.
  setWebSocketAutoResponse(pair) {
    if (pair === undefined || pair === null) {
      __ws_auto_response_set(null, null);
      return;
    }
    if (!(pair instanceof WebSocketRequestResponsePair))
      throw new TypeError(
        "Failed to execute 'setWebSocketAutoResponse' on " +
        "'DurableObjectState': parameter 1 is not of type " +
        "'WebSocketRequestResponsePair'.",
      );
    const max = 2048;
    const bytes = (s) => new TextEncoder().encode(s).length;
    const requestSize = bytes(pair.request);
    if (requestSize > max)
      throw new RangeError(
        `Request cannot be larger than ${max} bytes. ` +
        `A request of size ${requestSize} was provided.`,
      );
    const responseSize = bytes(pair.response);
    if (responseSize > max)
      throw new RangeError(
        `Response cannot be larger than ${max} bytes. ` +
        `A response of size ${responseSize} was provided.`,
      );
    __ws_auto_response_set(pair.request, pair.response);
  }
  getWebSocketAutoResponse() {
    const pair = __jsonParse(__ws_auto_response_get());
    if (pair === null) return null;
    return new WebSocketRequestResponsePair(pair[0], pair[1]);
  }
  getWebSocketAutoResponseTimestamp(ws) {
    const ms = __ws_auto_response_ts(__wsState(ws).id);
    return ms === null ? null : new Date(ms);
  }
  waitUntil(promise) {
    __registerWaitUntil(promise);
  }
}
// Each object's state, by its instance, which no script reaches: an
// instance's property would have been defined through a function a script
// can replace, with the instance (for the workflow and cron cells, celld's
// own) as its argument.
const __instanceStates = new __SafeWeakMap();
const __instanceState = (inst) => inst === undefined ? undefined
  : __ReflectApply(__WeakMapGet, __instanceStates, [inst]);
function _instance(scope) {
  let inst = __cell.instances[scope];
  if (!inst) {
    const className = scope.split(":")[0];
    const cls = __cell.classes[className];
    if (!cls) throw new Error("no DO class " + className);
    const state = new DurableObjectState(__kState, scope);
    inst = new cls(state, __cell.env);
    __ReflectApply(__WeakMapSet, __instanceStates, [inst, state]);
    // Workerd worker-rpc.c++ getTargetInfo(): RPC needs `extends
    // DurableObject` unless the js_rpc compat flag is on. Decided
    // once here; dispatch reads a boolean.
    __objectState.setRpcOk(state, __cell.compat.jsRpc ||
      __cell.doExports[className] === true);
    __cell.instances[scope] = inst;
  }
  return inst;
}
async function _readyInstance(scope) {
  const inst = _instance(scope);
  await __objectState.ready(__instanceState(inst));
  return inst;
}
const __actorEventStack = [];
const __currentActorEvent = () => {
  const context = String(__io_context_id());
  if (context === "") return undefined;
  for (let index = __actorEventStack.length - 1; index >= 0; index--) {
    const event = __actorEventStack[index];
    if (event.context === context) return event;
  }
  return undefined;
};
const __currentActorScope = () => __currentActorEvent()?.scope ?? "";
const __beginActorEvent = (scope) => {
  __rpcSignalRefresh();
  const event = { scope, context: String(__io_context_id()) };
  __actorEventStack.push(event);
  return event;
};
const __endActorEvent = (event) => {
  const index = __actorEventStack.lastIndexOf(event);
  if (index >= 0) __actorEventStack.splice(index, 1);
};
const __endActorEventsForContext = (context) => {
  for (let index = __actorEventStack.length - 1; index >= 0; index--) {
    if (__actorEventStack[index].context === context)
      __actorEventStack.splice(index, 1);
  }
};
const __incomingRequestSignals = new Map();
const __abortSignal = (signal, reason) => {
  if (signal.aborted) return;
  signal.aborted = true;
  signal.reason = reason;
  signal.dispatchEvent(new Event("abort"));
};
const __abortIncomingRequest = __celld.__abortIncomingRequest = (requestId) => {
  const signal = __incomingRequestSignals.get(String(requestId));
  if (signal && !signal.aborted) {
    __abortSignal(signal, new Error("The client has disconnected"));
    return true;
  }
  return false;
};
__celld.__registerIncomingRequest = (requestId, request) => {
  __incomingRequestSignals.set(String(requestId), request.signal);
};
__celld.__finishIncomingRequest = (requestId) => {
  __incomingRequestSignals.delete(String(requestId));
};
__celld.__retireInputGateContext = (context) => {
  for (const [scope, block] of __cellBlocks) {
    const retired = [...block.events].filter(([, record]) =>
      record.owner === context || record.reaction === context
    );
    if (retired.length === 0) continue;
    const holder = retired.find(([event]) => block.holder === event);
    if (holder === undefined) {
      // A queued callback has not changed the actor. Remove only that
      // callback, and let an unrelated holder continue with the same state.
      for (const [event, record] of retired) {
        record.retired = true;
        record.settleReady();
        block.events.delete(event);
        if (record.actorEvent !== undefined)
          __endActorEvent(record.actorEvent);
      }
      if (block.events.size === 0 && __cellBlocks.get(scope) === block)
        __cellBlocks.delete(scope);
      continue;
    }
    // A running callback changed this actor and cannot reach its own
    // `finally`. Reset the actor, and release the host gate when the context
    // that started the callback differs from the turn that owns its work.
    const [holderEvent, holderRecord] = holder;
    __gate_release(
      scope,
      holderEvent,
      holderRecord.owner,
      "the cell's critical section ended without releasing",
    );
    const instance = __cell.instances[scope];
    if (instance !== undefined && !__objectState.aborted(__instanceState(instance))) {
      __objectState.markReset(__instanceState(instance),
        new Error("the cell's critical section ended without releasing"),
      );
    }
    __storage_cancel_pending_puts(scope);
    if (instance !== undefined && __cell.instances[scope] === instance)
      delete __cell.instances[scope];
    for (const record of block.events.values()) {
      record.retired = true;
      record.settleReady();
      if (record.actorEvent !== undefined)
        __endActorEvent(record.actorEvent);
    }
    // The old actor cannot run any block `finally`. A later event creates an
    // instance whose ready promise contains none of this actor's work.
    if (__cellBlocks.get(scope) === block) __cellBlocks.delete(scope);
  }
  __endActorEventsForContext(context);
};
// Race a pending dispatch against the caller's abort signal: on abort,
// run `abandon` (which reaches the target's side) and reject with the
// caller's reason. The dispatch keeps its settle handlers, so a late
// settlement after abandonment cannot trip the unhandled-rejection
// signal.
const __raceCallerAbort = (dispatch, signal, abandon) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      abandon();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    dispatch.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
const __awaitCancellableDoCall = (operation, signal) => {
  if (signal.aborted) {
    __do_call_cancel(operation.__celldCancelId);
    return Promise.reject(signal.reason);
  }
  return __raceCallerAbort(operation, signal,
    () => __do_call_cancel(operation.__celldCancelId));
};
// Workerd semantics: a Response crossing a service binding is a fresh
// fetch-shaped Response -- immutable headers, default reason phrase,
// the request URL, and a real body stream -- never the callee's own
// mutable object.
const __STATUS_TEXT = {
  100: "Continue", 101: "Switching Protocols", 102: "Processing",
  103: "Early Hints", 200: "OK", 201: "Created", 202: "Accepted",
  203: "Non-Authoritative Information", 204: "No Content",
  205: "Reset Content", 206: "Partial Content", 207: "Multi-Status",
  208: "Already Reported", 226: "IM Used", 300: "Multiple Choices",
  301: "Moved Permanently", 302: "Found", 303: "See Other",
  304: "Not Modified", 305: "Use Proxy", 307: "Temporary Redirect",
  308: "Permanent Redirect", 400: "Bad Request", 401: "Unauthorized",
  402: "Payment Required", 403: "Forbidden", 404: "Not Found",
  405: "Method Not Allowed", 406: "Not Acceptable",
  407: "Proxy Authentication Required", 408: "Request Timeout",
  409: "Conflict", 410: "Gone", 411: "Length Required",
  412: "Precondition Failed", 413: "Payload Too Large",
  414: "URI Too Long", 415: "Unsupported Media Type",
  416: "Range Not Satisfiable", 417: "Expectation Failed",
  418: "I'm a teapot", 421: "Misdirected Request",
  422: "Unprocessable Entity", 423: "Locked", 424: "Failed Dependency",
  425: "Too Early", 426: "Upgrade Required",
  428: "Precondition Required", 429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons", 500: "Internal Server Error",
  501: "Not Implemented", 502: "Bad Gateway",
  503: "Service Unavailable", 504: "Gateway Timeout",
  505: "HTTP Version Not Supported", 506: "Variant Also Negotiates",
  507: "Insufficient Storage", 508: "Loop Detected",
  510: "Not Extended", 511: "Network Authentication Required",
};
const __ERROR_RESPONSE_MESSAGE =
  "Return value from serve handler must not be an error " +
  "response (like Response.error())";
const __wrapServiceResponse = (res, url) => {
  // Response.error() represents a Fetch network error, not an HTTP response.
  // Letting status 0 cross this seam turns it into an ordinary response and
  // makes callers continue after the target explicitly reported failure.
  if (res.type === "error" || res.status === 0) {
    throw new TypeError(__ERROR_RESPONSE_MESSAGE);
  }
  // A 101 that crossed isolates carries a client end the host joins to the
  // target, on the same terms as a Durable Object subrequest -- nothing binds
  // until `accept()`, so a response passed straight back out keeps the
  // direct route to the real client.
  const wrapped = new Response(
    // Buffered bodies re-stream (an empty buffer still yields a
    // stream, as over real HTTP); a streaming body passes through.
    __bodyBytesOf(res) !== null ? __bodyBytesOf(res) : res.body,
    {
      status: res.status,
      statusText:
        res.statusText || __STATUS_TEXT[res.status] || "",
      headers: res.headers,
      webSocket: res.webSocket,
    },
  );
  // The constructor copies headers, so mark the copy.
  Object.defineProperty(wrapped.headers, "_immutable", { value: true });
  wrapped.url = url;
  // An upgraded pair whose both ends live in this isolate: link them
  // directly -- the host connection seam only reaches external
  // clients. Frames the handler queued before linking flush first.
  const client = wrapped.webSocket;
  const clientState = client ? __wsState(client) : null;
  if (wrapped.status === 101 && clientState && clientState.peer !== null) {
    const server = clientState.peer;
    const serverState = __wsState(server);
    clientState.loopback = server;
    serverState.loopback = client;
    for (const frame of serverState.pending.splice(0)) {
      // "send-binary" joined this queue with outbound sockets; without a case
      // of its own it fell through to the close branch and tore the pair down
      // instead of delivering the frame.
      if (frame[0] === "send")
        queueMicrotask(() => __wsDispatchMessage(client, frame[1]));
      else if (frame[0] === "send-binary")
        queueMicrotask(() => {
          const data = frame[1];
          __wsDispatchMessage(client,
            data instanceof ArrayBuffer ? data : data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength,
            ),
          );
        });
      else
        queueMicrotask(
          () => __wsDispatchClose(client, frame[1], frame[2], true));
    }
  }
  return wrapped;
};
// `[[services]]` binding: a Fetcher pointed at another Worker in this
// process. No identity to resolve, so it goes straight to __svc_call.
// Worker Loader (Code Mode): spawn a fresh isolate from supplied code and
// invoke its default or named entrypoint through the cross-isolate request and
// RPC paths.
// A Fetcher can cross into a loaded isolate only as this host-minted route.
// Reading properties from a Proxy is not a trustworthy brand check, so the
// metadata lives in a side table that application objects cannot forge.
const __outboundMeta = new WeakMap();
const __loaderServiceMarker = "__celld$loaderSvc";
__celld.__makeLoader = () => {
  // A name weakly caches a shared load; `load()` is anonymous. Keep the load
  // promise itself on every derived capability, including a running facet,
  // so collection cannot evict a Worker while that capability still uses it.
  const byName = new Map();
  const loaderOptions = (method, options, supportsLimits) => {
    if (options === null || options === undefined) return undefined;
    if (typeof options !== "object")
      throw new TypeError(method + "() options must be an object.");
    const extra = Object.keys(options).filter(
      (key) => key !== "props" && !(supportsLimits && key === "limits"));
    if (extra.length !== 0)
      throw new TypeError(
        method + '() does not support the option "' + extra.join('", "') +
        '".');
    return options;
  };
  // `props` cross to the loaded isolate by structured clone, on the same
  // transport that already carries the call's arguments (`__rpcOut` below).
  // JSON is the obvious alternative and it is wrong: JSON.stringify turns a
  // Map, a Set, a Date, a typed array, and a RegExp into a plain object or a
  // string and reports no error, so the callee reads a mangled value that the
  // same call's arguments would have carried intact. Encoding here, once per
  // loader API call, also rejects an unclonable value at that call rather than
  // at the first operation.
  const loaderPropsSc = (method, options) => {
    const props = loaderOptions(method, options, false)?.props;
    if (props === undefined) return undefined;
    // `lift` false: the props cross an isolate boundary, so a stub inside them
    // is a DataCloneError, exactly as a stub inside an argument of the same
    // call is.
    return __rpcOut(props, false);
  };
  const loaderEntrypointOptions = (options) => {
    options = loaderOptions("getEntrypoint", options, true);
    const props = options?.props;
    return {
      propsSc: props === undefined ? undefined : __rpcOut(props, false),
      limitsJson: JSON.stringify(options?.limits ?? null),
    };
  };
  const makeEntrypoint = (loadPromise, entrypoint, propsSc, limitsJson) => {
    // One request to the entrypoint; fetch() follows its redirects back
    // through it (see __fetchThrough).
    const send = async (id, tails, req) => {
      // The caller's signal, never the incoming request's own, as for a
      // service binding.
      const signal = req._signalForSubrequests;
      if (signal?.aborted) throw signal.reason;
      // The verbatim header list; see the note on the outbound `fetch`.
      // The loaded worker rebuilds a `Headers` from these pairs, so a
      // repeat and its casing survive the isolate boundary.
      const headers = JSON.stringify(req.headers.__celldHeaderList);
      const { body, streamId } = await __subrequestBody(req);
      const loaded = __loader_fetch(
        id, req.url, req.method, body, headers, streamId, entrypoint,
        propsSc === undefined ? new Uint8Array() : propsSc,
        limitsJson, tails.length !== 0, signal != null);
      const dispatch = tails.length === 0 ? loaded : loaded[0];
      const response = signal
        ? __awaitCancellableDoCall(dispatch, signal)
        : dispatch;
      if (tails.length !== 0) {
        const delivery = loaded[1]
          .then((report) => JSON.parse(report))
          .then((events) => Promise.allSettled(
            tails.map((tail) => tail.tail(events))))
          .then((results) => {
            for (const result of results) {
              if (result.status === "rejected")
                console.error("Tail Worker failed:", result.reason);
            }
          })
          .catch((error) => console.error("Tail delivery failed:", error));
        // The loaded fetch answers before its report because the child can
        // still have waitUntil work. Keep this chain on the loader event so
        // its IoContext cannot retire and abort the report operation.
        __registerWaitUntil(delivery);
      }
      const r = __jsonParse(await response);
      const responseBody = r.streamId !== undefined
        ? new CelldHttpBodyStream(r.streamId)
        : r.body !== undefined ? r.body : Uint8Array.from(r.bodyBytes || []);
      return __wrapServiceResponse(
        new Response(responseBody, {
          status: r.status,
          headers: r.headers,
          webSocket: __responseSocket(r),
        }),
        req.url);
    };
    const target = {
      async fetch(input, init) {
        const { id, tails } = await loadPromise;
        return __fetchThrough(
          new __Request(input, init), (req) => send(id, tails, req));
      },
    };
    // Both the default and named entrypoints expose RPC: property access is a
    // callable pipeline node dispatched via __loader_rpc to that entrypoint in
    // the loaded worker (default -> the "default" export, which
    // register_entrypoints registers like any other). fetch stays on the
    // target. Only single-method calls are supported for now.
    const session = {
      get: () => Promise.reject(new Error(
        "Awaitable properties on loaded workers are not supported yet.")),
      call: (path, args) => (async () => {
        if (path.length !== 1)
          throw new Error(
            "Pipelined property paths on loaded workers are not supported " +
            "yet.");
        const { id } = await loadPromise;
        return __rpcDes(
          await __loader_rpc(id, entrypoint, path[0], __rpcOut(args, false),
            propsSc, limitsJson));
      })(),
    };
    return new Proxy(target, {
      get: (base, prop) => {
        if (prop === "then") return undefined;
        if (Reflect.has(base, prop)) return Reflect.get(base, prop);
        if (typeof prop !== "string") return undefined;
        return __makeNode(session, [prop], null);
      },
    });
  };
  // The load promise is the shared lifetime, retained by stubs, entrypoints,
  // classes, and running facets. Finalizing only the original stub can evict
  // a Worker that one of its derived capabilities still uses.
  const finalizer = new FinalizationRegistry(({ id, name, ref }) => {
    if (ref !== undefined && byName.get(name) === ref) byName.delete(name);
    if (id !== undefined) __loader_drop(id);
  });
  const track = (loadPromise, name, ref) => {
    // Register before settlement, so failed loads also release their names.
    const held = { id: undefined, name, ref };
    finalizer.register(loadPromise, held, loadPromise);
    loadPromise.then(({ id }) => { held.id = id; }, () => {});
    return loadPromise;
  };
  const makeStub = (loadPromise, name, ref) => {
    const drop = () => {
      if (ref !== undefined && byName.get(name) === ref) byName.delete(name);
      finalizer.unregister(loadPromise);
      loadPromise.then(({ id }) => __loader_drop(id), () => {});
    };
    const stub = {
      getEntrypoint(name = null, options = {}) {
        const { propsSc, limitsJson } = loaderEntrypointOptions(options);
        return makeEntrypoint(
          loadPromise, name === null ? "default" : String(name),
          propsSc, limitsJson);
      },
      getDurableObjectClass(name = null, options = {}) {
        return __makeDurableObjectClass(
          loadPromise, name, loaderPropsSc("getDurableObjectClass", options));
      },
      dispose: drop,
    };
    if (typeof Symbol.dispose === "symbol") stub[Symbol.dispose] = drop;
    return stub;
  };
  // JSON.stringify silently drops binary values, so each non-string module --
  // an explicit module shape such as `{ wasm: bytes }` -- is normalized
  // first. JavaScript modules become plain strings, and wasm moves into a
  // side-band `[name, Uint8Array]` list so multi-MB blobs never take a
  // base64/JSON round-trip.
  const toBytes = (v) => v instanceof ArrayBuffer ? new Uint8Array(v)
    : ArrayBuffer.isView(v)
      ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null;
  const moduleKinds = [
    "js", "cjs", "py", "text", "data", "json", "wasm",
  ];
  const encodeLoaderEnv = (value) => {
    if (value === undefined || value === null)
      return { env: undefined, envRoutes: [] };
    const envRoutes = [];
    const seen = new __SafeMap();
    const cache = (v, out) => __ReflectApply(__MapSet, seen, [v, out]);
    const project = (v) => {
      if (v === null ||
          (typeof v !== "object" && typeof v !== "function")) return v;
      const cached = __ReflectApply(__MapGet, seen, [v]);
      if (cached !== undefined) return cached;
      const route = __ReflectApply(__WeakMapGet, __outboundMeta, [v]);
      if (route !== undefined) {
        const marker = { [__loaderServiceMarker]: envRoutes.length };
        cache(v, marker);
        __ReflectApply(__ArrayPush, envRoutes, [[
          route.script,
          route.entrypoint,
          route.propsSc ?? (route.props === undefined
            ? new Uint8Array() : __rpcOut(route.props, false)),
        ]]);
        return marker;
      }
      if (typeof v === "function" || __isRpcTarget(v) ||
          __ReflectApply(__WeakMapHas, __stubMeta, [v]) ||
          __ReflectApply(__WeakMapHas, __doStubMeta, [v]))
        throw new DOMException(
          "Worker Loader env supports only Service Binding capabilities.",
          "DataCloneError");
      // Classified by brand, as an RPC payload is (`__rpcProject`): a
      // Proxy and a value V8 writes as itself go to the clone as they are,
      // a host class's instance crosses by value where workerd passes it
      // and is refused with workerd's error otherwise, as in storage
      // (`__hostValueOutsideRpc`), Maps and Sets are walked, a plain object
      // or an array is copied, its keys escaped as in an RPC envelope's
      // lifted tree, so data cannot pose as a marker (plan 1.53), and any
      // other object is refused with workerd's error.
      const flags = __util_type_flags(v);
      if ((flags & (__TYPE_PROXY | __TYPE_CLONED)) !== 0) return v;
      const array = __ArrayIsArray(v);
      if (!array && (__ObjectGetPrototypeOf(v) !== __ObjectPrototype ||
          (flags & (__TYPE_MAP | __TYPE_SET)) !== 0)) {
        const kind = __hostKind(v);
        if (kind !== undefined) {
          const marker = __hostValueOutsideRpc(v, kind);
          cache(v, marker);
          return marker;
        }
        if ((flags & __TYPE_MAP) !== 0) {
          const out = new Map();
          cache(v, out);
          for (const [key, item] of v) out.set(project(key), project(item));
          return out;
        }
        if ((flags & __TYPE_SET) !== 0) {
          const out = new Set();
          cache(v, out);
          for (const item of v) out.add(project(item));
          return out;
        }
        throw __rpcUnsupportedType(v);
      }
      const out = array ? [] : __bareObject();
      cache(v, out);
      const keys = __ObjectKeys(v);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (array) __defineData(out, key, project(v[key]));
        else out[__isMarkerKey(key) ? __escapeKey(key) : key] = project(v[key]);
      }
      return out;
    };
    const tree = project(value);
    try {
      return { env: __sc_encode(tree), envRoutes };
    } catch (error) {
      // V8 refuses a Proxy (or another value it cannot clone) as workerd
      // reports it, a DataCloneError.
      throw __dataCloneError(error);
    }
  };
  const encodeModules = (c) => {
    if (c === null || typeof c !== "object" || c.modules === null
        || typeof c.modules !== "object")
      return { config: c, wasm: [], outbound: undefined, tails: [] };
    // JSG converts the date and each flag to a string as a template literal
    // does: a missing date is "undefined", which the host then refuses as
    // invalid, a hole is "undefined", and a Symbol throws a TypeError. The
    // flags must be an array.
    const {
      globalOutbound: _globalOutbound,
      env: _env,
      tails: _tails,
      compatibilityDate: date,
      compatibilityFlags: flags,
      ...rest
    } = c;
    const compatibilityDate = `${date}`;
    let compatibilityFlags;
    if (flags !== undefined) {
      if (!Array.isArray(flags))
        throw new TypeError(
          "Incorrect type for the 'compatibilityFlags' field on 'WorkerCode': " +
          "the provided value is not of type 'Array'.");
      compatibilityFlags = Array.from(flags, (flag) => `${flag}`);
    }
    const modules = {};
    const wasm = [];
    for (const [name, value] of Object.entries(c.modules)) {
      const wrapped = value !== null && typeof value === "object" ? value : {};
      const explicitKinds = moduleKinds.filter((kind) =>
        Object.prototype.hasOwnProperty.call(wrapped, kind)
      );
      // An object is a module shape with one kind, as in workerd; bare bytes
      // are not a module.
      if (value !== null && typeof value === "object" &&
          !(value instanceof WebAssembly.Module) && explicitKinds.length !== 1)
        throw new TypeError(
          "Each module must contain exactly one of 'js', 'cjs', 'text', " +
          `'data', 'json', 'py', or 'wasm'. Module '${name}' contained ` +
          `${explicitKinds.length} properties.`);
      const kind = explicitKinds[0];
      if (kind === "js") {
        const source = wrapped[kind];
        if (typeof source !== "string")
          throw new TypeError(
            `Worker Loader module ${JSON.stringify(name)} field ` +
            `${JSON.stringify(kind)} must be a string.`);
        modules[name] = source;
        continue;
      }
      const bytes = kind === "wasm" ? toBytes(wrapped.wasm) : null;
      if (bytes !== null) wasm.push([name, bytes]);
      else modules[name] = value;
    }
    let outbound;
    let outboundProps;
    if (Object.prototype.hasOwnProperty.call(c, "globalOutbound")) {
      if (c.globalOutbound === undefined) {
        outbound = undefined;
      } else if (c.globalOutbound === null) {
        outbound = null;
      } else {
        const meta = __outboundMeta.get(c.globalOutbound);
        if (meta === undefined)
          throw new TypeError("globalOutbound must be a Fetcher or null.");
        // JSON carries only the host-minted route. Props use V8 structured
        // clone bytes, so their types and the cross-isolate clone boundary
        // match the other parameterized ctx.exports transports.
        outboundProps = meta.propsSc ?? (meta.props === undefined
          ? new Uint8Array()
          : __rpcOut(meta.props, false));
        outbound = JSON.stringify({
          script: meta.script,
          entrypoint: meta.entrypoint,
        });
      }
    }
    const { env, envRoutes } = encodeLoaderEnv(c.env);
    let tails = [];
    if (Object.prototype.hasOwnProperty.call(c, "tails")) {
      if (!Array.isArray(c.tails))
        throw new TypeError("tails must be an array of Fetchers.");
      tails = c.tails.map((tail) => {
        if (!__outboundMeta.has(tail))
          throw new TypeError("tails must be an array of Fetchers.");
        return tail;
      });
    }
    return {
      config: { ...rest, compatibilityDate, compatibilityFlags, modules },
      wasm, outbound, outboundProps, env, envRoutes, tails,
    };
  };
  // getCode is deferred into a microtask so a throw (or async getCode)
  // surfaces as a rejection when the worker is first used, not at get()/load().
  const loadFrom = (getCode) =>
    Promise.resolve().then(getCode)
      .then((c) => {
        const {
          config, wasm, outbound, outboundProps, env, envRoutes, tails,
        } = encodeModules(c);
        const id = __loader_load(
          JSON.stringify(config), wasm, outbound, outboundProps, env,
          envRoutes, tails.length !== 0);
        return { id, tails };
      });
  return {
    load(code) { return makeStub(track(loadFrom(() => code))); },
    get(name, getCode) {
      let ref = byName.get(name);
      let loadPromise = ref?.deref();
      if (loadPromise === undefined) {
        loadPromise = loadFrom(getCode);
        ref = new WeakRef(loadPromise);
        byName.set(name, ref);
        track(loadPromise, name, ref);
      }
      return makeStub(loadPromise, name, ref);
    },
  };
};

// A `services` binding's declared `props`, as the structured-clone bytes
// every call on the binding carries. The node passes the JSON text; parsing
// it here, rather than evaluating an object literal, keeps a "__proto__" key
// an own property, as it is in the manifest. The bound matches loader props:
// the bytes ride on a host job for each call. The deploy already refuses
// props that could encode past it; this covers a manifest that another
// control plane wrote.
const __SERVICE_PROPS_MAX = 1 << 20;
__celld.__propsBytes = (binding, json) => {
  const bytes = __rpcOut(JSON.parse(json), false);
  if (bytes.length > __SERVICE_PROPS_MAX)
    throw new RangeError(
      `Service binding ${binding} props size (${bytes.length} bytes) ` +
      `exceeds the maximum allowed size of ${__SERVICE_PROPS_MAX} bytes.`);
  return bytes;
};

const __makeServiceBinding = __celld.__makeServiceBinding =
  (script, entrypoint = null, propsSc = undefined) => {
  // One request to the target. fetch() follows its redirects back through
  // it (see __fetchThrough).
  const send = async (req) => {
    const signal = req._signalForSubrequests;
    if (signal?.aborted) throw signal.reason;
    // A stream body advertises its length the way the HTTP layer
    // would: known length -> Content-Length, unknown -> chunked. On the
    // target's copy only: a redirect sends the caller's headers again.
    let framing = null;
    if (__bodyBytesOf(req) === null &&
        !req.headers.has("content-length") &&
        !req.headers.has("transfer-encoding")) {
      const length = req.body._expectedLength;
      framing = length === undefined
        ? ["transfer-encoding", "chunked"]
        : ["content-length", String(length)];
    }
    const framed = (copy) => {
      if (framing !== null) copy.headers.set(framing[0], framing[1]);
      return copy;
    };
    // Fast path: the target is this same script, so its handler lives in
    // this isolate. Skip the op + pool-thread hop and call it directly,
    // inside its own event so the target's waitUntil does not attach to
    // the caller's. Cross-script targets still need their own isolate.
    // The default export with props goes this way too: only an entrypoint
    // dispatch delivers props.
    if (script === __cell.script &&
        (entrypoint !== null || propsSc !== undefined)) {
      // Mirror __dispatchTo: the target sees a fresh incoming signal,
      // aborted with "The client has disconnected" when the caller
      // abandons the call or cancels the response body; the caller's
      // own signal races the dispatch so an abandoned call rejects
      // immediately instead of pinning on a hung target. Its redirect mode
      // is an incoming request's (see __makeRequest), not the caller's.
      const requestController = new AbortController();
      const dispatch = __dispatchEntrypointFetch(
        entrypoint ?? "default",
        framed(new Request(req, {
          signal: requestController.signal,
          redirect: "manual",
          __celldIncomingSignal: true,
        })),
        propsSc ?? null);
      const response = signal
        ? await __raceCallerAbort(dispatch, signal, () =>
            requestController.abort(
              new Error("The client has disconnected")))
        : await dispatch;
      __attachResponseRequestCancellation(
        response, requestController, true);
      return __wrapServiceResponse(response, req.url);
    }
    if (script === __cell.script && entrypoint === null &&
        typeof __cell.selfFetch === "function") {
      if (__cell.svcDepth >= 8)
        throw new Error(
          "Service binding recursion limit exceeded (8)");
      __cell.svcDepth = (__cell.svcDepth || 0) + 1;
      const ctx = __beginEvent();
      try {
        // The target gets an incoming request's redirect mode (see
        // __makeRequest), so it needs its own Request rather than the
        // caller's.
        const incoming = framed(new Request(req, { redirect: "manual" }));
        return __wrapServiceResponse(
          await __ctxRun(undefined,
            () => __cell.selfFetch(incoming, __cell.env, ctx)),
          req.url);
      } finally {
        __cell.svcDepth--;
        __endEvent();
      }
    }
    // The verbatim header list; see the note on the outbound `fetch`. The
    // target isolate rebuilds a `Headers` from these pairs, so a repeat and
    // its casing survive the crossing.
    const list = req.headers.__celldHeaderList;
    if (framing !== null) list.push(framing);
    const headers = JSON.stringify(list);
    // Cross-isolate calls carry exact bytes. A host-backed stream transfers
    // its one source to the target, and another stream uses the byte fallback.
    const { body, streamId } = await __subrequestBody(req);
    const r = __jsonParse(await (signal
      ? __awaitCancellableDoCall(
        __svc_call_cancellable(
          script, req.url, req.method, body, headers, streamId, entrypoint,
          propsSc),
        signal)
      : __svc_call(
        script, req.url, req.method, body, headers, streamId, entrypoint,
        propsSc)));
    const responseBody = r.streamId !== undefined
      ? new CelldHttpBodyStream(r.streamId)
      : r.body !== undefined
        ? r.body
        : Uint8Array.from(r.bodyBytes || []);
    return __wrapServiceResponse(
      new Response(responseBody, {
        status: r.status, headers: r.headers,
        webSocket: __responseSocket(r),
      }),
      req.url);
  };
  const target = {
  async fetch(input, init) {
    return __fetchThrough(new __Request(input, init), send);
  },
  // Under service_binding_extra_handlers, Fetcher.queue() runs the target's
  // queue handler. celld does not implement it, so it fails at first use.
  async queue() {
    throw new Error("Fetcher.queue() is not implemented in celld");
  },
  // Under service_binding_extra_handlers, Fetcher.scheduled() invokes the
  // target's scheduled handler and reports the outcome.
  async scheduled(options = {}) {
    if (script !== __cell.script || entrypoint !== null ||
        typeof __cell.selfScheduled !== "function")
      throw new Error(
        "scheduled() is only implemented for same-script service " +
        "bindings whose target has a scheduled handler");
    let noRetry = false;
    const ctrl = {
      scheduledTime: options.scheduledTime === undefined
        ? Date.now() : Number(options.scheduledTime),
      cron: options.cron === undefined ? "" : String(options.cron),
      noRetry() { noRetry = true; },
    };
    // The binding's props, decoded for this call; a class default export
    // reads them from this ctx too (see the selfScheduled shim).
    const ctx = __beginEvent(__localProps(propsSc));
    try {
      await __cell.selfScheduled(ctrl, __cell.env, ctx);
      return { outcome: "ok", noRetry };
    } finally {
      const drain = __endEvent();
      // scheduled() reports the event outcome, so it cannot return while the
      // work that defines that event is still pending. Fetch replies differ:
      // a streamed response can depend on waitUntil work and must return first.
      if (drain !== null) await drain;
    }
  },
  };
  // The Fetcher's own members, and Object.prototype's, are answered here,
  // and an array index is nothing.
  Object.setPrototypeOf(target, __cf.ServiceStub.prototype);
  // An omitted entrypoint selects the module's default export, which may be a
  // WorkerEntrypoint or an object handler. `entrypoint = "Name"` selects that
  // named class. Any property other than a reserved Fetcher method is an
  // awaitable/callable pipeline node: awaiting
  // resolves the property remotely (a property-GET wire op), calling
  // invokes it, and deeper access extends the path, resolved on the
  // receiver side in one op. Same-script dispatch stays in this
  // isolate, so stub-able values may cross. A property path rooted
  // directly at the binding is context-free (ctx null): awaiting it
  // starts a fresh session, as in Workerd.
  const rpcEntrypoint = entrypoint === null ? "default" : entrypoint;
  // Read once, here. A loaded Worker's env is revived before its module
  // evaluates (install_loader_env), when `__cell.script` is still unset, so
  // `local` is false for those bindings. That is also their answer once it is
  // set: they route to the loader's scripts, never to the loaded Worker's own
  // `__loader:<id>`, which did not exist when the loader minted them.
  const session = __entrypointSession(
    rpcEntrypoint, script === __cell.script, script, propsSc);
  const binding = new Proxy(target, {
    getPrototypeOf: () => __cf.ServiceStub.prototype,
    get: (base, prop) => {
    if (prop === "then") return undefined; // a stub is not a thenable
    // workerd defines queue() and scheduled() on a Fetcher only under
    // service_binding_extra_handlers; without it both are RPC methods
    // (http.h Fetcher).
    if ((prop === "queue" || prop === "scheduled") &&
        !__cell.compat.serviceBindingExtraHandlers)
      return __makeNode(session, [prop], null);
    if (Reflect.has(base, prop)) return Reflect.get(base, prop);
    if (__rpcLocalName(prop, base)) return undefined;
    if (__cell.compat.fetcherGetPutDelete &&
        (prop === "get" || prop === "put" || prop === "delete"))
      return __fetcherHelper(base.fetch, prop);
    // Workerd's test hook: the named method as a callable handle,
    // resolved -- and refused -- on the receiver side.
    if (prop === "getRpcMethodForTestOnly")
      return (name) => __makeNode(session, [String(name)], null);
    return __makeNode(session, [prop], null);
  }});
  __outboundMeta.set(binding, { script, entrypoint, propsSc });
  return binding;
};

__celld.__installLoaderEnv = (bytes, routes) => {
  const env = __sc_decode(bytes);
  const seen = new Map();
  const revive = (v) => {
    if (v === null || typeof v !== "object") return v;
    const plain = !__ArrayIsArray(v) &&
      __ObjectGetPrototypeOf(v) === __ObjectPrototype;
    const keys = plain ? __ObjectKeys(v) : null;
    if (plain && keys.length !== 0 && keys[0] === __loaderServiceMarker) {
      const routeIndex = v[__loaderServiceMarker];
      // Rust supplies flat [script, entrypoint, props] triples, and the marker
      // stores the triple index rather than an offset into that array.
      const routeOffset = routeIndex * 3;
      if (!Number.isSafeInteger(routeIndex) || routeIndex < 0 ||
          !Number.isSafeInteger(routeOffset) || routeOffset + 2 >= routes.length)
        throw new DOMException(
          "Worker Loader env contains an invalid capability.",
          "DataCloneError");
      return __makeServiceBinding(
        routes[routeOffset], routes[routeOffset + 1], routes[routeOffset + 2]);
    }
    const cached = seen.get(v);
    if (cached !== undefined) return cached;
    // A host value's marker (`__hostValueOutsideRpc`).
    if (plain && keys.length !== 0 && __isMarkerKey(keys[0]) &&
        !__isEscapedKey(keys[0])) {
      const revived = __reviveHostValue(v, keys[0], revive, false);
      if (revived === undefined) throw __corruptLiftedPayload(keys[0]);
      seen.set(v, revived);
      return revived;
    }
    if (plain) {
      // Unescape onto a copy, which keeps the key order.
      let escaped = false;
      for (let i = 0; i < keys.length; i++) {
        if (!__isMarkerKey(keys[i])) continue;
        if (!__isEscapedKey(keys[i])) throw __corruptLiftedPayload(keys[i]);
        escaped = true;
      }
      const out = escaped ? {} : v;
      seen.set(v, out);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (!escaped) v[key] = revive(v[key]);
        else __defineData(out,
          __isEscapedKey(key) ? __unescapeKey(key) : key, revive(v[key]));
      }
      return out;
    }
    seen.set(v, v);
    if (v instanceof Map) {
      const entries = [...v];
      v.clear();
      for (const [key, item] of entries) v.set(revive(key), revive(item));
      return v;
    }
    if (v instanceof Set) {
      const items = [...v];
      v.clear();
      for (const item of items) v.add(revive(item));
      return v;
    }
    if (__ArrayIsArray(v)) {
      const indices = __ObjectKeys(v);
      for (let i = 0; i < indices.length; i++)
        v[indices[i]] = revive(v[indices[i]]);
    }
    return v;
  };
  Object.assign(__cell.env, revive(env));
};
// RPC marshalling: V8 structured clone (Workerd js-rpc semantics), so
// undefined, Date, Map, Set, BigInt, typed arrays, and cycles survive.
// A value V8 cannot clone throws DataCloneError, as in Workerd.
//
// The envelope's first byte tags the payload. 0xff (the clone version
// header) = plain clone, decoded as-is. 0x01 = clone of a lifted tree in
// which RpcTarget instances, functions, and Durable Object stubs were
// replaced by stub markers; the lift runs only after a plain clone
// already threw. A projection walk happens first because V8 silently erases
// custom and null prototypes. 0x02 = a lifted tree carrying only by-value
// host types (Blob/File, Headers,
// Request/Response) and no capabilities -- decoded like 0x01, but a
// reply so tagged does not root its callee context. 0x00 = clone of
// [error, ownProps] -- a callee exception crossing as a real Error.
//
// Marker keys. In a lifted tree (envelopes 0x01 and 0x02, and a stored row
// tagged as holding stubs) every marker is a plain object whose first key
// starts with `__celld$` and a character other than `$` (`__celld$stub`,
// `__celld$hdr`, ...), and `__celld$disp` beside a plain object's own keys
// carries its disposer. A script's own key that starts with `__celld$` gets
// one more `$` after that prefix on the way out (`__celld$x` becomes
// `__celld$$x`, `__celld$$x` becomes `__celld$$$x`) and loses it on the way
// in. So no plain object of a script's reads as a marker, and every key
// arrives as it was sent (plan 1.53). Arrays are never markers and carry no
// disposer, so their keys cross as they are. The prefix tests are two string
// comparisons, which call nothing a script can replace: a key starts with
// `__celld$` exactly when it sorts from that prefix up to `__celld%`.
const __isMarkerKey = (key) => key >= "__celld$" && key < "__celld%";
const __isEscapedKey = (key) => key >= "__celld$$" && key < "__celld$%";
const __escapeKey = (key) =>
  "__celld$$" + __ReflectApply(__StringSlice, key, [8]);
const __unescapeKey = (key) =>
  "__celld$" + __ReflectApply(__StringSlice, key, [9]);
// A tree object that no lift made: a stored row an older build wrote, whose
// keys were not escaped, or bytes from something other than a lift.
const __corruptLiftedPayload = (key) => new Error(
  "corrupt RPC or storage payload: a plain object has the reserved key " +
  __jsonString(key) + ".");
const __defineData = (target, key, value) => __ObjectDefineProperty(
  target, key,
  { value, enumerable: true, configurable: true, writable: true });
// An object with no prototype, so that assigning a key never reaches a
// setter on one. V8 keeps it in fast mode, where a `{ __proto__: null }`
// literal starts as a dictionary, which costs a stored lift about half
// again.
const __bareObject = () => __ObjectSetPrototypeOf({}, null);
// An array whose indices below `length` are already its own, so that
// assigning one never reaches a setter on a prototype; cheaper than
// defining each.
const __ownArray = (length) =>
  __ReflectApply(__ArrayFill, new __Array(length), [undefined]);
const __dataCloneError = (error) => new DOMException(
  String(error && error.message || error), "DataCloneError");
// The type a refusal names: V8's constructor name, as workerd's
// serializer reports it, except that an object claiming RpcTarget's
// prototype without its brand is workerd's "JsRpcTarget".
const __rpcUnsupportedType = (value) => new DOMException(
  'Could not serialize object of type "' +
  (__isRpcTarget(value) || !(value instanceof __cf.RpcTarget)
    ? __util_constructor_name(value) || "Object" : "JsRpcTarget") +
  '". This type does not support serialization.',
  "DataCloneError");
// ---- host values by brand ----------------------------------------
// What a value is, from V8's own type checks (`op_util_type_flags`) and the
// brands of celld's host classes, never from its prototype: a script sets
// that, and V8's serializer writes `Object.create(Date.prototype)`, a class
// instance or a null-prototype object as a plain object. The envelopes
// decide by this what crosses as itself, what is copied (and so escaped)
// and what is refused, so nothing they leave to V8 is an ordinary object.
const __TYPE_PROXY = 1 << 23;
const __TYPE_MAP = 1 << 14;
const __TYPE_SET = 1 << 15;
// Values V8's serializer writes as themselves: a Date, a boxed BigInt,
// boolean, number or string, a native error, a RegExp, an ArrayBuffer, a
// view of one, a SharedArrayBuffer and a compiled Wasm module.
const __TYPE_CLONED = (1 << 1) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6) |
  (1 << 8) | (1 << 9) | (1 << 20) | (1 << 21) | (1 << 22) | (1 << 25) |
  (1 << 26) | (1 << 27);
const __isHeaders = __celld.__isHeaders;
const __isReadableStream = __celld.__isReadableStream;
const __isWritableStream = __celld.__isWritableStream;
// The host class an object is an instance of, by brand, or undefined.
// crypto.js loads after the harness, so its brand is read when needed.
const __hostKind = (v) =>
  __isHeaders(v) ? "headers"
    : __isFile(v) ? "file"
    : __isBlob(v) ? "blob"
    : __isRequest(v) ? "request"
    : __isResponse(v) ? "response"
    : __isReadableStream(v) ? "readable"
    : __isWritableStream(v) ? "writable"
    : __isAbortSignal(v) ? "signal"
    : __isRpcTarget(v) ? "target"
    : __celld.__isCryptoKey !== undefined && __celld.__isCryptoKey(v)
      ? "cryptokey"
    : undefined;
// A Headers' entries, read from its list (headers.js), for a marker; any
// other value where a request or response holds its headers is refused.
const __headerPairsOf = (headers) => {
  if (headers === null || typeof headers !== "object" || !__isHeaders(headers))
    throw __rpcUnsupportedType(headers);
  return __celld.__headerPairs(headers);
};
// workerd's refusals of host values outside RPC (probed: storage and a
// Worker Loader env), and celld's of a stream across isolates.
const __streamOnlyForRpc = (kind) => new DOMException(
  (kind === "writable" ? "WritableStream" : "ReadableStream") +
  " can only be serialized for RPC.", "DataCloneError");
const __signalNotEnabled = () => new DOMException(
  "AbortSignal serialization is not enabled.", "DataCloneError");
const __streamAcrossIsolates = () => new DOMException(
  "RPC streams cannot cross isolate boundaries yet.", "DataCloneError");
// The marker a host value crosses as by value, as workerd serializes it on
// every transport: a Headers' entries, a Blob's bytes and type, and a
// Request's or Response's parts: no body is null, and a buffered body is
// its bytes and a stream body what `body(stream)` makes of it, or, with
// `body` null (outside RPC), either is refused; a File and a CryptoKey are
// refused, as in workerd. The bytes, a Blob's type and the header list are
// the value's private state; a Request's and Response's other attributes
// are its own properties in celld (plan 1.36), so each must have its type
// or the value is refused. Nothing a script set can make a field the
// receiver interprets (`__reviveHostValue` checks each again). undefined
// for a kind that is not a value (a stream, a signal, an RpcTarget).
const __hostValueMarker = (v, kind, body) => {
  switch (kind) {
    case "headers":
      return { "__celld$hdr": __headerPairsOf(v) };
    case "blob":
      return { "__celld$blob": __blobBytesOf(v), y: __blobTypeOf(v) };
    case "request": {
      const { url, method, redirect } = v;
      if (typeof url !== "string" || typeof method !== "string" ||
          typeof redirect !== "string")
        throw __rpcUnsupportedType(v);
      return { "__celld$req": url, m: method,
               h: __headerPairsOf(v.headers), r: redirect,
               c: __hostCf(v), b: __hostBody(v, body) };
    }
    case "response": {
      // Workerd serializes the socket too, and a WebSocket does not
      // serialize. Dropping it would revive a 101 with nothing to switch to.
      if (v.webSocket) throw __rpcUnsupportedType(v.webSocket);
      const { status, statusText, type } = v;
      if (!__NumberIsInteger(status) || typeof statusText !== "string")
        throw __rpcUnsupportedType(v);
      return { "__celld$res": status,
               t: statusText || __STATUS_TEXT[status] || "",
               h: __headerPairsOf(v.headers), c: __hostCf(v),
               e: type === "error", b: __hostBody(v, body) };
    }
    case "file":
    case "cryptokey":
      throw __rpcUnsupportedType(v);
  }
  return undefined;
};
// A Request's or Response's `cf`: absent, or a plain object, which the
// receiver hands to the constructor as data.
const __hostCf = (v) => {
  const cf = v.cf;
  if (cf !== undefined && cf !== null &&
      (typeof cf !== "object" || __ObjectGetPrototypeOf(cf) !== __ObjectPrototype))
    throw __rpcUnsupportedType(v);
  return cf;
};
// A body: null without one; outside RPC, workerd's refusal; otherwise its
// private bytes, or what `body` makes of the stream it holds, which must be
// a stream.
const __hostBody = (v, body) => {
  const stream = v.body;
  if (stream === null) return null;
  if (body === null) throw __streamOnlyForRpc("readable");
  const bytes = __bodyBytesOf(v);
  if (bytes !== null) return bytes;
  if (!__isReadableStream(stream)) throw __rpcUnsupportedType(v);
  return body(stream);
};
// A host value outside RPC (stored, or in a Worker Loader env): by value
// where workerd keeps it, otherwise workerd's refusal. A body crosses
// nowhere but RPC, buffered or not.
const __hostValueOutsideRpc = (v, kind) => {
  if (kind === "readable" || kind === "writable")
    throw __streamOnlyForRpc(kind);
  if (kind === "signal") throw __signalNotEnabled();
  return __hostValueMarker(v, kind, null);
};
// What a by-value host marker revives as, or undefined for another kind.
// Every field must have the type the lift gave it, and a body is bytes, null
// or, where `streams` (RPC), a stream marker the lift built: anything else
// is a payload no lift wrote.
const __reviveHostValue = (v, kind, revive, streams) => {
  const fail = () => {
    throw new Error("corrupt RPC or storage payload: a malformed " +
      kind + " marker.");
  };
  const pairs = (h) => {
    if (!__ArrayIsArray(h)) fail();
    for (let i = 0; i < h.length; i++) {
      const pair = h[i];
      if (!__ArrayIsArray(pair) || pair.length !== 2 ||
          typeof pair[0] !== "string" || typeof pair[1] !== "string") fail();
    }
    return h;
  };
  const cf = (c) => {
    if (c !== undefined && c !== null &&
        (typeof c !== "object" ||
         __ObjectGetPrototypeOf(c) !== __ObjectPrototype)) fail();
    return c;
  };
  const body = (b) => {
    if (b === null || __isUint8Array(b)) return b;
    if (streams && b !== null && typeof b === "object" &&
        __ObjectGetPrototypeOf(b) === __ObjectPrototype) {
      const keys = __ObjectKeys(b);
      if (keys.length !== 0 && keys[0] === "__celld$rs") return revive(b);
    }
    fail();
  };
  switch (kind) {
    case "__celld$hdr":
      return new Headers(pairs(v[kind]));
    case "__celld$blob":
      if (!__isUint8Array(v[kind]) || typeof v.y !== "string") fail();
      return __reviveBlob(v.y, v[kind]);
    case "__celld$req":
      if (typeof v[kind] !== "string" || typeof v.m !== "string" ||
          typeof v.r !== "string") fail();
      return __reviveRequest(v[kind], v.m, pairs(v.h), v.r, cf(v.c),
        body(v.b));
    case "__celld$res":
      if (!__NumberIsInteger(v[kind]) || typeof v.t !== "string" ||
          typeof v.e !== "boolean") fail();
      return __reviveResponse(v[kind], v.t, pairs(v.h), cf(v.c), v.e,
        body(v.b));
  }
  return undefined;
};
const __TYPE_UINT8ARRAY = 1 << 28;
const __isUint8Array = (v) => v !== null && typeof v === "object" &&
  (__util_type_flags(v) & __TYPE_UINT8ARRAY) !== 0;
// V8 clones a user-class instance and a null-prototype object as plain data,
// but Workerd refuses both over RPC. Project the value graph before V8 can
// erase that distinction. The projection also snapshots enumerable getters,
// so validation and serialization cannot invoke one getter twice. Native
// clone types and RPC host types keep their own serializers.
//
// A refused value projects to a placeholder that fails the plain clone, and
// the lift throws its error where it meets it: serialization fails in order,
// so whatever the lift took before it is released, as in workerd.
// `unsupported` maps each placeholder to its error, in projection order.
const __rpcProject = (value) => {
  let host = false;
  const seen = new Map();
  const originals = new WeakMap();
  const unsupported = new Map();
  const project = (v) => {
    if (v === null || (typeof v !== "object" && typeof v !== "function"))
      return v;
    const cached = seen.get(v);
    if (cached !== undefined) return cached;
    // Capabilities and Proxies go to the lift as they are.
    if (typeof v === "function" ||
        __ReflectApply(__WeakMapHas, __stubMeta, [v]) ||
        __ReflectApply(__WeakMapHas, __svcMeta, [v]) ||
        __ReflectApply(__WeakMapHas, __doStubMeta, [v])) return v;
    const flags = __util_type_flags(v);
    if ((flags & __TYPE_PROXY) !== 0) return v;
    if (__ArrayIsArray(v)) {
      const out = new Array(v.length);
      seen.set(v, out);
      originals.set(out, v);
      const keys = __ObjectKeys(v);
      for (let i = 0; i < keys.length; i++)
        __defineData(out, keys[i], project(v[keys[i]]));
      return out;
    }
    // A plain object. (A host class's instance given Object.prototype is
    // copied as one too: its own keys, escaped where they need it.)
    if (__ObjectGetPrototypeOf(v) === __ObjectPrototype &&
        (flags & (__TYPE_CLONED | __TYPE_MAP | __TYPE_SET)) === 0) {
      const out = {};
      seen.set(v, out);
      originals.set(out, v);
      const keys = __ObjectKeys(v);
      for (let i = 0; i < keys.length; i++)
        __defineData(out, keys[i], project(v[keys[i]]));
      return out;
    }
    if ((flags & __TYPE_CLONED) !== 0) return v;
    // A host instance goes to the lift, which builds its marker from its
    // state: the plain clone would write a stripped one as a plain object.
    if (__hostKind(v) !== undefined) {
      host = true;
      return v;
    }
    if ((flags & __TYPE_MAP) !== 0) {
      const out = new Map();
      seen.set(v, out);
      for (const [key, entry] of v) {
        out.set(project(key), project(entry));
      }
      return out;
    }
    if ((flags & __TYPE_SET) !== 0) {
      const out = new Set();
      seen.set(v, out);
      for (const entry of v) out.add(project(entry));
      return out;
    }
    // Any other object is ordinary, whatever its prototype claims.
    const placeholder = { "__celld$unsupported": __rpcNoClone };
    unsupported.set(placeholder, __rpcUnsupportedType(v));
    seen.set(v, placeholder);
    return placeholder;
  };
  const tree = project(value);
  return { tree, originals, unsupported, host };
};
const __tagged = (tag, sc) => {
  const out = new Uint8Array(sc.length + 1);
  out[0] = tag;
  out.set(sc, 1);
  return out;
};
// ---- request-context confinement -------------------------------
// Workerd ties I/O objects to the IoContext of the event that made
// them. Cells' equivalent: each dispatched event enters an
// async-context frame (the same CPED the ALS rides, so it survives
// awaits) carrying a context id. Stubs remember their owning
// context and refuse to serialize elsewhere; pipeline nodes refuse
// foreign awaits and calls -- each with Workerd's exact error.
let __nextCtxId = 1;
const __ctxKey = Symbol("celld.ctx");
const __ctxNow = () => {
  const frame = __als_get();
  return frame === undefined ? undefined : frame.get(__ctxKey);
};
// Run `fn` under context `id` (undefined = a fresh one). An async
// fn started inside keeps the frame across its awaits. The prior
// frame is cloned so user AsyncLocalStorage stores still flow into
// same-isolate callees, as they did before contexts existed.
const __ctxRun = (id, fn) => {
  const prior = __als_get();
  const frame = new Map(prior);
  frame.set(__ctxKey, id ?? __nextCtxId++);
  __als_set(frame);
  try {
    return fn();
  } finally {
    __als_set(prior);
  }
};
const __ctxError = (kind) => new Error(
  "Cannot perform I/O on behalf of a different request. I/O " +
  "objects (such as streams, request/response bodies, and others) " +
  "created in the context of one request handler cannot be " +
  "accessed from a different request's handler. This is a " +
  "limitation of Cloudflare Workers which allows us to improve " +
  "overall performance. (I/O type: " + kind + ")");
// ---- abortable request contexts --------------------------------
// Workerd's ctx.abort(reason) on an entrypoint aborts the request's
// IoContext: the in-flight call rejects with the reason, and stubs
// the context holds are disposed (their disposal callbacks fire).
// State is allocated only when a context first holds a stub handle
// or aborts, so plain-data dispatch pays nothing; call paths gate
// every abort lookup on `__abortedCtxs.size` (one field read).
// Aborted ids stay recorded: a stub rooted in a dead context must
// keep rejecting with the reason.
const __abortedCtxs = new Map();
// An actor-flavored abort reason: in-flight ops reject with the
// wrapped reason, later ops with Workerd's post-abort message
// (upstream TODO(bug): should propagate the reason, but doesn't).
class __ActorAbort { constructor(reason) { this.reason = reason; } }
const __postAbortError = (aborted) => aborted instanceof __ActorAbort
  ? new Error("The execution context which hosts this callback " +
      "is no longer running.")
  : aborted;
// ctx id -> Set of live stub handles (metas) the context holds.
const __ctxStubs = new Map();
// ctx id -> Set of reject callbacks for stub ops in flight against
// that context. A hung callee never settles, so a context abort
// must reject its pending callers directly.
const __ctxPendingOps = new Map();
const __opTrack = (ctx, reject) => {
  let set = __ctxPendingOps.get(ctx);
  if (set === undefined) __ctxPendingOps.set(ctx, set = new Set());
  set.add(reject);
  return () => {
    set.delete(reject);
    if (set.size === 0) __ctxPendingOps.delete(ctx);
  };
};
const __ctxRegister = (meta) => {
  if (meta.ctx === undefined) return;
  let set = __ctxStubs.get(meta.ctx);
  if (set === undefined) __ctxStubs.set(meta.ctx, set = new Set());
  set.add(meta);
};
const __ctxUnregister = (meta) => {
  const set = __ctxStubs.get(meta.ctx);
  if (set === undefined) return;
  set.delete(meta);
  if (set.size === 0) __ctxStubs.delete(meta.ctx);
};
// Tear down a context: dispose every handle it still holds, so a
// dup() leaked into it reaches the sender's disposal callback.
const __ctxEnd = (id) => {
  const set = __ctxStubs.get(id);
  if (set === undefined) return;
  __ctxStubs.delete(id);
  for (const meta of set) __disposeStub(meta);
};
const __ctxAbort = (id, reason) => {
  if (id === undefined || __abortedCtxs.has(id)) return;
  const stored = reason === undefined
    ? new Error("The execution context has been aborted.")
    : reason;
  __abortedCtxs.set(id, stored);
  __ctxEnd(id);
  const pending = __ctxPendingOps.get(id);
  if (pending === undefined) return;
  __ctxPendingOps.delete(id);
  const live =
    stored instanceof __ActorAbort ? stored.reason : stored;
  for (const reject of pending) reject(live);
};
// The entrypoint ctx.abort. Instances are cached across calls, so
// the construction-time ctx cannot pin a request id (Workerd
// constructs per request); the current frame's id at abort() time
// is the request being served, which matches Workerd observably.
const __ctxAbortCurrent =
  (reason) => __ctxAbort(__ctxNow(), reason);
// ---- same-process RPC stubs ------------------------------------
// A stub entry owns a local target; `refs` counts live handles
// across dup()s. When the last handle is disposed the target's own
// Symbol.dispose runs (async, matching Workerd's disposal callback).
// Stubs cross same-isolate transports only (same-script entrypoint
// RPC and same-process routed dispatch); a marker revived elsewhere fails
// loudly on use instead of aliasing an unrelated local entry.
// `ctx` records the owning request context: the entry's for
// running its target, the handle's for the serialize-elsewhere
// check.
const __stubEntries = new Map();
const __stubMeta = new WeakMap();
// Keep the Durable Object brand outside the user-visible object. Reading a
// string property here would invoke an inherited getter before validation can
// reject its unsupported prototype.
const __doStubMeta = new WeakMap();
let __nextStubId = 1;
// Which isolate a marker's entry id belongs to. Only a lift writes a marker
// (a script's keys are escaped), so the token is no authority: it keeps a
// marker from another isolate from naming a local entry. 128 random bits,
// drawn before any script runs.
const __stubIsolate = (() => {
  const words = new Uint32Array(4);
  $$randomValues(words);
  let token = "";
  for (let i = 0; i < words.length; i++)
    token += (words[i] + 0x100000000).toString(16).slice(1);
  return token;
})();
const __newEntry = (target) => {
  // `scope` records the actor event that minted the entry (top of
  // the event stack at lift time), so an actor breakage can find
  // and abort the contexts hosting its exported stubs, and an op on
  // the stub can queue on that cell's input gate. `section` is the
  // critical section running at lift time, if any -- an op on this
  // stub re-enters it rather than queueing behind it.
  const scope = __currentActorScope() || undefined;
  const entry = {
    id: __nextStubId++, target, refs: 1, ctx: __ctxNow(), scope,
    section: __cellBlocks.get(scope)?.holder ?? null,
  };
  __stubEntries.set(entry.id, entry);
  return entry;
};
// Actors broken in JS: scope -> reason. Workerd's DO ctx.abort
// rejects in-flight and future calls; when the abort fires under a
// same-isolate stub caller, terminate_execution would unwind that
// caller too (the routed dispatch re-enters the isolate), so the
// breakage is recorded here instead: contexts hosting the actor's
// exported stubs abort (in-flight ops reject with the reason,
// later ops with the post-abort message) and RPC dispatch to the
// scope rejects with the reason. Direct host-dispatched DO events
// keep the uncatchable terminate_execution path.
const __brokenActors = new Map();
const __actorBreak = (scope, reason) => {
  if (__brokenActors.has(scope)) return;
  __brokenActors.set(scope, reason);
  for (const entry of __stubEntries.values())
    if (entry.scope === scope)
      __ctxAbort(entry.ctx, new __ActorAbort(reason));
};
// Everything this isolate holds for one cell scope that belongs to the
// cell's residency rather than to the isolate, so a fresh instance
// inherits none of it. `adopt_cell` calls this on both edges: the
// give-back frees it, the take-in guarantees that no epoch spans.
// Storage is not here -- `stop_cell` closes it host-side -- and sockets
// live in the host registry, so a hibernated cell keeps them.
const __cellRelease = (scope) => {
  const state = __instanceState(__cell.instances[scope]);
  if (state !== undefined) __facetsRelease(__objectState.facets(state));
  delete __cell.instances[scope];
  delete __cell.idNames[scope];
  delete __cell.facetConfigs[scope];
  __brokenActors.delete(scope);
  // An abandoned block can never run `__blockLeave`. A normal eviction
  // cannot abandon a block because its event keeps the cell in flight. A
  // stop that waits for nobody can, so the release drops every block record
  // together with the other state for this residency.
  __cellBlocks.delete(scope);
  // An entry holds `target`, which can be an object the released
  // instance owns. Dropping it ends that reachability; `released` is
  // what an already-revived handle reads, since it holds its entry
  // directly and never looks in this map again.
  for (const entry of __stubEntries.values()) {
    if (entry.scope !== scope) continue;
    entry.released = true;
    __stubEntries.delete(entry.id);
    // Break in-flight ops as an abort would, but not through
    // `__actorBreak`: that records the scope broken for the life of the
    // isolate, which is the state this function drops.
    __ctxAbort(entry.ctx, new __ActorAbort(__releasedStubError()));
  }
};
const __releasedStubError = () => new Error(
  "The Durable Object that returned this RPC stub no longer runs on " +
  "this node.");
// Drop one reference to an entry; the last one runs the target's disposer.
const __releaseEntry = (entry) => {
  if (--entry.refs > 0) return;
  __stubEntries.delete(entry.id);
  const disposer = entry.target?.[Symbol.dispose];
  if (typeof disposer === "function")
    Promise.resolve().then(() => disposer.call(entry.target));
};
const __disposeStub = (meta) => {
  if (meta.disposed) return;
  meta.disposed = true;
  __ctxUnregister(meta);
  __releaseEntry(meta.entry);
};
// The end of a call disposes the stubs its params brought, last
// first, as workerd releases a message's capabilities.
const __disposeReceived = (handles) => {
  for (let i = handles.length - 1; i >= 0; i--) __disposeStub(handles[i]);
};
const __stubDisposedError = () =>
  new Error("RPC stub used after being disposed.");
// Shared brand value for RpcTarget instances; see the RpcTarget
// constructor.
const __rpcNoClone = () => {};
// Workerd method-visibility rules by target kind: an RpcTarget, an
// entrypoint or a Durable Object exposes inherited methods/accessors (never
// own instance state, never Object.prototype); a plain object or function
// exposes own properties only. Property reads go through normal [[Get]] so
// Proxy handlers participate, as in Workerd.
const __rpcNoSuchMethod = (prop) => new TypeError(
  'The RPC receiver does not implement the method "' + prop + '".');
// Reserved names, by the kind of target a call starts at (worker-rpc.c++
// isReservedName): a transient target -- an RpcStub's, or a call result's
// pipeline -- reserves two, and an entrypoint or a Durable Object also
// reserves its handlers. Every name on a path is checked against the set of
// the target the call started at, before any user code runs.
const __transientReserved = new Set(["constructor", "dup"]);
const __entrypointReserved = new Set([
  "constructor", "fetch", "connect", "alarm",
  "webSocketMessage", "webSocketClose", "webSocketError", "dup",
]);
const __rpcReservedError = (prop) => new TypeError("'" + prop +
  "' is a reserved method and cannot be called over RPC.");
// A class member, as workerd's tryGetProperty() finds it: one [[Get]], never
// `in`, so a Proxy's `get` trap answers for it and its `has` trap is not
// asked. An own property (by [[GetOwnProperty]], which a Proxy's trap
// answers too) stays hidden, and a read of undefined is a missing method.
// Object.prototype's names are refused before any user code runs. Workerd
// reads them and compares with Object.prototype's, but no stub sends one:
// celld's stubs answer them locally, as workerd's do, so only a peer or the
// test hook can ask, and the stricter refusal runs nothing for them.
const __rpcClassMember = (target, prop) => {
  if (prop in Object.prototype || __ObjectHasOwn(target, prop))
    throw __rpcNoSuchMethod(prop);
  const value = target[prop];
  if (value === undefined) throw __rpcNoSuchMethod(prop);
  return value;
};
// A plain object's or a function's member: its own properties only, which
// may hold undefined.
const __rpcOwnMember = (target, prop) => {
  if (!__ObjectHasOwn(target, prop)) throw __rpcNoSuchMethod(prop);
  return target[prop];
};
// Bind through the intrinsic because a callable proxy can implement `.bind`
// as a remote property. Reading that property can turn a valid named RPC
// method into a non-function. Keep this rule shared by every RPC binding site.
const __rpcBindMethod = (value, receiver) =>
  __ReflectApply(__FunctionBind, value, [receiver]);
// A member a property read answers with: a function stays bound to the
// object it was read from. celld's own stubs and pipeline nodes stay
// unwrapped because the wrapper would lose their metadata.
const __rpcBindMember = (value, receiver) =>
  typeof value === "function" && !__stubMeta.has(value) &&
      !(value instanceof __cf.RpcPromise) &&
      !(value instanceof __cf.RpcProperty)
    ? __rpcBindMethod(value, receiver) : value;
// A name a stub, a pipeline node or a Fetcher reads locally rather than
// as RPC: an array index, which workerd's wildcard property never sees
// (V8 hands indexed keys to a separate interceptor), and every name the
// stub's own prototype chain has, which includes Object.prototype's.
const __rpcLocalName = (prop, proto) => {
  if (typeof prop !== "string" || prop in proto) return true;
  const first = prop.charCodeAt(0);
  return first >= 48 && first <= 57 &&
    /^(?:0|[1-9][0-9]*)$/.test(prop) && Number(prop) < 4294967295;
};
// ---- streams over RPC ------------------------------------------
// A live stream crosses as a handle in the caps table: the sender
// locks the origin (reader/writer acquired at lift) behind a
// bridge entry, and the receiver's endpoint is an ordinary
// ReadableStream/WritableStream whose pulls and writes are stub
// ops against the bridge -- one bounded reverse call per chunk,
// the clone being the one wire copy. Backpressure is the op in
// flight: hwm 0 pulls only on demand, and the writable carries
// one chunk per op. EOF, close, and errors cross as op results;
// teardown (param disposal, context end, context abort) runs the
// bridge disposer, which cancels or aborts an unfinished origin
// with Workerd's generic disconnect errors -- reasons do not
// propagate, matching Workerd's own TODOs (and its verbatim
// "endeded" typo).
const __wsDisconnect = () => new Error(
  "WritableStream received over RPC was disconnected because " +
  "the remote execution context has endeded.");
const __rsDisconnect = () => new Error(
  "ReadableStream received over RPC disconnected prematurely.");
// Receiver wrapper stream -> its handle meta, for forwarding.
const __rpcStreamMeta = new WeakMap();
const __readableBridge = (reader) => {
  const bridge = {
    done: false,
    async read() {
      let result;
      try {
        result = await reader.read();
      } catch (error) {
        bridge.done = true;
        throw error;
      }
      if (result.done) bridge.done = true;
      return result;
    },
    cancel() {
      if (bridge.done) return;
      bridge.done = true;
      reader.cancel(__rsDisconnect()).catch(() => {});
    },
    [Symbol.dispose]() { bridge.cancel(); },
  };
  return bridge;
};
const __writableBridge = (writer) => {
  const bridge = {
    done: false,
    write: (chunk) => writer.write(chunk),
    close() {
      bridge.done = true;
      return writer.close();
    },
    abort() {
      bridge.done = true;
      return writer.abort(__wsDisconnect());
    },
    [Symbol.dispose]() {
      if (!bridge.done) bridge.abort().catch(() => {});
    },
  };
  return bridge;
};
const __liftStream = (v, readable = __isReadableStream(v)) => {
  const key = readable ? "__celld$rs" : "__celld$ws";
  const meta = __rpcStreamMeta.get(v);
  if (meta !== undefined && !meta.disposed && !v.locked) {
    // Re-serializing a received, untouched stream forwards the
    // original handle: the reference moves (like a stub) and
    // the local wrapper is dead -- a round trip stays one hop.
    meta.disposed = true;
    __ctxUnregister(meta);
    return { [key]: meta.entry.id, t: __stubIsolate };
  }
  if (v.locked)
    throw new TypeError(readable
      ? "The ReadableStream has been locked to a reader."
      : "The WritableStream has been locked to a writer.");
  const bridge = readable
    ? __readableBridge(v.getReader())
    : __writableBridge(v.getWriter());
  return { [key]: __newEntry(bridge).id, t: __stubIsolate };
};
// A signal is not a snapshot on the RPC wire. The marker carries a
// process-wide identity, and the host forwards the source's single state
// transition to every receiving isolate. A received signal keeps that
// identity when an RPC forwards it again, so a chain does not add relays.
const __rpcSignalMeta = new WeakMap();
const __rpcSignalReceivers = new Map();
const __rpcSignalSourceFinalizer = new FinalizationRegistry(
  (id) => __rpc_signal_release(id));
const __rpcSignalReceiverFinalizer = new FinalizationRegistry(
  ({ id, subscription }) =>
    __rpc_signal_unsubscribe(id, subscription));
const __rpcSignalReasonOut = (reason) => {
  if (reason instanceof DOMException)
    return __sc_encode({ d: true, n: reason.name, m: reason.message });
  try {
    return __sc_encode({ v: reason });
  } catch {
    return __sc_encode({ v: new Error(String(reason)) });
  }
};
const __rpcSignalReasonIn = (bytes) => {
  const reason = __sc_decode(bytes);
  return reason.d
    ? new DOMException(reason.m, reason.n)
    : reason.v;
};
const __rpcSignalSubscribe = (receiver) => {
  const signal = receiver.signal.deref();
  if (signal === undefined) return false;
  const pending = __rpc_signal_wait(receiver.id);
  receiver.subscription = pending.__celldRpcSignalSubscription;
  pending.then((reason) => {
    const target = receiver.signal.deref();
    if (target !== undefined && reason.byteLength !== 0)
      __abortSignal(target, __rpcSignalReasonIn(reason));
  });
  // A wait belongs to the request that installed it. A retained signal needs
  // a fresh wait in each later request, and its finalizer must unsubscribe the
  // newest one rather than the dead request's subscription.
  __rpcSignalReceiverFinalizer.unregister(receiver);
  __rpcSignalReceiverFinalizer.register(signal, receiver, receiver);
  return true;
};
const __liftSignal = (signal) => {
  let meta = __rpcSignalMeta.get(signal);
  if (meta === undefined) {
    const id = __rpc_signal_new();
    meta = { id };
    __rpcSignalMeta.set(signal, meta);
    __rpcSignalSourceFinalizer.register(signal, id);
    if (signal.aborted) {
      __rpc_signal_abort(id, __rpcSignalReasonOut(signal.reason));
    } else {
      signal.addEventListener("abort", (event) => {
        __rpc_signal_abort(id,
          __rpcSignalReasonOut(event.target.reason));
      }, { once: true });
    }
  }
  return { "__celld$sig": meta.id, a: signal.aborted,
           r: signal.aborted ? __rpcSignalReasonOut(signal.reason) : null };
};
const __rpcSignalRefresh = () => {
  for (const [id, receivers] of __rpcSignalReceivers) {
    const state = __rpc_signal_poll(id);
    const live = new Set();
    for (const receiver of receivers) {
      const signal = receiver.signal.deref();
      if (signal === undefined) continue;
      if (state instanceof Uint8Array)
        __abortSignal(signal, __rpcSignalReasonIn(state));
      else if (state !== null && __rpcSignalSubscribe(receiver))
        live.add(receiver);
    }
    if (live.size === 0 || state === null || state instanceof Uint8Array)
      __rpcSignalReceivers.delete(id);
    else
      __rpcSignalReceivers.set(id, live);
  }
};
// What a call's param crosses as under rpc_params_dup_stubs, when it
// is an RpcTarget, a function, or a Proxy of either: what its own
// dup() returns, which must be the same kind, or else the value
// itself (workerd's JsRpcTarget::serialize, serializeFunction and
// serializeProxy). The call then owns, and later disposes, that.
//
// A Proxy's kind is the stub it presents (workerd's checkStubType):
// an RpcTarget by its prototype chain, or else a plain object or a
// callable other than an RPC promise or property; its dup() may
// return either a Proxy or not, of that kind.
// An RpcTarget that is not a Proxy must dup() to another such
// RpcTarget, and a function to a function.
const __rpcProxyKind = (v) =>
  v instanceof __cf.RpcTarget ? "target"
    : Object.getPrototypeOf(v) === Object.prototype ||
        (typeof v === "function" && !(v instanceof __cf.RpcPromise) &&
          !(v instanceof __cf.RpcProperty)) ? "object"
    : null;
const __rpcParamDup = (v) => {
  const dup = v.dup;
  if (typeof dup !== "function") return v;
  const replacement = Reflect.apply(dup, v, []);
  const object = replacement !== null &&
    (typeof replacement === "object" || typeof replacement === "function");
  let message;
  if (__util_proxy_details(v) !== undefined) {
    if (object && __rpcProxyKind(replacement) === __rpcProxyKind(v))
      return replacement;
    message = "Couldn't create a stub for the Proxy because it has a " +
      "dup() method which did not return the same underlying type " +
      "(RpcTarget or Function) as the Proxy itself represents. Either " +
      "remove the dup() method or make sure it returns an RpcTarget.";
  } else if (typeof v === "function") {
    if (typeof replacement === "function" &&
        !(replacement instanceof __cf.RpcPromise) &&
        !(replacement instanceof __cf.RpcProperty))
      return replacement;
    message = "Couldn't create a stub for the function because it has " +
      "a dup() method which did not return another function. Either " +
      "remove the dup() method or make sure it returns a function.";
  } else {
    if (object && __isRpcTarget(replacement) &&
        __util_proxy_details(replacement) === undefined)
      return replacement;
    // "RcpTarget" is workerd's spelling.
    message = "Couldn't create a stub for the RcpTarget because it has " +
      "a dup() method which did not return another RpcTarget. Either " +
      "remove the dup() method or make sure it returns an RpcTarget.";
  }
  throw new DOMException(message, "DataCloneError");
};
// Replace stub-able values with wire markers. Runs only after a
// plain clone failed, so plain-data serialization never pays for
// it. Each entry reference a marker carries is pushed to `refs`, so
// a failed serialization can release it. An existing stub's
// reference is duplicated when `dupStubs` (a call's params under
// rpc_params_dup_stubs) and otherwise transferred: the sender's
// handle is disposed (dup() first to keep one) and the receiver
// adopts it. Returns null when nothing was liftable. Throws a
// projected value's refusal where the walk meets it.
//
// The walk rewrites the projection in place: its plain objects and
// arrays are the projection's own copies, whose keys are own data
// properties, so no setter a script put on a prototype sees the tree.
// A plain object with a key that starts with `__celld$` is copied
// instead, onto a null-prototype object, with that key escaped (see
// "Marker keys"). Markers are object literals, their marker key first
// and every field own.
const __stubLift = (projected, allowCapabilities, refs, dupStubs) => {
  const { originals, unsupported } = projected;
  let lifted = false;
  // Capabilities (stubs, disposers) root the callee context;
  // by-value host types do not -- they pick the 0x02 envelope.
  let caps = false;
  const seen = new __SafeMap();
  const cache = (v, out) => __ReflectApply(__MapSet, seen, [v, out]);
  const ref = (entry) => __ReflectApply(__ArrayPush, refs, [entry]);
  const ctx = __ctxNow();
  // A stream body crosses as a stream handle (a capability, so the reply
  // roots its callee context and the pulls keep working), within an isolate.
  const liftBody = (stream) => {
    if (!allowCapabilities) throw __streamAcrossIsolates();
    caps = true;
    return __liftStream(stream, true);
  };
  const lift = (v) => {
    if (v === null ||
        (typeof v !== "object" && typeof v !== "function")) return v;
    const cached = __ReflectApply(__MapGet, seen, [v]);
    if (cached !== undefined) return cached;
    const refused = __ReflectApply(__MapGet, unsupported, [v]);
    if (refused !== undefined) throw refused;
    const meta = __ReflectApply(__WeakMapGet, __stubMeta, [v]);
    if (meta) {
      if (!allowCapabilities) return v;
      lifted = true;
      caps = true;
      if (meta.disposed) throw __stubDisposedError();
      // A stub belongs to the request that received it; another
      // request cannot serialize it (Workerd's IoContext rule).
      if (meta.ctx !== ctx) throw __ctxError("Client");
      if (dupStubs) {
        meta.entry.refs++;
      } else {
        meta.disposed = true; // the ref moves to the receiver
        __ctxUnregister(meta);
      }
      ref(meta.entry);
      const marker = { "__celld$stub": meta.entry.id,
                       t: __stubIsolate, c: meta.callable, np: false };
      cache(v, marker);
      return marker;
    }
    const svc = __ReflectApply(__WeakMapGet, __svcMeta, [v]);
    if (svc !== undefined) {
      if (!allowCapabilities) return v;
      // A loopback service stub (ctx.exports): name + props cross
      // as plain data and revive as a fresh loopback stub. Props
      // are lifted too -- they may nest further stubs (Workerd's
      // nested channel tokens).
      lifted = true;
      caps = true;
      const marker = { "__celld$svc": svc.name, t: __stubIsolate,
                       p: undefined };
      cache(v, marker);
      if (svc.props !== undefined) marker.p = lift(svc.props);
      return marker;
    }
    // The projection's own plain objects and arrays are data: walk them.
    const copy = __ReflectApply(__WeakMapGet, originals, [v]);
    if (copy !== undefined) return walk(v, copy, __ArrayIsArray(v));
    // Workerd refuses to serialize its promise/property handles.
    if (v instanceof __cf.RpcPromise || v instanceof __cf.RpcProperty)
      throw new DOMException(
        'Could not serialize object of type "' +
        (v instanceof __cf.RpcPromise ? "RpcPromise" : "RpcProperty") +
        '". This type does not support serialization.',
        "DataCloneError");
    // Classified by brand (`__hostKind`); only a Proxy is classified by
    // the prototype chain it presents, as workerd does.
    const proxy = (__util_type_flags(v) & __TYPE_PROXY) !== 0;
    const kind = proxy ? undefined : __hostKind(v);
    if (typeof v === "function" || kind === "target" ||
        (proxy && v instanceof __cf.RpcTarget)) {
      if (!allowCapabilities) return v;
      lifted = true;
      caps = true;
      const target = dupStubs ? __rpcParamDup(v) : v;
      const entry = __newEntry(target);
      ref(entry);
      // A Proxy that claims to be an RpcTarget crosses as a stub, but a
      // call that returns one has no pipeline: workerd's brand check
      // (isInstanceOf<JsRpcTarget>) fails for it. The stub it revives as
      // says so (`__walkLocal`); a stub passed on from there is an
      // ordinary one.
      const marker = { "__celld$stub": entry.id,
                       t: __stubIsolate,
                       c: typeof target === "function",
                       np: typeof target !== "function" &&
                         __util_proxy_details(target) !== undefined };
      cache(v, marker);
      return marker;
    }
    const doId = __ReflectApply(__WeakMapGet, __doStubMeta, [v]);
    if (doId !== undefined) {
      if (!allowCapabilities) return v;
      lifted = true;
      caps = true;
      const marker = { "__celld$do": __doIdClass(doId),
                       v: doId.toString(), n: v.name ?? null };
      cache(v, marker);
      return marker;
    }
    // HTTP host types cross by value, as in Workerd's RPC
    // serialization: entry lists for Headers, the buffered bytes
    // for bodies (the marker aliases the live buffer; the clone
    // is the one wire copy), and no signal -- the receiver mints
    // a fresh one. A live stream body cannot cross yet.
    // A host instance never reaches the clone in a lifted tree: V8 would
    // write it as a plain object of its own keys, which a script sets. A
    // value crosses as a marker built from its state, on every transport
    // (`__hostValueMarker`); a stream crosses as a handle, within an isolate
    // only; a signal as its process-wide identity.
    let marker;
    if (kind === "readable" || kind === "writable") {
      if (!allowCapabilities) throw __streamAcrossIsolates();
      caps = true;
      marker = __liftStream(v, kind === "readable");
    } else if (kind === "signal") {
      marker = __liftSignal(v);
    } else if (kind !== undefined) {
      marker = __hostValueMarker(v, kind, liftBody);
    }
    if (marker !== undefined) {
      lifted = true;
      cache(v, marker);
      return marker;
    }
    // What is left is a value V8 writes as itself (a Date, a RegExp, an
    // ArrayBuffer, a Map or Set: their contents stay the clone's), a Proxy,
    // or an object read through a Proxy, which the projection did not walk
    // and which is classified here as it would have been.
    if (!proxy) {
      if ((__util_type_flags(v) &
          (__TYPE_CLONED | __TYPE_MAP | __TYPE_SET)) !== 0) return v;
      const array = __ArrayIsArray(v);
      if (array || __ObjectGetPrototypeOf(v) === __ObjectPrototype)
        return walk(v, v, array);
      throw __rpcUnsupportedType(v);
    }
    // A Proxy emulating neither a plain object nor an RpcTarget is
    // Workerd's canonical proxy serialization error. One emulating a
    // plain object is copied through its traps, never written to.
    const array = __ArrayIsArray(v);
    if (!array && __ObjectGetPrototypeOf(v) !== __ObjectPrototype)
      throw new DOMException(
        "Proxy could not be serialized because it is not a " +
        "valid RPC receiver type. The Proxy must emulate either " +
        "a plain object or an RpcTarget, as indicated by the " +
        "Proxy's prototype chain.", "DataCloneError");
    return walk(v, v, array);
  };
  // Lift the keys of a plain object or array `v`: in place when it is the
  // projection's own copy and needs no escape, otherwise onto a copy.
  // `source` is the script's object, whose disposer it carries.
  const walk = (v, source, array) => {
    const keys = __ObjectKeys(v);
    // The projection's copy is not the script's object; a Proxy is.
    let inPlace = source !== v;
    for (let i = 0; inPlace && !array && i < keys.length; i++)
      if (__isMarkerKey(keys[i])) inPlace = false;
    const out = inPlace ? v : array ? [] : __bareObject();
    cache(v, out);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (inPlace) v[key] = lift(v[key]);
      else if (array) __defineData(out, key, lift(v[key]));
      else out[__isMarkerKey(key) ? __escapeKey(key) : key] = lift(v[key]);
    }
    const disposer = source[Symbol.dispose];
    if (allowCapabilities && !array &&
        typeof disposer === "function" && disposer !== __rpcNoDisposer) {
      lifted = true;
      caps = true;
      const entry = __newEntry(__rpcBindMethod(disposer, source));
      ref(entry);
      __defineData(out, "__celld$disp", entry.id);
    }
    return out;
  };
  const tree = lift(projected.tree);
  return lifted ? { tree, caps } : null;
};
// Revive host-type markers into real instances, adopting the wire
// bytes directly -- no copy beyond the clone's own.
const __reviveBlob = (type, bytes) => {
  const blob = new Blob([], { type });
  __setBlobBytes(blob, bytes);
  return blob;
};
const __adoptBody = (target, bytes) => {
  __setBodyBytes(target, bytes);
  target._body = undefined; // decoded lazily on the first text()/json()
  const body = target.body;
  if (body !== null) {
    body._st.bytes = bytes;
    body._expectedLength = bytes.byteLength;
  }
};
// A body that is not bytes is a revived stream, which the constructor
// adopts as a streaming body.
const __reviveRequest = (url, method, headers, redirect, cf, body) => {
  if (!__isUint8Array(body))
    return new Request(url, { method, headers, redirect, cf, body });
  const req = new Request(url, { method, headers, redirect, cf });
  __adoptBody(req, body);
  return req;
};
const __reviveResponse = (status, statusText, headers, cf, error, body) => {
  const bytes = __isUint8Array(body);
  const res = new Response(body === null ? null : bytes ? "" : body,
    { status, statusText, headers, cf });
  if (bytes) __adoptBody(res, body);
  if (error) res.type = "error";
  return res;
};
// Wire a received stream handle to a local endpoint built with
// the ordinary constructors -- nothing new threads through the
// stream hot paths. Read errors surface as Workerd's generic
// premature-disconnect; write errors propagate (Workerd sends
// real errors back through the write loop).
const __foreignStreamOp = () => Promise.reject(new Error(
  "RPC streams cannot cross isolate boundaries yet."));
const __reviveStream = (marker, id, readable, handles) => {
  const entry = marker.t === __stubIsolate
    ? __stubEntries.get(id) : undefined;
  if (entry === undefined)
    return readable
      ? new CelldChunkStream(__foreignStreamOp)
      : new WritableStream({ write: __foreignStreamOp,
          close: __foreignStreamOp, abort: __foreignStreamOp });
  const meta = { entry, disposed: false, ctx: __ctxNow() };
  __ctxRegister(meta);
  handles.push(meta);
  // A received readable is a platform stream, as in workerd, so a BYOB
  // reader works on it whatever the sender's stream was.
  const stream = readable
    ? new CelldChunkStream(async () => {
        let result;
        try {
          result = await __stubOp(meta, ["read"], []);
        } catch {
          throw __rsDisconnect();
        }
        return result.done ? null : result.value;
      }, () => __stubOp(meta, ["cancel"], []).catch(() => {}))
    : new WritableStream({
        write: (chunk) => __stubOp(meta, ["write"], [chunk]),
        close: () => __stubOp(meta, ["close"], []),
        abort: () =>
          __stubOp(meta, ["abort"], []).catch(() => {}),
      });
  __rpcStreamMeta.set(stream, meta);
  return stream;
};
const __reviveSignal = (marker, id) => {
  const controller = new AbortController();
  const signal = controller.signal;
  __rpcSignalMeta.set(signal, { id });
  if (marker.a) {
    controller.abort(__rpcSignalReasonIn(marker.r));
    return controller.signal;
  }
  let receivers = __rpcSignalReceivers.get(id);
  if (receivers === undefined) {
    receivers = new Set();
    __rpcSignalReceivers.set(id, receivers);
  }
  const receiver = { id, signal: new WeakRef(signal), subscription: null };
  receivers.add(receiver);
  __rpcSignalSubscribe(receiver);
  return signal;
};
// Walk a lifted tree back into a script's value: `reviveMarker(marker,
// kind, revive)` answers what each marker becomes, or undefined for a kind
// this tree cannot hold; `disposers` collects `__celld$disp` entries (null
// where a tree carries none). Each object revives once, so a marker the
// value holds twice carries one reference (the lift shares it): one handle,
// one disposal.
//
// Only a plain object can be a marker, and it is one when its first key is
// a marker key: a lift escaped every key of a script's that starts with
// `__celld$`. Such a key is unescaped here, onto a copy that keeps the key
// order. Any other key with the prefix is refused: no lift wrote it.
const __reviveLifted = (value, reviveMarker, disposers) => {
  const seen = new __SafeMap();
  const cache = (v, out) => __ReflectApply(__MapSet, seen, [v, out]);
  const revive = (v) => {
    if (v === null || typeof v !== "object") return v;
    const cached = __ReflectApply(__MapGet, seen, [v]);
    if (cached !== undefined) return cached;
    // An array's named keys carry lifted values too, and its holes stay.
    if (__ArrayIsArray(v)) {
      cache(v, v);
      const keys = __ObjectKeys(v);
      for (let i = 0; i < keys.length; i++) v[keys[i]] = revive(v[keys[i]]);
      return v;
    }
    if (__ObjectGetPrototypeOf(v) !== __ObjectPrototype) return v;
    const keys = __ObjectKeys(v);
    const first = keys.length === 0 ? "" : keys[0];
    if (__isMarkerKey(first) && first !== "__celld$disp" &&
        !__isEscapedKey(first)) {
      const revived = reviveMarker(v, first, revive);
      if (revived === undefined) throw __corruptLiftedPayload(first);
      cache(v, revived);
      return revived;
    }
    let out = v;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (!__isMarkerKey(key)) continue;
      if (__isEscapedKey(key)) {
        if (out === v) out = {};
      } else if (key === "__celld$disp" && disposers !== null) {
        const entry = __ReflectApply(__MapGet, __stubEntries, [v[key]]);
        if (entry) __ReflectApply(__ArrayPush, disposers, [entry]);
        delete v[key];
      } else {
        throw __corruptLiftedPayload(key);
      }
    }
    cache(v, out);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key === "__celld$disp") continue;
      if (out === v) v[key] = revive(v[key]);
      else __defineData(out,
        __isEscapedKey(key) ? __unescapeKey(key) : key, revive(v[key]));
    }
    return out;
  };
  return revive(value);
};
// The inverse of `__stubLift`: markers become live handles. `handles`
// collects the revived stubs (for call-end param disposal or result-tree
// disposal); `disposers` collects remote Symbol.dispose entries.
const __stubRevive = (value) => {
  const handles = [];
  const disposers = [];
  const reviveMarker = (v, kind, revive) => {
    switch (kind) {
      case "__celld$stub": {
        const entry = v.t === __stubIsolate
          ? __ReflectApply(__MapGet, __stubEntries, [v[kind]]) : undefined;
        const stub = entry === undefined
          ? __foreignStub()
          : __makeStub(entry, v.c);
        const meta = __ReflectApply(__WeakMapGet, __stubMeta, [stub]);
        if (meta) {
          __ReflectApply(__ArrayPush, handles, [meta]);
          if (v.np) meta.noPipeline = true;
        }
        return stub;
      }
      case "__celld$svc":
        return v.t === __stubIsolate
          ? __entrypointStub(v[kind], revive(v.p))
          : __foreignStub();
      case "__celld$do":
        return __namespaceGet(__cell.makeNamespace(v[kind]),
          __newDoId(v[kind], v.v, v.n ?? undefined));
      case "__celld$rs": return __reviveStream(v, v[kind], true, handles);
      case "__celld$ws": return __reviveStream(v, v[kind], false, handles);
      case "__celld$sig": return __reviveSignal(v, v[kind]);
    }
    return __reviveHostValue(v, kind, revive, true);
  };
  return {
    value: __reviveLifted(value, reviveMarker, disposers), handles, disposers,
  };
};
// A marker that crossed an isolate boundary: fail on use, loudly. A
// pipelined path through one fails too (`__walkLocal`).
const __foreignStubError = () =>
  new Error("RPC stubs cannot cross isolate boundaries yet.");
const __foreignStubs = new WeakSet();
const __foreignStub = () => {
  const stub = new Proxy(function () {}, {
    get: (_b, prop) => {
      if (prop === "then" || typeof prop !== "string") return undefined;
      return () => Promise.reject(__foreignStubError());
    },
    apply: () => Promise.reject(__foreignStubError()),
  });
  __foreignStubs.add(stub);
  return stub;
};
// The kind of receiver a pipelined path reaches, by workerd's
// tryGetProperty(): "own" (a plain object or a function), "class" (an
// RpcTarget, or a Proxy whose prototype chain claims to be one), "stub" (one
// of this isolate's stubs, whose target takes the rest of the path),
// "foreign" (a stub from another isolate), "fetcher" (a Durable Object stub
// or a service binding, read as a class) and "node" (a member read off a
// fetcher, which a path descends through only there). null has no members,
// so the name that reached it is a missing method: a primitive, an array, a
// class instance, or an RpcPromise.
const __rpcReceiverKind = (v, inFetcher) => {
  if (v === null || (typeof v !== "object" && typeof v !== "function"))
    return null;
  if (__stubMeta.has(v)) return "stub";
  if (__foreignStubs.has(v)) return "foreign";
  if (__doStubMeta.has(v) || __outboundMeta.has(v)) return "fetcher";
  if (v instanceof __cf.RpcPromise || v instanceof __cf.RpcProperty)
    return inFetcher ? "node" : null;
  if (Object.getPrototypeOf(v) === Object.prototype) return "own";
  if (v instanceof __cf.RpcTarget) return "class";
  return typeof v === "function" ? "own" : null;
};
// The kind of target a stub wraps: an RpcTarget exposes class members, and
// anything else `new RpcStub()` or a lift accepts exposes its own.
const __rpcTargetKind = (target) =>
  __stubMeta.has(target) ? "stub"
    : target instanceof __cf.RpcTarget ? "class" : "own";
// Resolve `path` from `root`, a receiver of kind `kind`, then GET the final
// member (`args` null) or CALL it with the object it was read from as
// `this`. `reserved` is the reserved set of the target the call started at,
// which every name is checked against. A stub met on the way takes the rest
// of the path through `hop(meta, rest)`. `handler` is set for a plain-object
// entrypoint, whose functions are called as fn(arg, env, ctx) with
// `handler.props` selecting the ctx. Errors name the path, as workerd's do.
const __rpcPath = (root, kind, path, args, reserved, hop, handler) => {
  let value = root;
  let receiver;
  for (let i = 0; i < path.length; i++) {
    if (kind === "stub") {
      const meta = __stubMeta.get(value);
      if (meta.disposed) throw __stubDisposedError();
      return hop(meta, path.slice(i));
    }
    if (kind === "foreign") throw __foreignStubError();
    const prop = path[i];
    if (reserved.has(prop)) throw __rpcReservedError(prop);
    receiver = value;
    value = kind === "own" ? __rpcOwnMember(value, prop)
      : kind === "node" ? value[prop]
      : __rpcClassMember(value, prop);
    if (i < path.length - 1) {
      kind = __rpcReceiverKind(value, kind === "fetcher" || kind === "node");
      if (kind === null) throw __rpcNoSuchMethod(prop);
    }
  }
  // An empty path applies the root itself (a callable stub).
  if (path.length === 0) {
    if (args === null) return value;
    if (typeof value !== "function")
      throw new TypeError("The RPC stub is not callable.");
    return value(...args);
  }
  if (args === null) return __rpcBindMember(value, receiver);
  if (typeof value !== "function")
    throw new TypeError('"' + path.join(".") + '" is not a function.');
  if (handler !== undefined)
    return __callObjectEntrypoint(
      value, receiver, path.join("."), args, handler.props);
  return __ReflectApply(value, receiver, args);
};
// Receiver-side pipeline walk at a stub's target, in the stub's owning
// context. A stub the walk meets continues the same way at its own target.
const __rpcAtTarget = (target, path, args, reserved) => __rpcPath(
  target, __rpcTargetKind(target), path, args, reserved,
  (meta, rest) => __ctxRun(meta.entry.ctx,
    () => __rpcAtTarget(meta.entry.target, rest, args, reserved)));
// A call into an entrypoint or a Durable Object instance (`kind` "class"),
// or a plain-object entrypoint (`kind` "own", with `handler`). `scheduled`
// is not reserved: it is an ordinary method over RPC.
const __rpcAtEntrypoint = (root, kind, path, args, handler) => __rpcPath(
  root, kind, path, args, __entrypointReserved,
  (meta, rest) => __ctxRun(meta.entry.ctx,
    () => __rpcAtTarget(meta.entry.target, rest, args,
      __entrypointReserved)),
  handler);
// One stub-mediated op: clone through the RPC envelope both ways,
// so nested stubs, errors, and uncloneables behave exactly as a
// dispatched call. Args serialize in the caller's context (its
// stubs must be its own to transfer); the decode, the walk, and
// the reply serialization run in the stub's owning context, so
// stubs minted by the target belong to the target's context.
// Params received by the target are disposed when the op ends
// (Workerd's param-disposal rule).
const __stubOp = (meta, path, args) => {
  if (meta.disposed) return Promise.reject(__stubDisposedError());
  const entry = meta.entry;
  // The cell that minted this stub left residency, so `entry.target`
  // belongs to an instance this node released. The stub fails here
  // rather than calling into it.
  if (entry.released) return Promise.reject(__releasedStubError());
  // A stub rooted in an aborted context is broken: reject with the
  // abort reason, before and after the dispatch (the target may
  // abort its own context mid-call). Gated on one field read.
  if (__abortedCtxs.size !== 0) {
    const aborted = __abortedCtxs.get(entry.ctx);
    if (aborted !== undefined)
      return Promise.reject(__postAbortError(aborted));
  }
  const argsSc = args === null ? null : __rpcOut(args, true, true);
  const dispatch = (async () => {
    // Workerd delivers RPC asynchronously: the callee must not run
    // before the caller's synchronous code. A call made just after
    // a not-yet-delivered ctx.abort counts as in flight (rejects
    // with the reason, not the post-abort message). Bodies queue
    // in call order, so e-order holds.
    await null;
    // The cell that minted this stub gates it like any other event.
    // The op is dispatched inside the isolate and never becomes a
    // drive, so it is the one delivery point that has to ask here
    // rather than in Rust. A stub carrying the running critical
    // section re-enters it; everything else queues, and a section
    // that failed refuses what queued.
    const cell = entry.scope;
    if (cell !== undefined) {
      const block = __cellBlocks.get(cell);
      if (block !== undefined && (entry.section === null ||
          entry.section !== block.holder))
        await __gate_wait(cell);
    }
    const reply = await __ctxRun(entry.ctx,
      () => __rpcRun(async () => {
        const decoded =
          argsSc === null ? null : __rpcDesArgs(argsSc);
        try {
          return await __rpcAtTarget(entry.target, path,
            decoded === null ? null : decoded.args, __transientReserved);
        } finally {
          if (decoded !== null) __disposeReceived(decoded.received);
        }
      }, true));
    if (__abortedCtxs.size !== 0) {
      const aborted = __abortedCtxs.get(entry.ctx);
      if (aborted !== undefined)
        throw aborted instanceof __ActorAbort
          ? aborted.reason : aborted;
    }
    return __rpcDes(reply);
  })();
  if (entry.ctx === undefined) return dispatch;
  // Race the op against its hosting context's abort: a hung callee
  // never settles, so the settlement check above cannot reach it.
  // A late settlement lands on an already-settled promise (no-op).
  return new Promise((resolve, reject) => {
    const untrack = __opTrack(entry.ctx, reject);
    dispatch.then(
      (value) => { untrack(); resolve(value); },
      (error) => { untrack(); reject(error); });
  });
};
// Resolve a pipelined path against a call's result where it arrived, as
// workerd's call pipeline does (serializeJsValueWithPipeline): a plain
// object exposes its own properties, a stub hands the path to its target,
// and a Durable Object stub or a service binding is walked as a fetcher.
// Any other result -- a primitive, an array, a class instance, a Response,
// or a Proxy that claims to be an RpcTarget -- has no pipeline, so its first
// name is a missing method. Its reserved names are a transient target's.
const __walkLocal = (root, path, args) => {
  const meta = __stubMeta.get(root);
  if (meta !== undefined) {
    if (path.length !== 0 && meta.noPipeline === true)
      throw __rpcNoSuchMethod(path[0]);
    return __stubOp(meta, path, args);
  }
  if (__foreignStubs.has(root)) throw __foreignStubError();
  if (path.length === 0) {
    if (args === null) return root;
    if (typeof root !== "function")
      throw new TypeError("The RPC value is not callable.");
    return root(...args);
  }
  const kind = __doStubMeta.has(root) || __outboundMeta.has(root)
    ? "fetcher"
    : root !== null && typeof root === "object" &&
        Object.getPrototypeOf(root) === Object.prototype ? "own" : null;
  if (kind === null) throw __rpcNoSuchMethod(path[0]);
  return __rpcPath(root, kind, path, args, __transientReserved,
    (stub, rest) => __stubOp(stub, rest, args));
};
// A session is one place pipeline ops resolve: the local value a
// call returned, a same-isolate stub's target, or a named
// entrypoint (whose paths resolve receiver-side in one op).
//
// A call's session is what its RpcPromise disposes, as workerd's
// JsRpcPromise::dispose() does: the result is disposed through its own
// Symbol.dispose, now if it has arrived or else when it arrives, and later
// pipelining is refused. Awaiting the RpcPromise itself still yields the
// result.
const __rpcPromiseDisposedError = () =>
  new Error("RPC promise used after being disposed.");
const __disposeRpcResult = (value) => {
  if (value === null ||
      (typeof value !== "object" && typeof value !== "function")) return;
  const disposer = value[Symbol.dispose];
  if (typeof disposer === "function") disposer.call(value);
};
// Every object an RPC call or property read answers with has its own
// Symbol.dispose, as workerd's deserializeRpcReturnValue() gives it: the
// one that disposes the stubs it carries (`__rpcDes`), or else one that
// does nothing. A stub answers with its own. The lift never sends the empty
// one on as a capability.
const __rpcNoDisposer = () => {};
const __rpcResultDisposer = (value) => {
  if (value !== null && typeof value === "object" &&
      !__stubMeta.has(value) && !Object.hasOwn(value, Symbol.dispose))
    Reflect.defineProperty(value, Symbol.dispose, {
      value: __rpcNoDisposer, writable: true, configurable: true,
    });
  return value;
};
const __valueSession = (call) => {
  let settled = false;
  let result;
  // Awaiters chain on `promise`, after the result is recorded, so a
  // dispose in their continuation finds it. (Observing `call` with a
  // second handler would save this tick but mark every call's rejection
  // as handled.)
  const promise = call.then((value) => {
    __rpcResultDisposer(value);
    if (session.disposed) {
      __disposeRpcResult(value);
    } else {
      settled = true;
      result = value;
    }
    return value;
  });
  const session = {
    disposed: false,
    root: () => promise,
    get: (path) => session.disposed
      ? Promise.reject(__rpcPromiseDisposedError())
      : promise.then((v) => __walkLocal(v, path, null)),
    call: (path, args) => session.disposed
      ? Promise.reject(__rpcPromiseDisposedError())
      : promise.then((v) => __walkLocal(v, path, args)),
    dispose: () => {
      if (session.disposed) return;
      session.disposed = true;
      if (!settled) return;
      const value = result;
      result = undefined;
      __disposeRpcResult(value);
    },
  };
  return session;
};
// RpcPromise -> its call's session, for the disposer every RpcPromise
// shares from RpcPromise.prototype, as in workerd.
const __rpcPromiseSessions = new WeakMap();
// workerd's text for a method called on the wrong kind of object.
const __illegalInvocation = () => new TypeError(
  "Illegal invocation: function called with incorrect `this` " +
  "reference. See https://developers.cloudflare.com/workers/" +
  "observability/errors/#illegal-invocation-errors for details.");
const __rpcPromiseSession = (node) => {
  const session = __rpcPromiseSessions.get(node);
  if (session === undefined) throw __illegalInvocation();
  return session;
};
const __stubSession = (meta) => ({
  get: (path) => __stubOp(meta, path, null),
  call: (path, args) => __stubOp(meta, path, args),
});
// A same-script binding decodes its props for each call, as the target
// isolate of a cross-script call does, so no call sees another's changes.
const __localProps = (propsSc) =>
  propsSc === undefined ? undefined : __sc_decode(propsSc);
const __entrypointSession = (name, local, script, propsSc) => ({
  get: (path) => local
    ? (async () => __rpcDes(
        await __entrypointOp(
          name, path, null, true, __localProps(propsSc))))()
    : (async () => __rpcDes(
        await __svc_rpc(
          script, name, JSON.stringify(path), null, propsSc)))(),
  call: (path, args) => (async () => {
    const argsSc = __rpcOut(args, local, true);
    if (local)
      return __rpcDes(await __entrypointOp(
        name, path, argsSc, true, __localProps(propsSc)));
    return __rpcDes(
      await __svc_rpc(
        script, name, JSON.stringify(path), argsSc, propsSc));
  })(),
});
// Workerd's JsRpcPromise/JsRpcProperty: awaitable, callable, and
// property access extends a path resolved at the far end, so
// intermediates obey Workerd's receiver rules. `ctx` is the node's
// owning request context -- null marks a context-free node (a
// property path rooted directly at a service binding, which
// starts a fresh session per await); a foreign context awaiting a
// property or calling through the node gets Workerd's
// cross-context error. Depth is capped like Workerd's
// MAX_PROPERTY_DEPTH. An RpcPromise (an empty path, always over a
// call's value session) is disposable through RpcPromise.prototype;
// an RpcProperty is not. Like workerd's wildcard property, every
// string name but an array index is `in` a node, and a name its brand's
// prototype chain has (Object.prototype's among them) is read there.
const __makeNode = (session, path, ctx) => {
  let promise;
  const value = () => {
    // A property read again after its RpcPromise was disposed is
    // refused, as each read is a new pipelined op in workerd.
    if (path.length !== 0 && session.disposed)
      return Promise.reject(__rpcPromiseDisposedError());
    return promise ??= (() => {
      if (path.length === 0) return session.root();
      if (ctx !== null && ctx !== __ctxNow())
        return Promise.reject(__ctxError("Pipeline"));
      return session.get(path).then(__rpcResultDisposer);
    })();
  };
  const brand =
    path.length === 0 ? __cf.RpcPromise : __cf.RpcProperty;
  const node = new Proxy(function () {}, {
    getPrototypeOf: () => brand.prototype,
    has: (_b, p) => !__rpcLocalName(p, brand.prototype) ||
      Reflect.has(brand.prototype, p),
    get: (_b, p, receiver) => {
      if (p === "then")
        return (onOk, onErr) => value().then(onOk, onErr);
      if (p === "catch") return (onErr) => value().catch(onErr);
      if (p === "finally")
        return (onDone) => value().finally(onDone);
      if (__rpcLocalName(p, brand.prototype))
        return Reflect.get(brand.prototype, p, receiver);
      if (path.length >= 5120)
        throw new TypeError(
          "RPC pipelined property chain is too deep.");
      return __makeNode(session, [...path, p], ctx);
    },
    apply: (_b, _this, args) => {
      let result;
      if (ctx !== null && ctx !== __ctxNow()) {
        result = __valueSession(
          Promise.reject(__ctxError("JsRpcPromise")));
        // A call refused before it started is never reported unhandled.
        result.root().catch(() => {});
      } else {
        // Eager, so concurrent calls keep e-order.
        result = __valueSession(session.call(path, args));
      }
      return __makeNode(result, [], ctx ?? __ctxNow());
    },
  });
  if (path.length === 0) __rpcPromiseSessions.set(node, session);
  return node;
};
const __makeStub = (entry, callable) => {
  const meta =
    { entry, callable, disposed: false, ctx: __ctxNow() };
  __ctxRegister(meta);
  // As workerd's JsRpcStub: `dup` and Symbol.dispose are its own, a name
  // RpcStub.prototype's chain has is read there, and every other string
  // but `then` and an array index is a remote member.
  const stub = new Proxy(function () {}, {
    getPrototypeOf: () => __cf.RpcStub.prototype,
    has: (_b, prop) => prop === "dup" || prop === Symbol.dispose ||
      (prop !== "then" && !__rpcLocalName(prop, __cf.RpcStub.prototype)) ||
      Reflect.has(__cf.RpcStub.prototype, prop),
    get: (_b, prop, receiver) => {
      if (prop === "then") return undefined;
      if (prop === Symbol.dispose) return () => __disposeStub(meta);
      if (prop === "dup") return () => {
        if (meta.disposed) throw __stubDisposedError();
        entry.refs++;
        return __makeStub(entry, callable);
      };
      if (__rpcLocalName(prop, __cf.RpcStub.prototype))
        return Reflect.get(__cf.RpcStub.prototype, prop, receiver);
      return __makeNode(__stubSession(meta), [prop], __ctxNow());
    },
    apply: (_b, _this, args) => __makeNode(
      __valueSession(__stubOp(meta, [], args)), [], __ctxNow()),
  });
  __stubMeta.set(stub, meta);
  return stub;
};
// A loopback service stub for one of this worker's own
// entrypoints -- the ctx.exports surface. Calling the stub itself
// returns a new stub carrying props (Workerd's
// ctx.exports.Name({ props })). As in Workerd, the props are cloned when
// the stub is made, so a value that cannot be cloned is refused there and a
// later change to the caller's object does not reach the stub; each call
// then constructs a fresh instance with its own copy, as a service binding's
// does.
const __svcMeta = new WeakMap();
const __entrypointStub = (name, props) => {
  const propsSc = props === undefined ? undefined : __rpcOut(props, false);
  const session = __entrypointSession(name, true, null, propsSc);
  const stub = new Proxy(function () {}, {
    getPrototypeOf: () => __cf.ServiceStub.prototype,
    get: (_b, prop, receiver) => {
      if (prop === "then") return undefined;
      // Object.prototype's names, and the rest of the prototype chain, are
      // the stub's own, as on a workerd Fetcher.
      if (__rpcLocalName(prop, __cf.ServiceStub.prototype))
        return Reflect.get(__cf.ServiceStub.prototype, prop, receiver);
      if (prop === "getRpcMethodForTestOnly")
        return (n) => __makeNode(session, [String(n)], null);
      // A Fetcher's fetch() is an HTTP request, as a service binding's is.
      if (prop === "fetch")
        return (input, init) => __makeServiceBinding(
          __cell.script, name === "default" ? null : name, propsSc,
        ).fetch(input, init);
      return __makeNode(session, [prop], null);
    },
    apply: (_b, _this, args) =>
      __entrypointStub(name, args[0]?.props),
  });
  __svcMeta.set(stub, { name, props: __localProps(propsSc) });
  __outboundMeta.set(stub, {
    script: __cell.script,
    entrypoint: name,
    propsSc,
  });
  return stub;
};
// ---- stored stubs ----------------------------------------------
// Durable Object storage accepts only stubs with durable identity:
// loopback service stubs (entrypoint name + props re-mint a fresh
// stub on read) and Durable Object stubs (HMAC'd id + class revive
// in any isolate). A transient handle -- a received RPC stub, a
// function, an RpcTarget -- dies with its isolate; persisting its
// entry id would revive garbage after a restart, so it is refused.
// A stub-bearing row is written as 0x02 + clone(marker tree), off
// the plain-clone fast path (the lift runs only after the plain
// clone already threw, exactly like the RPC envelope). Reads hand
// tagged rows to JS as [sentinel, tree]; the sentinel never leaves
// this script and no user value can decode to it, and the tree's keys
// are escaped as an RPC envelope's are, so revival cannot be spoofed by
// data shaped like a marker. Tag 0x01 was the same row before that
// escape, which storage refuses (`storage_ops.rs`).
const __STORED_STUB_TAG = 2;
const __transientStubError = () => new DOMException(
  "Durable Object storage can only store stubs with " +
  "durable identity: service stubs from ctx.exports and " +
  "Durable Object stubs. This value is a transient RPC " +
  "handle that would not survive a restart.",
  "DataCloneError");
const __storedSentinel = {};
const __storedLift = (value) => {
  let lifted = false;
  const seen = new __SafeMap();
  const cache = (v, out) => __ReflectApply(__MapSet, seen, [v, out]);
  const lift = (v) => {
    if (v === null ||
        (typeof v !== "object" && typeof v !== "function")) return v;
    const cached = __ReflectApply(__MapGet, seen, [v]);
    if (cached !== undefined) return cached;
    // Ordering mirrors __stubLift: identify proxies by their
    // side tables and brands before touching any property -- a
    // stub or pipeline proxy answers every property read with a
    // fresh RpcProperty node.
    if (__ReflectApply(__WeakMapHas, __stubMeta, [v]) || __isRpcTarget(v))
      throw __transientStubError();
    const svc = __ReflectApply(__WeakMapGet, __svcMeta, [v]);
    if (svc !== undefined) {
      lifted = true;
      const marker = { "__celld$svc": svc.name, p: undefined };
      cache(v, marker);
      if (svc.props !== undefined) marker.p = lift(svc.props);
      return marker;
    }
    if (v instanceof __cf.RpcPromise ||
        v instanceof __cf.RpcProperty)
      throw new DOMException(
        'Could not serialize object of type "' +
        (v instanceof __cf.RpcPromise ? "RpcPromise" : "RpcProperty") +
        '". This type does not support serialization.',
        "DataCloneError");
    if (typeof v === "function") return v; // leave to the clone
    const doId = __ReflectApply(__WeakMapGet, __doStubMeta, [v]);
    if (doId !== undefined) {
      lifted = true;
      const marker = { "__celld$do": __doIdClass(doId),
                       v: doId.toString(), n: v.name ?? null };
      cache(v, marker);
      return marker;
    }
    // A value V8 writes as itself (a Date, a Map, an ArrayBuffer, ...) is
    // left to the clone, and so is a Proxy, which it refuses, unless the
    // Proxy presents an RpcTarget, refused above for any RpcTarget. A host
    // class's instance is stored by value where workerd stores it, and
    // refused with workerd's error otherwise (`__hostValueOutsideRpc`). V8
    // writes every other object as a plain object, whatever its prototype
    // (a class instance, `Object.create(Headers.prototype)`), as workerd
    // stores it, so it is copied with its keys escaped. The brand check runs
    // only off Object.prototype, since it costs an op per object, so a Proxy
    // presenting a plain object or an array is copied through its traps,
    // where workerd's clone refuses it (workerd stores no such stub row).
    const array = __ArrayIsArray(v);
    if (!array && __ObjectGetPrototypeOf(v) !== __ObjectPrototype) {
      const flags = __util_type_flags(v);
      if ((flags & __TYPE_PROXY) !== 0) {
        if (v instanceof __cf.RpcTarget) throw __transientStubError();
        return v;
      }
      if ((flags & (__TYPE_CLONED | __TYPE_MAP | __TYPE_SET)) !== 0)
        return v;
      const kind = __hostKind(v);
      if (kind !== undefined) {
        const marker = __hostValueOutsideRpc(v, kind);
        lifted = true;
        cache(v, marker);
        return marker;
      }
    }
    // No setter a script put on a prototype sees the copies: an array's
    // indices are its own before they are assigned (its holes are deleted
    // again, and its named keys defined), and a plain object's copy has no
    // prototype, which the clone does not keep.
    if (array) {
      const length = v.length;
      const out = __ownArray(length);
      cache(v, out);
      const keys = __ObjectKeys(v);
      // Every index and nothing else (indices come first, in order, so the
      // last key is the last index): no hole, no named key.
      if (keys.length === length &&
          (length === 0 || keys[length - 1] === "" + (length - 1))) {
        for (let i = 0; i < length; i++) out[i] = lift(v[i]);
        return out;
      }
      let indices = 0;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const index = +key;
        if (index >>> 0 === index && "" + index === key && index < length) {
          out[index] = lift(v[key]);
          indices++;
        } else {
          __defineData(out, key, lift(v[key]));
        }
      }
      for (let i = 0; indices < length && i < length; i++) {
        if (!__ObjectHasOwn(v, i)) {
          delete out[i];
          indices++;
        }
      }
      return out;
    }
    const out = __bareObject();
    cache(v, out);
    const keys = __ObjectKeys(v);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      out[__isMarkerKey(key) ? __escapeKey(key) : key] = lift(v[key]);
    }
    return out;
  };
  const tree = lift(value);
  return lifted ? tree : null;
};
// Encode one stub-bearing value for storage. Rethrows the original
// clone error when nothing was liftable, so plain uncloneables
// fail exactly as they always did.
const __storedBytes = (value, error) => {
  const tree = __storedLift(value);
  if (tree === null) throw error;
  return __tagged(__STORED_STUB_TAG, __sc_encode(tree));
};
const __storedRevive = (value) => __reviveLifted(value, (v, kind, revive) => {
  if (kind === "__celld$svc") return __entrypointStub(v[kind], revive(v.p));
  if (kind === "__celld$do")
    return __namespaceGet(__cell.makeNamespace(v[kind]),
      __newDoId(v[kind], v.v, v.n ?? undefined));
  return __reviveHostValue(v, kind, revive, false);
}, null);
const __unwrapStored = (v) =>
  __ArrayIsArray(v) && v[0] === __storedSentinel
    ? __storedRevive(v[1]) : v;
// A map result is wrapped as a whole only when it holds at least
// one tagged row, so the per-entry walk never runs on plain data.
const __unwrapStoredMap = (v) => {
  if (!__ArrayIsArray(v) || v[0] !== __storedSentinel) return v;
  const map = v[1];
  for (const [key, value] of map)
    map.set(key, __unwrapStored(value));
  return map;
};
// ctx.exports, as workerd's server builds it: a loopback stub for
// `default` and each other entrypoint, a namespace for each exported
// Durable Object class with storage, and a class, for facets, for
// each other exported one. Built once, on first access -- ctx
// construction itself only carries the getter.
let __ctxExportsCache;
const __ctxExports = () => __ctxExportsCache ??= (() => {
  const out = {};
  for (const name of Object.keys(__cell.entrypoints))
    out[name] = __entrypointStub(name, undefined);
  for (const name of Object.keys(__cell.objectEntrypoints))
    out[name] = __entrypointStub(name, undefined);
  // Every Durable Object class the module exports, whether it extends
  // DurableObject or no runtime base at all: a namespace when it has
  // storage, otherwise a class for facets. The load refuses a class with
  // storage that the module does not export. Loader 0 is the script's own
  // isolate: a facet of such a class runs beside the object that holds it.
  for (const name of Object.keys(__cell.classes)) {
    if (Object.hasOwn(out, name) || __isRuntimeClass(name)) continue;
    out[name] = Object.hasOwn(__cell.namespaceKeys, name)
      ? __cell.makeNamespace(name)
      : __makeLoopbackDurableObjectClass(name);
  }
  return out;
})();
// ---- RPC envelope ----------------------------------------------
// Serialize one payload. `lift` marks a same-isolate transport,
// where stub-able values may cross as markers; elsewhere they stay
// a DataCloneError, exactly as before stubs existed. `params` marks
// a call's arguments, whose stubs rpc_params_dup_stubs duplicates.
const __rpcOut = (value, lift, params = false) => {
  const projected = __rpcProject(value);
  // A payload with a host instance skips the plain clone (`__rpcProject`).
  let error = null;
  if (!projected.host) {
    try {
      return __sc_encode(projected.tree);
    } catch (error_) {
      error = error_;
    }
  }
  // A cross-isolate call lifts host values by value and a live signal. A
  // same-isolate call also transfers streams and JS capability handles.
  // A failure releases every entry reference the lift took, newest
  // first, as workerd drops the capabilities of a message it could not
  // build: an RpcTarget the call took is disposed, and a transferred
  // stub's reference goes with its handle.
  const refs = [];
  try {
    // A refused value the lift did not walk to (inside a Map, say) fails
    // the clone with its own error.
    const refusal = (cloneError) =>
      projected.unsupported.values().next().value ??
      __dataCloneError(cloneError);
    const lifted = __stubLift(projected, lift, refs,
      params && __cell.compat.rpcParamsDupStubs);
    if (lifted === null) throw refusal(error);
    try {
      return __tagged(
        lifted.caps ? 1 : 2, __sc_encode(lifted.tree));
    } catch (error_) {
      throw refusal(error_);
    }
  } catch (failure) {
    for (let i = refs.length - 1; i >= 0; i--) __releaseEntry(refs[i]);
    throw failure;
  }
};
// A callee exception as tagged bytes: the Error crosses by value
// (V8 serializes Error natively), custom own properties beside it.
const __rpcErrOut = (error) => {
  // `name` rides in the props: V8 only round-trips the standard
  // Error subclass names, and e.g. DataCloneError must survive.
  const props = error instanceof Error
    ? { ...error, name: error.name } : {};
  let sc;
  try {
    sc = __sc_encode([error, props]);
  } catch {
    const error_ = new Error(String(error?.message ?? error));
    sc = __sc_encode([error_, { name: String(error?.name ?? "Error") }]);
  }
  return __tagged(0, sc);
};
// The callee half of one RPC: run `body`, answer tagged bytes.
const __rpcRun = async (body, lift) => {
  try {
    return __rpcOut(await body(), lift);
  } catch (error) {
    return __rpcErrOut(error);
  }
};
const __rpcDesArgs = (bytes) => {
  if (bytes[0] === 0xff)
    return { args: __sc_decode(bytes), received: [] };
  const revived = __stubRevive(__sc_decode(bytes.subarray(1)));
  return { args: revived.value, received: revived.handles };
};
// The caller half: decode a reply, rebuilding stubs and rethrowing
// callee exceptions as real Errors with the callee's own
// properties, `.remote`, and a local (caller-side) stack.
const __rpcDes = (bytes) => {
  if (bytes[0] === 0xff) return __sc_decode(bytes);
  if (bytes[0] === 1 || bytes[0] === 2) {
    const { value, handles, disposers } =
      __stubRevive(__sc_decode(bytes.subarray(1)));
    if (value !== null && typeof value === "object" &&
        !__ReflectApply(__WeakMapHas, __stubMeta, [value]) &&
        (handles.length > 0 || disposers.length > 0)) {
      __ObjectDefineProperty(value, Symbol.dispose, {
        writable: true,
        configurable: true,
        value: () => {
          for (let i = 0; i < handles.length; i++) __disposeStub(handles[i]);
          for (let i = 0; i < disposers.length; i++) {
            const entry = disposers[i];
            __ReflectApply(__MapDelete, __stubEntries, [entry.id]);
            Promise.resolve().then(() => entry.target());
          }
        },
      });
    }
    return value;
  }
  const [error, props] = __sc_decode(bytes.subarray(1));
  if (error instanceof Error) {
    Object.assign(error, props);
    error.remote = true;
    const local = new Error().stack;
    error.stack = error.name + ": " + error.message +
      local.slice(local.indexOf("\n"));
  }
  throw error;
};
// Test builds put the lifted encodings' hook for `js::marker_key_tests`
// here (`bootstrap.rs`, `LIFTED_TEST_HOOK`).
/*__CELLD_TEST_LIFTED_HOOK__*/
// Deprecated Fetcher `get()`/`put()`/`delete()` HTTP helpers, kept by
// the fetcher_has_get_put_delete compat flag (Workerd http.c++):
// shortcuts for fetch() with the corresponding method.
const __fetcherStatus = (res, method) => {
  if (res.status >= 200 && res.status < 300) return;
  throw new Error("HTTP " + method + " request failed: " + res.status +
    " " + (res.statusText || __STATUS_TEXT[res.status] || ""));
};
// A Durable Object stub's `connect()`, which workerd's Fetcher sends to the
// object's connect handler as a socket. celld has no connect handlers, so it
// fails at first use, as `queue()` does, rather than reach the object as RPC.
// One function serves every stub, as Fetcher.prototype.connect does.
function __doStubConnect() {
  if (!__doStubMeta.has(this)) throw __illegalInvocation();
  throw new Error("Fetcher.connect() is not implemented in celld");
}
const __fetcherHelper = (fetch, prop) => {
  if (prop === "get") return async (url, type) => {
    const res = await fetch(url, { method: "GET" });
    if (res.status === 404 || res.status === 410) return null;
    __fetcherStatus(res, "GET");
    if (type === "stream")
      return res.body ?? new ReadableStream({ start(c) { c.close(); } });
    if (type === "arrayBuffer") return res.arrayBuffer();
    if (type === "json") return res.json();
    return res.text();
  };
  if (prop === "put") return async (url, body, options) => {
    const { expiration, expirationTtl } = options ?? {};
    if (expiration !== undefined || expirationTtl !== undefined) {
      const url_ = new URL(url);
      if (expiration !== undefined)
        url_.searchParams.append("expiration", expiration);
      if (expirationTtl !== undefined)
        url_.searchParams.append("expiration_ttl", expirationTtl);
      url = url_.toString();
    }
    __fetcherStatus(await fetch(url, { method: "PUT", body }), "PUT");
  };
  return async (url) => {
    __fetcherStatus(await fetch(url, { method: "DELETE" }), "DELETE");
  };
};
function makeNamespace(className) {
  const namespaceKey = __cell.namespaceKeys[className];
  if (typeof namespaceKey !== "string")
    throw new Error("no Durable Object namespace key for " + className);
  return new DurableObjectNamespace(__kNamespace, className, namespaceKey);
}
// A named class: SDKs sniff bindings by constructor name (workers-rs
// EnvBinding requires `constructor.name === "DurableObjectNamespace"`).
// The class of a Durable Object stub's own members, as workerd's: its
// `constructor`, and the name Object.prototype.toString() gives the stub.
const __DurableObjectStub = class DurableObject {
  get [Symbol.toStringTag]() { return "DurableObject"; }
};
// Emulate production: the actor recovers its name only when it is <= 1024
// UTF-8 bytes; longer names are dropped so ctx.id.name is undefined. The
// full name still seeds the routing hash, so dispatch is unchanged. Short
// names skip the byte count (< 256 chars is always <= 1020 bytes) to keep
// the hot path alloc-free.
const __dispatchName = (name) => name === undefined ? undefined
  : name.length < 256 || new TextEncoder().encode(name).length <= 1024
    ? name : undefined;
// What a failed Durable Object call throws: a routing error as the
// DurableObjectRoutingError it names, and an object's abort or exit as the
// reason alone, which breaks the stub (`broken`).
const __doCallFailure = (error) => {
  const routingError = __durableObjectRoutingError(error);
  if (routingError !== null) return { error: routingError, broken: false };
  const message = String(error && error.message || error);
  const marker = ["__CELLD_ACTOR_ABORT__:", "__CELLD_PROCESS_EXIT__:"]
    .find((candidate) => message.includes(candidate));
  if (!marker) return { error, broken: false };
  return {
    error: new Error(message.slice(message.indexOf(marker) + marker.length)),
    broken: true,
  };
};
let __namespaceGet, __cellRpc;
// The class and the namespace key are private and only `makeNamespace`
// constructs one, as in workerd ("Illegal constructor"): a namespace a
// script could build would name any class it liked.
const __kNamespace = Symbol("DurableObjectNamespace");
class DurableObjectNamespace {
  #className;
  #namespaceKey;
  constructor(brand, className, namespaceKey) {
    if (brand !== __kNamespace) throw new TypeError("Illegal constructor");
    this.#className = className;
    this.#namespaceKey = namespaceKey;
  }
  idFromName(name) {
    return this.#idFromName(name);
  }
  #idFromName(name) {
    name = String(name);
    return __newDoId(
      this.#className, __do_id(this.#namespaceKey, "name", name), name,
    );
  }
  idFromString(value) {
    return __newDoId(
      this.#className, __do_id(this.#namespaceKey, "validate", String(value)),
    );
  }
  newUniqueId(options = {}) {
    const jurisdiction = options == null ? undefined : options.jurisdiction;
    if (jurisdiction != null)
      throw new Error("Jurisdiction restrictions are not implemented");
    return __newDoId(
      this.#className, __do_id(this.#namespaceKey, "unique", ""),
    );
  }
  jurisdiction(value) {
    if (value == null) return this;
    throw new Error("Jurisdiction restrictions are not implemented");
  }
  // The public methods go through the private ones, so a script that
  // replaces them on the prototype changes only its own calls: the harness
  // never calls a method a script can reach with a namespace, an id or a
  // stub of its own (`__namespaceGet`, `__cellRpc`).
  getByName(name, options) {
    return this.#get(this.#idFromName(name));
  }
  get(id) {
    return this.#get(id);
  }
  static {
    __namespaceGet = (namespace, id) => namespace.#get(id);
    // One RPC to the cell `name` of a runtime class, for that class's
    // binding (KV, Queue, D1, Workflow) and one runtime cell's call into
    // another. No stub is made: a stub's members and prototype are a
    // script's to replace, and its method would receive the stub as `this`.
    __cellRpc = async (className, name, method, args) => {
      name = String(name);
      const scope = __doIdScope(makeNamespace(className).#idFromName(name));
      const dispatchName = __dispatchName(name);
      if (dispatchName !== undefined) __cell.idNames[scope] = dispatchName;
      try {
        return __rpcDes(await __rpc_call(
          scope, dispatchName ?? null, method, __rpcOut(args, true, true)));
      } catch (error) {
        throw __doCallFailure(error).error;
      }
    };
  }
  #get(id) {
    const className = this.#className;
    if (!__isDoId(id) || __doIdClass(id) !== className)
      throw new TypeError("Durable Object ID is not valid for this namespace");
    const scope = __doIdScope(id);
    const dispatchName = __dispatchName(id.name);
    if (dispatchName !== undefined) __cell.idNames[scope] = dispatchName;
    // Fetch and native RPC use the same host routing/activation seam.
    // Never expose `.then`: a DO stub is not itself a promise.
    // workerd's own properties, in its order, as an object literal: an
    // assignment would run a setter a script put on the prototypes.
    const target = {
      __proto__: __DurableObjectStub.prototype,
      name: dispatchName,
      id,
    };
    let brokenReason = null;
    const invoke = async (operation) => {
      if (brokenReason !== null) throw new Error(brokenReason);
      try {
        return await operation();
      } catch (error) {
        const failure = __doCallFailure(error);
        if (failure.broken) brokenReason = failure.error.message;
        throw failure.error;
      }
    };
    const doFetch = async (input, init) =>
      __fetchThrough(new __Request(input, init), send);
    // One request to the object; fetch() follows its redirects back through
    // this stub (see __fetchThrough).
    const send = async (req) => {
        const signal = req._signalForSubrequests;
        if (signal?.aborted) throw signal.reason;
        // A body already backed by a host stream forwards to the cell as its
        // stream id, so a proxied upload to a cell on this node costs a chunk
        // rather than the whole body (#156). The host keeps it a stream for a
        // local cell and collects it only to sign a cross-node frame. A held
        // body -- or a stream with no host id -- crosses as its bytes.
        if (__bodyBytesOf(req) === null) __unlockedBody(req);
        const bodyStreamId = __bodyBytesOf(req) === null
          ? __hostStreamId(req.body)
          : undefined;
        const body_ = bodyStreamId !== undefined
          ? new Uint8Array()
          : __bodyBytesOf(req) === null
            ? await req._consume()
            : __bodyBytesOf(req);
        if (bodyStreamId !== undefined) {
          // The cell reads this upload through the same host stream id, so the
          // Worker's wrapper must not also read it: lock it (a late read throws
          // instead of racing the cell over one host stream) and mark it used,
          // which is what awaiting the old _consume() did and what workerd
          // reports as request.bodyUsed after the forward.
          req._bodyUsed = true;
          req.body._disturbed = true;
          req.body.getReader();
        }
        // Forward the request's headers to the cell as JSON. When they were
        // never materialized -- a Worker that only routes to a cell reads
        // none -- pass the raw header string straight through, so the whole
        // dispatch never builds a Headers object on either side.
        //
        // Both branches now carry the same shape. The raw string is the
        // wire list the host handed in, so the materialized branch must send
        // the header list too, not the iterator; see the note on the
        // outbound `fetch`. Reading `.headers` on a forwarded request used
        // to change what the cell received.
        const headersJson = req._headersJson !== undefined
          ? req._headersJson
          : JSON.stringify(req.headers.__celldHeaderList);
        const r = __jsonParse(await invoke(() => {
          if (!signal) return __do_call(
            scope, dispatchName ?? null, req.url, req.method, body_,
            headersJson, bodyStreamId,
          );
          return __awaitCancellableDoCall(
            __do_call_cancellable(
              scope, dispatchName ?? null, req.url, req.method, body_,
              headersJson, bodyStreamId,
            ),
            signal,
          );
        }));
        const body = r.streamId !== undefined
          ? new CelldHttpBodyStream(r.streamId)
          : r.body !== undefined
            ? r.body
            : Uint8Array.from(r.bodyBytes || []);
        // An upgrade the cell answered with. The pair straddles two isolates,
        // so the client end cannot be the peer object itself -- it is a new
        // socket the host joins to the cell's on `accept()`. A caller that
        // returns this response instead of accepting keeps the direct route
        // its target already describes, and binds nothing.
        const response = new Response(body, {
          status: r.status,
          statusText: __STATUS_TEXT[r.status] || "",
          headers: r.headers,
          webSocket: __responseSocket(r),
        });
        // As a service binding's: the headers came from another Worker.
        Object.defineProperty(response.headers, "_immutable", { value: true });
        return response;
    };
    // Every cell RPC goes out through the host, whichever node owns the
    // target. Same-process dispatch re-enters this isolate, where the
    // abort and exit markers revive; bytes that land elsewhere revive as
    // loud foreign stubs. The first name is the method; the rest of a path,
    // or a property read, rides with the arguments (`__doRpcRequest`).
    const call = (path, args) => invoke(async () => __rpcDes(await __rpc_call(
      scope, dispatchName ?? null, path[0], __rpcOut(
        path.length === 1 && args !== null
          ? args : { path: path.slice(1), args },
        true, true),
    )));
    const session = { get: (path) => call(path, null), call };
    // A member is an RpcProperty, as on workerd's Fetcher: calling it returns
    // an RpcPromise, so a caller can pipeline through its result before
    // awaiting it (`stub.open().method()`, or a Proxy that forwards to it),
    // and awaiting it reads the property. `fetch` and `connect` are the
    // Fetcher's own methods, never RPC.
    const stub = new Proxy(target, {
      has: (_target, prop) => Reflect.has(_target, prop) ||
        (prop !== "then" && !__rpcLocalName(prop, _target)),
      get: (_target, prop) => {
        if (prop === "then") return undefined;
        if (Reflect.has(_target, prop)) return Reflect.get(_target, prop);
        if (prop === "fetch") return doFetch;
        if (prop === "connect") return __doStubConnect;
        if (__rpcLocalName(prop, _target)) return undefined;
        if (__cell.compat.fetcherGetPutDelete &&
            (prop === "get" || prop === "put" || prop === "delete"))
          return __fetcherHelper(doFetch, prop);
        return __makeNode(session, [prop], null);
      },
    });
    __doStubMeta.set(stub, id);
    return stub;
  }
}
const __attachResponseRequestCancellation = (
  response,
  requestController,
  wrapBody,
) => {
  if (!(response instanceof Response) ||
      __bodyBytesOf(response) !== null ||
      response.body === null) {
    return;
  }
  const requestControllers = Array.isArray(
    response.__celldRequestControllers,
  )
    ? response.__celldRequestControllers
    : [requestController];
  if (requestControllers !== response.__celldRequestControllers) {
    Object.defineProperty(response, "__celldRequestControllers", {
      value: requestControllers,
    });
  } else {
    requestControllers.push(requestController);
  }
  if (!wrapBody || response.__celldCancellationWrapped) return;
  // A platform stream, like the body it wraps, so a BYOB reader works on it.
  const reader = response.body.getReader();
  response.body = new CelldChunkStream(async () => {
    const result = await reader.read();
    return result.done ? null : result.value;
  }, async () => {
    const reason = new Error("The client has disconnected");
    for (const controller of requestControllers) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
    try {
      await reader.cancel(reason);
    } catch {}
  });
  Object.defineProperty(response, "__celldCancellationWrapped", {
    value: true,
  });
};
// called on the owner node by the /__do/<scope> endpoint: run one object.
// Returns the Response; Rust's read_response unwraps it (don't double-wrap).
// A top-level (non-actor) request whose signal can be aborted by id, so a
// disconnected HTTP or service-binding caller reaches the target's
// `request.signal`.
// A large body, or a body of unknown length, arrives as a stream id and
// not as bytes. The handler then pulls the body off the socket as it
// reads, so the whole body is never resident. `request.body` is a stream
// in both cases.
__celld.__makeIncomingRequest = (
  url, method, body, headersJson, streamId,
) => __makeRequest(
  url, method,
  streamId === undefined ? body : new CelldHttpBodyStream(streamId),
  headersJson, undefined, true);
const __dispatchTo = __celld.__dispatchTo = async (
  scope, url, method, body, headersJson, requestId = null, bodyStreamId = null,
) => {
  // A routed body that must not be collected crosses as a host stream id; the
  // handler here reads it in parts. A held body arrives as its bytes.
  if (bodyStreamId !== null) body = new CelldHttpBodyStream(bodyStreamId);
  // Request already allocates a default controller for an absent signal.
  // Retain that same allocation so a streamed response can report reader
  // cancellation after the handler has returned.
  const requestController = new AbortController();
  if (requestId !== null)
    __incomingRequestSignals.set(
      String(requestId), requestController.signal);
  const actorEvent = __beginActorEvent(scope);
  try {
    const dispatch = (async () => {
      const inst = await _readyInstance(scope);
      return await __ctxRun(undefined, () => __objectState.untilReset(__instanceState(inst), inst.fetch(
        __makeRequest(
          url,
          method,
          body,
          headersJson,
          requestController.signal,
          true,
        ))));
    })();
    // The caller's abandonment reaches the target through
    // __do_call_cancel/__abortIncomingRequest, which aborts the fresh incoming
    // signal made above; the host dispatcher passes no caller signal here.
    const response = await dispatch;
    // Not wrapped: the host holds this response and gates it, and the caller
    // that would cancel the body reaches it through the routed channel's own
    // controller rather than this one.
    __attachResponseRequestCancellation(response, requestController, false);
    // A socket that a subrequest handed to this object lives in another
    // isolate, so it is no socket of this cell's: the host passes it on.
    const client = response instanceof Response && response.status === 101
      ? response.webSocket : null;
    const clientState = client ? __wsState(client) : null;
    if (clientState && !clientState.target && !__isHandoffSocket(client)) {
      const socket = clientState.peer;
      const socketState = socket ? __wsState(socket) : null;
      if (socketState && !socketState.hibernatable) {
        // A pair's ends share the id the host allocates as it registers them.
        __wsSetId(socketState, __ws_accept_regular(socketState.id));
      }
      const target = { __proto__: null, id: clientState.id, scope };
      clientState.target = target;
      if (socketState) {
        socketState.target = target;
        __socketSet(socketState.id, socket);
        __wsFlushPending(socket);
      }
    }
    return response;
  } finally {
    if (requestId !== null)
      __incomingRequestSignals.delete(String(requestId));
    __endActorEvent(actorEvent);
  }
};
const __rpcTargetInstance = async (scope) => {
  const inst = await _readyInstance(scope);
  if (!__objectState.rpcOk(__instanceState(inst)))
    throw new TypeError(
      "The receiving Durable Object does not support RPC, because " +
      "its class was not declared with `extends DurableObject`. In " +
      "order to enable RPC, make sure your class extends the " +
      "special class `DurableObject`, which can be imported from " +
      "the module \"cloudflare:workers\".");
  return inst;
};
// A Durable Object call names its first step as `method`. Its arguments
// are the call's, or for a property read or a longer path
// `{ path: [rest], args }`, with null args for a read. Stubs only ever send
// an array of arguments, so the two cannot be confused.
const __doRpcRequest = (method, value) => {
  if (Array.isArray(value)) return [[method], value];
  if (value !== null && typeof value === "object" &&
      Array.isArray(value.path) &&
      value.path.every((name) => typeof name === "string") &&
      (value.args === null || Array.isArray(value.args)))
    return [[method, ...value.path], value.args];
  throw new TypeError("Malformed Durable Object RPC request.");
};
// One call into a Durable Object, by workerd's rules for an entrypoint: its
// handler names are reserved, and only class members are visible. A runtime
// class (`__runtimeClass`) answers only the methods it names, called
// directly, so its other methods are not RPC. Its internal methods answer
// only an `internal` call, which the host marks: celld's own, or one the
// runtime cells' isolate makes (`scope_grant::Caller::internal`), never a
// binding's.
//
// A runtime class's method is the one it had when the harness loaded, called
// through captured intrinsics: the workflow cell runs beside the script's
// code, and a lookup through its instance or a replaceable builtin would
// hand that instance to the script.
const __doRpcCall = (scope, inst, path, args, internal) => {
  const runtime = __ReflectApply(__WeakMapGet, __runtimeRpcMethods,
    [__cell.classes[scope.split(":")[0]]]);
  if (runtime === undefined) return __rpcAtEntrypoint(inst, "class", path, args);
  const name = path[0];
  const method = path.length !== 1 || args === null ? undefined
    : __ObjectHasOwn(runtime.binding, name) ? runtime.binding[name]
    : internal && __ObjectHasOwn(runtime.internal, name) ? runtime.internal[name]
    : undefined;
  if (method === undefined) throw __rpcNoSuchMethod(name);
  return __ReflectApply(method, inst, args);
};
// The byte path always lifts stub-able values into the reply: the
// markers carry the isolate token, so they revive only back in this
// isolate (same-process routed dispatch re-enters it) and fail loudly
// on use anywhere else. Callee exceptions cross in
// the error envelope on every flavor.
__celld.__dispatchRpc = async (scope, method, args, internal) => {
  const actorEvent = __beginActorEvent(scope);
  try {
    // A string is the legacy JSON flavor; bytes are V8 structured clone.
    // Answer in kind.
    if (typeof args === "string") {
      const inst = await __rpcTargetInstance(scope);
      // A peer's JSON `null` is a call with no arguments, as it was before
      // a call could name a path.
      const value = JSON.parse(args);
      const [path, callArgs] = __doRpcRequest(method, value === null ? [] : value);
      const result = await __objectState.untilReset(__instanceState(inst),
        __doRpcCall(scope, inst, path, callArgs, internal));
      return JSON.stringify(result) ?? "null";
    }
    return await __ctxRun(undefined, () => (async () => {
      const decoded = __rpcDesArgs(args);
      try {
        return await __rpcRun(async () => {
          // A broken actor (JS-flavored ctx.abort) rejects every
          // later call with the reason. One gated field read.
          if (__brokenActors.size !== 0) {
            const broken = __brokenActors.get(scope);
            if (broken !== undefined) throw broken;
          }
          const inst = await __rpcTargetInstance(scope);
          const [path, callArgs] = __doRpcRequest(method, decoded.args);
          return __objectState.untilReset(__instanceState(inst),
            __doRpcCall(scope, inst, path, callArgs, internal));
        }, true);
      } finally {
        __disposeReceived(decoded.received);
      }
    })());
  } finally {
    __endActorEvent(actorEvent);
  }
};
const __entrypointClass = (name) => {
  const cls = __cell.entrypoints[name];
  if (typeof cls !== "function") {
    // Workerd getExportedHandler(): distinguish a Durable Object class
    // misused as a stateless entrypoint from a name that resolves to
    // nothing. Error path only; both lookups are O(1).
    if (__cell.classes[name] !== undefined || __cell.doExports[name])
      throw new TypeError(
        `The entrypoint name ${name} refers to a Durable Object ` +
        "class, but the incoming request is trying to invoke it as " +
        "a stateless worker.");
    throw new TypeError(
      `The entrypoint name ${name} was not found in this worker. ` +
      "Ensure the worker exports an entrypoint with that name.");
  }
  return cls;
};
// End the construction event immediately: ctx.waitUntil registers into
// whichever event is current at call time, so leaving this event on the
// stack would swallow every later registration in the isolate. The drain that
// the event yields moves to the enclosing event, because a ctx.waitUntil()
// call inside a constructor is otherwise fire-and-forget: the RPC reply can
// answer and the request context can tear down before that work runs.
// __wait_until drops the drain when no event encloses this one, which is the
// isolate-startup case and matches the older behavior.
const __constructEntrypoint = (cls, props) => {
  const ctx = __beginEvent(props);
  try {
    return new cls(ctx, __cell.env);
  } finally {
    const drain = __endEvent();
    if (drain !== null) __wait_until(drain);
  }
};
// A stateless Worker invocation owns one class instance and its constructor
// context. Reusing either across invocations leaks class fields and request
// authority, while constructing more than once inside one invocation splits
// work that Cloudflare delivers to one receiver.
const __newEntrypointInstance = (name, props) =>
  __constructEntrypoint(__entrypointClass(name), props);
// `env.NAME.fetch()` where NAME is bound with `entrypoint = "..."` goes
// to that class's fetch, not the module's default export. A plain
// object export (Workerd's non-class entrypoint) dispatches its
// handler functions as fn(arg, env, ctx).
// A missing fetch reports workerd's own text, the same one the loader
// installs for a Worker with no default export, so the two paths agree.
const __noHandler = (name, method) =>
  method === "fetch" && name === "default"
    ? new Error("Handler does not export a fetch() function.")
    : new TypeError(
      `Entrypoint ${JSON.stringify(name)} has no ${method} handler`);

const __dispatchEntrypointMethod = async (name, method, arg, props) => {
  const handler = __cell.objectEntrypoints[name];
  if (handler !== undefined) {
    if (typeof handler[method] !== "function")
      throw __noHandler(name, method);
    const ctx = __beginEvent(props);
    try {
      return await __ctxRun(undefined,
        () => handler[method](arg, __cell.env, ctx));
    } finally {
      __endEvent();
    }
  }
  // A class entrypoint's methods get env and ctx from its constructor,
  // not as arguments.
  const inst = __newEntrypointInstance(name, props);
  if (typeof inst[method] !== "function")
    throw __noHandler(name, method);
  return await __ctxRun(undefined, () => inst[method](arg));
};
// Invoke a handler inside the event frame that the host already opened. A
// Queue dispatch uses this form because its host driver must receive and keep
// driving the handler's waitUntil aggregate after the settlement is returned.
const __dispatchEntrypointMethodInCurrentEvent = async (name, method, arg) => {
  const handler = __cell.objectEntrypoints[name];
  if (handler !== undefined) {
    if (typeof handler[method] !== "function")
      throw __noHandler(name, method);
    return await __ctxRun(undefined,
      () => handler[method](arg, __cell.env, __entrypointContext()));
  }
  const inst = __newEntrypointInstance(name, undefined);
  if (typeof inst[method] !== "function")
    throw __noHandler(name, method);
  return await __ctxRun(undefined, () => inst[method](arg));
};
const __dispatchEntrypointFetch = __celld.__dispatchEntrypointFetch =
  (name, request, propsSc = null) =>
  __dispatchEntrypointMethod(
    name, "fetch", request,
    propsSc === null || propsSc.length === 0
      ? undefined : __sc_decode(propsSc));
__celld.__dispatchEntrypointScheduled = (name, ctrl, props) =>
  __dispatchEntrypointMethod(name, "scheduled", ctrl, props);
// A queue batch owns mutable settlement state only while its handler runs.
// Keeping a batch alive after dispatch must not keep authority to settle its
// lease, because that lease can have expired and been handed out again.
__celld.__dispatchEntrypointQueue = async (name, incoming) => {
  let active = true;
  let ackAll = false;
  const explicitAcks = new Set();
  const retries = new Map();
  const retryBatch = { retry: false, delaySeconds: undefined };
  const checkActive = () => {
    if (!active)
      throw new Error("Queue event methods cannot be called after the handler returns.");
  };
  const retryDelay = (options) => {
    const value = options?.delaySeconds;
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff)
      throw new TypeError("delaySeconds must be a 32-bit integer");
    return value;
  };
  const decode = (message) => {
    switch (message.contentType) {
      case "text": return new TextDecoder().decode(message.body);
      case "bytes": return message.body;
      case "json": return JSON.parse(new TextDecoder().decode(message.body));
      case "v8": return __sc_decode(message.body);
      default: throw new TypeError(`Unknown queue content type: ${message.contentType}`);
    }
  };
  const messages = incoming.messages.map((message) => ({
    id: message.id,
    timestamp: new Date(message.timestamp),
    body: decode(message),
    attempts: message.attempts,
    ack() {
      checkActive();
      if (ackAll || retryBatch.retry || retries.has(message.id)) return;
      explicitAcks.add(message.id);
    },
    retry(options) {
      checkActive();
      if (ackAll || explicitAcks.has(message.id)) return;
      const delaySeconds = retryDelay(options);
      if (delaySeconds !== undefined || !retries.has(message.id))
        retries.set(message.id, delaySeconds);
    },
  }));
  const oldest = incoming.metrics.oldestMessageTimestamp;
  const batch = {
    queue: incoming.queue,
    messages,
    metadata: {
      metrics: {
        backlogCount: incoming.metrics.backlogCount,
        backlogBytes: incoming.metrics.backlogBytes,
        oldestMessageTimestamp: oldest === undefined ? undefined : new Date(oldest),
      },
    },
    ackAll() {
      checkActive();
      if (!retryBatch.retry) ackAll = true;
    },
    retryAll(options) {
      checkActive();
      if (ackAll) return;
      retryBatch.retry = true;
      const delaySeconds = retryDelay(options);
      if (delaySeconds !== undefined) retryBatch.delaySeconds = delaySeconds;
    },
  };
  let outcome = "ok";
  let errorText;
  try {
    await __dispatchEntrypointMethodInCurrentEvent(name, "queue", batch);
  } catch (error) {
    // A handler exception retries the batch but keeps explicit acks that the
    // handler made before it threw. The caller needs both facts together.
    outcome = "exception";
    try {
      errorText = String(error);
    } catch {
      errorText = "queue handler rejected";
    }
  } finally {
    active = false;
  }
  return {
    outcome,
    error: errorText,
    ackAll,
    retryBatch,
    explicitAcks: [...explicitAcks],
    retryMessages: [...retries].map(([msgId, delaySeconds]) => ({
      msgId,
      delaySeconds,
    })),
  };
};
// Workerd's simple-handler RPC rules (worker-rpc.c++
// invokeFnInsertingEnvCtx): a function a plain-object entrypoint exposes,
// at `name` on its path, is called as fn(arg, env, ctx) with `receiver` as
// `this`. Its declared length must be at most three, and the client must
// send exactly one argument. The messages are Workerd's, verbatim.
const __callObjectEntrypoint = (fn, receiver, name, args, props) => {
  let arity = Number(fn.length);
  arity = Number.isNaN(arity) ? 0 : Math.trunc(arity);
  if (arity < 0 || arity >= 256)
    throw new TypeError(
      "RPC function has unreasonable length attribute: " + arity);
  if (arity > 3)
    throw new TypeError(
      'Cannot call handler function "' + name + '" over RPC ' +
      "because it has the wrong number of arguments. A simple " +
      "function handler can only be called over RPC if it has " +
      "exactly the arguments (arg, env, ctx), where only the first " +
      "argument comes from the client. To support multi-argument " +
      "RPC functions, use class-based syntax (extending " +
      "WorkerEntrypoint) instead.");
  if (args.length !== 1)
    throw new TypeError(
      'Attempted to call RPC function "' + name + '" with the ' +
      "wrong number of arguments. When calling a top-level handler " +
      "function that is not declared as part of a class, you must " +
      "always send exactly one argument. In order to support " +
      "variable numbers of arguments, the server must use " +
      "class-based syntax (extending WorkerEntrypoint) instead.");
  return Reflect.apply(fn, receiver,
    [args[0], __cell.env, __entrypointContext(props)]);
};
let __nextPendingEventId = 1;
const __pendingEvents = new Map();
const __pendingEventError = () => new Error(
  "The Workers runtime canceled this request because it detected that " +
  "your Worker's code had hung and would never generate a response. " +
  "Refer to: https://developers.cloudflare.com/workers/observability/errors/");
// The host calls this only when the request has no native operation that can
// resume JavaScript. Reject the entrypoint call itself, so its caller can
// catch the cancellation and continue the enclosing event.
__celld.__cancelPendingEvents = (ids) => {
  for (const id of ids) __pendingEvents.get(id)?.(__pendingEventError());
};
// One entrypoint op (a call, or a property GET when argsSc is
// null), inside a fresh request context -- the callee owns stubs
// revived from its params, and stubs it mints belong to it.
// `props` is the caller's per-stub props (Workerd's
// getEntrypoint(name, { props })); undefined leaves the entrypoint's
// default empty props.
const __entrypointOp = (name, path, argsSc, local, props) => {
  const id = __nextCtxId++;
  return __ctxRun(id, () => {
  const pendingId = __nextPendingEventId++;
  let cancel;
  const cancellation = new Promise((_, reject) => { cancel = reject; });
  __pendingEvents.set(pendingId, cancel);
  __pending_event_begin(pendingId);
  const running = (async () => {
  const decoded = argsSc === null ? null : __rpcDesArgs(argsSc);
  let drain = null;
  try {
    const reply = await __rpcRun(async () => {
      // The handler's synchronous part runs inside its own event so
      // ctx.waitUntil and the imported waitUntil have a target. The
      // event pops before the first await -- the event stack is
      // strictly LIFO and an event held across an await would be
      // popped by whichever event settles next -- and its registered
      // work drains before a plain reply (below).
      __beginEvent();
      let result;
      try {
        const handler = __cell.objectEntrypoints[name];
        const args = decoded === null ? null : decoded.args;
        if (handler !== undefined) {
          // A plain-object entrypoint exposes its own properties, and
          // its functions also receive env and ctx.
          result = __rpcAtEntrypoint(handler, "own", path, args, { props });
        } else {
          // Each top-level operation constructs once here, so neither its
          // fields nor its constructor context reach the next invocation.
          const inst = __newEntrypointInstance(name, props);
          result = __rpcAtEntrypoint(inst, "class", path, args);
        }
      } finally {
        drain = __endEvent();
      }
      return await result;
    }, local);
    // Registered work drains before a plain reply. A
    // capability-bearing reply (tag 1) must not wait: a returned
    // stream's chunks may be produced by that very work, which
    // cannot finish until the caller pulls (returnReadableStream's
    // waitUntil writer would deadlock behind its own reply).
    if (reply[0] !== 1 && drain !== null) await drain;
    // ctx.abort() during the call supersedes its result; the raw
    // reason rejects the caller (same isolate -- identity holds).
    if (__abortedCtxs.size !== 0) {
      const reason = __abortedCtxs.get(id);
      if (reason !== undefined) throw reason;
    }
    // A reply that exports no stubs (tag 0xff plain, tag 0 error)
    // leaves nothing rooting this context: tear it down now, so a
    // dup() the callee leaked reaches its disposal callback
    // promptly (Workerd tears the IoContext down at call end
    // unless returned capabilities hold it open).
    if (reply[0] !== 1) __ctxEnd(id);
    return reply;
  } finally {
    if (decoded !== null) __disposeReceived(decoded.received);
  }
  })();
  return Promise.race([running, cancellation]).finally(() => {
    __pendingEvents.delete(pendingId);
    __pending_event_end(pendingId);
  });
  });
};
// Cross-isolate service callers pass a complete property path. Older host
// callers can still pass one method name, which becomes a one-part path.
// `propsSc` carries getEntrypoint(name, {props}) as structured-clone bytes,
// the same encoding as `argsSc`. It is empty when the caller sent no props,
// which no encoded value can be, so an empty buffer is an unambiguous absent.
__celld.__dispatchEntrypointRpc =
  (name, path, argsSc, local = false, propsSc = null) => __entrypointOp(
    name, typeof path === "string" ? [path] : path, argsSc, local,
    propsSc === null || propsSc.length === 0
      ? undefined : __sc_decode(propsSc));
// WebSocket: the host holds the socket; these deliver events into the DO.
// `ws` is a lightweight stub whose send/close route back to the host task
// by wsId -- so the isolate can be hibernated between messages.
const __wsStub = (wsId) => ({
  send: (data) => {
    if (data instanceof ArrayBuffer)
      __ws_send_binary(wsId, new Uint8Array(data));
    else if (ArrayBuffer.isView(data))
      __ws_send_binary(wsId,
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    else
      __ws_send(wsId, String(data));
  },
  // Without a code, an empty Close, as `WebSocket.close()` sends.
  close: (code, reason = "") =>
    __ws_close(wsId, code === undefined ? 1005 : code, reason),
});
__celld.__wsOpen = async (scope, wsId, protocol) => {
  const actorEvent = __beginActorEvent(scope);
  try {
    const inst = await _readyInstance(scope);
    const socket = __objectState.socket(__instanceState(inst), wsId);
    if (!__wsIsSocket(socket)) return;
    const state = __wsState(socket);
    if (state.readyState !== __WS_CONNECTING) return;
    state.protocol = protocol;
    state.readyState = __WS_OPEN;
    socket.dispatchEvent(new Event("open"));
  } finally {
    __endActorEvent(actorEvent);
  }
};
__celld.__wsMessage = async (scope, wsId, msg) => {
  const actorEvent = __beginActorEvent(scope);
  try {
    const inst = await _readyInstance(scope);
    const socket = __objectState.socket(__instanceState(inst), wsId);
    if (__wsIsSocket(socket) && !__wsState(socket).hibernatable)
      __wsDispatchMessage(socket, msg);
    else if (typeof inst.webSocketMessage === "function")
      await __objectState.untilReset(__instanceState(inst), inst.webSocketMessage(socket, msg));
  } finally {
    __endActorEvent(actorEvent);
  }
};
__celld.__wsBinary = async (scope, wsId, data) => {
  const actorEvent = __beginActorEvent(scope);
  try {
    const inst = await _readyInstance(scope);
    const socket = __objectState.socket(__instanceState(inst), wsId);
    const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    if (__wsIsSocket(socket) && !__wsState(socket).hibernatable)
      __wsDispatchMessage(socket, bytes);
    else if (typeof inst.webSocketMessage === "function")
      await __objectState.untilReset(__instanceState(inst), inst.webSocketMessage(socket, bytes));
  } finally {
    __endActorEvent(actorEvent);
  }
};
__celld.__wsClosed = async (scope, wsId, code, reason, wasClean) => {
  const actorEvent = __beginActorEvent(scope);
  try {
    const inst = await _readyInstance(scope);
    const socket = __objectState.socket(__instanceState(inst), wsId);
    if (__wsIsSocket(socket) && !__wsState(socket).hibernatable)
      __wsDispatchClose(socket, code, reason, wasClean);
    else if (!wasClean && typeof inst.webSocketError === "function")
      // A hibernatable socket reports an abnormal closure through
      // webSocketError, which celld listed as a handler name and never
      // called.
      await __objectState.untilReset(__instanceState(inst), inst.webSocketError(
        socket,
        new Error(reason ? `WebSocket closed abnormally: ${reason}` : "WebSocket closed abnormally"),
      ));
    else if (typeof inst.webSocketClose === "function") {
      // The peer's Close arrived: CLOSING until the handler replies, as in
      // workerd.
      if (__wsIsSocket(socket)) __wsReceivedClose(socket);
      await __objectState.untilReset(__instanceState(inst), inst.webSocketClose(socket, code, reason, wasClean));
    }
  } finally {
    __endActorEvent(actorEvent);
  }
};
// called by celld's scheduler when an alarm is due. Returns a promise.
__celld.__fireAlarm = async (scope, scheduledTime, retryCount) => {
  const actorEvent = __beginActorEvent(scope);
  try {
    const inst = await _readyInstance(scope);
    if (typeof inst.alarm !== "function") return;
    await __objectState.untilReset(__instanceState(inst),
      inst.alarm({ scheduledTime, retryCount, isRetry: retryCount > 0 }));
  } finally {
    __endActorEvent(actorEvent);
  }
};
// The reserved cron cell. It is not a user class: celld registers it under
// `.cron` for every deployment that declares `triggers.crons`, and one cell
// per script carries that script's whole schedule. Ownership CAS on that one
// name is what makes a cron trigger fire once per fleet rather than once per
// node -- the same arbiter an alarm already relies on, with nothing added.
//
// The schedule itself is never stored here. `__cell.crons` comes from the
// deployment the cell is running under, so changing a cron expression takes
// effect on the next activation and needs no migration of an armed alarm.
// Its state is private: the cron cell runs beside the script's code.
class CelldCronSchedule {
  // The schedule's storage through the harness's own methods
  // (`__ownStorage`).
  #storage;
  #retry;
  #owed;
  constructor(state) {
    this.#storage = __ownStorage(state);
    // Failures within one occurrence. Held in memory on purpose: losing the
    // count to an eviction only makes the next retry sooner, and every retry
    // is capped at the next occurrence anyway, so it need not be durable.
    this.#retry = 0;
    // What a pending retry owes: the occurrence, the expressions of it that
    // failed, and the deadline the retry was armed for. A retry deadline is a
    // backoff instant and not an occurrence, so nothing about it can be
    // recovered from the deadline itself -- without this record the wake
    // matches no expression, runs nothing, and drops the failed tick in
    // silence. Held in memory beside `#retry` and for the same reason: an
    // eviction costs the retry, never the next occurrence.
    this.#owed = null;
  }
  // celld calls this once per node after a deployment loads, because a cron
  // cell has no client to wake it. Arming is idempotent -- the same schedule
  // and the same clock give the same answer -- so it does not matter which
  // node wins the cell.
  async fetch() {
    // A pending retry is a deadline this cell already owes, and re-arming
    // would move it to the next occurrence and lose the tick it owes with it.
    if (this.#owed !== null) return new Response(null, { status: 204 });
    const armed = await this.#storage.getAlarm();
    // An alarm already due is a tick that is late, not one that is wrong.
    // Leaving it alone is what makes a fleet that was down fire the missed
    // occurrence once, instead of skipping it by re-arming into the future.
    if (armed === null || armed > Date.now()) await this.#arm(null, [], false);
    return new Response(null, { status: 204 });
  }
  async alarm(info) {
    const crons = __cell.crons || [];
    // A retry wake carries the backoff instant as its deadline, so what to run
    // and what time to report both come from the record the failure left. Only
    // a deadline that is not a retry is an occurrence to match against.
    const owed = this.#owed !== null && this.#owed.armedFor === info.scheduledTime
      ? this.#owed
      : null;
    const occurrence = owed === null ? info.scheduledTime : owed.at;
    // One deadline can belong to several expressions, and each is its own
    // invocation with its own controller.cron, as on Cloudflare. A retry
    // repeats only the expressions that failed, because the ones that
    // succeeded already ran for this occurrence.
    const due = owed === null
      ? __cron_plan(crons, info.scheduledTime, Date.now(), 0, false).matching
      : owed.indices;
    const failed = [];
    for (const index of due) {
      let noRetry = false;
      const controller = {
        // The occurrence, never the instant this attempt started, so a late
        // run and a retry both report the minute they were scheduled for.
        scheduledTime: occurrence,
        cron: crons[index],
        noRetry() { noRetry = true; },
      };
      const ctx = __beginEvent();
      try {
        if (typeof __cell.selfScheduled !== "function")
          throw new Error(
            "a cron trigger needs the Worker to export a `scheduled` handler");
        await __cell.selfScheduled(controller, __cell.env, ctx);
      } catch (error) {
        // Swallowed on purpose: this handler owns the re-arm below, so
        // throwing would hand the deadline to the generic alarm retry and
        // lose the next occurrence with it.
        console.error(
          `scheduled handler for cron ${JSON.stringify(crons[index])} failed:`,
          error);
        if (!noRetry) failed.push(index);
      } finally {
        const drain = __endEvent();
        // The alarm turn is the only host owner for this scheduled event.
        // Dropping its drain lets the actor turn end with waitUntil work still
        // pending, so an I/O promise can remain unresolved forever.
        if (drain !== null) await drain;
      }
    }
    await this.#arm(occurrence, failed, owed !== null);
  }
  // `occurrence` is the tick just handled, or null when the cell is only
  // arming, `failed` holds the expressions of it still owed, and `retried`
  // says the deadline just handled was a backoff rather than an occurrence.
  async #arm(occurrence, failed, retried) {
    const crons = __cell.crons || [];
    // The count is failures within one occurrence, so a fresh occurrence
    // starts at one however the last one ended. Carrying it across would
    // spend `alarm_retry`'s ceiling once and leave every later occurrence
    // with no retry at all, which is a budget for the schedule and not for
    // the tick.
    this.#retry = failed.length ? (retried ? this.#retry + 1 : 1) : 0;
    // A negative first argument means "arming only, nothing fired".
    const plan = __cron_plan(crons, -1, Date.now(), this.#retry, failed.length > 0);
    // The next occurrence beats the backoff whenever it is sooner, and it then
    // cancels the retry rather than queueing behind it, so the record the
    // retry needed goes when the retry does.
    this.#owed = plan.armIsRetry
      ? { at: occurrence, indices: failed, armedFor: plan.armAt }
      : null;
    // No expression matches again and nothing is owed: the deployment dropped
    // its crons, so the cell retires rather than waking forever.
    if (plan.armAt === null) await this.#storage.deleteAlarm();
    else await this.#storage.setAlarm(plan.armAt);
  }
}
// As `__runtimeClass` does for the classes it registers: a member the cron
// schedule lacks never reaches Object.prototype with its instance.
Object.setPrototypeOf(CelldCronSchedule.prototype, null);
// The harness's registries are null-prototype objects (the host replaces
// `workflows` and `containers` with null-prototype ones too): a lookup or an
// assignment by a scope or a class name must not reach a getter or setter a
// script put on Object.prototype, which would receive the instance, class or
// name being registered. `env` is the script's own object.
const __cell = __celld.__cell = {
  __proto__: null,
  entrypoints: { __proto__: null },
  objectEntrypoints: { __proto__: null },
  doExports: { __proto__: null },
  classes: { __proto__: null, ".cron": CelldCronSchedule },
  crons: [],
  workflows: { __proto__: null },
  containers: { __proto__: null },
  instances: { __proto__: null },
  facetConfigs: { __proto__: null },
  env: {},
  idNames: { __proto__: null },
  namespaceKeys: { __proto__: null },
  node: "",
  deleteAllDeletesAlarm: false,
  compat: {
    __proto__: null,
    jsRpc: false, fetcherGetPutDelete: false, queueJsonMessages: false,
    allowIrrevocableStubStorage: false, rpcParamsDupStubs: false,
  },
  makeNamespace,
  release: __cellRelease,
};
// A class the runtime supplies. RPC on a stub needs `extends DurableObject`
// or the js_rpc flag; the class is the runtime's own, so grant it here rather
// than make every user set a flag. It is not the application's export, so it
// stays out of ctx.exports.
// `methods` are the only names its binding's stub may call: the rest of its
// methods serve its own events, and a binding must not call them.
// `internal` are the methods one runtime cell calls on another, which only
// an internal call reaches (`__doRpcCall`). They are keyed by class, so a
// script's `__Workflow.<script>` alias shares them.
//
// Runs while the harness loads, before any script: the methods are captured
// here, and the class's prototype chain ends at null, so a member it lacks
// never reaches a getter a script put on Object.prototype with an instance.
const __runtimeClasses = new Set();
const __runtimeRpcMethods = new WeakMap();
const __runtimeClass = (name, cls, methods, internal = []) => {
  __cell.classes[name] = cls;
  __cell.doExports[name] = true;
  __runtimeClasses.add(name);
  const table = (names) => {
    const out = { __proto__: null };
    for (const method of names) out[method] = cls.prototype[method];
    return out;
  };
  __runtimeRpcMethods.set(cls, { binding: table(methods), internal: table(internal) });
  let base = cls.prototype;
  while (Object.getPrototypeOf(base) !== Object.prototype) base = Object.getPrototypeOf(base);
  Object.setPrototypeOf(base, null);
};
// Whether a class in `__cell.classes` is the runtime's rather than the
// application's: one registered above, the cron class (`.cron`, which needs
// no RPC grant), or a script's workflow class, which `alias_workflow_class`
// registers as `__Workflow.<script>`. The same rule as
// `deploy::is_reserved_class`, plus cron, which is not a manifest class.
const __isRuntimeClass = (name) =>
  __runtimeClasses.has(name) || name === ".cron" || name.startsWith("__Workflow.");
// ---- KV ------------------------------------------------------------------
// The namespace cell and the binding's client are `services/kv.js`, which the
// workerd engine runs too; this is the host they run against here.
const {
  KvNamespaceCell: __KvNamespaceCell,
  makeKvNamespace: __kvNamespace,
  cellSweepBatch: __cellSweepBatch,
} = kvService({
  // RPC on a runtime class is granted by `__runtimeClass` below.
  DurableObject: class {
    constructor(ctx) {
      this.ctx = ctx;
    }
  },
  limits: () => __cell.kvLimits,
  // One op for the whole large-value path, following `__d1_run`.
  blob: async (_cell, request, value) => {
    const reply = await __kv_blob(JSON.stringify(request), value);
    return reply instanceof Uint8Array
      ? { found: true, value: reply }
      : JSON.parse(reply);
  },
  // The raw base64 ops accept typed views for this internal wire form; the
  // public atob() and btoa() wrappers keep their standard string-only
  // behaviour.
  btoa: (bytes) => $$btoa(bytes),
  atob: (text) => $$atob(text, true),
});

__runtimeClass("__KvNamespace", __KvNamespaceCell,
  ["__kvGet", "__kvPut", "__kvDelete", "__kvList"]);

const __makeKvNamespace = __celld.__makeKvNamespace = (id, cellName) =>
  __kvNamespace((method, args) =>
    __cellRpc("__KvNamespace", cellName, method, args));

// ---- Queues --------------------------------------------------------------
// A Queue is one runtime-supplied Durable Object. The producer binding writes
// bytes and a content tag through RPC, and the cell owns the durable order,
// deadlines, leases, and alarms. `celld_logic::queue` owns every transition
// that can invalidate a lease or choose a deadline; this code supplies SQL and
// the Cloudflare-compatible presentation.

const __QUEUE_MESSAGES = "__queue_messages";
const __QUEUE_META = "__queue_meta";
const __QUEUE_STATS = "__queue_stats";
const __QUEUE_TRANSFER_RECEIPTS = "__queue_transfer_receipts";
const __queueEncoder = new TextEncoder();

// Independent send() calls share the same economics as sendBatch() without
// changing the public promise boundary. The first call opens a four-millisecond
// owner-local group by default; later cell events append their already-copied
// entries, and park on their own promise. One event commits the bounded group,
// and every response still trails that commit through the ordinary output
// gate. The three caps bound heap retention and keep the persisted transaction
// inside the public sendBatch limits.
const __QUEUE_PRODUCER_GROUP_CALLS = 64;
const __QUEUE_PRODUCER_GROUP_MESSAGES = 100;
const __QUEUE_PRODUCER_GROUP_BYTES = 256_000;

const __queueError = (message) => new Error("QUEUE_ERROR: " + String(message));
// A Queue message id is a UUIDv7 (RFC 9562): 48 bits of enqueue time, a
// 12-bit sequence inside that millisecond, and 62 random bits. It keeps the
// UUID shape a consumer can parse, and it sorts in enqueue order, so the
// UNIQUE index on `id` appends. A random v4 id made every grouped send
// transaction dirty one index leaf per message (about 1.6 WAL frames per
// 64-byte message) and turned every passive checkpoint into a random write
// across the whole backlog, which is what made a deep Queue's checkpoint
// cost grow with its backlog. The sequence never moves backwards inside one
// process, so a clock step only widens the gap between consecutive ids.
let __queueIdMs = 0;
let __queueIdSeq = 0;
function __queueMessageId(now) {
  if (now > __queueIdMs) {
    __queueIdMs = now;
    __queueIdSeq = 0;
  } else {
    __queueIdSeq += 1;
    if (__queueIdSeq > 0xfff) {
      __queueIdMs += 1;
      __queueIdSeq = 0;
    }
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ms = __queueIdMs;
  bytes[0] = Math.floor(ms / 0x10000000000) & 0xff;
  bytes[1] = Math.floor(ms / 0x100000000) & 0xff;
  bytes[2] = (ms >>> 24) & 0xff;
  bytes[3] = (ms >>> 16) & 0xff;
  bytes[4] = (ms >>> 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = 0x70 | (__queueIdSeq >> 8);
  bytes[7] = __queueIdSeq & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let hex = "";
  for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}
const __queueLimits = () => __cell.queueLimits;
const __queuePolicy = (request) =>
  JSON.parse(__queue_policy(JSON.stringify(request)));

const __queueDelay = (value, fallback = 0) => {
  if (value === undefined || value === null) return fallback;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 0 ||
      seconds > __queueLimits().maxDelaySeconds) {
    throw __queueError(
      `delaySeconds must be an integer from 0 to ${__queueLimits().maxDelaySeconds}`,
    );
  }
  return seconds;
};

const __queueBytes = (value) => {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }
  throw __queueError("a bytes message must be an ArrayBuffer or a typed array");
};

// Encode before entering the cell. The copy makes `sendBatch()` immune to a
// caller resizing or reusing a backing buffer while the durable write awaits.
const __queueEncode = (body, requestedType) => {
  const contentType = requestedType ??
    (__cell.compat.queueJsonMessages ? "json" : "v8");
  let bytes;
  switch (contentType) {
    case "text":
      bytes = __queueEncoder.encode(String(body));
      break;
    case "bytes":
      bytes = __queueBytes(body);
      break;
    case "json": {
      let json;
      try {
        json = JSON.stringify(body);
      } catch (error) {
        throw __queueError("the JSON message body cannot be serialized", error);
      }
      if (json === undefined) {
        throw __queueError("the JSON message body cannot be undefined");
      }
      bytes = __queueEncoder.encode(json);
      break;
    }
    case "v8":
      try {
        bytes = __sc_encode(body);
      } catch (error) {
        throw __queueError("the message body cannot be cloned", error);
      }
      break;
    default:
      throw __queueError(
        `contentType must be "text", "bytes", "json", or "v8", got ${JSON.stringify(contentType)}`,
      );
  }
  if (bytes.byteLength > __queueLimits().maxMessageBytes) {
    throw __queueError(
      `a message is at most ${__queueLimits().maxMessageBytes} bytes, got ${bytes.byteLength}`,
    );
  }
  return { body: bytes, contentType, size: bytes.byteLength };
};

// A message body as the cell receives one: bytes (a producer's view, or the
// ArrayBuffer SQLite answers a stored BLOB with), a content type the binding
// can encode, and the size it declares, which must be the bytes'.
const __queueContentTypes = new Set(["text", "bytes", "json", "v8"]);
const __queueCheckBody = (entry, what) => {
  if (!(entry.body instanceof Uint8Array || entry.body instanceof ArrayBuffer)) {
    throw __queueError(`${what} body must be bytes`);
  }
  if (!__queueContentTypes.has(entry.contentType)) {
    throw __queueError(
      `contentType must be "text", "bytes", "json", or "v8", got ${JSON.stringify(entry.contentType)}`,
    );
  }
  if (entry.size !== entry.body.byteLength) {
    throw __queueError(`${what} declares ${entry.size} bytes, but has ${entry.body.byteLength}`);
  }
  if (entry.size > __queueLimits().maxMessageBytes) {
    throw __queueError(
      `a message is at most ${__queueLimits().maxMessageBytes} bytes, got ${entry.size}`,
    );
  }
};

// The entries of a send, as the binding builds them, and only their fields.
const __queueCheckEntries = (entries, what) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw __queueError("sendBatch() needs at least one message");
  }
  if (entries.length > __queueLimits().maxBatchMessages) {
    throw __queueError(
      `${what} has at most ${__queueLimits().maxBatchMessages} messages`,
    );
  }
  return entries.map((entry) => {
    if (entry === null || typeof entry !== "object") {
      throw __queueError("each batch entry needs a body");
    }
    __queueCheckBody(entry, "a message");
    return {
      body: entry.body,
      contentType: entry.contentType,
      size: entry.size,
      delaySeconds: __queueDelay(entry.delaySeconds),
    };
  });
};

const __queueUuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

// A lease-scoped read must seek, not walk the backlog. The plan is the only
// evidence that says which, and it is cheap to ask for, so a gated test seam
// reads it from the shipped query rather than from a copy that can drift.
const __queueReportLeaseLookupPlan = (sql, query, leaseId) => {
  if (typeof __test_queue_lease_lookup_plan !== "function") return;
  const plan = sql.exec(`EXPLAIN QUERY PLAN ${query}`, leaseId)
    .toArray()
    .map((row) => row.detail)
    .join("; ");
  __test_queue_lease_lookup_plan(plan);
};

const __queueMetricsView = (metrics) => ({
  backlogCount: metrics.backlogCount,
  backlogBytes: metrics.backlogBytes,
  oldestMessageTimestamp: metrics.oldestMessageTimestamp === null ||
      metrics.oldestMessageTimestamp === undefined
    ? undefined
    : new Date(metrics.oldestMessageTimestamp),
});

class __QueueCell {
  constructor(ctx) {
    this.ctx = ctx;
    this.queue = ctx.id.name;
    this._ready = false;
    this._producerGroup = null;
  }

  _open() {
    if (this._ready) return this.ctx.storage.sql;
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${__QUEUE_MESSAGES} (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         id TEXT NOT NULL UNIQUE,
         body BLOB NOT NULL,
         content_type TEXT NOT NULL,
         size INTEGER NOT NULL,
         enqueued_at INTEGER NOT NULL,
         visible_at INTEGER NOT NULL,
         attempts INTEGER NOT NULL DEFAULT 0,
         lease_id TEXT,
         lease_generation INTEGER NOT NULL DEFAULT 0,
         leased_until INTEGER,
         purge_on_settle INTEGER NOT NULL DEFAULT 0,
         dlq_target TEXT,
         dlq_transfer_id TEXT,
         transfer_kind TEXT,
         dead_letter_source TEXT,
         CHECK ((dlq_target IS NULL AND transfer_kind IS NULL)
             OR (dlq_target IS NOT NULL
                 AND transfer_kind IN ('dead-letter', 'redrive')))
       )`,
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS ${__QUEUE_MESSAGES}_visible
         ON ${__QUEUE_MESSAGES} (visible_at, seq)`,
    );
    // Rearming is on every producer acknowledgement and settlement. Each
    // scheduling lookup must therefore stop at one deadline or one batch;
    // an aggregate over the backlog makes a large Queue quadratic to fill.
    sql.exec(
      `CREATE INDEX IF NOT EXISTS ${__QUEUE_MESSAGES}_ready
         ON ${__QUEUE_MESSAGES} (visible_at, seq)
         WHERE purge_on_settle = 0 AND dlq_target IS NULL
           AND lease_id IS NULL`,
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS ${__QUEUE_MESSAGES}_enqueued
         ON ${__QUEUE_MESSAGES} (enqueued_at, seq)`,
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS ${__QUEUE_MESSAGES}_retained
         ON ${__QUEUE_MESSAGES} (enqueued_at, seq)
         WHERE purge_on_settle = 0 AND dlq_target IS NULL`,
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS ${__QUEUE_MESSAGES}_lease
         ON ${__QUEUE_MESSAGES} (leased_until, seq)
         WHERE lease_id IS NOT NULL`,
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS ${__QUEUE_MESSAGES}_moving
         ON ${__QUEUE_MESSAGES} (seq)
         WHERE dlq_target IS NOT NULL`,
    );
    // Dispatch and settlement both select a whole batch by its lease. Without
    // this index SQLite answers them by walking every row: the dispatch
    // readback scans `_visible` and the settlement scan walks the table, so
    // each delivered batch costs two passes over the backlog. The `_lease`
    // index cannot serve them because it is keyed on `leased_until`.
    // The partial predicate keeps only leased rows, which `max_concurrency`
    // times `max_batch_size` bounds, and an inserted message has a null
    // `lease_id`, so `send` pays nothing for it.
    sql.exec(
      `CREATE INDEX IF NOT EXISTS ${__QUEUE_MESSAGES}_lease_batch
         ON ${__QUEUE_MESSAGES} (lease_id, visible_at, seq)
         WHERE lease_id IS NOT NULL`,
    );
    // The live-row index catches an impossible duplicate while a received
    // message remains queued. The receipt below is the durable deduplication
    // record after a consumer or purge removes that message.
    sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${__QUEUE_MESSAGES}_dlq_transfer
         ON ${__QUEUE_MESSAGES} (dlq_transfer_id)
         WHERE dlq_transfer_id IS NOT NULL AND dlq_target IS NULL`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${__QUEUE_META} (
         name TEXT PRIMARY KEY,
         value TEXT NOT NULL
       ) WITHOUT ROWID`,
    );
    // The producer result and operator metrics are on hot paths. SQLite
    // triggers keep the three values in the same transaction as every row
    // transition, so a caller cannot observe a new message with old totals.
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${__QUEUE_STATS} (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         stored_count INTEGER NOT NULL,
         backlog_count INTEGER NOT NULL,
         backlog_bytes INTEGER NOT NULL,
         oldest_message_timestamp INTEGER
       )`,
    );
    sql.exec(
      `INSERT INTO ${__QUEUE_STATS}
         (id, stored_count, backlog_count, backlog_bytes,
          oldest_message_timestamp)
       SELECT 1,
              COUNT(*),
              COALESCE(SUM(purge_on_settle = 0), 0),
              COALESCE(SUM(CASE WHEN purge_on_settle = 0 THEN size ELSE 0 END), 0),
              MIN(CASE WHEN purge_on_settle = 0 THEN enqueued_at END)
         FROM ${__QUEUE_MESSAGES}
        WHERE true
       ON CONFLICT(id) DO NOTHING`,
    );
    sql.exec(
      `CREATE TRIGGER IF NOT EXISTS ${__QUEUE_MESSAGES}_stored_insert
       AFTER INSERT ON ${__QUEUE_MESSAGES}
       BEGIN
         UPDATE ${__QUEUE_STATS}
            SET stored_count = stored_count + 1
          WHERE id = 1;
       END`,
    );
    sql.exec(
      `CREATE TRIGGER IF NOT EXISTS ${__QUEUE_MESSAGES}_stored_delete
       AFTER DELETE ON ${__QUEUE_MESSAGES}
       BEGIN
         UPDATE ${__QUEUE_STATS}
            SET stored_count = stored_count - 1
          WHERE id = 1;
       END`,
    );
    sql.exec(
      `CREATE TRIGGER IF NOT EXISTS ${__QUEUE_MESSAGES}_stats_insert
       AFTER INSERT ON ${__QUEUE_MESSAGES}
       WHEN new.purge_on_settle = 0
       BEGIN
         UPDATE ${__QUEUE_STATS}
            SET backlog_count = backlog_count + 1,
                backlog_bytes = backlog_bytes + new.size,
                oldest_message_timestamp = CASE
                  WHEN oldest_message_timestamp IS NULL
                    OR new.enqueued_at < oldest_message_timestamp
                  THEN new.enqueued_at ELSE oldest_message_timestamp END
          WHERE id = 1;
       END`,
    );
    sql.exec(
      `CREATE TRIGGER IF NOT EXISTS ${__QUEUE_MESSAGES}_stats_delete
       AFTER DELETE ON ${__QUEUE_MESSAGES}
       WHEN old.purge_on_settle = 0
       BEGIN
         UPDATE ${__QUEUE_STATS}
            SET backlog_count = backlog_count - 1,
                backlog_bytes = backlog_bytes - old.size,
                oldest_message_timestamp = CASE
                  WHEN backlog_count <= 1 THEN NULL
                  WHEN oldest_message_timestamp = old.enqueued_at
                  THEN (SELECT MIN(enqueued_at) FROM ${__QUEUE_MESSAGES}
                         WHERE purge_on_settle = 0)
                  ELSE oldest_message_timestamp END
          WHERE id = 1;
       END`,
    );
    sql.exec(
      `CREATE TRIGGER IF NOT EXISTS ${__QUEUE_MESSAGES}_stats_exclude
       AFTER UPDATE OF purge_on_settle ON ${__QUEUE_MESSAGES}
       WHEN old.purge_on_settle = 0 AND new.purge_on_settle != 0
       BEGIN
         UPDATE ${__QUEUE_STATS}
            SET backlog_count = backlog_count - 1,
                backlog_bytes = backlog_bytes - old.size,
                oldest_message_timestamp = CASE
                  WHEN backlog_count <= 1 THEN NULL
                  WHEN oldest_message_timestamp = old.enqueued_at
                  THEN (SELECT MIN(enqueued_at) FROM ${__QUEUE_MESSAGES}
                         WHERE purge_on_settle = 0)
                  ELSE oldest_message_timestamp END
          WHERE id = 1;
       END`,
    );
    sql.exec(
      `CREATE TRIGGER IF NOT EXISTS ${__QUEUE_MESSAGES}_stats_include
       AFTER UPDATE OF purge_on_settle ON ${__QUEUE_MESSAGES}
       WHEN old.purge_on_settle != 0 AND new.purge_on_settle = 0
       BEGIN
         UPDATE ${__QUEUE_STATS}
            SET backlog_count = backlog_count + 1,
                backlog_bytes = backlog_bytes + new.size,
                oldest_message_timestamp = CASE
                  WHEN oldest_message_timestamp IS NULL
                    OR new.enqueued_at < oldest_message_timestamp
                  THEN new.enqueued_at ELSE oldest_message_timestamp END
          WHERE id = 1;
       END`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${__QUEUE_TRANSFER_RECEIPTS} (
         transfer_id TEXT PRIMARY KEY,
         message_id TEXT NOT NULL,
         dead_letter_source TEXT,
         expires_at INTEGER NOT NULL
       ) WITHOUT ROWID`,
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS ${__QUEUE_TRANSFER_RECEIPTS}_expires
         ON ${__QUEUE_TRANSFER_RECEIPTS} (expires_at, transfer_id)`,
    );
    this._ready = true;
    return sql;
  }

  _meta(name) {
    return this._open().exec(
      `SELECT value FROM ${__QUEUE_META} WHERE name = ?`, name,
    ).toArray()[0]?.value;
  }

  _setMeta(name, value) {
    if (value === null || value === undefined) {
      this._open().exec(`DELETE FROM ${__QUEUE_META} WHERE name = ?`, name);
      return;
    }
    this._open().exec(
      `INSERT INTO ${__QUEUE_META} (name, value) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
      name,
      String(value),
    );
  }

  _paused() {
    return this._meta("paused") === "1";
  }

  _metrics(now = Date.now(), waitingOnly = false) {
    const expiresBefore = now - __queueLimits().retentionMs;
    const sql = this._open();
    const stats = sql.exec(
      `SELECT backlog_count, backlog_bytes, oldest_message_timestamp
         FROM ${__QUEUE_STATS} WHERE id = 1`,
    ).toArray()[0];
    // Retention is a clock transition, not a row transition. Until the
    // bounded sweep catches up, use the exact query only at that boundary;
    // the normal hot path remains one materialized row at every depth.
    if (stats.oldest_message_timestamp !== null &&
        stats.oldest_message_timestamp <= expiresBefore) {
      const row = sql.exec(
        `SELECT COUNT(*) AS backlog_count,
                COALESCE(SUM(size), 0) AS backlog_bytes,
                MIN(enqueued_at) AS oldest_message_timestamp
           FROM ${__QUEUE_MESSAGES}
          WHERE purge_on_settle = 0 AND enqueued_at > ?
            AND (? = 0 OR (lease_id IS NULL AND dlq_target IS NULL
                           AND visible_at <= ?))`,
        expiresBefore,
        waitingOnly ? 1 : 0,
        now,
      ).toArray()[0];
      return {
        backlogCount: row.backlog_count,
        backlogBytes: row.backlog_bytes,
        oldestMessageTimestamp: row.oldest_message_timestamp ?? null,
      };
    }
    if (!waitingOnly) {
      if (typeof __test_queue_metrics_materialized === "function") {
        __test_queue_metrics_materialized();
      }
      return {
        backlogCount: stats.backlog_count,
        backlogBytes: stats.backlog_bytes,
        oldestMessageTimestamp: stats.oldest_message_timestamp ?? null,
      };
    }
    const blocked = sql.exec(
      `SELECT COALESCE(SUM(blocked_count), 0) AS blocked_count,
              COALESCE(SUM(blocked_bytes), 0) AS blocked_bytes
         FROM (
           SELECT COUNT(*) AS blocked_count,
                  COALESCE(SUM(size), 0) AS blocked_bytes
             FROM ${__QUEUE_MESSAGES} INDEXED BY ${__QUEUE_MESSAGES}_lease
            WHERE purge_on_settle = 0 AND lease_id IS NOT NULL
           UNION ALL
           SELECT COUNT(*) AS blocked_count,
                  COALESCE(SUM(size), 0) AS blocked_bytes
             FROM ${__QUEUE_MESSAGES} INDEXED BY ${__QUEUE_MESSAGES}_moving
            WHERE purge_on_settle = 0 AND dlq_target IS NOT NULL
           UNION ALL
           SELECT COUNT(*) AS blocked_count,
                  COALESCE(SUM(size), 0) AS blocked_bytes
             FROM ${__QUEUE_MESSAGES} INDEXED BY ${__QUEUE_MESSAGES}_ready
            WHERE purge_on_settle = 0 AND dlq_target IS NULL
              AND lease_id IS NULL AND visible_at > ?
         )`,
      now,
    ).toArray()[0];
    const unleasedOldest = sql.exec(
      `SELECT enqueued_at
         FROM ${__QUEUE_MESSAGES} INDEXED BY ${__QUEUE_MESSAGES}_retained
        WHERE purge_on_settle = 0 AND dlq_target IS NULL
          AND lease_id IS NULL AND visible_at <= ?
        ORDER BY enqueued_at, seq
        LIMIT 1`,
      now,
    ).toArray()[0]?.enqueued_at ?? null;
    return {
      backlogCount: stats.backlog_count - blocked.blocked_count,
      backlogBytes: stats.backlog_bytes - blocked.blocked_bytes,
      oldestMessageTimestamp: unleasedOldest,
    };
  }

  async _rearm(now = Date.now(), waitForWake = false) {
    const sql = this._open();
    const consumer = __cell.queueConsumers?.[this.queue];
    const paused = this._paused();
    const active = sql.exec(
      `SELECT COUNT(DISTINCT lease_id) AS count
         FROM ${__QUEUE_MESSAGES} INDEXED BY ${__QUEUE_MESSAGES}_lease
        WHERE lease_id IS NOT NULL AND leased_until > ?`,
      now,
    ).toArray()[0].count;
    const concurrency = consumer
      ? consumer.maxConcurrency ?? __queueLimits().maxConcurrency
      : 0;
    const hasCapacity = !paused && consumer !== undefined && __queuePolicy({
      op: "capacity",
      active,
      maximum: concurrency,
    });
    // We need only enough ready rows to distinguish a partial batch from a
    // full one. The two indexed arms cover a new row and an expired lease,
    // and the outer LIMIT keeps the work independent of backlog depth.
    let ready = [];
    if (hasCapacity) {
      const visibleReady = sql.exec(
        `SELECT visible_at AS ready_at, seq
           FROM ${__QUEUE_MESSAGES} INDEXED BY ${__QUEUE_MESSAGES}_ready
          WHERE purge_on_settle = 0 AND dlq_target IS NULL
            AND lease_id IS NULL AND visible_at <= ?
          ORDER BY visible_at, seq
          LIMIT ?`,
        now,
        consumer.maxBatchSize,
      ).toArray();
      const expiredReady = sql.exec(
        `SELECT leased_until AS ready_at, seq
           FROM ${__QUEUE_MESSAGES} INDEXED BY ${__QUEUE_MESSAGES}_lease
          WHERE purge_on_settle = 0 AND dlq_target IS NULL
            AND lease_id IS NOT NULL AND leased_until <= ?
          ORDER BY leased_until, seq
          LIMIT ?`,
        now,
        consumer.maxBatchSize,
      ).toArray();
      ready = [...visibleReady, ...expiredReady]
        .sort((left, right) => left.ready_at - right.ready_at || left.seq - right.seq)
        .slice(0, consumer.maxBatchSize);
    }
    if (typeof __test_queue_rearm_bounded === "function") {
      __test_queue_rearm_bounded(
        ready.length <= (consumer?.maxBatchSize ?? 0),
        ready.length > 0,
      );
    }
    const earliestVisible = hasCapacity
      ? sql.exec(
        `SELECT visible_at
           FROM ${__QUEUE_MESSAGES} INDEXED BY ${__QUEUE_MESSAGES}_ready
          WHERE purge_on_settle = 0 AND dlq_target IS NULL
            AND lease_id IS NULL AND visible_at > ?
          ORDER BY visible_at, seq
          LIMIT 1`,
        now,
      ).toArray()[0]?.visible_at ?? null
      : null;
    const earliestLeaseExpiry = paused
      ? null
      : sql.exec(
        `SELECT leased_until
           FROM ${__QUEUE_MESSAGES} INDEXED BY ${__QUEUE_MESSAGES}_lease
          WHERE lease_id IS NOT NULL
          ORDER BY leased_until
          LIMIT 1`,
      ).toArray()[0]?.leased_until ?? null;
    const nextSweep = sql.exec(
      `SELECT enqueued_at + ? AS next_sweep
         FROM ${__QUEUE_MESSAGES} INDEXED BY ${__QUEUE_MESSAGES}_retained
        WHERE dlq_target IS NULL AND purge_on_settle = 0
        ORDER BY enqueued_at, seq
        LIMIT 1`,
      __queueLimits().retentionMs,
    ).toArray()[0]?.next_sweep ?? null;
    const dlqPending = sql.exec(
      `SELECT 1 AS pending
         FROM ${__QUEUE_MESSAGES} INDEXED BY ${__QUEUE_MESSAGES}_moving
        WHERE dlq_target IS NOT NULL
        LIMIT 1`,
    ).toArray().length !== 0;
    const receiptSweep = sql.exec(
      `SELECT expires_at AS next_sweep
         FROM ${__QUEUE_TRANSFER_RECEIPTS}
        ORDER BY expires_at, transfer_id
        LIMIT 1`,
    ).toArray()[0]?.next_sweep ?? null;
    // A queue without an attached consumer only wakes to reclaim retention.
    // Consumer attachment will nudge the cell when the fleet catalog gains a
    // registration; spinning on an already-visible row cannot make progress.
    let batchDeadline = null;
    if (ready.length > 0) {
      batchDeadline = ready.length >= consumer.maxBatchSize
        ? now
        : ready[0].ready_at + consumer.maxBatchTimeoutMs;
    }
    if (dlqPending) {
      batchDeadline = batchDeadline === null ? now : Math.min(batchDeadline, now);
    }
    const sweepDeadlines = [nextSweep, receiptSweep]
      .filter((deadline) => deadline !== null && deadline !== undefined);
    const armAt = __queuePolicy({
      op: "rearm",
      now,
      batchDeadline,
      earliestVisible,
      // A live handler can settle after delivery pauses. Do not reclaim its
      // lease while paused; resume re-arms the expired deadline immediately
      // and only then can a new generation replace it.
      earliestLeaseExpiry,
      nextSweep: sweepDeadlines.length === 0 ? null : Math.min(...sweepDeadlines),
    });
    if (armAt !== null && !Number.isFinite(armAt)) {
      throw __queueError("the Queue sweep deadline is invalid");
    }
    if (armAt === null) await this.ctx.storage.deleteAlarm();
    else if (waitForWake) {
      await __queue_alarm_set_wait(__objectState.scope(this.ctx), armAt);
    } else await this.ctx.storage.setAlarm(armAt);
  }

  _newProducerGroup() {
    const group = {
      calls: [],
      entries: [],
      bytes: 0,
      flushing: false,
      timer: null,
    };
    this._producerGroup = group;
    group.timer = setTimeout(() => {
      void this._flushProducerGroup(group);
    }, __queueLimits().producerGroupMs);
    return group;
  }

  async _flushProducerGroup(group) {
    if (group.flushing) return;
    group.flushing = true;
    if (this._producerGroup === group) this._producerGroup = null;
    if (group.timer !== null) {
      clearTimeout(group.timer);
      group.timer = null;
    }

    const now = Date.now();
    try {
      const sql = this._open();
      this.ctx.storage.transactionSync(() => {
        for (const entry of group.entries) {
          sql.exec(
            `INSERT INTO ${__QUEUE_MESSAGES}
               (id, body, content_type, size, enqueued_at, visible_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            __queueMessageId(now),
            entry.body,
            entry.contentType,
            entry.size,
            now,
            now + entry.delaySeconds * 1000,
          );
        }
      });
      await this._rearm(now, true);
      const metrics = this._metrics(now);
      if (typeof __test_queue_producer_group === "function") {
        __test_queue_producer_group(group.calls.length, group.entries.length);
      }
      for (const call of group.calls) call.resolve(metrics);
    } catch (error) {
      for (const call of group.calls) call.reject(error);
    }
  }

  // The producer binding's call. Each entry is checked again here, with the
  // binding's own errors: the binding encodes and bounds it in the caller's
  // isolate, and a caller that skipped that must gain nothing by it.
  __queueSend({ entries } = {}) {
    entries = __queueCheckEntries(entries, "a batch");
    const bytes = entries.reduce((total, entry) => total + entry.size, 0);
    if (bytes > __queueLimits().maxBatchBytes) {
      throw __queueError(
        `a batch is at most ${__queueLimits().maxBatchBytes} bytes, got ${bytes}`,
      );
    }
    return new Promise((resolve, reject) => {
      let group = this._producerGroup;
      if (group !== null &&
          (group.calls.length + 1 > __QUEUE_PRODUCER_GROUP_CALLS ||
            group.entries.length + entries.length > __QUEUE_PRODUCER_GROUP_MESSAGES ||
            group.bytes + bytes > __QUEUE_PRODUCER_GROUP_BYTES)) {
        void this._flushProducerGroup(group);
        group = null;
      }
      if (group === null) group = this._newProducerGroup();
      group.calls.push({ resolve, reject });
      group.entries.push(...entries);
      group.bytes += bytes;
      if (group.calls.length === __QUEUE_PRODUCER_GROUP_CALLS ||
          group.entries.length === __QUEUE_PRODUCER_GROUP_MESSAGES ||
          group.bytes === __QUEUE_PRODUCER_GROUP_BYTES) {
        void this._flushProducerGroup(group);
      }
    });
  }

  __queueMetrics() {
    return this._metrics();
  }

  // Retention decides visibility through `_metrics` immediately, while this
  // bounded sweep only reclaims space. A live lease is marked instead of
  // deleted, so its handler can finish but settlement or expiry removes it
  // without a redelivery.
  _sweep(now) {
    const sql = this._open();
    const cutoff = now - __queueLimits().retentionMs;
    const messages = __cellSweepBatch(
      this.ctx.storage,
      (limit) => sql.exec(
        `SELECT seq, lease_id, leased_until FROM ${__QUEUE_MESSAGES}
          WHERE enqueued_at <= ?
            AND (purge_on_settle = 0
              OR lease_id IS NULL OR leased_until <= ?)
          ORDER BY enqueued_at, seq
          LIMIT ?`,
        cutoff,
        now,
        limit,
      ).toArray(),
      (row) => {
        if (row.lease_id !== null && row.leased_until > now) {
          sql.exec(
            `UPDATE ${__QUEUE_MESSAGES} SET purge_on_settle = 1 WHERE seq = ?`,
            row.seq,
          );
        } else {
          sql.exec(`DELETE FROM ${__QUEUE_MESSAGES} WHERE seq = ?`, row.seq);
        }
      },
      __queueLimits().sweepBatchRows,
    );
    const remaining = __queueLimits().sweepBatchRows - messages;
    if (remaining === 0) return messages;
    const receipts = __cellSweepBatch(
      this.ctx.storage,
      (limit) => sql.exec(
        `SELECT transfer_id FROM ${__QUEUE_TRANSFER_RECEIPTS}
          WHERE expires_at <= ?
          ORDER BY expires_at, transfer_id
          LIMIT ?`,
        now,
        limit,
      ).toArray(),
      (row) => {
        sql.exec(
          `DELETE FROM ${__QUEUE_TRANSFER_RECEIPTS} WHERE transfer_id = ?`,
          row.transfer_id,
        );
      },
      remaining,
    );
    return messages + receipts;
  }

  _candidateRows(now, limit) {
    return this._open().exec(
      `SELECT seq, id, body, content_type, size, enqueued_at, visible_at,
              attempts, lease_id, lease_generation, leased_until,
              purge_on_settle
         FROM ${__QUEUE_MESSAGES}
        WHERE dlq_target IS NULL AND ((purge_on_settle = 1
                 AND (lease_id IS NULL OR leased_until <= ?))
           OR (purge_on_settle = 0 AND visible_at <= ?
                 AND (lease_id IS NULL OR leased_until <= ?)))
        ORDER BY visible_at, seq
        LIMIT ?`,
      now,
      now,
      now,
      limit,
    ).toArray();
  }

  async _leaseBatch(now, consumer) {
    const sql = this._open();
    const active = sql.exec(
      `SELECT COUNT(DISTINCT lease_id) AS count
         FROM ${__QUEUE_MESSAGES}
        WHERE lease_id IS NOT NULL AND leased_until > ?`,
      now,
    ).toArray()[0].count;
    const concurrency = consumer.maxConcurrency ?? __queueLimits().maxConcurrency;
    if (!__queuePolicy({ op: "capacity", active, maximum: concurrency })) return null;

    // Read extra rows so expired purge markers cannot hide a deliverable
    // batch. Policy chooses at most `maxBatchSize` rows and returns every
    // purge deletion that precedes them in this bounded scan.
    const rows = this._candidateRows(now, consumer.maxBatchSize + 256);
    const deliverable = rows.filter((row) => row.purge_on_settle === 0);
    if (deliverable.length === 0) {
      if (rows.length > 0) {
        this.ctx.storage.transactionSync(() => {
          for (const row of rows) {
            sql.exec(`DELETE FROM ${__QUEUE_MESSAGES} WHERE seq = ?`, row.seq);
          }
        });
      }
      return null;
    }
    const readySince = Math.min(...deliverable.map((row) =>
      row.lease_id === null ? row.visible_at : row.leased_until
    ));
    if (deliverable.length < consumer.maxBatchSize &&
        readySince + consumer.maxBatchTimeoutMs > now) {
      return null;
    }

    const plan = __queuePolicy({
      op: "batch",
      now,
      maxBatchSize: consumer.maxBatchSize,
      rows: rows.map((row) => ({
        seq: row.seq,
        visibleAt: row.visible_at,
        leaseGeneration: String(row.lease_generation),
        leasedUntil: row.leased_until,
        purgeOnSettle: row.purge_on_settle !== 0,
      })),
    });
    if (plan.leases.length === 0 && plan.deletePurged.length === 0) return null;
    const rowBySeq = new Map(rows.map((row) => [row.seq, row]));
    const reclaimed = plan.leases.filter((lease) => lease.reclaimed);
    const expiryPolicy = __queuePolicy({
      op: "expiry",
      now,
      entries: reclaimed.map((lease) => {
        const row = rowBySeq.get(lease.seq);
        return {
          priorFailures: row.attempts,
          maxRetries: consumer.maxRetries,
          configuredSeconds: consumer.retryDelaySeconds ?? null,
          purgeOnSettle: row.purge_on_settle !== 0,
        };
      }),
    });
    const expiryBySeq = new Map(
      reclaimed.map((lease, index) => [lease.seq, expiryPolicy[index]]),
    );
    const installs = plan.leases.filter((lease) => {
      const expiry = expiryBySeq.get(lease.seq);
      return expiry === undefined ||
        (expiry.action.kind === "retry" && expiry.action.at <= now);
    });
    const exhaustedTransfers = new Map(
      reclaimed
        .filter((lease) =>
          expiryBySeq.get(lease.seq).action.kind === "exhausted" &&
          consumer.deadLetterQueue !== undefined
        )
        .map((lease) => [lease.seq, crypto.randomUUID()]),
    );
    const leaseId = crypto.randomUUID();
    const leasedUntil = Math.min(
      Number.MAX_SAFE_INTEGER,
      now + __cell.queueLeaseDurationMs,
    );
    this.ctx.storage.transactionSync(() => {
      for (const seq of plan.deletePurged) {
        sql.exec(
          `DELETE FROM ${__QUEUE_MESSAGES}
            WHERE seq = ? AND purge_on_settle = 1
              AND (lease_id IS NULL OR leased_until <= ?)`,
          seq,
          now,
        );
      }
      for (const lease of reclaimed) {
        const expiry = expiryBySeq.get(lease.seq);
        if (expiry.action.kind === "delete-purged") {
          sql.exec(
            `DELETE FROM ${__QUEUE_MESSAGES}
              WHERE seq = ? AND leased_until <= ?`,
            lease.seq,
            now,
          );
        } else if (expiry.action.kind === "exhausted") {
          if (consumer.deadLetterQueue === undefined) {
            sql.exec(
              `DELETE FROM ${__QUEUE_MESSAGES}
                WHERE seq = ? AND leased_until <= ?`,
              lease.seq,
              now,
            );
          } else {
            sql.exec(
              `UPDATE ${__QUEUE_MESSAGES}
                  SET attempts = ?, lease_id = NULL, leased_until = NULL,
                      dlq_target = ?, dlq_transfer_id = ?,
                      transfer_kind = 'dead-letter'
                WHERE seq = ? AND leased_until <= ?`,
              expiry.attempt,
              consumer.deadLetterQueue,
              exhaustedTransfers.get(lease.seq),
              lease.seq,
              now,
            );
          }
        } else if (expiry.action.at > now) {
          sql.exec(
            `UPDATE ${__QUEUE_MESSAGES}
                SET attempts = ?, visible_at = ?, lease_id = NULL,
                    leased_until = NULL
              WHERE seq = ? AND leased_until <= ?`,
            expiry.attempt,
            expiry.action.at,
            lease.seq,
            now,
          );
        }
      }
      for (const lease of installs) {
        const generation = Number(lease.generation);
        if (!Number.isSafeInteger(generation)) {
          throw __queueError(`message ${lease.seq} exhausted its safe lease generation`);
        }
        sql.exec(
          `UPDATE ${__QUEUE_MESSAGES}
              SET lease_id = ?, lease_generation = ?, leased_until = ?,
                  attempts = attempts + ?
            WHERE seq = ? AND lease_generation = ?
              AND (lease_id IS NULL OR leased_until <= ?)`,
          leaseId,
          generation,
          leasedUntil,
          lease.reclaimed ? 1 : 0,
          lease.seq,
          generation - 1,
          now,
        );
      }
    });
    if (installs.length === 0) return null;
    const leasedQuery =
      `SELECT seq, id, body, content_type, enqueued_at, attempts,
              lease_generation
         FROM ${__QUEUE_MESSAGES}
        WHERE lease_id = ?
        ORDER BY visible_at, seq`;
    __queueReportLeaseLookupPlan(sql, leasedQuery, leaseId);
    const leased = sql.exec(leasedQuery, leaseId).toArray();
    if (leased.length !== installs.length) {
      throw __queueError("the Queue lease transaction changed fewer rows than its plan");
    }
    return {
      leaseId,
      leases: leased.map((row) => ({
        message_id: row.id,
        seq: row.seq,
        generation: row.lease_generation,
      })),
      messages: leased.map((row) => ({
        id: row.id,
        timestampMs: row.enqueued_at,
        // SQLite answers a BLOB as an ArrayBuffer. The raw base64 op accepts
        // typed views, so normalize here; otherwise it encodes the text
        // "[object ArrayBuffer]" and every consumer decoder sees corrupt data.
        bodyBase64: $$btoa(
          row.body instanceof Uint8Array ? row.body : new Uint8Array(row.body),
        ),
        contentType: row.content_type,
        attempts: row.attempts + 1,
      })),
      // Miniflare removes every dispatched batch from its backlog before it
      // invokes the consumer. Exclude every lease here for the same contract;
      // the operator aggregate still includes durable in-flight messages.
      metrics: this._metrics(now, true),
    };
  }

  // The target deduplicates the stable transfer identity. The source can
  // therefore repeat this call after a stop between the target commit and the
  // source delete without creating a second message.
  //
  // An internal method: only another Queue cell's event in the runtime
  // cells' isolate reaches it (`__runtimeClass`), never a binding. Its
  // transfers are still checked, as a producer's entries are, so a malformed
  // one fails here and not as a corrupt row.
  async __queueDlqAcceptBatch({ transfers } = {}) {
    if (!Array.isArray(transfers) || transfers.length === 0 ||
        transfers.length > __queueLimits().maxBatchMessages) {
      throw __queueError("a Queue transfer batch has an invalid size");
    }
    for (const transfer of transfers) {
      if (transfer === null || typeof transfer !== "object" ||
          !__queueUuid(transfer.transferId)) {
        throw __queueError("a Queue transfer has an invalid transfer id");
      }
      if (transfer.deadLetterSource !== null &&
          (typeof transfer.deadLetterSource !== "string" ||
            transfer.deadLetterSource === "")) {
        throw __queueError("a Queue transfer has an invalid dead-letter source");
      }
      const entry = transfer.entry;
      if (entry === null || typeof entry !== "object" || !__queueUuid(entry.id)) {
        throw __queueError("a Queue transfer has an invalid message id");
      }
      __queueCheckBody(entry, "a transferred message");
    }
    const now = Date.now();
    const sql = this._open();
    this.ctx.storage.transactionSync(() => {
      for (const { transferId, entry, deadLetterSource } of transfers) {
        const accepted = sql.exec(
          `SELECT message_id, dead_letter_source
             FROM ${__QUEUE_TRANSFER_RECEIPTS}
            WHERE transfer_id = ?`,
          transferId,
        ).toArray()[0];
        if (accepted !== undefined && (accepted.message_id !== entry.id ||
            accepted.dead_letter_source !== deadLetterSource)) {
          throw __queueError("a DLQ transfer collided with another message identity");
        }
        if (accepted !== undefined) continue;
        sql.exec(
          `INSERT INTO ${__QUEUE_TRANSFER_RECEIPTS}
             (transfer_id, message_id, dead_letter_source, expires_at)
           VALUES (?, ?, ?, ?)`,
          transferId,
          entry.id,
          deadLetterSource,
          now + __queueLimits().retentionMs,
        );
        sql.exec(
          `INSERT INTO ${__QUEUE_MESSAGES}
             (id, body, content_type, size, enqueued_at, visible_at,
              attempts, dlq_transfer_id, dead_letter_source)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          entry.id,
          entry.body,
          entry.contentType,
          entry.size,
          now,
          now,
          transferId,
          deadLetterSource,
        );
      }
    });
    await this._rearm(now);
    return this._metrics(now);
  }

  async _driveDlq(limit = 100) {
    const now = Date.now();
    const pending = this._open().exec(
      `SELECT seq, id, body, content_type, size, dlq_target, dlq_transfer_id,
              transfer_kind
         FROM ${__QUEUE_MESSAGES}
        WHERE dlq_target IS NOT NULL
          AND enqueued_at > ?
        ORDER BY seq
        LIMIT ?`,
      now - __queueLimits().retentionMs,
      limit,
    ).toArray();
    const groups = new Map();
    for (const row of pending) {
      let group = groups.get(row.dlq_target);
      if (group === undefined) groups.set(row.dlq_target, group = []);
      group.push(row);
    }
    for (const [targetName, rows] of groups) {
      await __cellRpc("__Queue", targetName, "__queueDlqAcceptBatch", [{
        transfers: rows.map((row) => ({
          transferId: row.dlq_transfer_id,
          // A dead-letter transfer records where redrive returns the message.
          // A redrive returns it to ordinary queue state, so the source marker
          // must not follow it and make a later redrive bounce it backwards.
          deadLetterSource: row.transfer_kind === "dead-letter" ? this.queue : null,
          entry: {
            id: row.id,
            body: row.body,
            contentType: row.content_type,
            size: row.size,
          },
        })),
      }]);
      if (typeof __test_queue_dlq_accepted === "function") {
        __test_queue_dlq_accepted();
      }
      // The target committed every receipt before this reply. Delete the
      // corresponding source marks together; a stop before this transaction
      // leaves the whole group replayable through those stable receipts.
      this.ctx.storage.transactionSync(() => {
        for (const row of rows) {
          this._open().exec(
            `DELETE FROM ${__QUEUE_MESSAGES}
              WHERE seq = ? AND dlq_target = ? AND dlq_transfer_id = ?
                AND transfer_kind = ?`,
            row.seq,
            row.dlq_target,
            row.dlq_transfer_id,
            row.transfer_kind,
          );
        }
      });
    }
    return pending.length;
  }

  async alarm() {
    const now = Date.now();
    try {
      await this._driveDlq();
    } catch (error) {
      // The durable source mark is the retry record. An alarm stays armed at
      // `now`, and the target's transfer identity makes a replay idempotent.
      console.error("Queue DLQ transfer failed:", error);
    }
    const swept = this._sweep(now);
    const consumer = this._paused()
      ? undefined
      : __cell.queueConsumers?.[this.queue];
    // Install every lease that the configured concurrency admits before the
    // first consumer can settle. One lease per alarm serialized full batches
    // because the next alarm depended on a later scheduler turn, so a queue
    // with maxConcurrency > 1 still used only one handler under backlog.
    // `_leaseBatch` counts the durable lease IDs on every iteration, which
    // makes the configured concurrency the structural bound for this loop.
    const batches = [];
    if (consumer !== undefined) {
      while (true) {
        const batch = await this._leaseBatch(now, consumer);
        if (batch === null) break;
        batches.push(batch);
      }
    }
    try {
      // `_leaseBatch` can exhaust an expired lease and create a new durable
      // DLQ mark. Drive that mark in the same wake; the first call above is
      // for a mark recovered from an earlier stopped process.
      await this._driveDlq();
    } catch (error) {
      console.error("Queue DLQ transfer failed:", error);
    }
    await this._rearm(now);
    if (swept >= __queueLimits().sweepBatchRows && batches.length === 0) {
      await this.ctx.storage.setAlarm(now + 1);
      return;
    }
    for (const batch of batches) {
      // This await covers only the output-gated handoff to the host. The
      // consumer runs after this alarm returns, and settlement comes back as
      // an independent cell event. All admitted leases are durable before the
      // first handoff, so a fast settlement cannot make this turn exceed the
      // configured concurrency.
      await __queue_dispatch(
        consumer.script,
        this.queue,
        JSON.stringify(batch),
      );
    }
  }

  _matchingLease(body) {
    if (typeof body.leaseId !== "string" || !Array.isArray(body.leases)) return null;
    const matchQuery =
      `SELECT seq, id, attempts, lease_generation, purge_on_settle
         FROM ${__QUEUE_MESSAGES}
        WHERE lease_id = ?
        ORDER BY seq`;
    __queueReportLeaseLookupPlan(this._open(), matchQuery, body.leaseId);
    const rows = this._open().exec(matchQuery, body.leaseId).toArray();
    for (const lease of body.leases) {
      if (typeof lease?.message_id !== "string" ||
          !Number.isSafeInteger(lease.seq) ||
          !Number.isSafeInteger(lease.generation)) return null;
    }
    const matches = __queuePolicy({
      op: "settlement",
      current: rows.map((row) => ({
        seq: String(row.seq),
        messageId: row.id,
        generation: String(row.lease_generation),
      })),
      submitted: body.leases.map((lease) => ({
        seq: String(lease.seq),
        messageId: lease.message_id,
        generation: String(lease.generation),
      })),
    });
    return matches ? rows : null;
  }

  async _settle(body) {
    const rows = this._matchingLease(body);
    if (rows === null) return false;
    const consumer = __cell.queueConsumers?.[this.queue];
    if (consumer === undefined) return false;
    const explicitAcks = new Set(body.explicitAcks ?? []);
    const retryMessages = new Map(
      (body.retryMessages ?? []).map((retry) => [retry.msgId, retry.delaySeconds]),
    );
    const retryBatch = body.retryBatch?.retry === true;
    const batchDelay = body.retryBatch?.delaySeconds;
    const exception = body.outcome === "exception";
    // An explicit ack-all survives a later handler exception, so it must
    // override every batch-level and message-level retry signal.
    const ackAll = body.ackAll === true;
    const decisions = rows.map((row) => {
      const retry = !ackAll && !explicitAcks.has(row.id) && (
        retryMessages.has(row.id) || retryBatch || exception
      );
      return { row, retry };
    });
    const retrying = decisions.filter((decision) =>
      decision.retry && decision.row.purge_on_settle === 0
    );
    const retryPolicy = __queuePolicy({
      op: "retries",
      now: Date.now(),
      entries: retrying.map(({ row }) => ({
        attempt: row.attempts + 1,
        maxRetries: consumer.maxRetries,
        explicitSeconds: retryMessages.has(row.id)
          ? retryMessages.get(row.id)
          : retryBatch ? batchDelay : null,
        configuredSeconds: consumer.retryDelaySeconds ?? null,
      })),
    });
    const retryById = new Map(
      retrying.map(({ row }, index) => [row.id, retryPolicy[index]]),
    );
    const dlqTransferById = new Map(
      retrying
        .filter(({ row }) =>
          retryById.get(row.id).exhausted && consumer.deadLetterQueue !== undefined
        )
        .map(({ row }) => [row.id, crypto.randomUUID()]),
    );
    const sql = this._open();
    this.ctx.storage.transactionSync(() => {
      for (const { row, retry } of decisions) {
        const policy = retryById.get(row.id);
        if (row.purge_on_settle !== 0 || !retry ||
            (policy.exhausted && consumer.deadLetterQueue === undefined)) {
          sql.exec(
            `DELETE FROM ${__QUEUE_MESSAGES}
              WHERE seq = ? AND lease_id = ? AND lease_generation = ?`,
            row.seq,
            body.leaseId,
            row.lease_generation,
          );
          continue;
        }
        if (policy.exhausted) {
          sql.exec(
            `UPDATE ${__QUEUE_MESSAGES}
                SET attempts = attempts + 1, lease_id = NULL,
                    leased_until = NULL, dlq_target = ?, dlq_transfer_id = ?,
                    transfer_kind = 'dead-letter'
              WHERE seq = ? AND lease_id = ? AND lease_generation = ?`,
            consumer.deadLetterQueue,
            dlqTransferById.get(row.id),
            row.seq,
            body.leaseId,
            row.lease_generation,
          );
          continue;
        }
        sql.exec(
          `UPDATE ${__QUEUE_MESSAGES}
              SET attempts = attempts + 1, visible_at = ?,
                  lease_id = NULL, leased_until = NULL
            WHERE seq = ? AND lease_id = ? AND lease_generation = ?`,
          policy.at,
          row.seq,
          body.leaseId,
          row.lease_generation,
        );
      }
    });
    try {
      await this._driveDlq();
    } catch (error) {
      // Settlement is durable once the source mark commits. A failed transfer
      // is alarm work now, not a reason to put the message back in delivery.
      console.error("Queue DLQ transfer deferred:", error);
    }
    await this._rearm();
    return true;
  }

  async _purge() {
    const now = Date.now();
    const sql = this._open();
    let deleted = 0;
    let leased = 0;
    this.ctx.storage.transactionSync(() => {
      let after = 0;
      while (true) {
        // Purge is necessarily proportional to the stored backlog, but its
        // policy envelope stays bounded instead of materializing the Queue in
        // V8 or Rust. One SQLite transaction keeps the visibility change
        // atomic across all chunks.
        const rows = sql.exec(
          `SELECT seq, lease_id, leased_until FROM ${__QUEUE_MESSAGES}
            WHERE seq > ?
            ORDER BY seq
            LIMIT 256`,
          after,
        ).toArray();
        if (rows.length === 0) break;
        after = rows[rows.length - 1].seq;
        const plan = __queuePolicy({
          op: "purge",
          now,
          rows: rows.map((row) => ({
            seq: String(row.seq),
            leaseIdPresent: row.lease_id !== null,
            leasedUntil: row.leased_until,
          })),
        });
        for (const seq of plan.delete) {
          sql.exec(
            `DELETE FROM ${__QUEUE_MESSAGES}
              WHERE seq = ?
                AND (lease_id IS NULL OR leased_until IS NULL OR leased_until <= ?)`,
            Number(seq),
            now,
          );
          deleted += 1;
        }
        for (const seq of plan.markForSettle) {
          sql.exec(
            `UPDATE ${__QUEUE_MESSAGES} SET purge_on_settle = 1
              WHERE seq = ? AND lease_id IS NOT NULL AND leased_until > ?`,
            Number(seq),
            now,
          );
          leased += 1;
        }
      }
    });
    await this._rearm(now);
    return { deleted, leased, metrics: this._metrics(now) };
  }

  async _setPaused(paused) {
    this._setMeta("paused", paused ? "1" : null);
    await this._rearm();
    return { paused, ...this._metrics() };
  }

  _operatorLimit(value, fallback) {
    const limit = value ?? fallback;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw __queueError("limit must be an integer from 1 through 100");
    }
    return limit;
  }

  _peek(limit) {
    const now = Date.now();
    const cutoff = now - __queueLimits().retentionMs;
    const rows = this._open().exec(
      `SELECT id, body, content_type, size, enqueued_at, visible_at, attempts,
              lease_id, leased_until, purge_on_settle, dlq_target,
              dead_letter_source
         FROM ${__QUEUE_MESSAGES}
        WHERE enqueued_at > ?
        ORDER BY visible_at, seq
        LIMIT ?`,
      cutoff,
      limit,
    ).toArray();
    return {
      messages: rows.map((row) => ({
        id: row.id,
        bodyBase64: $$btoa(
          row.body instanceof Uint8Array ? row.body : new Uint8Array(row.body),
        ),
        contentType: row.content_type,
        size: row.size,
        enqueuedAt: row.enqueued_at,
        visibleAt: row.visible_at,
        attempts: row.attempts,
        state: row.dlq_target !== null
          ? "moving"
          : row.purge_on_settle !== 0
          ? "purging"
          : row.lease_id !== null && row.leased_until > now
          ? "leased"
          : row.visible_at <= now
          ? "visible"
          : "delayed",
        leasedUntil: row.lease_id !== null && row.leased_until > now
          ? row.leased_until
          : null,
        transferTarget: row.dlq_target,
        deadLetterSource: row.dead_letter_source,
      })),
    };
  }

  async _redrive(limit) {
    // Finish an interrupted move before selecting more work. A transfer mark
    // is durable, so selecting it a second time would invent another identity
    // where replaying the existing identity is sufficient.
    await this._driveDlq(100);
    const now = Date.now();
    const cutoff = now - __queueLimits().retentionMs;
    const candidates = this._open().exec(
      `SELECT seq, dead_letter_source
         FROM ${__QUEUE_MESSAGES}
        WHERE dead_letter_source IS NOT NULL
          AND dlq_target IS NULL
          AND purge_on_settle = 0
          AND enqueued_at > ?
          AND (lease_id IS NULL OR leased_until <= ?)
        ORDER BY visible_at, seq
        LIMIT ?`,
      cutoff,
      now,
      limit,
    ).toArray();
    const transfers = candidates.map((row) => ({
      ...row,
      transferId: crypto.randomUUID(),
    }));
    this.ctx.storage.transactionSync(() => {
      for (const transfer of transfers) {
        this._open().exec(
          `UPDATE ${__QUEUE_MESSAGES}
              SET dlq_target = ?, dlq_transfer_id = ?, transfer_kind = 'redrive',
                  lease_id = NULL, leased_until = NULL
            WHERE seq = ? AND dead_letter_source = ? AND dlq_target IS NULL
              AND purge_on_settle = 0
              AND (lease_id IS NULL OR leased_until <= ?)`,
          transfer.dead_letter_source,
          transfer.transferId,
          transfer.seq,
          transfer.dead_letter_source,
          now,
        );
      }
    });
    // Arm before the cross-cell call. If the process stops after the durable
    // mark, the alarm replays the same transfer identity.
    await this._rearm(now);
    await this._driveDlq(100);
    await this._rearm();
    return { redriven: transfers.length, metrics: this._metrics() };
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") {
      return new Response("Queue route not found", { status: 404 });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response("invalid Queue request", { status: 400 });
    }
    try {
      if (path === "/__qSettle") {
        return await this._settle(body)
          ? new Response(null, { status: 204 })
          : new Response("stale Queue settlement", { status: 409 });
      }
      if (body.op === "info") {
        const metrics = this._metrics();
        const stored = this._open().exec(
          `SELECT stored_count FROM ${__QUEUE_STATS} WHERE id = 1`,
        ).toArray()[0].stored_count;
        return Response.json({ result: { ...metrics, stored, paused: this._paused() } });
      }
      if (body.op === "purge") {
        return Response.json({ result: await this._purge() });
      }
      if (body.op === "pause") {
        return Response.json({ result: await this._setPaused(true) });
      }
      if (body.op === "resume") {
        return Response.json({ result: await this._setPaused(false) });
      }
      if (body.op === "peek") {
        return Response.json({
          result: this._peek(this._operatorLimit(body.limit, 10)),
        });
      }
      if (body.op === "redrive") {
        return Response.json({
          result: await this._redrive(this._operatorLimit(body.limit, 100)),
        });
      }
      return Response.json(
        { error: `QUEUE_ERROR: unknown operation ${JSON.stringify(body.op)}` },
        { status: 400 },
      );
    } catch (error) {
      return Response.json(
        { error: String(error?.message ?? error) },
        { status: 400 },
      );
    }
  }
}

__runtimeClass("__Queue", __QueueCell,
  ["__queueSend", "__queueMetrics"], ["__queueDlqAcceptBatch"]);

// The producer binding. Only `__makeQueue` constructs one, as in workerd
// ("Illegal constructor"), and its cell is private, so a script reaches the
// Queue cell only through these methods.
const __kQueue = Symbol("Queue");
class Queue {
  #cellName;
  #deliveryDelay;

  constructor(brand, cellName, deliveryDelay) {
    if (brand !== __kQueue) throw new TypeError("Illegal constructor");
    this.#cellName = cellName;
    this.#deliveryDelay = deliveryDelay;
  }

  #call(method, args) {
    return __cellRpc("__Queue", this.#cellName, method, args);
  }

  async #send(entries) {
    const metrics = await this.#call("__queueSend", [{ entries }]);
    return { metadata: { metrics: __queueMetricsView(metrics) } };
  }

  send(body, options = {}) {
    const encoded = __queueEncode(body, options.contentType);
    return this.#send([{
      ...encoded,
      delaySeconds: __queueDelay(options.delaySeconds, this.#deliveryDelay),
    }]);
  }

  sendBatch(messages, options = {}) {
    if (messages === null || messages === undefined ||
        typeof messages[Symbol.iterator] !== "function") {
      throw __queueError("sendBatch() needs an iterable of messages");
    }
    const entries = [];
    let bytes = 0;
    const batchDelay = __queueDelay(options.delaySeconds, this.#deliveryDelay);
    for (const message of messages) {
      if (entries.length >= __queueLimits().maxBatchMessages) {
        throw __queueError(
          `a batch has at most ${__queueLimits().maxBatchMessages} messages`,
        );
      }
      if (message === null || typeof message !== "object" || !("body" in message)) {
        throw __queueError("each batch entry needs a body");
      }
      const encoded = __queueEncode(message.body, message.contentType);
      bytes += encoded.size;
      if (bytes > __queueLimits().maxBatchBytes) {
        throw __queueError(
          `a batch is at most ${__queueLimits().maxBatchBytes} bytes, got ${bytes}`,
        );
      }
      entries.push({
        ...encoded,
        delaySeconds: __queueDelay(message.delaySeconds, batchDelay),
      });
    }
    if (entries.length === 0) {
      throw __queueError("sendBatch() needs at least one message");
    }
    return this.#send(entries);
  }

  async metrics() {
    return __queueMetricsView(await this.#call("__queueMetrics", []));
  }
}

__celld.__makeQueue = (queue, cellName, deliveryDelay) =>
  new Queue(__kQueue, cellName, deliveryDelay);

// ---- D1 -----------------------------------------------------------------
// A D1 database is a cell of a runtime-supplied Durable Object class, so it
// inherits ownership, fencing, LTX replication, RPO=0 acknowledgement and
// pressure shedding from the cell it already is. This half is the server;
// `__makeD1Database` below is the client the binding hands to a Worker.
//
// Everything SQL goes through the one `__d1_run` op. The engine owns the
// statement walk, the row and byte caps, and the meta snapshot, all inside
// one execution -- the previous shape assembled these from the general
// SqlStorage ops, and every seam between them was a contract only convention
// enforced.

// The error families applications match on. A message that already carries
// one must pass through unwrapped: wrapping again would bury the family the
// application is matching under a second D1_ERROR prefix.
const __d1IsFamilyError = (message) =>
  /^D1_([A-Z]+_)*(ERROR|NOTFOUND): /.test(String(message));

const __d1Error = (message, cause) => {
  const error = new Error("D1_ERROR: " + String(message));
  error.cause = cause !== undefined ? cause : new Error(String(message));
  return error;
};

// A typed refusal from the engine: `{family, message}` becomes the Error the
// application sees, with `.cause` carrying the bare message as upstream does.
const __d1Failure = (failure) => {
  const error = new Error(failure.family + ": " + failure.message);
  error.cause = new Error(failure.message);
  return error;
};

const __d1Run = (scope, request) => {
  const response = JSON.parse(__d1_run(scope, JSON.stringify(request)));
  if (response.error) throw __d1Failure(response.error);
  return response.ok;
};

// The statements of a query or a batch, as the binding sends them: SQL
// text and an array of bind values.
const __d1Statements = (statements) => {
  if (!Array.isArray(statements)) throw __d1Error("a query takes an array of statements");
  return statements.map((statement) => {
    if (statement === null || typeof statement !== "object" ||
        typeof statement.sql !== "string") {
      throw __d1Error("a statement takes SQL text");
    }
    const params = statement.params ?? [];
    if (!Array.isArray(params)) throw __d1Error("a statement's bind values are an array");
    return { sql: statement.sql, params, first: statement.first };
  });
};

class __D1DatabaseCell {
  constructor(ctx) {
    this.ctx = ctx;
  }
  // The binding's calls, which are the cell's only RPC methods. The engine
  // checks every bind value and every cap itself; the statements' shape is
  // checked here, so a caller that skipped the binding's encoding gets a D1
  // error rather than whatever a coercion made of its value.
  //
  // Takes an array so that `batch()` can ride this same method, and the
  // same turn, when it lands.
  __d1Query(statements) {
    statements = __d1Statements(statements);
    const scope = __objectState.scope(this.ctx);
    return statements.map((statement) =>
      __d1Run(scope, {
        mode: "prepared",
        sql: statement.sql,
        params: statement.params,
        first: statement.first === true,
      })
    );
  }
  __d1Batch(statements) {
    statements = __d1Statements(statements);
    return __d1Run(__objectState.scope(this.ctx), {
      mode: "batch",
      statements: statements.map((statement) => ({
        sql: statement.sql,
        params: statement.params,
      })),
    });
  }
  // The CLI's way in. `celld d1` signs each request with the fleet secret
  // and sends it to a live node's `/runtime/<scope>` route, which verifies the
  // signature and then forwards to the owner over the same dispatch `/do/`
  // uses -- so the CLI needs no ownership logic and the database is reached
  // the way a Worker reaches it. The unauthenticated `/do/` route refuses a
  // D1 scope outright: this cell answers arbitrary SQL, and its scope is an
  // HMAC over names that sit in the project's config, so the scope itself
  // is no secret.
  async fetch(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "D1_ERROR: invalid request body" }, { status: 400 });
    }
    try {
      let result;
      if (body.migrate !== undefined) {
        result = this.__d1Migrate(
          String(body.migrate.name),
          String(body.migrate.sql),
          String(body.migrate.table || "d1_migrations"),
        );
      } else if (body.exec !== undefined) {
        // The CLI asks for rows; the Worker binding's exec() never does.
        result = __d1Run(__objectState.scope(this.ctx), {
          mode: "exec",
          sql: String(body.exec.sql),
          rows: !!body.exec.rows,
        });
      } else {
        result = this.__d1Query(body.statements || []);
      }
      return Response.json({ result });
    } catch (error) {
      return Response.json({ error: String(error && error.message || error) }, { status: 400 });
    }
  }
  __d1Exec(source) {
    if (typeof source !== "string") throw __d1Error("exec() takes SQL text");
    const result = __d1Run(__objectState.scope(this.ctx), {
      mode: "exec",
      sql: source,
      rows: false,
    });
    return { count: result.count, duration: result.duration };
  }
  // Apply one migration and record it. The engine runs the file, the
  // bookkeeping insert (the name is a bound parameter, so a file name never
  // reaches SQL text) and the BEGIN IMMEDIATE .. COMMIT bracket in one
  // request, so a migration that fails part-way rolls back whole and the
  // operator fixes the file and re-runs. Without the transaction the
  // statements that DID land are exactly the ones a re-run trips over.
  __d1Migrate(name, source, table) {
    return __d1Run(__objectState.scope(this.ctx), {
      mode: "migrate",
      name,
      sql: source,
      table,
    });
  }
}

__runtimeClass("__D1Database", __D1DatabaseCell,
  ["__d1Query", "__d1Batch", "__d1Exec"]);

// Validate and encode bind values once, at the public boundary, exactly as
// upstream does (workerd d1-api.ts). Byte-shaped values become byte arrays --
// the wire format for a BLOB bind -- and anything unsupported throws
// D1_TYPE_ERROR here, before any SQL runs. The first version deferred this
// to a JSON round-trip whose fallthrough was SQL NULL, so a Uint8Array bind
// stored NULL and nothing said so.
const __d1BindValue = (value) => {
  const kind = typeof value;
  if (kind === "number") {
    // A non-finite number has no JSON form, so it crosses as null and
    // stores SQL NULL. Upstream does the same (bind(NaN) selects typeof
    // "null"); making it explicit here turns the conversion from an
    // accident of JSON.stringify into a pinned decision.
    return Number.isFinite(value) ? value : null;
  }
  if (kind === "string") return value;
  if (kind === "boolean") return value ? 1 : 0;
  if (kind === "object") {
    if (value === null) return value;
    if (
      Array.isArray(value) &&
      value.every((byte) => typeof byte === "number" && byte >= 0 && byte < 256)
    ) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return Array.from(new Uint8Array(value));
    }
    // A typed view binds its ELEMENT values, each truncated to a byte --
    // Int8Array([-1]) stores 0xff, Float32Array([1.5]) stores 0x01 -- not
    // its underlying byte window, so Uint16Array([65, 66]) stores 2 bytes
    // and not 4. Upstream behaves this way (verified against workerd's D1;
    // the differential suite pins it), and the bare Array.from that
    // preceded this produced elements the engine then refused as bytes.
    if (ArrayBuffer.isView(value)) return Array.from(Uint8Array.from(value));
  }
  const error = new Error(
    `D1_TYPE_ERROR: Type '${kind}' not supported for value '${value}'`,
  );
  error.cause = new Error(`Type '${kind}' not supported for value '${value}'`);
  throw error;
};

// The binding's classes keep their database, statement and bookmark
// private, and only the harness constructs them ("Illegal constructor"), so
// a script reaches the database cell only through these methods. workerd's
// are a JavaScript wrapper with public fields and constructors that do not
// check (`env/d1-private-state`, xfail): celld's would name a database cell.
const __kD1 = Symbol("D1");
// The query and batch of a database or a session, by object, for the
// statements that run on it.
const __d1Runners = new WeakMap();
let __d1StatementParts;
class D1PreparedStatement {
  #database;
  #sql;
  #params;
  constructor(brand, database, sql, params) {
    if (brand !== __kD1) throw new TypeError("Illegal constructor");
    this.#database = database;
    this.#sql = sql;
    this.#params = params;
  }
  bind(...values) {
    return new D1PreparedStatement(
      __kD1,
      this.#database,
      this.#sql,
      values.map(__d1BindValue),
    );
  }
  async #run(first) {
    const results = await __d1Runners.get(this.#database).query([
      { sql: this.#sql, params: this.#params, first },
    ]);
    return results[0];
  }
  async all() {
    const result = await this.#run();
    return {
      success: true,
      meta: result.meta,
      results: result.rows.map((row) => __d1Shape(result.columns, row)),
    };
  }
  async run() {
    return await this.all();
  }
  async first(column) {
    // `first: true` keeps one row on the cell side, so only that row crosses
    // the isolate boundary and the row cap cannot fire for a first().
    const result = await this.#run(true);
    if (result.rows.length === 0) return null;
    const row = __d1Shape(result.columns, result.rows[0]);
    if (column === undefined) return row;
    // The check runs on the shaped object, as upstream's does, so a column
    // named like an Object.prototype member behaves the same here as there.
    if (row[column] === undefined) {
      const error = new Error(
        `D1_COLUMN_NOTFOUND: Column not found (${column})`,
      );
      error.cause = new Error("Column not found");
      throw error;
    }
    return row[column];
  }
  async raw(options) {
    const result = await this.#run();
    return options && options.columnNames
      ? [result.columns, ...result.rows]
      : result.rows;
  }
  static {
    // What `batch()` sends for a statement. Anything else crosses as an
    // empty statement, which the cell refuses.
    __d1StatementParts = (statement) =>
      statement !== null && typeof statement === "object" && #sql in statement
        ? { sql: statement.#sql, params: statement.#params }
        : { sql: undefined, params: undefined };
  }
}

// Object.fromEntries, not property assignment: assigning to a column named
// `__proto__` would walk the prototype chain and silently drop the value,
// while fromEntries defines an own property whatever the name.
const __d1Shape = (columns, row) =>
  Object.fromEntries(row.map((value, index) => [columns[index], value]));

const __d1PublicResult = (result) => ({
  success: true,
  meta: result.meta,
  results: result.rows.map((row) => __d1Shape(result.columns, row)),
});

// celld has one primary and no replicas, so every completed query satisfies
// every earlier session constraint. One stable opaque token states that fact
// without pretending an isolate-local counter is a durable database position.
const __d1PrimaryBookmark = "celld:primary";

class D1DatabaseSession {
  #bookmark;
  constructor(brand, database, constraintOrBookmark) {
    if (brand !== __kD1) throw new TypeError("Illegal constructor");
    const value = constraintOrBookmark == null
      ? "first-unconstrained"
      : String(constraintOrBookmark).trim();
    if (!value) {
      throw new Error("D1_SESSION_ERROR: invalid bookmark or constraint");
    }
    this.#bookmark =
      value === "first-primary" || value === "first-unconstrained" ? null : value;
    const runner = __d1Runners.get(database);
    __d1Runners.set(this, {
      query: async (statements) => {
        const results = await runner.query(statements);
        this.#bookmark = __d1PrimaryBookmark;
        return results;
      },
      batch: async (statements) => {
        const results = await runner.batch(statements);
        this.#bookmark = __d1PrimaryBookmark;
        return results;
      },
    });
  }
  prepare(sql) {
    return new D1PreparedStatement(__kD1, this, String(sql), []);
  }
  async batch(statements) {
    return await __d1Runners.get(this).batch(statements);
  }
  getBookmark() {
    return this.#bookmark;
  }
}

// Named so SDKs that sniff a binding by `constructor.name` recognise it.
class D1Database {
  #databaseName;
  constructor(brand, databaseName) {
    if (brand !== __kD1) throw new TypeError("Illegal constructor");
    this.#databaseName = databaseName;
    __d1Runners.set(this, {
      query: (statements) => this.#query(statements),
      batch: (statements) => this.#batch(statements),
    });
  }
  // Resolved per call rather than cached: a cell can move between calls, and
  // `getByName` is the same cost the Durable Object path already pays.
  #call(method, args) {
    return __cellRpc("__D1Database", this.#databaseName, method, args);
  }
  async #query(statements) {
    try {
      return await this.#call("__d1Query", [statements]);
    } catch (error) {
      if (__d1IsFamilyError(error && error.message)) throw error;
      throw __d1Error(String(error && error.message || error), error);
    }
  }
  async #batch(statements) {
    try {
      const results = await this.#call(
        "__d1Batch", [statements.map(__d1StatementParts)]);
      return results.map(__d1PublicResult);
    } catch (error) {
      if (__d1IsFamilyError(error && error.message)) throw error;
      throw __d1Error(String(error && error.message || error), error);
    }
  }
  prepare(sql) {
    return new D1PreparedStatement(__kD1, this, String(sql), []);
  }
  async exec(sql) {
    try {
      return await this.#call("__d1Exec", [String(sql)]);
    } catch (error) {
      if (__d1IsFamilyError(error && error.message)) throw error;
      throw __d1Error(String(error && error.message || error), error);
    }
  }
  async batch(statements) {
    return await this.#batch(statements);
  }
  withSession(constraintOrBookmark) {
    return new D1DatabaseSession(__kD1, this, constraintOrBookmark);
  }
  async dump() {
    throw __d1Error(
      "dump() is not implemented in celld; the database is a SQLite file in " +
        "your own bucket",
    );
  }
}

const __makeD1Database = __celld.__makeD1Database =
  (databaseName) => new D1Database(__kD1, databaseName);
// ---- Workflows ----------------------------------------------------------
// A workflow instance is one cell of the runtime-supplied `__Workflow` class,
// named `<workflow_name>/<instance_id>` through getByName, so it inherits
// ownership, fencing, LTX replication and the output gate from the cell it
// already is. Execution is replay: `run()` re-executes from the top on every
// resume and only steps are memoized, in `ctx.storage` KV under `__wf.*`.
// This half is the server; `__makeWorkflow` below is the client the binding
// hands to a Worker. The public contract is in docs/cloudflare-compat.md.

// Upstream's limit for a step return, an event payload, and the params. The
// error is distinct and names the step, because "too large" and "the isolate
// died" must not read the same (the D1 row-cap precedent).
const __WF_VALUE_CAP = 1 << 20;
// Workflow names, instance ids, and event types all share this charset.
// `/` is outside it, which is what makes the `<name>/<id>` cell-name join
// unambiguous.
const __WF_NAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;
const __wfError = (message) => new Error("WORKFLOW_ERROR: " + message);
// The suspension primitive: a blocked step returns a promise that never
// settles in this invocation, so user code simply stops progressing. A
// sentinel thrown through user code was rejected because `Promise.all` in
// `run()` would observe it as a rejection and user try/catch would eat it.
const __wfNever = new Promise(() => {});
const __wfTerminal = (status) =>
  status === "complete" || status === "errored" || status === "terminated";
// Upstream's hard bounds: 10,000 retries per step, 365 days for any sleep or
// event wait, one second under a waitForEvent timeout. Enforced loudly at the
// call site -- a config outside them would otherwise misbehave only after
// the instance is minutes or days into its run.
const __WF_RETRY_LIMIT_CAP = 10000;
const __WF_STEP_NAME_LIMIT = 256;
const __WF_MAX_WAIT_MS = 365 * 86400000;
const __WF_MIN_EVENT_TIMEOUT_MS = 1000;
// celld has no account plans, so it exposes the larger published retention
// ceiling as one stable application limit. Both an omitted policy and an
// omitted member of a partial policy use this value.
const __WF_RETENTION_MAX_MS = 30 * 86400000;
const __WF_LOCATION_HINTS = new Set([
  "wnam", "enam", "sam", "weur", "eeur", "apac", "apac-ne", "apac-se",
  "oc", "afr", "me",
]);
// How long run() can stay pending on non-step work while no step runs and
// none is blocked before the instance fails. Upstream permits un-stepped
// awaits between steps (they are merely non-durable), so erroring at the
// first quiescent macrotask would kill any run() whose external await
// outlives one turn of the loop. Sixty seconds is long enough for any
// sane un-stepped await and short enough that a truly never-settling
// promise fails the instance instead of wedging the alarm handler.
const __WF_STALL_GRACE_MS = 60000;
const __WF_UNITS = {
  second: 1000,
  minute: 60000,
  hour: 3600000,
  day: 86400000,
  week: 604800000,
  // Upstream does not document its month/year arithmetic; fixed 30/365-day
  // units are used so one expression cannot mean two durations depending on
  // when it runs.
  month: 30 * 86400000,
  year: 365 * 86400000,
};
const __wfDuration = (value, what) => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string") {
    throw __wfError(
      `invalid duration for ${what}: ${JSON.stringify(value)}; use milliseconds ` +
        'or "<n> <second|minute|hour|day|week|month|year>[s]"',
    );
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s+(second|minute|hour|day|week|month|year)s?\s*$/
    .exec(value);
  if (!match) {
    throw __wfError(
      `invalid duration for ${what}: ${JSON.stringify(value)}; use milliseconds ` +
        'or "<n> <second|minute|hour|day|week|month|year>[s]"',
    );
  }
  return Number(match[1]) * __WF_UNITS[match[2]];
};
const __wfRetentionDuration = (value, what) => {
  const durationMs = __wfDuration(value, what);
  if (durationMs > __WF_RETENTION_MAX_MS) {
    throw __wfError(
      `${what} is ${durationMs} ms, above celld's 30-day retention limit`,
    );
  }
  return durationMs;
};
const __wfOwnObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const __wfUnknownKey = (value, allowed) =>
  Object.keys(value).find((key) => !allowed.includes(key));
const __wfStepName = (name) => {
  // The pinned workers-sdk validator has no minimum length. An empty name is
  // therefore valid, although rejecting it looks safer at first glance. A
  // non-empty check made celld reject Worker code that the upstream runtime
  // accepts, so keep only the upstream length and control-character bounds.
  if (
    typeof name !== "string" || name.length > __WF_STEP_NAME_LIMIT ||
    /[\x00-\x1f]/.test(name)
  ) {
    throw __wfError(
      `invalid step name ${JSON.stringify(name)}: use at most ` +
        `${__WF_STEP_NAME_LIMIT} characters and no control characters`,
    );
  }
};
const __wfEventType = (type) => {
  if (typeof type !== "string" || type.length > 100 || !__WF_NAME_RE.test(type)) {
    throw __wfError(
      `invalid event type ${JSON.stringify(type)}: use at most 100 letters, ` +
        "digits, hyphens, or underscores",
    );
  }
};
const __wfSleepDuration = (duration, name) => {
  const durationMs = __wfDuration(
    duration,
    `the duration of sleep ${JSON.stringify(name)}`,
  );
  if (durationMs > __WF_MAX_WAIT_MS) {
    throw __wfError(
      `sleep ${JSON.stringify(name)} is ${durationMs} ms, above the upstream ` +
        "limit of 365 days",
    );
  }
  return durationMs;
};
const __wfSleepUntil = (timestamp, name) => {
  const at = timestamp instanceof Date ? timestamp.getTime() : timestamp;
  if (typeof at !== "number" || !Number.isFinite(at)) {
    throw __wfError(
      `invalid sleepUntil timestamp for ${JSON.stringify(name)}: use a Date ` +
        "or a UNIX timestamp in milliseconds",
    );
  }
  const delay = at - Date.now();
  if (delay > __WF_MAX_WAIT_MS) {
    throw __wfError(
      `sleepUntil ${JSON.stringify(name)} is ${delay} ms away, above the ` +
        "upstream limit of 365 days",
    );
  }
  return at;
};
const __wfWaitOptions = (options, name) => {
  if (!__wfOwnObject(options)) {
    throw __wfError(`invalid waitForEvent options for ${JSON.stringify(name)}`);
  }
  __wfEventType(options.type);
  const timeout = options.timeout ?? "24 hours";
  const timeoutMs = __wfDuration(
    timeout,
    `the timeout of waitForEvent ${JSON.stringify(name)}`,
  );
  if (timeoutMs < __WF_MIN_EVENT_TIMEOUT_MS || timeoutMs > __WF_MAX_WAIT_MS) {
    throw __wfError(
      `the timeout of waitForEvent ${JSON.stringify(name)} is ${timeoutMs} ms; ` +
        "upstream allows 1 second to 365 days",
    );
  }
  return { type: options.type, timeout, timeoutMs };
};
const __wfEventOptions = (options) => {
  if (!__wfOwnObject(options)) {
    throw __wfError("sendEvent() needs an event object");
  }
  __wfEventType(options.type);
  if (options.payload !== undefined) __wfCheckValue(options.payload, "the event payload");
  return { type: options.type, payload: options.payload };
};
const __wfRetentionOptions = (retention, what) => {
  if (retention === undefined) {
    return {
      successMs: __WF_RETENTION_MAX_MS,
      errorMs: __WF_RETENTION_MAX_MS,
    };
  }
  if (!__wfOwnObject(retention)) {
    throw __wfError(`${what} option retention must be an object`);
  }
  const unknown = __wfUnknownKey(retention, ["successRetention", "errorRetention"]);
  if (unknown !== undefined) {
    throw __wfError(
      `${what} option retention has an unknown field ${JSON.stringify(unknown)}`,
    );
  }
  return {
    successMs: retention.successRetention === undefined
      ? __WF_RETENTION_MAX_MS
      : __wfRetentionDuration(
        retention.successRetention,
        `${what} successRetention`,
      ),
    errorMs: retention.errorRetention === undefined
      ? __WF_RETENTION_MAX_MS
      : __wfRetentionDuration(retention.errorRetention, `${what} errorRetention`),
  };
};
const __wfLocationHint = (hint, what) => {
  if (hint !== undefined && !__WF_LOCATION_HINTS.has(hint)) {
    throw __wfError(
      `${what} has invalid locationHint ${JSON.stringify(hint)}`,
    );
  }
  return hint;
};
// A create as the binding sends it to the instance's cell, checked again in
// the cell. `cellName()` answers the cell's `<workflow>/<instance>`.
const __wfCheckCreate = (request, cellName) => {
  if (!__wfOwnObject(request)) throw __wfError("create() needs an object");
  const { workflowName, instanceId, params, retention, locationHint } = request;
  if (typeof workflowName !== "string" ||
      !Object.hasOwn(__cell.workflows, workflowName)) {
    throw __wfError(`unknown workflow ${JSON.stringify(workflowName)}`);
  }
  if (!__wfValidInstanceId(instanceId)) {
    throw __wfError(`invalid instance id ${JSON.stringify(instanceId)}`);
  }
  const durations = __wfOwnObject(retention)
    ? [retention.successMs, retention.errorMs] : [];
  if (durations.length !== 2 || !durations.every((ms) =>
    Number.isSafeInteger(ms) && ms >= 0 && ms <= __WF_RETENTION_MAX_MS)) {
    throw __wfError("create() option retention is invalid");
  }
  const checked = {
    workflowName,
    instanceId,
    params,
    retention: { successMs: retention.successMs, errorMs: retention.errorMs },
    locationHint: __wfLocationHint(locationHint, "create()"),
    skipExisting: request.skipExisting === true,
  };
  if (cellName() !== workflowName + "/" + instanceId) {
    throw __wfError("create() names another instance than its cell");
  }
  return checked;
};
const __wfRestartOptions = (options) => {
  if (options === undefined) return {};
  if (!__wfOwnObject(options)) {
    throw __wfError("restart() options must be an object");
  }
  const unknown = __wfUnknownKey(options, ["from"]);
  if (unknown !== undefined) {
    throw __wfError(`restart() has an unknown option ${JSON.stringify(unknown)}`);
  }
  if (options.from === undefined) return {};
  const from = options.from;
  if (!__wfOwnObject(from)) {
    throw __wfError("restart() option from must be an object");
  }
  const fromUnknown = __wfUnknownKey(from, ["name", "count", "type"]);
  if (fromUnknown !== undefined) {
    throw __wfError(
      `restart() option from has an unknown field ${JSON.stringify(fromUnknown)}`,
    );
  }
  __wfStepName(from.name);
  const count = from.count ?? 1;
  if (!Number.isInteger(count) || count < 1) {
    throw __wfError("restart() option from.count must be a positive integer");
  }
  const type = from.type ?? "do";
  if (!["do", "sleep", "waitForEvent"].includes(type)) {
    throw __wfError(
      'restart() option from.type must be "do", "sleep", or "waitForEvent"',
    );
  }
  return { from: { name: from.name, count, type } };
};
const __wfStepConfig = (config, name) => {
  if (!__wfOwnObject(config)) {
    throw __wfError(`invalid config for step ${JSON.stringify(name)}: use an object`);
  }
  let unknown = __wfUnknownKey(config, ["retries", "timeout", "sensitive"]);
  if (unknown !== undefined) {
    throw __wfError(
      `invalid config for step ${JSON.stringify(name)}: unknown option ` +
        JSON.stringify(unknown),
    );
  }
  const retries = config.retries;
  if (retries !== undefined) {
    if (!__wfOwnObject(retries)) {
      throw __wfError(`invalid retries config for step ${JSON.stringify(name)}`);
    }
    unknown = __wfUnknownKey(retries, ["limit", "delay", "backoff"]);
    if (unknown !== undefined) {
      throw __wfError(
        `invalid retries config for step ${JSON.stringify(name)}: unknown option ` +
          JSON.stringify(unknown),
      );
    }
    if (
      typeof retries.limit !== "number" || !Number.isFinite(retries.limit) ||
      retries.limit < 0
    ) {
      throw __wfError(
        `invalid retries config for step ${JSON.stringify(name)}: ` +
          "limit must be a non-negative number",
      );
    }
    if (retries.limit > __WF_RETRY_LIMIT_CAP) {
      throw __wfError(
        `invalid retries config for step ${JSON.stringify(name)}: limit is above ` +
          String(__WF_RETRY_LIMIT_CAP),
      );
    }
    if (typeof retries.delay !== "function") {
      __wfDuration(retries.delay, `the retries config delay of step ${JSON.stringify(name)}`);
    }
    if (
      retries.backoff !== undefined &&
      !["constant", "linear", "exponential"].includes(retries.backoff)
    ) {
      throw __wfError(
        `invalid retries config for step ${JSON.stringify(name)}: ` +
          "backoff must be constant, linear, or exponential",
      );
    }
  }
  if (config.timeout !== undefined) {
    const timeout = __wfDuration(
      config.timeout,
      `the config timeout of step ${JSON.stringify(name)}`,
    );
    if (timeout === 0) {
      throw __wfError(
        `invalid config timeout for step ${JSON.stringify(name)}: use a value above zero`,
      );
    }
  }
  if (config.sensitive !== undefined && config.sensitive !== "output") {
    throw __wfError(
      `invalid config sensitive value for step ${JSON.stringify(name)}: use "output"`,
    );
  }
  return {
    ...config,
    ...(retries === undefined ? {} : { retries: { ...retries } }),
  };
};
// Serialization is checked with the same encoder storage and RPC use, so a
// value that passes here cannot fail later at the isolate boundary. The
// thrown errors are permanent: retrying cannot make a value cloneable or
// shrink it.
const __wfEncodeValue = (value, what) => {
  try {
    return __sc_encode(value);
  } catch (error) {
    const failure = __wfError(
      `${what} is not serializable: ${String(error && error.message || error)}. ` +
        "It must survive structured clone; a ReadableStream return is not implemented in celld.",
    );
    failure.__wfPermanent = true;
    throw failure;
  }
};
const __wfCheckEncodedValue = (bytes, what) => {
  if (bytes.byteLength > __WF_VALUE_CAP) {
    const failure = __wfError(
      `${what} is ${bytes.byteLength} bytes, above the 1 MiB limit; ` +
        "store large output externally and return a reference",
    );
    failure.__wfPermanent = true;
    throw failure;
  }
};
const __wfCheckValue = (value, what) =>
  __wfCheckEncodedValue(__wfEncodeValue(value, what), what);
const __wfErrorRecord = (error) => ({
  name: String(error && error.name || "Error"),
  message: String(error && error.message || error),
});
// A permanently failed step rejects on every replay, so user try/catch
// around step.do keeps working after a resume, not only on the attempt that
// failed live.
const __wfReviveError = (record) => {
  const error = new Error(record.message);
  error.name = record.name;
  return error;
};
const __wfLedgerPrefix = (generation) => `__wf.${generation}.`;
const __wfEventPrefix = (generation) =>
  __wfLedgerPrefix(generation) + "event.";
const __wfEventKey = (generation, sequence) =>
  __wfEventPrefix(generation) + String(sequence).padStart(9, "0");
const __wfRetentionMs = (meta, status) =>
  status === "complete"
    ? (meta.retention?.successMs ?? __WF_RETENTION_MAX_MS)
    : (meta.retention?.errorMs ?? __WF_RETENTION_MAX_MS);
const __wfFinishRetention = (meta, transaction) => {
  meta.endedMs = Date.now();
  meta.expiresMs = meta.endedMs + __wfRetentionMs(meta, meta.status);
  transaction.setAlarm(meta.expiresMs);
};
// A ledger record replays only through the kind of call that wrote it. A
// `do` renamed into a `sleep`, or two calls reordered under one name, would
// otherwise read fields the other kind never wrote and continue on
// undefined -- a deadline of NaN, a value of nothing -- instead of failing.
const __wfKindCheck = (record, kind, name) => {
  if (record === undefined || record.kind === kind) return record;
  const failure = __wfError(
    `step ${JSON.stringify(name)} replays as ${kind} but its ledger record ` +
      `was written by ${record.kind}; a step keeps one kind across replays`,
  );
  failure.__wfPermanent = true;
  throw failure;
};
// Each step callback runs under an async-context frame naming its step (the
// same CPED-backed frame __ctxRun uses, so it survives the callback's
// awaits). A step started inside another step's callback would wedge
// quiescence: the outer callback cannot settle while it awaits the blocked
// inner step, so `running` never reaches zero and the instance can neither
// suspend nor finish. The frame is what lets the inner call refuse loudly
// at the nesting site instead.
const __wfStepKey = Symbol("celld.wfStep");
const __wfEnclosingStep = () => {
  const frame = __als_get();
  return frame === undefined ? undefined : frame.get(__wfStepKey);
};
const __wfEnterStep = (name, fn) => {
  const prior = __als_get();
  const frame = new Map(prior);
  frame.set(__wfStepKey, name);
  __als_set(frame);
  try {
    return fn();
  } finally {
    __als_set(prior);
  }
};

// Race an attempt against its deadline. The abandoned callback keeps
// running -- there is no cancellation to send it -- but its result is
// discarded and the timeout counts as a failed attempt, as upstream.
const __wfTimeout = (promise, ms, name, attempt) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(
          `step ${JSON.stringify(name)} timed out after ${ms} ms (attempt ${attempt})`,
        )),
      ms,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });

// Storage failures belong to the engine even when workflow code catches the
// rejected step promise. Record them outside the Error object, so user code
// cannot suppress a retry or forge one by returning a marked exception.
const __wfTrackStorageFailures = (storage, driver) => {
  const failed = (error) => {
    driver.storageFailure ??= error;
    throw error;
  };
  const trackSync = (method) => (...args) => {
    try {
      return method(...args);
    } catch (error) {
      failed(error);
    }
  };
  // `get` and `put` are async, so they answer a native promise.
  const trackAsync = (method) => (...args) =>
    __ReflectApply(__PromiseThen, trackSync(method)(...args), [undefined, failed]);
  // The instance's own storage view (`__ownStorage`) with the three methods
  // replaced, built as a null-prototype literal: `Object.create` and
  // `Object.defineProperty` are a script's to replace, with the storage.
  return {
    __proto__: storage,
    get: trackAsync(storage.get),
    put: trackAsync(storage.put),
    transactionSync: trackSync(storage.transactionSync),
  };
};

// The WorkflowStep the driver hands to run(). Each method resolves its step
// record by (name, occurrence count) -- the count is assigned synchronously
// at call time, so `Promise.all` of two same-named steps gets deterministic
// distinct keys in call order, and a repeated name in a loop cannot collide.
const __wfMakeStep = (driver) => {
  const storage = driver.storage;
  // The shared step frame. `body` resolves to {value} or {block: at, kind};
  // a blocked step leaves its promise unsettled forever in this invocation.
  // The running counter covers the whole body, ledger reads included, so
  // quiescence cannot fire between a step's read and its decision.
  const frame = (name, body) => {
    // A stale replay -- one whose invocation already suspended -- can wake
    // later if user code raced a step against an un-stepped await. It goes
    // quiet instead of executing an attempt beside the fresh replay.
    if (driver.finished) return __wfNever;
    const enclosing = __wfEnclosingStep();
    if (enclosing !== undefined) {
      const failure = __wfError(
        `step ${JSON.stringify(name)} cannot start inside the callback of ` +
          `step ${JSON.stringify(enclosing)}; a step callback must not use ` +
          "the step API",
      );
      failure.__wfPermanent = true;
      return Promise.reject(failure);
    }
    const count = (driver.counts.get(name) ?? 0) + 1;
    driver.counts.set(name, count);
    const ordinal = ++driver.ordinal;
    const key = driver.ledgerPrefix + `step.${count}.${name}`;
    // Step activity restarts the stall clock: a pending grace timer was
    // armed against a run() that looked stuck, and this call is progress.
    driver.clearStall();
    driver.running += 1;
    return new Promise((resolve, reject) => {
      (async () => {
        const meta = await storage.get("__wf.meta");
        if (
          meta === undefined || meta.generation !== driver.generation ||
          __wfTerminal(meta.status) || meta.status === "paused" ||
          meta.status === "waitingForPause"
        ) {
          return { pause: true };
        }
        return await body(key, count, ordinal);
      })().then(
        (result) => {
          driver.running -= 1;
          driver.clearStall();
          if (result.pause === true) {
            driver.pauseRequested = true;
            driver.check();
            return;
          }
          if (result.block !== undefined) {
            if (!driver.finished) {
              driver.blocked.push({ at: result.block, kind: result.kind });
            }
            driver.check();
            return;
          }
          driver.check();
          resolve(result.value);
        },
        (error) => {
          driver.running -= 1;
          driver.clearStall();
          driver.check();
          reject(error);
        },
      );
    });
  };
  const doStep = (name, configOrCallback, callbackOrRollback, maybeRollback) => {
    const hasConfig = typeof configOrCallback !== "function";
    let config = hasConfig ? (configOrCallback ?? {}) : {};
    const callback = hasConfig ? callbackOrRollback : configOrCallback;
    const rollback = hasConfig ? maybeRollback : callbackOrRollback;
    try {
      __wfStepName(name);
      config = __wfStepConfig(config, name);
    } catch (error) {
      return Promise.reject(error);
    }
    if (rollback !== undefined) {
      return Promise.reject(__wfError(
        "step rollbackOptions are not implemented in celld; remove the rollback handler",
      ));
    }
    if (config.sensitive !== undefined) {
      return Promise.reject(__wfError(
        "sensitive step output is not implemented in celld; remove `sensitive`",
      ));
    }
    if (typeof callback !== "function") {
      return Promise.reject(__wfError("step.do needs a callback function"));
    }
    return frame(name, async (key, count, ordinal) => {
      const record = __wfKindCheck(await storage.get(key), "do", name);
      if (record !== undefined && record.status === "completed") {
        return { value: record.value };
      }
      if (record !== undefined && record.status === "failed") {
        throw __wfReviveError(record.error);
      }
      // A pending retry whose backoff has not elapsed blocks without
      // executing; the deadline was persisted when the attempt failed, so a
      // replay cannot reset the backoff.
      if (record !== undefined && record.nextAt > Date.now()) {
        return { block: record.nextAt, kind: "retry" };
      }
      const attempt = (record === undefined ? 0 : record.attempt) + 1;
      const historyOrdinal = record?.ordinal ?? ordinal;
      const retries = config.retries ??
        { limit: 5, delay: 10000, backoff: "exponential" };
      const timeout = config.timeout ?? "10 minutes";
      const timeoutMs = __wfDuration(
        timeout,
        `the timeout of step ${JSON.stringify(name)}`,
      );
      // Upstream omits a dynamic delay from the step context. Copying the
      // config verbatim would expose the callback to itself as retry policy,
      // while callers expect only the serializable limit and backoff fields.
      const contextRetries = typeof retries.delay === "function"
        ? { limit: retries.limit, ...(retries.backoff === undefined
          ? {}
          : { backoff: retries.backoff }) }
        : retries;
      const context = {
        step: { name, count },
        attempt,
        config: { retries: contextRetries, timeout },
      };
      try {
        // Persist the history entry before the callback starts. A concurrent
        // selected restart can therefore name an in-flight occurrence, and
        // its new generation fences the callback's eventual old-ledger write.
        await storage.put(key, {
          kind: "do",
          status: "running",
          attempt: attempt - 1,
          ordinal: historyOrdinal,
        });
        const value = await __wfTimeout(
          __wfEnterStep(name, async () => callback(context)),
          timeoutMs,
          name,
          attempt,
        );
        if (value !== undefined) {
          __wfCheckValue(value, `the return value of step ${JSON.stringify(name)}`);
        }
        await storage.put(key, {
          kind: "do",
          status: "completed",
          value,
          ordinal: historyOrdinal,
        });
        return { value };
      } catch (error) {
        // NonRetryableError skips retries by contract; a value-cap or
        // serialization failure is marked permanent above because another
        // attempt returns the same value.
        const permanent = error instanceof NonRetryableError ||
          (error !== null && typeof error === "object" &&
            (error.name === "NonRetryableError" || error.__wfPermanent === true)) ||
          attempt > retries.limit;
        if (permanent) {
          await storage.put(key, {
            kind: "do",
            status: "failed",
            error: __wfErrorRecord(error),
            ordinal: historyOrdinal,
          });
          throw error;
        }
        // Upstream documents the backoff names, not the arithmetic; the
        // simplest reading is used and recorded in the design page. When
        // `retries` is given without `backoff`, celld uses constant -- the
        // documented exponential default is the whole-config-omitted case.
        const dynamic = typeof retries.delay === "function";
        const delay = dynamic
          ? await __wfEnterStep(name, () => retries.delay({ ctx: context, error }))
          : retries.delay;
        const base = __wfDuration(
          delay,
          `the retry delay of step ${JSON.stringify(name)}`,
        );
        // A delay callback replaces the fixed base duration, not the backoff
        // policy. Skipping this factor makes a dynamic exponential or linear
        // policy retry earlier than the same policy with a fixed base.
        const factor = retries.backoff === "exponential"
          ? 2 ** (attempt - 1)
          : retries.backoff === "linear"
          ? attempt
          : 1;
        const nextAt = Date.now() + base * factor;
        await storage.put(key, {
          kind: "do",
          status: "retrying",
          attempt,
          nextAt,
          ordinal: historyOrdinal,
        });
        return { block: nextAt, kind: "retry" };
      }
    });
  };
  const sleepUntilDeadline = (name, key, ordinal, deadline) => (async () => {
    const record = __wfKindCheck(await storage.get(key), "sleep", name);
    if (record !== undefined && record.status === "completed") {
      return { value: undefined };
    }
    const historyOrdinal = record?.ordinal ?? ordinal;
    let at = record === undefined ? undefined : record.deadline;
    if (at === undefined) {
      // The absolute deadline is computed once and persisted. Recomputing
      // from "now" on replay would extend the sleep by however long the
      // instance was down, so a crash could postpone a deadline forever.
      at = deadline();
      if (at - Date.now() > __WF_MAX_WAIT_MS) {
        throw __wfError(
          `sleep ${JSON.stringify(name)} ends ${at - Date.now()} ms from now, ` +
            "above the upstream limit of 365 days",
        );
      }
      await storage.put(key, {
        kind: "sleep",
        status: "sleeping",
        deadline: at,
        ordinal: historyOrdinal,
      });
    }
    if (at <= Date.now()) {
      await storage.put(key, {
        kind: "sleep",
        status: "completed",
        ordinal: historyOrdinal,
      });
      return { value: undefined };
    }
    return { block: at, kind: "sleep" };
  })();
  return {
    do: doStep,
    sleep: (name, duration) => {
      let durationMs;
      try {
        __wfStepName(name);
        durationMs = __wfSleepDuration(duration, name);
      } catch (error) {
        return Promise.reject(error);
      }
      return frame(name, (key, _count, ordinal) =>
        sleepUntilDeadline(
          name,
          key,
          ordinal,
          () => Date.now() + durationMs,
        ));
    },
    sleepUntil: (name, timestamp) => {
      let at;
      try {
        __wfStepName(name);
        at = __wfSleepUntil(timestamp, name);
      } catch (error) {
        return Promise.reject(error);
      }
      return frame(name, (key, _count, ordinal) =>
        sleepUntilDeadline(name, key, ordinal, () => {
          // A replay uses the persisted deadline after it has passed. Check
          // the moving future bound only while the deadline is first installed,
          // or every successful sleep would fail on the resume that completes it.
          if (at - Date.now() < 0) {
            throw __wfError(
              `sleepUntil ${JSON.stringify(name)} needs a future timestamp`,
            );
          }
          return at;
        }));
    },
    waitForEvent: (name, options) => {
      let checked;
      try {
        __wfStepName(name);
        checked = __wfWaitOptions(options, name);
      } catch (error) {
        return Promise.reject(error);
      }
      return frame(name, async (key, _count, ordinal) => {
        let record = __wfKindCheck(await storage.get(key), "event", name);
        if (record !== undefined && record.status === "completed") {
          return { value: record.value };
        }
        if (record !== undefined && record.status === "failed") {
          throw __wfReviveError(record.error);
        }
        if (record === undefined) {
          record = {
            kind: "event",
            status: "waiting",
            type: checked.type,
            deadline: Date.now() + checked.timeoutMs,
            ordinal,
          };
          await storage.put(key, record);
        }
        // The deadline is checked before the buffer: an event that arrived
        // after the persisted deadline must time the step out, not succeed
        // because the replay that noticed it ran late.
        if (record.deadline <= Date.now()) {
          const error = new Error(
            `waitForEvent ${JSON.stringify(name)} timed out waiting for an event ` +
              `of type ${JSON.stringify(record.type)}`,
          );
          await storage.put(key, {
            kind: "event",
            status: "failed",
            error: __wfErrorRecord(error),
            ordinal: record.ordinal,
          });
          throw error;
        }
        // Delivered events persist until a matching step consumes one, in
        // arrival order -- the zero-padded sequence key makes list order
        // arrival order -- so an event sent before the step is reached is
        // buffered, not lost.
        const consumed = storage.transactionSync(() => {
          const current = __wfKindCheck(storage.kv.get(key), "event", name);
          if (current !== undefined && current.status === "completed") {
            return { value: current.value };
          }
          if (current !== undefined && current.status === "failed") {
            throw __wfReviveError(current.error);
          }
          const events = storage.kv.list({
            prefix: __wfEventPrefix(driver.generation),
          });
          for (let index = 0; index < events.length; index++) {
            const { key: eventKey, value: event } = events[index];
            if (event.type !== current.type) continue;
            const value = {
              payload: event.payload,
              timestamp: new Date(event.timestampMs),
              type: event.type,
            };
            // The delete and completed ledger record are one SQLite commit.
            // A crash can therefore expose both or neither, so an
            // acknowledged event cannot disappear between them.
            storage.kv.delete(eventKey);
            /*__CELLD_TEST_WORKFLOW_EVENT_CONSUMED__*/
            storage.kv.put(key, {
              kind: "event",
              status: "completed",
              value,
              ordinal: current.ordinal,
            });
            return { value };
          }
        });
        if (consumed !== undefined) return consumed;
        return { block: record.deadline, kind: "event" };
      });
    },
  };
};

const __WorkflowCell = (() => {
  // Fields, not assignments: an assignment would run a setter a script put
  // on Object.prototype, with the instance's storage.
  class StorageTransaction {
    kv;
    #scope;
    constructor(storage) {
      this.kv = storage.kv;
      this.#scope = storage.scope;
    }
    setAlarm(t) {
      __alarm_set(this.#scope, t instanceof Date ? t.getTime() : Number(t));
    }
    deleteAlarm() {
      __alarm_delete(this.#scope);
    }
  }
  const transactionSync = (storage, callback) =>
    storage.transactionSync(() => callback(new StorageTransaction(storage)));
  const clearInstance = (transaction) => {
    const rows = transaction.kv.list({ prefix: "__wf." });
    for (let index = 0; index < rows.length; index++) {
      transaction.kv.delete(rows[index].key);
    }
    transaction.deleteAlarm();
  };
  const expireTerminal = (transaction, meta, now) => {
    if (!__wfTerminal(meta.status)) return false;
    if (meta.expiresMs === undefined) {
      meta.endedMs = now;
      meta.expiresMs = now + __wfRetentionMs(meta, meta.status);
      transaction.kv.put("__wf.meta", meta);
    }
    if (meta.expiresMs > now) return false;
    clearInstance(transaction);
    return true;
  };

  // The adapter stays in this closure because Workflow needs synchronous
  // alarm writes inside transactionSync(). The public async alarm API runs
  // after that commit, while a global helper would let application code
  // split metadata from its wake or invoke the raw operation after commit.
  // The engine's state is private: the workflow cell runs beside the
  // script's code, which must not reach its instance's storage.
  return class __WorkflowCell {
  #state;
  // The instance's storage through the harness's own methods
  // (`__ownStorage`).
  #storage;
  #wfDriving;
  #wfNudge;
  constructor(state) {
    this.#state = state;
    this.#storage = __ownStorage(state);
  }
  async __wfCreate(request) {
    // The binding validates first; the cell checks again, with its errors,
    // because this RPC owns the durable create: the workflow and instance
    // must be the ones this cell is, and the retention and location the
    // binding's normalized form.
    const {
      workflowName,
      instanceId,
      params,
      retention,
      locationHint,
      skipExisting,
    } = __wfCheckCreate(request, () => __objectState.id(this.#state).name);
    const storage = this.#storage;
    if (params !== undefined) __wfCheckValue(params, "the workflow params");
    const result = transactionSync(storage, (transaction) => {
      let meta = transaction.kv.get("__wf.meta");
      if (meta !== undefined && expireTerminal(transaction, meta, Date.now())) {
        meta = undefined;
      }
      if (meta !== undefined && skipExisting) return { id: instanceId, created: false };
      if (meta !== undefined) {
        throw __wfError(
          `instance ${JSON.stringify(instanceId)} already exists with status ` +
            JSON.stringify(meta.status),
        );
      }
      const generation = crypto.randomUUID();
      transaction.kv.put("__wf.meta", {
        workflowName,
        instanceId,
        params,
        retention,
        ...(locationHint === undefined ? {} : { locationHint }),
        generation,
        createdMs: Date.now(),
        status: "queued",
      });
      // The metadata and alarm are one SQLite commit. A committed creation
      // therefore always has the wake that can start or recover its drive.
      transaction.setAlarm(Date.now());
      /*__CELLD_TEST_WORKFLOW_META_CREATED__*/
      return { id: instanceId, created: true };
    });
    return result;
  }
  async __wfStatus() {
    const meta = transactionSync(this.#storage, (transaction) => {
      const current = transaction.kv.get("__wf.meta");
      if (current === undefined) return undefined;
      return expireTerminal(transaction, current, Date.now()) ? undefined : current;
    });
    // A cell exists on first address like any cell, so an absent ledger is
    // the only honest "no such instance" signal. Inventing an instance here
    // would turn every typo into an empty workflow.
    if (meta === undefined) throw __wfError("instance does not exist");
    const status = { status: meta.status, rollback: null };
    if (meta.error !== undefined) status.error = meta.error;
    if (meta.output !== undefined) status.output = meta.output;
    return status;
  }
  async __wfDelete() {
    const storage = this.#storage;
    const deleted = transactionSync(storage, (transaction) => {
      const meta = transaction.kv.get("__wf.meta");
      if (meta === undefined) return false;
      if (expireTerminal(transaction, meta, Date.now())) return false;
      clearInstance(transaction);
      return true;
    });
    // Throw after the transaction commits. An expiry discovered here must
    // keep its cleanup even though delete() reports that the instance is gone.
    if (!deleted) throw __wfError("instance does not exist");
    // A callback can still be awaiting application I/O when deletion lands.
    // Reset the object after the deletion commit so that callback cannot
    // recreate an old-generation ledger entry after delete() reports success.
    __objectState.abort(this.#state, new Error("WORKFLOW_INSTANCE_DELETED"));
  }
  async __wfPause() {
    const storage = this.#storage;
    transactionSync(storage, (transaction) => {
      const meta = transaction.kv.get("__wf.meta");
      if (meta === undefined) throw __wfError("instance does not exist");
      if (__wfTerminal(meta.status) || meta.status === "paused" ||
          meta.status === "waitingForPause") return;
      if (meta.status === "running") {
        meta.status = "waitingForPause";
        // A drive lost after this commit must re-enter and finish the pause.
        transaction.setAlarm(Date.now());
      } else {
        meta.status = "paused";
        meta.pausedMs = Date.now();
        transaction.deleteAlarm();
      }
      transaction.kv.put("__wf.meta", meta);
    });
  }
  async __wfResume() {
    const storage = this.#storage;
    transactionSync(storage, (transaction) => {
      const meta = transaction.kv.get("__wf.meta");
      if (meta === undefined) throw __wfError("instance does not exist");
      if (meta.status === "waitingForPause") {
        meta.status = "running";
        transaction.kv.put("__wf.meta", meta);
        transaction.setAlarm(Date.now());
        return;
      }
      if (meta.status !== "paused") {
        throw __wfError(
          `cannot resume an instance with status ${JSON.stringify(meta.status)}`,
        );
      }
      const offset = Math.max(0, Date.now() - (meta.pausedMs ?? Date.now()));
      const rows = transaction.kv.list({
        prefix: __wfLedgerPrefix(meta.generation) + "step.",
      });
      for (let index = 0; index < rows.length; index++) {
        const { key, value: record } = rows[index];
        if (record.status === "retrying") record.nextAt += offset;
        if (record.status === "sleeping" || record.status === "waiting") {
          record.deadline += offset;
        }
        transaction.kv.put(key, record);
      }
      delete meta.pausedMs;
      meta.status = "queued";
      transaction.kv.put("__wf.meta", meta);
      transaction.setAlarm(Date.now());
    });
  }
  async __wfRestart(options) {
    const checked = __wfRestartOptions(options);
    const storage = this.#storage;
    transactionSync(storage, (transaction) => {
      const meta = transaction.kv.get("__wf.meta");
      if (meta === undefined) throw __wfError("instance does not exist");
      const oldPrefix = __wfLedgerPrefix(meta.generation);
      let targetOrdinal;
      if (checked.from !== undefined) {
        const expectedKind = checked.from.type === "waitForEvent"
          ? "event"
          : checked.from.type;
        let occurrence = 0;
        const rows = transaction.kv.list({ prefix: oldPrefix + "step." });
        const history = [];
        for (let index = 0; index < rows.length; index++) {
          if (Number.isInteger(rows[index].value.ordinal)) {
            history[history.length] = rows[index];
          }
        }
        __ReflectApply(__ArraySort, history,
          [(left, right) => left.value.ordinal - right.value.ordinal]);
        // The ledger key is `<prefix>step.<per-name-count>.<name>`. Derive
        // the name from it because a record stores replay state, not identity.
        for (let index = 0; index < history.length; index++) {
          const { key, value: record } = history[index];
          const marker = oldPrefix + "step.";
          const suffix = key.slice(marker.length);
          const dot = suffix.indexOf(".");
          const name = dot < 0 ? "" : suffix.slice(dot + 1);
          if (record.kind !== expectedKind || name !== checked.from.name) continue;
          occurrence += 1;
          if (occurrence === checked.from.count) {
            targetOrdinal = record.ordinal;
            break;
          }
        }
        if (targetOrdinal === undefined) {
          throw __wfError(
            `restart() could not find ${checked.from.type} step ` +
              `${JSON.stringify(checked.from.name)} occurrence ${checked.from.count}`,
          );
        }
      }
      const generation = crypto.randomUUID();
      const newPrefix = __wfLedgerPrefix(generation);
      if (targetOrdinal !== undefined) {
        const rows = transaction.kv.list({ prefix: oldPrefix + "step." });
        for (let index = 0; index < rows.length; index++) {
          const { key, value: record } = rows[index];
          if (Number.isInteger(record.ordinal) && record.ordinal < targetOrdinal) {
            transaction.kv.put(newPrefix + key.slice(oldPrefix.length), record);
          }
        }
      }
      const stale = transaction.kv.list({ prefix: oldPrefix });
      for (let index = 0; index < stale.length; index++) {
        transaction.kv.delete(stale[index].key);
      }
      meta.generation = generation;
      meta.status = "queued";
      delete meta.pausedMs;
      delete meta.output;
      delete meta.error;
      transaction.kv.put("__wf.meta", meta);
      transaction.setAlarm(Date.now());
    });
  }
  async __wfTerminate() {
    const storage = this.#storage;
    transactionSync(storage, (transaction) => {
      const meta = transaction.kv.get("__wf.meta");
      if (meta === undefined) throw __wfError("instance does not exist");
      if (__wfTerminal(meta.status)) {
        throw __wfError(
          `cannot terminate an instance with status ${JSON.stringify(meta.status)}`,
        );
      }
      meta.status = "terminated";
      __wfFinishRetention(meta, transaction);
      transaction.kv.put("__wf.meta", meta);
      /*__CELLD_TEST_WORKFLOW_TERMINAL_ALARM_SET__*/
    });
  }
  async __wfSendEvent(options) {
    const storage = this.#storage;
    // The binding validates first to avoid an unnecessary cell call. Repeat
    // the check here because this RPC owns the durable event invariant: no
    // current or future internal caller can bypass validation before storage.
    const { type, payload } = __wfEventOptions(options);
    transactionSync(storage, (transaction) => {
      const meta = transaction.kv.get("__wf.meta");
      if (meta === undefined) throw __wfError("instance does not exist");
      if (__wfTerminal(meta.status)) {
        throw __wfError(
          `cannot send an event to an instance with status ${JSON.stringify(meta.status)}`,
        );
      }
      const sequenceKey = __wfLedgerPrefix(meta.generation) + "eventSeq";
      const sequence = transaction.kv.get(sequenceKey) ?? 0;
      transaction.kv.put(sequenceKey, sequence + 1);
      transaction.kv.put(__wfEventKey(meta.generation, sequence), {
        type,
        payload,
        timestampMs: Date.now(),
      });
      // Allocation, the event body, and the nudge are one commit. Parallel
      // writers cannot reuse a sequence and a crash cannot expose a partial
      // acknowledged send.
      if (meta.status !== "paused" && meta.status !== "waitingForPause") {
        transaction.setAlarm(Date.now());
      }
    });
  }
  async alarm() {
    const storage = this.#storage;
    // One drive at a time. A sendEvent nudge (setAlarm(now)) landing
    // mid-fire replaces the firing alarm in the core, and the replacement
    // can dispatch a second alarm() into this isolate while the first drive
    // still awaits user code. Two concurrent replays would both see the
    // same incomplete steps and double-execute their callbacks. The guard
    // is isolate-local and that is sufficient: every drive for a cell runs
    // in its owner's isolate, and a takeover starts a fresh isolate with no
    // drive in flight. The nudge is not lost -- the in-flight drive folds
    // `#wfNudge` into the minimum it re-arms, and if it suspended before
    // seeing the flag, the re-arm below starts a fresh drive immediately.
    // A failed drive is not re-raised here: the engine already retries the
    // alarm that fired it.
    if (this.#wfDriving !== undefined) {
      this.#wfNudge = Date.now();
      await this.#wfDriving.catch(() => {});
      if (this.#wfNudge !== undefined) {
        this.#wfNudge = undefined;
        const meta = await storage.get("__wf.meta");
        if (
          meta !== undefined && !__wfTerminal(meta.status) &&
          meta.status !== "paused" && meta.status !== "waitingForPause"
        ) {
          await storage.setAlarm(Date.now());
        }
      }
      return;
    }
    const meta = await storage.get("__wf.meta");
    // A terminal instance's pending alarm can still fire. It owns retention:
    // remove expired state, or restore the expiry wake after a stale nudge.
    if (meta === undefined) {
      await storage.deleteAlarm();
      return;
    }
    if (__wfTerminal(meta.status)) {
      transactionSync(storage, (transaction) => {
        const current = transaction.kv.get("__wf.meta");
        if (current === undefined) {
          transaction.deleteAlarm();
          return;
        }
        if (!expireTerminal(transaction, current, Date.now())) {
          transaction.setAlarm(current.expiresMs);
        }
      });
      return;
    }
    if (meta.status === "paused") {
      await storage.deleteAlarm();
      return;
    }
    if (meta.status === "waitingForPause") {
      transactionSync(storage, (transaction) => {
        const current = transaction.kv.get("__wf.meta");
        if (current === undefined || current.generation !== meta.generation ||
            current.status !== "waitingForPause") return;
        current.status = "paused";
        current.pausedMs = Date.now();
        transaction.kv.put("__wf.meta", current);
        transaction.deleteAlarm();
      });
      return;
    }
    // The fired alarm stays armed while the drive runs. The engine consumes
    // it only when this handler returns cleanly, and retries it when the
    // handler fails -- that retry is the crash safety net. Deleting it here
    // would commit the deletion durably mid-drive (durability is per SQLite
    // commit, and replication ships frames per commit), so a SIGKILL before
    // the suspend-time re-arm would strand a "running" instance with no
    // alarm and no wake entry. The suspend path re-arms explicitly, and a
    // terminal drive deletes.
    const driving = this.#drive(meta);
    this.#wfDriving = driving;
    try {
      await driving;
    } finally {
      this.#wfDriving = undefined;
    }
  }
  async #drive(meta) {
    const storage = this.#storage;
    // The drive owns `status`, `output`, and `error`; every other piece of
    // instance state belongs to the RPCs (sendEvent's sequence lives in its
    // own key for the same reason). The gate is open at every await, so a
    // terminate can land mid-drive: re-reading before each write, and
    // writing nothing once the status is terminal, is what makes "terminate
    // wins the race" true rather than asserted. Writing back the meta this
    // drive entered with would resurrect a terminated instance as "waiting"
    // and re-arm the alarm its terminate deleted.
    const settle = (mutate) => transactionSync(storage, (transaction) => {
      const current = transaction.kv.get("__wf.meta");
      if (current === undefined || __wfTerminal(current.status) ||
          current.generation !== meta.generation) return false;
      mutate(current, transaction);
      transaction.kv.put("__wf.meta", current);
      return true;
    });
    const className = __cell.workflows[meta.workflowName];
    const cls = className === undefined ? undefined : __cf.exports[className];
    if (typeof cls !== "function" ||
        typeof (cls.prototype && cls.prototype.run) !== "function") {
      // Deploy cannot see inside the bundle, so a missing export fails
      // here, loudly, with the class and the config key named.
      settle((current, transaction) => {
        current.status = "errored";
        current.error = {
          name: "Error",
          message: className === undefined
            ? `workflow ${JSON.stringify(meta.workflowName)} is not declared ` +
              "in this deployment's `workflows`"
            : `workflow class ${JSON.stringify(className)} is not a module ` +
              "export with a run() method; export it and extend " +
              "WorkflowEntrypoint",
        };
        __wfFinishRetention(current, transaction);
        /*__CELLD_TEST_WORKFLOW_TERMINAL_ALARM_SET__*/
      });
      return;
    }
    const driver = {
      __proto__: null,
      storage: undefined,
      storageFailure: undefined,
      generation: meta.generation,
      ledgerPrefix: __wfLedgerPrefix(meta.generation),
      counts: new Map(),
      ordinal: 0,
      running: 0,
      blocked: [],
      pauseRequested: false,
      finished: false,
      checkQueued: false,
      stallTimer: undefined,
      clearStall() {
        if (this.stallTimer !== undefined) {
          clearTimeout(this.stallTimer);
          this.stallTimer = undefined;
        }
      },
    };
    driver.storage = __wfTrackStorageFailures(storage, driver);
    const outcome = new Promise((resolve) => {
      driver.finish = (result) => {
        if (driver.finished) return;
        driver.finished = true;
        driver.clearStall();
        resolve(result);
      };
    });
    // Quiescence: when a step is blocked, no step callback is executing,
    // and a macrotask has passed, nothing can progress, so the invocation
    // suspends. The macrotask lets every microtask chain a completed step
    // unblocked drain first; checking on the spot would suspend an instance
    // whose next step is one `await` away from starting.
    driver.check = () => {
      if (driver.checkQueued || driver.finished) return;
      driver.checkQueued = true;
      setTimeout(() => {
        driver.checkQueued = false;
        if (driver.finished || driver.running !== 0) return;
        if (driver.pauseRequested) {
          driver.finish({ kind: "pause" });
          return;
        }
        if (driver.blocked.length > 0) {
          driver.finish({ kind: "suspend" });
          return;
        }
        // No step runs, none is blocked, and run() has not settled: it
        // awaits something that is not a step. Upstream permits that -- an
        // un-stepped `await fetch()` between steps is legal, merely
        // non-durable -- so this is not yet an error; but a promise that
        // never settles would wedge the alarm handler in silence, with the
        // instance "running" forever. A grace timer splits the two: if the
        // same nothing-can-progress state still holds when it fires, the
        // instance fails loudly. The timer is a plain in-isolate timeout,
        // not a durable alarm, on purpose: an eviction or a restart replays
        // run() from the top anyway, so losing the timer loses nothing --
        // the replay re-enters the same stall and re-arms its own grace.
        if (driver.stallTimer !== undefined) return;
        driver.stallTimer = setTimeout(() => {
          driver.stallTimer = undefined;
          if (driver.finished || driver.running !== 0 || driver.blocked.length > 0) {
            return;
          }
          driver.finish({
            kind: "error",
            error: __wfError(
              "run() has been awaiting something that is not a step for " +
                (__WF_STALL_GRACE_MS / 1000) + " seconds while no step is " +
                "running or blocked; a replay cannot resume this wait, so " +
                "wrap long async work in step.do",
            ),
          });
        }, __WF_STALL_GRACE_MS);
      }, 0);
    };
    if (
      meta.status !== "running" &&
      !(await settle((current) => {
        current.status = "running";
      }))
    ) {
      return;
    }
    const step = __wfMakeStep(driver);
    const event = {
      payload: meta.params,
      timestamp: new Date(meta.createdMs),
      instanceId: meta.instanceId,
      workflowName: meta.workflowName,
    };
    // ExecutionContext-shaped, as the WorkflowEntrypoint constructor
    // documents upstream.
    const ctx = __withCtxRestore({
      waitUntil: __registerWaitUntil,
      passThroughOnException() {},
    });
    // Its run() executes in an ExecutionContext on workerd, which has
    // `tracing`.
    __celld.__defineContextTracing(ctx);
    (async () => new cls(ctx, __cell.env).run(event, step))().then(
      (value) => driver.finish({ kind: "complete", value }),
      (error) => driver.finish({ kind: "error", error }),
    );
    /*__CELLD_TEST_WORKFLOW_AFTER_RUN_STARTED__*/
    let result = await outcome;
    // The workflow can catch a rejected step promise, but it cannot turn an
    // engine storage failure into a successful run. Preserve the alarm so
    // the runtime retries over the last committed ledger prefix.
    if (driver.storageFailure !== undefined) {
      throw driver.storageFailure;
    }
    const currentMeta = await storage.get("__wf.meta");
    if (
      result.kind === "pause" ||
      (currentMeta !== undefined &&
        currentMeta.generation === meta.generation &&
        currentMeta.status === "waitingForPause")
    ) {
      /*__CELLD_TEST_WORKFLOW_BEFORE_PAUSE_SETTLE__*/
      settle((current, transaction) => {
        // A resume can cancel waitingForPause after this drive selected its
        // pause result. Preserve that newer running state and its alarm, or
        // this stale settlement strands an acknowledged resume as paused.
        if (current.status !== "waitingForPause") return;
        current.status = "paused";
        current.pausedMs = Date.now();
        transaction.deleteAlarm();
      });
      return;
    }
    if (result.kind === "suspend") {
      let at = Math.min(...driver.blocked.map((entry) => entry.at));
      // A nudge that landed mid-drive must not wait out the pending
      // deadline. It is visible in one of two places: getAlarm(), when the
      // nudge re-armed and no second alarm dispatched yet, or `#wfNudge`,
      // when a second alarm() already entered and parked on the drive
      // guard -- its dispatch consumed the armed alarm, so getAlarm()
      // alone would miss it.
      const nudge = await storage.getAlarm();
      if (nudge !== null) at = Math.min(at, nudge);
      if (this.#wfNudge !== undefined) {
        at = Math.min(at, this.#wfNudge);
        this.#wfNudge = undefined;
      }
      settle((current, transaction) => {
        current.status = "waiting";
        transaction.setAlarm(at);
      });
      // The explicit re-arm replaces the alarm that fired this drive.
      // Durability is per SQLite commit, not per turn: a crash can persist
      // any prefix of this invocation's ledger writes, and the unconsumed
      // fired alarm is what re-drives the replay over whatever prefix
      // survived. A terminated instance re-arms nothing; its leftover
      // alarm fires once, sees the terminal status, and retires itself.
      return;
    }
    if (result.kind === "complete") {
      try {
        if (result.value !== undefined) {
          __wfCheckValue(result.value, "the run() return value");
        }
      } catch (error) {
        result = { kind: "error", error };
      }
      if (result.kind === "complete") {
        // Keep settlement outside the value-validation catch. A storage
        // failure must escape the alarm handler so the engine retries the
        // still-armed drive; converting it to a user error would consume the
        // alarm and make a transient commit failure terminal.
        settle((current, transaction) => {
          current.status = "complete";
          if (result.value !== undefined) current.output = result.value;
          // The terminal commit installs the expiry wake with the retained
          // state, so a crash can expose neither without the other.
          __wfFinishRetention(current, transaction);
          /*__CELLD_TEST_WORKFLOW_TERMINAL_ALARM_SET__*/
        });
        return;
      }
    }
    settle((current, transaction) => {
      current.status = "errored";
      current.error = __wfErrorRecord(result.error);
      __wfFinishRetention(current, transaction);
      /*__CELLD_TEST_WORKFLOW_TERMINAL_ALARM_SET__*/
    });
  }
  };
})();
__runtimeClass("__Workflow", __WorkflowCell, [
  "__wfCreate", "__wfStatus", "__wfTerminate", "__wfSendEvent", "__wfPause",
  "__wfResume", "__wfRestart", "__wfDelete",
]);

class NonRetryableError extends Error {
  constructor(message, name = "NonRetryableError") {
    super(message);
    this.name = name;
  }
}
// Backing object for the `cloudflare:workflows` builtin module.
__celld.__cfWorkflows = { NonRetryableError };
// `celld:python`, imported only by the Python Worker bundle.
__celld.__pythonHost = {
  condemnIsolate: (reason) => __isolate_condemn(String(reason)),
};

const __wfValidInstanceId = (id) =>
  typeof id === "string" && id.length >= 1 && id.length <= 100 &&
  __WF_NAME_RE.test(id);
const __wfCreateOptions = (options, what, validateParams = true) => {
  if (!__wfOwnObject(options)) {
    throw __wfError(`${what} needs an object`);
  }
  const retention = __wfRetentionOptions(options.retention, what);
  const locationHint = __wfLocationHint(options.locationHint, what);
  const id = options.id === undefined ? crypto.randomUUID() : options.id;
  if (!__wfValidInstanceId(id)) {
    throw __wfError(
      `invalid instance id ${JSON.stringify(id)}: use letters, digits, ` +
        "\"-\" and \"_\" (not starting with \"-\"), at most 100 characters",
    );
  }
  if (validateParams && options.params !== undefined) {
    // The cell repeats this serialization check because it owns the durable
    // create invariant. A single create rejects before it addresses the cell.
    __wfCheckValue(options.params, "the workflow params");
  }
  return { id, params: options.params, retention, locationHint };
};

// The binding and its instances keep the workflow name, the instance id and
// the cell private, and only the harness constructs them ("Illegal
// constructor"): a script reaches its workflow cells through these methods,
// which validate what they send. workerd's are a JavaScript wrapper with a
// public `binding` (`env/d1-private-state`, xfail).
const __kWorkflow = Symbol("Workflow");
let __wfInstanceCall;
// Named so SDKs that sniff a binding by `constructor.name` recognise it.
class WorkflowInstance {
  #workflowName;
  #id;
  constructor(brand, workflowName, id) {
    if (brand !== __kWorkflow) throw new TypeError("Illegal constructor");
    this.#workflowName = workflowName;
    this.#id = id;
    // workerd's own property; the cell is named by the private copy.
    this.id = id;
  }
  // One call to the instance's cell, resolved per call rather than cached: a
  // cell can move between calls. The reserved class is script-scoped
  // (`deploy::workflow_class`), because a workflow instance is: two co-hosted
  // scripts must not share one entry in the deployment's flat class registry.
  // `__cell.script` is injected before any binding runs, so this resolves at
  // call time.
  #call(method, args = []) {
    return __cellRpc("__Workflow." + __cell.script,
      this.#workflowName + "/" + this.#id, method, args);
  }
  static {
    __wfInstanceCall = (instance, method, args) => instance.#call(method, args);
  }
  async status() {
    return await this.#call("__wfStatus");
  }
  async terminate(options) {
    if (options && options.rollback) {
      throw __wfError(
        "terminate({rollback: true}) is not implemented in celld; step " +
          "rollbackOptions are not implemented, so no handler could run",
      );
    }
    await this.#call("__wfTerminate");
  }
  async sendEvent(options) {
    await this.#call("__wfSendEvent", [__wfEventOptions(options)]);
  }
  async pause() {
    await this.#call("__wfPause");
  }
  async resume() {
    await this.#call("__wfResume");
  }
  async restart(options) {
    await this.#call("__wfRestart", [__wfRestartOptions(options)]);
  }
  async delete() {
    try {
      await this.#call("__wfDelete");
    } catch (error) {
      // The deletion commit resets an active Workflow cell so an in-flight
      // callback cannot put old ledger state back. That reset rejects this
      // RPC with its private completion marker; it is the successful path.
      if (!String(error && error.message || error).includes("WORKFLOW_INSTANCE_DELETED")) {
        throw error;
      }
    }
  }
}

class Workflow {
  #workflowName;
  constructor(brand, workflowName) {
    if (brand !== __kWorkflow) throw new TypeError("Illegal constructor");
    this.#workflowName = workflowName;
  }
  async #create(options, skipExisting) {
    const { id, params, retention, locationHint } = options;
    const instance = new WorkflowInstance(__kWorkflow, this.#workflowName, id);
    const result = await __wfInstanceCall(instance, "__wfCreate", [{
      workflowName: this.#workflowName,
      instanceId: id,
      params,
      retention,
      locationHint,
      skipExisting,
    }]);
    return result.created ? instance : undefined;
  }
  async create(options = {}) {
    return await this.#create(__wfCreateOptions(options, "create()"), false);
  }
  async createBatch(batch) {
    if (!Array.isArray(batch)) {
      throw __wfError("createBatch() needs an array of create options");
    }
    if (batch.length > 100) {
      throw __wfError(
        `createBatch() accepts at most 100 instances, got ${batch.length}`,
      );
    }
    if (batch.length === 0) {
      throw __wfError("createBatch() needs at least one instance");
    }
    // Cloudflare rejects a structural error in any item before it creates the
    // first instance, but it filters a params clone failure per item. Keep
    // these two gates separate so a bad ID stays atomic while a clone failure
    // does not suppress the valid items around it.
    const optionsList = batch.map((options, index) =>
      __wfCreateOptions(options, `createBatch() item ${index}`, false));
    const creatable = [];
    for (const options of optionsList) {
      let encoded;
      try {
        if (options.params !== undefined) {
          encoded = __wfEncodeValue(options.params, "the workflow params");
        }
      } catch {
        continue;
      }
      if (encoded !== undefined) {
        __wfCheckEncodedValue(encoded, "the workflow params");
      }
      creatable.push(options);
    }
    const created = [];
    for (const options of creatable) {
      const instance = await this.#create(options, true);
      if (instance !== undefined) created.push(instance);
    }
    return created;
  }
  async get(id) {
    if (!__wfValidInstanceId(id)) {
      throw __wfError(`invalid instance id ${JSON.stringify(id)}`);
    }
    const instance = new WorkflowInstance(__kWorkflow, this.#workflowName, id);
    // The cell exists on first address like any cell, but get() must not
    // mint an instance for a typo: an id with no ledger rejects here.
    await __wfInstanceCall(instance, "__wfStatus", []);
    return instance;
  }
  async deleteBatch(instanceIds) {
    if (!Array.isArray(instanceIds)) {
      throw __wfError("deleteBatch() needs an array of instance ids");
    }
    if (instanceIds.length < 1 || instanceIds.length > 100) {
      throw __wfError(
        `deleteBatch() accepts 1 to 100 instance ids, got ${instanceIds.length}`,
      );
    }
    for (const id of instanceIds) {
      if (!__wfValidInstanceId(id)) {
        throw __wfError(`invalid instance id ${JSON.stringify(id)}`);
      }
    }
    const uniqueIds = [...new Set(instanceIds)];
    const settled = await Promise.allSettled(uniqueIds.map(async (id) => {
      const instance = new WorkflowInstance(__kWorkflow, this.#workflowName, id);
      await instance.delete();
    }));
    const results = new Map(uniqueIds.map((id, index) => [id, settled[index]]));
    const output = { deleted: [], errors: [] };
    for (const id of instanceIds) {
      const result = results.get(id);
      if (result.status === "fulfilled") {
        output.deleted.push({ id });
        continue;
      }
      const notFound = String(result.reason && result.reason.message || result.reason)
        .includes("instance does not exist");
      output.errors.push({
        id,
        code: notFound ? 10400 : 10001,
        message: notFound
          ? "workflows.api.error.instance.not_found"
          : "workflows.api.error.internal_server",
      });
    }
    return output;
  }
}

const __makeWorkflow = __celld.__makeWorkflow =
  (workflowName) => new Workflow(__kWorkflow, workflowName);
// A `cloudflare:workers` export celld does not implement yet. It throws on
// first use and names itself, rather than reading as `undefined` and failing
// far from the cause. A function stub throws when called or constructed (and
// so when a subclass is constructed). An object stub throws when one of its
// API names is read, written, defined, deleted or tested with `in`. It acts as
// an empty plain object for the names generic code probes: symbols, `then`,
// `toJSON` and the Object.prototype members. So `await`, a return from an
// async function, `JSON.stringify` and console logging don't trip it.
const __cfUnimplementedError = (name) =>
  new Error(`cloudflare:workers export '${name}' is not implemented in celld`);
const __cfUnimplementedFunction = (name) => {
  const stub = function () { throw __cfUnimplementedError(name); };
  Object.defineProperty(stub, "name", { value: name });
  return stub;
};
const __cfInertKey = (key) =>
  typeof key !== "string" || key === "then" || key === "toJSON" ||
  key in Object.prototype;
const __cfUnimplementedObject = (name) => {
  const fail = () => { throw __cfUnimplementedError(name); };
  return new Proxy({}, {
    get(target, key) {
      if (__cfInertKey(key)) return Reflect.get(target, key);
      fail();
    },
    has(target, key) {
      if (__cfInertKey(key)) return Reflect.has(target, key);
      fail();
    },
    set: fail,
    defineProperty: fail,
    deleteProperty: fail,
  });
};
// `cloudflare:workers` module surface: exactly the names in modules.rs
// CLOUDFLARE_WORKERS_EXPORTS, with `tracing` added by tracing.js, which runs
// after the harness. The DO base class sets ctx/env the way
// `class X extends DurableObject` expects; env aliases the cell env.
const __cf = __celld.__cf = {
  DurableObject: class DurableObject {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  },
  // The enumerable function-valued brand makes V8's structured clone
  // fail on every RpcTarget instance, forcing it off the silent
  // plain-clone path and into the stub lift (Workerd rejects these
  // from plain serialization outright).
  RpcTarget: class RpcTarget {
    // workerd's JSG brand: `Object.create(RpcTarget.prototype)` is no
    // RpcTarget (`__hostKind`).
    #brand;
    static {
      __isRpcTarget = (value) =>
        typeof value === "object" && value !== null && #brand in value;
    }
    constructor() {
      Object.defineProperty(this, "__celldRpcTarget", {
        value: __rpcNoClone, enumerable: true,
      });
    }
  },
  // Named entrypoint for `[[services]]` with `entrypoint = "Name"`.
  WorkerEntrypoint: class WorkerEntrypoint {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  },
  // Base class for `workflows` classes. The reserved workflow cell
  // instantiates a subclass on every replay with an ExecutionContext-shaped
  // ctx -- never the cell's own DurableObjectState, which would hand user
  // code the ledger that replays it.
  WorkflowEntrypoint: class WorkflowEntrypoint {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  },
  // `new RpcStub(target)` wraps any local object or function in a
  // loopback stub; the constructor returns the proxy, so instanceof
  // works through __makeStub's getPrototypeOf trap.
  RpcStub: class RpcStub {
    get [Symbol.toStringTag]() { return "JsRpcStub"; }
    constructor(target) {
      if (target === null ||
          (typeof target !== "object" && typeof target !== "function"))
        throw new TypeError(
          "RpcStub requires an object or function.");
      return __makeStub(
        __newEntry(target), typeof target === "function");
    }
  },
  RpcPromise: class RpcPromise extends Promise {
    [Symbol.dispose]() { __rpcPromiseSession(this).dispose(); }
    get [Symbol.toStringTag]() { return "JsRpcPromise"; }
  },
  RpcProperty: class RpcProperty {
    get [Symbol.toStringTag]() { return "JsRpcProperty"; }
  },
  ServiceStub: class ServiceStub {},
  // `import { waitUntil } from "cloudflare:workers"`: register into
  // the current event or extend its active background work. Outside either
  // lifetime this is Workerd's global-scope error.
  waitUntil(promise) {
    if (!__wait_until_active())
      throw new Error(
        "Disallowed operation called within global scope.");
    __registerWaitUntil(promise);
  },
  exports: {},
  get env() { return __cell.env; },
  // The key of a `[restore]()` method. Like workerd's (an API symbol,
  // workers-module.c++ getRestoreSymbol) it is described as
  // "cloudflare:workers:restore" and is absent from the Symbol.for registry.
  restore: Symbol("cloudflare:workers:restore"),
  abortIsolate: __cfUnimplementedFunction("abortIsolate"),
  cache: __cfUnimplementedObject("cache"),
  withEnv: __cfUnimplementedFunction("withEnv"),
  withEnvAndExports: __cfUnimplementedFunction("withEnvAndExports"),
  withExports: __cfUnimplementedFunction("withExports"),
};
// `import { env, exports } from "cloudflare:workers"`. Under
// disallow_importable_env workerd has no Worker env or exports to give them
// (modules.c++ EnvModule::getCurrentEnv and getCurrentExports), so its
// proxies (cloudflare/workers.ts) read every name as undefined, list none,
// and ignore writes to `env`.
const __cfNoEnv = new Proxy({}, {
  get: () => undefined,
  set: () => true,
  has: () => false,
  ownKeys: () => [],
  deleteProperty: () => true,
  defineProperty: () => true,
  getOwnPropertyDescriptor: () => undefined,
});
const __cfNoExports = new Proxy({}, {
  get: () => undefined,
  has: () => false,
  ownKeys: () => [],
  getOwnPropertyDescriptor: () => undefined,
});
__celld.__cfImportable = (name) => {
  if (!__cell.compat.disallowImportableEnv) return __cf[name];
  return name === "env" ? __cfNoEnv : __cfNoExports;
};
// workerd adds ctx.restore() to ExecutionContext and DurableObjectState
// under allow_irrevocable_stub_storage. celld can't restore yet, so the
// method rejects: a Worker that relies on it fails at first use. The method
// is promise-returning on workerd, hence a rejection, not a throw.
function __ctxRestore() {
  return Promise.reject(new Error("ctx.restore() is not implemented in celld"));
}
const __withCtxRestore = (ctx) => {
  if (__cell.compat.allowIrrevocableStubStorage) {
    __ObjectDefineProperty(ctx, "restore", {
      value: __ctxRestore, writable: true, configurable: true,
    });
  }
  return ctx;
};
// Proxy standing in for unsupported node:*/cloudflare:* builtins. Property
// walks stay inert -- real bundles reference these at module scope, and
// evaluation must not crash on a builtin the fetch path never exercises --
// but a call or construct throws: the compat contract is "reject at first
// use", and the old silent pass-through turned a missing builtin into a
// wrong result far from the cause. Memoized by dotted path so repeated
// reads keep identity (`mod.foo === mod.foo`).
const __stubCache = new Map();
const __nodeStubFor = __celld.__nodeStubFor = (path) => {
  let stub = __stubCache.get(path);
  if (stub) return stub;
  stub = new Proxy(function () {}, {
    get: (_t, p) => {
      // Never masquerade as a thenable. `await` probes `.then`; returning
      // a callable here creates a promise that can never settle.
      if (p === "then") return undefined;
      // coerce cleanly in string/number contexts so evaluation never throws
      if (p === Symbol.toPrimitive || p === "toString" || p === "valueOf")
        return () => "";
      if (p === Symbol.toStringTag) return "NodeStub";
      if (p === Symbol.iterator) return function* () {};
      if (typeof p !== "string") return undefined;
      return __nodeStubFor(path + "." + p);
    },
    apply() { throw new Error(path + " is not implemented in celld"); },
    construct() { throw new Error(path + " is not implemented in celld"); },
  });
  __stubCache.set(path, stub);
  return stub;
};
__celld.__nodeStub = __nodeStubFor("node builtin");
if (!globalThis.Event) {
  globalThis.Event = class Event {
    // Private fields: stored in the object itself, so an Event costs no
    // side allocation and no defineProperty call at construction. The
    // public members are accessors because the DOM standard makes them
    // read-only; EventTarget drives them through _begin/_end.
    #type; #bubbles; #cancelable; #composed;
    #defaultPrevented = false;
    #eventPhase = 0;
    #target; #currentTarget; #path;
    #stop = false; #stopImmediate = false; #dispatching = false;
    // Workerd: events the runtime delivers are trusted; events a
    // script constructs and dispatches itself are not.
    #trusted = false;
    constructor(type, init = {}) {
      if (arguments.length === 0)
        throw new TypeError(
          "Failed to construct 'Event': 1 argument required, but only " +
          "0 present.");
      if (init !== undefined && init !== null &&
          typeof init !== "object")
        throw new TypeError(
          "Failed to construct 'Event': The provided value is not of " +
          "type 'EventInit'.");
      const options = init || {};
      // Template interpolation, not String(): it must throw for a
      // Symbol, which String() would happily format.
      this.#type = `${type}`;
      this.#bubbles = !!options.bubbles;
      this.#cancelable = !!options.cancelable;
      this.#composed = !!options.composed;
    }
    get type() { return this.#type; }
    get bubbles() { return this.#bubbles; }
    get cancelable() { return this.#cancelable; }
    get composed() { return this.#composed; }
    get defaultPrevented() { return this.#defaultPrevented; }
    get eventPhase() { return this.#eventPhase; }
    get target() { return this.#target; }
    get currentTarget() { return this.#currentTarget; }
    get isTrusted() { return this.#trusted; }
    get timeStamp() { return 0; }
    get returnValue() { return !this.#defaultPrevented; }
    // The one writable member, per the DOM standard.
    get cancelBubble() { return this.#stop; }
    set cancelBubble(value) { if (value) this.#stop = true; }
    composedPath() { return this.#path ? this.#path.slice() : []; }
    preventDefault() {
      if (this.#cancelable) this.#defaultPrevented = true;
    }
    stopPropagation() { this.#stop = true; }
    stopImmediatePropagation() {
      this.#stop = true;
      this.#stopImmediate = true;
    }
    // Internal dispatch hooks used by EventTarget.
    get _dispatching() { return this.#dispatching; }
    get _stopImmediate() { return this.#stopImmediate; }
    _trust() { this.#trusted = true; }
    _begin(target) {
      this.#dispatching = true;
      this.#target = target;
      this.#currentTarget = target;
      this.#eventPhase = 2; // AT_TARGET
      this.#path = [target];
      this.#stop = false;
      this.#stopImmediate = false;
    }
    // Workerd leaves currentTarget set after dispatch (the DOM standard
    // nulls it); only the phase is reset.
    _end() {
      this.#eventPhase = 0;
      this.#dispatching = false;
    }
  };
  {
    const phases = {
      NONE: 0, CAPTURING_PHASE: 1, AT_TARGET: 2, BUBBLING_PHASE: 3,
    };
    for (const [name, value] of Object.entries(phases)) {
      const d = { value, writable: false, enumerable: true,
        configurable: false };
      Object.defineProperty(globalThis.Event, name, d);
      Object.defineProperty(globalThis.Event.prototype, name, d);
    }
  }
}
if (!globalThis.CustomEvent) {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.detail = init.detail === undefined ? null : init.detail;
    }
  };
}
if (!globalThis.ExtendableEvent) {
  // Exists as a type but is not constructable from user code.
  globalThis.ExtendableEvent = class ExtendableEvent extends Event {
    constructor() {
      throw new TypeError("Illegal constructor");
    }
  };
}
// An event-handler IDL attribute occupies one listener-list position. Replacing
// its callback must retain that position, or listeners added after `onabort`
// run before it and observe an order that differs from the web platform.
const __eventHandlerEntry = Symbol("eventHandlerEntry");
const __getEventHandler = (target, type) =>
  (target._listeners.get(type) || [])
    .find((entry) => entry[__eventHandlerEntry])?.callback ?? null;
const __setEventHandler = (target, type, callback) => {
  const list = target._listeners.get(type) || [];
  const entry = list.find((item) => item[__eventHandlerEntry]);
  if (typeof callback !== "function") {
    if (entry) list.splice(list.indexOf(entry), 1);
    return;
  }
  if (entry) {
    entry.callback = callback;
  } else {
    list.push({ callback, once: false, [__eventHandlerEntry]: true });
    target._listeners.set(type, list);
  }
};
if (!globalThis.EventTarget) {
  globalThis.EventTarget = class EventTarget {
    constructor() { this._listeners = new Map(); }
    addEventListener(type, callback, options = {}) {
      if (callback === null || callback === undefined) return;
      if (typeof callback !== "function" &&
          typeof callback.handleEvent !== "function")
        throw new TypeError(
          "Failed to execute 'addEventListener' on 'EventTarget': " +
          "parameter 2 is not of type 'EventListener'.");
      const object = typeof options === "object" && options !== null;
      // Capture and passive are accepted for portability but must be
      // false: Cells dispatches only at the target, so honouring them
      // would silently change ordering.
      if (object ? options.capture || options.passive : !!options)
        throw new TypeError(
          "Cells does not support the 'capture' or 'passive' options " +
          "on addEventListener().");
      const signal = object ? options.signal : undefined;
      if (signal && signal.aborted) return;
      const key = String(type);
      const list = this._listeners.get(key) || [];
      if (list.some((e) => e.callback === callback)) return;
      list.push({ callback, once: object && !!options.once });
      this._listeners.set(key, list);
      if (signal)
        signal.addEventListener("abort", () =>
          this.removeEventListener(key, callback), { once: true });
    }
    removeEventListener(type, callback, options = {}) {
      const object = typeof options === "object" && options !== null;
      if (object ? options.capture : !!options)
        throw new TypeError(
          "Cells does not support the 'capture' option on " +
          "removeEventListener().");
      const list = this._listeners.get(String(type));
      if (!list) return;
      const index = list.findIndex((e) => e.callback === callback);
      if (index >= 0) list.splice(index, 1);
    }
    dispatchEvent(event) {
      if (!(event instanceof Event))
        throw new TypeError("argument is not an Event");
      if (event._dispatching)
        throw new DOMException(
          "The event is already being dispatched.",
          "InvalidStateError");
      event._begin(this);
      // Copy: a listener may add or remove listeners mid-dispatch.
      for (const item of (this._listeners.get(event.type) || []).slice()) {
        if (event._stopImmediate) break;
        if (item.once)
          this.removeEventListener(event.type, item.callback);
        if (typeof item.callback === "function")
          item.callback.call(this, event);
        else item.callback.handleEvent(event);
      }
      const handler = this["on" + event.type];
      const hasEventHandler = (this._listeners.get(event.type) || [])
        .some((item) => item[__eventHandlerEntry]);
      if (!hasEventHandler && !event._stopImmediate &&
          typeof handler === "function")
        handler.call(this, event);
      event._end();
      return !event.defaultPrevented;
    }
  };
}
// The global scope is itself an EventTarget.
if (typeof globalThis.addEventListener !== "function") {
  const globalTarget = new EventTarget();
  for (const name of
    ["addEventListener", "removeEventListener", "dispatchEvent"])
    globalThis[name] = globalTarget[name].bind(globalTarget);
}
if (!globalThis.MessageEvent) {
  globalThis.MessageEvent = class MessageEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.data = init.data;
      this.origin = String(init.origin || "");
      this.lastEventId = String(init.lastEventId || "");
    }
  };
}
if (!globalThis.CloseEvent) {
  globalThis.CloseEvent = class CloseEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.code = Number(init.code || 0);
      // `reason` is a USVString: a lone surrogate becomes U+FFFD rather than
      // travelling as an unpaired code unit.
      this.reason = String(init.reason || "").toWellFormed
        ? String(init.reason || "").toWellFormed()
        : String(init.reason || "").replace(
          /[\uD800-\uDFFF]/g,
          (unit, index, whole) => {
            const code = unit.charCodeAt(0);
            const next = whole.charCodeAt(index + 1);
            const prev = whole.charCodeAt(index - 1);
            const paired = code <= 0xDBFF
              ? next >= 0xDC00 && next <= 0xDFFF
              : prev >= 0xD800 && prev <= 0xDBFF;
            return paired ? unit : "\uFFFD";
          },
        );
      this.wasClean = !!init.wasClean;
    }
  };
}
if (!globalThis.DOMException) {
  globalThis.DOMException = class DOMException extends Error {
    constructor(message = "", name = "Error") {
      super(message);
      this.name = name;
      // What a startup error reports, whatever the properties become.
      __dom_exception_brand(this, `${name}`, `${message}`);
    }
  };
  // WebIDL legacy code constants, enumerable on both the interface
  // object and its prototype, in spec order.
  {
    const codes = [
      ["INDEX_SIZE_ERR", 1], ["DOMSTRING_SIZE_ERR", 2],
      ["HIERARCHY_REQUEST_ERR", 3], ["WRONG_DOCUMENT_ERR", 4],
      ["INVALID_CHARACTER_ERR", 5], ["NO_DATA_ALLOWED_ERR", 6],
      ["NO_MODIFICATION_ALLOWED_ERR", 7], ["NOT_FOUND_ERR", 8],
      ["NOT_SUPPORTED_ERR", 9], ["INUSE_ATTRIBUTE_ERR", 10],
      ["INVALID_STATE_ERR", 11], ["SYNTAX_ERR", 12],
      ["INVALID_MODIFICATION_ERR", 13], ["NAMESPACE_ERR", 14],
      ["INVALID_ACCESS_ERR", 15], ["VALIDATION_ERR", 16],
      ["TYPE_MISMATCH_ERR", 17], ["SECURITY_ERR", 18],
      ["NETWORK_ERR", 19], ["ABORT_ERR", 20],
      ["URL_MISMATCH_ERR", 21], ["QUOTA_EXCEEDED_ERR", 22],
      ["TIMEOUT_ERR", 23], ["INVALID_NODE_TYPE_ERR", 24],
      ["DATA_CLONE_ERR", 25],
    ];
    for (const [name, value] of codes) {
      const d = { value, writable: false, enumerable: true,
        configurable: false };
      Object.defineProperty(globalThis.DOMException, name, d);
      Object.defineProperty(globalThis.DOMException.prototype, name, d);
    }
    // The legacy `code` member maps the error name to its constant, per
    // WebIDL; names outside the table (and every modern name) are 0.
    const legacy = {
      IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4,
      InvalidCharacterError: 5, NoModificationAllowedError: 7,
      NotFoundError: 8, NotSupportedError: 9, InUseAttributeError: 10,
      InvalidStateError: 11, SyntaxError: 12, InvalidModificationError: 13,
      NamespaceError: 14, InvalidAccessError: 15, TypeMismatchError: 17,
      SecurityError: 18, NetworkError: 19, AbortError: 20,
      URLMismatchError: 21, QuotaExceededError: 22, TimeoutError: 23,
      InvalidNodeTypeError: 24, DataCloneError: 25,
    };
    Object.defineProperty(globalThis.DOMException.prototype, "code", {
      get() { return legacy[this.name] ?? 0; },
      enumerable: true, configurable: true,
    });
  }
}
if (!globalThis.AbortSignal) {
  const __abortBrand = Symbol("abortSignal");
  globalThis.AbortSignal = class AbortSignal extends EventTarget {
    // The brand the RPC envelope classifies by (`__hostKind`).
    #brand;
    static {
      __recordBase(this);
      __isAbortSignal = (value) =>
        typeof value === "object" && value !== null && #brand in value;
    }
    // The Headers/Blob clone-poisoning brand: V8's structured
    // clone throws on functions, so a live signal reaches the
    // RPC lift instead of silently flattening to plain data.
    constructor() {
      // Per spec AbortSignal has no constructor: it is only reachable
      // through AbortController, AbortSignal.abort/timeout/any. The internal
      // paths pass the brand to get past this.
      if (arguments[0] !== __abortBrand) {
        throw new TypeError("Illegal constructor");
      }
      const set = __pinBase(AbortSignal);
      try {
        super();
      } finally {
        __unpinBase(AbortSignal, set);
      }
      this.aborted = false;
      this.reason = undefined;
      // Fixed, as a Headers' is (headers.js).
      __ObjectDefineProperty(this, "__celldHost",
        { value: __rpcNoClone, enumerable: true });
    }
    throwIfAborted() { if (this.aborted) throw this.reason; }
    static abort(reason = new DOMException("The operation was aborted", "AbortError")) {
      const c = new AbortController(); c.abort(reason); return c.signal;
    }
    static timeout(ms) {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException(
        "The operation was aborted due to timeout", "TimeoutError",
      )), ms);
      return c.signal;
    }
    static any(signals) {
      const c = new AbortController();
      for (const signal of signals) {
        if (signal.aborted) { c.abort(signal.reason); break; }
        signal.addEventListener("abort", () => c.abort(signal.reason), { once: true });
      }
      return c.signal;
    }
  };
  Object.defineProperty(globalThis.AbortSignal.prototype, "onabort", {
    configurable: true,
    enumerable: true,
    get() {
      if (!(this instanceof globalThis.AbortSignal))
        throw new TypeError("Illegal invocation");
      return __getEventHandler(this, "abort");
    },
    set(value) {
      if (!(this instanceof globalThis.AbortSignal))
        throw new TypeError("Illegal invocation");
      __setEventHandler(this, "abort", value);
    },
  });
  globalThis.AbortController = class AbortController {
    constructor() { this.signal = new AbortSignal(__abortBrand); }
    abort(reason = new DOMException("The operation was aborted", "AbortError")) {
      __abortSignal(this.signal, reason);
    }
  };
}
if (!globalThis.Blob) {
  // Same clone-poisoning brand as Headers: an enumerable
  // function-valued property makes V8's structured clone throw, so
  // a Blob reaches the RPC lift instead of silently flattening.
  const __blobNoClone = () => {};
  globalThis.Blob = class Blob {
    // The brand the RPC envelope classifies by (`__hostKind`).
    #brand;
    // The bytes and the type, private as workerd's are, so that what the
    // Blob reads, sends and stores is its own (`__blobBytesOf`); `size` and
    // `type` are prototype accessors, as in workerd.
    #bytes;
    #type;
    static {
      __isBlob = (value) =>
        typeof value === "object" && value !== null && #brand in value;
      __blobBytesOf = (value) =>
        value !== null && typeof value === "object" && #bytes in value
          ? value.#bytes : undefined;
      __blobTypeOf = (blob) => blob.#type;
      __setBlobBytes = (blob, bytes) => {
        blob.#bytes = bytes;
      };
    }
    constructor(parts = [], options = {}) {
      if (options && options.endings !== undefined)
        throw new Error(
          "The 'endings' field on 'Options' is not implemented.");
      // A type outside U+0020..U+007E is not a valid MIME type and is
      // dropped rather than stored.
      const rawType = String(options.type || "");
      this.#type = /^[\u0020-\u007e]*$/.test(rawType)
        ? rawType.toLowerCase() : "";
      // Fixed, as a Headers' is (headers.js).
      __ObjectDefineProperty(this, "__celldHost",
        { value: __blobNoClone, enumerable: true });
      // Two passes. First convert every part in order -- string
      // conversion runs user code (Symbol.toPrimitive), which may
      // resize a backing buffer. Buffers and views are carried through
      // as-is so a length-tracking view is measured *after* those side
      // effects, matching Workerd. Then allocate once and copy.
      //
      // The previous shape pushed every byte into a plain array with a
      // spread, costing roughly 8x the memory and exceeding the
      // argument limit on multi-megabyte parts.
      const sources = [];
      for (const part of parts) {
        if (__isBlob(part)) sources.push(__blobBytesOf(part));
        else if (part instanceof ArrayBuffer ||
                 ArrayBuffer.isView(part)) sources.push(part);
        else sources.push(new TextEncoder().encode(String(part)));
      }
      const chunks = sources.map((source) =>
        source instanceof Uint8Array ? source
          : source instanceof ArrayBuffer ? new Uint8Array(source)
            : new Uint8Array(
              source.buffer, source.byteOffset, source.byteLength));
      let total = 0;
      for (const chunk of chunks) total += chunk.byteLength;
      const LIMIT = 134217728;
      if (total > LIMIT)
        throw new RangeError(
          `Blob size ${total} exceeds limit ${LIMIT}`);
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      this.#bytes = bytes;
    }
    get size() { return this.#bytes.byteLength; }
    get type() { return this.#type; }
    async arrayBuffer() { return this.#bytes.slice().buffer; }
    async bytes() { return this.#bytes.slice(); }
    async text() { return new TextDecoder().decode(this.#bytes); }
    // A platform stream, as in workerd, so a BYOB reader works on it. Each
    // chunk is a copy: the Blob's bytes stay its own.
    stream() {
      const bytes = this.#bytes;
      let offset = 0;
      return new CelldChunkStream(() => {
        if (offset >= bytes.byteLength) return null;
        const end = Math.min(offset + 64 * 1024, bytes.byteLength);
        const chunk = bytes.slice(offset, end);
        offset = end;
        return chunk;
      });
    }
    [Symbol.for("nodejs.util.inspect.custom")]() {
      return `Blob { size: ${this.size}, type: '${this.type}' }`;
    }
    slice(start = 0, end = this.size, type = "") {
      const norm = (n, fallback) => {
        n = n === undefined ? fallback : Number(n);
        return n < 0 ? Math.max(this.size + n, 0) : Math.min(n, this.size);
      };
      const a = norm(start, 0), b = norm(end, this.size);
      return new Blob(
        [this.#bytes.subarray(a, Math.max(a, b))], { type });
    }
    get [Symbol.toStringTag]() { return "Blob"; }
  };
}
// A Blob of `buffer`, which the caller hands over: a body read whole that
// nothing else holds, so it needs no copy. The type is normalised as the
// constructor does.
__celld.__blobOf = (buffer, type) => {
  const blob = new Blob([], { type });
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength > 134217728)
    throw new RangeError(`Blob size ${bytes.byteLength} exceeds limit 134217728`);
  __setBlobBytes(blob, bytes);
  return blob;
};
// Memory V8 grows outside its allocator: WebAssembly memories, and buffers
// made resizable or growable with `maxByteLength`. The host counts it
// against the isolate's backing-store budget (`__memory_admit`). Growth that
// JavaScript asks for is admitted before it happens, once the original's own
// checks would pass, and refused past the budget with V8's RangeError; a
// receiver or argument the original rejects goes to it untouched. A refusal
// takes no memory, so it condemns nothing: a Worker may catch it and ask for
// less, as Emscripten does. What V8 makes whole (a WebAssembly memory or
// instance) is checked once made, and refused the same way, leaving it
// garbage. What Wasm code grows itself, with `memory.grow`, the host watches
// while the turn runs, once the isolate has made WebAssembly; a buffer grows
// only through the methods here, so it needs no watch. Every original is
// captured here, so code that runs later reaches only the checked forms.
// Strict, so no Worker code reaches these functions through `caller`.
(function () {
  "use strict";
  const construct = Reflect.construct;
  const apply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const getter = (target, name) => Object.getOwnPropertyDescriptor(target, name).get;
  const trunc = Math.trunc;
  const isFinite = Number.isFinite;
  const then = Promise.prototype.then;
  const ErrorOfRange = RangeError;
  const SharedPrototype = globalThis.SharedArrayBuffer?.prototype;
  const PAGE = 65536;
  const MAX_INDEX = 2 ** 53 - 1;
  const MAX_UINT32 = 2 ** 32 - 1;
  const admit = __memory_admit;
  // The most one WebAssembly memory may hold (`--wasm-max-mem-pages`).
  const MAX_PAGES = trunc(__memory_limit() / PAGE);
  const captureStackTrace = Error.captureStackTrace;
  // Throw V8's RangeError, with the stack from the Worker's call of `from`,
  // the public function, so it shows no harness frames.
  const refuse = (message, from) => {
    const error = new ErrorOfRange(message);
    captureStackTrace(error, from);
    throw error;
  };
  const isObject = (value) =>
    value !== null && (typeof value === "object" || typeof value === "function");
  // ToIndex, given the number its argument converted to: the index, or
  // undefined where the original throws a RangeError. The caller converts
  // with unary plus, which throws V8's own TypeError for a BigInt or a
  // Symbol, and passes the original the number, so a `valueOf` runs once.
  const toIndex = (number) => {
    const integer = trunc(number) || 0;
    return integer >= 0 && integer <= MAX_INDEX ? integer : undefined;
  };

  // `Function.prototype.toString` prints each wrapper as its original, so
  // feature detection that reads `[native code]` sees what it would in
  // workerd.
  const natives = new WeakMap();
  const nativeOf = WeakMap.prototype.get;
  const setNative = WeakMap.prototype.set;
  const functionToString = Function.prototype.toString;
  const toString = {
    toString() {
      return apply(functionToString, apply(nativeOf, natives, [this]) ?? this, []);
    },
  }.toString;
  const disguise = (wrapper, original) => {
    apply(setNative, natives, [wrapper, original]);
    return wrapper;
  };
  defineProperty(Function.prototype, "toString", {
    value: disguise(toString, functionToString),
    writable: true, enumerable: false, configurable: true,
  });
  // Swap a method for `wrap(original, self)`, with the original's name,
  // length and text; `self()` is the method, for `refuse`.
  const replaceMethod = (prototype, name, wrap) => {
    const original = prototype[name];
    if (typeof original !== "function") return;
    const wrapper = wrap(original, () => wrapper);
    defineProperty(wrapper, "length", { value: original.length });
    defineProperty(prototype, name, {
      value: disguise(wrapper, original),
      writable: true, enumerable: false, configurable: true,
    });
  };
  // Swap a constructor for a function that runs `make`, keeping
  // `value.constructor === Global`, statics and subclassing as they were.
  // A function, not a proxy: V8 names a receiver in its errors after the
  // function its `constructor` holds (`#<ArrayBuffer>`). `new.target` is
  // the original, not the wrapper, so V8 makes what the original would.
  // `named` makes the wrapper by a named function expression, since V8
  // takes the name from the function's source rather than its `name`.
  const replaceConstructor = (Original, make, named) => {
    const wrapper = named((receiver, args, newTarget) => {
      if (newTarget === undefined) return apply(Original, receiver, args);
      return make(Original, args, newTarget === wrapper ? Original : newTarget, wrapper);
    });
    for (const key of Reflect.ownKeys(Original)) {
      if (key === "name") continue;
      defineProperty(wrapper, key, Object.getOwnPropertyDescriptor(Original, key));
    }
    defineProperty(Original.prototype, "constructor", {
      value: wrapper, writable: true, enumerable: false, configurable: true,
    });
    return disguise(wrapper, Original);
  };
  // A resizable ArrayBuffer or a growable SharedArrayBuffer, made with a
  // `maxByteLength`, commits its initial length outside the allocator.
  const BUFFER_FAILED = "Array buffer allocation failed";
  const checkedBuffer = (target, args, newTarget, from) => {
    const options = args[1];
    if (args.length < 2 || !isObject(options)) return construct(target, args, newTarget);
    const length = +args[0];
    const index = toIndex(length);
    if (index === undefined) return construct(target, [length], newTarget);
    const max = options.maxByteLength;
    if (max === undefined) return construct(target, [length], newTarget);
    const maxNumber = +max;
    const maxIndex = toIndex(maxNumber);
    if (maxIndex !== undefined && index <= maxIndex && !admit(index, false)) refuse(BUFFER_FAILED, from);
    return construct(target, [length, { maxByteLength: maxNumber }], newTarget);
  };

  const byteLength = getter(ArrayBuffer.prototype, "byteLength");
  const maxByteLength = getter(ArrayBuffer.prototype, "maxByteLength");
  const resizable = getter(ArrayBuffer.prototype, "resizable");
  const detached = getter(ArrayBuffer.prototype, "detached");
  // Whether `buffer` is an ArrayBuffer that is resizable and not detached:
  // anything else the original rejects or, for `transfer`, copies through
  // the allocator.
  const isResizable = (buffer) => {
    try {
      return apply(resizable, buffer, []) && !apply(detached, buffer, []);
    } catch {
      return false;
    }
  };
  globalThis.ArrayBuffer = replaceConstructor(ArrayBuffer, checkedBuffer,
    (body) => function ArrayBuffer() {
      "use strict";
      return body(this, arguments, new.target);
    });
  replaceMethod(ArrayBuffer.prototype, "resize", (original, self) => ({
    resize(newLength) {
      if (!isResizable(this)) return apply(original, this, [newLength]);
      const length = +newLength;
      const index = toIndex(length);
      if (index !== undefined && index <= apply(maxByteLength, this, [])) {
        const bytes = index - apply(byteLength, this, []);
        if (bytes > 0 && !admit(bytes, false)) refuse("ArrayBuffer.prototype.resize: Out of memory", self());
      }
      return apply(original, this, [length]);
    },
  }).resize);
  // A transfer of a resizable buffer keeps its reservation and commits the
  // new length there, outside the allocator.
  for (const name of ["transfer", "transferToFixedLength"]) {
    replaceMethod(ArrayBuffer.prototype, name, (original, self) => ({
      [name](newLength) {
        if (!isResizable(this)) return apply(original, this, [newLength]);
        const current = apply(byteLength, this, []);
        const length = newLength === undefined ? undefined : +newLength;
        const index = length === undefined ? current : toIndex(length);
        const ceiling = name === "transfer" ? apply(maxByteLength, this, []) : MAX_INDEX;
        if (index !== undefined && index <= ceiling && index > current &&
            !admit(index - current, false))
          refuse(BUFFER_FAILED, self());
        return apply(original, this, [length]);
      },
    })[name]);
  }

  if (typeof SharedArrayBuffer === "function") {
    const sharedLength = getter(SharedArrayBuffer.prototype, "byteLength");
    const sharedMax = getter(SharedArrayBuffer.prototype, "maxByteLength");
    const growable = getter(SharedArrayBuffer.prototype, "growable");
    const isGrowable = (buffer) => {
      try {
        return apply(growable, buffer, []);
      } catch {
        return false;
      }
    };
    globalThis.SharedArrayBuffer = replaceConstructor(SharedArrayBuffer, checkedBuffer,
      (body) => function SharedArrayBuffer() {
        "use strict";
        return body(this, arguments, new.target);
      });
    replaceMethod(SharedArrayBuffer.prototype, "grow", (original, self) => ({
      grow(newLength) {
        if (!isGrowable(this)) return apply(original, this, [newLength]);
        const length = +newLength;
        const index = toIndex(length);
        if (index !== undefined && index <= apply(sharedMax, this, [])) {
          const bytes = index - apply(sharedLength, this, []);
          if (bytes > 0 && !admit(bytes, false))
            refuse("SharedArrayBuffer.prototype.grow: Out of memory", self());
        }
        return apply(original, this, [length]);
      },
    }).grow);
  }

  if (typeof WebAssembly === "object") {
    const Memory = WebAssembly.Memory;
    const Instance = WebAssembly.Instance;
    const memoryBuffer = getter(Memory.prototype, "buffer");
    // A WebAssembly memory's pages, or undefined if `memory` is none.
    const pagesOf = (memory) => {
      let buffer;
      try {
        buffer = apply(memoryBuffer, memory, []);
      } catch {
        return undefined;
      }
      try {
        return apply(byteLength, buffer, []) / PAGE;
      } catch {
        return apply(getter(SharedPrototype, "byteLength"), buffer, []) / PAGE;
      }
    };
    // A memory or instance V8 made whole: kept if the isolate's memory still
    // fits, and otherwise left as garbage behind V8's RangeError.
    const checked = (message) => (made, from) => {
      if (!admit(0, true)) refuse(message, from);
      return made;
    };
    const madeMemory = checked("WebAssembly.Memory(): could not allocate memory");
    const INSTANCE_FAILED =
      "WebAssembly.Instance(): Out of memory: Cannot allocate Wasm memory for new instance";
    const madeInstance = checked(INSTANCE_FAILED);
    const madeInstantiation = checked(
      "WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance");
    // ToPrimitive, as V8 converts a descriptor's member: what Worker code
    // a member runs (`valueOf`, `toString`), it runs here.
    const toPrimitive = (value, hint) => {
      const exotic = value[Symbol.toPrimitive];
      if (exotic !== undefined && exotic !== null) {
        const result = apply(exotic, value, [hint]);
        if (!isObject(result)) return result;
      } else {
        for (const name of hint === "string" ? ["toString", "valueOf"] : ["valueOf", "toString"]) {
          const method = value[name];
          if (typeof method !== "function") continue;
          const result = apply(method, value, []);
          if (!isObject(result)) return result;
        }
      }
      throw new TypeError("Cannot convert object to primitive value");
    };
    // A memory descriptor as plain data, each member read once in the order
    // V8 reads them, and converted to the primitive V8 converts further, so
    // V8 runs no Worker code with it. Anything else goes to V8 as it is.
    const plainDescriptor = (descriptor) => {
      if (!isObject(descriptor)) return descriptor;
      const plain = { __proto__: null };
      for (const key of ["address", "initial", "maximum", "shared"]) {
        const value = descriptor[key];
        if (value === undefined) continue;
        plain[key] = key === "shared" || !isObject(value)
          ? value
          : toPrimitive(value, key === "address" ? "string" : "number");
      }
      return plain;
    };
    // The watch waits while V8 makes a memory, which runs no Worker code
    // with a plain descriptor, for the check here, which refuses one past
    // the budget rather than condemning it. A tick that comes meanwhile is
    // taken when the wait ends. A subclass's `new.target` can run code as V8
    // reads its prototype, so it is made unpaused.
    const pause = __memory_watch_pause;
    WebAssembly.Memory = replaceConstructor(Memory,
      (target, args, newTarget, from) => {
        const descriptor = plainDescriptor(args[0]);
        if (newTarget !== target)
          return madeMemory(construct(target, [descriptor], newTarget), from);
        pause(true);
        try {
          return madeMemory(construct(target, [descriptor], target), from);
        } finally {
          pause(false);
        }
      },
      (body) => function Memory() {
        "use strict";
        return body(this, arguments, new.target);
      });
    WebAssembly.Instance = replaceConstructor(Instance,
      (target, args, newTarget, from) => madeInstance(construct(target, args, newTarget), from),
      (body) => function Instance() {
        "use strict";
        return body(this, arguments, new.target);
      });
    // `grow(delta)` converts as WebIDL's [EnforceRange] unsigned long. The
    // memory's own maximum is not readable, so a grow past both it and the
    // budget throws the budget's RangeError rather than the maximum's.
    replaceMethod(Memory.prototype, "grow", (original, self) => ({
      grow(delta) {
        const pages = pagesOf(this);
        if (pages === undefined) return apply(original, this, [delta]);
        const number = +delta;
        if (isFinite(number)) {
          const more = trunc(number);
          if (more > 0 && more <= MAX_UINT32 && pages + more <= MAX_PAGES &&
              !admit(more * PAGE, true))
            refuse("WebAssembly.Memory.grow(): Unable to grow instance memory", self());
        }
        return apply(original, this, [number]);
      },
    }).grow);
    for (const name of ["instantiate", "instantiateStreaming"]) {
      replaceMethod(WebAssembly, name, (original) => ({
        [name](...args) {
          return apply(then, apply(original, WebAssembly, args), [madeInstantiation]);
        },
      })[name]);
    }
  }
})();
if (!globalThis.File) {
  // WebIDL-ish per Workerd: name is required, name/lastModified are
  // brand-checked prototype getters (enumerable, matching the
  // workers_api_getters_setters_on_prototype flag), and lastModified
  // coerces via ToNumber (throws for BigInt), NaN becoming 0.
  globalThis.File = class File extends Blob {
    #name;
    #lastModified;
    static {
      __recordBase(this);
      __isFile = (value) =>
        typeof value === "object" && value !== null && #name in value;
    }
    constructor(parts, name, options = {}) {
      if (arguments.length < 2)
        throw new TypeError(
          "Failed to construct 'File': 2 arguments required, but " +
          `only ${arguments.length} present.`);
      const set = __pinBase(File);
      try {
        super(parts, options);
      } finally {
        __unpinBase(File, set);
      }
      this.#name = String(name);
      const lm = options == null ? undefined : options.lastModified;
      if (lm === undefined) this.#lastModified = Date.now();
      else {
        const n = +lm; // ToNumber: throws for BigInt, like WebIDL
        this.#lastModified = Number.isFinite(n) ? Math.trunc(n) : 0;
      }
    }
    get name() { return this.#name; }
    get lastModified() { return this.#lastModified; }
    get [Symbol.toStringTag]() { return "File"; }
    [Symbol.for("nodejs.util.inspect.custom")]() {
      return `File { name: '${this.name}', ` +
        `lastModified: ${this.lastModified}, size: ${this.size}, ` +
        `type: '${this.type}' }`;
    }
  };
  for (const key of ["name", "lastModified"]) {
    const desc =
      Object.getOwnPropertyDescriptor(File.prototype, key);
    desc.enumerable = true;
    Object.defineProperty(File.prototype, key, desc);
  }
}
if (!globalThis.FormData) {
// Byte offsets the multipart scanner compares against. A part body is
// arbitrary bytes, so every framing decision below is made on bytes.
const __CR = 13, __LF = 10, __DASH = 45;
const __bytesIndexOf = (haystack, needle, from) => {
  const last = haystack.length - needle.length;
  outer: for (let i = from; i <= last; i++) {
    for (let j = 0; j < needle.length; j++)
      if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};
// A boundary delimiter is a delimiter only at the start of a line (RFC 2046
// section 5.1.1). Searching for the bytes anywhere would let a binary part
// that happens to contain `--<boundary>` split itself, which is a corrupt
// upload rather than a parse error, so the caller never learns of it.
const __delimiterIndex = (bytes, delimiter, from) => {
  for (let at = from;;) {
    const found = __bytesIndexOf(bytes, delimiter, at);
    if (found < 0) return -1;
    if (found === 0 || bytes[found - 1] === __LF) return found;
    at = found + 1;
  }
};
// A `Content-Disposition` parameter, anchored to the start of a parameter:
// the parameter name must follow the header name or a `;`. An unanchored
// pattern found the `name=` inside `filename=`, so a part whose header wrote
// the filename first landed under the filename. The grammar does not
// constrain the parameter order, and both orders occur in the wild. Hoisted
// because the previous shape compiled a regex per parameter per part.
const __CD_NAME =
  /(?:^|;)\s*name\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i;
const __CD_FILENAME =
  /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i;
// Body -> FormData for multipart/form-data and
// application/x-www-form-urlencoded. Kept out of the class so V8 only
// pre-parses it; the body is compiled on first actual formData() call.
//
// `bytes` is the undecoded body. A file part must reach `File` as the bytes
// that arrived: decoding the body first and slicing part bodies out of the
// string replaced every non-UTF-8 sequence with U+FFFD, and the re-encode in
// the `Blob` constructor then wrote those replacement bytes into the file.
__celld.__parseFormData = (bytes, contentType) => {
  const ct = String(contentType || "");
  if (/^\s*application\/x-www-form-urlencoded/i.test(ct)) {
    // This form is decoded as UTF-8, so a declared charset that is not UTF-8
    // cannot be honoured. Refuse rather than mis-decode.
    const charset = /;\s*charset\s*=\s*"?([^";]+)/i.exec(ct);
    if (charset && !/^utf-?8$/i.test(charset[1].trim()))
      throw new TypeError(
        `Unsupported charset "${charset[1].trim()}". FormData can only ` +
        "parse UTF-8 encoded bodies.");
    const form = new FormData();
    for (const [key, value] of new URLSearchParams(
      new TextDecoder().decode(bytes)))
      form.append(key, value);
    return form;
  }
  if (!/^\s*multipart\/form-data/i.test(ct))
    throw new TypeError(
      "Unrecognized Content-Type header value. FormData can only " +
      "parse the following MIME types: multipart/form-data, " +
      "application/x-www-form-urlencoded");
  const found = /boundary\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(ct);
  if (!found)
    throw new TypeError(
      "No boundary was found in the multipart/form-data " +
      "Content-Type header.");
  const boundary = (found[1] !== undefined ? found[1] : found[2]).trim();
  const form = new FormData();
  const delimiter = new TextEncoder().encode("--" + boundary);
  // Walk the delimiters rather than splitting on them, so that a body whose
  // framing is truncated or corrupt is refused instead of silently yielding
  // the parts that happened to parse. Only the framing is checked; a part's
  // own bytes are carried through unexamined. The preamble before the first
  // delimiter and the epilogue after the closing one are ignored.
  let cursor = __delimiterIndex(bytes, delimiter, 0);
  if (cursor < 0)
    throw new TypeError(
      "No boundary delimiter was found in the multipart/form-data body.");
  cursor += delimiter.length;
  for (;;) {
    // What follows a delimiter decides everything: "--" closes the body, a
    // line break opens another part, and anything else is malformed.
    if (bytes[cursor] === __DASH && bytes[cursor + 1] === __DASH) break;
    const lineBreak = bytes[cursor] === __CR && bytes[cursor + 1] === __LF
      ? 2
      : bytes[cursor] === __LF ? 1 : 0;
    if (lineBreak === 0)
      throw new TypeError(
        "A boundary delimiter must be followed by CRLF, LF, or \"--\".");
    cursor += lineBreak;
    const partStart = cursor;
    const next = __delimiterIndex(bytes, delimiter, partStart);
    if (next < 0)
      throw new TypeError(
        "The multipart/form-data body ended without a closing boundary " +
        "delimiter.");
    // The line break before a delimiter belongs to the delimiter, not to the
    // part it terminates.
    let chunkEnd = next;
    if (chunkEnd > partStart && bytes[chunkEnd - 1] === __LF) {
      chunkEnd -= 1;
      if (chunkEnd > partStart && bytes[chunkEnd - 1] === __CR) chunkEnd -= 1;
    }
    cursor = next + delimiter.length;
    // The headers end at the first blank line. Either line break can be CRLF
    // or a bare LF, which accepted inputs can contain.
    let headerEnd = -1, bodyStart = -1;
    for (let i = partStart; i < chunkEnd; i++) {
      const first = bytes[i] === __CR && bytes[i + 1] === __LF
        ? 2
        : bytes[i] === __LF ? 1 : 0;
      if (first === 0) continue;
      const after = i + first;
      const second = bytes[after] === __CR && bytes[after + 1] === __LF
        ? 2
        : bytes[after] === __LF ? 1 : 0;
      if (second === 0) continue;
      headerEnd = i;
      bodyStart = after + second;
      break;
    }
    if (headerEnd < 0)
      throw new TypeError(
        "A FormData part's headers must be terminated by a blank line.");
    // Part headers are text. Decoding this slice as UTF-8 keeps a non-ASCII
    // name or filename intact and cannot reach the part body.
    const rawHeaders = new TextDecoder().decode(
      bytes.subarray(partStart, headerEnd));
    const body = bytes.subarray(bodyStart, chunkEnd);
    let disposition = null;
    let type = "";
    for (const line of rawHeaders.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (name === "content-disposition") disposition = value;
      else if (name === "content-type") type = value;
    }
    if (disposition === null)
      throw new TypeError(
        "Content-Disposition header is required for each FormData " +
        "part.");
    const kind = disposition.split(";")[0].trim();
    if (kind.toLowerCase() !== "form-data")
      throw new TypeError(
        "Content-Disposition header for FormData part must have the " +
        "value \"form-data\", possibly followed by parameters. Got: " +
        "\"" + kind + "\"");
    const param = (pattern) => {
      const m = pattern.exec(disposition);
      if (!m) return undefined;
      const raw = m[1] !== undefined ? m[1] : (m[2] || "").trim();
      if (/\\$/.test(raw.replace(/\\\\/g, "")))
        throw new TypeError(
          "Name or filename can't end with backslash");
      return raw.replace(/\\(.)/g, "$1");
    };
    const name = param(__CD_NAME);
    if (name === undefined)
      throw new TypeError(
        "Content-Disposition header for FormData part must have a " +
        "name parameter.");
    const filename = param(__CD_FILENAME);
    // A part without a filename is an entry value, which the spec defines as a
    // string, so this one part is decoded as UTF-8. A file part keeps its
    // bytes.
    if (filename === undefined)
      form.append(name, new TextDecoder().decode(body));
    else
      form.append(
        name, new File([body], filename, { type: type || "" }));
  }
  return form;
};
  // Spec entry conversion: strings stay strings; a Blob becomes a
  // File named "blob" (or `filename`); a File is renamed only when a
  // filename is supplied.
  const __formDataValue = (value, filename) => {
    if (!(value instanceof Blob)) return String(value);
    if (value instanceof File && filename === undefined) return value;
    return new File(
      [value],
      filename === undefined ? "blob" : String(filename),
      {
        type: value.type,
        lastModified:
          value instanceof File ? value.lastModified : undefined,
      },
    );
  };
  globalThis.FormData = class FormData {
    constructor() { this._entries = []; }
    append(name, value, filename) {
      this._entries.push(
        [String(name), __formDataValue(value, filename)]);
    }
    set(name, value, filename) {
      value = __formDataValue(value, filename);
      const key = String(name);
      // Spec: replace the first match in place, keeping its position,
      // and drop any later matches.
      const first = this._entries.findIndex(([k]) => k === key);
      if (first < 0) { this._entries.push([key, value]); return; }
      this._entries[first] = [key, value];
      for (let i = this._entries.length - 1; i > first; i--)
        if (this._entries[i][0] === key) this._entries.splice(i, 1);
    }
    get(name) {
      const row = this._entries.find(([key]) => key === String(name));
      return row ? row[1] : null;
    }
    getAll(name) {
      return this._entries.filter(([key]) => key === String(name)).map(([, value]) => value);
    }
    has(name) { return this._entries.some(([key]) => key === String(name)); }
    delete(name) {
      const key = String(name);
      // Splice in place: the iterators below read the live list, so the
      // array identity must survive a delete during iteration.
      for (let i = this._entries.length - 1; i >= 0; i--)
        if (this._entries[i][0] === key) this._entries.splice(i, 1);
    }
    // Iteration is live: the iterator holds an index and re-reads the
    // entry list, so entries appended during iteration are visited and
    // an exhausted iterator resumes if entries are added later. A
    // generator cannot do this -- once it returns it is done forever.
    _iterate(pick) {
      const self = this;
      let index = 0;
      const iterator = {
        next() {
          if (index >= self._entries.length)
            return { value: undefined, done: true };
          return { value: pick(self._entries[index++]), done: false };
        },
        [Symbol.iterator]() { return iterator; },
      };
      return iterator;
    }
    entries() { return this._iterate((e) => [e[0], e[1]]); }
    keys() { return this._iterate((e) => e[0]); }
    values() { return this._iterate((e) => e[1]); }
    [Symbol.iterator]() { return this.entries(); }
    forEach(callback, thisArg) {
      if (typeof callback !== "function")
        throw new TypeError(
          "Failed to execute 'forEach' on 'FormData': parameter 1 is " +
          "not of type 'Function'.");
      for (const [key, value] of this.entries())
        callback.call(thisArg, value, key, this);
    }
  };
}
// Node's Buffer lives in src/js/node_buffer.js, compiled
// lazily (LAZY_GLOBALS / LAZY_MODULES) on first use.
if (!globalThis.ErrorEvent) {
  globalThis.ErrorEvent = class ErrorEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.message = String(init.message ?? "");
      this.filename = String(init.filename ?? "");
      this.lineno = Number(init.lineno ?? 0);
      this.colno = Number(init.colno ?? 0);
      this.error = init.error;
    }
  };
}
// Web API globals a real bundle references at module scope but that the
// prelude doesn't provide. Stub as empty classes (guarded so we never
// clobber a real prelude implementation). Enough to LOAD; every name in
// this first list has a real implementation elsewhere, so the empty class
// only exists for the load-order window.
for (const n of ["WebSocket", "EventTarget", "Event", "MessageEvent",
  "CloseEvent", "ErrorEvent", "SubtleCrypto", "TransformStream",
  "ReadableStream", "WritableStream", "ReadableStreamDefaultReader",
  "WritableStreamDefaultWriter",
  "ByteLengthQueuingStrategy", "CountQueuingStrategy",
  "TextEncoderStream", "TextDecoderStream"]) {
  if (!globalThis[n]) globalThis[n] = class {};
}
// These have no implementation anywhere in celld. An empty class would
// let `new BroadcastChannel(...)` hand back an inert object that fails
// far from the cause; the compat contract is "reject at first use", so
// the name loads but construction throws. (EventSource, MessageChannel,
// and MessagePort are real; their scripts run after the harness.)
for (const n of ["BroadcastChannel", "FileReader"]) {
  if (!globalThis[n]) globalThis[n] = class {
    constructor() {
      throw new Error(n + " is not implemented in celld");
    }
  };
}
// Every socket this isolate holds for the host, by host id. Read through the
// captured Map methods, so a Worker that replaces them does not see or
// redirect this path.
const __sockets = new __SafeMap();
const __socketGet = (id) => __ReflectApply(__MapGet, __sockets, [id]);
const __socketSet = (id, socket) => {
  if (id !== 0) __ReflectApply(__MapSet, __sockets, [id, socket]);
};
const __socketDelete = (id) => {
  if (id !== 0) __ReflectApply(__MapDelete, __sockets, [id]);
};
const __WS_CONNECTING = 0;
const __WS_OPEN = 1;
const __WS_CLOSING = 2;
const __WS_CLOSED = 3;
// workerd's text for a socket used from another Durable Object in the same
// isolate. Its request variant is `__ctxError`.
const __crossObjectError = () => new Error(
  "Cannot perform I/O on behalf of a different Durable Object. I/O " +
  "objects (such as streams, request/response bodies, and others) " +
  "created in the context of one Durable Object cannot be accessed from " +
  "a different Durable Object in the same isolate. This is a limitation " +
  "of Cloudflare Workers which allows us to improve overall performance. " +
  "(I/O type: Native)");
// The internal factory's options for the construction in progress. Set and
// cleared around one `new`, and read before anything else runs in the
// constructor, so no application code can observe or reuse it.
let __wsInit = null;
// Exported once from the class's static block. Each reads the socket's
// private state, and so doubles as the brand check: anything that is not a
// WebSocket made by this class throws a TypeError.
let __wsState;
let __wsIsSocket;
let __wsDispatchMessage;
let __wsDispatchClose;
// A hibernatable socket's peer sent its Close, which `webSocketClose`
// answers: the socket is CLOSING until it does.
let __wsReceivedClose;
let __wsStartPump;
let __wsFlushPending;
let __wsCheckOwner;
// The options of a socket made with none.
const __WS_NO_INIT = Object.freeze({ __proto__: null });
// A Durable Object socket target as host JSON, from its own fields only.
const __wsTargetJson = (target) => {
  let out = `{"id":${Number(target.id)},"scope":${__jsonString(target.scope)}`;
  if (target.tunnel !== undefined && target.tunnel !== null)
    out += `,"tunnel":${Number(target.tunnel)}`;
  return out + "}";
};
// A target from a host result, copied into a null-prototype object so that
// reading it later consults nothing a Worker can change.
const __wsTargetFrom = (raw) => {
  const target = { __proto__: null, id: __own(raw, "id"), scope: __own(raw, "scope") };
  const tunnel = __own(raw, "tunnel");
  if (tunnel !== undefined && tunnel !== null) target.tunnel = tunnel;
  return target;
};
// Assign a pair's id. Both ends name the same host socket.
const __wsSetId = (state, id) => {
  state.id = id;
  if (state.peer !== null) __wsState(state.peer).id = id;
};
const __WebSocket = globalThis.WebSocket = class WebSocket extends EventTarget {
  // The spec names, which workerd exposes and real bundles use. celld only
  // had the READY_STATE_* aliases, which no other runtime defines.
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static READY_STATE_CONNECTING = 0;
  static READY_STATE_OPEN = 1;
  static READY_STATE_CLOSING = 2;
  static READY_STATE_CLOSED = 3;
  // All of a socket's state. Private, so application code can neither read
  // nor write the host id, the peer, the target or the owner.
  #s;
  static {
    __recordBase(this);
    __wsState = (value) => {
      if (value === null || (typeof value !== "object" && typeof value !== "function") ||
          !(#s in value))
        throw new TypeError("Illegal invocation: the value is not a WebSocket");
      return value.#s;
    };
    __wsIsSocket = (value) =>
      value !== null && (typeof value === "object" || typeof value === "function") &&
      #s in value;
    __wsDispatchMessage = (socket, data) => socket.#dispatchMessage(data);
    __wsDispatchClose = (socket, code, reason, wasClean) =>
      socket.#dispatchClose(code, reason, wasClean);
    __wsReceivedClose = (socket) => {
      const s = socket.#s;
      if (s.closedIncoming || s.readyState === __WS_CLOSED) return;
      s.closedIncoming = true;
      s.readyState = s.closedOutgoing ? __WS_CLOSED : __WS_CLOSING;
    };
    __wsStartPump = (socket) => socket.#startPump();
    __wsFlushPending = (socket) => socket.#flushPending();
    __wsCheckOwner = (socket) => socket.#checkOwner();
  }
  constructor(url, protocols = []) {
    // Internal sockets come from `__wsCreate` only. Every other `new` dials,
    // and its first argument is a URL, as in workerd: a number is not a
    // socket id.
    const internal = __wsInit;
    __wsInit = null;
    const set = __pinBase(WebSocket);
    try {
      super();
    } finally {
      __unpinBase(WebSocket, set);
    }
    const dialed = internal === null;
    // Internal options are null-prototype objects, so nothing a Worker puts
    // on Object.prototype supplies a missing one.
    const init = internal ?? __WS_NO_INIT;
    const bound = init.bound ?? null;
    // A socket bound to a Durable Object's socket behaves like a dialed one
    // in every way that matters here: the host carries its frames, so every
    // operation goes out through `__ws_*` on this id rather than to a peer
    // in this heap.
    const outbound = dialed || bound !== null || init.outbound === true;
    const s = {
      // The host id. 0 until the host registers the socket: a dialed one
      // here, a bound one at `accept()`, a pair when it is accepted or
      // returned.
      id: init.id ?? 0,
      // The token of the code that made the socket. Another request or
      // Durable Object that uses it gets workerd's cross-request error.
      owner: __ws_owner(),
      // Set once the socket leaves in a response. Its other end then belongs
      // to whoever receives that response, and this one cannot be accepted.
      returned: false,
      outbound,
      boundTarget: bound,
      bound: false,
      pendingClose: null,
      attachment: undefined,
      // The Durable Object socket a 101 response names, `{id, scope}`.
      target: bound,
      accepted: false,
      hibernatable: false,
      tags: [],
      pending: [],
      // The other end of a pair.
      peer: null,
      // The other end of an in-isolate upgrade (a WebSocketPair served
      // over a same-script service binding); frames route to it
      // directly instead of through the host connection.
      loopback: null,
      // The caller drives a bound socket itself, exactly as a Worker drives
      // one it opened. The host pipe is not built until `accept()`, so a
      // response passed straight back out is left alone.
      polled: bound !== null || init.polled === true,
      // `new WebSocket(url)` made it. Any other socket sends nothing until
      // it is accepted.
      dialed,
      pumping: false,
      pumpDone: undefined,
      // The token of a Worker socket that a subrequest's 101 handed over,
      // until `accept()` binds it. The token alone grants nothing: the host
      // lets only the request that made the call adopt and take it.
      handoff: init.handoff,
      // Such a socket once accepted, which a response can no longer carry.
      handoffAccepted: false,
      readyState: init.readyState ?? (outbound ? __WS_CONNECTING : __WS_OPEN),
      // Whether this end has sent its Close, and received its peer's. Each
      // direction closes on its own, as in workerd: an end that has one but
      // not the other is CLOSING.
      closedOutgoing: false,
      closedIncoming: false,
      // Whether a Close from the peer leaves this end half-open until the
      // Worker calls close(), rather than replying at once
      // (`web_socket_auto_reply_to_close`, or `accept({allowHalfOpen})`).
      allowHalfOpen: !__cell.compat?.webSocketAutoReplyToClose,
      binaryType: __cell.compat?.websocketStandardBinaryType ? "blob" : "arraybuffer",
      // A server-side socket has no URL, and reports null rather than an
      // empty string -- workerd's inspect output pins this. A socket that
      // came back from an upgrade has none either: nothing in this isolate
      // dialed it.
      url: init.url ?? null,
      protocol: "",
      extensions: "",
    };
    this.#s = s;
    if (!dialed) return;
    const target = String(url);
    // workerd validates the URL in the constructor and throws synchronously;
    // letting the connector reject later would surface a scheme mistake as a
    // network failure instead of a TypeError.
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      throw new DOMException(
        "WebSocket Constructor: The url is invalid.",
        "SyntaxError");
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new DOMException(
        "WebSocket Constructor: The url scheme must be ws or wss.",
        "SyntaxError");
    }
    s.url = target;
    // A Durable Object socket is pushed events by the host so it can revive
    // a hibernated cell. A Worker socket has no cell: the isolate polls it,
    // and it lives and dies with the request, which is the lifetime
    // Cloudflare gives one too.
    const scope = __currentActorScope();
    s.polled = !scope;
    const requested = typeof protocols === "string"
      ? [protocols]
      : __ArrayFrom(protocols, String);
    for (const value of requested) {
      // RFC 6455 subprotocols are HTTP tokens; a space or separator would
      // otherwise be smuggled into the Sec-WebSocket-Protocol header.
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)) {
        throw new DOMException(
          `WebSocket Constructor: The subprotocol '${value}' is invalid.`,
          "SyntaxError");
      }
    }
    if (new Set(requested).size !== requested.length) {
      throw new DOMException(
        "WebSocket Constructor: The subprotocols must be unique.",
        "SyntaxError");
    }
    const dial = __ws_connect(target, __jsonStringList(requested));
    s.id = dial.id;
    __socketSet(s.id, this);
    const connection = dial.ready;
    __registerWaitUntil(connection);
    if (s.polled) this.#startPump();
    // The egress policy's refusal arrives as an outcome, so that it can
    // reach the error event as the TypeError fetch() would throw.
    const opened = connection.then((raw) => {
      const outcome = __jsonParse(raw);
      if (outcome.refused !== undefined) throw new TypeError(outcome.refused);
      return outcome.protocol;
    });
    opened.then((protocol) => {
      if (s.readyState === __WS_CLOSING) {
        if (s.pendingClose) {
          const [code, reason] = s.pendingClose;
          __ws_close(s.id, code, reason);
        }
        return;
      }
      if (s.readyState !== __WS_CONNECTING) return;
      s.protocol = protocol;
      s.readyState = __WS_OPEN;
      this.dispatchEvent(new Event("open"));
    }, (error) => {
      if (s.readyState === __WS_CLOSED) return;
      s.readyState = __WS_CLOSED;
      __socketDelete(s.id);
      // The connection's own error, then the abnormal close. Not through
      // #dispatchClose, which returns for a closed socket and would add its
      // generic error event: a failed dial fired the error and never the close.
      this.dispatchEvent(new ErrorEvent("error", { message: String(error?.message || error), error }));
      const event = new CloseEvent("close", { code: 1006, reason: "", wasClean: false });
      event._trust();
      this.dispatchEvent(event);
    });
  }
  // A socket that a pair or a response made is OPEN until it closes, as in
  // workerd, even while it waits for accept(): only a dialed one connects.
  get readyState() {
    const s = this.#s;
    return s.readyState === __WS_CONNECTING && !s.dialed ? __WS_OPEN : s.readyState;
  }
  get url() { return this.#s.url; }
  get protocol() { return this.#s.protocol; }
  get extensions() { return this.#s.extensions; }
  get binaryType() { return this.#s.binaryType; }
  // The spec ignores an unrecognised value rather than throwing.
  set binaryType(value) {
    if (value === "blob" || value === "arraybuffer") this.#s.binaryType = value;
  }
  // workerd checks that the running request or Durable Object owns an I/O
  // object before anything else, so a socket from an ended request fails
  // this way rather than as a closed socket. Tokens are odd for a Durable
  // Object and even for a request.
  #checkOwner() {
    const running = __ws_owner();
    const owner = this.#s.owner;
    if (running === owner) return;
    throw running % 2 === 1 && owner % 2 === 1
      ? __crossObjectError()
      : __ctxError("Native");
  }
  // The pump ends only when the socket closes, so it must NOT be registered
  // as waitUntil work: that would hold the request open for as long as the
  // socket lives, and the host reclaims an abandoned socket only once the
  // request has retired. Its `__ws_next` ops are driven while the request
  // runs and normally resolve with the host's 1001 "request ended" close.
  // They resolve as 1006 only if the sender disappears without a close frame.
  #startPump() {
    const s = this.#s;
    if (!s.pumping) {
      s.pumping = true;
      s.pumpDone = this.#pump().catch(() => {});
    }
    return s.pumpDone;
  }
  // Drain the host queue for an isolate-polled socket. Each `__ws_next` is an
  // ordinary async op the request owns; a request that retires with the
  // socket still open closes it, which ends this loop with a close frame.
  async #pump() {
    const s = this.#s;
    for (;;) {
      const frame = await __ws_next(s.id);
      const tag = frame[0];
      const body = frame.subarray(1);
      if (tag === 0) {
        this.#dispatchMessage(new TextDecoder().decode(body));
      } else if (tag === 1) {
        this.#dispatchMessage(
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        );
      } else if (tag === 2) {
        if (s.readyState === __WS_CONNECTING) {
          s.protocol = new TextDecoder().decode(body);
          s.readyState = __WS_OPEN;
          this.dispatchEvent(new Event("open"));
        }
      } else {
        const info = __jsonParse(new TextDecoder().decode(body));
        this.#dispatchClose(info.code, info.reason, info.wasClean);
        return;
      }
    }
  }
  // Deliver whatever this end queued before it had somewhere to send.
  #flushToPeer() {
    const s = this.#s;
    const peer = s.loopback;
    if (!peer) return;
    for (const frame of s.pending.splice(0)) {
      if (frame[0] === "send") {
        queueMicrotask(() => peer.#dispatchMessage(frame[1]));
      } else if (frame[0] === "send-binary") {
        const data = frame[1];
        const bytes = data instanceof ArrayBuffer
          ? data
          : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        queueMicrotask(() => peer.#dispatchMessage(bytes));
      } else {
        queueMicrotask(() => peer.#dispatchClose(frame[1], frame[2], true));
      }
    }
  }
  accept(options) {
    const s = this.#s;
    this.#checkOwner();
    if (s.returned)
      throw new TypeError(
        "Can't accept() WebSocket that was already used in a response.");
    // workerd reads the option only on the first accept().
    if (!s.accepted && options !== undefined && options !== null) {
      const allowHalfOpen = options.allowHalfOpen;
      if (allowHalfOpen !== undefined) s.allowHalfOpen = !!allowHalfOpen;
    }
    const peer = s.peer;
    // A pair used directly, without being returned through a 101 response,
    // still has to carry frames once both ends are accepted. celld only
    // linked a pair on the upgrade path, so such a pair queued forever. The
    // link carries frames inside this heap with no host check, so it joins
    // only a pair that is still wholly this code's: neither end registered
    // with the host nor returned, and both made by the running owner.
    if (peer !== null && peer.#s.accepted && s.loopback === null) {
      const other = peer.#s;
      if (s.id === 0 && other.id === 0 && !other.returned &&
          other.owner === s.owner) {
        s.accepted = true;
        s.loopback = peer;
        other.loopback = this;
        this.#flushToPeer();
        peer.#flushToPeer();
        return;
      }
    }
    // A socket obtained from a `fetch()` upgrade is already connected and
    // delivers nothing until it is accepted; this is where it starts.
    if (s.outbound && s.readyState === __WS_CONNECTING) {
      // Bind before the pump: the op registers this socket's queue on this
      // thread, so the first `__ws_next` cannot run ahead of it. A refused
      // bind throws and leaves the socket as it was.
      if (s.boundTarget !== null && !s.bound) {
        const id = __ws_bind_target(__wsTargetJson(s.boundTarget));
        s.bound = true;
        s.id = id;
      }
      if (s.handoff !== undefined) {
        // The server end is a Worker socket in another isolate. The host
        // bridges it to this socket. A refused bind throws and leaves the
        // socket as it was; a bound one no longer names the server end.
        const scope = __currentActorScope();
        __ws_bind_worker_handoff(s.id, s.handoff);
        s.accepted = true;
        s.handoff = undefined;
        s.handoffAccepted = true;
        s.readyState = __WS_OPEN;
        const pump = this.#startPump();
        // A stateless request ends when its response and waitUntil work do,
        // and its sockets close with it. Workerd keeps a request alive
        // while a socket it accepted is open, which is what a Worker that
        // relays this socket to its own client needs. A Durable Object's
        // event keeps its pending I/O without this.
        if (!scope) __registerWaitUntil(pump);
        return;
      }
      s.accepted = true;
      s.readyState = __WS_OPEN;
      if (s.polled) {
        const pump = this.#startPump();
        // As for a handed-over socket above: a Durable Object's socket that
        // a stateless request accepted keeps that request while it is open.
        if (s.bound && !__currentActorScope()) __registerWaitUntil(pump);
      }
      return;
    }
    s.accepted = true;
  }
  // workerd's refusal of send() and close() on a socket that a pair or a
  // response made and that nothing accepted yet.
  #requireAccepted() {
    const s = this.#s;
    if (!s.dialed && !s.accepted && !s.hibernatable)
      throw new TypeError(
        "You must call one of accept() or state.acceptWebSocket() on this " +
        "WebSocket before sending messages.");
  }
  send(data) {
    const s = this.#s;
    this.#checkOwner();
    // As in workerd, a socket sends until it has sent its own Close: a
    // half-open one, whose peer's Close arrived, still can.
    if (s.closedOutgoing)
      throw new TypeError("Can't call WebSocket send() after close().");
    this.#requireAccepted();
    if (s.readyState !== __WS_OPEN && !(s.readyState === __WS_CLOSING && s.closedIncoming))
      throw new DOMException("WebSocket is not open", "InvalidStateError");
    const binary = data instanceof ArrayBuffer || ArrayBuffer.isView(data);
    const text = binary ? null : String(data);
    if (s.loopback) {
      const peer = s.loopback;
      const message = binary
        ? (data instanceof ArrayBuffer ? data.slice(0) : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
        : text;
      queueMicrotask(() => peer.#dispatchMessage(message));
      return;
    }
    // The pending queue belongs to an inbound pair socket that has been
    // accepted but not yet bound to a host transport. An outbound socket is
    // already bound -- queueing here would silently swallow its frames.
    if (!s.outbound && s.accepted && !s.target) {
      s.pending.push([binary ? "send-binary" : "send", binary ? data : text]);
      return;
    }
    if (binary) {
      const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      __ws_send_binary(s.id, bytes);
    } else {
      __ws_send(s.id, text);
    }
  }
  close(code, reason) {
    const s = this.#s;
    this.#checkOwner();
    // workerd outside its pedantic WPT mode, which celld does not implement:
    // any code from 1000 to 4999, except the four RFC 6455 reserves for
    // reporting and forbids on the wire. The code converts as an int.
    if (code !== undefined) {
      code = Number(code) | 0;
      if (code < 1000 || code >= 5000 || code === 1004 || code === 1005 ||
          code === 1006 || code === 1015) {
        throw new DOMException(
          `Invalid WebSocket close code: ${code}.`, "InvalidAccessError");
      }
    }
    // RFC 6455 5.5: the close frame body is at most 125 bytes, two of which
    // are the code. Measured in UTF-8, so a multibyte reason can exceed the
    // cap at well under 123 characters.
    if (reason !== undefined) {
      reason = String(reason);
      if (new TextEncoder().encode(reason).length > 123) {
        throw new DOMException(
          "WebSocket close reason must not be longer than 123 bytes when UTF-8 encoded.",
          "SyntaxError");
      }
    }
    // Without a code, the Close carries no status, which workerd sends as an
    // empty Close (1005), and so it cannot carry a reason either.
    if (code === undefined) {
      if (reason !== undefined)
        throw new DOMException(
          "If you specify a WebSocket close reason, you must also specify a code.",
          "InvalidAccessError");
      code = 1005;
    }
    if (reason === undefined) reason = "";
    // A second close() does nothing, as in workerd, and neither does one on
    // a socket that has ended. A half-open socket, whose peer's Close has
    // arrived, still sends its own: that reply is the one the peer sees.
    if (s.closedOutgoing || s.readyState === __WS_CLOSED) {
      return;
    }
    this.#requireAccepted();
    const connecting = s.readyState === __WS_CONNECTING;
    s.closedOutgoing = true;
    s.readyState = s.closedIncoming ? __WS_CLOSED : __WS_CLOSING;
    if (s.outbound && connecting) {
      s.pendingClose = [code, reason];
      return;
    }
    if (s.outbound) {
      __ws_close(s.id, code, reason);
      return;
    }
    if (s.loopback) {
      // CLOSING until the peer's reply arrives.
      const peer = s.loopback;
      queueMicrotask(() => peer.#dispatchClose(code, reason, true));
      return;
    }
    // CLOSING until the peer's reply, which the host delivers as this end's
    // close event.
    if (s.accepted && !s.target) {
      s.pending.push(["close", code, reason]);
      return;
    }
    __ws_close(s.id, code, reason);
  }
  // Send a Close without close()'s checks: the automatic reply, which
  // carries the code and reason the peer sent, 1005 (an empty Close) among
  // them.
  #sendClose(code, reason) {
    const s = this.#s;
    if (s.loopback) {
      const peer = s.loopback;
      queueMicrotask(() => peer.#dispatchClose(code, reason, true));
    } else if (!s.outbound && s.accepted && !s.target) {
      s.pending.push(["close", code, reason]);
    } else {
      __ws_close(s.id, code, reason);
    }
  }
  #flushPending() {
    const s = this.#s;
    const pending = s.pending.splice(0);
    for (const frame of pending) {
      if (frame[0] === "send") __ws_send(s.id, frame[1]);
      else if (frame[0] === "send-binary") {
        const data = frame[1];
        const bytes = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        __ws_send_binary(s.id, bytes);
      }
      else __ws_close(s.id, frame[1], frame[2]);
    }
  }
  serializeAttachment(value) {
    const s = this.#s;
    // Structured clone, not JSON: Cloudflare accepts anything cloneable
    // here, so a Date must come back a Date and a Map a Map.
    const bytes = __sc_encode(value);
    s.attachment = value;
    // The attachment is the object's own state, which workerd lets any
    // code that holds the object set. Only the owner stores it with the
    // host for a later wake.
    if (s.owner === __ws_owner()) __ws_attachment_set(s.id, bytes);
  }
  deserializeAttachment() { return this.#s.attachment; }
  #dispatchMessage(data) {
    if (this.#s.binaryType === "blob" && data instanceof ArrayBuffer) {
      data = new Blob([data]);
    }
    const event = new MessageEvent("message", { data });
    event._trust();
    this.dispatchEvent(event);
  }
  // The peer's Close arrived, or the connection ended without one
  // (`wasClean` false). Unless the socket is half-open, it replies with the
  // same code and reason before its close event fires, so it is CLOSED
  // then; a half-open one is CLOSING until the Worker calls close().
  // Workerd web-socket.c++ LegacyWebSocketAdapter::readLoop.
  #dispatchClose(code, reason, wasClean) {
    const s = this.#s;
    if (s.readyState === __WS_CLOSED || s.closedIncoming) return;
    s.closedIncoming = true;
    if (wasClean && !s.allowHalfOpen && !s.closedOutgoing) {
      s.closedOutgoing = true;
      this.#sendClose(code, reason);
    }
    s.readyState = s.closedOutgoing || !wasClean ? __WS_CLOSED : __WS_CLOSING;
    // A half-open socket this isolate polls keeps its request's other work
    // running until it replies, as an open one does, but does not keep the
    // request by itself.
    if (s.readyState === __WS_CLOSING && s.polled && s.id !== 0) __ws_half_open(s.id);
    __socketDelete(s.id);
    // An abnormal closure fires `error` before `close`. Code written against
    // the standard onerror never ran otherwise, which matters most for an
    // outbound socket: its peer is a remote server that can simply vanish.
    if (!wasClean) {
      this.dispatchEvent(new ErrorEvent("error", {
        message: reason
          ? `WebSocket closed abnormally: ${reason}`
          : "WebSocket closed abnormally",
      }));
    }
    const event = new CloseEvent("close", { code, reason, wasClean });
    event._trust();
    this.dispatchEvent(event);
  }
};
// A Worker that replaced WebSocket's prototype could run its own code as the
// `super()` of every socket the harness makes. Subclasses still work: they
// change their own prototype, not this one.
Object.preventExtensions(__WebSocket);
// The internal factory: a socket that names a host socket, a pair end, or
// the client end of a subrequest's upgrade. Never reachable from
// application code, which can only dial.
const __wsCreate = (init) => {
  __wsInit = init;
  try {
    return new __WebSocket();
  } finally {
    __wsInit = null;
  }
};
// The client end of a Durable Object socket that a subrequest's 101 names.
// The host joins it to that socket on `accept()`, under the grant the
// response gave this request.
const __boundSocket = (target) =>
  __wsCreate({ __proto__: null, bound: __wsTargetFrom(target) });
// Take the socket a host response handed over and give it to the running
// request, which releases it when it retires unless it returns the socket
// in a response or accepts it first. Returns the client end for a 101.
const __hostResponseSocket = (r) => {
  const token = __own(r, "wsWorker");
  if (token === undefined) return undefined;
  // The host chooses the id of this end, and registers the bridge under it.
  // Like a Durable Object's socket from a subrequest: the host carries its
  // frames once it is accepted, and until then it is connecting.
  const socket = __wsCreate({
    __proto__: null,
    id: __ws_adopt_worker_handoff(token),
    outbound: true,
    polled: true,
    readyState: __WS_CONNECTING,
    handoff: token,
  });
  return __own(r, "status") === 101 ? socket : undefined;
};
// The socket a host response to a subrequest carries: the client end of a
// Durable Object's socket, or a handed-over Worker socket.
const __responseSocket = (r) => {
  const target = __own(r, "wsTarget");
  return __own(r, "status") === 101 && target
    ? __boundSocket(target)
    : __hostResponseSocket(r);
};
const __isHandoffSocket = (socket) => {
  const s = __wsState(socket);
  return s.handoff !== undefined || s.handoffAccepted;
};
const __socketFromRow = (row) => {
  const id = Number(__own(row, "id"));
  let ws = __socketGet(id);
  if (!ws) {
    ws = __wsCreate({ __proto__: null, id });
    __socketSet(id, ws);
  }
  const s = __wsState(ws);
  s.tags = __own(row, "tags") || [];
  s.hibernatable = true;
  const attachment = __own(row, "attachment");
  if (attachment != null) {
    try {
      s.attachment = __sc_decode(new Uint8Array(attachment));
    } catch {
      s.attachment = undefined;
    }
  }
  return ws;
};
// Workerd's api::WebSocketRequestResponsePair (websocket.h): an immutable
// request/response pair for state.setWebSocketAutoResponse.
globalThis.WebSocketRequestResponsePair =
  class WebSocketRequestResponsePair {
    #request;
    #response;
    constructor(request, response) {
      this.#request = String(request);
      this.#response = String(response);
    }
    get request() { return this.#request; }
    get response() { return this.#response; }
  };
globalThis.WebSocketPair = function WebSocketPair() {
  // Both ends take the id the host allocates when one of them is registered:
  // accepted by a Durable Object, or returned by a Worker.
  const client = __wsCreate({ __proto__: null });
  const server = __wsCreate({ __proto__: null });
  __wsState(client).peer = server;
  __wsState(server).peer = client;
  // Indexed AND iterable: `const [client, server] = new WebSocketPair()` is
  // the form most Cloudflare code uses.
  return {
    0: client,
    1: server,
    length: 2,
    [Symbol.iterator]() {
      return [client, server][Symbol.iterator]();
    },
  };
};
// Cloudflare exposes the time of the last I/O, not a clock that advances
// while JavaScript runs. Keep Date and performance on one turn timestamp so
// neither becomes a timing side channel and the two APIs cannot disagree.
const __NativeDate = Date;
let __ioTimestamp = 0;
const __CloudflareDate = function Date(...args) {
  if (new.target) {
    return Reflect.construct(
      __NativeDate,
      args.length === 0 ? [__ioTimestamp] : args,
      new.target,
    );
  }
  return new __NativeDate(__ioTimestamp).toString();
};
Object.defineProperties(__CloudflareDate, {
  length: { value: 7 },
  prototype: { value: __NativeDate.prototype },
  now: {
    value: () => __ioTimestamp,
    writable: true,
    configurable: true,
  },
  parse: {
    value: __NativeDate.parse,
    writable: true,
    configurable: true,
  },
  UTC: {
    value: __NativeDate.UTC,
    writable: true,
    configurable: true,
  },
});
Object.defineProperty(__NativeDate.prototype, "constructor", {
  value: __CloudflareDate,
  writable: true,
  configurable: true,
});
globalThis.Date = __CloudflareDate;
globalThis.performance = {
  now: () => __ioTimestamp,
  timeOrigin: 0,
  mark() {},
  measure() {},
};
__celld.__advanceIoTime = (timestamp) => {
  __ioTimestamp = timestamp;
};
// Workerd ServiceWorkerGlobalScope: `self` is the global scope, as a writable,
// enumerable data property. Libraries probe it to find the global, and
// @cloudflare/worker-bundler throws when it is absent.
globalThis.self = globalThis;
if (!globalThis.navigator) globalThis.navigator = {
  userAgent: "Cloudflare-Workers", hardwareConcurrency: 1,
  language: "en", languages: ["en"],
};
if (!globalThis.queueMicrotask)
  globalThis.queueMicrotask = (f) => Promise.resolve().then(f);
// workerd's `Scheduler` (src/workerd/api/basics.h) has `wait` alone. Its
// arguments convert as JSG converts them, and a bad one rejects rather than
// throws, because the method returns a promise. An abort rejects with the
// signal's reason itself; workerd's rejection is a copy rebuilt from the
// reason's name and message (docs/cloudflare-compat.md).
if (!globalThis.scheduler) {
  const AbortSignal_ = globalThis.AbortSignal;
  globalThis.scheduler = {
    wait(delay, options) {
      const argumentCount = arguments.length;
      return new Promise((resolve, reject) => {
        if (argumentCount === 0)
          throw new TypeError(
            "Failed to execute 'wait' on 'Scheduler': parameter 1 is not of type 'number'.");
        const ms = +delay;
        let signal;
        if (options !== undefined && options !== null) {
          if (typeof options !== "object" && typeof options !== "function")
            throw new TypeError(
              "Failed to execute 'wait' on 'Scheduler': parameter 2 is not of type 'WaitOptions'.");
          signal = options.signal;
          if (signal !== undefined && !(signal instanceof AbortSignal_))
            throw new TypeError(
              "Incorrect type for the 'signal' field on 'WaitOptions': " +
              "the provided value is not of type 'AbortSignal'.");
        }
        if (signal === undefined) {
          setTimeout(resolve, ms);
          return;
        }
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const onAbort = () => {
          clearTimeout(id);
          reject(signal.reason);
        };
        const id = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
if (!globalThis.structuredClone) {
  const hostBrand = Symbol("Cells.structuredCloneHost");
  const deserializers = {
    Blob: (data) => new Blob([data.bytes], { type: data.mimeType }),
    File: (data) => new File([data.bytes], data.name, {
      type: data.mimeType,
      lastModified: data.lastModified,
    }),
    CryptoKey: (data) => new CryptoKey(
      data.keyType, data.algorithm, data.extractable, data.usages, data.material),
    DOMException: (data) => {
      const exception = new DOMException(data.message, data.name);
      if (data.stack !== undefined)
        Object.defineProperty(exception, "stack", {
          value: data.stack, configurable: true, writable: true,
        });
      return exception;
    },
  };
  const defineHostType = (prototype, serialize) => {
    if (!Object.prototype.hasOwnProperty.call(prototype, hostBrand))
      Object.defineProperty(prototype, hostBrand, { value: serialize });
  };
  const defineUnsupportedType = (constructor) => {
    if (typeof constructor === "function")
      defineHostType(constructor.prototype, null);
  };

  defineHostType(Blob.prototype, function() {
    return {
      type: "Blob", bytes: __blobBytesOf(this),
      mimeType: this.type,
    };
  });
  defineHostType(File.prototype, function() {
    return {
      type: "File", bytes: __blobBytesOf(this),
      mimeType: this.type, name: this.name,
      lastModified: this.lastModified,
    };
  });
  defineHostType(DOMException.prototype, function() {
    return {
      type: "DOMException", message: this.message,
      name: this.name, stack: this.stack,
    };
  });

  globalThis.structuredClone = function(value, options) {
    if (arguments.length < 1)
      throw new TypeError(
        "Failed to execute 'structuredClone': 1 argument required");
    const transfer = options?.transfer === undefined
      ? [] : Array.from(options.transfer);
    const seen = new Set();
    for (let index = 0; index < transfer.length; index++) {
      const item = transfer[index];
      if (!(item instanceof ArrayBuffer))
        throw new DOMException(
          `Value at index ${index} is not transferable`, "DataCloneError");
      if (item.detached)
        throw new DOMException(
          `ArrayBuffer at index ${index} is already detached`,
          "DataCloneError");
      if (seen.has(item))
        throw new DOMException(
          `ArrayBuffer at index ${index} is a duplicate`, "DataCloneError");
      seen.add(item);
    }

    // Crypto loads after this harness, and MessagePort is also installed by a
    // later bootstrap script. Register every late type before V8 traverses the
    // graph. The delegate then sees host objects at any depth without a second
    // JavaScript traversal, which follows Deno's structured-clone design.
    if (typeof CryptoKey === "function")
      defineHostType(CryptoKey.prototype, function() {
        return {
          type: "CryptoKey", keyType: this.type,
          algorithm: this.algorithm, extractable: this.extractable,
          usages: this.usages, material: this.__celldMaterial,
        };
      });
    for (const constructor of [
      URL, URLSearchParams, Headers, FormData, Request, Response,
      typeof MessagePort === "function" ? MessagePort : undefined,
    ]) defineUnsupportedType(constructor);

    let result;
    try {
      result = __structured_clone(value, hostBrand, deserializers);
    } catch (error) {
      if (error instanceof TypeError)
        throw new DOMException(error.message, "DataCloneError");
      throw error;
    }
    // A clone of a resizable buffer commits outside the allocator, so the
    // clone is kept only if the isolate's memory still fits, as a buffer the
    // allocator refused would not be.
    if (!__memory_admit(0, false))
      throw new RangeError("Array buffer allocation failed");
    // Validate the complete list and clone the value before detaching any
    // source. A later invalid entry therefore cannot leave an earlier buffer
    // detached after the operation fails.
    for (const item of transfer) item.transfer();
    return result;
  };
}
// Web Crypto is installed after the rest of the harness so it can use
// DOMException, structuredClone, and Buffer.
// `process.env` follows workerd's src/node/internal/internal_process.ts at
// v1.20261001.1: Node's rules, so whatever is stored reads back as a string,
// and a descriptor must be a plain, writable, enumerable, configurable value.
const __processEnvTarget = {};
// node:util's ERR_INVALID_ARG_VALUE, loading that module on first use.
const __processEnvError = (name, value, reason) => {
  __builtin_module("node:util");
  return new __celld.__utilErrors.ERR_INVALID_ARG_VALUE(name, value, reason);
};
const __processEnv = new Proxy(__processEnvTarget, {
  set(target, prop, value) {
    if (typeof prop === "symbol" || typeof value === "symbol")
      throw new TypeError("Cannot convert a symbol value to a string");
    return Reflect.set(target, prop, `${value}`);
  },
  defineProperty(target, prop, descriptor) {
    if (Reflect.has(descriptor, "get") || Reflect.has(descriptor, "set"))
      throw __processEnvError("descriptor", descriptor,
        "process.env value must not have getter/setter");
    for (const field of ["configurable", "enumerable", "writable"]) {
      if (!descriptor[field])
        throw __processEnvError(`descriptor.${field}`, descriptor,
          `process.env value must be ${field}`);
    }
    if (!Reflect.has(descriptor, "value"))
      throw __processEnvError("descriptor.value", descriptor,
        "process.env value must be specified explicitly");
    if (typeof prop === "symbol" || typeof descriptor.value === "symbol")
      throw new TypeError("Cannot convert a symbol value to a string");
    descriptor.value = `${descriptor.value}`;
    return Reflect.defineProperty(target, prop, descriptor);
  },
});
// Whether JSON carries `value` without losing anything: no cycles or aliases,
// and only plain objects and arrays (workerd's isJsonSerializable). A binding
// object, such as a service binding, is left out rather than read as "{}".
const __jsonSerializable = (value, seen = new Set()) => {
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return true;
    case "object":
      if (value === null) return true;
      if (seen.has(value)) return false;
      seen.add(value);
      switch (Object.getPrototypeOf(value)) {
        case Object.prototype:
          return Object.values(value).every(
            (item) => __jsonSerializable(item, seen));
        case Array.prototype:
          return value.every((item) => __jsonSerializable(item, seen));
        default:
          return false;
      }
    default:
      return false;
  }
};
// `nodejs_compat_populate_process_env`, before the main module evaluates:
// copy the env installed so far (a loaded Worker's own `env`) and then
// `vars`, a [name, value] list, as workerd's getInitialEnv copies `env`. A
// string stays as it is, a value JSON can carry becomes its JSON text, and
// anything else is left out.
__celld.__populateProcessEnv = (vars) => {
  for (const [name, value] of [...Object.entries(__cell.env), ...vars]) {
    if (typeof value === "string") __processEnvTarget[name] = value;
    else if (__jsonSerializable(value))
      __processEnvTarget[name] = JSON.stringify(value);
  }
};
// A Node dependency reads a `process` field at module scope and passes it
// straight to something that rejects `undefined` -- `dirname(process.execPath)`
// is one such case. Workerd defines every field
// below with a neutral value, so the same bundle evaluates there. A missing
// field therefore fails the whole Worker at load, which is why each one is
// defined even though nothing in a cell has an executable path, a parent
// process, or a real exit code. The values match workerd's
// `src/node/internal/public_process.ts` at workerd revision 04a08513a419
// (2026-09-04); celld does not invent its own, because a dependency that reads
// them is comparing them to what workerd reports. A field whose workerd
// implementation throws at that revision -- `kill`, `binding`, `dlopen`,
// `cpuUsage` -- stays absent, because it fails on both runtimes and a stub
// here would only change the message.
if (!globalThis.process) globalThis.process = {
  env: __processEnv, platform: "linux", arch: "x64", version: "v20.0.0",
  versions: { node: "20.0.0" }, cwd: () => "/",
  title: "workerd", argv: ["workerd"], argv0: "workerd", execArgv: [],
  execPath: "", pid: 1, ppid: 0, exitCode: undefined,
  allowedNodeEnvironmentFlags: new Set(),
  release: { name: "node", lts: true, sourceUrl: "", headersUrl: "" },
  channel: null, connected: false, debugPort: 0, domain: null,
  noDeprecation: false, traceDeprecation: false, throwDeprecation: false,
  sourceMapsEnabled: false, moduleLoadList: [],
  stdin: { fd: 0, isTTY: false },
  stdout: { fd: 1, isTTY: false, write: (s) => { __log(String(s)); return true; } },
  stderr: { fd: 2, isTTY: false, write: (s) => { __log(String(s)); return true; } },
  nextTick: (f, ...a) => queueMicrotask(() => f(...a)),
  on() {}, once() {}, off() {}, emit() {}, hrtime: () => [0, 0],
  // Workerd routes a warning to the process 'warning' event, and this
  // process emits nothing, so a no-op keeps the two runtimes equivalent.
  emitWarning() {},
  ref() {}, unref() {}, uptime: () => 0,
  constrainedMemory: () => 0, availableMemory: () => 0,
  memoryUsage: () => ({
    rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0,
  }),
};
globalThis.process.exit = (code = 0) => {
  const actorScope = __currentActorScope();
  if (actorScope) {
    const instance = __cell.instances[actorScope];
    const state = __instanceState(instance);
    if (state !== undefined)
      __objectState.resetAfterConcurrencyFailure(state);
  }
  __process_exit(Number(code) || 0, actorScope);
};
globalThis.process.getBuiltinModule =
  (id) => __builtin_module(String(id));
// `node:process` and `process` resolve to this object (modules.rs).
__celld.__process = globalThis.process;
if (!globalThis.global) globalThis.global = globalThis;
// Events belong to the request, and the host owns the request. `__event_*`
// and `__wait_until` operate on whichever context the host has made current
// for this turn, so nothing here has to know which request is running -- and
// two requests sharing an isolate cannot pop each other's events.
const __registerWaitUntil = __celld.__registerWaitUntil = (promise) => {
  const tracked = Promise.resolve(promise).catch((error) => {
    console.error("waitUntil rejected", error);
  });
  __wait_until(tracked);
};
// `props` are the per-stub props a loopback service stub carries
// (ctx.props); `exports` is built once, on first access.
// An invocation without props gets its own empty object: `ctx.props` is
// writable, so one shared object would carry one call's changes to the next.
const __entrypointContext = (props = {}) => {
  const ctx = __withCtxRestore({
    waitUntil: __registerWaitUntil,
    passThroughOnException() {},
    abort: __ctxAbortCurrent,
    props,
    get exports() { return __ctxExports(); },
  });
  __celld.__defineContextTracing(ctx);
  return ctx;
};
const __beginEvent = __celld.__beginEvent = (props = {}) => {
  __rpcSignalRefresh();
  __event_begin();
  return __entrypointContext(props);
};
const __endEvent = __celld.__endEvent = () => __event_end();
// Workerd's writable filesystem is memory-backed and request-scoped. The
// native IoContext owns the directory tree; this facade supplies Node's path,
// error, Promise, and Stats shapes without exposing a host filesystem.
const __fsPath = (value) => {
  if (value instanceof URL) {
    if (value.protocol !== "file:") {
      const error = new TypeError('The URL must be of scheme file');
      error.code = "ERR_INVALID_URL_SCHEME";
      throw error;
    }
    value = decodeURIComponent(value.pathname);
  } else if (globalThis.Buffer?.isBuffer(value)) {
    value = value.toString();
  } else if (typeof value !== "string") {
    const error = new TypeError(
      'The "path" argument must be of type string or an instance of Buffer or URL',
    );
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  if (value.includes("\0")) {
    const error = new TypeError('The argument "path" must not contain null bytes');
    error.code = "ERR_INVALID_ARG_VALUE";
    throw error;
  }
  const absolute = value.startsWith("/") ? value : process.cwd() + "/" + value;
  const parts = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
};
const __fsError = (code, syscall, path) => {
  const e = new Error(`${code}: ${syscall} '${path}'`);
  e.errno = { EPERM: -1, ENOENT: -2, EEXIST: -17, ENOTDIR: -20 }[code];
  e.code = code;
  e.syscall = syscall;
  e.path = path;
  return e;
};
const __enoent = (path = "") => { throw __fsError("ENOENT", "open", path); };
const __fsStatsBadge = Symbol("fs.Stats");
class __FsStats {
  constructor(badge, kind, size, bigint) {
    if (badge !== __fsStatsBadge) throw new TypeError("Illegal constructor");
    const file = kind === 3;
    this.dev = 0;
    this.ino = 0;
    // A bundle file is 0o100444 and a writable temporary directory is 0o40666,
    // matching the mode values workerd's fs-stat-test.js asserts.
    this.mode = (file ? 0o100000 : 0o40000) | 0o444 | (kind === 2 ? 0o222 : 0);
    this.nlink = 1;
    this.uid = 0;
    this.gid = 0;
    this.rdev = 0;
    this.size = size;
    this.blksize = 0;
    this.blocks = 0;
    this.atimeMs = this.mtimeMs = this.ctimeMs = this.birthtimeMs = 0;
    this.atime = new Date(0);
    this.mtime = new Date(0);
    this.ctime = new Date(0);
    this.birthtime = new Date(0);
    Object.defineProperty(this, "__kind", { value: file ? "file" : "directory" });
    if (bigint) {
      for (const name of [
        "dev", "ino", "mode", "nlink", "uid", "gid", "rdev", "size",
        "blksize", "blocks", "atimeMs", "mtimeMs", "ctimeMs", "birthtimeMs",
      ]) this[name] = BigInt(this[name]);
      this.atimeNs = 0n;
      this.mtimeNs = 0n;
      this.ctimeNs = 0n;
      this.birthtimeNs = 0n;
    }
  }
  isFile() { return this.__kind === "file"; }
  isDirectory() { return this.__kind === "directory"; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
  isSymbolicLink() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
}
const __fsOptions = (options, names) => {
  if (options === undefined) return {};
  if (options === null || typeof options !== "object") {
    const error = new TypeError('The "options" argument must be of type object');
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  for (const name of names) {
    if (options[name] !== undefined && typeof options[name] !== "boolean") {
      const error = new TypeError(`The "options.${name}" property must be of type boolean`);
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
  }
  return options;
};
const __fsMkdirSync = (value, options = {}) => {
  const path = __fsPath(value);
  if (typeof options === "number") options = { mode: options };
  options = __fsOptions(options, ["recursive"]);
  const result = __vfs_mkdir(path, options.recursive === true);
  if (result && !result.startsWith("/")) throw __fsError(result, "mkdir", path);
  return result || undefined;
};
const __fsStatSync = (value, options, syscall = "stat") => {
  const path = __fsPath(value);
  options = __fsOptions(options, ["bigint", "throwIfNoEntry"]);
  const [kind, size] = __vfs_stat(path);
  if (!kind) {
    if (options.throwIfNoEntry === false) return undefined;
    throw __fsError("ENOENT", syscall, path);
  }
  return new __FsStats(__fsStatsBadge, kind, size, options.bigint === true);
};
const __fsLstatSync = (value, options) => __fsStatSync(value, options, "lstat");
const __fsRealpathSync = (value) => {
  const path = __fsPath(value);
  if (!__vfs_stat(path)[0]) throw __fsError("ENOENT", "realpath", path);
  return path;
};
const __fsExistsSync = (value) => {
  try { return __vfs_stat(__fsPath(value))[0] !== 0; }
  catch { return false; }
};
// Node returns a Buffer unless an encoding is given, as a string or as
// `options.encoding`. Only `utf8` is decoded here; any other encoding falls
// through to Buffer's own decoder.
const __fsReadFileSync = (value, options) => {
  const path = __fsPath(value);
  const encoding = typeof options === "string" ? options : options?.encoding;
  const bytes = __vfs_read_file(path);
  if (bytes === undefined) {
    // A directory read fails differently from a missing path, so the stat
    // decides which error the caller sees.
    if (__vfs_stat(path)[0]) throw __fsError("EISDIR", "read", path);
    throw __fsError("ENOENT", "open", path);
  }
  const buffer = Buffer.from(bytes);
  return encoding ? buffer.toString(encoding) : buffer;
};
// `fs.constants`, with the four access modes from workerd's
// `src/node/internal/internal_fs_constants.ts`. The table carries only the
// modes `access` reads. Every other constant belongs to an operation the
// virtual filesystem does not implement, and that operation already fails
// loudly at the unimplemented-builtin stub, so publishing its constants would
// only make a caller build a mode for a call it cannot make.
const __fsConstants = Object.freeze({ F_OK: 0, X_OK: 1, W_OK: 2, R_OK: 4 });
// Node validates a mode before it reaches the filesystem, so a bad mode is an
// argument error and never a filesystem error. The range is the union of the
// four access modes, which is what workerd's `validateMode` allows.
const __fsMode = (mode) => {
  if (mode === undefined) return __fsConstants.F_OK;
  if (typeof mode !== "number") {
    const error = new TypeError('The "mode" argument must be of type number');
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  if (!Number.isInteger(mode) || mode < 0 || mode > 7) {
    const error = new RangeError(
      `The value of "mode" is out of range. It must be >= 0 && <= 7. Received ${mode}`,
    );
    error.code = "ERR_OUT_OF_RANGE";
    throw error;
  }
  return mode;
};
// `access` reports what the virtual filesystem can do and not a POSIX
// permission, so it follows workerd's `accessSyncImpl`: no file is executable,
// therefore `X_OK` always fails, and an unwritable path fails exactly like a
// missing one, so a caller cannot tell the two apart. Kind 2 is the writable
// tree; see `op_vfs_stat`.
const __fsAccessSync = (value, mode) => {
  const path = __fsPath(value);
  mode = __fsMode(mode);
  const [kind] = __vfs_stat(path);
  const denied = mode & __fsConstants.X_OK
    || !kind
    || (mode & __fsConstants.W_OK && kind !== 2);
  if (denied) throw __fsError("ENOENT", "access", path);
};
// The callback forms run the same synchronous core as `fs.promises`.
// Validation and the operation are separate arguments, not one function,
// because they fail differently: an argument error throws, and only a
// filesystem error reaches the callback. One combined body would route both to
// the callback and hide a caller's bug behind an error it did not expect.
//
// `validate()` runs before the callback check, which is workerd's order: each
// entry point in `internal_fs_callback.ts` validates its path and its options,
// and only then calls `callWithSingleArgCallback`. Node checks the callback
// first, so a call that has a bad path and no callback reports the path here
// and reports the callback in Node. Both are `ERR_INVALID_ARG_TYPE`, and the
// runtime follows workerd.
const __fsDeliver = (validate, run, callback, deliver) => {
  validate();
  if (typeof callback !== "function") {
    const error = new TypeError('The "cb" argument must be of type function');
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  let result;
  try {
    result = run();
  } catch (error) {
    // A callback delivered in this turn would let a caller observe the result
    // before its own call returned, which Node never does.
    queueMicrotask(() => callback(error));
    return;
  }
  queueMicrotask(() => deliver(result));
};
// An operation with a result calls back with `(error, result)`, and one
// without calls back with `(error)` alone. Workerd splits the two the same way
// (`callWithSingleArgCallback` and `callWithErrorOnlyCallback`), because a
// caller can read `arguments.length` and see the difference.
const __fsCallback = (validate, run, callback) =>
  __fsDeliver(validate, run, callback, (result) => callback(null, result));
const __fsErrorOnlyCallback = (validate, run, callback) =>
  __fsDeliver(validate, run, callback, () => callback(null));
// Node accepts `(path, callback)` or `(path, options, callback)` everywhere.
const __fsCallbackArgs = (options, callback) =>
  typeof options === "function" ? [undefined, options] : [options, callback];
const __fsAccess = (value, mode, callback) => {
  [mode, callback] = __fsCallbackArgs(mode, callback);
  __fsErrorOnlyCallback(
    () => { __fsPath(value); __fsMode(mode); },
    () => __fsAccessSync(value, mode),
    callback,
  );
};
const __fsStat = (value, options, callback) => {
  [options, callback] = __fsCallbackArgs(options, callback);
  __fsCallback(
    () => { __fsPath(value); __fsOptions(options, ["bigint", "throwIfNoEntry"]); },
    () => __fsStatSync(value, options),
    callback,
  );
};
const __fsLstat = (value, options, callback) => {
  [options, callback] = __fsCallbackArgs(options, callback);
  __fsCallback(
    () => { __fsPath(value); __fsOptions(options, ["bigint", "throwIfNoEntry"]); },
    () => __fsLstatSync(value, options),
    callback,
  );
};
const __fsRealpath = (value, options, callback) => {
  [options, callback] = __fsCallbackArgs(options, callback);
  __fsCallback(
    () => __fsPath(value),
    () => __fsRealpathSync(value),
    callback,
  );
};
const __fsReadFile = (value, options, callback) => {
  [options, callback] = __fsCallbackArgs(options, callback);
  __fsCallback(
    () => __fsPath(value),
    () => __fsReadFileSync(value, options),
    callback,
  );
};
const __fsMkdir = (value, options, callback) => {
  [options, callback] = __fsCallbackArgs(options, callback);
  __fsCallback(
    () => {
      __fsPath(value);
      // A number is the mode, which `mkdirSync` validates but does not apply.
      if (typeof options !== "number") __fsOptions(options, ["recursive"]);
    },
    () => __fsMkdirSync(value, options),
    callback,
  );
};
const __fsPromisesSurface = {
  // The promise form validates inside the promise, so an argument error
  // rejects instead of throwing. Workerd makes the same split, because a
  // caller of a promise API has no synchronous frame to catch.
  async access(...args) { return __fsAccessSync(...args); },
  async mkdir(...args) { return __fsMkdirSync(...args); },
  async stat(...args) { return __fsStatSync(...args); },
  async lstat(...args) { return __fsLstatSync(...args); },
  async realpath(...args) { return __fsRealpathSync(...args); },
  async readFile(...args) { return __fsReadFileSync(...args); },
};
// A namespace import gets a fixed export set when V8 links the module, so a
// partial module must enumerate unsupported Node exports too. A get trap alone
// keeps default and named imports loud but silently omits these names from a
// namespace. Keep the unsupported names lazy: materializing every stub in
// every isolate would charge Workers that use only the implemented subset.
const __fsNamespaceProxy = (surface, path, names, enoentNames = []) => {
  const namespaceNames = new Set([...Reflect.ownKeys(surface), ...names]);
  const enoentNameSet = new Set(enoentNames);
  return new Proxy(surface, {
    get: (target, p) => {
      if (Reflect.has(target, p)) return Reflect.get(target, p);
      if (enoentNameSet.has(p)) return __enoent;
      if (typeof p !== "string") return undefined;
      return __nodeStubFor(path + "." + p);
    },
    ownKeys: () => [...namespaceNames],
    // A lazy name has no descriptor on the target, so the synthetic one below
    // completes to `writable: false`. Without this trap an assignment would
    // reach OrdinarySet, read that descriptor off the proxy as the receiver,
    // and throw "Cannot redefine property". CommonJS dependencies patch a
    // builtin at module scope, so the throw takes the whole Worker down at
    // load. Write through to the surface instead, which also promotes the name
    // to a real own property and keeps the descriptor honest from then on.
    // Materializing a complete descriptor in the trap below would fix the
    // assignment too, but it would charge every Worker for all the stubs the
    // moment anything enumerates the namespace.
    set: (target, p, value) => Reflect.set(target, p, value),
    getOwnPropertyDescriptor: (target, p) =>
      Reflect.getOwnPropertyDescriptor(target, p) ??
        (namespaceNames.has(p)
          ? { configurable: true, enumerable: true }
          : undefined),
  });
};
const __fsPromises = __celld.__fsPromises = __fsNamespaceProxy(
  __fsPromisesSurface,
  "node:fs/promises",
  [
    "appendFile", "chmod", "chown", "copyFile", "cp", "lchmod", "lchown",
    "link", "lutimes", "mkdtemp", "open", "opendir", "readdir", "readlink",
    "rename", "rm", "rmdir", "statfs", "symlink", "truncate", "unlink",
    "utimes", "watch", "writeFile",
  ],
);
const __fsSurface = {
  Stats: __FsStats,
  constants: __fsConstants,
  promises: __fsPromises,
  accessSync: __fsAccessSync,
  access: __fsAccess,
  existsSync: __fsExistsSync,
  mkdirSync: __fsMkdirSync,
  statSync: __fsStatSync,
  lstatSync: __fsLstatSync,
  realpathSync: __fsRealpathSync,
  readFileSync: __fsReadFileSync,
  stat: __fsStat,
  lstat: __fsLstat,
  realpath: __fsRealpath,
  readFile: __fsReadFile,
  mkdir: __fsMkdir,
};
const __fsNamespaceNames = [
  "Dir", "Dirent", "ReadStream", "WriteStream", "_toUnixTimestamp",
  "appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync",
  "close", "closeSync", "copyFile", "copyFileSync", "cp", "cpSync",
  "createReadStream", "createWriteStream", "exists", "fchmod", "fchmodSync",
  "fchown", "fchownSync", "fdatasync", "fdatasyncSync", "fstat", "fstatSync",
  "fsync", "fsyncSync", "ftruncate", "ftruncateSync", "futimes", "futimesSync",
  "lchmod", "lchmodSync", "lchown", "lchownSync", "link", "linkSync",
  "lutimes", "lutimesSync", "mkdtemp", "mkdtempSync", "open", "openSync",
  "opendir", "opendirSync", "read", "readSync", "readdir", "readdirSync",
  "readlink", "readlinkSync", "readv", "readvSync", "rename", "renameSync",
  "rm", "rmSync", "rmdir", "rmdirSync", "statfs", "statfsSync", "symlink",
  "symlinkSync", "truncate", "truncateSync", "unlink", "unlinkSync",
  "unwatchFile", "utimes", "utimesSync", "watch", "watchFile", "write",
  "writeFile", "writeFileSync", "writeSync", "writev", "writevSync",
];
// Writable file contents and every mutation remain explicit unsupported
// surfaces until a failing application seam requires them. These two reads
// use ENOENT so dependencies can take their no-filesystem fallback path.
__celld.__fs = __fsNamespaceProxy(
  __fsSurface,
  "node:fs",
  __fsNamespaceNames,
  ["readdirSync", "readlinkSync"],
);
const __bridgeResponseStream = (body, requestControllers) => {
  const streamId = __response_stream_create();
  const pump = (async () => {
    const reader = body.getReader();
    const consumerClosed = __response_stream_closed(streamId)
      .then((status) => status === "cancelled"
        ? { consumerClosed: true }
        : new Promise(() => {}));
    const cancelProducer = async () => {
      const reason = new Error("The client has disconnected");
      for (const controller of requestControllers || []) {
        if (!controller.signal.aborted) controller.abort(reason);
      }
      try {
        await reader.cancel(reason);
      } catch {}
      await __response_stream_close(streamId, "");
    };
    try {
      for (;;) {
        const result = await Promise.race([
          reader.read().then((read) => ({ read })),
          consumerClosed,
        ]);
        if (result.consumerClosed) {
          await cancelProducer();
          return;
        }
        if (result.read.done) {
          await __response_stream_close(streamId, "");
          return;
        }
        const bytes = __bodyBytes(result.read.value);
        for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
          await __response_stream_write(
            streamId,
            bytes.subarray(offset, offset + 64 * 1024),
          );
        }
      }
    } catch (error) {
      if (String(error).includes("response stream consumer canceled")) {
        await cancelProducer();
        return;
      }
      await __response_stream_close(streamId, String(error));
    }
  })();
  __registerWaitUntil(pump);
  return streamId;
};
__celld.__readResponse = (r) => {
  if (!(r instanceof Response)) {
    return {
      status: 200,
      bodyBytes: new TextEncoder().encode(String(r)),
      bodyStreamId: 0,
      headersJson: "[]",
      wsTargetJson: "null",
      workerSocketId: 0,
    };
  }
  // Keep the network-error marker out of the HTTP response fields. If status
  // zero reaches Rust as an ordinary response, the outer server can report
  // only a generic invalid status instead of the Worker contract failure.
  if (r.type === "error" || r.status === 0)
    return { error: __ERROR_RESPONSE_MESSAGE };
  let workerSocketId = 0;
  const socket = r.webSocket;
  const state = socket === null ? null : __wsState(socket);
  // A socket from another request or Durable Object cannot leave in this
  // one's response, as in workerd.
  if (socket !== null) __wsCheckOwner(socket);
  // Workerd lets a socket this request accepted leave in a 101 and fails it
  // when it couples to the receiver: the receiver's connection ends with
  // 1006. The host gives the response a socket that is already gone. A
  // client end bound to a Durable Object's socket is the same case.
  const acceptedWebSocket = r.status === 101 && state !== null &&
    (state.handoffAccepted || state.bound);
  // The Durable Object socket this response names. The host admits it only
  // under a grant this request holds, or as the running object's own.
  const wsTarget = state !== null && !acceptedWebSocket ? state.target : null;
  // This end now belongs to whoever receives the response.
  if (r.status === 101 && state !== null) state.returned = true;
  // A socket another isolate holds, handed to this request by a subrequest
  // and returned here without being accepted: the host passes that socket
  // on, so its server end reaches this response's client.
  const workerHandoff = r.status === 101 && state !== null
    ? state.handoff ?? null
    : null;
  if (r.status === 101 && state !== null && wsTarget === null && workerHandoff === null &&
      !acceptedWebSocket) {
    const server = state.peer;
    const serverState = server === null ? null : __wsState(server);
    if (serverState !== null && serverState.accepted) {
      // Install the host queue before the pump asks for its first frame. The
      // target marker makes sends use that queue instead of remaining in the
      // pair's pre-upgrade buffer.
      workerSocketId = __ws_prepare_worker_handoff(serverState.id);
      __wsSetId(serverState, workerSocketId);
      serverState.target = { __proto__: null, id: workerSocketId, scope: "" };
      serverState.polled = true;
      __socketSet(workerSocketId, server);
      __wsStartPump(server);
      __wsFlushPending(server);
    }
  }
  const hostStreamId = r.__celldRequestControllers
    ? undefined
    : __hostStreamId(r.body);
  const bodyStreamId = __bodyBytesOf(r) === null
    ? hostStreamId ?? __bridgeResponseStream(
      r.body,
      r.__celldRequestControllers,
    )
    : 0;
  if (bodyStreamId) {
    return {
      status: r.status,
      bodyBytes: new Uint8Array(),
      bodyStreamId,
      headersJson: JSON.stringify(Array.from(r.headers)),
      wsTargetJson: (wsTarget === null ? "null" : __wsTargetJson(wsTarget)),
      workerSocketId,
      workerHandoff,
      acceptedWebSocket,
    };
  }
  const bytes = __bodyBytesOf(r);
  return {
    status: r.status,
    bodyBytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    bodyStreamId: 0,
    headersJson: JSON.stringify(Array.from(r.headers)),
    wsTargetJson: (wsTarget === null ? "null" : __wsTargetJson(wsTarget)),
    workerSocketId,
    workerHandoff,
    acceptedWebSocket,
  };
};
