// A key exported as a JWK: its members, in order, and the ones that are not
// key material. celld exports no symmetric key as a JWK, and an asymmetric
// one without `key_ops`, `ext` or `alg` (plan 1.64).
import { createSecretKey } from "node:crypto";

const shape = (jwk) => ({
  keys: Object.keys(jwk),
  kty: jwk.kty,
  alg: jwk.alg ?? null,
  key_ops: jwk.key_ops ?? null,
  ext: jwk.ext ?? null,
  crv: jwk.crv ?? null,
});

const exported = async (make) => {
  try {
    return shape(await make());
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

export default {
  async fetch() {
    const subtle = crypto.subtle;
    const hmac = await subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
    const aes = await subtle.generateKey({ name: "AES-GCM", length: 128 }, true, ["encrypt"]);
    const rsa = await subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 1024,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const ec = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const ed = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    return Response.json({
      hmac: await exported(() => subtle.exportKey("jwk", hmac)),
      aes: await exported(() => subtle.exportKey("jwk", aes)),
      rsaPublic: await exported(() => subtle.exportKey("jwk", rsa.publicKey)),
      rsaPrivate: await exported(() => subtle.exportKey("jwk", rsa.privateKey)),
      ecPublic: await exported(() => subtle.exportKey("jwk", ec.publicKey)),
      edPublic: await exported(() => subtle.exportKey("jwk", ed.publicKey)),
      nodeSecret: await exported(() => createSecretKey(new Uint8Array(16)).export({ format: "jwk" })),
    });
  },
};
