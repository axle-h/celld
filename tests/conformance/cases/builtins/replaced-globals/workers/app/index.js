// What a script reaches by replacing the globals the runtime's own APIs might
// use. Replacing `Crypto.prototype.getRandomValues` changes what a script's
// own calls draw, but not the secret keys `crypto.subtle.generateKey()` makes.
// Replacing the global `setTimeout` and `clearTimeout` stalls nothing:
// `scheduler.wait()`, `AbortSignal.timeout()` and node:timers/promises arm
// their timers without them. Each probe restores what it replaced.
import { setTimeout as sleep } from "node:timers/promises";

const allZero = (bytes) => bytes.every((byte) => byte === 0);

const probes = {
  async random() {
    const proto = Object.getPrototypeOf(crypto);
    const original = proto.getRandomValues;
    proto.getRandomValues = (array) => array;
    try {
      const raw = async (algorithm, usages) => new Uint8Array(await crypto.subtle.exportKey(
        "raw", await crypto.subtle.generateKey(algorithm, true, usages)));
      return {
        "patched-draw-all-zero": allZero(crypto.getRandomValues(new Uint8Array(16))),
        "aes-gcm-key-all-zero": allZero(await raw({ name: "AES-GCM", length: 256 }, ["encrypt"])),
        "aes-cbc-key-all-zero": allZero(await raw({ name: "AES-CBC", length: 128 }, ["encrypt"])),
        "hmac-key-all-zero": allZero(await raw({ name: "HMAC", hash: "SHA-256" }, ["sign"])),
      };
    } finally {
      proto.getRandomValues = original;
    }
  },

  async timers() {
    const { setTimeout: originalSet, clearTimeout: originalClear } = globalThis;
    let calls = 0;
    globalThis.setTimeout = () => { calls++; return 0; };
    globalThis.clearTimeout = () => { calls++; };
    // A stalled wait would hang the request, so each races a guard armed
    // with the original timer.
    const settle = (promise) => new Promise((resolve) => {
      const guard = originalSet(() => resolve("stalled"), 2000);
      promise.then(
        () => { originalClear(guard); resolve("resolved"); },
        (error) => { originalClear(guard); resolve(`rejected ${error.name}`); },
      );
    });
    const aborted = (signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    try {
      const controller = new AbortController();
      const cancelled = sleep(60000, undefined, { signal: controller.signal });
      controller.abort();
      return {
        "scheduler-wait": await settle(scheduler.wait(10)),
        "abort-signal-timeout": await settle(aborted(AbortSignal.timeout(10))),
        "node-timers-promises": await settle(sleep(10)),
        "node-timers-promises-aborted": await settle(cancelled),
        "replaced-calls": calls,
      };
    } finally {
      globalThis.setTimeout = originalSet;
      globalThis.clearTimeout = originalClear;
    }
  },
};

export default {
  async fetch(request) {
    const probe = probes[new URL(request.url).searchParams.get("probe")];
    if (probe === undefined) return new Response("unknown probe", { status: 400 });
    return Response.json(await probe());
  },
};
