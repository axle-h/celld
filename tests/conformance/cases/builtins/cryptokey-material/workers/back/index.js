import { WorkerEntrypoint } from "cloudflare:workers";

// Receives a CryptoKey over RPC and uses it, if one arrives.
export default class extends WorkerEntrypoint {
  async fetch() { return new Response("back"); }
  async use(key) {
    const sig = await crypto.subtle.sign("HMAC", key, new Uint8Array(1));
    return { type: key.type, extractable: key.extractable, signature: sig.byteLength };
  }
}
