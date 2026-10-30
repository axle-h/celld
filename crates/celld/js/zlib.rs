// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! zlib: the synchronous `__zlib` op behind `node:zlib`, and the streaming
//! compression backend.
//!
//! `CompressionStream`, `DecompressionStream` and a Content-Encoding body
//! need output chunk by chunk, so a stream keeps a live flate2 writer and
//! codes its queued input in bounded steps as output is read. The one-shot
//! op has no such state and runs to completion.
use super::*;

/// workerd's `Z_MAX_CHUNK`: a synchronous call's input must be smaller and
/// its output no larger. It is also the default `maxOutputLength`, so an
/// inflate bomb stops at 128 MiB.
const Z_MAX_CHUNK: usize = 128 * 1024 * 1024;

/// workerd's `ZLIB_PERFORMANT_CHUNK_SIZE`: the step a synchronous call's
/// output buffer grows by.
const OUTPUT_CHUNK: usize = 40 * 1024;

/// The operating system byte zlib writes into a gzip header on Unix, as
/// workerd's gzip output carries it. flate2 writes 255 (unknown) by default.
const GZIP_OS_UNIX: u8 = 3;

/// workerd's text, which it throws as a RangeError.
const MEMORY_LIMIT: &str = "Memory limit exceeded";

/// Why a synchronous call failed. workerd throws a RangeError for the
/// memory limit and an Error for everything else.
#[derive(Debug)]
enum SyncFailure {
    MemoryLimit,
    Other(anyhow::Error),
}

impl From<std::io::Error> for SyncFailure {
    fn from(error: std::io::Error) -> Self {
        Self::Other(error.into())
    }
}

/// `__zlib(mode, view, level, maxOutputLength)` -> Uint8Array: one
/// synchronous `node:zlib` call. `node_zlib.js` has already converted and
/// range-checked the options, as workerd does; the checks here keep the op
/// bounded whatever its caller passes.
pub(super) fn op_zlib(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let mode = args.get(0).to_rust_string_lossy(scope);
    let bytes = view_bytes(args.get(1)).unwrap_or_default();
    let level = args.get(2).int32_value(scope).unwrap_or(i32::MIN);
    let max_output = args.get(3).number_value(scope).unwrap_or(0.0);
    match zlib_sync(&mode, &bytes, level, max_output) {
        Ok(bytes) => rv.set(bytes_value(scope, bytes)),
        Err(failure) => {
            let exception = match failure {
                SyncFailure::MemoryLimit => {
                    let message = v8::String::new(scope, MEMORY_LIMIT).unwrap();
                    v8::Exception::range_error(scope, message)
                }
                SyncFailure::Other(error) => {
                    let message = v8::String::new(scope, &error.to_string()).unwrap();
                    v8::Exception::error(scope, message)
                }
            };
            scope.throw_exception(exception);
        }
    }
}

fn zlib_sync(
    mode: &str,
    input: &[u8],
    level: i32,
    max_output: f64,
) -> Result<Vec<u8>, SyncFailure> {
    use flate2::read;
    if input.len() >= Z_MAX_CHUNK {
        return Err(SyncFailure::MemoryLimit);
    }
    if !(1.0..=Z_MAX_CHUNK as f64).contains(&max_output) {
        return Err(SyncFailure::Other(anyhow!("maxOutputLength out of range")));
    }
    let max_output = max_output as usize;
    let level = match level {
        -1 => flate2::Compression::default(),
        0..=9 => flate2::Compression::new(level as u32),
        _ => return Err(SyncFailure::Other(anyhow!("level out of range"))),
    };
    match mode {
        "gzip" => read_bounded(
            flate2::GzBuilder::new()
                .operating_system(GZIP_OS_UNIX)
                .read(input, level),
            max_output,
        ),
        "gunzip" => read_bounded(Gunzip::new(input), max_output),
        "deflate" => read_bounded(read::ZlibEncoder::new(input, level), max_output),
        "inflate" => read_bounded(Inflate::new(input, true), max_output),
        "deflateRaw" => read_bounded(read::DeflateEncoder::new(input, level), max_output),
        "inflateRaw" => read_bounded(Inflate::new(input, false), max_output),
        _ => Err(SyncFailure::Other(anyhow!("unsupported zlib operation"))),
    }
}

/// The most gzip members one call decodes. Each member costs a header parse
/// and a decoder reset, and an input of empty members (20 bytes each) would
/// otherwise make one synchronous call, which the CPU watchdog cannot
/// interrupt, decode millions of them. Real multi-member input stays far
/// below this: BGZF, the common producer, writes one member per 64 KiB of
/// data or less, so the 128 MiB default output limit is 2,048 of its members.
/// At this cap the worst case, all empty members, takes about 120 ms.
const MAX_GZIP_MEMBERS: usize = 65_536;

fn unexpected_end() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "unexpected end of file")
}

/// zlib's message for a stream it cannot decode.
fn invalid(message: &'static str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message)
}

/// Decode from `input` into `out` until some output is produced or the
/// deflate stream ends, advancing `input` past what was consumed. Returns
/// the bytes written and whether the stream ended. Input that runs out
/// before the stream ends fails, as zlib does; flate2's readers end quietly
/// there instead.
fn inflate_step(
    state: &mut flate2::Decompress,
    input: &mut &[u8],
    out: &mut [u8],
) -> std::io::Result<(usize, bool)> {
    loop {
        let (read, written) = (state.total_in(), state.total_out());
        let status = state
            .decompress(input, out, flate2::FlushDecompress::None)
            // miniz_oxide does not say what went wrong, so this is
            // workerd's fallback message.
            .map_err(|_| invalid("Zlib error"))?;
        let consumed = (state.total_in() - read) as usize;
        let produced = (state.total_out() - written) as usize;
        *input = &input[consumed..];
        match status {
            flate2::Status::StreamEnd => return Ok((produced, true)),
            _ if produced > 0 => return Ok((produced, false)),
            _ if consumed == 0 => return Err(unexpected_end()),
            _ => {}
        }
    }
}

/// A zlib or raw deflate stream decoded from a slice. Bytes after the
/// stream's end are ignored, as in workerd. A zlib stream's header and
/// Adler-32 trailer are checked here rather than by miniz_oxide, so their
/// failures carry zlib's messages.
struct Inflate<'a> {
    input: &'a [u8],
    state: flate2::Decompress,
    /// The running Adler-32 of the output, for a zlib stream.
    adler: Option<Adler32>,
    header_checked: bool,
    ended: bool,
}

