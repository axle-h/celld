// The Response.clone() and Request.clone() checks the fetch/*-clone* cases
// run on a body from each source. Each check gets a fresh Response or
// Request from `make()`, so one check's reads never reach the next.

const attempt = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

const decoder = new TextDecoder();

// Only the headers a case sets: a network response has the server's own.
const SET_HEADERS = new Set(["content-type", "location"]);
const setHeaders = (headers) => [...headers].filter(([name]) => name.startsWith("x-") || SET_HEADERS.has(name));

// A network response's statusText is left out where `withStatusText` is
// false: celld does not have the server's (builtins/body-defaults).
let withStatusText = true;
export const describeResponse = (response) => ({
  status: response.status,
  ...(withStatusText ? { statusText: response.statusText } : {}),
  ok: response.ok,
  redirected: response.redirected,
  url: response.url,
  type: response.type,
  headers: setHeaders(response.headers),
  bodyUsed: response.bodyUsed,
  body: response.body === null ? null : Object.prototype.toString.call(response.body),
  webSocket: response.webSocket === null ? null : typeof response.webSocket,
  cf: response.cf ?? null,
});

// The first chunk of a body, read and released, as text.
const readFirst = async (body) => {
  const reader = body.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return value === undefined ? "" : decoder.decode(value);
};

export const RESPONSE_CHECKS = {
  clone: async (make) => {
    const response = await make();
    const clone = response.clone();
    const out = { original: describeResponse(response), clone: describeResponse(clone) };
    out.texts = [await response.text(), await clone.text()];
    out.after = [response.bodyUsed, clone.bodyUsed];
    return out;
  },
  cloneReadFirst: async (make) => {
    const response = await make();
    const clone = response.clone();
    return [await clone.text(), await response.text()];
  },
  cloneOfClone: async (make) => {
    const response = await make();
    const clone = response.clone();
    const again = clone.clone();
    return { again: describeResponse(again), texts: [await again.text(), await clone.text(), await response.text()] };
  },
  // The chunk boundaries differ between runtimes, so the transcript records
  // only that the clone has what the original had left.
  afterPartialRead: async (make) => {
    const response = await make();
    if (response.body === null) return "no body";
    const whole = await (await make()).text();
    const first = await readFirst(response.body);
    const usedBefore = response.bodyUsed;
    const clone = await attempt(() => response.clone());
    if (typeof clone === "string") return { usedBefore, clone };
    const out = { usedBefore, usedAfter: response.bodyUsed, clone: describeResponse(clone) };
    const rest = await response.text();
    const cloned = await clone.text();
    return { ...out, whole: first + rest === whole, cloneIsRest: cloned === rest };
  },
  afterLock: async (make) => {
    const response = await make();
    if (response.body === null) return "no body";
    response.body.getReader();
    return attempt(() => describeResponse(response.clone()));
  },
  afterText: async (make) => {
    const response = await make();
    await response.text();
    return attempt(async () => {
      const clone = response.clone();
      return { clone: describeResponse(clone), text: await clone.text() };
    });
  },
  afterCancel: async (make) => {
    const response = await make();
    if (response.body === null) return "no body";
    await response.body.cancel();
    return attempt(async () => {
      const clone = response.clone();
      return { clone: describeResponse(clone), text: await clone.text() };
    });
  },
  cancelClone: async (make) => {
    const response = await make();
    const clone = response.clone();
    if (clone.body !== null) await clone.body.cancel();
    return { text: await response.text(), cloneUsed: clone.bodyUsed };
  },
  cancelOriginal: async (make) => {
    const response = await make();
    const clone = response.clone();
    if (response.body !== null) await response.body.cancel();
    return { text: await clone.text(), originalUsed: response.bodyUsed };
  },
  headers: async (make) => {
    const response = await make();
    const clone = response.clone();
    const set = await attempt(() => {
      clone.headers.set("x-clone", "1");
      return "set";
    });
    return { set, original: response.headers.get("x-clone"), clone: clone.headers.get("x-clone") };
  },
  arrayBuffer: async (make) => {
    const response = await make();
    const clone = response.clone();
    const [a, b] = await Promise.all([response.arrayBuffer(), clone.arrayBuffer()]);
    return [a.byteLength, b.byteLength];
  },
  cachePut: async (make, key) => {
    const response = await make();
    if (response.status !== 200) return "not cacheable";
    await caches.default.put(`https://cache.test/${key}`, response.clone());
    return response.text();
  },
};

