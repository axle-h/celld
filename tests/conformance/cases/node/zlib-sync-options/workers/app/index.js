// The synchronous `node:zlib` functions and the options they take: the full
// `constants` object; `level`, which sets the output size though not the
// exact bytes, since those differ between deflate implementations;
// `maxOutputLength`, and the default 128 MiB bound that stops an inflate
// bomb; and the conversion and range checks on each option.
import zlib, {
  constants, codes, deflateSync, inflateSync, gzipSync, gunzipSync, deflateRawSync,
  inflateRawSync, Z_BEST_SPEED, Z_BEST_COMPRESSION, Z_DEFAULT_COMPRESSION,
} from "node:zlib";

const describe = (error) => ({ name: error.name, message: error.message });

// Reports an output by its length, or by `summarize` when its bytes depend
// on the deflate implementation.
function attempt(fn, summarize = (output) => output.byteLength) {
  try {
    return { ok: summarize(fn()) };
  } catch (error) {
    return { error: describe(error) };
  }
}

const sameBytes = (a, b) =>
  a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);

// Compressible text with enough variety that level 1 and level 9 differ.
const text = new TextEncoder().encode(
  Array.from({ length: 4000 }, (_, i) => `line ${i % 97} of ${i % 13}: ${"ab".repeat(i % 7)}\n`)
    .join(""));

// Which of levels 0, 1 and the default deflated `text` into `output`.
const levelOf = (output) =>
  [0, 1, -1].find((level) => sameBytes(output, deflateSync(text, { level }))) ?? "other";

const formats = {
  deflate: [deflateSync, inflateSync],
  gzip: [gzipSync, gunzipSync],
  deflateRaw: [deflateRawSync, inflateRawSync],
};

function levels() {
  const result = {};
  for (const [format, [compress, decompress]] of Object.entries(formats)) {
    const sizes = {};
    const rows = {};
    for (const level of [undefined, -1, 0, 1, 2, 5, 6, 7, 9]) {
      const out = compress(text, level === undefined ? undefined : { level });
      sizes[level] = out.byteLength;
      rows[String(level)] = {
        isBuffer: Buffer.isBuffer(out),
        roundTrips: sameBytes(decompress(out), text),
        // gzip's XFL and OS bytes. The rest of the output, a zlib header's
        // FLEVEL bits included, depends on the deflate implementation.
        header: format === "gzip" ? [out[8], out[9]] : null,
      };
    }
    result[format] = {
      rows,
      storedIsLarger: sizes[0] > text.byteLength,
      fastIsLarger: sizes[1] > sizes[9],
      defaultIsSix: sizes[undefined] === sizes[6] && sizes[-1] === sizes[6],
      compresses: sizes[9] < text.byteLength / 4,
    };
  }
  result.errors = Object.fromEntries(
    [10, -2, 1.5, "1", "fast", null, NaN, Infinity, 2 ** 32 + 1].map((level) =>
      [String(level), attempt(() => deflateSync(text, { level }), levelOf)]));
  result.gzipLevelError = attempt(() => gzipSync(text, { level: 12 }));
  return result;
}

// A raw deflate stream of `mib` MiB of zeros, compressed in pieces so no
// large buffer exists on the way.
async function zeroBomb(mib) {
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  const chunk = new Uint8Array(1024 * 1024);
  const written = (async () => {
    for (let i = 0; i < mib; i++) await writer.write(chunk);
    await writer.close();
  })();
  const compressed = new Uint8Array(await new Response(stream.readable).arrayBuffer());
  await written;
  return compressed;
}

async function maxOutputLength() {
  const deflated = deflateSync(text);
  const gzipped = gzipSync(text);
  const size = text.byteLength;
  const result = {
    inflateExact: attempt(() => inflateSync(deflated, { maxOutputLength: size })),
    inflateOneShort: attempt(() => inflateSync(deflated, { maxOutputLength: size - 1 })),
    inflateSmall: attempt(() => inflateSync(deflated, { maxOutputLength: 1 })),
    gunzipExact: attempt(() => gunzipSync(gzipped, { maxOutputLength: size })),
    gunzipShort: attempt(() => gunzipSync(gzipped, { maxOutputLength: 1000 })),
    inflateRawShort: attempt(() =>
      inflateRawSync(deflateRawSync(text), { maxOutputLength: 64 })),
    deflateShort: attempt(() => deflateSync(text, { maxOutputLength: 16 }), levelOf),
    deflateRoomy: attempt(() => deflateSync(text, { maxOutputLength: size }), levelOf),
    empty: attempt(() => inflateSync(deflateSync(new Uint8Array()), { maxOutputLength: 1 })),
    // workerd collects output 40 KiB at a time, growing only by whole
    // chunks up to the limit, so output that would fit can still fail.
    exactFits: Object.fromEntries([17, 1000, 40960, 40961, 81920, text.byteLength].map((length) => {
      const input = text.subarray(0, length);
      const deflatedInput = deflateSync(input);
      return [length, Object.fromEntries(
        [length - 1, length, length + 1, 40960, 50000, 81920, 81921, 122880, 163840].map(
          (max) => [max, attempt(() => inflateSync(deflatedInput, { maxOutputLength: max }))]))];
    })),
    errors: Object.fromEntries(
      [0, -1, 2 ** 27 + 1, 1.5, "64", "many", null, NaN].map((value) =>
        [String(value), attempt(() => inflateSync(deflated, { maxOutputLength: value }))])),
  };
  // The default bound is 128 MiB: 129 MiB of zeros, about 130 KB deflated,
  // does not inflate, and 1 MiB of them does.
  const bomb = await zeroBomb(129);
  result.bomb = {
    compressedUnder1MiB: bomb.byteLength < 1024 * 1024,
    default: attempt(() => inflateSync(bomb)),
    bounded: attempt(() => inflateSync(bomb, { maxOutputLength: 1024 * 1024 })),
  };
  const small = await zeroBomb(1);
  result.smallZeros = attempt(() => inflateSync(small));
  return result;
}

