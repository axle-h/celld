// A named entrypoint and the default export, each echoing `this.ctx.props`
// over fetch and over RPC, or changing them in place (`mutate()`, and fetch
// to `/mutate`).
import { WorkerEntrypoint } from "cloudflare:workers";

// `undefined` does not survive JSON, so say what the value is as well.
const describe = (props) => ({ type: typeof props, props: props ?? null });

function mutate(props) {
  try {
    props.mutated = true;
    if (props.nested) props.nested.mutated = true;
    return { ok: true, ...describe(props) };
  } catch (error) {
    return { ok: false, error: error.name };
  }
}

const echo = (request, props) =>
  Response.json(new URL(request.url).pathname === "/mutate" ? mutate(props) : describe(props));

export class Named extends WorkerEntrypoint {
  fetch(request) {
    return echo(request, this.ctx.props);
  }
  props() {
    return describe(this.ctx.props);
  }
  mutate() {
    return mutate(this.ctx.props);
  }
}

export default class extends WorkerEntrypoint {
  fetch(request) {
    return echo(request, this.ctx.props);
  }
  props() {
    return describe(this.ctx.props);
  }
  mutate() {
    return mutate(this.ctx.props);
  }
}
