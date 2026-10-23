//! Every esbuild run, through esbuild's service protocol: the one its
//! JavaScript API speaks to `esbuild --service=<version> --ping`
//! (`lib/shared/stdio_protocol.ts`, `lib/shared/common.ts` and
//! `cmd/esbuild/service.go` at the versions in [`PROTOCOL_VERSIONS`]). The
//! protocol carries plugins, which the CLI cannot, so Wrangler's `alias`
//! plugin runs here as it does under Wrangler ([`super::alias`]).
//!
//! A build sends the same flags the CLI took: the service parses them with
//! the CLI's own parser (`cli.ParseBuildOptions`), and its logger writes
//! diagnostics to stderr as the CLI's does. celld shows that stderr when a
//! build fails, as it showed the CLI's. One difference is esbuild's: the
//! service sets `logger.API = JSAPI`, so a hint that names an option
//! spells it as the JavaScript API does (`platform: 'node'`, not
//! `--platform=node`).

use super::alias::{Alias, OnResolve};
use anyhow::{anyhow, bail, Context};
use std::io::{BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};

/// The esbuild versions whose service protocol celld speaks. CI runs the
/// bundling cases with each (`.github/workflows/test.yml`). 0.28.2 added
/// only `logStyle` to `format-msgs`, which celld does not send.
const PROTOCOL_VERSIONS: [&str; 3] = ["0.28.0", "0.28.1", "0.28.2"];

/// The largest packet celld reads. A build writes its output to disk, so
/// its answer holds only diagnostics.
const MAX_PACKET: usize = 64 << 20;

/// How many values one packet may decode to. A value takes a byte on the
/// wire and tens in memory, so the packet limit alone would let a packet of
/// nulls decode to gigabytes; a diagnostic is about fifteen values.
const MAX_VALUES: usize = 1 << 20;

/// The most of esbuild's stderr that a failure shows.
const MAX_LOG: usize = 16 << 20;

/// How deep a decoded value may nest. esbuild's values nest a few levels.
const MAX_DEPTH: usize = 64;

/// One esbuild build.
pub(super) struct Build<'a> {
    /// The working directory esbuild resolves and prints paths against.
    pub(super) cwd: &'a Path,
    /// The entry point, relative to `cwd` or absolute.
    pub(super) entry: &'a Path,
    /// The CLI flags, without the entry point.
    pub(super) flags: Vec<String>,
    /// Wrangler's `alias`, applied by an on-resolve plugin when not empty.
    pub(super) alias: Option<&'a Alias>,
    /// Under `celld dev`, esbuild joins the builds [`super::stop_builds`]
    /// stops.
    pub(super) dev: bool,
}

/// How a build that esbuild ran ended.
pub(super) enum Outcome {
    Built,
    /// esbuild reported errors, written as its CLI writes them.
    Failed(String),
}

/// Run `build` on the esbuild that `CELLD_ESBUILD` names, or on `PATH`.
pub(super) fn run(build: &Build) -> anyhow::Result<Outcome> {
    run_binary(&binary(std::env::var("CELLD_ESBUILD").ok())?, build)
}

/// The esbuild to run: `CELLD_ESBUILD`, or `esbuild` on `PATH`. A path with
/// a `/` is a file, not a `PATH` lookup. The service runs in the build's
/// directory, so a relative one is made absolute here, against celld's own,
/// once for the probe and the service alike.
fn binary(configured: Option<String>) -> anyhow::Result<String> {
    let binary = configured.unwrap_or_else(|| "esbuild".to_string());
    if !binary.contains('/') {
        return Ok(binary);
    }
    std::path::absolute(&binary)
        .with_context(|| format!("resolve CELLD_ESBUILD {binary}"))?
        .into_os_string()
        .into_string()
        .map_err(|path| anyhow!("CELLD_ESBUILD is not UTF-8: {path:?}"))
}

