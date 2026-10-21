// Passes every request on to `back` and returns its response unchanged.
export default {
  fetch(request, env) {
    return env.BACK.fetch(request);
  },
};