// `skip` names checks a runtime can't run, such as `cachePut` where workerd
// runs without a cache.
export const runResponseChecks = async (sources, { statusText = true, skip = [] } = {}) => {
  withStatusText = statusText;
  const out = {};
  for (const [source, make] of Object.entries(sources)) {
    const row = {};
    for (const [check, run] of Object.entries(RESPONSE_CHECKS))
      if (!skip.includes(check)) row[check] = await attempt(() => run(make, `${source}/${check}`));
    out[source] = row;
  }
  return out;
};

// A large body cloned and read one branch at a time, so the branch read
// second is buffered whole while the first is read: workerd buffers it
// without a limit. Each row records the byte lengths read.
export const BACKPRESSURE_CHECKS = {
  originalFirst: async (make) => {
    const response = await make();
    const clone = response.clone();
    const a = (await response.arrayBuffer()).byteLength;
    return [a, (await clone.arrayBuffer()).byteLength];
  },
  cloneFirst: async (make) => {
    const response = await make();
    const clone = response.clone();
    const a = (await clone.arrayBuffer()).byteLength;
    return [a, (await response.arrayBuffer()).byteLength];
  },
  cloneNeverRead: async (make) => {
    const response = await make();
    response.clone();
    return (await response.arrayBuffer()).byteLength;
  },
  together: async (make) => {
    const response = await make();
    const clone = response.clone();
    const [a, b] = await Promise.all([response.arrayBuffer(), clone.arrayBuffer()]);
    return [a.byteLength, b.byteLength];
  },
  readerOnOriginal: async (make) => {
    const response = await make();
    const clone = response.clone();
    const reader = response.body.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
    }
    return [total, (await clone.arrayBuffer()).byteLength];
  },
};

export const runBackpressureChecks = async (sources) => {
  const out = {};
  for (const [source, make] of Object.entries(sources)) {
    const row = {};
    for (const [check, run] of Object.entries(BACKPRESSURE_CHECKS)) row[check] = await attempt(() => run(make));
    out[source] = row;
  }
  return out;
};

// The runtimes add different headers to an incoming request, so only the
// ones a case sets are kept. `cf` is compared by the `cf` check, since an
// incoming request's differs between the runtimes too.
export const describeRequest = (request) => ({
  url: request.url,
  method: request.method,
  redirect: request.redirect,
  headers: setHeaders(request.headers),
  bodyUsed: request.bodyUsed,
  body: request.body === null ? null : Object.prototype.toString.call(request.body),
  cf: request.cf === undefined ? null : typeof request.cf,
});

export const REQUEST_CHECKS = {
  clone: async (make) => {
    const request = await make();
    const clone = request.clone();
    const out = { original: describeRequest(request), clone: describeRequest(clone) };
    out.sameSignal = clone.signal === request.signal;
    out.texts = [await request.text(), await clone.text()];
    out.after = [request.bodyUsed, clone.bodyUsed];
    return out;
  },
  cloneReadFirst: async (make) => {
    const request = await make();
    const clone = request.clone();
    return [await clone.text(), await request.text()];
  },
  afterPartialRead: async (make) => {
    const request = await make();
    if (request.body === null) return "no body";
    await readFirst(request.body);
    const usedBefore = request.bodyUsed;
    const clone = await attempt(() => describeRequest(request.clone()));
    return { usedBefore, usedAfter: request.bodyUsed, clone };
  },
  afterLock: async (make) => {
    const request = await make();
    if (request.body === null) return "no body";
    request.body.getReader();
    return attempt(() => describeRequest(request.clone()));
  },
  afterText: async (make) => {
    const request = await make();
    await request.text();
    return attempt(async () => {
      const clone = request.clone();
      return { clone: describeRequest(clone), text: await clone.text() };
    });
  },
  headers: async (make) => {
    const request = await make();
    const clone = request.clone();
    const set = await attempt(() => {
      clone.headers.set("x-clone", "1");
      return "set";
    });
    return { set, original: request.headers.get("x-clone"), clone: clone.headers.get("x-clone") };
  },
  cf: async (make) => {
    const request = await make();
    const clone = request.clone();
    if (clone.cf === undefined) return "no cf";
    clone.cf.mark = "clone";
    return { original: request.cf.mark ?? null, clone: clone.cf.mark };
  },
};

export const runRequestChecks = async (sources) => {
  const out = {};
  for (const [source, make] of Object.entries(sources)) {
    const row = {};
    for (const [check, run] of Object.entries(REQUEST_CHECKS)) row[check] = await attempt(() => run(make));
    out[source] = row;
  }
  return out;
};
