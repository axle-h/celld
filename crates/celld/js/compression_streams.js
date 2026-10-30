// CompressionStream / DecompressionStream -- WHATWG Compression Streams,
// each a TransformStream over one stateful native zlib stream
// (__zlib_stream_new / push / end / drop). Output streams chunk by chunk
// as input is written; the terminal block arrives from flush() when the
// writable side closes. A cancelled or aborted stream drops its native
// state instead of leaking it.
//
// Compiled on first access (see LAZY_GLOBALS); a bundle that never names
// either global never pays for this file.
return (() => {

// Per spec the chunk must be a BufferSource; anything else is a
// TypeError, which errors both sides of the transform.
function bytes(chunk) {
  if (ArrayBuffer.isView(chunk))
    return new Uint8Array(chunk.buffer, chunk.byteOffset,
                          chunk.byteLength);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  throw new TypeError(
    'The provided value is not of type (ArrayBuffer or ' +
    'ArrayBufferView).');
}

function make(format, decompress) {
  format = String(format);
  if (format !== 'gzip' && format !== 'deflate' &&
      format !== 'deflate-raw')
    throw new TypeError(
      `Unsupported compression format: '${format}'`);
  const id = __zlib_stream_new(format, decompress);
  const ts = new TransformStream({
    transform(chunk, controller) {
      const out = __zlib_stream_push(id, bytes(chunk));
      if (out.byteLength) controller.enqueue(out);
    },
    flush(controller) {
      const out = __zlib_stream_end(id);
      if (out.byteLength) controller.enqueue(out);
    },
    cancel() { __zlib_stream_drop(id); },
  });
  // Workerd's compression streams are internal streams, so the readable
  // side is a platform stream over the transform's output: a BYOB reader
  // works on it, and a pending default read() rejects with the cancel
  // reason, as an Error, instead of resolving {done: true}. An error on the
  // transform (a bad chunk, an aborted writable) errors it at once, as
  // before.
  const inner = ts.readable.getReader();
  const readable = __celld.__makeInternalByteStream(
    () => inner.read().then((r) => (r.done ? null : r.value)),
    (reason) => inner.cancel(reason));
  inner.closed.catch((e) => {
    if (!readable._closed && !readable._errored)
      readable._controller.error(e);
  });
  return { readable, writable: ts.writable };
}

class CompressionStream {
  constructor(format) {
    const ts = make(format, false);
    this.readable = ts.readable;
    this.writable = ts.writable;
  }
}

class DecompressionStream {
  constructor(format) {
    const ts = make(format, true);
    this.readable = ts.readable;
    this.writable = ts.writable;
  }
}

for (const [cls, name] of [
  [CompressionStream, 'CompressionStream'],
  [DecompressionStream, 'DecompressionStream'],
])
  __celld.__apiTag(cls.prototype, name);

return { CompressionStream, DecompressionStream };
})()
