// Plain data shaped like celld's markers beside an AbortSignal, which celld
// lifts with it (plan 1.53), in a call's params and result, within the
// isolate and to another Worker's isolate. Each reports, for each forged
// value, "same" or what arrived instead, and that the signal arrived as one.
import { WorkerEntrypoint } from "cloudflare:workers";
import { compare, forged } from "#marker-shaped";

const isSignal = (value) => value instanceof AbortSignal;

export class Echo extends WorkerEntrypoint {
  probe(arg) {
    return { forged: compare(arg.forged), signal: isSignal(arg.signal) };
  }
  give() {
    return { signal: new AbortController().signal, forged: forged() };
  }
}

export default {
  async fetch(request, env, ctx) {
    const signal = () => new AbortController().signal;
    const given = await ctx.exports.Echo.give();
    return Response.json({
      params: await ctx.exports.Echo.probe({ signal: signal(), forged: forged() }),
      result: { forged: compare(given.forged), signal: isSignal(given.signal) },
      service: await env.OTHER.probe({ signal: signal(), forged: forged() }),
    });
  },
};
