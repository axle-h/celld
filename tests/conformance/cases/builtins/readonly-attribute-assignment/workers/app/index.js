// Assigning to a read-only attribute in strict code. workerd's prototype
// accessors are read-only V8 accessors, so V8 reports a read-only property;
// celld's are JavaScript getters without a setter, so V8 reports a getter
// without a setter (plan 1.64). Without
// workers_api_getters_setters_on_prototype both report a read-only
// property.
const attempt = (fn) => {
  try {
    fn();
    return "assigned";
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

export default {
  async fetch() {
    const request = new Request("http://x/");
    const response = new Response(null);
    const signal = new AbortController().signal;
    return Response.json([
      attempt(() => { request.url = "y"; }),
      attempt(() => { response.status = 1; }),
      attempt(() => { signal.aborted = true; }),
      attempt(() => { new TextDecoder().encoding = "x"; }),
    ]);
  },
};
