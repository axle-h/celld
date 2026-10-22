// Every redirect hop is checked like the first request. The upstream's first
// port is allowed, so its `/redirect?to=` is reachable; a redirect from there
// to an address the policy refuses fails the fetch, whether the target is an
// IP literal or a name that resolves to one. With redirect: "manual" nothing
// is followed, so the 302 comes back.
async function probe(url, init) {
  try {
    const response = await fetch(url, init);
    return {
      status: response.status,
      location: response.headers.get("location"),
      body: await response.text(),
    };
  } catch (error) {
    return { error: error.name, message: error.message };
  }
}

export default {
  async fetch(request) {
    const params = new URL(request.url).searchParams;
    const allowed = `http://127.0.0.1:${params.get("port")}`;
    const other = params.get("other");
    const redirect = (to) => `${allowed}/redirect?to=${encodeURIComponent(to)}`;
    return Response.json({
      allowedHop: await probe(redirect("/landed?from=redirect")),
      literal: await probe(redirect(`http://127.0.0.1:${other}/`)),
      metadata: await probe(redirect("http://169.254.169.254/latest/meta-data/")),
      mapped: await probe(redirect(`http://[::ffff:127.0.0.1]:${other}/`)),
      name: await probe(redirect(`http://localhost:${other}/`)),
      manual: await probe(redirect(`http://127.0.0.1:${other}/`), { redirect: "manual" }),
    });
  },
};
