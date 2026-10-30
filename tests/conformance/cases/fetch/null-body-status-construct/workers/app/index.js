// A Response with a null body status (101, 204, 205 or 304) and a body:
// workerd refuses one that is a stream or not empty, and treats an empty
// buffer as no body (http.c++ Response::constructor), as celld does (plan
// 1.40).
const attempt = (fn) => {
  try {
    const response = fn();
    return ["ok", response.status, response.body === null];
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};
export default {
  fetch() {
    return Response.json({
      text: attempt(() => new Response("x", { status: 204 })),
      empty: attempt(() => new Response("", { status: 205 })),
      emptyBytes: attempt(() => new Response(new Uint8Array(0), { status: 304 })),
      stream: attempt(() => new Response(new ReadableStream(), { status: 204 })),
      none: attempt(() => new Response(null, { status: 204 })),
    });
  },
};
