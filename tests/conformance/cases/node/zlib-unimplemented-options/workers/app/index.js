// What celld refuses in node:zlib: the synchronous options it does not
// implement (each fails at the call, after workerd's own checks, and each
// option's default still works), every other export of workerd's node:zlib,
// and gzip input with more members than one call decodes.
import zlib, { constants, deflateSync, inflateSync, gzipSync, gunzipSync, inflateRawSync } from "node:zlib";

const text = new TextEncoder().encode("refused ".repeat(64));
const deflated = deflateSync(text);

// A success reports only that the call returned a Buffer: the deflated
// bytes are the deflate implementation's.
function attempt(fn) {
  try {
    return { ok: Buffer.isBuffer(fn()) };
  } catch (error) {
    return { error: `${error.name}: ${error.message}` };
  }
}

export default {
  async fetch() {
    return Response.json({
      windowBits: {
        deflate: attempt(() => deflateSync(text, { windowBits: 9 })),
        gzip: attempt(() => gzipSync(text, { windowBits: 14 })),
        inflate: attempt(() => inflateSync(deflated, { windowBits: 12 })),
        inflateHeader: attempt(() => inflateSync(deflated, { windowBits: 0 })),
        inflateRawHeader: attempt(() => inflateRawSync(deflated, { windowBits: 0 })),
        default: attempt(() => deflateSync(text, { windowBits: 15 })),
        outOfRange: attempt(() => deflateSync(text, { windowBits: 7 })),
      },
      memLevel: {
        nine: attempt(() => deflateSync(text, { memLevel: 9 })),
        default: attempt(() => deflateSync(text, { memLevel: 8 })),
        outOfRange: attempt(() => deflateSync(text, { memLevel: 0 })),
      },
      strategy: {
        rle: attempt(() => deflateSync(text, { strategy: constants.Z_RLE })),
        huffmanOnly: attempt(() => deflateSync(text, { strategy: constants.Z_HUFFMAN_ONLY })),
        default: attempt(() => deflateSync(text, { strategy: constants.Z_DEFAULT_STRATEGY })),
      },
      finishFlush: {
        sync: attempt(() => inflateSync(deflated.subarray(0, 10), { finishFlush: constants.Z_SYNC_FLUSH })),
        default: attempt(() => inflateSync(deflated, { finishFlush: constants.Z_FINISH })),
      },
      dictionary: attempt(() => deflateSync(text, { dictionary: new TextEncoder().encode("refused") })),
      info: attempt(() => deflateSync(text, { info: true })),
      infoFalse: attempt(() => deflateSync(text, { info: false })),
      // Every other export of workerd's node:zlib throws when called.
      exports: {
        createGzip: attempt(() => zlib.createGzip()),
        Gzip: attempt(() => new zlib.Gzip()),
        gzip: attempt(() => zlib.gzip(text, () => {})),
        unzipSync: attempt(() => zlib.unzipSync(deflated)),
        crc32: attempt(() => zlib.crc32(text)),
        brotliCompressSync: attempt(() => zlib.brotliCompressSync(text)),
        zstdDecompress: attempt(() => zlib.zstdDecompress(text, () => {})),
      },
      // One call decodes at most 65,536 gzip members.
      gzipMembers: (() => {
        const member = gzipSync(new Uint8Array());
        const members = (count) => {
          const input = new Uint8Array(member.length * count);
          for (let i = 0; i < count; i++) input.set(member, i * member.length);
          return input;
        };
        return {
          atCap: attempt(() => gunzipSync(members(65_536))),
          overCap: attempt(() => gunzipSync(members(65_537))),
        };
      })(),
    });
  },
};
