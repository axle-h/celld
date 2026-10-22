// node:zlib for celld: workerd's synchronous gzip and deflate functions,
// with its argument checks ported from Cloudflare, Inc.'s workerd
// (Apache-2.0).
//
// Each function converts its arguments as workerd's `ZlibUtil::zlibSync`
// (src/workerd/api/node/zlib-util.c++ at v1.20261001.1) does and checks them
// in the same order with the same errors. `level` and `maxOutputLength`
// are honoured; `flush` and `chunkSize` are checked and, as in workerd's
// synchronous path, change nothing. An option that would change the output
// and that celld does not implement fails loudly, as does every other export
// of workerd's node:zlib.
//
// Injected lazily, so an isolate that never imports node:zlib pays nothing.
(() => {
  "use strict";

  // workerd's `constants`: every value its native module defines, in its
  // order, as read-only properties of an object that is not frozen.
  const constants = {};
  Object.defineProperties(constants, Object.fromEntries(Object.entries({
    Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3,
    Z_FINISH: 4, Z_BLOCK: 5, Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2,
    Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4,
    Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6, Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1,
    Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1, Z_FILTERED: 1,
    Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0,
    ZLIB_VERNUM: 4897, DEFLATE: 1, INFLATE: 2, GZIP: 3, GUNZIP: 4, DEFLATERAW: 5,
    INFLATERAW: 6, UNZIP: 7, BROTLI_DECODE: 8, BROTLI_ENCODE: 9,
    Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15, Z_DEFAULT_WINDOWBITS: 15,
    Z_MIN_CHUNK: 64, Z_MAX_CHUNK: 134217728, Z_DEFAULT_CHUNK: 16384,
    Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9, Z_DEFAULT_MEMLEVEL: 8, Z_MIN_LEVEL: -1,
    Z_MAX_LEVEL: 9, Z_DEFAULT_LEVEL: -1, BROTLI_OPERATION_PROCESS: 0,
    BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2,
    BROTLI_OPERATION_EMIT_METADATA: 3, BROTLI_PARAM_MODE: 0,
    BROTLI_MODE_GENERIC: 0, BROTLI_MODE_TEXT: 1, BROTLI_MODE_FONT: 2,
    BROTLI_DEFAULT_MODE: 0, BROTLI_PARAM_QUALITY: 1, BROTLI_MIN_QUALITY: 0,
    BROTLI_MAX_QUALITY: 11, BROTLI_DEFAULT_QUALITY: 11, BROTLI_PARAM_LGWIN: 2,
    BROTLI_MIN_WINDOW_BITS: 10, BROTLI_MAX_WINDOW_BITS: 24,
    BROTLI_LARGE_MAX_WINDOW_BITS: 30, BROTLI_DEFAULT_WINDOW: 22,
    BROTLI_PARAM_LGBLOCK: 3, BROTLI_MIN_INPUT_BLOCK_BITS: 16,
    BROTLI_MAX_INPUT_BLOCK_BITS: 24,
    BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4, BROTLI_PARAM_SIZE_HINT: 5,
    BROTLI_PARAM_LARGE_WINDOW: 6, BROTLI_PARAM_NPOSTFIX: 7,
    BROTLI_PARAM_NDIRECT: 8, BROTLI_DECODER_RESULT_ERROR: 0,
    BROTLI_DECODER_RESULT_SUCCESS: 1, BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2,
    BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3,
    BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0,
    BROTLI_DECODER_PARAM_LARGE_WINDOW: 1, BROTLI_DECODER_NO_ERROR: 0,
    BROTLI_DECODER_SUCCESS: 1, BROTLI_DECODER_NEEDS_MORE_INPUT: 2,
    BROTLI_DECODER_NEEDS_MORE_OUTPUT: 3,
    BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE: -1,
    BROTLI_DECODER_ERROR_FORMAT_RESERVED: -2,
    BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE: -3,
    BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET: -4,
    BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME: -5,
    BROTLI_DECODER_ERROR_FORMAT_CL_SPACE: -6,
    BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE: -7,
    BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT: -8,
    BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1: -9,
    BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2: -10,
    BROTLI_DECODER_ERROR_FORMAT_TRANSFORM: -11,
    BROTLI_DECODER_ERROR_FORMAT_DICTIONARY: -12,
    BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS: -13,
    BROTLI_DECODER_ERROR_FORMAT_PADDING_1: -14,
    BROTLI_DECODER_ERROR_FORMAT_PADDING_2: -15,
    BROTLI_DECODER_ERROR_FORMAT_DISTANCE: -16,
    BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET: -19,
    BROTLI_DECODER_ERROR_INVALID_ARGUMENTS: -20,
    BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES: -21,
    BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS: -22,
    BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP: -25,
    BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1: -26,
    BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2: -27,
    BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES: -30,
    BROTLI_DECODER_ERROR_UNREACHABLE: -31, ZSTD_ENCODE: 10, ZSTD_DECODE: 11,
    ZSTD_COMPRESS: 10, ZSTD_DECOMPRESS: 11, ZSTD_e_continue: 0, ZSTD_e_flush: 1,
    ZSTD_e_end: 2, ZSTD_c_compressionLevel: 100, ZSTD_c_windowLog: 101,
    ZSTD_c_hashLog: 102, ZSTD_c_chainLog: 103, ZSTD_c_searchLog: 104,
    ZSTD_c_minMatch: 105, ZSTD_c_targetLength: 106, ZSTD_c_strategy: 107,
    ZSTD_c_enableLongDistanceMatching: 160, ZSTD_c_ldmHashLog: 161,
    ZSTD_c_ldmMinMatch: 162, ZSTD_c_ldmBucketSizeLog: 163,
    ZSTD_c_ldmHashRateLog: 164, ZSTD_c_contentSizeFlag: 200,
    ZSTD_c_checksumFlag: 201, ZSTD_c_dictIDFlag: 202, ZSTD_c_nbWorkers: 400,
    ZSTD_c_jobSize: 401, ZSTD_c_overlapLog: 402, ZSTD_d_windowLogMax: 100,
    ZSTD_fast: 1, ZSTD_dfast: 2, ZSTD_greedy: 3, ZSTD_lazy: 4, ZSTD_lazy2: 5,
    ZSTD_btlazy2: 6, ZSTD_btopt: 7, ZSTD_btultra: 8, ZSTD_btultra2: 9,
    ZSTD_CLEVEL_DEFAULT: 3, ZSTD_error_no_error: 0, ZSTD_error_GENERIC: 1,
    ZSTD_error_prefix_unknown: 10, ZSTD_error_version_unsupported: 12,
    ZSTD_error_frameParameter_unsupported: 14,
    ZSTD_error_frameParameter_windowTooLarge: 16,
    ZSTD_error_corruption_detected: 20, ZSTD_error_checksum_wrong: 22,
    ZSTD_error_literals_headerWrong: 24, ZSTD_error_dictionary_corrupted: 30,
    ZSTD_error_dictionary_wrong: 32, ZSTD_error_dictionaryCreation_failed: 34,
    ZSTD_error_parameter_unsupported: 40,
    ZSTD_error_parameter_combination_unsupported: 41,
    ZSTD_error_parameter_outOfBound: 42, ZSTD_error_tableLog_tooLarge: 44,
    ZSTD_error_maxSymbolValue_tooLarge: 46,
    ZSTD_error_maxSymbolValue_tooSmall: 48,
    ZSTD_error_stabilityCondition_notRespected: 50, ZSTD_error_stage_wrong: 60,
    ZSTD_error_init_missing: 62, ZSTD_error_memory_allocation: 64,
    ZSTD_error_workSpace_tooSmall: 66, ZSTD_error_dstSize_tooSmall: 70,
    ZSTD_error_srcSize_wrong: 72, ZSTD_error_dstBuffer_null: 74,
    ZSTD_error_noForwardProgress_destFull: 80,
    ZSTD_error_noForwardProgress_inputEmpty: 82,
  }).map(([name, value]) => [name, {
    value, writable: false, configurable: false, enumerable: true,
  }])));

  // workerd's `codes`: the return codes both ways round, frozen.
  const codes = {};
  for (const name of [
    "Z_OK", "Z_STREAM_END", "Z_NEED_DICT", "Z_ERRNO", "Z_STREAM_ERROR",
    "Z_DATA_ERROR", "Z_MEM_ERROR", "Z_BUF_ERROR", "Z_VERSION_ERROR",
  ]) codes[name] = constants[name];
  for (const name of Object.keys(codes)) codes[codes[name]] = name;
  Object.freeze(codes);

  const {
    Z_MIN_CHUNK, Z_MAX_CHUNK, Z_MIN_WINDOWBITS, Z_MAX_WINDOWBITS,
    Z_DEFAULT_WINDOWBITS, Z_MIN_LEVEL, Z_MAX_LEVEL, Z_DEFAULT_LEVEL,
    Z_MIN_MEMLEVEL, Z_MAX_MEMLEVEL, Z_DEFAULT_MEMLEVEL, Z_DEFAULT_STRATEGY,
    Z_FILTERED, Z_HUFFMAN_ONLY, Z_RLE, Z_FIXED, Z_NO_FLUSH, Z_FINISH,
  } = constants;
  // zlib's Z_TREES, the largest flush value; workerd checks against it.
  const Z_TREES = 6;

  // JSG's `int`: a non-finite number is 0, and a fraction truncates.
  const toInt = (value) => {
    const number = +value;
    if (!Number.isFinite(number)) return 0;
    if (number > 2147483647 || number < -2147483648)
      throw new TypeError(
        "Value out of range. Must be between -2147483648 and 2147483647 (inclusive).");
    return Math.trunc(number);
  };
  // JSG's `uint`: a non-finite or negative number is refused.
  const toUint = (value) => {
    const number = +value;
    if (!Number.isFinite(number))
      throw new TypeError("The value cannot be converted because it is not an integer.");
    if (number < 0)
      throw new TypeError(
        "The value cannot be converted because it is negative and this API expects a positive number.");
    if (number > 4294967295)
      throw new TypeError("Value out of range. Must be less than or equal to 4294967295.");
    return Math.trunc(number);
  };
  // An option JSG reads as `uint` that workerd then passes to zlib as `int`.
  const toUintAsInt = (value) => toUint(value) | 0;
  // JSG's `kj::Array<kj::byte>`: an ArrayBuffer or a view of one.
  const toBytes = (name) => (value) => {
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
    throw new TypeError(
      `Incorrect type for the '${name}' field on 'Options': the provided value is not of ` +
      "type 'ArrayBuffer or ArrayBufferView'.");
  };
  const checkRange = (name, value, min, max, received = value) => {
    if (value < min || value > max)
      throw new RangeError(
        `The value of "options.${name}" is out of range. It must be >= ${min} and <= ${max}. ` +
        `Received ${received}`);
  };
  const unimplemented = (name, detail = "") =>
    new Error(`node:zlib option '${name}' is not implemented in celld${detail}`);
  const onlyDefault = (name, value, fallback) => {
    if (value !== fallback)
      throw unimplemented(name, ` beyond its default, ${fallback} (received ${value})`);
  };

  // The modes whose `windowBits` may be 0, to take the window size from the
  // stream's header.
  const HEADER_WINDOW = new Set(["inflate", "gunzip"]);

  function zlibSync(mode, data, options = {}) {
    // workerd's JavaScript wrapper reads `info` before anything else.
    if (options.info) throw unimplemented("info");
    let bytes;
    if (typeof data === "string") bytes = new TextEncoder().encode(data);
    else if (ArrayBuffer.isView(data))
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else
      throw new TypeError(
        "Failed to execute 'zlibSync' on 'ZlibUtil': parameter 1 is not of type " +
        "'string or ArrayBuffer or ArrayBufferView'.");
    if (typeof options !== "object" && typeof options !== "function")
      throw new TypeError(
        "Failed to execute 'zlibSync' on 'ZlibUtil': parameter 2 is not of type 'Options'.");

    // The fields convert in the order workerd's `Options` struct declares
    // them; an undefined one is absent.
    const read = (name, convert) =>
      options[name] === undefined ? undefined : convert(options[name]);
    const flush = read("flush", toInt) ?? Z_NO_FLUSH;
    const finishFlush = read("finishFlush", toInt) ?? Z_FINISH;
    const chunkSize = read("chunkSize", toUint);
    const windowBits = read("windowBits", toUintAsInt) ?? Z_DEFAULT_WINDOWBITS;
    const level = read("level", toInt) ?? Z_DEFAULT_LEVEL;
    const memLevel = read("memLevel", toUintAsInt) ?? Z_DEFAULT_MEMLEVEL;
    const strategy = read("strategy", toUintAsInt) ?? Z_DEFAULT_STRATEGY;
    const dictionary = read("dictionary", toBytes("dictionary"));
    const maxOutputLength = read("maxOutputLength", toUint) ?? Z_MAX_CHUNK;

    // Then the checks, in workerd's order.
    if (chunkSize !== undefined) checkRange("chunkSize", chunkSize, Z_MIN_CHUNK, Z_MAX_CHUNK);
    checkRange("maxOutputLength", maxOutputLength, 1, Z_MAX_CHUNK);
    if (!(windowBits === 0 && HEADER_WINDOW.has(mode)))
      checkRange("windowBits", windowBits, Z_MIN_WINDOWBITS, Z_MAX_WINDOWBITS);
    checkRange("level", level, Z_MIN_LEVEL, Z_MAX_LEVEL);
    checkRange("memLevel", memLevel, Z_MIN_MEMLEVEL, Z_MAX_MEMLEVEL);
    if (![Z_FILTERED, Z_HUFFMAN_ONLY, Z_RLE, Z_FIXED, Z_DEFAULT_STRATEGY].includes(strategy))
      throw new Error("invalid strategy");
    checkRange("flush", flush, Z_NO_FLUSH, Z_TREES);
    // workerd reports `flush` here, not `finishFlush`.
    checkRange("finishFlush", finishFlush, Z_NO_FLUSH, Z_TREES, flush);

    // What workerd accepts but celld cannot do.
    if (windowBits !== 0 || !HEADER_WINDOW.has(mode))
      onlyDefault("windowBits", windowBits, Z_DEFAULT_WINDOWBITS);
    onlyDefault("memLevel", memLevel, Z_DEFAULT_MEMLEVEL);
    onlyDefault("strategy", strategy, Z_DEFAULT_STRATEGY);
    onlyDefault("finishFlush", finishFlush, Z_FINISH);
    if (dictionary !== undefined) throw unimplemented("dictionary");
    // workerd checks the input's size last; checking it here saves the op
    // copying an input it would refuse.
    if (bytes.byteLength >= Z_MAX_CHUNK) throw new RangeError("Memory limit exceeded");

    // `Buffer` is read at call time, which materializes the lazy global.
    return globalThis.Buffer.from(__zlib(mode, bytes, level, maxOutputLength).buffer);
  }

  const implemented = {
    deflateSync: (data, options) => zlibSync("deflate", data, options),
    inflateSync: (data, options) => zlibSync("inflate", data, options),
    gzipSync: (data, options) => zlibSync("gzip", data, options),
    gunzipSync: (data, options) => zlibSync("gunzip", data, options),
    deflateRawSync: (data, options) => zlibSync("deflateRaw", data, options),
    inflateRawSync: (data, options) => zlibSync("inflateRaw", data, options),
  };
  // workerd's default export (src/node/zlib.ts at v1.20261001.1), in its
  // order. A name celld does not implement is a stub that throws
  // "node:zlib.<name> is not implemented in celld" when called.
  const exported = (name) => implemented[name] ?? __celld.__nodeStubFor(`node:zlib.${name}`);
  __celld.__zlibModule = {
    crc32: exported("crc32"),
    codes,
    constants,
    ...constants,
    ...Object.fromEntries([
      "Gzip", "Gunzip", "Deflate", "DeflateRaw", "Inflate", "InflateRaw", "Unzip",
      "BrotliCompress", "BrotliDecompress", "ZstdCompress", "ZstdDecompress",
      "createGzip", "createGunzip", "createDeflate", "createDeflateRaw",
      "createInflate", "createInflateRaw", "createUnzip", "createBrotliCompress",
      "createBrotliDecompress", "createZstdCompress", "createZstdDecompress",
      "inflate", "inflateSync", "deflate", "deflateSync", "inflateRaw",
      "inflateRawSync", "deflateRaw", "deflateRawSync", "gzip", "gzipSync",
      "gunzip", "gunzipSync", "unzip", "unzipSync", "brotliDecompress",
      "brotliDecompressSync", "brotliCompress", "brotliCompressSync",
      "zstdCompress", "zstdCompressSync", "zstdDecompress", "zstdDecompressSync",
    ].map((name) => [name, exported(name)])),
  };
})();