impl<'a> Inflate<'a> {
    fn new(input: &'a [u8], zlib_header: bool) -> Self {
        Self {
            input,
            state: flate2::Decompress::new(false),
            adler: zlib_header.then(Adler32::default),
            header_checked: !zlib_header,
            ended: false,
        }
    }
}

/// RFC 1950's Adler-32 checksum.
struct Adler32 {
    a: u32,
    b: u32,
}

impl Default for Adler32 {
    fn default() -> Self {
        Self { a: 1, b: 0 }
    }
}

impl Adler32 {
    fn update(&mut self, bytes: &[u8]) {
        const MOD: u32 = 65_521;
        // The most bytes before `b` can overflow a u32 (zlib's NMAX).
        for chunk in bytes.chunks(5_552) {
            for &byte in chunk {
                self.a += u32::from(byte);
                self.b += self.a;
            }
            self.a %= MOD;
            self.b %= MOD;
        }
    }

    fn sum(&self) -> u32 {
        self.b << 16 | self.a
    }
}

/// zlib's checks of a zlib header, in its order and with its messages.
fn check_zlib_header(input: &[u8]) -> std::io::Result<()> {
    let [cmf, flg, ..] = *input else {
        return Err(unexpected_end());
    };
    if (u16::from(cmf) << 8 | u16::from(flg)) % 31 != 0 {
        return Err(invalid("incorrect header check"));
    }
    if cmf & 0x0f != 8 {
        return Err(invalid("unknown compression method"));
    }
    if (cmf >> 4) + 8 > 15 {
        return Err(invalid("invalid window size"));
    }
    if flg & 0x20 != 0 {
        return Err(invalid("Missing dictionary"));
    }
    Ok(())
}

impl std::io::Read for Inflate<'_> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.ended || out.is_empty() {
            return Ok(0);
        }
        if !self.header_checked {
            check_zlib_header(self.input)?;
            self.input = &self.input[2..];
            self.header_checked = true;
        }
        let (produced, ended) = inflate_step(&mut self.state, &mut self.input, out)?;
        if let Some(adler) = &mut self.adler {
            adler.update(&out[..produced]);
            if ended {
                let trailer = self.input.get(..4).ok_or_else(unexpected_end)?;
                if u32::from_be_bytes(trailer.try_into().unwrap()) != adler.sum() {
                    return Err(invalid("incorrect data check"));
                }
            }
        }
        self.ended = ended;
        Ok(produced)
    }
}

/// Parse one gzip member header (RFC 1952) with zlib's checks and messages,
/// returning the input after it.
fn gzip_header(input: &[u8]) -> std::io::Result<&[u8]> {
    const FHCRC: u8 = 0x02;
    const FEXTRA: u8 = 0x04;
    const FNAME: u8 = 0x08;
    const FCOMMENT: u8 = 0x10;
    let Some(magic) = input.get(..2) else {
        return Err(unexpected_end());
    };
    if magic != [0x1f, 0x8b] {
        return Err(invalid("incorrect header check"));
    }
    let Some(fixed) = input.get(..10) else {
        return Err(unexpected_end());
    };
    if fixed[2] != 8 {
        return Err(invalid("unknown compression method"));
    }
    let flags = fixed[3];
    if flags & 0xe0 != 0 {
        return Err(invalid("unknown header flags set"));
    }
    let mut at = 10;
    if flags & FEXTRA != 0 {
        let length = input.get(at..at + 2).ok_or_else(unexpected_end)?;
        at += 2 + usize::from(u16::from_le_bytes([length[0], length[1]]));
    }
    for flag in [FNAME, FCOMMENT] {
        if flags & flag != 0 {
            let field = input.get(at..).ok_or_else(unexpected_end)?;
            let end = field
                .iter()
                .position(|&byte| byte == 0)
                .ok_or_else(unexpected_end)?;
            at += end + 1;
        }
    }
    if flags & FHCRC != 0 {
        let stored = input.get(at..at + 2).ok_or_else(unexpected_end)?;
        let mut crc = flate2::Crc::new();
        crc.update(&input[..at]);
        if crc.sum() as u16 != u16::from_le_bytes([stored[0], stored[1]]) {
            return Err(invalid("header crc mismatch"));
        }
        at += 2;
    }
    input.get(at..).ok_or_else(unexpected_end)
}

/// A gzip stream decoded from a slice, member after member, as workerd's
/// gunzip does: after a member ends, any remaining input that does not start
/// with a zero byte (padding) must be another member. One raw inflater and
/// one CRC are reset for each member, and at most [`MAX_GZIP_MEMBERS`] are
/// decoded.
struct Gunzip<'a> {
    input: &'a [u8],
    state: flate2::Decompress,
    crc: flate2::Crc,
    members: usize,
    in_member: bool,
}

impl<'a> Gunzip<'a> {
    fn new(input: &'a [u8]) -> Self {
        Self {
            input,
            state: flate2::Decompress::new(false),
            crc: flate2::Crc::new(),
            members: 0,
            in_member: false,
        }
    }
}

impl std::io::Read for Gunzip<'_> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        loop {
            if !self.in_member {
                if self.members > 0 && matches!(self.input.first(), None | Some(0)) {
                    return Ok(0);
                }
                if self.members == MAX_GZIP_MEMBERS {
                    return Err(std::io::Error::other(format!(
                        "gzip input has more than {MAX_GZIP_MEMBERS} members, which celld does \
                         not decode in one call"
                    )));
                }
                self.input = gzip_header(self.input)?;
                self.state.reset(false);
                self.crc.reset();
                self.members += 1;
                self.in_member = true;
            }
            let (produced, ended) = inflate_step(&mut self.state, &mut self.input, out)?;
            self.crc.update(&out[..produced]);
            if ended {
                let trailer = self.input.get(..8).ok_or_else(unexpected_end)?;
                let (crc, size) = trailer.split_at(4);
                if u32::from_le_bytes(crc.try_into().unwrap()) != self.crc.sum() {
                    return Err(invalid("incorrect data check"));
                }
                if u32::from_le_bytes(size.try_into().unwrap()) != self.crc.amount() {
                    return Err(invalid("incorrect length check"));
                }
                self.input = &self.input[8..];
                self.in_member = false;
            }
            if produced > 0 {
                return Ok(produced);
            }
        }
    }
}

