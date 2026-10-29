// Turns that hold their thread must not starve the node (plan 1.61). The node
// runs with two Tokio workers and four isolate threads, and each Worker gets
// at most two isolates.
//
// /wedge: six requests to `hog` (the review's repro, past its 1 s limit)
// keep both of its isolates busy while the node's listeners (the case probes
// the operator listener; this probes the public one's health endpoint) and
// another Worker keep answering within a bound.
//
// /hold: `stuck` gets two turns stuck, one in a Dynamic Worker it loads, both
// counted against it, and `stuck2` one: three, the node's cap. A Durable
// Object of `stuck` armed before them sends a new event to an object already
// placed, and asks for one not yet placed, once they are stuck. The case's `internal` steps then read `/state` and probe the
// operator listener. /refused shows `stuck` refused at once with the CPU
// limit's error, `stuck2` refused growth at the node's cap, the Durable
// Object refused placement, and `other`, which holds none, still growing.
// /recovered shows `stuck` serving again once the holds return.

// How long a probe may take. A wedged node takes as long as a whole turn.
const PROBE_BOUND_MS = 500;
// How long each hold runs, far past the 10 ms limits.
const HOLD_MS = 6000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function outcome(call) {
  try {
    const response = await call();
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { error: error.name, message: error.message };
  }
}

async function timed(call) {
  const started = Date.now();
  const result = await outcome(call);
  return { ms: Date.now() - started, ...result };
}

// The node's listener and another Worker, each within the bound.
async function probe(env, port) {
  const health = await timed(() =>
    fetch(`http://127.0.0.1:${port}/.well-known/celld/health`, { signal: AbortSignal.timeout(20_000) }),
  );
  const other = await timed(() => env.OTHER.fetch("http://other/"));
  return {
    listener: health.status !== undefined && health.ms < PROBE_BOUND_MS,
    other: other.body === "other ok" && other.ms < PROBE_BOUND_MS,
    detail: { health, other },
  };
}

// What the holds answered, kept for /results.
let held = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/wedge": {
        const port = url.searchParams.get("public");
        let settled = false;
        const hogs = Promise.all(
          Array.from({ length: 6 }, () => outcome(() => env.HOG.fetch("http://hog/"))),
        ).finally(() => (settled = true));
        // Probe every 100 ms while they run; bounded.
        const slow = [];
        let probes = 0;
        while (!settled && probes < 600) {
          const result = await probe(env, port);
          probes++;
          if (!result.listener || !result.other) slow.push(result.detail);
          await pause(100);
        }
        const results = await hogs;
        return Response.json({
          hogs: [...new Set(results.map((result) => result.message ?? result.body))],
          probed: probes > 0,
          slowProbes: slow,
        });
      }
      case "/hold": {
        // Each call's first turn ends before the next is sent, so all three
        // of `stuck`'s land in its warm isolate: the Dynamic Worker's hold
        // runs in an isolate of its own, the Durable Object waits, and the
        // last holds the stateless isolate.
        // Before the holds: an object placed, and another that will reach it
        // with a new event, and reach an object not yet placed, once they
        // are stuck.
        await outcome(() => env.STUCK.fetch("http://stuck/room?name=placed"));
        const armed = await outcome(() => env.STUCK.fetch("http://stuck/room-later?after=1500"));
        if (armed.body !== "armed") return Response.json({ armed });
        // The Dynamic Worker's hold runs in an isolate of its own; the
        // stateless one holds `stuck`'s warm isolate.
        const holds = [];
        holds.push(outcome(() => env.STUCK.fetch(`http://stuck/dynamic?ms=${HOLD_MS}`)));
        await pause(50);
        holds.push(outcome(() => env.STUCK.fetch(`http://stuck/?ms=${HOLD_MS}`)));
        holds.push(outcome(() => env.STUCK2.fetch(`http://stuck2/?ms=${HOLD_MS}`)));
        ctx.waitUntil(Promise.all(holds).then((results) => (held = results)));
        return new Response("holding");
      }
      case "/refused": {
        const stuck = await timed(() => env.STUCK.fetch("http://stuck/"));
        const stuck2 = await timed(() => env.STUCK2.fetch("http://stuck2/"));
        // Overlapping on one isolate: the pool grows a second.
        const calls = [];
        for (let index = 0; index < 4; index++) {
          calls.push(outcome(() => env.OTHER.fetch("http://other/busy")));
          await pause(30);
        }
        const busy = await Promise.all(calls);
        return Response.json({
          stuck: { message: stuck.message ?? stuck.body, atOnce: stuck.ms < PROBE_BOUND_MS },
          stuck2: { message: stuck2.message ?? stuck2.body, atOnce: stuck2.ms < PROBE_BOUND_MS },
          otherGrew: new Set(busy.map((result) => result.body)).size,
        });
      }
      case "/recovered": {
        // Serves again once its calls have returned. Bounded.
        let result;
        for (let attempt = 0; attempt < 100; attempt++) {
          result = await outcome(() => env.STUCK.fetch("http://stuck/"));
          if (result.body === "held") break;
          await pause(100);
        }
        const room = await outcome(() => env.STUCK.fetch("http://stuck/room?name=fresh"));
        const later = await outcome(() => env.STUCK.fetch("http://stuck/room-result"));
        return Response.json({
          stateless: result.body,
          room: room.body ?? room.message,
          // What the object placed before the holds saw while they were stuck.
          whileStuck: later.body === undefined ? later : JSON.parse(later.body),
        });
      }
      case "/results": {
        // The holds have returned by now (`stuckIsolates.total` is 0). Bounded.
        for (let attempt = 0; attempt < 100 && held === null; attempt++) await pause(100);
        if (held === null) return Response.json({ held: "not in this isolate, or not returned" });
        const [dynamic, stateless, stuck2] = held;
        return Response.json({
          dynamic: dynamic.message ?? dynamic.body,
          stateless: stateless.message ?? stateless.body,
          stuck2: stuck2.message ?? stuck2.body,
        });
      }
    }
    return new Response("not found", { status: 404 });
  },
};
