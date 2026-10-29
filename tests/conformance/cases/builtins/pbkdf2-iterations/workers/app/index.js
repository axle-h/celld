// PBKDF2's iteration cap. One call runs in the host, where no CPU limit can
// stop it, so Cloudflare refuses more than 100 000 iterations in WebCrypto
// and node:crypto alike (workerd's `checkPbkdfLimits` under its default
// limit enforcer). workerd run locally sets no limit.
import { pbkdf2, pbkdf2Sync } from "node:crypto";

const caught = (call) => {
  try {
    return { bytes: call().length };
  } catch (error) {
    return { name: error.name, message: error.message };
  }
};

export default {
  async fetch() {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("password"), "PBKDF2", false, ["deriveBits"]);
    const derive = (iterations) =>
      crypto.subtle
        .deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(8), iterations }, key, 256)
        .then((bits) => ({ bytes: bits.byteLength }), (error) => ({ name: error.name, message: error.message }));
    const callback = await new Promise((resolve) =>
      pbkdf2("password", "salt", 100001, 32, "sha256", (error, bytes) =>
        resolve(error ? { name: error.name, message: error.message } : { bytes: bytes.length }),
      ),
    );
    return Response.json({
      webAtCap: await derive(100000),
      webOver: await derive(100001),
      nodeAtCap: caught(() => pbkdf2Sync("password", "salt", 100000, 32, "sha256")),
      nodeOver: caught(() => pbkdf2Sync("password", "salt", 1000000, 32, "sha256")),
      nodeCallback: callback,
    });
  },
};
