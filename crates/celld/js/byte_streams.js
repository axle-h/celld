// Readable byte streams (WHATWG subset): ReadableByteStreamController,
// ReadableStreamBYOBReader, ReadableStreamBYOBRequest. The BYOB reader also
// serves internal streams: IdentityTransformStream readables, and the
// harness's platform streams through ChunkedInternalController below.
//
// Compiled on first access (see LAZY_GLOBALS); streams.js names the
// ReadableByteStreamController global when a source declares
// `type: 'bytes'`, so a bundle with no byte streams never pays for this
// file. All state lives on the controller; the stream keeps only a
// `_byteCtl` backref plus instance overrides for `getReader` and
// `_cancel`, so default-stream paths are untouched.
//
// Three deliberate Workerd deviations from current spec text: a read on
// a default reader drains the whole byte queue as one coalesced chunk,
// a source with no start() is started synchronously (mirroring the
// writable's sink handling), and close() settles parked BYOB reads (see
// _closeCommit) instead of leaving them for respond(0).
return (() => {

const _brand = Symbol('ReadableByteStreamController');
const INVALIDATED =
  'This ReadableStreamBYOBRequest has been invalidated.';
const RELEASED =
  'This ReadableStream reader has been released.';
const NO_BYOB = 'This ReadableStream does not support BYOB reads.';
const BAD_MODE = "mode must be undefined or 'byob' in call to getReader().";
const ONE_READ =
  'This ReadableStream only supports a single pending read request ' +
  'at a time.';
const NOT_BYTES = 'This ReadableStream did not return bytes.';

// Same shape streams.js returns from reads: shadow `then` so a user
// override of Object.prototype.then cannot intercept the result.
function _readResult(value, done) {
  const r = __celld.__readResult(value, done);
  Object.defineProperty(r, 'then', {
    __proto__: null,
    value: undefined,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return r;
}

class ReadableStreamBYOBRequest {
  constructor(brand, controller, view) {
    if (brand !== _brand)
      throw new TypeError(
        'ReadableStreamBYOBRequest cannot be constructed directly');
    this._c = controller;
    this._view = view;
  }
  get view() { return this._view; }
  respond(bytesWritten) {
    if (this._c === null) throw new TypeError(INVALIDATED);
    const n = Number(bytesWritten);
    if (!Number.isInteger(n) || n < 0)
      throw new TypeError('invalid bytesWritten');
    this._c._respond(n);
  }
  respondWithNewView(view) {
    if (this._c === null) throw new TypeError(INVALIDATED);
    if (!ArrayBuffer.isView(view))
      throw new TypeError('view must be an ArrayBufferView');
    this._c._respondWithNewView(view);
  }
}

class ReadableByteStreamController {
  _stream;
  // Byte queue: {buffer, byteOffset, byteLength} slices.
  _queue = [];
  _queueTotalSize = 0;
  _closeRequested = false;
  // Pull-into descriptors. `readerType` is 'byob' (req carries the
  // read's resolve/reject) or 'default' (an autoAllocate read whose
  // request sits in the stream's _readRequests).
  _pendingPullIntos = [];
  _byobRequest = null;
  _autoAlloc;
  _hwm = 0;
  _source;
  _pullFn;
  _cancelFn;
  _started = false;
  _pulling = false;
  _pullAgain = false;

  constructor(brand, stream) {
    if (brand !== _brand)
      throw new TypeError(
        'ReadableByteStreamController cannot be constructed directly');
    this._stream = stream;
  }

  // Wires a `type: 'bytes'` stream: called by the ReadableStream
  // constructor, which returns immediately after (so none of the
  // default controller/pull machinery is set up). `hwm` is undefined
  // when the strategy did not provide one; byte streams default to 0.
  static _setup(stream, src, hwm) {
    const startFn = src.start;
    const pullFn = src.pull;
    const cancelFn = src.cancel;
    for (const [name, fn] of [['start', startFn], ['pull', pullFn],
                              ['cancel', cancelFn]])
      if (fn !== undefined && typeof fn !== 'function')
        throw __celld.__jsg.field(name, 'UnderlyingSource', 'function');
    let auto = src.autoAllocateChunkSize;
    if (auto !== undefined) {
      auto = Number(auto);
      if (!Number.isInteger(auto) || auto <= 0)
        throw new TypeError(
          'autoAllocateChunkSize must be a positive integer');
    }
    const c = new ReadableByteStreamController(_brand, stream);
    c._source = src;
    c._pullFn = pullFn;
    c._cancelFn = cancelFn;
    c._autoAlloc = auto;
    c._hwm = hwm === undefined ? 0 : hwm;
    stream._byteCtl = c;
    stream._controller = c;
    // Instance overrides so shared prototype paths stay unbranched.
    Object.defineProperties(stream, {
      getReader: { __proto__: null, value: byteGetReader, writable: true,
                   configurable: true },
      _cancel: { __proto__: null, value: byteCancel, writable: true,
                 configurable: true },
    });
    if (startFn) {
      let result;
      try { result = startFn.call(src, c); }
      catch (e) { result = Promise.reject(e); }
      Promise.resolve(result).then(
        () => { c._started = true; c._pull(); },
        (e) => c.error(e));
    } else {
      // Workerd starts a source with no start() synchronously.
      c._started = true;
      c._pull();
    }
  }

  get byobRequest() {
    if (this._byobRequest === null &&
        this._pendingPullIntos.length > 0) {
      const d = this._pendingPullIntos[0];
      const view = new Uint8Array(d.buffer,
        d.byteOffset + d.bytesFilled, d.byteLength - d.bytesFilled);
      this._byobRequest =
        new ReadableStreamBYOBRequest(_brand, this, view);
    }
    return this._byobRequest;
  }

  get desiredSize() {
    const s = this._stream;
    if (s._errored) return null;
    if (s._closed || this._closeRequested) return 0;
    return this._hwm - this._queueTotalSize;
  }

  enqueue(chunk) {
    const s = this._stream;
    // A BufferSource, as workerd's parameter is: a view, or an ArrayBuffer
    // taken whole.
    if (chunk instanceof ArrayBuffer) chunk = new Uint8Array(chunk);
    else if (!ArrayBuffer.isView(chunk))
      throw __celld.__jsg.execute(
        'enqueue', 'ReadableByteStreamController', 1, 'BufferSource');
    if (chunk.byteLength === 0 || chunk.buffer.byteLength === 0)
      throw new TypeError('Cannot enqueue a zero-length ArrayBuffer.');
    if (this._closeRequested || s._closed || s._errored)
      throw new TypeError('This ReadableByteStreamController is closed.');
    const { byteOffset, byteLength } = chunk;
    const buffer = chunk.buffer.transfer();
    const first = this._pendingPullIntos[0];
    if (first) {
      this._invalidate();
      if (first.readerType === 'default') {
        // A pending autoAllocate descriptor is dropped; salvage any
        // bytes it already holds ahead of the new chunk.
        this._pendingPullIntos.shift();
        if (first.bytesFilled > 0) {
          this._queue.push({ buffer: first.buffer,
            byteOffset: first.byteOffset,
            byteLength: first.bytesFilled });
          this._queueTotalSize += first.bytesFilled;
        }
      }
    }
    const reader = s._reader;
    if (reader instanceof ReadableStreamDefaultReader) {
      while (s._readRequests.length > 0 && this._queueTotalSize > 0)
        s._readRequests.shift()
          .resolve(_readResult(this._drain(), false));
      if (s._readRequests.length > 0) {
        s._readRequests.shift().resolve(_readResult(
          new Uint8Array(buffer, byteOffset, byteLength), false));
      } else {
        this._queue.push({ buffer, byteOffset, byteLength });
        this._queueTotalSize += byteLength;
      }
    } else {
      this._queue.push({ buffer, byteOffset, byteLength });
      this._queueTotalSize += byteLength;
      if (reader) this._process();
    }
    this._pull();
  }

  close() {
    const s = this._stream;
    if (this._closeRequested || s._closed || s._errored)
      throw new TypeError('This ReadableStream is closed.');
    if (this._queueTotalSize > 0) {
      this._closeRequested = true;
      return;
    }
    const d = this._pendingPullIntos[0];
    if (d && d.bytesFilled % d.elementSize !== 0) {
      const e = new TypeError('Insufficient bytes to fill elements');
      this.error(e);
      throw e;
    }
    this._closeCommit();
  }

  // Workerd settles parked BYOB reads when the stream closes: a
  // partially filled (min/readAtLeast) descriptor commits what it got
  // with done still false, an empty one hands its buffer back as a
  // zero-length done view. (Spec would leave them for respond(0);
  // a respond after this sees no request and is a no-op.)
  _closeCommit() {
    const pending = this._pendingPullIntos;
    this._pendingPullIntos = [];
    this._invalidate();
    this._stream._finishClose();
    for (const d of pending)
      if (d.req) d.req.resolve(_readResult(
        new d.ctor(d.buffer, d.byteOffset,
                   d.bytesFilled / d.elementSize),
        d.bytesFilled === 0));
  }

  error(e) {
    const s = this._stream;
    if (s._closed || s._errored) return;
    this._queue = [];
    this._queueTotalSize = 0;
    const pending = this._pendingPullIntos;
    this._pendingPullIntos = [];
    this._invalidate();
    s._error = e;
    s._errored = true;
    // Reject closed first (spec order), then reads.
    s._rejectClosed(e);
    for (const r of s._readRequests) r.reject(e);
    s._readRequests = [];
    for (const d of pending) if (d.req) d.req.reject(e);
  }

  _invalidate() {
    const r = this._byobRequest;
    if (r === null) return;
    r._c = null;
    r._view = null;
    this._byobRequest = null;
  }

  // Workerd: a default-reader read drains the whole byte queue as one
  // chunk (a single entry is handed back without a copy).
  _drain() {
    const q = this._queue;
    let out;
    if (q.length === 1) {
      const d = q[0];
      out = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    } else {
      out = new Uint8Array(this._queueTotalSize);
      let off = 0;
      for (const d of q) {
        out.set(
          new Uint8Array(d.buffer, d.byteOffset, d.byteLength), off);
        off += d.byteLength;
      }
    }
    this._queue = [];
    this._queueTotalSize = 0;
    this._handleDrain();
    return out;
  }

  _handleDrain() {
    if (this._queueTotalSize === 0 && this._closeRequested)
      this._closeCommit();
  }

  // FillPullIntoDescriptorFromQueue: copies up to the descriptor's
  // capacity, committing only element-aligned bytes once minFill is
  // reachable. Returns whether the descriptor is ready to commit.
  _fill(d) {
    const max = Math.min(this._queueTotalSize,
                         d.byteLength - d.bytesFilled);
    const maxFilled = d.bytesFilled + max;
    const aligned = maxFilled - (maxFilled % d.elementSize);
    let remaining = max;
    let ready = false;
    if (aligned >= d.minFill) {
      remaining = aligned - d.bytesFilled;
      ready = true;
    }
    const dest = new Uint8Array(d.buffer);
    while (remaining > 0) {
      const head = this._queue[0];
      const n = Math.min(remaining, head.byteLength);
      dest.set(new Uint8Array(head.buffer, head.byteOffset, n),
               d.byteOffset + d.bytesFilled);
      if (n === head.byteLength) this._queue.shift();
      else { head.byteOffset += n; head.byteLength -= n; }
      this._queueTotalSize -= n;
      d.bytesFilled += n;
      remaining -= n;
    }
    return ready;
  }

  _commit(d, done) {
    const view = new d.ctor(d.buffer, d.byteOffset,
                            d.bytesFilled / d.elementSize);
    if (d.readerType === 'default') {
      const r = this._stream._readRequests.shift();
      if (r) r.resolve(_readResult(view, done));
    } else {
      d.req.resolve(_readResult(view, done));
    }
  }

  _process() {
    while (this._pendingPullIntos.length > 0 &&
           this._queueTotalSize > 0) {
      const d = this._pendingPullIntos[0];
      if (!this._fill(d)) return;
      this._pendingPullIntos.shift();
      this._commit(d, false);
    }
  }

  _pullInto(view, min) {
    const s = this._stream;
    const elementSize = view.BYTES_PER_ELEMENT ?? 1; // DataView: 1
    const d = {
      buffer: null,
      bufferLen: 0,
      byteOffset: view.byteOffset,
      byteLength: view.byteLength,
      bytesFilled: 0,
      elementSize,
      minFill: min * elementSize,
      ctor: view.constructor,
      readerType: 'byob',
      req: null,
    };
    try { d.buffer = view.buffer.transfer(); }
    catch (e) { return Promise.reject(e); }
    d.bufferLen = d.buffer.byteLength;
    if (this._pendingPullIntos.length > 0)
      return new Promise((resolve, reject) => {
        d.req = { resolve, reject };
        this._pendingPullIntos.push(d);
      });
    if (s._closed)
      return Promise.resolve(_readResult(
        new d.ctor(d.buffer, d.byteOffset, 0), true));
    if (this._queueTotalSize > 0) {
      if (this._fill(d)) {
        const filled = new d.ctor(d.buffer, d.byteOffset,
                                  d.bytesFilled / elementSize);
        this._handleDrain();
        return Promise.resolve(_readResult(filled, false));
      }
      if (this._closeRequested) {
        const e = new TypeError('Insufficient bytes to fill elements');
        this.error(e);
        return Promise.reject(e);
      }
    }
    const p = new Promise((resolve, reject) => {
      d.req = { resolve, reject };
      this._pendingPullIntos.push(d);
    });
    this._pull();
    return p;
  }

  _respond(n) {
    const s = this._stream;
    const d = this._pendingPullIntos[0];
    if (s._closed) {
      if (n !== 0)
        throw new TypeError(
          'bytesWritten must be zero on a closed stream');
    } else {
      if (n === 0)
        throw new TypeError('bytesWritten must be non-zero');
      if (d.bytesFilled + n > d.byteLength)
        throw new RangeError('bytesWritten exceeds the view');
    }
    this._respondInternal(d, n);
  }

  _respondWithNewView(view) {
    const s = this._stream;
    const d = this._pendingPullIntos[0];
    if (!(view.buffer instanceof ArrayBuffer))
      throw new TypeError(
        'view must be over a detachable ArrayBuffer');
    if (s._closed) {
      if (view.byteLength !== 0)
        throw new TypeError(
          'view must be zero-length on a closed stream');
    } else if (view.byteLength === 0) {
      throw new TypeError('view must be non-zero-length');
    }
    if (d.byteOffset + d.bytesFilled !== view.byteOffset)
      throw new RangeError(
        'view byteOffset does not match the request');
    if (d.bufferLen !== view.buffer.byteLength)
      throw new RangeError('view buffer does not match the request');
    if (d.bytesFilled + view.byteLength > d.byteLength)
      throw new RangeError('view is larger than the request');
    const n = view.byteLength;
    d.buffer = view.buffer.transfer();
    this._respondInternal(d, n);
  }

  _respondInternal(d, n) {
    this._invalidate();
    if (this._stream._closed) {
      // respond(0) after close: every pending descriptor commits as
      // done with a zero-length view over its (filled) buffer.
      while (this._pendingPullIntos.length > 0)
        this._commit(this._pendingPullIntos.shift(), true);
      return;
    }
    d.bytesFilled += n;
    if (d.bytesFilled < d.minFill) { this._pull(); return; }
    this._pendingPullIntos.shift();
    const remainder = d.bytesFilled % d.elementSize;
    if (remainder > 0) {
      // Unaligned tail goes back on the queue for the next read.
      const end = d.byteOffset + d.bytesFilled;
      this._queue.push({
        buffer: d.buffer.slice(end - remainder, end),
        byteOffset: 0,
        byteLength: remainder,
      });
      this._queueTotalSize += remainder;
      d.bytesFilled -= remainder;
    }
    this._commit(d, false);
    this._process();
    this._pull();
  }

  _shouldPull() {
    const s = this._stream;
    if (!this._started || !this._pullFn || s._closed || s._errored ||
        this._closeRequested)
      return false;
    if (s._readRequests.length > 0) return true;
    if (this._pendingPullIntos.length > 0) return true;
    return this._hwm - this._queueTotalSize > 0;
  }

  _pull() {
    if (!this._shouldPull()) return;
    if (this._pulling) {
      this._pullAgain = true;
      return;
    }
    this._pulling = true;
    let result;
    try { result = this._pullFn.call(this._source, this); }
    catch (e) {
      this._pulling = false;
      this.error(e);
      return;
    }
    Promise.resolve(result).then(
      () => {
        this._pulling = false;
        if (this._pullAgain) {
          this._pullAgain = false;
          this._pull();
        }
      },
      (e) => {
        this._pulling = false;
        this.error(e);
      });
  }
}

// Default reader over a byte stream. Subclassing keeps the shared
// ReadableStreamDefaultReader.read() free of byte-stream branches;
// releaseLock/cancel/closed are inherited (release nulls _reader,
// which is this class's released signal).
class ByteDefaultReader extends ReadableStreamDefaultReader {
  constructor(stream) {
    super(stream);
    this._s = stream;
  }
  read() {
    const s = this._s;
    if (s._reader !== this)
      return Promise.reject(new TypeError(RELEASED));
    s._disturbed = true;
    if (s._errored) return Promise.reject(s._error);
    const c = s._byteCtl;
    if (c._queueTotalSize > 0)
      return Promise.resolve(_readResult(c._drain(), false));
    if (s._closed)
      return Promise.resolve(_readResult(undefined, true));
    const p = new Promise((resolve, reject) =>
      s._readRequests.push({ resolve, reject }));
    const auto = c._autoAlloc;
    if (auto !== undefined)
      c._pendingPullIntos.push({
        buffer: new ArrayBuffer(auto),
        bufferLen: auto,
        byteOffset: 0,
        byteLength: auto,
        bytesFilled: 0,
        elementSize: 1,
        minFill: 1,
        ctor: Uint8Array,
        readerType: 'default',
        req: null,
      });
    c._pull();
    return p;
  }
}

class ReadableStreamBYOBReader {
  _released = false;

  // Accepts byte streams (`_byteCtl`) and internal streams (`_ictl`:
  // IdentityTransformStream readables and the harness's platform streams),
  // both of which implement the `_pullInto` protocol.
  constructor(stream) {
    if (__celld.__oldAttributes)
      __celld.__installAttributes(this, "ReadableStreamBYOBReader");
    const c = stream instanceof ReadableStream
      ? (stream._byteCtl ?? stream._ictl) : undefined;
    if (c === undefined) throw new TypeError(NO_BYOB);
    if (stream._locked)
      throw new TypeError('This ReadableStream is currently locked to a reader.');
    this._s = stream;
    this._c = c;
    stream._locked = true;
    stream._reader = this;
  }

  read(view, options) {
    if (this._released)
      return Promise.reject(new TypeError(RELEASED));
    // A stream another request owns refuses first (streams.js).
    const refused = __celld.__streamIo.readRefusal(this._s);
    if (refused !== undefined) return refused;
    if (!ArrayBuffer.isView(view))
      return Promise.reject(new TypeError(
        "Failed to execute 'read' on 'ReadableStreamBYOBReader': " +
        "parameter 1 is not of type 'ArrayBufferView'."));
    if (view.byteLength === 0 || view.buffer.byteLength === 0)
      return Promise.reject(new TypeError(
        'You must call read() on a "byob" reader with a positive-sized ' +
        'TypedArray object.'));
    let min = 1;
    if (options !== undefined && options !== null &&
        options.min !== undefined) {
      min = Number(options.min);
      const elements = view.length ?? view.byteLength; // DataView
      if (!Number.isInteger(min) || min < 1)
        return Promise.reject(new TypeError('invalid min'));
      if (min > elements)
        return Promise.reject(new TypeError(
          `Minimum bytes to read (${min}) exceeds size of buffer ` +
          `(${elements}).`));
    }
    const s = this._s;
    s._disturbed = true;
    if (s._errored) return Promise.reject(s._error);
    return this._c._pullInto(view, min);
  }

  // Workerd extension: resolve only once at least `min` bytes are in
  // `view` (or the stream ends first -- then with what arrived).
  readAtLeast(min, view) {
    return this.read(view, { min });
  }

  // The `_ictl` of a harness platform stream (CelldChunkStream), made on
  // its first BYOB reader so the eager harness carries none of this
  // machinery.
  static _chunked(stream) {
    return new ChunkedInternalController(stream);
  }

  cancel(reason) {
    if (this._released)
      return Promise.reject(new TypeError(RELEASED));
    return __celld.__streamIo.refusal(this._s) ?? this._s._cancel(reason);
  }

  get closed() {
    if (this._released)
      return Promise.reject(new TypeError(RELEASED));
    return this._s._closedPromise;
  }

  releaseLock() {
    if (this._released) return;
    const s = this._s;
    const c = this._c;
    // Workerd's internal streams keep the lock while a read is in flight.
    if (c._reading === true)
      throw new TypeError(
        'Cannot call releaseLock() on a reader with outstanding read ' +
        'promises.');
    const err = new TypeError(RELEASED);
    for (const d of c._pendingPullIntos)
      if (d.req) d.req.reject(err);
    c._pendingPullIntos = [];
    c._invalidate();
    s._locked = false;
    s._reader = null;
    this._released = true;
  }
}

// Workerd converts a cancel reason into a real Error before rejecting the
// read in flight with it (cancelErrorTypePropagation).
function toError(reason) {
  if (reason instanceof Error) return reason;
  return new Error(
    reason === undefined ? 'Stream was cancelled.' : String(reason));
}

// BYOB reads on a platform stream (the harness's CelldChunkStream): bodies,
// Blob streams, compression output, streams received over RPC. Workerd
// serves these as internal streams, and this controller has their contract:
//
// - one read at a time; a second read rejects, and releaseLock() throws
//   while a read is in flight;
// - a read fills the caller's buffer from the stream's chunks and resolves
//   once it holds `min` elements' worth of bytes, or the stream ends, with a
//   Uint8Array over that buffer whatever the view's type; what a chunk has
//   beyond the buffer stays for the next read, of either kind;
// - the read is served on a later turn, so a cancel in the same turn as the
//   read rejects it, with the reason converted to an Error;
// - a read after the end hands the buffer back as a zero-length view, done.
//
// Chunks come from the stream's default queue first (what a default read
// left there), then from the stream's `_take()`, the source both kinds of
// reader share.
class ChunkedInternalController {
  _pendingPullIntos = [];  // the reader's releaseLock walks it; always empty
  _reading = false;
  _req = null;             // the read in flight: { d, resolve, reject }

  constructor(stream) { this._s = stream; }

  _invalidate() {}

  _pullInto(view, min) {
    if (this._reading)
      return Promise.reject(new TypeError(ONE_READ));
    // The view's bounds, before the transfer detaches it.
    const d = {
      buffer: null,
      byteOffset: view.byteOffset,
      byteLength: view.byteLength,
      filled: 0,
      minFill: min * (view.BYTES_PER_ELEMENT ?? 1), // DataView: 1
    };
    try { d.buffer = view.buffer.transfer(); }
    catch (e) { return Promise.reject(e); }
    this._reading = true;
    return new Promise((resolve, reject) => {
      const req = { d, resolve, reject };
      this._req = req;
      Promise.resolve().then(() => this._serve(req));
    });
  }

  async _serve(req) {
    const s = this._s;
    const d = req.d;
    let ended = false;
    try {
      while (d.filled < d.minFill) {
        const chunk = await this._next();
        if (this._req !== req) return;  // cancelled meanwhile
        if (chunk === null) {
          ended = true;
          break;
        }
        const bytes = ArrayBuffer.isView(chunk)
          ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : null;
        if (bytes === null) throw new TypeError(NOT_BYTES);
        const n = Math.min(bytes.byteLength, d.byteLength - d.filled);
        new Uint8Array(d.buffer, d.byteOffset + d.filled, n)
          .set(n === bytes.byteLength ? bytes : bytes.subarray(0, n));
        d.filled += n;
        if (n < bytes.byteLength) s._chunks.rest = bytes.subarray(n);
      }
    } catch (e) {
      if (this._req !== req) return;
      this._req = null;
      this._reading = false;
      if (!s._closed && !s._errored) s._controller.error(e);
      req.reject(s._errored ? s._error : e);
      return;
    }
    this._req = null;
    this._reading = false;
    if (ended && !s._closed && !s._errored && !s._closeRequested)
      s._controller.close();
    req.resolve(_readResult(
      new Uint8Array(d.buffer, d.byteOffset, d.filled),
      d.filled === 0));
  }

  // The next chunk: the default queue's, else the source's once no default
  // pull is in flight (a default reader released with a read pending leaves
  // one, whose chunk lands in the queue).
  async _next() {
    const s = this._s;
    const st = s._chunks;
    for (;;) {
      if (s._errored) throw s._error;
      if (s._queue.length > 0) {
        const chunk = s._queue.shift();
        s._queueTotalSize -= s._queueSizes.shift() ?? 0;
        if (s._queue.length === 0 && s._closeRequested) s._finishClose();
        return chunk;
      }
      if (s._closed || s._closeRequested) return null;
      if (st.pulling === null) return s._take();
      await st.pulling.catch(() => {});
    }
  }

  // The stream was cancelled: reject the read in flight.
  _cancelled(reason) {
    const req = this._req;
    if (req === null) return;
    this._req = null;
    this._reading = false;
    req.reject(toError(reason));
  }
}

// Installed per byte-stream instance by _setup.
function byteGetReader(options) {
  if (options !== undefined && options !== null &&
      options.mode !== undefined) {
    if (String(options.mode) !== 'byob') throw new TypeError(BAD_MODE);
    return new ReadableStreamBYOBReader(this);
  }
  return new ByteDefaultReader(this);
}

function byteCancel(reason) {
  const c = this._byteCtl;
  if (this._closed) return Promise.resolve();
  if (this._errored) return Promise.reject(this._error);
  this._disturbed = true;
  c._queue = [];
  c._queueTotalSize = 0;
  const pending = c._pendingPullIntos;
  c._pendingPullIntos = [];
  c._invalidate();
  // Spec: cancel resolves pending BYOB reads with no value.
  for (const d of pending)
    if (d.req) d.req.resolve(_readResult(undefined, true));
  this._finishClose();
  if (!c._cancelFn) return Promise.resolve();
  let result;
  try { result = c._cancelFn.call(c._source, reason); }
  catch (e) { return Promise.reject(e); }
  return Promise.resolve(result).then(() => undefined);
}

for (const [cls, name] of [
  [ReadableByteStreamController, 'ReadableByteStreamController'],
  [ReadableStreamBYOBReader, 'ReadableStreamBYOBReader'],
  [ReadableStreamBYOBRequest, 'ReadableStreamBYOBRequest'],
]) {
  __celld.__apiTag(cls.prototype, name);
}

__celld.__registerAttributes("ReadableStreamBYOBReader",
  [[ReadableStreamBYOBReader.prototype, "closed"]]);

return {
  ReadableByteStreamController,
  ReadableStreamBYOBReader,
  ReadableStreamBYOBRequest,
};
})()
