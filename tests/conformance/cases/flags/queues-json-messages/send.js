// A queue message's default content type: `json` under queues_json_messages
// (on from 2024-03-18), otherwise `v8`. A BigInt body has a V8 encoding and no
// JSON one, so only a `v8` send accepts it. (celld's refusal is an Error
// where workerd's is a TypeError, so only the outcome is compared.)
async function attempt(fn) {
  try {
    await fn();
    return "sent";
  } catch {
    return "refused";
  }
}

export async function report(env) {
  return Response.json({
    bigint: await attempt(() => env.QUEUE.send(10n)),
    bigintAsV8: await attempt(() => env.QUEUE.send(10n, { contentType: "v8" })),
    object: await attempt(() => env.QUEUE.send({ a: [1, "b"] })),
    reported: Cloudflare.compatibilityFlags.queues_json_messages,
  });
}
