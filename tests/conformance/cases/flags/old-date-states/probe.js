// The behaviour before four flags celld once always behaved as on:
// strip_bom_in_read_all_text, text_decoder_replace_surrogates,
// websocket_close_reason_byte_limit and
// writable_stream_spec_compliant_writer.
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const outcome = (promise) => promise.then(() => "resolved", (error) => `rejected ${error.name}: ${error.message}`);

export default {
  async fetch() {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
    const flags = Cloudflare.compatibilityFlags;
    // A lone surrogate, little-endian, between two letters.
    const lone = new Uint8Array([0x61, 0x00, 0x00, 0xd8, 0x62, 0x00]);
    const decoded = (options) => {
      try {
        return [...new TextDecoder("utf-16le", options).decode(lone)].map((c) => c.charCodeAt(0));
      } catch (error) {
        return `${error.name}: ${error.message}`;
      }
    };
    const close = (reason) => {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      try {
        server.close(1000, reason);
        return "closed";
      } catch (error) {
        return `${error.name}: ${error.message}`;
      }
    };
    // A writer's ready promise while the sink's start is pending, and after
    // the writer is released.
    let started;
    const pending = new WritableStream({ start: () => new Promise((resolve) => { started = resolve; }) });
    const writer = pending.getWriter();
    const log = [];
    writer.ready.then(() => log.push("ready resolved"), () => log.push("ready rejected"));
    await settle();
    log.push("before start");
    started();
    await settle();
    const released = new WritableStream().getWriter();
    await released.ready;
    const readyBefore = released.ready;
    released.releaseLock();
    const sized = new WritableStream({}, { size() { sizedWriter.releaseLock(); return 1; } });
    const sizedWriter = sized.getWriter();
    return Response.json({
      responseText: await new Response(bom).text(),
      requestText: await new Request("http://x/", { method: "POST", body: bom }).text(),
      // A Blob's text keeps it whatever the flag.
      blobText: await new Blob([bom]).text(),
      decoded: decoded(),
      decodedFatal: decoded({ fatal: true }),
      closeLong: close("x".repeat(124)),
      closeUtf8: close("é".repeat(62)),
      closeShort: close("x".repeat(123)),
      writerReady: log,
      releasedReady: [readyBefore === released.ready, await outcome(released.ready)],
      writeAfterSizeRelease: await outcome(sizedWriter.write("a")),
      reported: [flags.strip_bom_in_read_all_text ?? null, flags.text_decoder_replace_surrogates ?? null,
        flags.websocket_close_reason_byte_limit ?? null, flags.writable_stream_spec_compliant_writer ?? null],
    });
  },
};
