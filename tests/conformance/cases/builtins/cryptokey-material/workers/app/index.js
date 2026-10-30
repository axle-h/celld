import {
  KeyObject, createHash, createHmac, createPublicKey, createSecretKey, generateKeyPairSync,
} from "node:crypto";

// What a script can see of a CryptoKey, and that a non-extractable key's
// material leaves it through no path a script can reach: no property, no
// export, no wrap, no node:crypto KeyObject export.
const bytes = (n) => new Uint8Array(n);
const report = (error) =>
  `${error?.constructor?.name}(${error?.name}): ${error?.message}`;
const attempt = async (probe) => {
  try {
    const value = await probe();
    if (value instanceof ArrayBuffer) return `returned ArrayBuffer(${value.byteLength})`;
    if (ArrayBuffer.isView(value)) return `returned ${value.constructor.name}(${value.byteLength})`;
    return `returned ${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`;
  } catch (error) {
    return report(error);
  }
};

// Every own key, inherited key and descriptor a script can enumerate.
const describeDescriptor = (d) => d === undefined ? "none"
  : "get" in d
    ? `accessor get=${typeof d.get} set=${typeof d.set} e=${d.enumerable} c=${d.configurable}`
    : `data w=${d.writable} e=${d.enumerable} c=${d.configurable} ${typeof d.value}`;
const surface = (key) => {
  const own = Reflect.ownKeys(key).map(String);
  const descriptors = {};
  for (const name of Reflect.ownKeys(key))
    descriptors[String(name)] = describeDescriptor(Object.getOwnPropertyDescriptor(key, name));
  const forIn = [];
  for (const name in key) forIn.push(name);
  return {
    own, descriptors, forIn,
    keys: Object.keys(key),
    json: JSON.stringify(key),
    assign: JSON.stringify(Object.assign({}, key)),
    spread: Object.keys({ ...key }),
    material: typeof key.__celldMaterial,
    materialIn: "__celldMaterial" in key,
    type: key.type, extractable: key.extractable, usages: key.usages,
    algorithmName: key.algorithm.name,
  };
};

// A key's bytes that nothing else in a probe holds: any view a script can
// reach that carries them came from the key.
const SECRET = () => bytes(16).fill(0xa7);
const holdsSecret = (value) => {
  const view = value instanceof ArrayBuffer ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let run = 0;
  for (const byte of view) if ((run = byte === 0xa7 ? run + 1 : 0) === 16) return true;
  return false;
};
// Whether the key's bytes are reachable from `root` through own properties,
// string- or symbol-keyed, and prototypes, as data a script reads without
// calling anything.
const reachesSecret = (root) => {
  const seen = new Set();
  const walk = (value, depth) => {
    if (value === null || typeof value !== "object" || seen.has(value) || depth > 8) return false;
    seen.add(value);
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return holdsSecret(value);
    for (const name of Reflect.ownKeys(value)) {
      const d = Object.getOwnPropertyDescriptor(value, name);
      if (d && "value" in d && walk(d.value, depth + 1)) return true;
    }
    return walk(Object.getPrototypeOf(value), depth + 1);
  };
  return walk(root, 0);
};
// An object's own symbols, and what each holds: its own keys and its
// prototype's.
const handles = (object) => Object.fromEntries(Object.getOwnPropertySymbols(object).map((symbol) => {
  const value = object[symbol];
  const shape = value === null || typeof value !== "object" ? typeof value : {
    own: Reflect.ownKeys(value).map(String),
    prototype: Object.getOwnPropertyNames(Object.getPrototypeOf(value)),
  };
  return [String(symbol), shape];
}));
// How a call ended: a synchronous throw, or how its promise settled.
const settle = async (call) => {
  try {
    const value = call();
    if (value === null || typeof value?.then !== "function") return `returned ${typeof value}`;
    return await value.then((v) => `resolved ${v?.constructor?.name}`, (e) => `rejected ${report(e)}`);
  } catch (error) {
    return `threw ${report(error)}`;
  }
};

