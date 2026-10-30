// workers_api_getters_setters_on_prototype for the streams, their readers
// and writers, Blob, File, DigestStream and crypto: where each attribute is,
// and, without the flag, the instance's own descriptor of it. (Their other
// own keys are covered by builtins/internal-own-keys.)
const kind = (value) => value === null ? "null"
  : typeof value === "object" ? `object ${value.constructor?.name}`
  : typeof value === "function" ? "function"
  : `${typeof value} ${String(value)}`;

const attributes = (object, names) => names.map((name) => {
  const ownDescriptor = Object.getOwnPropertyDescriptor(object, name);
  let target = Object.getPrototypeOf(object);
  while (target && !Object.getOwnPropertyDescriptor(target, name)) target = Object.getPrototypeOf(target);
  const descriptor = target && Object.getOwnPropertyDescriptor(target, name);
  return [name,
    ownDescriptor ? ["own", kind(ownDescriptor.value), ownDescriptor.writable, ownDescriptor.enumerable, ownDescriptor.configurable] : null,
    descriptor ? ["get" in descriptor ? "accessor" : "data", target.constructor?.name ?? null,
      descriptor.get?.name ?? null, descriptor.enumerable] : null];
});

export default {
  async fetch() {
    const readable = new ReadableStream();
    const writable = new WritableStream();
    const bytes = new ReadableStream({ type: "bytes" });
    return Response.json({
      readableStream: attributes(readable, ["locked"]),
      defaultReader: attributes(new ReadableStream().getReader(), ["closed"]),
      byobReader: attributes(bytes.getReader({ mode: "byob" }), ["closed"]),
      writableStream: attributes(writable, ["locked"]),
      writer: attributes(new WritableStream().getWriter(), ["closed", "ready", "desiredSize"]),
      blob: attributes(new Blob(["x"]), ["size", "type"]),
      file: attributes(new File(["x"], "f", { lastModified: 1 }), ["name", "lastModified", "size", "type"]),
      digestStream: attributes(new crypto.DigestStream("SHA-256"), ["digest", "bytesWritten", "locked"]),
      crypto: attributes(crypto, ["subtle", "getRandomValues", "randomUUID"]),
      reported: Cloudflare.compatibilityFlags.workers_api_getters_setters_on_prototype ?? null,
    });
  },
};