fn run_binary(binary: &str, build: &Build) -> anyhow::Result<Outcome> {
    let version = protocol_version(binary, build.dev)?;
    let cwd = std::path::absolute(build.cwd)
        .with_context(|| format!("resolve the build directory {}", build.cwd.display()))?;
    // Absolute, as Wrangler passes it, so that an alias key meets the entry
    // as it would there. esbuild prints paths relative to `cwd` either way.
    let entry = cwd.join(build.entry);
    let mut command = Command::new(binary);
    command
        .arg(format!("--service={version}"))
        .arg("--ping")
        // The CLI turns Go's collector off for a build of one entry point,
        // which then exits (`debug.SetGCPercent(-1)` in
        // `cmd/esbuild/main.go`); the service leaves it on. This service also
        // runs one such build and exits, so it runs as the CLI did, in time
        // and in memory.
        .env("GOGC", "off")
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let (child, group) = super::spawn_build_process(&mut command, build.dev, "esbuild")
        .map_err(|error| not_found(binary, error))?;
    let mut service = Service {
        child,
        _group: group,
    };
    let mut stdin = service.child.stdin.take().expect("stdin is piped");
    let mut stdout = BufReader::new(service.child.stdout.take().expect("stdout is piped"));
    let mut stderr = service.child.stderr.take().expect("stderr is piped");
    // Drained beside the exchange, so a full stderr pipe never stalls it.
    let log = std::thread::spawn(move || {
        let mut log = Vec::new();
        let _ = (&mut stderr).take(MAX_LOG as u64).read_to_end(&mut log);
        let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        log
    });
    let answer = exchange(&mut stdin, &mut stdout, &version, &cwd, &entry, build);
    // esbuild exits once stdin closes and its last packet is out, unless a
    // failed exchange left it waiting on celld's answer.
    if answer.is_err() {
        let _ = service.child.kill();
    }
    drop(stdin);
    let _ = std::io::copy(&mut stdout, &mut std::io::sink());
    let status = service.child.wait().context("wait for esbuild")?;
    let log = log
        .join()
        .map_err(|_| anyhow!("esbuild's stderr reader panicked"))?;
    let log = String::from_utf8_lossy(&log).trim().to_string();
    let answer = answer.map_err(|error| {
        if log.is_empty() {
            error.context(format!("esbuild ({status})"))
        } else {
            error.context(format!("esbuild ({status}):\n{log}"))
        }
    })?;
    if let Some(error) = answer.get("error").and_then(Wire::as_str) {
        // A refused request, such as a flag the parser rejects: the CLI
        // prints it as an error.
        return Ok(Outcome::Failed(format!("✘ [ERROR] {error}")));
    }
    let errors = answer
        .get("errors")
        .and_then(Wire::as_array)
        .context("esbuild's build answer has no errors list")?;
    if errors.is_empty() {
        Ok(Outcome::Built)
    } else {
        Ok(Outcome::Failed(log))
    }
}

/// The esbuild service process. Dropping it kills and reaps esbuild, then
/// leaves `celld dev`'s registry.
struct Service {
    child: Child,
    _group: Option<super::DevGroup>,
}

impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn not_found(binary: &str, error: anyhow::Error) -> anyhow::Error {
    match error.downcast_ref::<std::io::Error>() {
        Some(io) if io.kind() == std::io::ErrorKind::NotFound => anyhow!(
            "esbuild not found ({binary}).\n\
             `celld deploy` bundles with esbuild; install it and retry,\n\
             or set CELLD_ESBUILD to its path."
        ),
        Some(_) => error.context("run esbuild"),
        None => error,
    }
}

