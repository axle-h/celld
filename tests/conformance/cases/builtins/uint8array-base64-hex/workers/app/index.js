// The base64 and hex methods of Uint8Array (TC39 "Uint8Array to/from
// base64"), which both runtimes take from V8: encoding with each option,
// decoding with each alphabet and `lastChunkHandling`, partial writes into a
// short target with `setFromBase64`/`setFromHex`, and the errors each throws.
function attempt(fn) {
  try {
    const value = fn();
    return { value: value instanceof Uint8Array ? Array.from(value) : value };
  } catch (error) {
    return { error: { name: error.name, message: error.message } };
  }
}

// Writes `input` into a target of `size` bytes, reporting what the method
// returned and what the target holds afterwards.
function setFrom(method, input, size, options) {
  const target = new Uint8Array(size).fill(0xee);
  const result = attempt(() => target[method](input, options));
  return { result, target: Array.from(target) };
}

const sample = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x01, 0x7e]);

export default {
  async fetch() {
    return Response.json({
      present: [
        typeof Uint8Array.prototype.toBase64,
        typeof Uint8Array.prototype.toHex,
        typeof Uint8Array.prototype.setFromBase64,
        typeof Uint8Array.prototype.setFromHex,
        typeof Uint8Array.fromBase64,
        typeof Uint8Array.fromHex,
      ],
      toHex: [sample.toHex(), new Uint8Array().toHex(), sample.subarray(2, 4).toHex()],
      toBase64: {
        plain: sample.toBase64(),
        base64url: sample.toBase64({ alphabet: "base64url" }),
        omitPadding: [1, 2, 3, 4].map((n) =>
          sample.subarray(0, n).toBase64({ omitPadding: true })),
        padded: [1, 2, 3, 4].map((n) => sample.subarray(0, n).toBase64()),
        urlUnpadded: sample.subarray(0, 4).toBase64({ alphabet: "base64url", omitPadding: true }),
        empty: new Uint8Array().toBase64(),
        badAlphabet: attempt(() => sample.toBase64({ alphabet: "hex" })),
        optionsNotObject: attempt(() => sample.toBase64("base64url")),
        detached: attempt(() => {
          const buffer = new ArrayBuffer(4);
          const view = new Uint8Array(buffer);
          structuredClone(buffer, { transfer: [buffer] });
          return view.toBase64();
        }),
      },
      fromHex: {
        lower: attempt(() => Uint8Array.fromHex("fbffbf00017e")),
        upper: attempt(() => Uint8Array.fromHex("FBFFBF")),
        empty: attempt(() => Uint8Array.fromHex("")),
        odd: attempt(() => Uint8Array.fromHex("abc")),
        badDigit: attempt(() => Uint8Array.fromHex("zz")),
        whitespace: attempt(() => Uint8Array.fromHex("ab cd")),
        notString: attempt(() => Uint8Array.fromHex(1234)),
      },
      fromBase64: {
        plain: attempt(() => Uint8Array.fromBase64("+/+/AAF+")),
        base64url: attempt(() => Uint8Array.fromBase64("-_-_AAF-", { alphabet: "base64url" })),
        urlCharsInBase64: attempt(() => Uint8Array.fromBase64("-_-_")),
        base64CharsInUrl: attempt(() => Uint8Array.fromBase64("+/+/", { alphabet: "base64url" })),
        whitespace: attempt(() => Uint8Array.fromBase64(" +/+/\n AAF+\t")),
        loose: ["AQ", "AQ==", "AQI", "AQI=", "AQ=", "AR=="].map((input) =>
          attempt(() => Uint8Array.fromBase64(input))),
        strict: ["AQ", "AQ==", "AQI=", "AR==", "AQJ="].map((input) =>
          attempt(() => Uint8Array.fromBase64(input, { lastChunkHandling: "strict" }))),
        stopBeforePartial: ["AQ", "AQID", "AQIDBA", "AQIDBA==", "AQIDBAU"].map((input) =>
          attempt(() => Uint8Array.fromBase64(input, { lastChunkHandling: "stop-before-partial" }))),
        badLastChunkHandling: attempt(() =>
          Uint8Array.fromBase64("AQ==", { lastChunkHandling: "lenient" })),
        badAlphabet: attempt(() => Uint8Array.fromBase64("AQ==", { alphabet: "hex" })),
        badCharacter: attempt(() => Uint8Array.fromBase64("AQ*=")),
        trailingAfterPadding: attempt(() => Uint8Array.fromBase64("AQ==AQ==")),
        notString: attempt(() => Uint8Array.fromBase64(null)),
      },
      setFromHex: {
        fits: setFrom("setFromHex", "0102", 4),
        exact: setFrom("setFromHex", "01020304", 4),
        partial: setFrom("setFromHex", "0102030405", 2),
        badDigitAfterValid: setFrom("setFromHex", "0102zz", 4),
        odd: setFrom("setFromHex", "010", 4),
      },
      setFromBase64: {
        fits: setFrom("setFromBase64", "AQID", 4),
        exact: setFrom("setFromBase64", "AQIDBA==", 4),
        partial: setFrom("setFromBase64", "AQIDBAUG", 4),
        partialChunk: setFrom("setFromBase64", "AQIDBAUG", 5),
        base64url: setFrom("setFromBase64", "-_8", 4, { alphabet: "base64url" }),
        stopBeforePartial: setFrom("setFromBase64", "AQIDBA", 8, { lastChunkHandling: "stop-before-partial" }),
        strictBadPadding: setFrom("setFromBase64", "AQ", 4, { lastChunkHandling: "strict" }),
        badCharacter: setFrom("setFromBase64", "AQID*A==", 8),
        emptyTarget: setFrom("setFromBase64", "AQID", 0),
      },
      onOtherTypedArrays: attempt(() => Uint8Array.prototype.toHex.call(new Int8Array(2))),
      onSubclass: (() => {
        class Bytes extends Uint8Array {}
        const value = Bytes.fromHex("0102");
        return { isUint8Array: value.constructor === Uint8Array, hex: value.toHex() };
      })(),
    });
  },
};
