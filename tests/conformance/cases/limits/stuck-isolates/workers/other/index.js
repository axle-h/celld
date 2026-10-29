// Another Worker on the node, which keeps serving, and grows, while the
// others' isolates are stuck. `/busy` spins within its limit and answers
// which isolate it ran in.
let isolate;
export default {
  fetch(request) {
    isolate ??= crypto.randomUUID();
    if (new URL(request.url).pathname === "/busy") {
      // About 300 ms; time stands still within a turn.
      let x = 1;
      for (let i = 0; i < 4e8; i++) x = (Math.imul(x, 1103515245) + 12345) | 0;
      return new Response(x === 0.5 ? "" : isolate);
    }
    return new Response("other ok");
  },
};