/// Read `reader` to its end into a buffer that grows as workerd's
/// `GrowableBuffer` does for a synchronous call (`syncProcessBuffer` in
/// src/workerd/api/node/zlib-util.c++): it starts at one chunk, or at `max`
/// if that is smaller. Each time it fills, it grows to at least one more
/// chunk, doubling, but never past `max`. A full buffer that cannot take a
/// whole chunk more fails, even when the rest of the output would fit, and a
/// full buffer at `max` succeeds only if the stream ends there. So the
/// outputs that fit are the ones that fit in workerd, and memory never
/// exceeds `max`.
fn read_bounded(mut reader: impl std::io::Read, max: usize) -> Result<Vec<u8>, SyncFailure> {
    let chunk = OUTPUT_CHUNK.min(max);
    let mut out = vec![0; chunk];
    let mut len = 0;
    loop {
        while len < out.len() {
            match reader.read(&mut out[len..])? {
                0 => {
                    // The buffer moves into V8, which counts only its
                    // length, so give back the unused capacity.
                    out.truncate(len);
                    out.shrink_to_fit();
                    return Ok(out);
                }
                n => len += n,
            }
        }
        if len >= max {
            return match reader.read(&mut [0])? {
                0 => Ok(out),
                _ => Err(SyncFailure::MemoryLimit),
            };
        }
        let needed = len + chunk;
        if needed > max {
            return Err(SyncFailure::MemoryLimit);
        }
        let capacity = max.min(needed.max(len * 2));
        out.reserve_exact(capacity - len);
        out.resize(capacity, 0);
    }
}

/// The most output one read hands back, and the output a stream decodes
/// ahead of its reader.
const STREAM_CHUNK: usize = 64 * 1024;

/// The output a stream decodes eagerly as input arrives, before it waits for
/// its reader: enough that a stream read after its writes finish (as in
/// workerd, whose writes never wait for a read) errors on the write that
/// brought the bad bytes, yet an inflate bomb stops here instead of taking
/// the heap.
const STREAM_AHEAD: usize = 1024 * 1024;

/// The input one encoder write takes; an encoder's output is smaller.
const ENCODE_SLICE: usize = 64 * 1024;

/// What an encoder holds before it hands out output, matching workerd,
/// whose suite reads a small message back as one chunk.
const ENCODER_HELD: usize = 32 * 1024;

/// One flate2 encoder over a `Vec` sink, which [`ZlibStream`] empties into
/// its output after every write.
enum Encoder {
    Gzip(flate2::write::GzEncoder<Vec<u8>>),
    Zlib(flate2::write::ZlibEncoder<Vec<u8>>),
    Raw(flate2::write::DeflateEncoder<Vec<u8>>),
}

macro_rules! encoder_each {
    ($encoder:expr, $w:ident => $body:expr) => {
        match $encoder {
            Encoder::Gzip($w) => $body,
            Encoder::Zlib($w) => $body,
            Encoder::Raw($w) => $body,
        }
    };
}

/// Where a gzip header is (RFC 1952 2.3): its fixed ten bytes, then, as
/// its flags say, FEXTRA's length and data, FNAME and FCOMMENT (each up to
/// a NUL) and FHCRC.
#[derive(Clone, Copy, PartialEq, Eq)]
enum HeaderPart {
    Fixed,
    ExtraLength,
    Extra(usize),
    Name,
    Comment,
    Crc,
}

const FHCRC: u8 = 0x02;
const FEXTRA: u8 = 0x04;
const FNAME: u8 = 0x08;
const FCOMMENT: u8 = 0x10;

/// Where a decoder is in its format: gzip's header, its deflate data and
/// its trailer, or the end.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Inflating {
    Header(HeaderPart),
    Data,
    Trailer,
    End,
}

/// A decoder over flate2's `Decompress`, which inflates into a fixed
/// [`STREAM_CHUNK`] buffer, so a step's output is bounded however far the
/// input expands. gzip's framing (RFC 1952) is read here, as the miniz
/// backend inflates zlib and raw deflate only: the header as a stream, a
/// whole slice at a time, holding at most its ten fixed bytes, whatever
/// the length of its optional fields, whose CRC FHCRC checks, as zlib does.
struct Inflater {
    inflate: flate2::Decompress,
    gzip: bool,
    /// Every gzip member is read, as kj's GzipInputStream reads a body.
    members: bool,
    state: Inflating,
    /// The fixed part of a gzip header, FEXTRA's length, FHCRC or the
    /// trailer, read so far.
    frame: [u8; 10],
    frame_len: usize,
    /// The header's flags, and the CRC of its bytes so far.
    flags: u8,
    header_crc: flate2::Crc,
    /// The CRC of a member's data.
    crc: flate2::Crc,
    /// Whether a whole gzip member was read.
    member_read: bool,
    buffer: Box<[u8]>,
}

/// Why a decoder stopped: bad data, or bytes after the end of its data.
enum InflateError {
    Data,
    Trailing,
}

impl Inflater {
    fn new(format: &str) -> Option<Inflater> {
        let (gzip, members, zlib) = match format {
            "gzip" => (true, false, false),
            "gzip-body" => (true, true, false),
            "deflate" => (false, false, true),
            "deflate-raw" => (false, false, false),
            _ => return None,
        };
        Some(Inflater {
            inflate: flate2::Decompress::new(zlib),
            gzip,
            members,
            state: if gzip {
                Inflating::Header(HeaderPart::Fixed)
            } else {
                Inflating::Data
            },
            frame: [0; 10],
            frame_len: 0,
            flags: 0,
            header_crc: flate2::Crc::new(),
            crc: flate2::Crc::new(),
            member_read: false,
            buffer: vec![0; STREAM_CHUNK].into_boxed_slice(),
        })
    }

    /// Copies up to `want` bytes of `rest` into `frame`; true once it holds
    /// `want`.
    fn fill(&mut self, rest: &[u8], want: usize, taken: &mut usize) -> bool {
        let more = (want - self.frame_len).min(rest.len());
        self.frame[self.frame_len..self.frame_len + more].copy_from_slice(&rest[..more]);
        self.frame_len += more;
        *taken += more;
        self.frame_len == want
    }

    /// The header part after `part`, as the flags say, or the data.
    fn after(&mut self, part: HeaderPart) -> Inflating {
        let order = [
            (HeaderPart::ExtraLength, FEXTRA),
            (HeaderPart::Name, FNAME),
            (HeaderPart::Comment, FCOMMENT),
            (HeaderPart::Crc, FHCRC),
        ];
        let start = match part {
            HeaderPart::Fixed => 0,
            HeaderPart::ExtraLength | HeaderPart::Extra(_) => 1,
            HeaderPart::Name => 2,
            HeaderPart::Comment => 3,
            HeaderPart::Crc => 4,
        };
        self.frame_len = 0;
        for (next, flag) in order.iter().skip(start) {
            if self.flags & flag != 0 {
                return Inflating::Header(*next);
            }
        }
        self.inflate.reset(false);
        self.crc.reset();
        Inflating::Data
    }

