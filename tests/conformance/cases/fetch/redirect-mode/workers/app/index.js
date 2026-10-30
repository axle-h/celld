// The redirect modes a Request takes. workerd parses `redirect` in the
// Request constructor, ignoring case, and refuses "error" and anything else
// there, so `fetch()` rejects before any request leaves.
function construct(init, input = "http://example.test/") {
  try {
    return { redirect: new Request(input, init).redirect };
  } catch (error) {
    return { error: error.name, message: error.message };
  }
}

async function fetched(init) {
  let pending;
  try {
    // An unreachable port: the request must never get that far.
    pending = fetch("http://127.0.0.1:9/", init);
  } catch (error) {
    return { thrown: error.name, message: error.message };
  }
  try {
    await pending;
    return { resolved: true };
  } catch (error) {
    return { rejected: error.name, message: error.message };
  }
}

// The order in which the constructor reads and converts a dict init's
// fields: workerd reads each field of RequestInitializerDict in its struct
// order and converts it before it reads the next.
function traced() {
  const log = [];
  const value = (name, text) => ({
    toString() {
      log.push(`${name}.toString`);
      return text;
    },
  });
  const target = {
    method: value("method", "POST"),
    headers: { "x-a": value("headers.x-a", "1") },
    body: value("body", "payload"),
    redirect: value("redirect", "manual"),
    cf: {},
    integrity: value("integrity", ""),
    encodeResponseBody: value("encodeResponseBody", "manual"),
  };
  const init = new Proxy(target, {
    get(t, key, receiver) {
      log.push(`get ${String(key)}`);
      return Reflect.get(t, key, receiver);
    },
    has(t, key) {
      log.push(`has ${String(key)}`);
      return Reflect.has(t, key);
    },
    getOwnPropertyDescriptor(t, key) {
      log.push(`getOwnPropertyDescriptor ${String(key)}`);
      return Reflect.getOwnPropertyDescriptor(t, key);
    },
    ownKeys(t) {
      log.push("ownKeys");
      return Reflect.ownKeys(t);
    },
  });
  let result;
  try {
    const request = new Request("http://example.test/", init);
    result = { method: request.method, redirect: request.redirect, header: request.headers.get("x-a") };
  } catch (error) {
    result = { error: `${error.name}: ${error.message}` };
  }
  return { log, result };
}

export default {
  async fetch() {
    return Response.json({
      default: construct({}),
      undefined: construct({ redirect: undefined }),
      follow: construct({ redirect: "follow" }),
      manual: construct({ redirect: "manual" }),
      upperCase: construct({ redirect: "FOLLOW" }),
      mixedCase: construct({ redirect: "Manual" }),
      error: construct({ redirect: "error" }),
      other: construct({ redirect: "bogus" }),
      null: construct({ redirect: null }),
      fromRequest: construct({ redirect: "error" }, new Request("http://example.test/")),
      inherited: construct({}, new Request("http://example.test/", { redirect: "manual" })),
      // A Request as the init: its mode comes with it.
      requestAsInit: construct(new Request("http://other.test/", { redirect: "manual" })),
      traced: traced(),
      fetchError: await fetched({ redirect: "error" }),
      fetchOther: await fetched({ redirect: "bogus" }),
    });
  },
};
