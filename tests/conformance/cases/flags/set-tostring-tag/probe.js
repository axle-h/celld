// Symbol.toStringTag under set_tostring_tag: workerd gives every API
// class's prototype its name, writable and configurable but not enumerable
// (jsg/resource.h), and without the flag none. The objects that are not
// instances of an API class in celld are flags/set-tostring-tag-instances'
// (plan 1.63).
import { DurableObject } from "cloudflare:workers";

const CLASSES = [
  "AbortController", "AbortSignal", "Blob", "ByteLengthQueuingStrategy", "Cache",
  "CacheStorage", "CloseEvent", "CompressionStream", "CountQueuingStrategy",
  "CryptoKey", "CustomEvent", "DOMException", "DecompressionStream", "ErrorEvent",
  "Event", "EventSource", "EventTarget", "ExtendableEvent", "File",
  "FixedLengthStream", "FormData", "HTMLRewriter", "Headers",
  "IdentityTransformStream", "MessageChannel", "MessageEvent", "MessagePort",
  "ReadableByteStreamController", "ReadableStream", "ReadableStreamBYOBReader",
  "ReadableStreamBYOBRequest", "ReadableStreamDefaultController",
  "ReadableStreamDefaultReader", "Request", "Response", "SubtleCrypto",
  "TextDecoder", "TextDecoderStream", "TextEncoder", "TextEncoderStream",
  "TransformStream", "TransformStreamDefaultController", "URL", "URLPattern",
  "URLSearchParams", "WebSocket", "WebSocketPair", "WebSocketRequestResponsePair",
  "WritableStream", "WritableStreamDefaultController", "WritableStreamDefaultWriter",
];

const tag = (target) => {
  const descriptor = Object.getOwnPropertyDescriptor(target, Symbol.toStringTag);
  if (descriptor === undefined) return null;
  if (descriptor.get !== undefined) return "accessor";
  const flags = `${descriptor.writable ? "w" : ""}${descriptor.enumerable ? "e" : ""}${descriptor.configurable ? "c" : ""}`;
  return `${String(descriptor.value)}|${flags}`;
};
const kind = (value) => Object.prototype.toString.call(value);

export class Thing extends DurableObject {
  ping() { return "pong"; }
}

export default {
  async fetch(request, env) {
    const prototypes = {};
    for (const name of CLASSES) prototypes[name] = globalThis[name] === undefined ? "absent" : tag(globalThis[name].prototype);
    prototypes.DigestStream = tag(crypto.DigestStream.prototype);
    let readableController;
    let writableController;
    let transformController;
    new ReadableStream({ start(controller) { readableController = controller; } });
    new WritableStream({ start(controller) { writableController = controller; } });
    new TransformStream({ start(controller) { transformController = controller; } });
    const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
    const [socket] = Object.values(new WebSocketPair());
    const instances = {
      request: kind(request),
      headers: kind(request.headers),
      signal: kind(request.signal),
      response: kind(new Response("x")),
      body: kind(new Response("x").body),
      reader: kind(new Response("x").body.getReader()),
      byobReader: kind(new ReadableStream({ type: "bytes" }).getReader({ mode: "byob" })),
      writer: kind(new WritableStream().getWriter()),
      readableController: kind(readableController),
      writableController: kind(writableController),
      transformController: kind(transformController),
      blob: kind(new Blob(["x"])),
      file: kind(new File(["x"], "x")),
      formData: kind(new FormData()),
      url: kind(new URL("http://x/?a=1")),
      searchParams: kind(new URL("http://x/?a=1").searchParams),
      pattern: kind(new URLPattern({ pathname: "/x" })),
      event: kind(new Event("x")),
      controller: kind(new AbortController()),
      encoder: kind(new TextEncoder()),
      compression: kind(new CompressionStream("gzip")),
      subtle: kind(crypto.subtle),
      key: kind(key),
      digest: kind(new crypto.DigestStream("SHA-256")),
      cache: kind(caches.default),
      socket: kind(socket),
      rewriter: kind(new HTMLRewriter()),
      objectStub: kind(env.OBJECT.get(env.OBJECT.idFromName("x"))),
    };
    return Response.json({
      prototypes,
      instances,
      reported: Cloudflare.compatibilityFlags.set_tostring_tag ?? null,
    });
  },
};