    /// Reads header bytes from `rest`, returning how many it took; the
    /// skipped fields count only toward the header's CRC.
    fn header(&mut self, part: HeaderPart, rest: &[u8]) -> Result<usize, InflateError> {
        let mut taken = 0;
        match part {
            HeaderPart::Fixed => {
                const MAGIC: [u8; 3] = [0x1f, 0x8b, 8];
                let start = self.frame_len;
                let done = self.fill(rest, 10, &mut taken);
                let seen = self.frame_len.min(3);
                if start < seen && self.frame[start..seen] != MAGIC[start..seen] {
                    return Err(InflateError::Data);
                }
                if done {
                    self.flags = self.frame[3];
                    if self.flags & 0xe0 != 0 {
                        return Err(InflateError::Data);
                    }
                    self.header_crc.reset();
                    self.header_crc.update(&self.frame[..10]);
                    self.state = self.after(part);
                }
            }
            HeaderPart::ExtraLength => {
                if self.fill(rest, 2, &mut taken) {
                    self.header_crc.update(&self.frame[..2]);
                    let length = u16::from_le_bytes([self.frame[0], self.frame[1]]) as usize;
                    self.frame_len = 0;
                    self.state = if length == 0 {
                        self.after(HeaderPart::Extra(0))
                    } else {
                        Inflating::Header(HeaderPart::Extra(length))
                    };
                }
            }
            HeaderPart::Extra(left) => {
                taken = left.min(rest.len());
                self.header_crc.update(&rest[..taken]);
                self.state = if taken == left {
                    self.after(part)
                } else {
                    Inflating::Header(HeaderPart::Extra(left - taken))
                };
            }
            HeaderPart::Name | HeaderPart::Comment => match rest.iter().position(|b| *b == 0) {
                Some(zero) => {
                    taken = zero + 1;
                    self.header_crc.update(&rest[..taken]);
                    self.state = self.after(part);
                }
                None => {
                    taken = rest.len();
                    self.header_crc.update(rest);
                }
            },
            HeaderPart::Crc => {
                if self.fill(rest, 2, &mut taken) {
                    let expected = u16::from_le_bytes([self.frame[0], self.frame[1]]);
                    if expected != (self.header_crc.sum() & 0xffff) as u16 {
                        return Err(InflateError::Data);
                    }
                    self.state = self.after(part);
                }
            }
        }
        Ok(taken)
    }

    /// Inflates from `input` into `out` until `limit` of output is pending,
    /// the input runs out, or the data ends. Returns the input it took.
    fn step(
        &mut self,
        input: &[u8],
        out: &mut Vec<u8>,
        pending: usize,
        limit: usize,
    ) -> Result<usize, InflateError> {
        let mut taken = 0;
        let mut pending = pending;
        loop {
            let rest = &input[taken..];
            match self.state {
                Inflating::End => {
                    return if rest.is_empty() {
                        Ok(taken)
                    } else {
                        Err(InflateError::Trailing)
                    };
                }
                Inflating::Header(part) => {
                    if rest.is_empty() {
                        return Ok(taken);
                    }
                    taken += self.header(part, rest)?;
                }
                Inflating::Trailer => {
                    if !self.fill(rest, 8, &mut taken) {
                        return Ok(taken);
                    }
                    let crc = u32::from_le_bytes(self.frame[0..4].try_into().unwrap());
                    let size = u32::from_le_bytes(self.frame[4..8].try_into().unwrap());
                    if crc != self.crc.sum() || size != self.crc.amount() {
                        return Err(InflateError::Data);
                    }
                    self.frame_len = 0;
                    self.member_read = true;
                    self.state = if self.members {
                        Inflating::Header(HeaderPart::Fixed)
                    } else {
                        Inflating::End
                    };
                }
                Inflating::Data => {
                    if pending >= limit {
                        return Ok(taken);
                    }
                    let before_in = self.inflate.total_in();
                    let before_out = self.inflate.total_out();
                    let status = self
                        .inflate
                        .decompress(rest, &mut self.buffer, flate2::FlushDecompress::None)
                        .map_err(|_| InflateError::Data)?;
                    let consumed = (self.inflate.total_in() - before_in) as usize;
                    let produced = (self.inflate.total_out() - before_out) as usize;
                    taken += consumed;
                    if self.gzip {
                        self.crc.update(&self.buffer[..produced]);
                    }
                    out.extend_from_slice(&self.buffer[..produced]);
                    pending += produced;
                    if status == flate2::Status::StreamEnd {
                        self.frame_len = 0;
                        self.state = if self.gzip {
                            Inflating::Trailer
                        } else {
                            Inflating::End
                        };
                    } else if consumed == 0 && produced == 0 {
                        return Ok(taken);
                    }
                }
            }
        }
    }

    /// Whether the data ended where the input did: a complete stream, or,
    /// reading members, the end of a member.
    fn complete(&self) -> bool {
        self.state == Inflating::End
            || (self.members
                && self.member_read
                && self.state == Inflating::Header(HeaderPart::Fixed)
                && self.frame_len == 0)
    }
}

enum Engine {
    Encode(Option<Encoder>),
    Decode(Inflater),
}

/// One live `CompressionStream`, `DecompressionStream` or Content-Encoding
/// body coder. Input is queued as it is written and coded in bounded steps:
/// eagerly up to [`STREAM_AHEAD`] of output, then only as the reader takes
/// output, [`STREAM_CHUNK`] at a time. So memory stays bounded by the input
/// the Worker gave plus a few chunks, whatever the compression ratio.
struct ZlibStream {
    engine: Engine,
    decompress: bool,
    /// A Content-Encoding body (`gzip-body`): every gzip member is decoded,
    /// with workerd's (kj's GzipInputStream's) messages.
    body: bool,
    /// Input not yet coded, from `input_pos`.
    input: Vec<u8>,
    input_pos: usize,
    /// Output not yet read, from `output_pos`.
    output: Vec<u8>,
    output_pos: usize,
    /// The writable side has closed.
    ended: bool,
    /// The final output is in `output`.
    finished: bool,
}

impl ZlibStream {
    fn new(format: &str, decompress: bool) -> Option<ZlibStream> {
        use flate2::write as z;
        let level = flate2::Compression::default();
        let engine = if decompress {
            Engine::Decode(Inflater::new(format)?)
        } else {
            Engine::Encode(Some(match format {
                "gzip" => Encoder::Gzip(z::GzEncoder::new(Vec::new(), level)),
                "deflate" => Encoder::Zlib(z::ZlibEncoder::new(Vec::new(), level)),
                "deflate-raw" => Encoder::Raw(z::DeflateEncoder::new(Vec::new(), level)),
                _ => return None,
            }))
        };
        Some(ZlibStream {
            engine,
            decompress,
            body: format == "gzip-body",
            input: Vec::new(),
            input_pos: 0,
            output: Vec::new(),
            output_pos: 0,
            ended: false,
            finished: false,
        })
    }

