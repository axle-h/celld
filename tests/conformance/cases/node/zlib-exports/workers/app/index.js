// The surface of node:zlib: the keys of its default export, the type of each
// name workerd's src/node/zlib.ts exports, and how the default import, a
// namespace import, process.getBuiltinModule and require() relate. celld
// implements only the synchronous gzip and deflate functions; it refuses the
// rest when called (node/zlib-unimplemented-options), but they exist with
// the same types, as on workerd. A namespace import on celld also binds the
// constants that workerd puts only on the default export, so the case does
// not compare the namespace's keys.
import zlib from "node:zlib";
import * as namespace from "node:zlib";
import required from "./required.cjs";

// workerd's named exports other than its constants, at v1.20261001.1.
const NAMES = [
  "crc32", "codes", "constants",
  "Gzip", "Gunzip", "Deflate", "DeflateRaw", "Inflate", "InflateRaw", "Unzip",
  "BrotliCompress", "BrotliDecompress", "ZstdCompress", "ZstdDecompress",
  "createGzip", "createGunzip", "createDeflate", "createDeflateRaw", "createInflate",
  "createInflateRaw", "createUnzip", "createBrotliCompress", "createBrotliDecompress",
  "createZstdCompress", "createZstdDecompress",
  "inflate", "inflateSync", "deflate", "deflateSync", "inflateRaw", "inflateRawSync",
  "deflateRaw", "deflateRawSync", "gzip", "gzipSync", "gunzip", "gunzipSync", "unzip",
  "unzipSync", "brotliDecompress", "brotliDecompressSync", "brotliCompress",
  "brotliCompressSync", "zstdCompress", "zstdCompressSync", "zstdDecompress",
  "zstdDecompressSync",
];

export default {
  async fetch() {
    const builtin = process.getBuiltinModule("node:zlib");
    return Response.json({
      defaultKeys: Object.keys(zlib).sort(),
      types: Object.fromEntries(NAMES.map((name) => [name, typeof zlib[name]])),
      namespaceTypes: Object.fromEntries(NAMES.map((name) => [name, typeof namespace[name]])),
      identity: {
        namespaceDefault: namespace.default === zlib,
        namespaceFunction: namespace.deflateSync === zlib.deflateSync,
        builtin: builtin === zlib,
        builtinFunction: builtin.deflateSync === zlib.deflateSync,
        requireBare: required.bare === zlib,
        requirePrefixed: required.prefixed === zlib,
        requireFunction: required.bare.deflateSync === zlib.deflateSync,
        bareBuiltin: process.getBuiltinModule("zlib") === builtin,
      },
    });
  },
};
