// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! zlib: the synchronous `__zlib` op behind `node:zlib`, and the streaming
//! compression backend.
//!
//! `CompressionStream` and `DecompressionStream` need output chunk by chunk,
//! so a stream keeps a live flate2 writer whose `Vec` sink is drained after
//! every push. The one-shot op has no such state and runs to completion.
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

/// One live `CompressionStream`/`DecompressionStream`: a stateful flate2
/// writer whose `Vec` sink is drained after every push, so output streams
/// chunk by chunk instead of arriving once at close.
enum ZlibStream {
    GzipEncode(flate2::write::GzEncoder<Vec<u8>>),
    GzipDecode(flate2::write::GzDecoder<Vec<u8>>),
    ZlibEncode(flate2::write::ZlibEncoder<Vec<u8>>),
    ZlibDecode(flate2::write::ZlibDecoder<Vec<u8>>),
    RawEncode(flate2::write::DeflateEncoder<Vec<u8>>),
    RawDecode(flate2::write::DeflateDecoder<Vec<u8>>),
}

/// The six writer types share `write`/`flush`/`get_mut`/`finish` but no
/// trait, so dispatch once here.
macro_rules! zlib_each {
    ($stream:expr, $w:ident => $body:expr) => {
        match $stream {
            ZlibStream::GzipEncode($w) => $body,
            ZlibStream::GzipDecode($w) => $body,
            ZlibStream::ZlibEncode($w) => $body,
            ZlibStream::ZlibDecode($w) => $body,
            ZlibStream::RawEncode($w) => $body,
            ZlibStream::RawDecode($w) => $body,
        }
    };
}

impl ZlibStream {
    fn new(format: &str, decompress: bool) -> Option<ZlibStream> {
        use flate2::write as z;
        let level = flate2::Compression::default();
        let sink = Vec::new;
        Some(match (format, decompress) {
            ("gzip", false) => Self::GzipEncode(z::GzEncoder::new(sink(), level)),
            ("gzip", true) => Self::GzipDecode(z::GzDecoder::new(sink())),
            ("deflate", false) => Self::ZlibEncode(z::ZlibEncoder::new(sink(), level)),
            ("deflate", true) => Self::ZlibDecode(z::ZlibDecoder::new(sink())),
            ("deflate-raw", false) => Self::RawEncode(z::DeflateEncoder::new(sink(), level)),
            ("deflate-raw", true) => Self::RawDecode(z::DeflateDecoder::new(sink())),
            _ => return None,
        })
    }

    fn decompress(&self) -> bool {
        matches!(
            self,
            Self::GzipDecode(_) | Self::ZlibDecode(_) | Self::RawDecode(_)
        )
    }

    /// Workerd's canonical message, matched by its conformance suite.
    fn failure(&self) -> &'static str {
        if self.decompress() {
            "Decompression failed."
        } else {
            "Compression failed."
        }
    }

    /// Write one chunk and return whatever output it produced. Decoded
    /// output flows per chunk; encoders hold theirs until a full buffer
    /// accumulates (matching Workerd, whose suite reads a small message
    /// back as one chunk), with the rest arriving from `finish`. A
    /// decoder that stops consuming input has hit the end of the
    /// compressed stream, so leftover bytes are trailing garbage —
    /// Workerd's strict_compression_checks.
    fn push(&mut self, mut input: &[u8]) -> Result<Vec<u8>> {
        use std::io::Write;
        const ENCODER_CHUNK: usize = 32 * 1024;
        let failure = self.failure();
        let held = if self.decompress() { 0 } else { ENCODER_CHUNK };
        zlib_each!(self, w => {
            while !input.is_empty() {
                let n = w.write(input).map_err(|_| anyhow!(failure))?;
                if n == 0 { return Err(anyhow!(failure)); }
                input = &input[n..];
            }
            if w.get_ref().len() < held { return Ok(Vec::new()); }
            Ok(std::mem::take(w.get_mut()))
        })
    }

    /// Terminate the stream and return the final output. For gzip this
    /// also validates the trailer, so a truncated stream errors here.
    fn finish(self) -> Result<Vec<u8>> {
        let failure = self.failure();
        zlib_each!(self, w => w.finish().map_err(|_| anyhow!(failure)))
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

fn zlib_stream_return(
    scope: &mut v8::PinScope,
    rv: v8::ReturnValue<v8::Value>,
    result: Result<Vec<u8>>,
) {
    match result {
        Ok(bytes) => webcrypto_return_bytes(scope, rv, &bytes),
        Err(error) => {
            let message = v8::String::new(scope, &error.to_string()).unwrap();
            let exception = v8::Exception::type_error(scope, message);
            scope.throw_exception(exception);
        }
    }
}

/// `__zlib_stream_new(format, decompress)` -> id. JS validates the format
/// and throws the spec TypeError, so an unknown one here is a bug.
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

/// `__zlib_stream_push(id, view)` -> Uint8Array (possibly empty). An
/// error poisons the stream: its native state is dropped and the
/// TypeError errors both sides of the transform.
pub(super) fn op_zlib_stream_push(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue<v8::Value>,
) {
    let id = args.get(0).integer_value(scope).unwrap_or(0) as u64;
    let bytes = view_bytes(args.get(1)).unwrap_or_default();
    let result = {
        let mut streams = zlib_streams().lock().unwrap();
        let stream = streams
            .get_mut(&id)
            .ok_or_else(|| anyhow!("zlib stream already closed"));
        match stream {
            Ok(stream) => {
                let out = stream.push(&bytes);
                if out.is_err() {
                    streams.remove(&id);
                }
                out
            }
            Err(error) => Err(error),
        }
    };
    zlib_stream_return(scope, rv, result);
}

/// `__zlib_stream_end(id)` -> the final Uint8Array. Consumes the stream.
pub(super) fn op_zlib_stream_end(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue<v8::Value>,
) {
    let id = args.get(0).integer_value(scope).unwrap_or(0) as u64;
    let result = zlib_streams()
        .lock()
        .unwrap()
        .remove(&id)
        .ok_or_else(|| anyhow!("zlib stream already closed"));
    zlib_stream_return(scope, rv, result.and_then(ZlibStream::finish));
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
}
