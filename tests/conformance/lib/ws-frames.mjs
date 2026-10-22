// The WebSocket framing (RFC 6455) of the runner's own raw sockets: the
// upstream server's WebSocket routes, and the `ws` steps that need control of
// the connection Node's WebSocket hides. Only what those use: payloads under
// 64 KiB and no extensions. Fragments are reported, not reassembled: see
// `isFragment`.

import { createHash, randomBytes } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The `Sec-WebSocket-Accept` value for a `Sec-WebSocket-Key`. */
export const acceptKey = (key) => createHash("sha1").update(key + GUID).digest("base64");

export const CONTINUATION = 0x0;
export const TEXT = 0x1;
export const BINARY = 0x2;
export const CLOSE = 0x8;
export const PING = 0x9;
export const PONG = 0xa;

/** One frame, masked when `masked` (a client's frames must be). */
export function encodeFrame(opcode, payload, masked) {
  const body = Buffer.from(payload);
  if (body.length > 0xffff) throw new Error("frame too large for the runner's codec");
  const length = body.length < 126 ? [body.length] : [126, body.length >> 8, body.length & 0xff];
  const header = Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | length[0], ...length.slice(1)]);
  if (!masked) return Buffer.concat([header, body]);
  const mask = randomBytes(4);
  const out = Buffer.from(body);
  for (let i = 0; i < out.length; i++) out[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, out]);
}

/** A Close frame's payload: empty without a code, as a Close with no status. */
export function closePayload(code, reason = "") {
  if (code === undefined || code === null) return Buffer.alloc(0);
  const reasonBytes = Buffer.from(reason);
  const out = Buffer.alloc(2 + reasonBytes.length);
  out.writeUInt16BE(code, 0);
  reasonBytes.copy(out, 2);
  return out;
}

/** What a received Close says: `{code, reason}`, code 1005 when empty. */
export function readClose(payload) {
  if (payload.length < 2) return { code: 1005, reason: "" };
  return { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString() };
}

/** Whether `frame` is part of a fragmented message, which nothing here reassembles. */
export const isFragment = (frame) => !frame.fin || frame.opcode === CONTINUATION;

/**
 * Feed bytes in, take whole frames out: `push(chunk)` returns the frames
 * the bytes completed, each `{fin, opcode, payload}`, unmasked.
 */
export function frameReader() {
  let buffered = Buffer.alloc(0);
  return {
    push(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      const frames = [];
      for (;;) {
        if (buffered.length < 2) break;
        const fin = (buffered[0] & 0x80) !== 0;
        const opcode = buffered[0] & 0x0f;
        const masked = (buffered[1] & 0x80) !== 0;
        let length = buffered[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffered.length < 4) break;
          length = buffered.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          throw new Error("frame too large for the runner's codec");
        }
        const maskOffset = offset;
        if (masked) offset += 4;
        if (buffered.length < offset + length) break;
        const payload = Buffer.from(buffered.subarray(offset, offset + length));
        if (masked) {
          for (let i = 0; i < payload.length; i++) payload[i] ^= buffered[maskOffset + (i % 4)];
        }
        frames.push({ fin, opcode, payload });
        buffered = buffered.subarray(offset + length);
      }
      return frames;
    },
  };
}
