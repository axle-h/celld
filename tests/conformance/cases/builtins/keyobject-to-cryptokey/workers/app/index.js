import { KeyObject, createPrivateKey, generateKeyPairSync } from "node:crypto";

const report = (error) => `${error?.constructor?.name}(${error?.name}): ${error?.message}`;
const view = (key) => ({
  type: key.type, extractable: key.extractable, usages: key.usages,
  algorithm: key.algorithm.name, hash: key.algorithm.hash?.name,
});
const attempt = async (probe) => {
  try {
    const value = await probe();
    return value instanceof ArrayBuffer ? `ArrayBuffer(${value.byteLength})` : value;
  } catch (error) {
    return report(error);
  }
};
const rsa = (name, hash = "SHA-256") => ({
  name, modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash,
});

export default {
  async fetch() {
    const subtle = crypto.subtle;
    const ecdsa = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const ecdsaOpen = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const ecdh = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const pss = await subtle.generateKey(rsa("RSA-PSS"), false, ["sign", "verify"]);
    const pkcs1 = await subtle.generateKey(rsa("RSASSA-PKCS1-v1_5"), false, ["sign", "verify"]);
    const ed = await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    const p256 = { name: "ECDH", namedCurve: "P-256" };
    const from = (key) => KeyObject.from(key);
    return Response.json({
      "ECDSA as ECDSA": await attempt(() =>
        view(from(ecdsa.privateKey).toCryptoKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]))),
      "ECDSA as ECDSA, signs": await attempt(() => subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        from(ecdsa.privateKey).toCryptoKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
        new Uint8Array(1)).then(() => "signed")),
      "ECDSA as ECDH": await attempt(() =>
        view(from(ecdsa.privateKey).toCryptoKey(p256, false, ["deriveBits"]))),
      "ECDH as ECDH deriveKey": await attempt(() =>
        view(from(ecdh.privateKey).toCryptoKey(p256, false, ["deriveKey"]))),
      "RSA-PSS as RSA-OAEP": await attempt(() =>
        view(from(pss.privateKey).toCryptoKey({ name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]))),
      "RSASSA-PKCS1-v1_5 with SHA-1": await attempt(() =>
        view(from(pkcs1.privateKey).toCryptoKey(rsa("RSASSA-PKCS1-v1_5", "SHA-1"), false, ["sign"]))),
      "RSASSA-PKCS1-v1_5 with SHA-256": await attempt(() =>
        view(from(pkcs1.privateKey).toCryptoKey(rsa("RSASSA-PKCS1-v1_5"), false, ["sign"]))),
      "Ed25519 as Ed25519": await attempt(() =>
        view(from(ed.privateKey).toCryptoKey("Ed25519", false, ["sign"]))),
      "private key typed public": await attempt(() => {
        const object = from(ecdsa.privateKey);
        Object.defineProperty(object, "type", { value: "public" });
        return view(object.toCryptoKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]));
      }),
      "extractable ECDSA as ECDH": await attempt(() =>
        view(from(ecdsaOpen.privateKey).toCryptoKey(p256, false, ["deriveBits"]))),
      "imported key as ECDH": await attempt(async () => {
        const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" });
        return view(createPrivateKey(pem).toCryptoKey(p256, false, ["deriveBits"]));
      }),
    });
  },
};
