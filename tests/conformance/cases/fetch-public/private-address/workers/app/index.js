// fetch() to an IP literal that is not a public address is refused before
// celld connects, in every written form: IPv4, IPv6, IPv4-mapped, NAT64, and
// the numeric forms the URL parser turns into an IPv4 address. The first one
// is the runner's upstream server, which is listening, so a refusal there is
// the policy and not a closed port.
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
    const urls = [
      `http://127.0.0.1:${port}/`,
      `https://127.0.0.1:${port}/`,
      `http://2130706433:${port}/`,
      `http://0.0.0.0:${port}/`,
      "http://10.1.2.3/",
      "http://172.16.0.1/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://224.0.0.1/",
      "http://255.255.255.255/",
      `http://[::1]:${port}/`,
      `http://[::ffff:127.0.0.1]:${port}/`,
      "http://[::ffff:169.254.169.254]/",
      "http://[64:ff9b::a9fe:a9fe]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://[ff02::1]/",
      "http://[::]/",
    ];
    const results = [];
    for (const url of urls) results.push(await probe(url));
    return Response.json(results);
  },
};
