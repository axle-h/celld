export default {
  async fetch(request, env) {
    try {
      const response = await env.FRONT.fetch(request);
      try {
        return new Response(`${response.status}: ${await response.text()}`);
      } catch (error) {
        return new Response(`${response.status}, read ${error.name}: ${error.message}`);
      }
    } catch (error) {
      return new Response(`threw ${error.name}: ${error.message}`);
    }
  },
};