/// The version `binary --version` prints, when celld speaks its protocol.
/// The service starts only for the host version that matches the binary's.
/// The probe is a build process like the service.
fn protocol_version(binary: &str, dev: bool) -> anyhow::Result<String> {
    let mut command = Command::new(binary);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let (child, group) = super::spawn_build_process(&mut command, dev, "esbuild")
        .map_err(|error| not_found(binary, error))?;
    let output = child
        .wait_with_output()
        .context("wait for `esbuild --version`")?;
    drop(group);
    if !output.status.success() {
        bail!(
            "`{binary} --version` failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !PROTOCOL_VERSIONS.contains(&version.as_str()) {
        bail!(
            "esbuild {version} ({binary}) is not a version celld can drive: celld speaks the \
             service protocol of esbuild {}. Install one of them, or set CELLD_ESBUILD to its \
             path.",
            PROTOCOL_VERSIONS.join(", ")
        );
    }
    Ok(version)
}

/// The build's id, and its key for the plugin callbacks.
const BUILD: u32 = 0;
/// The alias plugin's one on-resolve callback.
const ON_RESOLVE: u32 = 0;
const PLUGIN: &str = "alias";

/// Check esbuild's version packet, send the build, and answer esbuild's
/// requests until the build's answer arrives.
fn exchange(
    stdin: &mut impl Write,
    stdout: &mut impl Read,
    version: &str,
    cwd: &Path,
    entry: &Path,
    build: &Build,
) -> anyhow::Result<Wire> {
    let first = read_packet(stdout)?.context("esbuild exited before it started")?;
    if first != version.as_bytes() {
        bail!(
            "esbuild started as version {:?}, not {version}",
            String::from_utf8_lossy(&first)
        );
    }
    let alias = build.alias.filter(|alias| !alias.is_empty());
    let mut request = vec![
        ("command", Wire::str("build")),
        ("key", Wire::Int(BUILD)),
        (
            "entries",
            Wire::Array(vec![Wire::Array(vec![Wire::str(""), path(entry)?])]),
        ),
        (
            "flags",
            Wire::Array(build.flags.iter().map(|flag| Wire::str(flag)).collect()),
        ),
        ("write", Wire::Bool(true)),
        ("absWorkingDir", path(cwd)?),
        // None, as from Wrangler: the CLI reads `NODE_PATH` (`runImpl`), the
        // service only this list, which Wrangler leaves empty.
        ("nodePaths", Wire::Array(Vec::new())),
        ("context", Wire::Bool(false)),
    ];
    if let Some(alias) = alias {
        request.push((
            "plugins",
            Wire::Array(vec![Wire::map([
                ("name", Wire::str(PLUGIN)),
                ("onStart", Wire::Bool(false)),
                ("onEnd", Wire::Bool(false)),
                (
                    "onResolve",
                    Wire::Array(vec![Wire::map([
                        ("id", Wire::Int(ON_RESOLVE)),
                        ("filter", Wire::Str(alias.filter())),
                        ("namespace", Wire::str("")),
                    ])]),
                ),
                ("onLoad", Wire::Array(Vec::new())),
            ])]),
        ));
    }
    stdin.write_all(&encode_packet(BUILD, true, &Wire::map(request))?)?;
    stdin.flush()?;
    loop {
        let bytes = read_packet(stdout)?.context("esbuild exited before it answered the build")?;
        let packet = decode_packet(&bytes)?;
        if !packet.is_request {
            if packet.id != BUILD {
                bail!(
                    "esbuild answered request {}, which celld did not send",
                    packet.id
                );
            }
            return Ok(packet.value);
        }
        let command = packet.value.get("command").and_then(Wire::as_str);
        let reply = match command {
            Some("ping") => Wire::map([]),
            // esbuild always registers an on-start callback for a plugin.
            Some("on-start") => Wire::map([
                ("errors", Wire::Array(Vec::new())),
                ("warnings", Wire::Array(Vec::new())),
            ]),
            Some("on-resolve") => {
                let alias = alias.context("esbuild sent on-resolve to a build without plugins")?;
                let import = packet
                    .value
                    .get("path")
                    .and_then(Wire::as_str)
                    .context("esbuild's on-resolve request has no path")?;
                on_resolve(alias.on_resolve(import))
            }
            other => bail!("esbuild sent the request {other:?}, which celld does not answer"),
        };
        stdin.write_all(&encode_packet(packet.id, false, &reply)?)?;
        stdin.flush()?;
    }
}

/// The on-resolve answer, as the JavaScript API builds it: the callback's
/// id with what it returned, or nothing for an import it leaves alone.
fn on_resolve(outcome: OnResolve) -> Wire {
    match outcome {
        OnResolve::Unaliased => Wire::map([]),
        OnResolve::Path(path) => {
            Wire::map([("id", Wire::Int(ON_RESOLVE)), ("path", Wire::Str(path))])
        }
        // esbuild places a message that has no location at the import.
        OnResolve::Error(text) => Wire::map([
            ("id", Wire::Int(ON_RESOLVE)),
            (
                "errors",
                Wire::Array(vec![Wire::map([
                    ("id", Wire::str("")),
                    ("pluginName", Wire::str(PLUGIN)),
                    ("text", Wire::Str(text)),
                    ("location", Wire::Null),
                    ("notes", Wire::Array(Vec::new())),
                    // The JavaScript API's "no detail" (`-1`).
                    ("detail", Wire::Int(u32::MAX)),
                ])]),
            ),
        ]),
    }
}

fn path(path: &Path) -> anyhow::Result<Wire> {
    path.to_str()
        .map(Wire::str)
        .ok_or_else(|| anyhow!("esbuild takes UTF-8 paths, not {}", path.display()))
}

/// A value of the service protocol: JSON with an integer type and a byte
/// array type. A map keeps its keys in order.
#[derive(Clone, Debug, PartialEq)]
enum Wire {
    Null,
    Bool(bool),
    /// A 32-bit integer. Go writes an `int` as its low 32 bits, and reads
    /// one back as unsigned.
    Int(u32),
    Str(String),
    Bytes(Vec<u8>),
    Array(Vec<Wire>),
    Map(Vec<(String, Wire)>),
}

impl Wire {
    fn str(value: &str) -> Wire {
        Wire::Str(value.to_string())
    }

    fn map<'a>(entries: impl IntoIterator<Item = (&'a str, Wire)>) -> Wire {
        Wire::Map(
            entries
                .into_iter()
                .map(|(key, value)| (key.to_string(), value))
                .collect(),
        )
    }

    /// A map's value for `key`; the last one, as both ends keep a repeated
    /// key's last value.
    fn get(&self, key: &str) -> Option<&Wire> {
        let Wire::Map(entries) = self else {
            return None;
        };
        entries
            .iter()
            .rev()
            .find(|(candidate, _)| candidate == key)
            .map(|(_, value)| value)
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            Wire::Str(value) => Some(value),
            _ => None,
        }
    }

    fn as_array(&self) -> Option<&[Wire]> {
        match self {
            Wire::Array(items) => Some(items),
            _ => None,
        }
    }
}

