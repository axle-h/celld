// The status checks of the Response constructor (plan 1.22): the range a
// Response may take with and without a WebSocket, and how the status
// converts. builtins/response-null-body has the checks on a null body status
// and on statusText.
const STATUSES = [
  undefined, 0, 99, 100, 101, 102, 103, 199, 200, 204, 205, 299, 304, 404, 599, 600, 999, -1,
  -200, 200.9, 101.5, "201", "", "abc", null, NaN, Infinity, 2 ** 32 + 200, 2 ** 31 + 200, 1e10,
];

const label = (status) => (typeof status === "string" ? JSON.stringify(status) : String(status));

const attempt = (make) => {
  try {
    const response = make();
    return `${response.status} ${response.ok}`;
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

export default {
  fetch() {
    const results = {};
    for (const status of STATUSES) {
      results[label(status)] = attempt(() => new Response(null, { status }));
      const [client] = Object.values(new WebSocketPair());
      results[`${label(status)} webSocket`] = attempt(
        () => new Response(null, { status, webSocket: client }),
      );
    }
    // A Response as the init carries its status, and its WebSocket.
    const [client] = Object.values(new WebSocketPair());
    const upgrade = new Response(null, { status: 101, webSocket: client });
    results["rebuilt 101"] = attempt(() => new Response(null, upgrade));
    results["rebuilt 101 as 200"] = attempt(() => new Response(null, { status: 200, webSocket: upgrade.webSocket }));
    results["webSocket null"] = attempt(() => new Response(null, { status: 200, webSocket: null }));
    results["webSocket undefined"] = attempt(() => new Response(null, { status: 101, webSocket: undefined }));
    return Response.json(results);
  },
};
