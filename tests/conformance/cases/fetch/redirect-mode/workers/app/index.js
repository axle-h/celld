// The redirect modes a Request takes. workerd parses `redirect` in the
// Request constructor, ignoring case, and refuses "error" and anything else
// there, so `fetch()` rejects before any request leaves.
function construct(init, input = "http://example.test/") {
  try {
    return { redirect: new Request(input, init).redirect };
  } catch (error) {
    return { error: error.name, message: error.message };
  }
}

async function fetched(init) {
  let pending;
  try {
    // An unreachable port: the request must never get that far.
    pending = fetch("http://127.0.0.1:9/", init);
  } catch (error) {
    return { thrown: error.name, message: error.message };
  }
  try {
    await pending;
    return { resolved: true };
  } catch (error) {
    return { rejected: error.name, message: error.message };
  }
}

export default {
  async fetch() {
    return Response.json({
      default: construct({}),
      undefined: construct({ redirect: undefined }),
      follow: construct({ redirect: "follow" }),
      manual: construct({ redirect: "manual" }),
      upperCase: construct({ redirect: "FOLLOW" }),
      mixedCase: construct({ redirect: "Manual" }),
      error: construct({ redirect: "error" }),
      other: construct({ redirect: "bogus" }),
      null: construct({ redirect: null }),
      fromRequest: construct({ redirect: "error" }, new Request("http://example.test/")),
      inherited: construct({}, new Request("http://example.test/", { redirect: "manual" })),
      // A Request as the init: its mode comes with it.
      requestAsInit: construct(new Request("http://other.test/", { redirect: "manual" })),
      fetchError: await fetched({ redirect: "error" }),
      fetchOther: await fetched({ redirect: "bogus" }),
    });
  },
};
