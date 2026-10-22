export default {
  fetch(request) {
    return new Response(`worker ${new URL(request.url).pathname}`);
  },
};
