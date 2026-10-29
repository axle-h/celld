// A stateless Worker with `limits.cpu_ms` of 50. One request spins until
// its limit stops it, and one spends its limit a little at a time, across
// turns. Each fails alone, and the Worker serves the next.

// About 4 ms of CPU time on a fast machine.
export function work() {
  let x = 1;
  for (let i = 0; i < 5e6; i++) x = (Math.imul(x, 1103515245) + 12345) | 0;
  return x;
}

// Long past any limit here (about 20 s), and bounded, so a broken limit
// fails the case rather than hanging it.
export function spin() {
  for (let i = 0; i < 5000; i++) work();
  return "spun";
}

export default {
  // A thrown value whose conversion to a string spins: celld reports a
  // thrown value without running its code.
  fetch(request) {
    const mode = new URL(request.url).searchParams.get("mode");
    if (mode === "throw-spinning") throw { toString: spin, valueOf: spin };
    return this.serve(request);
  },
  async serve(request) {
    const mode = new URL(request.url).searchParams.get("mode");
    if (mode === "spin") return new Response(spin());
    // Builtins that V8 can let a termination slip past, called in a loop.
    if (mode === "json") {
      const big = JSON.stringify(Array.from({ length: 300000 }, (_, i) => ({ i, s: `x${i}` })));
      for (let i = 0; i < 1000; i++) JSON.parse(big);
      return new Response("parsed");
    }
    if (mode === "steps") {
      // Each turn stays far under the limit; together they pass it.
      for (let step = 0; step < 2000; step++) {
        work();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return new Response("finished");
    }
    if (mode === "wait") {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return new Response("waited");
    }
    return Response.json({ ok: true });
  },
};
