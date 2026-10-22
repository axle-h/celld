// The ASSETS binding is a Fetcher, so it follows a redirect through itself:
// the 307 html_handling answers for /about.html is followed to /about.
async function probe(assets, init) {
  const response = await assets.fetch("http://assets.test/about.html", init);
  return {
    status: response.status,
    url: response.url,
    redirected: response.redirected,
    location: response.headers.get("location"),
    body: await response.text(),
  };
}

export default {
  async fetch(request, env) {
    return Response.json({
      follow: await probe(env.ASSETS),
      manual: await probe(env.ASSETS, { redirect: "manual" }),
    });
  },
};
