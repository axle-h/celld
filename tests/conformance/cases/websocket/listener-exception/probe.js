// A WebSocket whose 'message' listener throws: workerd errors it out (an
// 'error' event with the exception, CLOSED, and the peer sees 1006), after
// every listener ran and the exception was reported under
// spec_compliant_dispatch_exceptions, or at once without it. celld runs the
// listeners as the flag says but does not error the socket out (plan 1.64).
const errors = [];
addEventListener("error", (event) => {
  errors.push(event.message);
});

async function run(action) {
  const log = [];
  errors.length = 0;
  const returned = await action(log);
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { log, returned, errors: errors.splice(0) };
}

export default {
  async fetch() {
    return Response.json({
      websocket: await run(async (log) => {
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();
        client.accept();
        server.addEventListener("message", (event) => {
          log.push(`first ${event.data}`);
          throw new Error("socket failed");
        });
        server.addEventListener("message", (event) => log.push(`second ${event.data}`));
        server.addEventListener("error", (event) => log.push(`error ${event.message}`));
        server.addEventListener("close", (event) => log.push(`close ${event.code}`));
        client.addEventListener("close", (event) => log.push(`client close ${event.code}`));
        client.send("one");
        await new Promise((resolve) => setTimeout(resolve, 20));
        try {
          client.send("two");
        } catch (error) {
          log.push(`send threw ${error.message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        return server.readyState;
      }),
      reported: Cloudflare.compatibilityFlags.spec_compliant_dispatch_exceptions ?? null,
    });
  },
};