    /// Workerd's message for bad input: DecompressionStream's canonical one,
    /// or for a body kj's "gzip decompression failed".
    fn failure(&self) -> &'static str {
        match (self.body, self.decompress) {
            (true, _) => "Gzip decompression failed.",
            (false, true) => "Decompression failed.",
            (false, false) => "Compression failed.",
        }
    }

    /// Workerd's message for a stream that ends before its compressed data.
    fn truncated(&self) -> &'static str {
        match (self.body, self.decompress) {
            (true, _) => "Gzip compressed stream ended prematurely.",
            (false, true) => "Called close() on a decompression stream with incomplete data",
            (false, false) => self.failure(),
        }
    }

    /// Output coded and not yet read.
    fn buffered(&self) -> usize {
        self.output.len() - self.output_pos
    }

    fn write(&mut self, bytes: &[u8]) -> Result<()> {
        if self.input_pos == self.input.len() {
            self.input.clear();
            self.input_pos = 0;
        }
        self.input.extend_from_slice(bytes);
        self.code(STREAM_AHEAD)
    }

    /// Codes queued input until `limit` of output is buffered or the input
    /// runs out. Bytes after the end of a decoder's data are trailing
    /// garbage, which workerd refuses (strict_compression_checks; for a
    /// body, kj's failure to read another member).
    fn code(&mut self, limit: usize) -> Result<()> {
        use std::io::Write;
        let failure = self.failure();
        let body = self.body;
        let pending = self.buffered();
        let input = &self.input[self.input_pos..];
        let taken = match &mut self.engine {
            Engine::Decode(inflater) => inflater
                .step(input, &mut self.output, pending, limit)
                .map_err(|error| match (error, body) {
                    (InflateError::Trailing, false) => {
                        anyhow!("Trailing bytes after end of compressed data")
                    }
                    _ => anyhow!(failure),
                })?,
            // A finished encoder has no input left to take.
            Engine::Encode(None) => 0,
            Engine::Encode(Some(encoder)) => {
                let mut taken = 0;
                while taken < input.len() && self.output.len() - self.output_pos < limit {
                    let end = input.len().min(taken + ENCODE_SLICE);
                    let n = encoder_each!(&mut *encoder, w => w.write(&input[taken..end]))
                        .map_err(|_| anyhow!(failure))?;
                    taken += n;
                    let sink = encoder_each!(&mut *encoder, w => w.get_mut());
                    self.output.extend_from_slice(sink);
                    sink.clear();
                }
                taken
            }
        };
        self.input_pos += taken;
        if self.input_pos == self.input.len() {
            self.input = Vec::new();
            self.input_pos = 0;
        }
        Ok(())
    }

    /// The next chunk of output, at most [`STREAM_CHUNK`]. Empty means none
    /// until more input is written, or, once ended, that the stream is done.
    fn read(&mut self) -> Result<Vec<u8>> {
        self.code(self.buffered() + STREAM_CHUNK)?;
        let drained = self.input_pos == self.input.len();
        if self.ended && drained && !self.finished {
            self.finish()?;
        }
        if !self.decompress && !self.finished && self.buffered() < ENCODER_HELD {
            return Ok(Vec::new());
        }
        Ok(self.take(STREAM_CHUNK))
    }

    /// Ends the stream once its input is coded: an encoder's final output,
    /// and a decoder's check that its data ended there.
    fn finish(&mut self) -> Result<()> {
        let truncated = self.truncated();
        match &mut self.engine {
            Engine::Decode(inflater) => {
                if !inflater.complete() {
                    return Err(anyhow!(truncated));
                }
            }
            Engine::Encode(encoder) => {
                let encoder = encoder.take().ok_or_else(|| anyhow!(truncated))?;
                let rest =
                    encoder_each!(encoder, w => w.finish()).map_err(|_| anyhow!(truncated))?;
                self.output.extend_from_slice(&rest);
            }
        }
        self.finished = true;
        Ok(())
    }

    fn take(&mut self, max: usize) -> Vec<u8> {
        let start = self.output_pos;
        let end = self.output.len().min(start + max);
        let out = self.output[start..end].to_vec();
        if end == self.output.len() {
            self.output.clear();
            self.output_pos = 0;
        } else if end >= self.output.len() / 2 {
            // What was read goes once it is half the buffer, so the buffer
            // stays bounded while the reader keeps a little behind.
            self.output.drain(..end);
            self.output_pos = 0;
        } else {
            self.output_pos = end;
        }
        out
    }
}

/// Live compression streams, keyed by an id JS holds across awaits.
///
/// **Process-wide, not per thread.** A `CompressionStream` outlives the turn
/// that created it, and under D1 the next turn of that request runs on
/// whichever isolate thread takes it — a thread-local table loses the stream,
/// and a per-thread counter is worse than that: two workers hand out the same
/// id, so one request's stream answers another's push. The ids are what JS
/// holds, so they have to be unique across the process.
static ZLIB_STREAMS: OnceLock<Mutex<HashMap<u64, ZlibStream>>> = OnceLock::new();
static ZLIB_STREAM_NEXT: AtomicU64 = AtomicU64::new(1);

fn zlib_streams() -> &'static Mutex<HashMap<u64, ZlibStream>> {
    ZLIB_STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Runs `op` on stream `id` outside the table's lock, so coding one stream
/// never stalls another thread's. An error poisons the stream: its native
/// state is dropped and the TypeError errors both sides of the transform.
fn with_stream<T>(id: u64, op: impl FnOnce(&mut ZlibStream) -> Result<T>) -> Result<T> {
    let mut stream = zlib_streams()
        .lock()
        .unwrap()
        .remove(&id)
        .ok_or_else(|| anyhow!("zlib stream already closed"))?;
    let result = op(&mut stream);
    if result.is_ok() {
        zlib_streams().lock().unwrap().insert(id, stream);
    }
    result
}

fn zlib_stream_throw(scope: &mut v8::PinScope, error: anyhow::Error) {
    let message = v8::String::new(scope, &error.to_string()).unwrap();
    let exception = v8::Exception::type_error(scope, message);
    scope.throw_exception(exception);
}

