// The own keys of API objects that celld builds with properties of its own:
// workerd's have none (plan 1.64).
export default {
  async fetch() {
    const { readable, writable } = new TransformStream();
    const objects = {
      readableStream: new ReadableStream(),
      transformReadable: readable,
      writableStream: writable,
      defaultReader: new ReadableStream().getReader(),
      writer: new WritableStream().getWriter(),
      responseBody: new Response("x").body,
      headers: new Headers(),
      blob: new Blob(["x"]),
      file: new File(["x"], "f", { lastModified: 1 }),
      formData: new FormData(),
      digestStream: new crypto.DigestStream("SHA-256"),
      abortSignal: new AbortController().signal,
      eventTarget: new EventTarget(),
    };
    return Response.json(Object.fromEntries(
      Object.entries(objects).map(([name, object]) => [name, Reflect.ownKeys(object).map(String)])));
  },
};
