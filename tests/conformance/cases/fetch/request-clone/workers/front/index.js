import { REQUEST_CHECKS, runRequestChecks } from "#clone";

const encoder = new TextEncoder();

const userStream = () => {
  const parts = ["one,", "two,", "three"];
  return new ReadableStream({
    pull(controller) {
      const part = parts.shift();
      if (part === undefined) controller.close();
      else controller.enqueue(encoder.encode(part));
    },
  });
};

const headers = { "x-from": "front", "content-type": "text/plain;charset=UTF-8" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/requests") {
      return Response.json(await runRequestChecks({
        constructedString: () =>
          new Request("https://example.com/a", { method: "POST", body: "a string", headers, cf: { colo: "test" } }),
        constructedStream: () => new Request("https://example.com/a", { method: "POST", body: userStream(), headers }),
        constructedGet: () => new Request("https://example.com/a?q", { headers, redirect: "manual" }),
        copied: () =>
          new Request(new Request("https://example.com/b", { method: "PUT", body: "copied", headers }), {
            redirect: "manual",
          }),
        fetchedBody: async () =>
          new Request("https://example.com/c", { method: "POST", body: (await env.BACK.fetch("http://back/")).body }),
      }));
    }
    if (url.pathname === "/signal") {
      const controller = new AbortController();
      const original = new Request("https://example.com/", { signal: controller.signal });
      const clone = original.clone();
      const out = { originalIsInit: original.signal === controller.signal, same: clone.signal === original.signal };
      controller.abort("why");
      out.aborted = [original.signal.aborted, clone.signal.aborted];
      out.reason = clone.signal.reason ?? null;
      return Response.json(out);
    }
    // The request this step sent, through one check.
    const check = REQUEST_CHECKS[url.searchParams.get("check")];
    return Response.json(await check(() => request));
  },
};
