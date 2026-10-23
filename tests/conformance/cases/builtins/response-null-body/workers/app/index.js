// The Response constructor's checks on a body with a null body status (101,
// 204, 205 and 304) and on statusText. workerd refuses a body there unless it
// is empty, and a control character in statusText. celld accepts both (plan
// 1.42).
const attempt = (make) => {
  try {
    const response = make();
    return `${response.status} ${response.body === null ? "null body" : "body"}`;
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

export default {
  fetch() {
    const results = {};
    for (const status of [101, 204, 205, 304]) {
      const end = () => (status === 101 ? Object.values(new WebSocketPair())[0] : undefined);
      results[`${status} with body`] = attempt(() => new Response("x", { status, webSocket: end() }));
      results[`${status} with empty body`] = attempt(() => new Response("", { status, webSocket: end() }));
      results[`${status} with a stream`] = attempt(
        () => new Response(new ReadableStream(), { status, webSocket: end() }),
      );
    }
    results["statusText newline"] = attempt(() => new Response(null, { statusText: "a\nb" }));
    results["statusText tab"] = attempt(() => new Response(null, { statusText: "a\tb" }));
    return Response.json(results);
  },
};
