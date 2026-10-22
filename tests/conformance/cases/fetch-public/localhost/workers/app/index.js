// A hostname that resolves only to private addresses is refused too. The
// check runs on the resolved addresses, the ones celld would connect to, so a
// name can't pass the check with one address and connect to another.
// `localhost` resolves to loopback through the system resolver; the runner's
// upstream server listens there.
async function probe(url) {
  try {
    const response = await fetch(url);
    return { url, status: response.status, body: await response.text() };
  } catch (error) {
    return { url, error: error.name, message: error.message };
  }
}

export default {
  async fetch(request) {
    const port = new URL(request.url).searchParams.get("port");
    return Response.json([
      await probe(`http://localhost:${port}/`),
      await probe(`http://LocalHost.:${port}/`),
    ]);
  },
};
