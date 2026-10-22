// A Worker dials the runner's upstream, which sends its Close as soon as the
// connection opens (lib/upstream.mjs, /ws/close-first). The upstream records
// the Close that answers it, the frames before that answer, and whether the
// connection then ended. `reply` chooses what the close listener does:
// `now` closes with 4052, `send` sends a frame and then closes with 4054,
// `no-code` closes with no code, and `none` returns without closing, so the
// request ends with the socket half-open.
export async function dial(request) {
  const url = new URL(request.url);
  const upstream = `127.0.0.1:${url.searchParams.get("port")}`;
  const id = url.searchParams.get("id");
  const log = async () => (await fetch(`http://${upstream}/ws/log?id=${id}`)).json();
  if (url.pathname.endsWith("/log")) return Response.json(await log());
  const target = new URL(`ws://${upstream}/ws/close-first`);
  target.searchParams.set("id", id);
  for (const name of ["code", "reason"]) {
    if (url.searchParams.has(name)) target.searchParams.set(name, url.searchParams.get(name));
  }
  const reply = url.searchParams.get("reply");
  const ws = new WebSocket(target);
  const event = await new Promise((resolve) => {
    ws.addEventListener("close", (close) => {
      const seen = [close.code, close.reason, ws.readyState];
      if (reply === "now") ws.close(4052, "worker replies");
      if (reply === "send") {
        ws.send("half-open message");
        ws.close(4054, "after a message");
      }
      if (reply === "no-code") ws.close();
      resolve(seen);
    });
  });
  if (reply === "none") return Response.json({ event });
  return Response.json({ event, log: await log() });
}
