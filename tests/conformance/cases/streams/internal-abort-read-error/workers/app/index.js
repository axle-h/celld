// The readable side of an internal stream whose writer aborted: workerd
// rejects a read with "Network connection lost." whatever the abort's
// reason.
const read = async (make, reason) => {
  const { writable, readable } = make();
  const writer = writable.getWriter();
  writer.write(new Uint8Array([1])).catch(() => {});
  await writer.abort(reason).catch(() => {});
  return readable.getReader().read().then(() => "read", (error) => `${error.name}: ${error.message}`);
};

export default {
  async fetch() {
    return Response.json({
      identity: await read(() => new IdentityTransformStream(), new Error("why")),
      fixed: await read(() => new FixedLengthStream(10), "why"),
      idle: await read(() => {
        const stream = new IdentityTransformStream();
        return stream;
      }, new TypeError("why")),
    });
  },
};
