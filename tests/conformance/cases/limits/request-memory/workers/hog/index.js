// A stateless Worker whose request exceeds the heap limit. `poisoned` marks
// the isolate that did: a later request reports whether it runs there.
import { hog } from "./hog.js";

let poisoned = false;

export default {
  async fetch(request) {
    const mode = new URL(request.url).searchParams.get("mode");
    if (mode === "check") return Response.json({ poisoned });
    if (mode === "wait") return wait();
    poisoned = true;
    return new Response(`allocated ${hog(mode)}`);
  },
};

// In flight while another request in the isolate exceeds the limit. Its
// timer fires after the condemnation, and nothing of it may run then: it
// would retain more and answer 200.
async function wait() {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const keep = [];
  for (let i = 0; i < 6e6; i++) keep.push([i, 1, 2]);
  globalThis.waited = keep;
  return new Response(`waited ${keep.length}`);
}
