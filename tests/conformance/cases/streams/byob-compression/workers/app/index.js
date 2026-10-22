import { checkAll, equal, parts, payload } from "#byob";

const compress = (format) => () =>
  parts().pipeThrough(new CompressionStream(format));

// Compressed bytes differ between zlib builds, so a compressed read is right
// when it inflates to the payload.
const inflates = (format) => async (bytes) => {
  const inflated = new Uint8Array(await new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)),
  ).arrayBuffer());
  return equal(inflated, payload());
};

export default {
  async fetch(request) {
    const out = {};
    for (const format of ["gzip", "deflate", "deflate-raw"]) {
      out[format] = {
        compress: await checkAll(compress(format), inflates(format)),
        decompress: await checkAll(
          () => compress(format)().pipeThrough(new DecompressionStream(format))),
      };
    }
    return Response.json(out);
  },
};
