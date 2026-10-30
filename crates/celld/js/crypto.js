// Web Crypto implementation for the embedded runtime.
//
// The common WebCrypto paths use typed-array host ops.
// Cells keeps a second, JSON-shaped op for Workers-compatible algorithms that
// require structured arguments (RSA-OAEP, ECDSA, and Ed25519).
(function () {
  // A script's random values, which global scope refuses (js.rs
  // `GLOBAL_SCOPE_OPS`), and celld's own, which nothing refuses.
  const _randomValues = $$randomValues;
  const _celldRandomValues = $$celldRandomValues;
  const _digest = $$digest;
  const _hmacSign = $$hmacSign;
  const _hmacVerify = $$hmacVerify;
  const _aesEncrypt = $$aesEncrypt;
  const _aesDecrypt = $$aesDecrypt;

  // MD5 is not in the Web Crypto spec; Cloudflare accepts it for `digest`
  // and DigestStream, and the host op has always implemented it.
  const _CRC_ALGS = new Set(["CRC32", "CRC32C", "CRC64NVME"]);
  const _DIGEST_ALGS = new Set([
    "SHA-1", "SHA-256", "SHA-384", "SHA-512", "MD5",
  ]);
  const _SECRET_KEY_ALGS = new Set(
    ["HMAC", "AES-GCM", "AES-CBC", "AES-CTR"],
  );
  // Cloudflare accepts its own pre-standard curve spellings beside the
  // standard ones.
  const _curveName = (curve) =>
    curve === "NODE-ED25519" ? "Ed25519" : String(curve ?? "");
  // The curves celld carries, under every spelling Web Crypto and Node use.
  const _EC_CURVES = {
    "P-256": "P-256", "prime256v1": "P-256", "secp256r1": "P-256",
    "P-384": "P-384", "secp384r1": "P-384",
    "P-521": "P-521", "secp521r1": "P-521",
  };
  const _canonicalEcCurve = (curve) => _EC_CURVES[_curveName(curve)];
  // An exported key as workerd's JsonWebKey struct: its members in
  // declaration order, every one but `kty` optional (`__struct`).
  const _JWK_MEMBERS = ["kty", "use", "key_ops", "alg", "ext", "crv", "x", "y",
    "d", "n", "e", "p", "q", "dp", "dq", "qi", "oth", "k", "pub", "priv"];
  const _jwkStruct = __celld.__jwkStruct = (jwk) => __celld.__struct(
    _JWK_MEMBERS.map((name) => [name, jwk[name], name !== "kty"]));
  // The asymmetric algorithms, as the uppercased name `_algorithmName`
  // produces mapped to the spelling `key.algorithm.name` reports. The
  // uppercased form is for lookup only: echoing it back names an algorithm
  // no library recognizes, because `RSASSA-PKCS1-V1_5` is not the Web
  // Crypto spelling of `RSASSA-PKCS1-v1_5`.
  const _ASYM_NAMES = {
    "RSASSA-PKCS1-V1_5": "RSASSA-PKCS1-v1_5",
    "RSA-OAEP": "RSA-OAEP",
    "RSA-PSS": "RSA-PSS",
    "ECDSA": "ECDSA",
    "ECDH": "ECDH",
    "ED25519": "Ed25519",
    // Cloudflare's pre-standard spelling reports itself back, because a
    // caller that asked with it matches on what it asked for -- which is
    // what the upstream `eddsa_test` group pins.
    "NODE-ED25519": "NODE-ED25519",
    "X25519": "X25519",
  };
  // The one signature algorithm over Curve25519, under both spellings. Its
  // two names share every host op, so sign, verify and generate look the
  // algorithm up here rather than testing two strings each.
  const _ED25519_ALGS = new Set(["ED25519", "NODE-ED25519"]);
  // The Secure Curves, whose `raw` Web Crypto form is the bare 32-byte
  // public point rather than a DER document.
  const _OKP_CURVES = { "ED25519": "Ed25519", "NODE-ED25519": "Ed25519",
    "X25519": "X25519" };
  // Algorithms whose keys are asymmetric, whatever celld can then *do* with
  // them: import validates the key, and an unsupported operation throws
  // later at sign/verify/encrypt rather than here. Derived from the table
  // above, not written twice: an algorithm that imports but has no reported
  // spelling would report the uppercased lookup key.
  const _ASYM_ALGS = new Set(Object.keys(_ASYM_NAMES));

  function _toBuf(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    throw new TypeError("expected an ArrayBuffer or ArrayBufferView");
  }

  // A BufferSource parameter of a method, refused with JSG's error for it.
  function _bufferParam(data, method, owner, index) {
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return _toBuf(data);
    throw __celld.__jsg.execute(method, owner, index, "BufferSource");
  }

  // A CryptoKey parameter of a SubtleCrypto method, as its state
  // (`_keyState`), refused with JSG's error for anything else.
  function _keyParam(key, method, index) {
    const state = _keyState(key);
    if (state === undefined)
      throw __celld.__jsg.execute(method, "SubtleCrypto", index, "CryptoKey");
    return state;
  }

  // The algorithms workerd knows (crypto.c++ `registeredAlgorithms`, without
  // the ML-DSA and ML-KEM ones its webcrypto_modern_algorithms flag adds),
  // uppercased, and those it can generate a key for. An algorithm outside
  // them gets workerd's "Unrecognized" error, which echoes the name as the
  // caller wrote it; one inside them that celld lacks gets celld's own.
  const _WORKERD_ALGS = new Set([
    "AES-CTR", "AES-CBC", "AES-GCM", "AES-KW", "HMAC", "PBKDF2", "HKDF",
    "RSASSA-PKCS1-V1_5", "RSA-PSS", "RSA-OAEP", "ECDSA", "ECDH",
    "NODE-ED25519", "ED25519", "X25519", "RSA-RAW",
  ]);
  const _WORKERD_GENERATE_ALGS = new Set(
    [..._WORKERD_ALGS].filter((name) =>
      name !== "PBKDF2" && name !== "HKDF" && name !== "RSA-RAW"));
  const _KEY_FORMATS = new Set(["raw", "pkcs8", "spki", "jwk"]);
  // The algorithm's name as the caller wrote it.
  function _givenAlgorithmName(algorithm) {
    return String(typeof algorithm === "string" ? algorithm : algorithm?.name ?? "");
  }

  function _algorithmName(algorithm) {
    return String(
      typeof algorithm === "string" ? algorithm : algorithm?.name || "",
    ).toUpperCase();
  }

  function _hashName(hash) {
    return _algorithmName(
      typeof hash === "string" ? hash : hash?.name || "SHA-256",
    );
  }

  // workerd's DEFAULT_MAX_PBKDF2_ITERATIONS, which Cloudflare enforces for
  // WebCrypto and node:crypto alike (`checkPbkdfLimits`); workerd run
  // locally sets no limit.
  const MAX_PBKDF2_ITERATIONS = 100000;
  function pbkdf2LimitMessage(iterations) {
    return `Pbkdf2 failed: iteration counts above ${MAX_PBKDF2_ITERATIONS} ` +
      `are not supported (requested ${iterations}).`;
  }

  // workerd's refusal to export a key made non-extractable.
  function _notExtractable(state) {
    return new DOMException(
      `Attempt to export non-extractable ${state.algorithm?.name} key.`, "InvalidAccessError");
  }

  function _notSupported(message) {
    return new DOMException(message, "NotSupportedError");
  }

  function _operationError(message) {
    return new DOMException(message, "OperationError");
  }

  function _rsaOaepLabel(algorithm) {
    const label = _toBuf(algorithm?.label ?? new Uint8Array());
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(label);
    } catch {
      throw _notSupported("RSA-OAEP labels must contain UTF-8 bytes");
    }
    return Array.from(label);
  }

  // A CryptoKey is made only by celld (`__celld.__makeCryptoKey`): a script
  // that calls the constructor gets workerd's "Illegal constructor".
  const kMakeKey = Symbol("celld.CryptoKey.make");
  // A key's state: its type, algorithm, extractability, usages and
  // material. Only celld reads it (`_keyState`, `__celld.__cryptoKeyState`):
  // the key's public properties are copies a script may redefine, as it may
  // workerd's, so every check reads this instead, and no property, Proxy,
  // inspection or clone of a key reaches its material.
  let _keyState;
  // The state's own copy of a key's algorithm dictionary: the one
  // `key.algorithm` holds is the script's to change, and a changed
  // `algorithm.hash.name` must not change what the key signs with.
  const _copyAlgorithm = (value) => {
    if (ArrayBuffer.isView(value)) return value.slice();
    if (value === null || typeof value !== "object") return value;
    const copy = {};
    for (const name of Object.keys(value)) copy[name] = _copyAlgorithm(value[name]);
    return copy;
  };
  class CryptoKey {
    #state;
    static {
      // The key's state, or undefined for anything else: a Proxy of a key,
      // or an object that only inherits from one, is not a key.
      _keyState = (value) =>
        typeof value === "object" && value !== null && #state in value
          ? value.#state : undefined;
    }
    // A rest parameter, so `CryptoKey.length` is 0, as workerd's is.
    constructor(...args) {
      const [token, type, algorithm, extractable, usages, material] = args;
      if (token !== kMakeKey) throw new TypeError("Illegal constructor");
      this.#state = {
        __proto__: null, type, algorithm: _copyAlgorithm(algorithm),
        extractable: Boolean(extractable),
        usages: Object.freeze(Array.from(usages || [])), material,
      };
      // workerd's instance properties: read-only, enumerable and
      // configurable, in its order.
      const state = this.#state;
      Object.defineProperties(this, {
        usages: { __proto__: null, value: state.usages, enumerable: true, configurable: true },
        algorithm: { __proto__: null, value: algorithm, enumerable: true, configurable: true },
        extractable: { __proto__: null, value: state.extractable, enumerable: true, configurable: true },
        type: { __proto__: null, value: type, enumerable: true, configurable: true },
      });
    }
  }
  // The brand the RPC envelope classifies by (harness.js, `__hostKind`).
  __celld.__isCryptoKey = (value) => _keyState(value) !== undefined;
  // For node:crypto, which keeps a CryptoKey as a KeyObject's handle.
  __celld.__cryptoKeyState = _keyState;

  // A WebIDL `long`, as workerd's JSG converts one: a value that is not
  // finite is 0, anything else is truncated and must fit 32 bits.
  function _webIdlLong(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    const long = Math.trunc(number);
    if (long < -0x8000_0000 || long > 0x7fff_ffff) {
      throw new TypeError(
        "Value out of range. Must be between -2147483648 and 2147483647 (inclusive).");
    }
    return long + 0;
  }

  // RSA key generation's parameters and usages, as workerd's generateRsa,
  // validateRsaParams (api/crypto/rsa.c++) and generateKey (crypto.c++)
  // check them under strict_crypto_checks, in their order: the exponent, the
  // hash and the modulus are required, the modulus positive, the hash a
  // digest workerd knows (lookupDigestAlgorithm), each usage one the
  // algorithm has (CryptoKeyUsageSet::validate), then the modulus's range,
  // the exponent and the modulus's multiple. Only 3 and 65537 are legal
  // exponents, so no other reaches the prime search, and the modulus is
  // bounded before it does. Key generation refuses a modulus under 512 bits
  // (BoringSSL), and only then does workerd find a private key without
  // usages.
  function _rsaGenerateParams(name, algorithm, usages) {
    const rawModulus = algorithm?.modulusLength;
    const modulusLength = rawModulus === undefined ? undefined : _webIdlLong(rawModulus);
    const rawExponent = algorithm?.publicExponent;
    if (rawExponent === undefined) {
      throw new TypeError('Missing field "publicExponent" in "algorithm".');
    }
    const exponentBytes = _toBuf(rawExponent).slice();
    if (algorithm?.hash === undefined) {
      throw new TypeError('Missing field "hash" in "algorithm".');
    }
    if (modulusLength === undefined) {
      throw new TypeError('Missing field "modulusLength" in "algorithm".');
    }
    if (modulusLength <= 0) {
      throw _operationError(
        `modulusLength must be greater than zero (requested ${modulusLength}).`);
    }
    if (!_DIGEST_ALGS.has(_hashName(algorithm.hash))) {
      throw _notSupported("Unrecognized or unimplemented digest algorithm requested.");
    }
    const normalizedName = _ASYM_NAMES[name];
    const valid = name === "RSA-OAEP" ? _RSA_OAEP_USAGES : _RSA_SIGN_USAGES;
    for (const usage of usages) {
      if (!valid.includes(usage)) {
        throw new DOMException(
          `Attempt to generate ${normalizedName} key with invalid usage "${usage}".`,
          "SyntaxError");
      }
    }
    if (modulusLength % 8 !== 0 || modulusLength < 256 || modulusLength > 16384) {
      throw _operationError(
        "The modulus length must be a multiple of 8 and between 256 and 16k, " +
          `but ${modulusLength} was requested.`);
    }
    // The exponent as an unsigned 32-bit number, as workerd's fromBignum
    // reads its big-endian bytes: one whose bytes reach past four is larger.
    let publicExponent = 0;
    for (let i = 0; i < exponentBytes.byteLength; i++) {
      if (exponentBytes.byteLength - i - 1 >= 4 && exponentBytes[i] !== 0) {
        throw _operationError(
          'The "publicExponent" must be either 3 or 65537, but got a number ' +
            "larger than 2^32.");
      }
      publicExponent = publicExponent * 256 + exponentBytes[i];
    }
    if (publicExponent !== 3 && publicExponent !== 65537) {
      throw _operationError(
        `The "publicExponent" must be either 3 or 65537, but got ${publicExponent}.`);
    }
    if (modulusLength % 128 !== 0) {
      throw _operationError(
        "Can't generate key: RSA key size is required to be a multiple of 128");
    }
    if (modulusLength < 512) throw _operationError("RSA key size is too small.");
    if (!usages.some((usage) => _PRIVATE_KEY_USAGES.includes(usage))) {
      throw new DOMException(
        "Attempt to generate asymmetric keys with no valid private key usages.",
        "SyntaxError");
    }
    return { modulusLength, publicExponent, exponentBytes };
  }

  const _RSA_OAEP_USAGES = ["encrypt", "decrypt", "wrapKey", "unwrapKey"];
  const _RSA_SIGN_USAGES = ["sign", "verify"];
  // Which half of a generated pair each usage goes to (workerd's
  // CryptoKeyUsageSet publicKeyMask and privateKeyMask).
  const _PUBLIC_KEY_USAGES = ["encrypt", "verify", "wrapKey"];
  const _PRIVATE_KEY_USAGES = ["decrypt", "sign", "unwrapKey", "deriveKey", "deriveBits"];

  // RSA-PSS's salt length, as workerd's RsaPssKey::addSalt takes it: given,
  // converted as a WebIDL long, and not negative. sign() reports a missing
  // one as a DataError and verify() as a TypeError, as workerd's do.
  function _rsaPssSaltLength(algorithm, signing) {
    const raw = algorithm?.saltLength;
    if (raw === undefined) {
      const message = "Failed to provide salt for RSA-PSS key operation which requires a salt";
      throw signing ? new DOMException(message, "DataError") : new TypeError(message);
    }
    const saltLength = _webIdlLong(raw);
    if (saltLength < 0) {
      throw new DOMException(
        `SaltLength for RSA-PSS must be non-negative (provided ${saltLength}).`, "DataError");
    }
    return saltLength;
  }

  // The length of an HMAC key imported from `raw`, as workerd's importHmac
  // (api/crypto/digest.c++) checks it: the data's bits, or fewer by at most
  // 7, and never none, so an empty key is refused. The bits past it are
  // zeroed in `raw`.
  function _hmacImportLength(requested, raw) {
    const keySize = raw.byteLength * 8;
    const length = requested === undefined ? keySize : _webIdlLong(requested);
    if (length <= 0 || length > keySize || length <= keySize - 8) {
      throw new DOMException(
        `Imported HMAC key length (${length}) must be a non-zero value up to 7 ` +
          "bits less than, and no greater than, the bit length of the raw key " +
          `data (${keySize}).`,
        "DataError");
    }
    if (length % 8 !== 0) raw[raw.byteLength - 1] &= 0xff << (8 - length % 8);
    return length;
  }

  function _makeKey(type, algorithm, extractable, usages, material) {
    return new CryptoKey(kMakeKey, type, algorithm, extractable, usages, material);
  }
  // For celld's other key makers: node:crypto.
  __celld.__makeCryptoKey = _makeKey;

  // Web Crypto reports a key's algorithm as its *KeyAlgorithm dictionary,
  // built from the parsed key, not as the request the caller passed. An
  // RSA key carries RsaHashedKeyAlgorithm: the modulus length, the public
  // exponent as bytes, and the hash as `{ name }`. An EC key carries its
  // curve. A JOSE library reads `algorithm.hash.name` and `modulusLength`
  // to validate an RS256 key before it ever calls verify(), so a key that
  // echoes the request's hash string fails with a TypeError. The host
  // parses every asymmetric key, so its details are the source here.
  //
  // `algorithm` is the caller's request, or null when there is none -- a
  // node:crypto KeyObject crossing to Web Crypto has only the parsed key.
  // RSA is the one algorithm whose hash the key itself does not carry, so
  // the request is the only source for it and a missing one means SHA-256.
  function _keyAlgorithm(name, algorithm, keyType, details) {
    const reported = { name: _ASYM_NAMES[_algorithmName(name)] ?? name };
    if (keyType === "rsa") {
      // The exponent is reported as a Uint8Array, which is what
      // `crypto_preserve_public_exponent` fixed upstream -- an ArrayBuffer
      // here is the bug that flag names. The host sends a decimal string,
      // because JSON cannot carry the BigInt the exponent can reach.
      const exponent = [];
      for (let n = BigInt(details.publicExponent); n; n >>= 8n) {
        exponent.unshift(Number(n & 255n));
      }
      reported.modulusLength = details.modulusLength;
      reported.publicExponent = Uint8Array.from(exponent);
      reported.hash = { name: _hashName(algorithm?.hash) };
    } else if (keyType === "ec") {
      // The host names the curve as node:crypto does; Web Crypto spells it
      // as the caller did, so map it back.
      reported.namedCurve =
        _canonicalEcCurve(details.namedCurve) ?? details.namedCurve;
    } else if (algorithm?.namedCurve !== undefined) {
      // Ed25519 and X25519 have one curve each, so the parsed key carries
      // no curve to report. Cloudflare still puts `namedCurve` on such a
      // key, and a caller that asked with `NODE-ED25519` matches on the
      // spelling it used, so the request's curve passes through.
      reported.namedCurve = algorithm.namedCurve;
    }
    return reported;
  }

  function _extra(operation, input) {
    return JSON.parse(__crypto_operation(operation, JSON.stringify(input)));
  }

  // The AES modes the host ops accept. `encrypt` and `decrypt` both test
  // against this one set, so neither can grow a mode the other refuses.
  const _AES_MODES = new Set(["AES-GCM", "AES-CBC", "AES-CTR"]);
  const _AES_GCM_TAG_LENGTHS = new Set([96, 104, 112, 120, 128]);
  const _RSA_OAEP_HASHES = new Set([
    "SHA-1", "SHA-256", "SHA-384", "SHA-512",
  ]);

  // All three modes take the same typed-array host ops: the key, the IV or
  // counter block, and the data are all bytes, so nothing here crosses as
  // JSON. CBC is PKCS#7-padded and CTR is its own inverse, so `encrypting`
  // only matters for CBC.
  //
  // AES-CTR names its IV `counter`, and that block belongs to the caller.
  // The host copies every view it is given, so nothing on this path can
  // increment the caller's block in place.
  //
  // AES-GCM reports a failure by returning nothing, and this turns that into
  // the `OperationError` the Web Crypto specification names. The block modes
  // throw from the host with the cause, so they never reach that branch.
  function _aes(name, algorithm, state, data, encrypting) {
    if ((name === "AES-GCM" || name === "AES-CBC") && algorithm.iv === undefined) {
      throw new TypeError('Missing field "iv" in "algorithm".');
    }
    if (name === "AES-GCM" && _toBuf(algorithm.iv).byteLength === 0) {
      throw new DOMException("AES-GCM IV must not be empty.", "OperationError");
    }
    const tagLength = name === "AES-GCM"
      ? Number(algorithm.tagLength ?? 128)
      : 128;
    if (name === "AES-GCM" && !_AES_GCM_TAG_LENGTHS.has(tagLength)) {
      throw _operationError("unsupported AES-GCM tagLength: " + tagLength);
    }
    const run = encrypting ? _aesEncrypt : _aesDecrypt;
    const out = run(
      name,
      state.material.bytes,
      _toBuf(name === "AES-CTR" ? algorithm.counter : algorithm.iv),
      _toBuf(data),
      name === "AES-GCM"
        ? _toBuf(algorithm.additionalData ?? new Uint8Array())
        : new Uint8Array(),
      tagLength / 8,
    );
    if (!out) {
      // workerd's text for a ciphertext that fails to authenticate
      // (aes.c++ `decryptFinalHelper`): the lengths are the ciphertext's
      // without its tag, which is what the plaintext would have been.
      if (!encrypting && name === "AES-GCM") {
        const length = Math.max(_toBuf(data).byteLength - tagLength / 8, 0);
        throw _operationError(
          "Decryption failed. This could be due to a ciphertext authentication " +
          "failure, bad padding, incorrect CryptoKey, or another algorithm-specific " +
          `reason. Input length was ${length}, output length expected to be ` +
          `${length} for AES-GCM`);
      }
      throw _operationError(
        name + (encrypting ? " encrypt failed" : " decrypt failed"),
      );
    }
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  }

  // The operations behind SubtleCrypto's methods. A method checks its
  // receiver, then hands its arguments here, and the operations that
  // compose others (deriveKey, wrapKey, unwrapKey) call them here too,
  // never through `this` or a property a script can replace: either
  // would hand a non-extractable result's bytes to the script's own
  // importKey, or a key's to its own encrypt.
  const _ops = {
    __proto__: null,

    async digest(algorithm, data) {
      if (arguments.length < 1)
        throw __celld.__jsg.execute("digest", "SubtleCrypto", 1, "string or HashAlgorithm");
      const bytes = _bufferParam(data, "digest", "SubtleCrypto", 2);
      const name = _algorithmName(algorithm);
      if (!_DIGEST_ALGS.has(name)) {
        throw _notSupported("Unrecognized or unimplemented digest algorithm requested.");
      }
      const out = _digest(name, bytes);
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    },

    async importKey(format, keyData, algorithm, extractable, usages) {
      const name = _algorithmName(algorithm);
      // workerd checks the format, then the algorithm (crypto.c++
      // `importKeySync`), then that a buffer format has a buffer.
      if (!_KEY_FORMATS.has(format)) {
        throw _notSupported(`Unrecognized key import format "${format}".`);
      }
      if (!_WORKERD_ALGS.has(name)) {
        throw _notSupported(
          `Unrecognized key import algorithm "${_givenAlgorithmName(algorithm)}" requested.`);
      }
      // The data is a BufferSource or a JsonWebKey dictionary, and a buffer
      // format takes only the first.
      const buffer = keyData instanceof ArrayBuffer || ArrayBuffer.isView(keyData);
      if (!buffer && (keyData === null || typeof keyData !== "object" &&
          typeof keyData !== "function")) {
        throw __celld.__jsg.execute(
          "importKey", "SubtleCrypto", 2, "BufferSource or JsonWebKey");
      }
      if (format !== "jwk" && !buffer) {
        throw new TypeError(
          "Import data provided for buffer-based import formats must be a buffer source.");
      }
      if (format === "raw" && (name === "HKDF" || name === "PBKDF2")) {
        // The spec makes KDF secrets non-extractable, so the password
        // material cannot come back out through exportKey.
        if (extractable) {
          throw new DOMException(
            name + " keys must not be extractable", "SyntaxError");
        }
        return _makeKey(
          "secret", { name }, false, usages,
          { bytes: _toBuf(keyData).slice() },
        );
      }
      if (format === "raw" && _SECRET_KEY_ALGS.has(name)) {
        const raw = _toBuf(keyData).slice();
        if (name === "HMAC") {
          // An HMAC key names its hash; workerd has no default.
          if (algorithm?.hash === undefined)
            throw new TypeError('Missing field "hash" in "algorithm".');
          const hash = _hashName(algorithm.hash);
          const length = _hmacImportLength(algorithm?.length, raw);
          return _makeKey(
            "secret", { name, hash: { name: hash }, length }, extractable, usages,
            { bytes: raw },
          );
        }
        return _makeKey(
          "secret", { name, length: raw.byteLength * 8 }, extractable, usages,
          { bytes: raw },
        );
      }
      // A Secure Curves public key has a `raw` form: the 32-byte point on
      // its own. It is checked before the asymmetric block below, because
      // that block reads `raw` bytes as a DER document and can only report a
      // parse failure for them.
      if (format === "raw" && _OKP_CURVES[name] !== undefined) {
        const imported = _extra("asym-key-import", {
          key: Array.from(_toBuf(keyData)),
          format: "raw",
          type: _OKP_CURVES[name],
          visibility: "public",
          passphrase: null,
        });
        return _makeKey(
          "public",
          _keyAlgorithm(name, algorithm, imported.keyType, imported.details),
          extractable,
          usages,
          {
            bytes: Uint8Array.from(imported.der),
            keyType: imported.keyType,
            details: imported.details,
          },
        );
      }
      // A JWK's `alg` names the algorithm it was made for. Anything that is
      // not a string is not an algorithm name, and importing it would leave
      // a key claiming to be something it cannot be. Web Crypto ignores a
      // mismatched `alg` on EC keys, so only the type is checked here.
      if (format === "jwk" && keyData?.alg !== undefined &&
          typeof keyData.alg !== "string") {
        throw new DOMException(
          `Unrecognized or unimplemented algorithm "${String(keyData.alg)}"`,
          "NotSupportedError",
        );
      }
      // Asymmetric keys go through the same host import node:crypto uses, so
      // the CryptoKey carries the key type and details beside its bytes.
      // KeyObject.from() then sees a real asymmetric key rather than opaque
      // material, and the key is validated at import instead of at first use.
      if (
        (format === "spki" || format === "pkcs8" ||
          format === "jwk") &&
        _ASYM_ALGS.has(name)
      ) {
        const jwk = format === "jwk";
        const visibility =
          format === "pkcs8" || (jwk && keyData?.d !== undefined)
            ? "private"
            : "public";
        let imported;
        try {
          imported = _extra("asym-key-import", {
            key: jwk ? keyData : Array.from(_toBuf(keyData)),
            format: jwk ? "jwk" : "der",
            type: jwk ? null : format,
            visibility,
            passphrase: null,
          });
        } catch (error) {
          // A DER document that does not parse is workerd's DataError
          // (keys.c++); node:crypto's wording stays for node:crypto.
          if (!jwk && /Failed to parse private key$/.test(String(error?.message))) {
            throw new DOMException(
              `Invalid ${format === "pkcs8" ? "PKCS8" : "SPKI"} input.`, "DataError");
          }
          throw error;
        }
        return _makeKey(
          visibility,
          _keyAlgorithm(name, algorithm, imported.keyType, imported.details),
          extractable,
          usages,
          {
            bytes: Uint8Array.from(imported.der),
            keyType: imported.keyType,
            details: imported.details,
          },
        );
      }
      throw _notSupported("unsupported key import");
    },

    async exportKey(format, key) {
      const state = _keyParam(key, "exportKey", 2);
      // Before the format, as workerd checks (crypto.c++ `exportKey`).
      if (!state.extractable) throw _notExtractable(state);
      const material = state.material;
      // The `raw` form of a Secure Curves public key is its 32-byte point.
      // The branch below answers every `raw` request from the stored bytes,
      // which for an asymmetric key are its SPKI document -- so without this
      // arm an X25519 peer key exports as 44 bytes that no counterpart can
      // read, and nothing reports an error.
      if (format === "raw" && state.type === "public" &&
          (material.keyType === "ed25519" || material.keyType === "x25519")) {
        return Uint8Array.from(_extra("asym-key-raw-public", {
          der: Array.from(material.bytes),
        }).bytes).buffer;
      }
      if (format === "raw" && material.bytes) {
        const raw = material.bytes;
        return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      }
      // Asymmetric keys export from their normalized DER: spki and pkcs8 as
      // they are stored, jwk through the host.
      if (material.keyType !== undefined) {
        const visibility = state.type;
        if (format === "jwk") {
          return _jwkStruct(_extra("asym-key-export", {
            der: Array.from(material.bytes),
            visibility,
          }).jwk);
        }
        if ((format === "spki" && visibility === "public") ||
            (format === "pkcs8" && visibility === "private")) {
          const der = material.bytes;
          return der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength);
        }
      }
      throw _notSupported("unsupported key export");
    },

    // Cloudflare's extension, not Web Crypto: a constant-time compare for
    // signatures and MACs, where `===` on a decoded string leaks by timing.
    // Equal lengths are required, so this cannot be used to probe length.
    timingSafeEqual(a, b) {
      const left = _bufferParam(a, "timingSafeEqual", "SubtleCrypto", 1);
      const right = _bufferParam(b, "timingSafeEqual", "SubtleCrypto", 2);
      if (left.byteLength !== right.byteLength) {
        throw new TypeError(
          "Input buffers must have the same byte length.");
      }
      return $$timingSafeEqual(left, right);
    },

    // ECDH. `length` may be null or undefined, a recent spec change: the
    // shared secret is the curve's field size, so there is a right answer
    // without being told one. A shorter length truncates, as the spec says.
    // HKDF and PBKDF2 have no natural output size, so for them a missing
    // or unaligned length is the OperationError the spec names.
    async deriveBits(algorithm, baseKey, length) {
      const baseState = _keyParam(baseKey, "deriveBits", 2);
      const name = _algorithmName(algorithm);
      if (name === "HKDF" || name === "PBKDF2") {
        const bits = Number(length);
        if (!Number.isInteger(bits) || bits <= 0 || bits % 8 !== 0) {
          throw _operationError(
            name + " length must be a positive multiple of 8 bits");
        }
        const hash = _hashName(algorithm?.hash);
        if (!_DIGEST_ALGS.has(hash)) {
          throw _notSupported("unsupported " + name + " hash: " + hash);
        }
        const ikm = baseState.material.bytes;
        const salt = _toBuf(algorithm?.salt ?? new Uint8Array());
        let out;
        if (name === "HKDF") {
          out = $$hkdf(
            hash, ikm, salt,
            _toBuf(algorithm?.info ?? new Uint8Array()), bits / 8);
          if (!out) {
            throw _operationError("HKDF length is too large for the hash");
          }
        } else {
          const iterations = Number(algorithm?.iterations);
          if (!Number.isInteger(iterations) || iterations <= 0) {
            throw _operationError(
              "PBKDF2 iterations must be a positive integer");
          }
          // Cloudflare's cap (workerd's default limit enforcer): one call
          // runs in the host, where no CPU limit can stop it.
          if (iterations > MAX_PBKDF2_ITERATIONS) {
            throw _notSupported(pbkdf2LimitMessage(iterations));
          }
          out = $$pbkdf2(hash, ikm, salt, iterations, bits / 8);
        }
        return out.buffer.slice(
          out.byteOffset, out.byteOffset + out.byteLength);
      }
      if (name !== "ECDH" && name !== "X25519") {
        throw _notSupported("unsupported derive algorithm: " + name);
      }
      const publicState = _keyState(algorithm?.public);
      if (publicState?.type !== "public") {
        throw new TypeError(name + " requires a public key in algorithm.public");
      }
      // X25519 carries no `namedCurve`, so it cannot ride the curve match
      // `ecdh-derive` runs; its op is separate for that reason alone. Both
      // answer the raw shared secret, so everything below is shared.
      const shared = Uint8Array.from(_extra(
        name === "X25519" ? "x25519-derive" : "ecdh-derive", {
          private: Array.from(_toBuf(baseState.material.bytes)),
          public: Array.from(_toBuf(publicState.material.bytes)),
        }).bytes);
      if (length === null || length === undefined) return shared.buffer;
      const bytes = Number(length) / 8;
      if (!Number.isInteger(bytes) || bytes < 0 || bytes > shared.byteLength) {
        throw _operationError("requested length exceeds the derived secret");
      }
      return shared.slice(0, bytes).buffer;
    },

    async deriveKey(algorithm, baseKey, derived, extractable, usages) {
      _keyParam(baseKey, "deriveKey", 2);
      const name = _algorithmName(derived);
      // An HMAC key with no stated length defaults to its hash's block
      // size, which is what the spec's getKeyLength returns.
      const length = derived?.length ??
        (name === "AES-GCM" || name === "AES-CBC" || name === "AES-CTR"
          ? 256
          : name === "HMAC"
            ? ({ "SHA-384": 1024, "SHA-512": 1024 }[
              _hashName(derived?.hash)] ?? 512)
            : null);
      const bits = await _ops.deriveBits(algorithm, baseKey, length);
      return _ops.importKey(
        "raw", bits, derived, extractable, usages);
    },

    async generateKey(algorithm, extractable, usages) {
      const name = _algorithmName(algorithm);
      if (_SECRET_KEY_ALGS.has(name)) {
        let byteLength;
        if (name === "HMAC") {
          const defaults = {
            "SHA-1": 20,
            "SHA-256": 32,
            "SHA-384": 48,
            "SHA-512": 64,
          };
          if (algorithm?.hash === undefined)
            throw new TypeError('Missing field "hash" in "algorithm".');
          const hash = _hashName(algorithm.hash);
          byteLength = algorithm?.length
            ? Number(algorithm.length) / 8
            : defaults[hash];
          if (!byteLength) throw _notSupported("unsupported HMAC hash: " + hash);
          const raw = new Uint8Array(byteLength);
          _randomValues(raw);
          return _makeKey(
            "secret",
            { name, hash: { name: hash }, length: raw.byteLength * 8 },
            extractable,
            usages,
            { bytes: raw },
          );
        }
        byteLength = Number(algorithm?.length || 256) / 8;
        if (byteLength !== 16 && byteLength !== 32) {
          throw new DOMException("AES-GCM length must be 128 or 256", "OperationError");
        }
        const raw = new Uint8Array(byteLength);
        _randomValues(raw);
        return _makeKey(
          "secret",
          { name, length: raw.byteLength * 8 },
          extractable,
          usages,
          { bytes: raw },
        );
      }
      // Asymmetric signing keys. `NODE-ED25519` is Cloudflare's pre-standard
      // spelling of Ed25519 and stays as the reported algorithm name, because
      // the caller matched on what it asked for.
      const ASYM_GENERATE = {
        "RSASSA-PKCS1-V1_5": "rsa",
        "RSA-OAEP": "rsa",
        "RSA-PSS": "rsa",
        "ED25519": "ed25519",
        "NODE-ED25519": "ed25519",
        "X25519": "x25519",
        "ECDSA": "ec",
        "ECDH": "ec",
      };
      const kind = ASYM_GENERATE[name];
      if (kind !== undefined) {
        const options = { type: kind };
        let exponentBytes;
        if (kind === "rsa") {
          const params = _rsaGenerateParams(name, algorithm, [...(usages || [])]);
          options.modulusLength = params.modulusLength;
          options.publicExponent = params.publicExponent;
          exponentBytes = params.exponentBytes;
          const hash = _hashName(algorithm?.hash);
          if (name === "RSA-OAEP" && !_RSA_OAEP_HASHES.has(hash)) {
            throw _notSupported("unsupported RSA-OAEP hash: " + hash);
          }
        }
        if (kind === "ec") {
          const curve = _canonicalEcCurve(algorithm?.namedCurve);
          if (curve === undefined)
            throw _notSupported(
              `Unrecognized or unimplemented EC curve "${algorithm?.namedCurve}" requested.`);
          options.namedCurve = curve;
        }
        const pair = _extra("asym-key-generate", options);
        // A dictionary per half, not one shared between them. The reported
        // hash is what sign() then hashes with, so a caller that mutates
        // `publicKey.algorithm.hash.name` on a shared object would change
        // what the private key signs.
        const half = (der, type, allowed) => {
          const reported = _keyAlgorithm(name, algorithm, pair.keyType, pair.details);
          // The exponent as the caller gave it, leading zeros and all, as
          // workerd reports it.
          if (exponentBytes !== undefined) reported.publicExponent = exponentBytes.slice();
          return _makeKey(type, reported,
            type === "public" ? true : extractable,
            (usages || []).filter((usage) => allowed.includes(usage)), {
              bytes: Uint8Array.from(der),
              keyType: pair.keyType,
              details: pair.details,
            });
        };
        return {
          publicKey: half(pair.publicDer, "public", _PUBLIC_KEY_USAGES),
          privateKey: half(pair.privateDer, "private", _PRIVATE_KEY_USAGES),
        };
      }
      if (!_WORKERD_GENERATE_ALGS.has(name)) {
        throw _notSupported(
          `Unrecognized key generation algorithm "${_givenAlgorithmName(algorithm)}" requested.`);
      }
      throw _notSupported("unsupported key algorithm: " + name);
    },

    async sign(algorithm, key, data) {
      const state = _keyParam(key, "sign", 2);
      const name = _algorithmName(algorithm || state.algorithm);
      const bytes = _toBuf(data);
      if (name === "HMAC") {
        const hash = _hashName(state.algorithm?.hash);
        const sig = _hmacSign(hash, state.material.bytes, bytes);
        if (!sig) throw _operationError("HMAC sign failed");
        return sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength);
      }
      const operation = _ED25519_ALGS.has(name)
        ? "ed25519-sign"
        : name === "ECDSA"
          ? "p256-sign"
          : name === "RSASSA-PKCS1-V1_5"
            ? "rsa-pkcs1-sign"
            : name === "RSA-PSS"
              ? "rsa-pss-sign"
              : null;
      if (!operation) throw _notSupported("unsupported sign algorithm: " + name);
      if (name === "ECDSA") {
        if (_canonicalEcCurve(state.algorithm?.namedCurve) !== "P-256") {
          throw _notSupported("ECDSA signatures support only P-256");
        }
        if (_hashName(algorithm?.hash) !== "SHA-256") {
          throw _notSupported("ECDSA P-256 supports only SHA-256");
        }
      }
      const result = _extra(operation, {
        key: Array.from(state.material.bytes || []),
        data: Array.from(bytes),
        // RSA carries its hash on the key; the others ignore the field.
        hash: _hashName(state.algorithm?.hash),
        saltLength: name === "RSA-PSS" ? _rsaPssSaltLength(algorithm, true) : undefined,
      });
      if (result.saltTooLong) {
        throw _operationError("key too small for signing with given digest and salt length");
      }
      return Uint8Array.from(result.bytes).buffer;
    },

    async verify(algorithm, key, signature, data) {
      const state = _keyParam(key, "verify", 2);
      const name = _algorithmName(algorithm || state.algorithm);
      if (name === "HMAC") {
        return _hmacVerify(
          _hashName(state.algorithm?.hash),
          state.material.bytes,
          _toBuf(signature),
          _toBuf(data),
        );
      }
      // Ed25519 signs through `ed25519-sign` above, so a key pair that can
      // be generated and signed with had no way to check its own signature
      // until this arm existed (denoland/celld#221). The host op is the one
      // node:crypto's `verify()` already calls.
      const operation = _ED25519_ALGS.has(name)
        ? "ed25519-verify"
        : name === "ECDSA"
        ? "p256-verify"
        : name === "RSASSA-PKCS1-V1_5"
        ? "rsa-pkcs1-verify"
        : name === "RSA-PSS"
        ? "rsa-pss-verify"
        : null;
      if (!operation) {
        throw _notSupported("unsupported verify algorithm: " + name);
      }
      const material = state.material.bytes;
      if (!material) throw _notSupported("verify needs an spki public key");
      if (name === "ECDSA") {
        if (_canonicalEcCurve(state.algorithm?.namedCurve) !== "P-256") {
          throw _notSupported("ECDSA signatures support only P-256");
        }
        if (_hashName(algorithm?.hash) !== "SHA-256") {
          throw _notSupported("ECDSA P-256 supports only SHA-256");
        }
      }
      return _extra(operation, {
        key: Array.from(material),
        data: Array.from(_toBuf(data)),
        signature: Array.from(_toBuf(signature)),
        // ECDSA carries its hash on the call, RSASSA on the key.
        hash: _hashName(
          name === "ECDSA" ? algorithm?.hash : state.algorithm?.hash,
        ),
        // RSA-PSS verifies with the salt length it signed with; the others
        // have none.
        saltLength: name === "RSA-PSS" ? _rsaPssSaltLength(algorithm, false) : undefined,
      }).ok;
    },

    async encrypt(algorithm, key, data) {
      const state = _keyParam(key, "encrypt", 2);
      const name = _algorithmName(algorithm);
      if (_AES_MODES.has(name)) {
        return _aes(name, algorithm, state, data, true);
      }
      if (name === "RSA-OAEP") {
        const hash = _hashName(state.algorithm?.hash);
        if (!_RSA_OAEP_HASHES.has(hash)) {
          throw _notSupported("unsupported RSA-OAEP hash: " + hash);
        }
        const result = _extra("rsa-oaep-encrypt", {
          key: Array.from(state.material.bytes || []),
          data: Array.from(_toBuf(data)),
          hash,
          label: _rsaOaepLabel(algorithm),
        });
        return Uint8Array.from(result.bytes).buffer;
      }
      throw _notSupported("unsupported encrypt algorithm: " + name);
    },

    // wrapKey and unwrapKey compose the primitives exactly the way the
    // spec defines them: export + encrypt, and decrypt + import. A
    // jwk-format key crosses as its JSON bytes.
    async wrapKey(format, key, wrappingKey, wrapAlgorithm) {
      _keyParam(key, "wrapKey", 2);
      _keyParam(wrappingKey, "wrapKey", 3);
      const exported = await _ops.exportKey(format, key);
      const raw = format === "jwk"
        ? new TextEncoder().encode(JSON.stringify(exported))
        : exported;
      return _ops.encrypt(wrapAlgorithm, wrappingKey, raw);
    },

    async unwrapKey(
      format, wrapped, unwrappingKey, unwrapAlgorithm,
      algorithm, extractable, usages,
    ) {
      _keyParam(unwrappingKey, "unwrapKey", 3);
      const raw = await _ops.decrypt(unwrapAlgorithm, unwrappingKey, wrapped);
      const keyData = format === "jwk"
        ? JSON.parse(new TextDecoder().decode(raw))
        : raw;
      return _ops.importKey(format, keyData, algorithm, extractable, usages);
    },

    async decrypt(algorithm, key, data) {
      const state = _keyParam(key, "decrypt", 2);
      const name = _algorithmName(algorithm);
      if (_AES_MODES.has(name)) {
        return _aes(name, algorithm, state, data, false);
      }
      if (name === "RSA-OAEP") {
        const hash = _hashName(state.algorithm?.hash);
        if (!_RSA_OAEP_HASHES.has(hash)) {
          throw _notSupported("unsupported RSA-OAEP hash: " + hash);
        }
        const result = _extra("rsa-oaep-decrypt", {
          key: Array.from(state.material.bytes || []),
          data: Array.from(_toBuf(data)),
          hash,
          label: _rsaOaepLabel(algorithm),
        });
        return Uint8Array.from(result.bytes).buffer;
      }
      throw _notSupported("unsupported decrypt algorithm: " + name);
    },
  };
  Object.freeze(_ops);
  const _apply = Reflect.apply;
  // A method of the one SubtleCrypto, `crypto.subtle`: any other receiver
  // is refused before anything runs, synchronously, as JSG refuses one.
  const _subtleCall = (receiver, op, args) => {
    if (receiver !== subtle) throw __celld.__illegalInvocation();
    return _apply(op, undefined, args);
  };

  // The one SubtleCrypto is `crypto.subtle`; a script cannot make another.
  class SubtleCrypto {
    constructor(...args) {
      if (args[0] !== kMakeKey) throw new TypeError("Illegal constructor");
    }
    digest(algorithm, data) {
      return _subtleCall(this, _ops.digest, arguments);
    }
    importKey(format, keyData, algorithm, extractable, usages) {
      return _subtleCall(this, _ops.importKey, arguments);
    }
    exportKey(format, key) {
      return _subtleCall(this, _ops.exportKey, arguments);
    }
    timingSafeEqual(a, b) {
      return _subtleCall(this, _ops.timingSafeEqual, arguments);
    }
    deriveBits(algorithm, baseKey, length) {
      return _subtleCall(this, _ops.deriveBits, arguments);
    }
    deriveKey(algorithm, baseKey, derived, extractable, usages) {
      return _subtleCall(this, _ops.deriveKey, arguments);
    }
    generateKey(algorithm, extractable, usages) {
      return _subtleCall(this, _ops.generateKey, arguments);
    }
    sign(algorithm, key, data) {
      return _subtleCall(this, _ops.sign, arguments);
    }
    verify(algorithm, key, signature, data) {
      return _subtleCall(this, _ops.verify, arguments);
    }
    encrypt(algorithm, key, data) {
      return _subtleCall(this, _ops.encrypt, arguments);
    }
    wrapKey(format, key, wrappingKey, wrapAlgorithm) {
      return _subtleCall(this, _ops.wrapKey, arguments);
    }
    unwrapKey(format, wrapped, unwrappingKey, unwrapAlgorithm, algorithm,
      extractable, usages) {
      return _subtleCall(this, _ops.unwrapKey, arguments);
    }
    decrypt(algorithm, key, data) {
      return _subtleCall(this, _ops.decrypt, arguments);
    }
  }

  // A version 4 UUID from 16 bytes `fill` draws.
  const _uuid = (fill) => {
    const bytes = new Uint8Array(16);
    fill(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const h = (index) => bytes[index].toString(16).padStart(2, "0");
    return h(0) + h(1) + h(2) + h(3) + "-" +
      h(4) + h(5) + "-" + h(6) + h(7) + "-" +
      h(8) + h(9) + "-" + h(10) + h(11) +
      h(12) + h(13) + h(14) + h(15);
  };

  const subtle = new SubtleCrypto(kMakeKey);
  // workerd's `crypto` is an instance of its Crypto class: its methods,
  // `subtle` and DigestStream are its prototype's, which has the tag. celld
  // has no Crypto global (plan 1.63), so the class is reachable only as the
  // prototype's constructor, which refuses to construct.
  const Crypto = function Crypto() {
    throw new TypeError("Illegal constructor");
  };
  const cryptoPrototype = Crypto.prototype;
  Object.assign(cryptoPrototype, {
    getRandomValues(array) {
      // Web IDL brand check, observable via node:crypto's webcrypto alias.
      if (this !== crypto) throw __celld.__illegalInvocation();
      // A view, as workerd's parameter is, and then an integer-typed one.
      if (!ArrayBuffer.isView(array)) {
        throw __celld.__jsg.execute("getRandomValues", "Crypto", 1, "ArrayBufferView");
      }
      if (
        !(array instanceof Int8Array) &&
        !(array instanceof Uint8Array) &&
        !(array instanceof Uint8ClampedArray) &&
        !(array instanceof Int16Array) &&
        !(array instanceof Uint16Array) &&
        !(array instanceof Int32Array) &&
        !(array instanceof Uint32Array) &&
        !(array instanceof BigInt64Array) &&
        !(array instanceof BigUint64Array)
      ) {
        throw new DOMException(
          "ArrayBufferView argument to getRandomValues() must be an integer-typed view.",
          "TypeMismatchError",
        );
      }
      if (array.byteLength > 65536) {
        throw new DOMException(
          "getRandomValues() only accepts buffers of size <= 64K but provided " +
            `${array.byteLength} bytes.`,
          "QuotaExceededError",
        );
      }
      _randomValues(array);
      return array;
    },

    randomUUID() {
      if (this !== crypto) throw __celld.__illegalInvocation();
      return _uuid(_randomValues);
    },
  });
  Object.defineProperty(cryptoPrototype, "subtle", {
    __proto__: null,
    get: [function () {
      if (this !== crypto) throw __celld.__illegalInvocation();
      return subtle;
    }][0],
    enumerable: true,
    configurable: true,
  });
  const crypto = Object.create(cryptoPrototype);
  __celld.__apiTag(cryptoPrototype, "Crypto");
  // Without workers_api_getters_setters_on_prototype `subtle` is the
  // object's own (harness.js `__applyCompat`).
  __celld.__registerAttributes("Crypto", [[cryptoPrototype, "subtle"]]);
  __celld.__crypto = crypto;

  // Cloudflare's DigestStream: a WritableStream that hashes what is written
  // to it and resolves `digest` when the stream closes. Not Web Crypto, and
  // the reason a Worker can hash a body it never has to hold whole -- though
  // celld buffers here, as its Hash already does.
  class DigestStream extends WritableStream {
    #digest;
    #state;
    constructor(algorithm) {
      if (arguments.length < 1)
        throw __celld.__jsg.construct("DigestStream", 1, "string or HashAlgorithm");
      const name = _algorithmName(algorithm);
      // DigestStream takes the CRC checksums too; `subtle.digest` does not.
      if (!_DIGEST_ALGS.has(name) && !_CRC_ALGS.has(name)) {
        throw _notSupported("Unrecognized or unimplemented digest algorithm requested.");
      }
      const state = { chunks: [], written: 0, resolve: null, reject: null };
      const digest = new Promise((resolve, reject) => {
        state.resolve = resolve;
        state.reject = reject;
      });
      // Its own attribute comes first, then WritableStream's
      // (`__celld.__deferWritableAttributes`).
      __celld.__deferWritableAttributes = true;
      super({ __proto__: null,
        write(chunk) {
          // A string is written as its UTF-8 bytes, as workerd does; every
          // other chunk must already be binary.
          if (typeof chunk !== "string" && !ArrayBuffer.isView(chunk) &&
              !(chunk instanceof ArrayBuffer)) {
            throw new TypeError(
              "DigestStream is a byte stream but received an object of " +
              "non-ArrayBuffer/ArrayBufferView/string type on its " +
              "writable side.");
          }
          const bytes = typeof chunk === "string"
            ? new TextEncoder().encode(chunk)
            : _toBuf(chunk);
          state.chunks.push(bytes);
          state.written += bytes.byteLength;
        },
        close() {
          const joined = new Uint8Array(state.written);
          let offset = 0;
          for (const chunk of state.chunks) {
            joined.set(chunk, offset);
            offset += chunk.byteLength;
          }
          state.chunks.length = 0;
          const out = _digest(name, joined);
          state.resolve(
            out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
        },
        abort(reason) {
          state.chunks.length = 0;
          state.reject(reason);
        },
      });
      // A stream that is written to and never closed is legal, and so is one
      // that is disposed. Neither should raise an unhandled rejection just
      // because nobody awaited `digest`.
      digest.catch(() => {});
      this.#digest = digest;
      this.#state = state;
      if (__celld.__oldAttributes) __celld.__installAttributes(this, "DigestStream");
    }
    get digest() {
      if (!(#state in this)) throw __celld.__illegalInvocation();
      return this.#digest;
    }
    get bytesWritten() {
      if (!(#state in this)) throw __celld.__illegalInvocation();
      return BigInt(this.#state.written);
    }
    [Symbol.dispose]() {
      if (!(#state in this)) throw __celld.__illegalInvocation();
      const state = this.#state;
      if (state.disposed) return; // disposing twice is a no-op
      state.disposed = true;
      state.chunks.length = 0;
      const error = new Error("The DigestStream was disposed.");
      state.reject(error);
      // Error the stream itself, so a later write() rejects with the same
      // reason rather than succeeding into a digest nobody will resolve.
      this.abort(error).catch(() => {});
    }
  }

  __celld.__apiTag(DigestStream.prototype, "DigestStream");
  // `digest` as workerd defines it by the flag, `bytesWritten` on the
  // prototype whatever it says; both getters nameless and enumerable.
  __celld.__registerAttributes("DigestStream", [
    [DigestStream.prototype, "digest"], [WritableStream.prototype, "locked"],
  ]);
  {
    const { get } = Object.getOwnPropertyDescriptor(DigestStream.prototype, "bytesWritten");
    Object.defineProperty(get, "name", { __proto__: null, value: "" });
    Object.defineProperty(DigestStream.prototype, "bytesWritten",
      { __proto__: null, enumerable: true });
  }
  __celld.__apiTag(CryptoKey.prototype, "CryptoKey");
  __celld.__apiTag(SubtleCrypto.prototype, "SubtleCrypto");
  cryptoPrototype.DigestStream = DigestStream;
  globalThis.DigestStream = DigestStream;
  globalThis.CryptoKey = CryptoKey;
  globalThis.SubtleCrypto = SubtleCrypto;
  globalThis.crypto = crypto;
  // The harness's own ids use this, whatever a script does to `crypto`, and
  // wherever it runs.
  __celld.__randomUUID = () => _uuid(_celldRandomValues);
  // `node_crypto.js` hands a parsed key to Web Crypto through
  // `KeyObject.toCryptoKey()`, so it reports the same dictionary. It built
  // a second one by hand, which drifted: it named every EC curve P-256 and
  // left the exponent off an RSA key. The loop below hides this name, and
  // the module is lazy, so it always resolves after this script runs.
  __celld.$$keyAlgorithm = _keyAlgorithm;
  __celld.$$canonicalEcCurve = _canonicalEcCurve;
})();
