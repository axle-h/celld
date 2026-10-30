// The Workers Cache API with always-miss semantics.
//
// celld has no shared edge cache, and Cloudflare's Cache API is a view of
// exactly that cache. Refusing the API would break the large class of
// Workers that treat `caches.default` as a best-effort layer over their
// own origin logic, so celld accepts the surface, validates it with
// Workerd's rules and messages, and misses every match -- the same
// posture as `passThroughOnException()`, which is a documented no-op
// because there is no CDN behind it. A per-node in-memory cache can
// replace the miss without changing any observable contract.
(function () {
  const kCreate = Symbol("celld.Cache.create");
  let isCache;

  // A key is a Request or URL string. A string becomes a Request first,
  // which refuses one that is not a URL as the Request constructor does,
  // and the URL must then name a host, whatever its scheme -- the rule
  // (kj::Url's HTTP_PROXY_REQUEST form) and message of Workerd's
  // validateUrl.
  const asKey = (request) => {
    const url = request instanceof Request ? request.url : String(request);
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      throw new TypeError(`Invalid URL: ${url}`);
    }
    if (parsed.host === "") {
      throw new TypeError(
        "Invalid URL. Cache API keys must be fully-qualified, valid URLs.");
    }
    return __celld.__isRequest(request) ? request : new __celld.__Request(url);
  };

  // celld validates the key's URL before the method, status and Vary checks;
  // workerd checks those first and the URL last (plan 1.65).
  const putChecked = async (request, response) => {
    __require_io_context();
    const key = asKey(request);
    if (key.method !== "GET") {
      throw new TypeError("Cannot cache response to non-GET request.");
    }
    if (response.status === 206) {
      throw new TypeError(
        "Cannot cache response to a range request (206 Partial Content).");
    }
    const vary = response.headers.get("vary");
    if (vary !== null && vary.includes("*")) {
      throw new TypeError("Cannot cache response with 'Vary: *' header.");
    }
    if (response.bodyUsed) {
      throw new TypeError(
        "Body has already been used. It can only be used once. Use tee() " +
        "first if you need to read it twice.");
    }
    // Consume the body even though nothing is stored: put()'s contract
    // is that the response is disturbed when it returns, and a
    // streaming producer must see its stream pulled to completion
    // instead of hanging on a reader that never comes.
    if (response.body) await response.arrayBuffer();
  };

  const matchChecked = async (request, options) => {
    __require_io_context();
    const key = asKey(request);
    // A non-GET key cannot match without ignoreMethod; celld misses
    // either way, and the option is accepted for compatibility.
    void key;
    void options;
    return undefined;
  };

  const deleteChecked = async (request, options) => {
    __require_io_context();
    asKey(request);
    void options;
    return false;
  };

  // CacheQueryOptions (cache.h), as JSG converts the dictionary: undefined
  // or null is empty and any other primitive is refused, then each field is
  // read in the order of its JSG_STRUCT. `ignoreMethod` is a boolean, which
  // celld's every-miss cache has no use for; workerd will not implement the
  // other three, and refuses any of them given a value, null included, as
  // JSG refuses a WontImplement field (jsg/util.c++).
  const WONT_IMPLEMENT = ["ignoreSearch", "ignoreVary", "cacheName"];
  const queryOptions = (options, method) => {
    if (!__celld.__jsg.isDictionary(options))
      throw __celld.__jsg.execute(method, "Cache", 2, "CacheQueryOptions");
    if (options === undefined || options === null) return;
    void options.ignoreMethod;
    for (let i = 0; i < WONT_IMPLEMENT.length; i++) {
      const field = WONT_IMPLEMENT[i];
      if (options[field] !== undefined)
        throw __celld.__jsg.error(
          `The '${field}' field on 'CacheQueryOptions' is not implemented.`);
    }
  };

  class Cache {
    #brand;
    static {
      isCache = (value) =>
        (typeof value === "object" || typeof value === "function") &&
        value !== null && #brand in value;
    }

    constructor(token = undefined) {
      if (token !== kCreate) throw new TypeError("Illegal constructor");
    }

    // workerd checks the receiver first and throws. A response that does
    // not convert, or an error response, rejects before put() asks for the
    // current request, whose global-scope error rejects too; match() and
    // delete() ask for it before they read the key (api/cache.c++).
    put(request, response) {
      if (!isCache(this)) throw __celld.__illegalInvocation();
      if (!__celld.__isResponse(response)) {
        return Promise.reject(new TypeError(
          "Failed to execute 'put' on 'Cache': parameter 2 is not of type 'Response'."));
      }
      if (__celld.__responseType(response) === "error") {
        return Promise.reject(new TypeError(
          "Cache is unable to store an error response"));
      }
      return putChecked(request, response);
    }

    match(request, options = undefined) {
      if (!isCache(this)) throw __celld.__illegalInvocation();
      try {
        queryOptions(options, "match");
      } catch (error) {
        return Promise.reject(error);
      }
      return matchChecked(request, options);
    }

    delete(request, options = undefined) {
      if (!isCache(this)) throw __celld.__illegalInvocation();
      try {
        queryOptions(options, "delete");
      } catch (error) {
        return Promise.reject(error);
      }
      return deleteChecked(request, options);
    }
  }

  class CacheStorage {
    constructor(token = undefined) {
      if (token !== kCreate) throw new TypeError("Illegal constructor");
    }

    async open(cacheName) {
      // A required string (cache.h).
      if (arguments.length < 1)
        throw __celld.__jsg.execute("open", "CacheStorage", 1, "string");
      if (String(cacheName).length >= 1024) {
        throw new TypeError("Cache name is too long.");
      }
      return new Cache(kCreate);
    }
  }

  const storage = new CacheStorage(kCreate);
  Object.defineProperty(storage, "default", {
    __proto__: null,
    value: new Cache(kCreate),
    enumerable: true,
  });

  __celld.__apiTag(Cache.prototype, "Cache");
  __celld.__apiTag(CacheStorage.prototype, "CacheStorage");
  globalThis.Cache = Cache;
  globalThis.CacheStorage = CacheStorage;
  globalThis.caches = storage;
})();