/// One packet: a request, or the response to the request with its id.
#[derive(Debug, PartialEq)]
struct Packet {
    id: u32,
    is_request: bool,
    value: Wire,
}

/// `encodePacket`: the length of the rest, then `id << 1`, with the low
/// bit set on a response, then the value. Every integer is little-endian.
fn encode_packet(id: u32, is_request: bool, value: &Wire) -> anyhow::Result<Vec<u8>> {
    fn length(bytes: &mut Vec<u8>, len: usize) -> anyhow::Result<()> {
        let len = u32::try_from(len).context("a packet field is over 4 GiB")?;
        bytes.extend_from_slice(&len.to_le_bytes());
        Ok(())
    }
    fn visit(bytes: &mut Vec<u8>, value: &Wire) -> anyhow::Result<()> {
        match value {
            Wire::Null => bytes.push(0),
            Wire::Bool(value) => bytes.extend_from_slice(&[1, u8::from(*value)]),
            Wire::Int(value) => {
                bytes.push(2);
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            Wire::Str(value) => {
                bytes.push(3);
                length(bytes, value.len())?;
                bytes.extend_from_slice(value.as_bytes());
            }
            Wire::Bytes(value) => {
                bytes.push(4);
                length(bytes, value.len())?;
                bytes.extend_from_slice(value);
            }
            Wire::Array(items) => {
                bytes.push(5);
                length(bytes, items.len())?;
                for item in items {
                    visit(bytes, item)?;
                }
            }
            Wire::Map(entries) => {
                bytes.push(6);
                length(bytes, entries.len())?;
                for (key, value) in entries {
                    length(bytes, key.len())?;
                    bytes.extend_from_slice(key.as_bytes());
                    visit(bytes, value)?;
                }
            }
        }
        Ok(())
    }
    if id > u32::MAX >> 1 {
        bail!("packet id {id} does not fit in 31 bits");
    }
    let mut bytes = vec![0; 4];
    bytes.extend_from_slice(&(id << 1 | u32::from(!is_request)).to_le_bytes());
    visit(&mut bytes, value)?;
    let len = u32::try_from(bytes.len() - 4).context("a packet is over 4 GiB")?;
    bytes[..4].copy_from_slice(&len.to_le_bytes());
    Ok(bytes)
}

/// `decodePacket`, of a packet without its length. Anything malformed is an
/// error: a short or overlong value, an unknown type, or bytes after the
/// value. Strings are decoded as the JavaScript API decodes them, with
/// U+FFFD for an invalid sequence.
fn decode_packet(bytes: &[u8]) -> anyhow::Result<Packet> {
    struct Reader<'a>(&'a [u8], usize);

    impl<'a> Reader<'a> {
        fn take(&mut self, len: usize) -> anyhow::Result<&'a [u8]> {
            if self.0.len() < len {
                bail!("invalid packet from esbuild: it ends early");
            }
            let (head, rest) = self.0.split_at(len);
            self.0 = rest;
            Ok(head)
        }

        fn u32(&mut self) -> anyhow::Result<u32> {
            Ok(u32::from_le_bytes(
                self.take(4)?.try_into().expect("4 bytes"),
            ))
        }

        fn bytes(&mut self) -> anyhow::Result<&'a [u8]> {
            let len = self.u32()? as usize;
            self.take(len)
        }

        fn value(&mut self, depth: usize) -> anyhow::Result<Wire> {
            if depth > MAX_DEPTH {
                bail!("invalid packet from esbuild: values nest over {MAX_DEPTH} deep");
            }
            self.1 += 1;
            if self.1 > MAX_VALUES {
                bail!("invalid packet from esbuild: over {MAX_VALUES} values");
            }
            Ok(match self.take(1)?[0] {
                0 => Wire::Null,
                1 => Wire::Bool(self.take(1)?[0] != 0),
                2 => Wire::Int(self.u32()?),
                3 => Wire::Str(String::from_utf8_lossy(self.bytes()?).into_owned()),
                4 => Wire::Bytes(self.bytes()?.to_vec()),
                5 => {
                    let count = self.u32()?;
                    // Each item takes a byte at least, so the count is
                    // checked before anything is allocated for it.
                    let mut items = Vec::with_capacity((count as usize).min(self.0.len()));
                    for _ in 0..count {
                        items.push(self.value(depth + 1)?);
                    }
                    Wire::Array(items)
                }
                6 => {
                    let count = self.u32()?;
                    let mut entries = Vec::with_capacity((count as usize).min(self.0.len() / 5));
                    for _ in 0..count {
                        let key = String::from_utf8_lossy(self.bytes()?).into_owned();
                        entries.push((key, self.value(depth + 1)?));
                    }
                    Wire::Map(entries)
                }
                kind => bail!("invalid packet from esbuild: unknown value type {kind}"),
            })
        }
    }

    let mut reader = Reader(bytes, 0);
    let id = reader.u32()?;
    let value = reader.value(0)?;
    if !reader.0.is_empty() {
        bail!(
            "invalid packet from esbuild: {} bytes after the value",
            reader.0.len()
        );
    }
    Ok(Packet {
        id: id >> 1,
        is_request: id & 1 == 0,
        value,
    })
}

