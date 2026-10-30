// Operations at a Dynamic Worker's module scope where celld differs from
// workerd for reasons of its own, not global scope's (plan 1.67): Web
// Crypto's checks of a key it generates, which come before the refusal, and
// queueMicrotask(), which returns a promise.
import { probe } from "#global-scope-ops";

const groups = {
  gaps: {
    "queue-microtask": { op: `queueMicrotask(() => {})` },
    "generate-aes-kw": {
      op: `crypto.subtle.generateKey({ name: "AES-KW", length: 128 }, true, ["wrapKey"])`,
    },
    "generate-aes-bad-length": {
      op: `crypto.subtle.generateKey({ name: "AES-GCM", length: 7 }, true, ["encrypt"])`,
    },
    "generate-aes-bad-usage": {
      op: `crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, true, ["sign"])`,
    },
    "generate-hmac-bad-hash": {
      op: `crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-3" }, true, ["sign"])`,
    },
  },
};

export default probe(groups);
