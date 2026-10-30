// What a DecompressionStream reports for bad input, under
// strict_compression_checks: bytes after the end of the compressed data
// (a second gzip member is such), data cut short, data that is not
// compressed, and a header whose FHCRC is wrong. The write that brings the
// bytes and the read each fail.
const gzip = async (text) => new Uint8Array(await new Response(
  new Response(text).body.pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

const attempt = async (promise) => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

const decode = async (bytes) => {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const read = attempt(new Response(ds.readable).text());
  const write = await attempt(writer.write(bytes));
  if (write === "ok") await attempt(writer.close());
  return { write, read: await read };
};

// A gzip member with FHCRC whose CRC is wrong.
const badHeaderCrc = (data) => {
  const out = new Uint8Array(data.length + 2);
  out.set(data.subarray(0, 10));
  out[3] |= 0x02;
  out.set([0, 0], 10);
  out.set(data.subarray(10), 12);
  return out;
};

export default {
  async fetch() {
    const data = await gzip("hello world");
    const both = new Uint8Array(data.length * 2);
    both.set(data);
    both.set(data, data.length);
    return Response.json({
      trailing: await decode(new Uint8Array([...data, 1, 2, 3])),
      members: await decode(both),
      truncated: await decode(data.subarray(0, data.length - 4)),
      bad: await decode(new TextEncoder().encode("not gzip at all")),
      badHeaderCrc: await decode(badHeaderCrc(data)),
    });
  },
};
