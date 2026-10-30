// RSA key generation's parameters, as workerd's generateRsa and
// validateRsaParams (api/crypto/rsa.c++) check them, with
// strict_crypto_checks: the exponent is 3 or 65537, the modulus a multiple
// of 8 from 256 to 16384 bits and of 128, each refusal in that order. A key
// made with exponent 3 signs and verifies, and reports the exponent as it
// was given. RSA-PSS signs and verifies with the salt length it is given,
// which it requires.
const outcome = async (call) => {
  try {
    return await call();
  } catch (error) {
    return `${error.constructor.name} ${error.name}: ${error.message}`;
  }
};

const generate = (name, params) => crypto.subtle.generateKey(
  { name, hash: "SHA-256", ...params }, true,
  name === "RSA-OAEP" ? ["encrypt", "decrypt"] : ["sign", "verify"]);

const E3 = new Uint8Array([3]);
const E65537 = new Uint8Array([1, 0, 1]);

export default {
  async fetch() {
    const out = {};
    out.exponent3 = await outcome(async () => {
      const { publicKey, privateKey } = await generate("RSASSA-PKCS1-v1_5",
        { modulusLength: 512, publicExponent: E3 });
      const data = new Uint8Array([1, 2, 3]);
      const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, data);
      const jwk = await crypto.subtle.exportKey("jwk", publicKey);
      return {
        algorithm: { ...publicKey.algorithm, publicExponent: [...publicKey.algorithm.publicExponent] },
        verified: await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, data),
        e: jwk.e,
      };
    });
    out.exponent3Pss = await outcome(async () => {
      const { publicKey, privateKey } = await generate("RSA-PSS",
        { modulusLength: 512, publicExponent: E3 });
      const data = new Uint8Array([4]);
      const signature = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 0 }, privateKey, data);
      return crypto.subtle.verify({ name: "RSA-PSS", saltLength: 0 }, publicKey, signature, data);
    });
    // RSA-PSS verifies with the salt length it is given.
    out.pssSaltLengths = await outcome(async () => {
      const { publicKey, privateKey } = await generate("RSA-PSS",
        { modulusLength: 1024, publicExponent: E65537 });
      const data = new Uint8Array([5]);
      const results = [];
      for (const [signed, verified] of [[0, 0], [20, 20], [32, 32], [0, 32], [32, 0]]) {
        const signature = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: signed }, privateKey, data);
        results.push([signed, verified,
          await crypto.subtle.verify({ name: "RSA-PSS", saltLength: verified }, publicKey, signature, data)]);
      }
      return results;
    });
    out.exponent3Oaep = await outcome(async () => {
      const { publicKey, privateKey } = await generate("RSA-OAEP",
        { modulusLength: 1024, publicExponent: E3 });
      const sealed = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, new Uint8Array([7, 8]));
      return [...new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, sealed))];
    });
    // Leading zero bytes are kept in the reported exponent.
    out.paddedExponent = await outcome(async () => {
      const { publicKey } = await generate("RSASSA-PKCS1-v1_5",
        { modulusLength: 512, publicExponent: new Uint8Array([0, 0, 1, 0, 1]) });
      return [...publicKey.algorithm.publicExponent];
    });
    out.exponents = [];
    for (const bytes of [[5], [], [0], [1, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 3], [255, 255, 255, 255], [1, 0, 0, 0, 0]]) {
      out.exponents.push([bytes, await outcome(async () => {
        await generate("RSASSA-PKCS1-v1_5", { modulusLength: 512, publicExponent: new Uint8Array(bytes) });
        return "generated";
      })]);
    }
    out.moduli = [];
    for (const modulusLength of [0, -1, 128, 248, 256, 264, 384, 520, 16392, 2 ** 31]) {
      out.moduli.push([modulusLength, await outcome(async () => {
        // A bad exponent shows which check comes first.
        await generate("RSASSA-PKCS1-v1_5", { modulusLength, publicExponent: new Uint8Array([7]) });
        return "generated";
      })]);
    }
    // With a good exponent: a size that is not a multiple of 128, then one
    // under the 512 bits key generation makes.
    out.sizes = [];
    for (const modulusLength of [256, 264, 384, 448, 512, 520, 640, "512", 512.9]) {
      out.sizes.push([modulusLength, await outcome(async () => {
        const { publicKey } = await generate("RSASSA-PKCS1-v1_5", { modulusLength, publicExponent: E65537 });
        return publicKey.algorithm.modulusLength;
      })]);
    }
    out.missingExponent = await outcome(() => generate("RSASSA-PKCS1-v1_5", { modulusLength: 512 }));
    out.missingModulus = await outcome(() => generate("RSASSA-PKCS1-v1_5", { publicExponent: E65537 }));
    out.missingBoth = await outcome(() => generate("RSASSA-PKCS1-v1_5", {}));
    out.missingHash = await outcome(() => crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 512, publicExponent: E65537 }, true, ["sign"]));
    // workerd's order (generateRsa): the hash's name and the usages before
    // the modulus and the exponent, and the private key's usages after the
    // key is made.
    out.order = [];
    const E7 = new Uint8Array([7]);
    for (const [label, name, params, usages] of [
      ["unknown hash, bad modulus", "RSASSA-PKCS1-v1_5", { hash: "SHA-3", modulusLength: 100, publicExponent: E7 }, ["sign"]],
      ["MD5 hash, bad modulus", "RSA-PSS", { hash: "md5", modulusLength: 100, publicExponent: E65537 }, ["sign"]],
      ["zero modulus, unknown hash", "RSA-PSS", { hash: "SHA-3", modulusLength: 0, publicExponent: E65537 }, ["sign"]],
      ["bad usage, bad modulus", "RSA-PSS", { hash: "SHA-256", modulusLength: 100, publicExponent: E65537 }, ["encrypt"]],
      ["bad usage, bad exponent", "RSA-OAEP", { hash: "SHA-256", modulusLength: 1024, publicExponent: E7 }, ["sign"]],
      ["unknown usage", "RSASSA-PKCS1-v1_5", { hash: "SHA-256", modulusLength: 512, publicExponent: E65537 }, ["sign", "bogus"]],
      ["unknown hash, bad usage", "RSA-PSS", { hash: "SHA-3", modulusLength: 512, publicExponent: E65537 }, ["encrypt"]],
      ["no private usage", "RSASSA-PKCS1-v1_5", { hash: "SHA-256", modulusLength: 512, publicExponent: E65537 }, ["verify"]],
      ["no usages", "RSA-OAEP", { hash: "SHA-256", modulusLength: 1024, publicExponent: E65537 }, []],
      ["no private usage, small modulus", "RSASSA-PKCS1-v1_5", { hash: "SHA-256", modulusLength: 384, publicExponent: E65537 }, ["verify"]],
      ["hash in lower case", "RSA-PSS", { hash: { name: "sha-384" }, modulusLength: 512, publicExponent: E65537 }, ["sign", "verify"]],
    ]) {
      out.order.push([label, await outcome(async () => {
        const { publicKey, privateKey } = await crypto.subtle.generateKey({ name, ...params }, true, usages);
        return { hash: publicKey.algorithm.hash.name, public: publicKey.usages, private: privateKey.usages };
      })]);
    }
    // RSA-PSS's salt length (RsaPssKey::addSalt): required, converted as a
    // long, not negative, and no longer than the key and hash leave room for.
    out.pssSalt = await outcome(async () => {
      const { publicKey, privateKey } = await generate("RSA-PSS",
        { modulusLength: 1024, publicExponent: E65537 });
      const data = new Uint8Array([6]);
      const signed = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, privateKey, data);
      const results = [];
      for (const [label, saltLength] of [["missing", undefined], ["negative", -1], ["fraction", 32.7],
        ["string", "32"], ["NaN", NaN], ["past a long", 2 ** 31], ["largest", 94], ["too long", 95]]) {
        const algorithm = { name: "RSA-PSS" };
        if (saltLength !== undefined) algorithm.saltLength = saltLength;
        results.push([label,
          await outcome(async () => (await crypto.subtle.sign(algorithm, privateKey, data)).byteLength),
          await outcome(() => crypto.subtle.verify(algorithm, publicKey, signed, data))]);
      }
      return results;
    });
    return Response.json(out);
  },
};