/// The next length-prefixed packet, or `None` at the end of the stream.
fn read_packet(stream: &mut impl Read) -> anyhow::Result<Option<Vec<u8>>> {
    let mut len = [0; 4];
    let mut filled = 0;
    while filled < 4 {
        match stream.read(&mut len[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => bail!("esbuild's output ends inside a packet length"),
            Ok(read) => filled += read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error).context("read from esbuild"),
        }
    }
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_PACKET {
        bail!("esbuild sent a packet of {len} bytes, over celld's limit of {MAX_PACKET}");
    }
    let mut packet = vec![0; len];
    stream
        .read_exact(&mut packet)
        .context("esbuild's output ends inside a packet")?;
    Ok(Some(packet))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic xorshift, so a failing case replays.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    fn random_value(rng: &mut Rng, depth: usize) -> Wire {
        let kind = if depth > 4 {
            rng.below(5)
        } else {
            rng.below(7)
        };
        let text = |rng: &mut Rng| -> String {
            let pool = ["", "a", "é", "日本", "\u{1F600}", "\0", "key", "on-resolve"];
            (0..rng.below(4))
                .map(|_| pool[rng.below(pool.len() as u64) as usize])
                .collect()
        };
        match kind {
            0 => Wire::Null,
            1 => Wire::Bool(rng.below(2) == 1),
            2 => Wire::Int(rng.next() as u32),
            3 => Wire::Str(text(rng)),
            4 => Wire::Bytes((0..rng.below(8)).map(|_| rng.next() as u8).collect()),
            5 => Wire::Array(
                (0..rng.below(5))
                    .map(|_| random_value(rng, depth + 1))
                    .collect(),
            ),
            _ => Wire::Map(
                (0..rng.below(5))
                    .map(|_| (text(rng), random_value(rng, depth + 1)))
                    .collect(),
            ),
        }
    }

    fn round_trip(id: u32, is_request: bool, value: &Wire) -> Packet {
        let bytes = encode_packet(id, is_request, value).unwrap();
        let len = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
        assert_eq!(len, bytes.len() - 4);
        let mut stream = &bytes[..];
        let packet = read_packet(&mut stream).unwrap().unwrap();
        assert!(read_packet(&mut stream).unwrap().is_none());
        decode_packet(&packet).unwrap()
    }

    #[test]
    fn packets_round_trip() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        for _ in 0..2000 {
            let value = random_value(&mut rng, 0);
            let id = rng.below(1 << 31) as u32;
            let is_request = rng.below(2) == 0;
            assert_eq!(
                round_trip(id, is_request, &value),
                Packet {
                    id,
                    is_request,
                    value
                }
            );
        }
        assert!(encode_packet(1 << 31, true, &Wire::Null).is_err());
    }

    /// The bytes esbuild's JavaScript `encodePacket` writes for
    /// `{ id: 3, isRequest: false, value: { command: "ping", n: -1, ok: true } }`.
    #[test]
    fn packets_match_the_javascript_encoding() {
        let value = Wire::map([
            ("command", Wire::str("ping")),
            ("n", Wire::Int(u32::MAX)),
            ("ok", Wire::Bool(true)),
        ]);
        let mut expected = vec![];
        expected.extend_from_slice(&7u32.to_le_bytes());
        expected.extend_from_slice(&[6, 3, 0, 0, 0]);
        expected.extend_from_slice(&[7, 0, 0, 0]);
        expected.extend_from_slice(b"command");
        expected.extend_from_slice(&[3, 4, 0, 0, 0]);
        expected.extend_from_slice(b"ping");
        expected.extend_from_slice(&[1, 0, 0, 0, b'n', 2, 0xff, 0xff, 0xff, 0xff]);
        expected.extend_from_slice(&[2, 0, 0, 0, b'o', b'k', 1, 1]);
        let mut framed = (expected.len() as u32).to_le_bytes().to_vec();
        framed.extend_from_slice(&expected);
        assert_eq!(encode_packet(3, false, &value).unwrap(), framed);
    }

    #[test]
    fn malformed_packets_are_errors() {
        let valid = encode_packet(5, true, &Wire::Array(vec![Wire::str("abc"), Wire::Int(9)]))
            .unwrap()
            .split_off(4);
        // Every truncation, and trailing bytes.
        for len in 0..valid.len() {
            assert!(decode_packet(&valid[..len]).is_err(), "truncated to {len}");
        }
        let mut long = valid.clone();
        long.push(0);
        assert!(decode_packet(&long)
            .unwrap_err()
            .to_string()
            .contains("1 bytes after"));
        // An unknown type, and counts and lengths past the end, which must
        // fail before they allocate.
        let id = 0u32.to_le_bytes();
        let packet = |tail: &[u8]| [&id[..], tail].concat();
        assert!(decode_packet(&packet(&[7])).is_err());
        assert!(decode_packet(&packet(&[3, 0xff, 0xff, 0xff, 0xff])).is_err());
        assert!(decode_packet(&packet(&[5, 0xff, 0xff, 0xff, 0xff])).is_err());
        assert!(decode_packet(&packet(&[6, 0xff, 0xff, 0xff, 0xff])).is_err());
        assert!(decode_packet(&packet(&[2, 1, 2])).is_err());
        assert!(decode_packet(&packet(&[1])).is_err());
        // Nesting is bounded.
        let mut deep = vec![];
        for _ in 0..1000 {
            deep.extend_from_slice(&[5, 1, 0, 0, 0]);
        }
        deep.push(0);
        assert!(decode_packet(&packet(&deep))
            .unwrap_err()
            .to_string()
            .contains("nest"));
        // Invalid UTF-8 decodes as the JavaScript API's TextDecoder does.
        assert_eq!(
            decode_packet(&packet(&[3, 2, 0, 0, 0, 0xff, b'a']))
                .unwrap()
                .value,
            Wire::str("\u{FFFD}a")
        );
        // The stream: a packet over the limit, and one cut short.
        let mut over = &(MAX_PACKET as u32 + 1).to_le_bytes()[..];
        assert!(read_packet(&mut over)
            .unwrap_err()
            .to_string()
            .contains("limit"));
        let mut short = &[4, 0, 0, 0, 1][..];
        assert!(read_packet(&mut short).is_err());
        let mut cut = &[4, 0][..];
        assert!(read_packet(&mut cut).is_err());
    }

    /// A packet's values are counted, so a small packet cannot decode to a
    /// large tree.
    #[test]
    fn a_packet_decodes_to_a_bounded_number_of_values() {
        let packet = |count: usize| {
            let mut bytes = vec![0, 0, 0, 0, 5];
            bytes.extend_from_slice(&(count as u32).to_le_bytes());
            bytes.resize(bytes.len() + count, 0);
            bytes
        };
        assert!(decode_packet(&packet(MAX_VALUES - 1)).is_ok());
        assert!(decode_packet(&packet(MAX_VALUES))
            .unwrap_err()
            .to_string()
            .contains("values"));
    }

    #[test]
    fn a_relative_esbuild_is_made_absolute_once() {
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(binary(None).unwrap(), "esbuild");
        assert_eq!(
            binary(Some("esbuild-0.28".to_string())).unwrap(),
            "esbuild-0.28"
        );
        assert_eq!(
            binary(Some("node_modules/.bin/esbuild".to_string())).unwrap(),
            cwd.join("node_modules/.bin/esbuild").to_str().unwrap()
        );
        assert_eq!(
            binary(Some("/opt/esbuild".to_string())).unwrap(),
            "/opt/esbuild"
        );
    }

    /// Random bytes never panic the decoder.
    #[test]
    fn random_bytes_decode_or_fail() {
        let mut rng = Rng(0xD1B5_4A32_D192_ED03);
        for _ in 0..20_000 {
            let len = rng.below(48) as usize;
            let bytes: Vec<u8> = (0..len)
                .map(|_| match rng.below(4) {
                    0 => rng.below(8) as u8,
                    1 => 0,
                    _ => rng.next() as u8,
                })
                .collect();
            if let Ok(packet) = decode_packet(&bytes) {
                let again = round_trip(packet.id, packet.is_request, &packet.value);
                assert_eq!(again, packet);
            }
        }
    }

    /// An executable standing in for esbuild: `--version` prints
    /// `version`, and the service runs `service`, a shell script.
    ///
    /// Other tests fork meanwhile, and a child forked while the script was
    /// open for writing holds that descriptor until it execs, so executing
    /// the script fails with ETXTBSY until then. The script is written
    /// under another name, closed and renamed into place, and run until it
    /// runs: once no descriptor for writing is left, none can come back.
    fn fake_esbuild(dir: &Path, version: &str, service: &str) -> String {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let path = dir.join("esbuild");
        let staged = dir.join("esbuild.staged");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o755)
            .open(&staged)
            .unwrap();
        write!(
            file,
            "#!/bin/sh\nif [ \"$1\" = --version ]; then echo {version}; exit 0; fi\n{service}\n"
        )
        .unwrap();
        drop(file);
        std::fs::rename(&staged, &path).unwrap();
        let started = std::time::Instant::now();
        loop {
            match Command::new(&path).arg("--version").output() {
                Err(error) if error.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                    assert!(
                        started.elapsed() < std::time::Duration::from_secs(10),
                        "the fake esbuild stayed busy"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                result => {
                    result.unwrap();
                    break;
                }
            }
        }
        path.to_str().unwrap().to_string()
    }

    fn build(dir: &Path, dev: bool) -> Build<'_> {
        Build {
            cwd: dir,
            entry: Path::new("index.js"),
            flags: Vec::new(),
            alias: None,
            dev,
        }
    }

    /// Whether `pid` runs: a zombie does not.
    fn running(pid: i32) -> bool {
        (unsafe { libc::kill(pid, 0) }) == 0
            && !std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .is_ok_and(|stat| stat.contains(") Z "))
    }

    fn wait_for_pid(file: &Path) -> i32 {
        let started = std::time::Instant::now();
        loop {
            if let Some(pid) = std::fs::read_to_string(file)
                .ok()
                .and_then(|pid| pid.trim().parse().ok())
            {
                return pid;
            }
            assert!(
                started.elapsed() < std::time::Duration::from_secs(10),
                "esbuild did not start"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    #[test]
    fn a_version_celld_does_not_speak_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let binary = fake_esbuild(dir.path(), "0.27.7", "exit 1");
        let Err(error) = run_binary(&binary, &build(dir.path(), false)) else {
            panic!("esbuild 0.27.7 ran");
        };
        assert_eq!(
            error.to_string(),
            format!(
                "esbuild 0.27.7 ({binary}) is not a version celld can drive: celld speaks the \
                 service protocol of esbuild 0.28.0, 0.28.1, 0.28.2. Install one of them, or \
                 set CELLD_ESBUILD to its path."
            )
        );
        let missing = dir.path().join("missing").to_str().unwrap().to_string();
        let Err(error) = run_binary(&missing, &build(dir.path(), false)) else {
            panic!("a missing esbuild ran");
        };
        assert!(
            error.to_string().starts_with("esbuild not found"),
            "{error}"
        );
    }

    /// A service that breaks the protocol is killed, not left waiting for
    /// an answer, and its stderr is in the error.
    #[test]
    fn a_failed_exchange_kills_esbuild() {
        let dir = tempfile::tempdir().unwrap();
        let binary = fake_esbuild(
            dir.path(),
            "0.28.1",
            "echo $$ > pid; echo oops >&2; printf '\\005\\000\\000\\000%s' 9.9.9; exec sleep 600",
        );
        let Err(error) = run_binary(&binary, &build(dir.path(), false)) else {
            panic!("a bad service built");
        };
        let error = format!("{error:#}");
        assert!(error.contains("signal: 9"), "{error}");
        assert!(error.contains("oops"), "{error}");
        assert!(
            error.contains("esbuild started as version \"9.9.9\", not 0.28.1"),
            "{error}"
        );
        let pid = wait_for_pid(&dir.path().join("pid"));
        assert!(!running(pid), "esbuild {pid} survived");
    }

    /// `celld dev`'s stop reaches esbuild, which is in its own build group.
    #[test]
    fn stopping_dev_builds_stops_esbuild() {
        let _turn = super::super::dev_build_turn();
        let dir = tempfile::tempdir().unwrap();
        let binary = fake_esbuild(dir.path(), "0.28.1", "echo $$ > pid; exec sleep 600");
        let root = dir.path().to_path_buf();
        let running_build =
            std::thread::spawn(move || run_binary(&binary, &build(&root, true)).map(|_| ()));
        let pid = wait_for_pid(&dir.path().join("pid"));
        let stopping = std::time::Instant::now();
        super::super::stop_builds(std::time::Duration::from_secs(2));
        let error = format!("{:#}", running_build.join().unwrap().unwrap_err());
        assert!(stopping.elapsed() < std::time::Duration::from_secs(5));
        assert!(error.contains("signal: 15"), "{error}");
        assert!(!running(pid), "esbuild {pid} survived");
        // No esbuild starts once `celld dev` is stopping.
        let binary = fake_esbuild(dir.path(), "0.28.1", "touch started; exec sleep 600");
        let Err(error) = run_binary(&binary, &build(dir.path(), true)) else {
            panic!("esbuild started while celld dev stopped");
        };
        assert_eq!(
            format!("{error:#}"),
            "celld dev is stopping, so esbuild did not start"
        );
        assert!(!dir.path().join("started").exists());
    }

    #[test]
    fn a_repeated_key_reads_its_last_value() {
        let value = Wire::Map(vec![
            ("a".to_string(), Wire::Int(1)),
            ("a".to_string(), Wire::Int(2)),
        ]);
        assert_eq!(value.get("a"), Some(&Wire::Int(2)));
        assert_eq!(value.get("b"), None);
    }
}
