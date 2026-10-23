import { runBackpressureChecks, runResponseChecks } from "#clone";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const upstream = `http://127.0.0.1:${url.searchParams.get("port")}`;
    if (url.pathname === "/responses") {
      // celld's network responses have no statusText of their own yet
      // (builtins/body-defaults), and workerd runs this case without a
      // cache (fetch/response-clone has cachePut).
      return Response.json(await runResponseChecks({
        network: () => fetch(`${upstream}/`),
        redirected: () => fetch(`${upstream}/bounce`),
        manual: () => fetch(`${upstream}/bounce`, { redirect: "manual" }),
      }, { statusText: false, skip: ["cachePut"] }));
    }
    if (url.pathname === "/backpressure") {
      // 4 MiB.
      return Response.json(await runBackpressureChecks({
        network: () => fetch(`${upstream}/big?kib=4096`),
      }));
    }
    return new Response("not found", { status: 404 });
  },
};
