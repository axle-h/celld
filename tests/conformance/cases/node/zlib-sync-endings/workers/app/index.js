// How the synchronous decoders end: truncated or corrupt input fails, bytes
// after a zlib or raw deflate stream are ignored, and gunzip decodes every
// gzip member up to zero padding. Each failure has zlib's message, which
// workerd passes on.
import {
  deflateSync, inflateSync, gzipSync, gunzipSync, deflateRawSync, inflateRawSync,
} from "node:zlib";

const text = new TextEncoder().encode("ending ".repeat(5000));

function attempt(fn) {
  try {
    return { ok: fn().byteLength };
  } catch (error) {
    return { error: `${error.name}: ${error.message}` };
  }
}

const concat = (...parts) => new Uint8Array(parts.flatMap((part) => [...part]));

export default {
  async fetch() {
    const zlib = deflateSync(text);
    const gzip = gzipSync(text);
    const raw = deflateRawSync(text);
    const badAdler = new Uint8Array(zlib);
    badAdler[zlib.length - 1] ^= 1;
    const badCrc = new Uint8Array(gzip);
    badCrc[gzip.length - 8] ^= 1;
    return Response.json({
      inflate: {
        whole: attempt(() => inflateSync(zlib)),
        noChecksum: attempt(() => inflateSync(zlib.subarray(0, zlib.length - 4))),
        half: attempt(() => inflateSync(zlib.subarray(0, zlib.length >> 1))),
        empty: attempt(() => inflateSync(new Uint8Array())),
        badChecksum: attempt(() => inflateSync(badAdler)),
        badHeader: attempt(() => inflateSync(new Uint8Array([1, 2, 3, 4]))),
        trailing: attempt(() => inflateSync(concat(zlib, [1, 2, 3]))),
      },
      inflateRaw: {
        whole: attempt(() => inflateRawSync(raw)),
        half: attempt(() => inflateRawSync(raw.subarray(0, raw.length >> 1))),
        empty: attempt(() => inflateRawSync(new Uint8Array())),
        trailing: attempt(() => inflateRawSync(concat(raw, [9, 9]))),
      },
      gunzip: {
        whole: attempt(() => gunzipSync(gzip)),
        noTrailer: attempt(() => gunzipSync(gzip.subarray(0, gzip.length - 8))),
        half: attempt(() => gunzipSync(gzip.subarray(0, gzip.length >> 1))),
        empty: attempt(() => gunzipSync(new Uint8Array())),
        badChecksum: attempt(() => gunzipSync(badCrc)),
        twoMembers: attempt(() => gunzipSync(concat(gzip, gzip))),
        zeroPadding: attempt(() => gunzipSync(concat(gzip, [0, 0, 7]))),
        trailingGarbage: attempt(() => gunzipSync(concat(gzip, [7, 0]))),
      },
    });
  },
};
