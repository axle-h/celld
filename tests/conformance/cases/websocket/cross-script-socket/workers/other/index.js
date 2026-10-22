// The other script: it can only dial, and a Response takes no socket it
// cannot hold.
const refused = (attempt) => {
  try {
    attempt();
    return "allowed";
  } catch (error) {
    return error.name;
  }
};

export default {
  fetch() {
    const outcome = {};
    for (let id = 1; id <= 3; id++) outcome[`id${id}`] = refused(() => new WebSocket(id));
    outcome.targetInit = refused(() => new Response(null, {
      status: 101,
      __wsTarget: { id: 1, scope: "room" },
    }));
    outcome.fakeSocket = refused(() => new Response(null, {
      status: 101,
      webSocket: { accept() {}, send() {} },
    }));
    return Response.json(outcome);
  },
};