function options() {
  const deflated = deflateSync(text);
  return {
    inputs: {
      string: attempt(() => inflateSync(deflateSync("hello hello hello"))),
      arrayBuffer: attempt(() => inflateSync(deflated.buffer.slice(
        deflated.byteOffset, deflated.byteOffset + deflated.byteLength))),
      dataView: attempt(() =>
        inflateSync(new DataView(deflated.buffer, deflated.byteOffset, deflated.byteLength))),
      uint8Array: attempt(() => inflateSync(new Uint8Array(deflated))),
      number: attempt(() => deflateSync(123)),
      array: attempt(() => deflateSync([1, 2, 3])),
      nullData: attempt(() => deflateSync(null)),
    },
    optionsString: attempt(() => deflateSync(text, "fast")),
    optionsNumber: attempt(() => deflateSync(text, 9)),
    optionsNull: attempt(() => deflateSync(text, null), levelOf),
    unknownOption: attempt(() => deflateSync(text, { speed: "max" }), levelOf),
    chunkSize: {
      default: attempt(() => deflateSync(text, { chunkSize: 16 * 1024 }), levelOf),
      small: attempt(() => deflateSync(text, { chunkSize: 63 }), levelOf),
      min: attempt(() => deflateSync(text, { chunkSize: 64 }), levelOf),
    },
    flush: {
      noFlush: attempt(() => deflateSync(text, { flush: constants.Z_NO_FLUSH }), levelOf),
      outOfRange: attempt(() => deflateSync(text, { flush: 7 }), levelOf),
    },
    finishFlush: {
      finish: attempt(
        () => deflateSync(text, { finishFlush: constants.Z_FINISH }), levelOf),
      outOfRange: attempt(() => deflateSync(text, { finishFlush: -1 }), levelOf),
    },
    windowBits: {
      default: attempt(() => deflateSync(text, { windowBits: 15 }), levelOf),
      outOfRange: attempt(() => deflateSync(text, { windowBits: 16 }), levelOf),
      inflateAuto: attempt(() => inflateSync(deflated, { windowBits: 0 })),
      gunzipAuto: attempt(() => gunzipSync(gzipSync(text), { windowBits: 0 })),
      inflateRawZero: attempt(() => inflateRawSync(deflateRawSync(text), { windowBits: 0 })),
      deflateZero: attempt(() => deflateSync(text, { windowBits: 0 }), levelOf),
    },
    // JSG reads these as unsigned and workerd hands them to zlib as int, so
    // 2^32 - 1 is reported as -1.
    wrapped: {
      windowBits: attempt(() => deflateSync(text, { windowBits: 2 ** 32 - 1 }), levelOf),
      memLevel: attempt(() => deflateSync(text, { memLevel: 2 ** 32 - 1 }), levelOf),
      strategy: attempt(() => deflateSync(text, { strategy: 2 ** 32 - 1 }), levelOf),
    },
    dictionary: {
      string: attempt(() => deflateSync(text, { dictionary: "abc" }), levelOf),
      number: attempt(() => deflateSync(text, { dictionary: 5 }), levelOf),
      // The dictionary converts before maxOutputLength and after strategy.
      beforeMaxOutputLength: attempt(
        () => deflateSync(text, { dictionary: "abc", maxOutputLength: -1 }), levelOf),
      afterStrategy: attempt(
        () => deflateSync(text, { strategy: -1, dictionary: "abc" }), levelOf),
    },
    memLevel: {
      default: attempt(() => deflateSync(text, { memLevel: 8 }), levelOf),
      outOfRange: attempt(() => deflateSync(text, { memLevel: 10 }), levelOf),
    },
    strategy: {
      default: attempt(
        () => deflateSync(text, { strategy: constants.Z_DEFAULT_STRATEGY }), levelOf),
      invalid: attempt(() => deflateSync(text, { strategy: 9 }), levelOf),
    },
  };
}

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/constants") {
      const descriptor = Object.getOwnPropertyDescriptor(constants, "Z_BEST_SPEED");
      return Response.json({
        constants,
        count: Object.keys(constants).length,
        descriptor,
        frozen: Object.isFrozen(constants),
        codes,
        codesFrozen: Object.isFrozen(codes),
        named: [Z_BEST_SPEED, Z_BEST_COMPRESSION, Z_DEFAULT_COMPRESSION],
        onDefault: Object.keys(constants).every((key) => zlib[key] === constants[key]),
        sameObject: zlib.constants === constants,
      });
    }
    if (pathname === "/levels") return Response.json(levels());
    if (pathname === "/max-output-length") return Response.json(await maxOutputLength());
    if (pathname === "/options") return Response.json(options());
    return new Response("not found", { status: 404 });
  },
};