const keys = async () => {
  const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, false, ["encrypt", "decrypt"]);
  const hmac = await crypto.subtle.importKey("raw", bytes(16).fill(7), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const rsa = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    false, ["sign", "verify"]);
  const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const ed = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const ecdh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const pbkdf2 = await crypto.subtle.importKey("raw", bytes(8), "PBKDF2", false, ["deriveBits"]);
  return { aes, hmac, rsa, ec, ed, ecdh, pbkdf2 };
};

const STEPS = {
  async handles() {
    const hmac = await crypto.subtle.importKey("raw", SECRET(), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const aes = await crypto.subtle.importKey("raw", SECRET(), "AES-GCM", false, ["encrypt"]);
    const subjects = {
      "createHmac(CryptoKey)": createHmac("sha256", hmac).update("x"),
      "createHmac(KeyObject)": createHmac("sha256", KeyObject.from(aes)).update("x"),
      "createHmac(bytes)": createHmac("sha256", SECRET()).update("x"),
      "createHash": createHash("sha256").update(SECRET()),
      "Hash.copy": createHash("sha256").update(SECRET()).copy(),
      "KeyObject.from(hmac)": KeyObject.from(hmac),
      "createSecretKey": createSecretKey(SECRET()),
    };
    const out = {};
    for (const [label, subject] of Object.entries(subjects))
      out[label] = { handles: handles(subject), reached: reachesSecret(subject) };
    const pair = generateKeyPairSync("ed25519");
    out["generateKeyPairSync private"] = { handles: handles(pair.privateKey) };
    out["digest through the handle"] = await attempt(() => {
      const h = createHmac("sha256", hmac);
      return h[Object.getOwnPropertySymbols(h)[0]].digest();
    });
    out["export through the KeyObject's handle"] = await attempt(() => {
      const k = KeyObject.from(hmac);
      return crypto.subtle.exportKey("raw", k[Object.getOwnPropertySymbols(k)[0]]);
    });
    out["hmac still signs"] = createHmac("sha256", hmac).update("x").digest("hex")
      === createHmac("sha256", SECRET()).update("x").digest("hex");
    return out;
  },
  async retyped() {
    const k = await keys();
    const typed = (key, type) => Object.defineProperty(key, "type", { value: type });
    const derive = (key) => () => createPublicKey(key).asymmetricKeyType;
    const refused = async (probe) => {
      const outcome = await attempt(probe);
      return outcome.startsWith("returned") ? outcome : "refused";
    };
    return {
      "secret CryptoKey typed private": await attempt(derive(typed(k.aes, "private"))),
      "secret KeyObject typed private": await attempt(derive(typed(KeyObject.from(k.hmac), "private"))),
      "public CryptoKey typed private": await attempt(derive(typed(k.ec.publicKey, "private"))),
      "private CryptoKey typed secret": await attempt(derive(typed(k.ec.privateKey, "secret"))),
      "private KeyObject": await attempt(derive(generateKeyPairSync("ed25519").privateKey)),
      // Both refuse; workerd's text is its raw export's, which celld lacks.
      "createHmac of a private KeyObject typed secret": await refused(() =>
        createHmac("sha256", typed(KeyObject.from(k.ed.privateKey), "secret")).digest()),
      "createHmac of a private CryptoKey typed secret": await refused(() =>
        createHmac("sha256", typed(k.rsa.privateKey, "secret")).digest()),
      "sign after algorithm.hash is changed": await attempt(async () => {
        const key = await crypto.subtle.importKey("raw", bytes(16), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        key.algorithm.hash.name = "SHA-1";
        return crypto.subtle.sign("HMAC", key, bytes(1));
      }),
    };
  },
  async receiver() {
    const k = await keys();
    const subtle = crypto.subtle;
    const proto = SubtleCrypto.prototype;
    const pbkdf2 = { name: "PBKDF2", hash: "SHA-256", salt: bytes(8), iterations: 2 };
    const aes = { name: "AES-GCM", length: 128 };
    const gcm = { name: "AES-GCM", iv: bytes(12) };
    const wrapping = await subtle.generateKey(aes, false, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
    const wrapped = await subtle.encrypt(gcm, wrapping, SECRET());
    const base = await subtle.importKey("raw", bytes(8), "PBKDF2", false, ["deriveBits", "deriveKey"]);
    const extractable = await subtle.importKey("raw", SECRET(), "AES-GCM", true, ["encrypt"]);
    const calls = {
      digest: ["SHA-256", bytes(1)],
      importKey: ["raw", bytes(16), "AES-GCM", false, ["encrypt"]],
      exportKey: ["raw", k.aes],
      generateKey: [aes, false, ["encrypt"]],
      deriveBits: [pbkdf2, base, 128],
      deriveKey: [pbkdf2, base, aes, false, ["encrypt"]],
      sign: ["HMAC", k.hmac, bytes(1)],
      verify: ["HMAC", k.hmac, bytes(32), bytes(1)],
      encrypt: [gcm, wrapping, bytes(1)],
      decrypt: [gcm, wrapping, wrapped],
      wrapKey: ["raw", extractable, wrapping, gcm],
      unwrapKey: ["raw", wrapped, wrapping, gcm, "AES-GCM", false, ["encrypt"]],
      timingSafeEqual: [bytes(1), bytes(1)],
    };
    const out = {};
    for (const [name, args] of Object.entries(calls)) {
      out[name] = {
        own: await settle(() => subtle[name](...args)),
        plain: await settle(() => proto[name].call({}, ...args)),
        inherits: await settle(() => proto[name].call(Object.create(subtle), ...args)),
        detached: await settle(() => (0, proto[name])(...args)),
      };
    }
    // A stand-in receiver, or a replaced method, sees none of a
    // non-extractable result's bytes.
    let seen = [];
    const capture = (label) => (...args) => {
      seen.push(`${label} ${args.map((a) => a instanceof ArrayBuffer ? `ArrayBuffer(${a.byteLength})` : typeof a).join(",")}`);
      return Promise.reject(new Error("captured"));
    };
    const standIn = {
      deriveBits: (...a) => subtle.deriveBits(...a), decrypt: (...a) => subtle.decrypt(...a),
      exportKey: capture("exportKey"), importKey: capture("importKey"), encrypt: capture("encrypt"),
    };
    const run = async (label, call) => {
      seen = [];
      out[label] = { result: await settle(call), seen };
    };
    await run("deriveKey on a stand-in", () => proto.deriveKey.call(standIn, ...calls.deriveKey));
    await run("unwrapKey on a stand-in", () => proto.unwrapKey.call(standIn, ...calls.unwrapKey));
    await run("wrapKey on a stand-in", () => proto.wrapKey.call(standIn, ...calls.wrapKey));
    const replace = async (target, name, label, call) => {
      const saved = Object.getOwnPropertyDescriptor(target, name);
      target[name] = capture(name);
      try { await run(label, call); } finally {
        if (saved) Object.defineProperty(target, name, saved); else delete target[name];
      }
    };
    await replace(subtle, "importKey", "deriveKey, importKey replaced", () => subtle.deriveKey(...calls.deriveKey));
    await replace(proto, "deriveBits", "deriveKey, prototype deriveBits replaced", () => subtle.deriveKey(...calls.deriveKey));
    await replace(proto, "importKey", "unwrapKey, prototype importKey replaced", () => subtle.unwrapKey(...calls.unwrapKey));
    await replace(subtle, "decrypt", "unwrapKey, decrypt replaced", () => subtle.unwrapKey(...calls.unwrapKey));
    await replace(subtle, "exportKey", "wrapKey, exportKey replaced", () => subtle.wrapKey(...calls.wrapKey));
    await replace(subtle, "encrypt", "wrapKey, encrypt replaced", () => subtle.wrapKey(...calls.wrapKey));
    return out;
  },
  async surface() {
    const k = await keys();
    return {
      secret: surface(k.aes),
      hmac: surface(k.hmac),
      rsaPrivate: surface(k.rsa.privateKey),
      rsaPublic: surface(k.rsa.publicKey),
      ecPrivate: surface(k.ec.privateKey),
      ed25519Private: surface(k.ed.privateKey),
      getOwnPropertyNames: Object.getOwnPropertyNames(k.aes),
      prototypeNames: Object.getOwnPropertyNames(CryptoKey.prototype),
      symbols: Object.getOwnPropertySymbols(k.aes).length,
    };
  },
  async tamper() {
    const k = await keys();
    const key = k.aes;
    return {
      "assign extractable": await attempt(() => { key.extractable = true; return key.extractable; }),
      "define extractable": await attempt(() => {
        Object.defineProperty(key, "extractable", { value: true }); return key.extractable;
      }),
      "define material": await attempt(() => {
        Object.defineProperty(key, "__celldMaterial", { value: { bytes: bytes(16) } });
        return typeof key.__celldMaterial;
      }),
      "export after tamper": await attempt(() => crypto.subtle.exportKey("raw", key)),
      "export proxy": await attempt(() => crypto.subtle.exportKey("raw", new Proxy(key, {}))),
      "proxy traps": await attempt(() => {
        const seen = [];
        const proxy = new Proxy(k.hmac, {
          get(target, name, receiver) { seen.push(String(name)); return Reflect.get(target, name); },
          has(target, name) { seen.push(`has ${String(name)}`); return Reflect.has(target, name); },
          getOwnPropertyDescriptor(target, name) {
            seen.push(`gopd ${String(name)}`); return Reflect.getOwnPropertyDescriptor(target, name);
          },
        });
        return crypto.subtle.sign("HMAC", proxy, bytes(1)).then(
          (sig) => ({ sig: sig.byteLength, seen }), (error) => ({ error: report(error), seen }));
      }),
    };
  },
  async exports() {
    const k = await keys();
    const wrapGcm = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, true, ["encrypt", "wrapKey"]);
    const der = (key, type, format) => () => KeyObject.from(key).export({ type, format });
    return {
      "exportKey raw secret": await attempt(() => crypto.subtle.exportKey("raw", k.aes)),
      "exportKey jwk secret": await attempt(() => crypto.subtle.exportKey("jwk", k.aes)),
      "exportKey raw hmac": await attempt(() => crypto.subtle.exportKey("raw", k.hmac)),
      "exportKey pkcs8 rsa": await attempt(() => crypto.subtle.exportKey("pkcs8", k.rsa.privateKey)),
      "exportKey jwk rsa": await attempt(() => crypto.subtle.exportKey("jwk", k.rsa.privateKey)),
      "exportKey pkcs8 ec": await attempt(() => crypto.subtle.exportKey("pkcs8", k.ec.privateKey)),
      "exportKey pkcs8 ed25519": await attempt(() => crypto.subtle.exportKey("pkcs8", k.ed.privateKey)),
      "exportKey spki rsa public": await attempt(() => crypto.subtle.exportKey("spki", k.rsa.publicKey)),
      "exportKey raw pbkdf2": await attempt(() => crypto.subtle.exportKey("raw", k.pbkdf2)),
      "wrapKey raw secret (AES-GCM)": await attempt(() =>
        crypto.subtle.wrapKey("raw", k.aes, wrapGcm, { name: "AES-GCM", iv: bytes(12) })),
      "wrapKey jwk hmac (AES-GCM)": await attempt(() =>
        crypto.subtle.wrapKey("jwk", k.hmac, wrapGcm, { name: "AES-GCM", iv: bytes(12) })),
      "wrapKey pkcs8 rsa (AES-GCM)": await attempt(() =>
        crypto.subtle.wrapKey("pkcs8", k.rsa.privateKey, wrapGcm, { name: "AES-GCM", iv: bytes(12) })),
      "wrapKey extractable (AES-GCM)": await attempt(async () => {
        const key = await crypto.subtle.importKey("raw", bytes(16), "AES-GCM", true, ["encrypt"]);
        return crypto.subtle.wrapKey("raw", key, wrapGcm, { name: "AES-GCM", iv: bytes(12) });
      }),
      "KeyObject.from secret type": await attempt(() => KeyObject.from(k.aes).type),
      "KeyObject.from secret export buffer": await attempt(() => KeyObject.from(k.aes).export()),
      "KeyObject.from secret export jwk": await attempt(() => KeyObject.from(k.hmac).export({ format: "jwk" })),
      "KeyObject.from rsa export pkcs8": await attempt(der(k.rsa.privateKey, "pkcs8", "der")),
      "KeyObject.from rsa export pem": await attempt(der(k.rsa.privateKey, "pkcs8", "pem")),
      "KeyObject.from ec export jwk": await attempt(() => KeyObject.from(k.ec.privateKey).export({ format: "jwk" })),
      "KeyObject.from ed25519 export": await attempt(der(k.ed.privateKey, "pkcs8", "der")),
      "KeyObject.from rsa public export": await attempt(der(k.rsa.publicKey, "spki", "der")),
      "KeyObject equals non-extractable": await attempt(async () => {
        const again = await crypto.subtle.importKey("raw", bytes(16).fill(7), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        return KeyObject.from(k.hmac).equals(KeyObject.from(again));
      }),
    };
  },
  async use() {
    const k = await keys();
    const data = bytes(4);
    const iv = bytes(12);
    return {
      "AES-GCM round trip": await attempt(async () => {
        const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k.aes, data);
        return (await crypto.subtle.decrypt({ name: "AES-GCM", iv }, k.aes, sealed)).byteLength;
      }),
      "HMAC sign/verify": await attempt(async () => {
        const sig = await crypto.subtle.sign("HMAC", k.hmac, data);
        return crypto.subtle.verify("HMAC", k.hmac, sig, data);
      }),
      "RSA sign/verify": await attempt(async () => {
        const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k.rsa.privateKey, data);
        return crypto.subtle.verify("RSASSA-PKCS1-v1_5", k.rsa.publicKey, sig, data);
      }),
      "ECDSA sign/verify": await attempt(async () => {
        const alg = { name: "ECDSA", hash: "SHA-256" };
        const sig = await crypto.subtle.sign(alg, k.ec.privateKey, data);
        return crypto.subtle.verify(alg, k.ec.publicKey, sig, data);
      }),
      "Ed25519 sign/verify": await attempt(async () => {
        const sig = await crypto.subtle.sign("Ed25519", k.ed.privateKey, data);
        return crypto.subtle.verify("Ed25519", k.ed.publicKey, sig, data);
      }),
      "ECDH derive": await attempt(async () =>
        (await crypto.subtle.deriveBits({ name: "ECDH", public: k.ecdh.publicKey }, k.ecdh.privateKey, 256)).byteLength),
      "PBKDF2 derive": await attempt(async () =>
        (await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: bytes(8), iterations: 2 }, k.pbkdf2, 128)).byteLength),
    };
  },
  async clone(env) {
    const k = await keys();
    return {
      "structuredClone secret": await attempt(async () => {
        const clone = structuredClone(k.hmac);
        const sig = await crypto.subtle.sign("HMAC", clone, bytes(1));
        return crypto.subtle.verify("HMAC", k.hmac, sig, bytes(1));
      }),
      "structuredClone private": await attempt(() => typeof structuredClone(k.rsa.privateKey)),
      "structuredClone in object": await attempt(() => typeof structuredClone({ key: k.aes })),
      "RPC secret": await attempt(() => env.BACK.use(k.hmac)),
      "RPC in object": await attempt(() => env.BACK.use({ key: k.hmac })),
    };
  },
};

export default {
  async fetch(request, env) {
    const step = STEPS[new URL(request.url).searchParams.get("step")];
    if (!step) return new Response("unknown step", { status: 400 });
    return Response.json(await step(env));
  },
};
