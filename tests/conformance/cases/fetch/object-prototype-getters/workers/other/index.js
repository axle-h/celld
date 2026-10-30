export default {
  async fetch(request) {
    return new Response(`${request.method} ${new URL(request.url).pathname} ${await request.text()}`);
  },
};