/// `__zlib_stream_new(format, decompress)` -> id. JS validates the format
/// and throws the spec TypeError, so an unknown one here is a bug.
/// `gzip-body` is the Content-Encoding decoder.
pub(super) fn op_zlib_stream_new(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let format = args.get(0).to_rust_string_lossy(scope);
    let decompress = args.get(1).boolean_value(scope);
    let stream = ZlibStream::new(&format, decompress).expect("JS validated the compression format");
    let id = ZLIB_STREAM_NEXT.fetch_add(1, Ordering::Relaxed);
    zlib_streams().lock().unwrap().insert(id, stream);
    rv.set(v8::Number::new(scope, id as f64).into());
}

/// `__zlib_stream_write(id, view)`: queues the bytes and codes them as far
/// as [`STREAM_AHEAD`] allows, throwing for bad input found there.
pub(super) fn op_zlib_stream_write(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let id = args.get(0).integer_value(scope).unwrap_or(0) as u64;
    let bytes = view_bytes(args.get(1)).unwrap_or_default();
    if let Err(error) = with_stream(id, |stream| stream.write(&bytes)) {
        zlib_stream_throw(scope, error);
    }
}

/// `__zlib_stream_end(id)`: the writable side closed. What is queued is
/// coded as far as [`STREAM_AHEAD`] allows, and when that is everything the
/// coder finishes here, so a truncated stream fails the close.
pub(super) fn op_zlib_stream_end(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let id = args.get(0).integer_value(scope).unwrap_or(0) as u64;
    let result = with_stream(id, |stream| {
        stream.ended = true;
        stream.code(STREAM_AHEAD)?;
        if stream.input_pos == stream.input.len() && !stream.finished {
            stream.finish()?;
        }
        Ok(())
    });
    if let Err(error) = result {
        zlib_stream_throw(scope, error);
    }
}

/// `__zlib_stream_read(id)` -> Uint8Array of at most [`STREAM_CHUNK`]:
/// empty when there is nothing until more is written, or, after
/// `__zlib_stream_end`, when the stream is done (and dropped).
pub(super) fn op_zlib_stream_read(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue<v8::Value>,
) {
    let id = args.get(0).integer_value(scope).unwrap_or(0) as u64;
    match with_stream(id, |stream| Ok((stream.read()?, stream.finished))) {
        Ok((bytes, finished)) => {
            if bytes.is_empty() && finished {
                zlib_streams().lock().unwrap().remove(&id);
            }
            webcrypto_return_bytes(scope, rv, &bytes);
        }
        Err(error) => zlib_stream_throw(scope, error),
    }
}

