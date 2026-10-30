// CompressionStream / DecompressionStream -- WHATWG Compression Streams over
// one stateful native zlib stream (__zlib_stream_new / write / end / read /
// drop). A write queues its chunk and codes it as far as the native side
// codes ahead of its reader (zlib.rs `STREAM_AHEAD`), so bad input fails
// that write, as in workerd, whose writes never wait for a read; the
// readable side then pulls the output a bounded chunk at a time, coding
// more of the queued input as it goes, so an inflate bomb never holds more
// than a few chunks. A cancelled or aborted stream drops its native state
// instead of leaking it.
//
// Compiled on first access (see LAZY_GLOBALS), after the Worker's code may
// have replaced the globals, so it uses the intrinsics the harness captured.
// A bundle that never names either global never pays for this file.
return (() => {
const {
  ReflectApply, Promise, PromiseThen, Uint8Array,
  ArrayBuffer, ArrayBufferIsView, TypeError, TransformStream,
  ObjectSetPrototypeOf, TransformStreamReadable, TransformStreamWritable,
  StreamGetReader, ReaderCancel, ReaderClosed,
} = __celld.__intrinsics;

// Per spec the chunk must be a BufferSource; anything else is a
// TypeError, which errors both sides of the transform.
function bytes(chunk) {
  if (ArrayBufferIsView(chunk))
    return new Uint8Array(chunk.buffer, chunk.byteOffset,
                          chunk.byteLength);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  throw new TypeError(
    'The provided value is not of type (ArrayBuffer or ' +
    'ArrayBufferView).');
}

function make(format, decompress) {
  format = `${format}`;
  if (format !== 'gzip' && format !== 'deflate' &&
      format !== 'deflate-raw')
    throw new TypeError(
      `Unsupported compression format: '${format}'`);
  const id = __zlib_stream_new(format, decompress);
  // The readable side's pull waits here for a write or the close.
  let waiting = null;
  let ended = false;
  let failed = null;
  const wake = () => {
    const resume = waiting;
    waiting = null;
    if (resume !== null) resume();
  };
  // The writable side: a TransformStream whose output never reaches its own
  // readable, which only carries its errors (a bad chunk, an abort) here.
  // Nothing is enqueued there, so a high water mark of 1 keeps that side
  // from holding writes back.
  const ts = new TransformStream({ __proto__: null,
    transform(chunk) {
      __zlib_stream_write(id, bytes(chunk));
      wake();
    },
    flush() {
      __zlib_stream_end(id);
      ended = true;
      wake();
    },
    cancel() { __zlib_stream_drop(id); },
  }, undefined, { __proto__: null, highWaterMark: 1 });
  // Workerd's compression streams are internal streams, so the readable
  // side is a platform stream: a BYOB reader works on it, and a pending
  // default read() rejects with the cancel reason, as an Error, instead of
  // resolving {done: true}.
  const inner = ReflectApply(StreamGetReader,
    ReflectApply(TransformStreamReadable, ts, []), []);
  const readable = __celld.__makeInternalByteStream(async () => {
    for (;;) {
      if (failed !== null) throw failed.error;
      const out = __zlib_stream_read(id);
      if (out.byteLength) return out;
      if (ended) return null;
      await new Promise((resolve) => { waiting = resolve; });
    }
  }, (reason) => {
    __zlib_stream_drop(id);
    return ReflectApply(ReaderCancel, inner, [reason]);
  });
  // An error on the transform errors the readable side at once.
  ReflectApply(PromiseThen, ReflectApply(ReaderClosed, inner, []), [undefined, (error) => {
    __zlib_stream_drop(id);
    failed = { __proto__: null, error };
    wake();
    if (!readable._closed && !readable._errored)
      readable._controller.error(error);
  }]);
  return {
    __proto__: null, readable,
    writable: ReflectApply(TransformStreamWritable, ts, []),
  };
}

// TransformStreams, as workerd's are, whose sides the TransformStream
// accessors read (`__setTransformSides`); the base constructor never runs.
class CompressionStream {
  constructor(format) {
    const ts = make(format, false);
    __celld.__setTransformSides(this, ts.readable, ts.writable);
  }
}

class DecompressionStream {
  constructor(format) {
    const ts = make(format, true);
    __celld.__setTransformSides(this, ts.readable, ts.writable);
  }
}

ObjectSetPrototypeOf(CompressionStream.prototype, TransformStream.prototype);
ObjectSetPrototypeOf(CompressionStream, TransformStream);
ObjectSetPrototypeOf(DecompressionStream.prototype, TransformStream.prototype);
ObjectSetPrototypeOf(DecompressionStream, TransformStream);

__celld.__apiTag(CompressionStream.prototype, 'CompressionStream');
__celld.__apiTag(DecompressionStream.prototype, 'DecompressionStream');

return { CompressionStream, DecompressionStream };
})()
