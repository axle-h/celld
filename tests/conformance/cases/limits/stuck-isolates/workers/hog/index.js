// The review's repro (plan 1.61): a sync `fetch` returning an async IIFE
// whose loop allocates a large array each pass. Its limit stops it; on some
// machines the termination lands seconds late, and its isolate is condemned
// while the loop still runs.
export default {
  fetch() {
    return (async () => {
      let c = 0;
      for (let i = 0; i < 1e9; i++) c += new Array(1e6).fill(1).length;
      return new Response(String(c));
    })();
  },
};