/// `__zlib_stream_drop(id)` — cancelled/aborted transform cleanup.
pub(super) fn op_zlib_stream_drop(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let id = args.get(0).integer_value(scope).unwrap_or(0) as u64;
    zlib_streams().lock().unwrap().remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn fits(len: usize, max: usize) -> bool {
        match read_bounded(std::io::repeat(7).take(len as u64), max) {
            Ok(out) => {
                assert_eq!(out.len(), len);
                true
            }
            Err(SyncFailure::MemoryLimit) => false,
            Err(SyncFailure::Other(error)) => panic!("unexpected failure: {error}"),
        }
    }

    /// Output lengths against `maxOutputLength`, as workerd v1.20261001.1
    /// answered them in `tests/conformance/cases/node/zlib-sync-options`.
    #[test]
    fn read_bounded_matches_workerd_buffer_growth() {
        for (len, max, expected) in [
            (17, 16, false),
            (17, 17, true),
            (17, 18, true),
            (1000, 999, false),
            (1000, 1000, true),
            (40960, 40959, false),
            (40960, 40960, true),
            (40960, 40961, false),
            (40960, 50000, false),
            (40960, 81920, true),
            (40961, 40961, false),
            (40961, 81920, true),
            (81920, 81919, false),
            (81920, 81920, true),
            (81920, 81921, false),
            (81920, 122880, true),
            (84489, 84489, false),
            (84489, 100000, false),
            (84489, 122880, true),
            (0, 1, true),
            (Z_MAX_CHUNK, Z_MAX_CHUNK, true),
        ] {
            assert_eq!(fits(len, max), expected, "{len} bytes with max {max}");
        }
    }

    #[test]
    fn inflate_stops_at_the_default_limit() {
        let zeros = std::io::repeat(0).take(Z_MAX_CHUNK as u64 + 1);
        let mut bomb = Vec::new();
        flate2::read::ZlibEncoder::new(zeros, flate2::Compression::best())
            .read_to_end(&mut bomb)
            .unwrap();
        assert!(bomb.len() < 1024 * 1024);
        assert!(matches!(
            zlib_sync("inflate", &bomb, -1, Z_MAX_CHUNK as f64),
            Err(SyncFailure::MemoryLimit)
        ));
        assert!(matches!(
            zlib_sync("inflate", &bomb, -1, 1024.0),
            Err(SyncFailure::MemoryLimit)
        ));
    }

    /// The compressed bytes are miniz_oxide's, not zlib's, so this checks
    /// what a level does rather than the bytes it writes, and the gzip
    /// header fields that flate2 sets as zlib does.
    #[test]
    fn level_is_honoured_and_gzip_header_matches_zlib() {
        let text: Vec<u8> = (0..4000)
            .flat_map(|i| {
                format!("line {} of {}: {}\n", i % 97, i % 13, "ab".repeat(i % 7)).into_bytes()
            })
            .collect();
        let size = |level| {
            zlib_sync("deflateRaw", &text, level, Z_MAX_CHUNK as f64)
                .unwrap()
                .len()
        };
        assert!(size(0) > text.len());
        assert!(size(1) > size(9));
        assert_eq!(size(-1), size(6));
        for level in -1..=9 {
            let gzip = zlib_sync("gzip", &text, level, Z_MAX_CHUNK as f64).unwrap();
            let xfl = match level {
                9 => 2,
                0 | 1 => 4,
                _ => 0,
            };
            assert_eq!(gzip[8..10], [xfl, GZIP_OS_UNIX], "level {level}");
            let back = zlib_sync("gunzip", &gzip, -1, Z_MAX_CHUNK as f64).unwrap();
            assert_eq!(back, text);
        }
    }

    fn decode(mode: &str, input: &[u8]) -> Result<Vec<u8>, String> {
        zlib_sync(mode, input, -1, Z_MAX_CHUNK as f64).map_err(|failure| match failure {
            SyncFailure::MemoryLimit => MEMORY_LIMIT.to_string(),
            SyncFailure::Other(error) => error.to_string(),
        })
    }

    /// Output larger than one buffer step, and the endings workerd v1.20261001.1
    /// gives: truncated input fails, bytes after a zlib or raw stream are
    /// ignored, and gunzip reads every member up to zero padding.
    #[test]
    fn decoding_fails_on_truncation_and_reads_every_gzip_member() {
        let text: Vec<u8> = (0..4000)
            .flat_map(|i| {
                format!("line {} of {}: {}\n", i % 97, i % 13, "ab".repeat(i % 7)).into_bytes()
            })
            .collect();
        let encode = |mode| zlib_sync(mode, &text, -1, Z_MAX_CHUNK as f64).unwrap();
        let (zlib, raw, gzip) = (encode("deflate"), encode("deflateRaw"), encode("gzip"));
        assert_eq!(decode("inflate", &zlib).unwrap(), text);
        assert_eq!(decode("inflateRaw", &raw).unwrap(), text);
        assert_eq!(decode("gunzip", &gzip).unwrap(), text);
        for (mode, stream) in [("inflate", &zlib), ("inflateRaw", &raw), ("gunzip", &gzip)] {
            for cut in [0, 1, stream.len() / 2, stream.len() - 1] {
                assert_eq!(
                    decode(mode, &stream[..cut]).unwrap_err(),
                    "unexpected end of file",
                    "{mode} cut at {cut}"
                );
            }
        }
        assert_eq!(
            decode("inflate", &[&zlib[..], &[1, 2, 3]].concat()).unwrap(),
            text
        );
        assert_eq!(
            decode("inflateRaw", &[&raw[..], &[9, 9]].concat()).unwrap(),
            text
        );
        let two = [&gzip[..], &gzip[..]].concat();
        assert_eq!(
            decode("gunzip", &two).unwrap(),
            [&text[..], &text[..]].concat()
        );
        assert_eq!(
            decode("gunzip", &[&gzip[..], &[0, 7]].concat()).unwrap(),
            text
        );
        assert!(decode("gunzip", &[&gzip[..], &[7, 0]].concat()).is_err());
    }

    #[test]
    fn gunzip_decodes_at_most_max_gzip_members() {
        let member = zlib_sync("gzip", b"", -1, Z_MAX_CHUNK as f64).unwrap();
        let mut members = member.repeat(MAX_GZIP_MEMBERS);
        assert_eq!(decode("gunzip", &members).unwrap(), b"");
        members.extend_from_slice(&member);
        assert_eq!(
            decode("gunzip", &members).unwrap_err(),
            format!("gzip input has more than {MAX_GZIP_MEMBERS} members, which celld does not decode in one call")
        );
        // The largest input, all empty members, stops at the cap.
        let bomb = member.repeat(Z_MAX_CHUNK / member.len() - 1);
        assert!(decode("gunzip", &bomb).is_err());
    }

    /// zlib's messages, which workerd passes on, for the failures celld can
    /// tell apart.
    #[test]
    fn decoding_errors_use_zlib_messages() {
        let text = b"messages ".repeat(1000);
        let zlib = zlib_sync("deflate", &text, -1, Z_MAX_CHUNK as f64).unwrap();
        let gzip = zlib_sync("gzip", &text, -1, Z_MAX_CHUNK as f64).unwrap();
        let with = |stream: &[u8], at: usize, byte: u8| {
            let mut stream = stream.to_vec();
            stream[at] = byte;
            stream
        };
        for (mode, input, message) in [
            ("inflate", vec![1, 2, 3, 4], "incorrect header check"),
            ("inflate", vec![0x79, 0x18], "unknown compression method"),
            ("inflate", vec![0x88, 0x1c], "invalid window size"),
            ("inflate", vec![0x78, 0xbb], "Missing dictionary"),
            ("inflate", vec![0x78], "unexpected end of file"),
            (
                "gunzip",
                vec![0x1f, 0x8c, 8, 0, 0, 0, 0, 0, 0, 3],
                "incorrect header check",
            ),
            ("gunzip", with(&gzip, 2, 7), "unknown compression method"),
            ("gunzip", with(&gzip, 3, 0x20), "unknown header flags set"),
            ("gunzip", with(&gzip, 3, 0x02), "header crc mismatch"),
            (
                "gunzip",
                with(&gzip, gzip.len() - 8, gzip[gzip.len() - 8] ^ 1),
                "incorrect data check",
            ),
            (
                "gunzip",
                with(&gzip, gzip.len() - 4, gzip[gzip.len() - 4] ^ 1),
                "incorrect length check",
            ),
            ("gunzip", gzip[..5].to_vec(), "unexpected end of file"),
        ] {
            assert_eq!(
                decode(mode, &input).unwrap_err(),
                message,
                "{mode} {input:?}"
            );
        }
        let checksum = with(&zlib, zlib.len() - 1, zlib[zlib.len() - 1] ^ 1);
        assert_eq!(
            decode("inflate", &checksum).unwrap_err(),
            "incorrect data check"
        );
        assert_eq!(
            decode("inflate", &zlib[..zlib.len() - 2]).unwrap_err(),
            "unexpected end of file"
        );
        // A block type of 3 is reserved; miniz_oxide does not say why it
        // failed, so the message is workerd's fallback.
        assert_eq!(decode("inflateRaw", &[0x07]).unwrap_err(), "Zlib error");
    }

    #[test]
    fn op_arguments_out_of_range_fail() {
        for (level, max) in [
            (10, 1.0),
            (-2, 1.0),
            (i32::MIN, 1.0),
            (-1, 0.0),
            (-1, f64::NAN),
        ] {
            assert!(matches!(
                zlib_sync("deflate", b"x", level, max),
                Err(SyncFailure::Other(_))
            ));
        }
        assert!(matches!(
            zlib_sync("deflate", &vec![0; Z_MAX_CHUNK], -1, Z_MAX_CHUNK as f64),
            Err(SyncFailure::MemoryLimit)
        ));
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    /// Reads a stream to its end, checking each chunk's bound.
    fn drain(stream: &mut ZlibStream) -> Result<Vec<u8>> {
        stream.ended = true;
        let mut out = Vec::new();
        loop {
            let chunk = stream.read()?;
            assert!(chunk.len() <= STREAM_CHUNK);
            if chunk.is_empty() {
                return Ok(out);
            }
            out.extend_from_slice(&chunk);
        }
    }

    /// An inflate bomb decodes a bounded chunk at a time: one write codes
    /// ahead only so far, and the rest waits for the reader.
    #[test]
    fn stream_decodes_a_bomb_in_bounded_steps() {
        let bomb = gzip(&vec![0; 64 * 1024 * 1024]);
        let mut stream = ZlibStream::new("gzip", true).unwrap();
        stream.write(&bomb).unwrap();
        assert!(stream.buffered() < STREAM_AHEAD + 1024 * 1024);
        let mut total = 0;
        stream.ended = true;
        loop {
            let chunk = stream.read().unwrap();
            assert!(chunk.len() <= STREAM_CHUNK);
            assert!(stream.buffered() < STREAM_AHEAD + 1024 * 1024);
            assert!(stream.output.capacity() < 4 * STREAM_AHEAD);
            if chunk.is_empty() {
                break;
            }
            total += chunk.len();
        }
        assert_eq!(total, 64 * 1024 * 1024);
    }

    /// A Content-Encoding body decodes every gzip member, as kj's
    /// GzipInputStream does; a DecompressionStream refuses the second as
    /// trailing bytes, as workerd's does.
    #[test]
    fn stream_gzip_members() {
        let mut both = gzip(b"hello\n");
        both.extend(gzip(b"world\n"));
        let mut body = ZlibStream::new("gzip-body", true).unwrap();
        body.write(&both).unwrap();
        assert_eq!(drain(&mut body).unwrap(), b"hello\nworld\n");
        let mut stream = ZlibStream::new("gzip", true).unwrap();
        let error = stream.write(&both).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Trailing bytes after end of compressed data"
        );
    }

    /// workerd's messages for a stream cut short and for bytes that are not
    /// gzip.
    #[test]
    fn stream_failures() {
        let data = gzip(b"cut short");
        let mut body = ZlibStream::new("gzip-body", true).unwrap();
        body.write(&data[..data.len() - 4]).unwrap();
        let error = drain(&mut body).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Gzip compressed stream ended prematurely."
        );
        let mut body = ZlibStream::new("gzip-body", true).unwrap();
        let error = body.write(b"not gzip").unwrap_err();
        assert_eq!(error.to_string(), "Gzip decompression failed.");
        let mut stream = ZlibStream::new("gzip", true).unwrap();
        stream.write(&data[..data.len() - 4]).unwrap();
        let error = drain(&mut stream).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Called close() on a decompression stream with incomplete data"
        );
    }

    /// An encoder holds its output until a full chunk or the end, and a
    /// round trip gives the input back.
    #[test]
    fn stream_encodes_and_round_trips() {
        let input: Vec<u8> = (0..300_000u32).map(|i| (i * 7 % 251) as u8).collect();
        let mut encoder = ZlibStream::new("gzip", false).unwrap();
        encoder.write(&input).unwrap();
        let compressed = drain(&mut encoder).unwrap();
        let mut decoder = ZlibStream::new("gzip", true).unwrap();
        decoder.write(&compressed).unwrap();
        assert_eq!(drain(&mut decoder).unwrap(), input);
    }

    /// Bytes after a body's last gzip member that are not another member
    /// fail it as kj fails it; a header's optional fields are skipped.
    #[test]
    fn stream_body_trailing_garbage_and_header_fields() {
        let mut body = ZlibStream::new("gzip-body", true).unwrap();
        let mut data = gzip(b"hello");
        data.extend_from_slice(b"garbage");
        let error = body.write(&data).unwrap_err();
        assert_eq!(error.to_string(), "Gzip decompression failed.");

        let mut named = Vec::new();
        {
            use std::io::Write;
            let mut encoder = flate2::GzBuilder::new()
                .filename("name.txt")
                .comment("a comment")
                .extra(vec![1, 2, 3])
                .write(&mut named, flate2::Compression::default());
            encoder.write_all(b"fields").unwrap();
            encoder.finish().unwrap();
        }
        let mut stream = ZlibStream::new("gzip", true).unwrap();
        for byte in &named {
            stream.write(std::slice::from_ref(byte)).unwrap();
        }
        assert_eq!(drain(&mut stream).unwrap(), b"fields");
    }

    /// A gzip member with the given header flags' fields: FNAME `name`,
    /// FEXTRA `extra`, and FHCRC, correct or not.
    fn member(
        name: Option<&[u8]>,
        extra: Option<&[u8]>,
        header_crc: Option<bool>,
        text: &[u8],
    ) -> Vec<u8> {
        let mut flags = 0;
        let mut header = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3];
        if let Some(extra) = extra {
            flags |= FEXTRA;
            header.extend_from_slice(&(extra.len() as u16).to_le_bytes());
            header.extend_from_slice(extra);
        }
        if let Some(name) = name {
            flags |= FNAME;
            header.extend_from_slice(name);
            header.push(0);
        }
        if let Some(good) = header_crc {
            flags |= FHCRC;
            header[3] = flags;
            let mut crc = flate2::Crc::new();
            crc.update(&header);
            let sum = (crc.sum() & 0xffff) as u16 ^ if good { 0 } else { 1 };
            header.extend_from_slice(&sum.to_le_bytes());
        }
        header[3] = flags;
        // The deflate data and trailer of a plain member.
        let plain = gzip(text);
        header.extend_from_slice(&plain[10..]);
        header
    }

    /// A header field of several MiB streams through in linear time and
    /// is never held, however it is split.
    #[test]
    fn stream_long_header_fields() {
        let name = vec![b'n'; 8 * 1024 * 1024];
        let data = member(Some(&name), Some(&[7; 300]), Some(true), b"named");
        for chunk in [data.len(), 64 * 1024, 1000] {
            let started = std::time::Instant::now();
            let mut body = ZlibStream::new("gzip-body", true).unwrap();
            for piece in data.chunks(chunk) {
                body.write(piece).unwrap();
                // Taken whole: nothing of the header waits in the queue.
                assert!(body.input.is_empty());
            }
            assert_eq!(drain(&mut body).unwrap(), b"named");
            assert!(started.elapsed() < std::time::Duration::from_secs(2));
        }
    }

    /// FHCRC is checked, as zlib checks it: a mismatch is bad data for a
    /// body and for a DecompressionStream.
    #[test]
    fn stream_header_crc() {
        let good = member(Some(b"n"), None, Some(true), b"checked");
        let bad = member(Some(b"n"), None, Some(false), b"checked");
        let mut body = ZlibStream::new("gzip-body", true).unwrap();
        body.write(&good).unwrap();
        assert_eq!(drain(&mut body).unwrap(), b"checked");
        let mut body = ZlibStream::new("gzip-body", true).unwrap();
        assert_eq!(
            body.write(&bad).unwrap_err().to_string(),
            "Gzip decompression failed."
        );
        let mut stream = ZlibStream::new("gzip", true).unwrap();
        assert_eq!(
            stream.write(&bad).unwrap_err().to_string(),
            "Decompression failed."
        );
    }
}
