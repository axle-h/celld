// workers_api_getters_setters_on_prototype: an API class's attributes are
// accessors of its prototype, whose getters have no name; without the flag
// they are read-only data properties of each instance, in the reverse of
// their declaration order, and the prototypes have none.
const kind = (value) => value === null ? "null"
  : typeof value === "object" ? `object ${value.constructor?.name}`
  : typeof value === "function" ? "function"
  : `${typeof value} ${String(value)}`;

const own = (object) => Reflect.ownKeys(object).map(String).map((key) => {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return "value" in descriptor
    ? [key, kind(descriptor.value), descriptor.writable, descriptor.enumerable, descriptor.configurable]
    : [key, "accessor", typeof descriptor.get, typeof descriptor.set];
});

const accessors = (object, names) => names.map((name) => {
  let target = Object.getPrototypeOf(object);
  while (target && !Object.getOwnPropertyDescriptor(target, name)) target = Object.getPrototypeOf(target);
  const descriptor = target && Object.getOwnPropertyDescriptor(target, name);
  if (!descriptor || target === Object.getPrototypeOf(object) && false) return [name, null];
  return "get" in descriptor
    ? [name, target.constructor?.name, descriptor.get?.name ?? null, typeof descriptor.set, descriptor.enumerable, descriptor.configurable]
    : [name, "data"];
});

const attempt = (fn) => {
  try {
    return kind(fn());
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

export default {
  async fetch() {
    const [client] = Object.values(new WebSocketPair());
    const controller = new AbortController();
    const objects = {
      request: [new Request("http://x/", { method: "POST", body: "x" }),
        ["method", "url", "headers", "redirect", "fetcher", "signal", "cf", "integrity", "keepalive", "body", "bodyUsed"]],
      response: [new Response("x"),
        ["status", "statusText", "headers", "ok", "redirected", "url", "webSocket", "cf", "type", "body", "bodyUsed"]],
      textDecoder: [new TextDecoder(), ["encoding", "fatal", "ignoreBOM"]],
      textEncoder: [new TextEncoder(), ["encoding"]],
      event: [new Event("x"), ["type", "eventPhase", "composed", "bubbles", "cancelable", "defaultPrevented",
        "returnValue", "currentTarget", "target", "srcElement", "timeStamp", "isTrusted", "cancelBubble"]],
      customEvent: [new CustomEvent("x", { detail: 1 }), ["detail", "type"]],
      messageEvent: [new MessageEvent("x", { data: 1 }), ["data", "type"]],
      closeEvent: [new CloseEvent("x", { code: 1000 }), ["code", "type"]],
      errorEvent: [new ErrorEvent("x", { message: "m" }), ["message", "filename", "lineno", "colno", "error", "type"]],
      abortController: [controller, ["signal"]],
      abortSignal: [controller.signal, ["aborted", "reason", "onabort"]],
      transformStream: [new TransformStream(), ["readable", "writable"]],
      identityTransformStream: [new IdentityTransformStream(), ["readable", "writable"]],
      textEncoderStream: [new TextEncoderStream(), ["readable", "writable", "encoding"]],
      compressionStream: [new CompressionStream("gzip"), ["readable", "writable"]],
      webSocket: [client, ["readyState", "url", "protocol", "extensions", "binaryType"]],
    };
    const shapes = {};
    for (const [name, [object, names]] of Object.entries(objects))
      shapes[name] = { own: own(object), accessors: accessors(object, names) };
    // What an instance attribute reads after the state behind it changed.
    const response = new Response("x");
    const usedBefore = response.bodyUsed;
    await response.text();
    const live = new AbortController();
    live.abort("why");
    const event = new Event("x", { cancelable: true });
    event.preventDefault();
    const request = new Request("http://x/");
    class Status extends Response {
      get status() { return 299; }
    }
    class Cf extends Request {
      get cf() { return "subclass"; }
    }
    const body = Object.getPrototypeOf(Request.prototype);
    return Response.json({
      shapes,
      live: [usedBefore, response.bodyUsed, live.signal.aborted, live.signal.reason,
        event.defaultPrevented, Object.getOwnPropertyDescriptor(response, "bodyUsed")?.value ?? "accessor"],
      // A body stream's own keys are covered by
      // flags/getters-setters-on-prototype-streams.
      json: [JSON.stringify(request), JSON.stringify(new Response(null, { statusText: "Fine" }))],
      statusText: [new Response(null).statusText, new Response(null, { status: 404 }).statusText,
        new Response(null, { statusText: "" }).statusText],
      clone: [attempt(() => structuredClone(request)), attempt(() => structuredClone(new Response("x")))],
      subclass: [new Status("x").status, new Cf("http://x/").cf],
      // The message of an assignment to a read-only accessor is covered by
      // builtins/readonly-attribute-assignment.
      assign: [attempt(() => { request.url = "y"; return request.url; }).split(":")[0],
        attempt(() => { event.cancelBubble = true; return event.cancelBubble; })],
      targets: (() => {
        const target = new EventTarget();
        const seen = [];
        const event = new Event("x");
        seen.push([event.target, event.currentTarget, event.srcElement].map(kind));
        target.addEventListener("x", (e) => seen.push([e.target, e.currentTarget, e.srcElement].map(kind)));
        target.dispatchEvent(event);
        seen.push([event.target, event.currentTarget, event.srcElement].map(kind));
        return seen;
      })(),
      body: [body === Object.getPrototypeOf(Response.prototype), body.constructor.name,
        Object.getOwnPropertyNames(body).filter((key) => key !== "constructor"), attempt(() => new body.constructor())],
      transform: [new CompressionStream("gzip") instanceof TransformStream, new IdentityTransformStream() instanceof TransformStream],
      reported: Cloudflare.compatibilityFlags.workers_api_getters_setters_on_prototype ?? null,
    });
  },
};
