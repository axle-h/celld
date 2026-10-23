const MIB = 2 ** 20;

// Reads a stream to its end without keeping it: the bytes read, and the error
// that ended it.
const count = async (stream) => {
  const reader = stream.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { bytes, error: null };
      bytes += value.byteLength;
    }
  } catch (error) {
    return { bytes, error: `${error.name}: ${error.message}` };
  }
};

// How far a read got depends on when the limit was reached, so only whether
// it read anything is recorded.
const drain = async (stream) => {
  const { bytes, error } = await count(stream);
  return error === null ? { mb: bytes / MIB, error } : { read: bytes > 0, error };
};

// Reads `mb` MiB of a stream and keeps it locked.
const readSome = async (stream, mb) => {
  const reader = stream.getReader();
  let bytes = 0;
  while (bytes < mb * MIB) bytes += (await reader.read()).value.byteLength;
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const fetchBody = (mb) => env.BACK.fetch(`http://back/?mb=${mb}`);
    if (url.pathname === "/shared") {
      // All of an isolate's tees together hold at most half its 128 MiB
      // budget. Alone, a tee's read branch gets past 48 MiB before the limit.
      const alone = await fetchBody(400);
      const aloneClone = alone.clone();
      const lone = await count(alone.body);
      // Cancelling the clone gives back what it held.
      await aloneClone.body.cancel();
      // With 40 MiB already held by another tee's unread clone, the second
      // stops well before that.
      const held = await fetchBody(400);
      const heldClone = held.clone();
      await readSome(held.body, 40);
      const second = await fetchBody(400);
      const secondClone = second.clone();
      const shared = await count(second.body);
      await heldClone.body.cancel();
      await secondClone.body.cancel();
      return Response.json({
        alonePast48MiB: lone.bytes > 48 * MIB,
        sharedUnder32MiB: shared.bytes < 32 * MIB,
        errors: [lone.error, shared.error],
      });
    }
    const response = await fetchBody(url.searchParams.get("mb"));
    let first;
    let second;
    if (url.pathname === "/clone") {
      second = response.clone().body;
      first = response.body;
    } else {
      [first, second] = response.body.tee();
    }
    return Response.json({ first: await drain(first), second: await drain(second) });
  },
};
