// A socket's host id is private to it (plan 1.50). Before 1.50 a Socket
// kept it in a writable `_id`, and ids are a counter, so a Worker could point
// its own Socket at the connection another script opened just before
// (`back`'s) and write to it and close it. Now a Socket has no `_id` to
// read or set: front reports that, sets one anyway, and its write and close
// act on its own connection only, while back's report shows that nothing
// arrived on its connection and it is still open. The host's own check of
// an id another owner holds is unit-tested (`tcp::tests`): no script can
// hand the host an id any more.
import { connect } from "cloudflare:sockets";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function attempt(fn) {
  try {
    return { ok: (await fn()) ?? null };
  } catch (error) {
    return { error: `${error?.name}: ${error?.message}` };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/hold" || url.pathname === "/report") {
      return env.BACK.fetch(request);
    }
    if (url.pathname !== "/forge") return new Response("not found", { status: 404 });
    const port = url.searchParams.get("port");
    const mine = connect(`127.0.0.1:${port}`);
    await mine.opened;
    const hidden = !("_id" in mine) && Object.getOwnPropertyNames(mine).length === 0;
    const write = await attempt(async () => {
      mine._id = 1;
      const writer = mine.writable.getWriter();
      await writer.write(enc.encode("forged"));
      writer.releaseLock();
      const reader = mine.readable.getReader();
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ done: true }), 1000)),
      ]);
      return done ? "<nothing>" : dec.decode(value);
    });
    const other = connect(`127.0.0.1:${port}`);
    await other.opened;
    const close = await attempt(async () => {
      other._id = 1;
      await other.close();
      return "closed";
    });
    await mine.close();
    return Response.json({ hidden, write, close });
  },
};
