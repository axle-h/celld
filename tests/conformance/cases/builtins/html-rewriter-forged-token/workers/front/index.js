// An HTMLRewriter token's host id is private to it (plan 1.50). Rewriter ids
// are a counter, so before 1.50 an element handler could point its token's
// `__state` at the rewriter another script made just before (`back`'s, whose
// parser is parked on a token) and change that document. A token now has no
// `__state` (the handler reports that); one it sets changes nothing, the
// handler's calls act on its own token, and back's output is its own. The
// host's check of another owner's id is unit-tested (`html_rewriter::tests`).
let hidden = null;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/forge") return env.BACK.fetch(request);
    const source = new Response("<p>front</p>", { headers: { "content-type": "text/html" } });
    const transformed = new HTMLRewriter()
      .on("p", {
        element(element) {
          hidden = !("__state" in element);
          element.__state = {
            id: 1,
            live: true,
            attrEpoch: 0,
            deferred: [],
            endTag: null,
          };
          element.setAttribute("forged", "1");
        },
      })
      .transform(source);
    const text = await transformed.text();
    return Response.json({ hidden, text });
  },
};
