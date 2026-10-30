// IdentityTransformStream / FixedLengthStream -- Cloudflare's byte
// pass-through streams. Not spec TransformStreams: in Workerd these are
// "internal" (native) byte streams, and celld matches that
// contract. Both sides belong to the request or Durable Object that
// made them. The readable supports one pending read at a time (a second
// concurrent read rejects, and releaseLock() throws while it is
// pending), BYOB readers with the readAtLeast() extension that answer
// with a Uint8Array whatever the view's type, per-reader closed promises
// that reject on releaseLock, tee() branches of the same kind, and
// reader-cancel reasons converted to Errors, which reject the read in
// flight and propagate to the writer's pending write and close. A write
// resolves only once its bytes have been read, so the pump buffers
// nothing and the default read path copies nothing.
//
// Compiled on first access (see LAZY_GLOBALS); a bundle that never names
// either global never pays for this file.
return (() => {
// Compiled on first access, after the Worker's code could have replaced the
// globals: the intrinsics the harness captured.
const {
  ReflectApply: reflectApply, Promise: PromiseCtor,
  PromiseWithResolvers: withResolvers,
} = __celld.__intrinsics;

const NOT_BYTES =
  'This TransformStream is being used as a byte stream, but received ' +
  'an object of non-ArrayBuffer/ArrayBufferView type on its writable ' +
  'side.';
const RELEASED =
  'This ReadableStream reader has been released.';
const ONE_READ =
  'This ReadableStream only supports a single pending read request ' +
  'at a time.';

// No copy: a write is only observable once it has been read, so the
// writer cannot safely reuse the buffer before then either.
function bytes(chunk) {
  if (ArrayBuffer.isView(chunk))
    return new Uint8Array(chunk.buffer, chunk.byteOffset,
                          chunk.byteLength);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  throw new TypeError(NOT_BYTES);
}

// Workerd converts a cancel reason into a real Error before handing it
// to the other side (cancelErrorTypePropagation).
function toError(reason) {
  if (reason instanceof Error) return reason;
  return new Error(
    reason === undefined ? 'Stream was cancelled.' : String(reason));
}

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

// The pipe itself: at most one unconsumed write and one pending read.
// Implements the `_pullInto` surface ReadableStreamBYOBReader drives
// (see byte_streams.js), so the global BYOB reader works on the
// readable unchanged.
class InternalController {
  _chunk = null;     // unread remainder of the in-flight write
  _consumed = null;  // settles the sink write once _chunk drains
  _readReq = null;   // parked default read
  _pendingPullIntos = [];  // parked BYOB descriptor (at most one)
  _readerClosed = null;  // the default reader's closed promise, made on use
  _stream = null;
  _writable = null;
  // An abort that waits for the write in flight (`writable._abort`).
  _pendingAbort = null;
  _runPendingAbort = null;

  _invalidate() {}   // no BYOB-request surface on internal streams

  // The default reader's closed promise, per reader as in workerd: it
  // settles with the stream, or rejects when the reader is released.
  _readerClosedPromise() {
    if (this._readerClosed === null) {
      const s = this._stream;
      const record = Promise.withResolvers();
      record.promise.catch(() => {});
      if (s._closed) record.resolve();
      else if (s._errored) record.reject(s._error);
      this._readerClosed = record;
    }
    return this._readerClosed.promise;
  }

  _settleReaderClosed(e) {
    const record = this._readerClosed;
    if (record === null) return;
    if (e === null) record.resolve();
    else record.reject(e);
  }

  // A default reader's release: what it had pending is refused, and its
  // closed promise rejects.
  _released() {
    const err = new TypeError(RELEASED);
    if (this._readReq !== null) {
      this._readReq.reject(err);
      this._readReq = null;
    }
    this._settleReaderClosed(err);
    this._readerClosed = null;
  }

  _hasPending() {
    return this._readReq !== null ||
      this._pendingPullIntos.length > 0;
  }

  // A read in flight, which keeps a BYOB reader's lock (releaseLock in
  // byte_streams.js).
  get _reading() { return this._hasPending(); }

  _doneChunk() {
    const c = this._consumed;
    this._chunk = null;
    this._consumed = null;
    // A deferred abort runs once the machinery has completed this write
    // (`writable._advanceQueue`).
    if (this._pendingAbort !== null) this._pendingAbort.ready = true;
    if (c) c.resolve();
  }

  // Copy from the pending chunk into a BYOB descriptor.
  _fill(d) {
    const c = this._chunk;
    const n = Math.min(c.byteLength, d.byteLength - d.filled);
    new Uint8Array(d.buffer, d.byteOffset + d.filled, n)
      .set(n === c.byteLength ? c : c.subarray(0, n));
    d.filled += n;
    if (n === c.byteLength) this._doneChunk();
    else this._chunk = c.subarray(n);
  }

  // Workerd answers a BYOB read on an internal stream with the bytes it
  // filled, as a Uint8Array, whatever the type of the view passed in.
  _view(d) {
    return new Uint8Array(d.buffer, d.byteOffset, d.filled);
  }

  // sink.write: deliver a chunk, resolving once it is fully read.
  _deliver(view) {
    return new Promise((resolve, reject) => {
      this._chunk = view;
      this._consumed = { resolve, reject };
      const r = this._readReq;
      if (r !== null) {
        this._readReq = null;
        const v = this._chunk;
        this._doneChunk();
        r.resolve(_readResult(v, false));
        return;
      }
      const d = this._pendingPullIntos[0];
      if (d !== undefined) {
        this._fill(d);
        if (d.filled >= d.minFill) {
          this._pendingPullIntos.shift();
          d.req.resolve(_readResult(this._view(d), false));
        }
      }
    });
  }

  // Workerd serves a read on a later turn even when written bytes wait,
  // so a second read, a releaseLock() or a cancel in the read's own turn
  // meets it in flight. A write that arrives first serves it (_deliver).
  _read() {
    const s = this._stream;
    if (s._errored) return Promise.reject(s._error);
    if (s._closed)
      return Promise.resolve(_readResult(undefined, true));
    if (this._hasPending())
      return Promise.reject(new TypeError(ONE_READ));
    return new Promise((resolve, reject) => {
      const req = { resolve, reject };
      this._readReq = req;
      Promise.resolve().then(() => {
        if (this._readReq !== req || this._chunk === null) return;
        this._readReq = null;
        const v = this._chunk;
        this._doneChunk();
        req.resolve(_readResult(v, false));
      });
    });
  }

  _pullInto(view, min) {
    const s = this._stream;
    if (s._errored) return Promise.reject(s._error);
    if (this._hasPending())
      return Promise.reject(new TypeError(ONE_READ));
    const elementSize = view.BYTES_PER_ELEMENT ?? 1; // DataView: 1
    const d = {
      buffer: null,
      byteOffset: view.byteOffset,
      byteLength: view.byteLength,
      filled: 0,
      minFill: min * elementSize,
      req: null,
    };
    try { d.buffer = view.buffer.transfer(); }
    catch (e) { return Promise.reject(e); }
    if (s._closed)
      // A post-close BYOB read hands the (transferred) buffer back as
      // a zero-length view.
      return Promise.resolve(_readResult(this._view(d), true));
    // Served on a later turn, as a default read is (_read).
    return new Promise((resolve, reject) => {
      d.req = { resolve, reject };
      this._pendingPullIntos.push(d);
      Promise.resolve().then(() => {
        if (this._pendingPullIntos[0] !== d || this._chunk === null) return;
        this._fill(d);
        if (d.filled >= d.minFill) {
          this._pendingPullIntos.shift();
          d.req.resolve(_readResult(this._view(d), false));
        }
      });
    });
  }

  // sink.close -- only reachable with no write in flight.
  _close() {
    const s = this._stream;
    s._finishClose();
    const r = this._readReq;
    if (r !== null) {
      this._readReq = null;
      r.resolve(_readResult(undefined, true));
    }
    const pending = this._pendingPullIntos;
    this._pendingPullIntos = [];
    for (const d of pending)
      d.req.resolve(_readResult(this._view(d), d.filled === 0));
    this._settleReaderClosed(null);
  }

  // Error the readable side (writer abort, bad write, length
  // violation).
  _errorRd(e) {
    const s = this._stream;
    if (s._closed || s._errored) return;
    s._errored = true;
    s._error = e;
    s._rejectClosed(e);
    const r = this._readReq;
    if (r !== null) { this._readReq = null; r.reject(e); }
    const pending = this._pendingPullIntos;
    this._pendingPullIntos = [];
    for (const d of pending) d.req.reject(e);
    this._settleReaderClosed(e);
    if (this._consumed !== null) {
      const c = this._consumed;
      this._chunk = null;
      this._consumed = null;
      c.reject(e);
    }
    // A deferred abort ends with the stream.
    if (this._pendingAbort !== null) this._runPendingAbort();
  }

  // reader.cancel / readable.cancel: close the read side, convert the
  // reason, reject the read in flight with it, and reject the writer's
  // pending write and close with it.
  _cancel(reason) {
    const s = this._stream;
    if (s._errored) return Promise.reject(s._error);
    if (!s._closed) {
      const e = toError(reason);
      s._disturbed = true;
      s._finishClose();
      const r = this._readReq;
      if (r !== null) {
        this._readReq = null;
        r.reject(e);
      }
      const pending = this._pendingPullIntos;
      this._pendingPullIntos = [];
      for (const d of pending) d.req.reject(e);
      this._settleReaderClosed(null);
      this._writable._errorStream(e);
      if (this._consumed !== null) {
        const c = this._consumed;
        this._chunk = null;
        this._consumed = null;
        c.reject(e);
      }
      if (this._pendingAbort !== null) this._runPendingAbort();
    }
    return Promise.resolve();
  }
}

// Instance overrides so shared prototype paths stay unbranched.
function internalGetReader(options) {
  if (options !== undefined && options !== null &&
      options.mode !== undefined) {
    if (String(options.mode) !== 'byob')
      throw new TypeError(
        "mode must be undefined or 'byob' in call to getReader().");
    return new ReadableStreamBYOBReader(this);
  }
  return new ReadableStreamDefaultReader(this);
}

function internalCancel(reason) {
  return this._ictl._cancel(reason);
}

// Workerd tees an internal stream into internal streams, so a branch takes
// a BYOB reader too. The readable is read through one default reader as a
// platform stream, and that stream's tee makes the branches.
function internalTee() {
  __celld.__streamIo.check(this);
  const reader = this.getReader();
  return __celld.__makeInternalByteStream(
    () => reader.read().then((r) => (r.done ? null : r.value)),
    (reason) => reader.cancel(reason)).tee();
}

// FixedLengthStream's expected length, handed to the base constructor
// across super(). A field would arrive too late -- super() builds the
// sink that enforces it.
let expected;

class IdentityTransformStream {
  constructor(_queuingStrategy) {
    const limit = expected;
    expected = undefined;
    const ctl = new InternalController();
    const readable = new ReadableStream();
    ctl._stream = readable;
    readable._ictl = ctl;
    // A default reader is the standard one, with the internal-stream
    // contract (streams.js), reading from this controller.
    __celld.__streamIo.internal(readable, {
      pending: () => ctl._hasPending(),
      read: () => ctl._read(),
      release: () => ctl._released(),
      closed: () => ctl._readerClosedPromise(),
      error: (e) => ctl._errorRd(e),
    });
    Object.defineProperties(readable, {
      getReader: { __proto__: null, value: internalGetReader, writable: true,
                   configurable: true },
      _cancel: { __proto__: null, value: internalCancel, writable: true,
                 configurable: true },
      tee: { __proto__: null, value: internalTee, writable: true, configurable: true },
    });
    // FixedLengthStream implies Content-Length when its readable is a
    // fetch body.
    if (limit !== undefined) readable._expectedLength = limit;
    let seen = 0;
    const writable = new WritableStream({ __proto__: null,
      write(chunk) {
        let view;
        try {
          view = bytes(chunk);
          if (limit !== undefined &&
              (seen += view.byteLength) > limit)
            throw new TypeError(
              'Attempt to write too many bytes through a ' +
              'FixedLengthStream.');
        } catch (e) {
          ctl._errorRd(e);
          throw e;
        }
        if (view.byteLength === 0) return;
        return ctl._deliver(view);
      },
      close() {
        if (limit !== undefined && seen < limit) {
          const e = new TypeError(
            'FixedLengthStream did not see all expected bytes ' +
            'before close().');
          ctl._errorRd(e);
          throw e;
        }
        ctl._close();
      },
      // The readable side sees the connection lost, whatever the reason,
      // as workerd's does.
      abort() { ctl._errorRd(new Error('Network connection lost.')); },
    });
    ctl._writable = writable;
    const abort_ = writable._abort.bind(writable);
    writable._abort = (reason) => {
      // Before internal_writable_stream_abort_clears_queue workerd aborts
      // lazily: with a write in flight, the abort waits until that write
      // is read, which then completes, and errors the stream after it
      // (streams/internal.c++ WritableStreamInternalController::doAbort).
      if (!__celld.__cell.compat.internalWritableStreamAbortClearsQueue &&
          ctl._consumed !== null && writable._state === 'writable') {
        if (ctl._pendingAbort === null) {
          ctl._pendingAbort = { __proto__: null, reason,
            done: reflectApply(withResolvers, PromiseCtor, []), ready: false };
          writable._abortPromise = ctl._pendingAbort.done.promise;
        }
        return ctl._pendingAbort.done.promise;
      }
      // abort() must not deadlock behind a write parked in _deliver: the
      // writable machinery waits for the in-flight write before running
      // the sink abort, so unpark it with the abort reason.
      const p = abort_(reason);
      if (writable._state === 'erroring' && ctl._consumed !== null) {
        const c = ctl._consumed;
        ctl._chunk = null;
        ctl._consumed = null;
        c.reject(reason);
      }
      return p;
    };
    // The deferred abort runs once the write in flight has completed, before
    // the next one starts: as workerd's doError, it rejects the writer's
    // closed promise, then the writes queued behind, then errors the
    // readable side and settles the abort.
    ctl._runPendingAbort = () => {
      const pending = ctl._pendingAbort;
      ctl._pendingAbort = null;
      const reason = pending.reason;
      if (writable._state === 'writable') {
        writable._storedError = reason;
        writable._state = 'errored';
        if (writable._writer) writable._writer._rejectReady(reason);
        writable._rejectCloseAndClosed();
        for (const entry of writable._queue) entry.reject(reason);
        writable._queue = [];
        writable._queueSize = 0;
        ctl._errorRd(new Error('Network connection lost.'));
      }
      pending.done.resolve();
    };
    const advance_ = writable._advanceQueue.bind(writable);
    writable._advanceQueue = () => {
      if (ctl._pendingAbort !== null && ctl._pendingAbort.ready) ctl._runPendingAbort();
      advance_();
    };
    // Both sides are I/O objects of the request or Durable Object that
    // made them, as in workerd: any other is refused. One made at global
    // scope belongs to no one.
    if (__wait_until_active()) {
      __celld.__streamIo.own(readable, 'ReadableStreamSource');
      __celld.__streamIo.own(writable, 'Writable');
    }
    __celld.__setTransformSides(this, readable, writable);
  }
}

// Workerd's IdentityTransformStream is a TransformStream subclass; the
// base constructor must never run, so the chains are wired directly.
Object.setPrototypeOf(IdentityTransformStream.prototype,
                      TransformStream.prototype);
Object.setPrototypeOf(IdentityTransformStream, TransformStream);

class FixedLengthStream extends IdentityTransformStream {
  constructor(expectedLength, queuingStrategy) {
    // Workerd coerces through jsg's integer conversion, so
    // a fraction truncates (0.00001 -> 0) and -0 is 0.
    const length = Math.trunc(Number(expectedLength));
    if (!Number.isInteger(length) || length < 0 ||
        length > Number.MAX_SAFE_INTEGER)
      throw new TypeError(
        'FixedLengthStream requires an integer expected length less ' +
        'than 2^53.');
    expected = length;
    super(queuingStrategy);
  }
}

for (const [cls, name] of [
  [IdentityTransformStream, 'IdentityTransformStream'],
  [FixedLengthStream, 'FixedLengthStream'],
])
  __celld.__apiTag(cls.prototype, name);

return { IdentityTransformStream, FixedLengthStream };
})()
