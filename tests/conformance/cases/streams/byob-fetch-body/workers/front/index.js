import { checkAll, payload } from "#byob";

const settle = (promise) => promise.then(
  (result) => result === undefined
    ? "resolved"
    : { done: result.done, bytes: result.value?.byteLength ?? null },
  (error) => `${error.name}: ${error.message}`);

const within = (promise, ms = 100) => Promise.race([
  settle(promise),
  new Promise((resolve) => setTimeout(() => resolve("waiting"), ms)),
]);

// Cancel while a BYOB read waits on the network: the read rejects with the
// reason, as an Error, and the stream reads as done.
async function cancelWaiting(env) {
  const response = await env.BACK.fetch("http://back/stalled");
  const reader = response.body.getReader({ mode: "byob" });
  const first = await reader.read(new Uint8Array(64));
  const waiting = reader.read(new Uint8Array(64));
  const second = await within(waiting);
  const concurrent = await settle(reader.read(new Uint8Array(4)));
  const cancelled = await settle(reader.cancel("stop"));
  return {
    first: first.value.byteLength,
    match: first.value.every((byte, i) => byte === payload(16)[i]),
    second,
    concurrent,
    cancelled,
    read: await within(waiting),
    after: await settle(reader.read(new Uint8Array(4))),
    closed: await within(reader.closed),
  };
}

// releaseLock while a BYOB read waits on the network.
async function releaseWaiting(env) {
  const response = await env.BACK.fetch("http://back/stalled");
  const reader = response.body.getReader({ mode: "byob" });
  await reader.read(new Uint8Array(64));
  const waiting = reader.read(new Uint8Array(64));
  await within(waiting);
  let release;
  try {
    reader.releaseLock();
    release = "released";
  } catch (error) {
    release = `${error.name}: ${error.message}`;
  }
  const read = await within(waiting);
  const locked = response.body.locked;
  const cancelled = locked
    ? await settle(reader.cancel("stop"))
    : await settle(response.body.cancel("stop"));
  return { release, read, locked, cancelled, after: await within(waiting) };
}

export default {
  async fetch(request, env) {
    switch (new URL(request.url).pathname) {
      case "/parts":
        return Response.json(await checkAll(
          async () => (await env.BACK.fetch("http://back/parts")).body));
      case "/cancel-waiting":
        return Response.json(await cancelWaiting(env));
      case "/release-waiting":
        return Response.json(await releaseWaiting(env));
    }
    return new Response("not found", { status: 404 });
  },
};
