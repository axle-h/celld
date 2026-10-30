// An HMAC key imported from raw bytes, as workerd's importHmac
// (api/crypto/digest.c++) takes it: its length is the bits of the data
// unless `length` says fewer, by at most 7, and never none. So an empty key
// is refused. The bits past the length are zeroed, which a raw export and a
// signature show.
const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

const outcome = async (call) => {
  try {
    return await call();
  } catch (error) {
    return `${error.constructor.name} ${error.name}: ${error.message}`;
  }
};

const importRaw = (bytes, length, hash = "SHA-256") => crypto.subtle.importKey(
  "raw", new Uint8Array(bytes),
  length === undefined ? { name: "HMAC", hash } : { name: "HMAC", hash, length },
  true, ["sign", "verify"]);

const describe = async (bytes, length) => {
  const key = await importRaw(bytes, length);
  return {
    algorithm: key.algorithm,
    raw: hex(await crypto.subtle.exportKey("raw", key)),
    mac: hex(await crypto.subtle.sign("HMAC", key, new Uint8Array([1, 2, 3]))),
  };
};

export default {
  async fetch() {
    const four = [0xff, 0xff, 0xff, 0xff];
    const out = {
      empty: await outcome(() => importRaw([])),
      emptyLength0: await outcome(() => importRaw([], 0)),
      emptyLength8: await outcome(() => importRaw([], 8)),
      emptySha1: await outcome(() => importRaw([], undefined, "SHA-1")),
      oneByte: await outcome(() => describe([0xff])),
      oneByteLength1: await outcome(() => describe([0xff], 1)),
      oneByteLength0: await outcome(() => describe([0xff], 0)),
    };
    const lengths = [32, 31, 25, 24, 33, 0, 40, "25", 25.9, -0.5, -7, NaN, Infinity, 2 ** 31, 2 ** 32 + 25, null];
    out.lengths = [];
    for (const length of lengths) {
      out.lengths.push([String(length), typeof length, await outcome(() => describe(four, length))]);
    }
    // A derived HMAC key goes through the same import.
    out.derived = await outcome(async () => {
      const base = await crypto.subtle.importKey("raw", new Uint8Array(16), "HKDF", false, ["deriveKey"]);
      const key = await crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new Uint8Array(0) },
        base, { name: "HMAC", hash: "SHA-256", length: 256 }, true, ["sign"]);
      return key.algorithm;
    });
    return Response.json(out);
  },
};
