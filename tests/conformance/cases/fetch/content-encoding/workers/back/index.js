const gzip = async (text) => new Uint8Array(await new Response(
  new Response(text).body.pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

// A gzip member whose header carries FNAME `name` and, when `headerCrc`
// is given, FHCRC: the right CRC16 of the header, or a wrong one.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const withHeader = (plain, name, headerCrc) => {
  const header = [...plain.subarray(0, 10)];
  header[3] = 0x08 | (headerCrc === undefined ? 0 : 0x02);
  const head = new Uint8Array(header.length + name.length + 1);
  head.set(header);
  head.set(name, header.length);
  const crc = headerCrc === undefined ? [] : (() => {
    const sum = (crc32(head) & 0xffff) ^ (headerCrc ? 0 : 1);
    return [sum & 0xff, sum >> 8];
  })();
  const body = new Uint8Array(head.length + crc.length + plain.length - 10);
  body.set(head);
  body.set(crc, head.length);
  body.set(plain.subarray(10), head.length + crc.length);
  return body;
};

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    // Two gzip members, which a reader decodes one after the other.
    if (path === "/members") {
      const first = await gzip("hello\n");
      const second = await gzip("world\n");
      const body = new Uint8Array(first.length + second.length);
      body.set(first);
      body.set(second, first.length);
      return new Response(body, { headers: { "content-encoding": "gzip" }, encodeBody: "manual" });
    }
    // A member whose FNAME is 1 MiB long, which a reader streams past.
    if (path === "/long-name") {
      const body = withHeader(await gzip("after a long name"), new Uint8Array(1024 * 1024).fill(110));
      return new Response(body, { headers: { "content-encoding": "gzip" }, encodeBody: "manual" });
    }
    // A member with FHCRC, right or wrong, which a reader checks.
    if (path === "/header-crc" || path === "/bad-header-crc") {
      const body = withHeader(await gzip("header checked"), new Uint8Array([110]), path === "/header-crc");
      return new Response(body, { headers: { "content-encoding": "gzip" }, encodeBody: "manual" });
    }
    // A gzip member followed by bytes that are not another member.
    if (path === "/garbage") {
      const member = await gzip("before garbage");
      const body = new Uint8Array(member.length + 7);
      body.set(member);
      body.set(new TextEncoder().encode("garbage"), member.length);
      return new Response(body, { headers: { "content-encoding": "gzip" }, encodeBody: "manual" });
    }
    // A gzip stream cut short of its trailer.
    if (path === "/truncated") {
      const body = await gzip("cut short");
      return new Response(body.subarray(0, body.length - 4),
        { headers: { "content-encoding": "gzip" }, encodeBody: "manual" });
    }
    if (path === "/raw") {
      const body = new Response("from back raw").body.pipeThrough(new CompressionStream("gzip"));
      return new Response(body, { headers: { "content-encoding": "gzip" }, encodeBody: "manual" });
    }
    return new Response("from back", { headers: { "content-encoding": "gzip" } });
  },
};
