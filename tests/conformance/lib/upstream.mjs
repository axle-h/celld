// A local HTTP server for cases whose Workers fetch "the network": the
// redirecting server of `service-bindings/redirect-outside`, and the private
// address the `fetch-public/*` cases try to reach. It listens on two loopback
// ports, so a case can allow one and show that the other is still refused.

import { createServer } from "node:http";

/**
 * Starts the server and returns `{ ports: [first, second], close() }`.
 *
 * - `/bounce` answers 302 to `/landed?from=bounce`.
 * - `/landed` answers JSON `{"landed": <the query string>}`.
 * - `/redirect?to=<url>` answers 302 to that URL.
 * - Anything else answers `upstream`.
 */
export async function startUpstream() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://upstream");
    switch (url.pathname) {
      case "/bounce":
        response.writeHead(302, { location: "/landed?from=bounce" }).end("bounce");
        return;
      case "/landed":
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ landed: url.search }));
        return;
      case "/redirect":
        response.writeHead(302, { location: url.searchParams.get("to") ?? "/" }).end("redirect");
        return;
      default:
        response.writeHead(200, { "content-type": "text/plain" }).end("upstream");
    }
  });
  const second = createServer(server.listeners("request")[0]);
  const listen = (instance) =>
    new Promise((resolve, reject) => {
      instance.once("error", reject);
      instance.listen(0, "127.0.0.1", () => resolve(instance.address().port));
    });
  const close = (instance) =>
    new Promise((resolve) => {
      if (!instance.listening) return resolve();
      instance.closeAllConnections();
      instance.close(() => resolve());
    });
  try {
    const ports = [await listen(server), await listen(second)];
    return { ports, close: () => Promise.all([close(server), close(second)]) };
  } catch (error) {
    await Promise.all([close(server), close(second)]);
    throw error;
  }
}
