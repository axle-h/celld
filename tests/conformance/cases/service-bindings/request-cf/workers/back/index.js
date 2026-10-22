// The same server as front's `serve`.
const serve = (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/redirect")
    return new Response(null, { status: 307, headers: { location: "/cf" } });
  return Response.json(request.cf ?? null);
};

export default { fetch: serve };
