// examples/counter, plus `sinceStart`: an in-memory count of the requests this
// object instance has served. A restart must reset it while `n`, which is in
// storage, carries on.
export class Counter {
  constructor(state, env) {
    this.state = state;
    this.sinceStart = 0;
  }
  async fetch(request) {
    let n = (await this.state.storage.get("n")) ?? 0;
    n++;
    await this.state.storage.put("n", n);
    this.sinceStart++;
    return Response.json({ n, sinceStart: this.sinceStart, url: request.url });
  }
}
export default {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("name") ?? "default";
    const id = env.COUNTER.idFromName(name);
    return env.COUNTER.get(id).fetch(request);
  },
};
