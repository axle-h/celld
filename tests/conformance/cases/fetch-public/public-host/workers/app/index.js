// A public address passes the policy, as an IP literal and as a name. The
// transcript records only whether the policy refused the request, so it is
// the same whether the machine running the case is online (a response) or
// offline (a network error, or the timeout).
async function refusedByPolicy(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    return false;
  } catch (error) {
    return error instanceof TypeError && error.message.startsWith("celld egress policy");
  }
}

export default {
  async fetch() {
    return Response.json({
      literal: await refusedByPolicy("http://1.1.1.1/"),
      name: await refusedByPolicy("http://one.one.one.one/"),
    });
  },
};
