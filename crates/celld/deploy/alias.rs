//! Wrangler's `alias` (plan items 1.24 and 1.45), as Wrangler 4.147.0 reads
//! and applies it (`wrangler-dist/cli.js`): `normalizeAndValidateAliases`
//! checks the config, and the esbuild plugin `alias` in `bundleWorker`
//! replaces an import.
//!
//! The plugin registers one on-resolve callback whose filter is the keys,
//! escaped and joined with `|`, unanchored. The callback then looks the
//! import path up literally, `alias[args.path]`, from any importer, and
//! resolves the value with Node's `require.resolve(value, { paths: [root] })`,
//! `root` being the config's directory. It runs only when the key is
//! imported, so a target that never resolves fails only the build that
//! imports it. [`require_resolve`] is that Node call, from Node 26's
//! `lib/internal/modules/cjs/loader.js` and `lib/internal/modules/esm/resolve.js`.

use crate::note;
use anyhow::{anyhow, bail, Context};
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use url::Url;

/// The config's `alias`, and the directory its values resolve from.
pub(super) struct Alias {
    /// Absolute, as Wrangler's `projectRoot`.
    root: PathBuf,
    /// What Node's resolution reads besides: celld's working directory,
    /// which stands for Wrangler's, and the conditions.
    node: Node,
    /// Every key, an empty value included: Wrangler's filter lists it, and
    /// its lookup finds an empty string, which aliases nothing.
    entries: BTreeMap<String, String>,
}

/// What the plugin answers for one import path.
#[derive(Debug, PartialEq)]
pub(super) enum OnResolve {
    /// Not aliased: esbuild resolves the path as usual.
    Unaliased,
    /// The path esbuild loads instead: a file, or what Node returns for a
    /// builtin, which esbuild then refuses as a non-absolute path, as it does
    /// under Wrangler.
    Path(String),
    /// The plugin's error, which fails the build.
    Error(String),
}

/// The names `alias[args.path]` finds on `Object.prototype` when the config
/// has no such key (`Object.getOwnPropertyNames(Object.prototype)` on Node
/// 26). Wrangler passes what it finds to `require.resolve`, which throws.
const OBJECT_PROTOTYPE: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// Read `alias` as Wrangler's `normalizeAndValidateAliases` does: an
/// object whose every value is a string, each failure named. celld also
/// refuses a `null` or array `alias`, which `typeof` calls an object:
/// Wrangler crashes on `null` and reads an array's indexes as keys.
pub(super) fn read_alias(object: &Map<String, Value>, root: &Path) -> anyhow::Result<Alias> {
    let cwd = std::env::current_dir().context("read the working directory")?;
    let root = resolve(&cwd, root);
    let entries = match object.get("alias") {
        None => {
            return Ok(Alias {
                root,
                node: Node {
                    cwd,
                    conditions: Vec::new(),
                },
                entries: BTreeMap::new(),
            })
        }
        Some(Value::Object(entries)) => entries,
        Some(Value::Null) => bail!("`alias` must be an object, not null"),
        Some(Value::Array(_)) => bail!("`alias` must be an object, not an array"),
        Some(other) => bail!(
            "Expected alias to be an object, but got {}",
            json_type(other)
        ),
    };
    // Wrangler reports every entry that is not a string before giving up.
    let wrong: Vec<String> = entries
        .iter()
        .filter(|(_, value)| !value.is_string())
        .map(|(key, value)| {
            format!(
                "Expected alias[\"{key}\"] to be a string, but got {}",
                json_type(value)
            )
        })
        .collect();
    if !wrong.is_empty() {
        bail!("{}", wrong.join("\n"));
    }
    let mut alias = BTreeMap::new();
    for (key, value) in entries {
        let value = value.as_str().expect("checked above");
        // Wrangler's JSONC parser assigns `__proto__` to the object's
        // prototype, which ignores a string, so the key does nothing there.
        if key == "__proto__" {
            bail!(
                "`alias` key \"__proto__\" is refused: Wrangler's config parser drops it, so \
                 it aliases nothing there"
            );
        }
        if value.is_empty() {
            note!("note: `alias` {key:?} has an empty target, so it aliases nothing");
        }
        alias.insert(key.clone(), value.to_string());
    }
    let conditions = cjs_conditions(std::env::var("NODE_OPTIONS").ok().as_deref())
        .context("read NODE_OPTIONS, which Node's resolution of `alias` follows")?;
    Ok(Alias {
        root,
        node: Node { cwd, conditions },
        entries: alias,
    })
}

/// What JavaScript's `typeof` says of a JSON value, as Wrangler's messages
/// use it: `null` and an array are both `object`.
fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Null | Value::Array(_) | Value::Object(_) => "object",
    }
}

impl Alias {
    pub(super) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The plugin's filter as esbuild receives it from Wrangler: each key
    /// escaped by Wrangler's `escapeRegex` (`/[-/\\^$*+?.()|[\]{}]/g`),
    /// joined with `|`, as the `source` of a JavaScript `RegExp` (which
    /// writes a line terminator as an escape, and an empty pattern as
    /// `(?:)`). esbuild compiles it as a Go regular expression.
    pub(super) fn filter(&self) -> String {
        let escaped: Vec<String> = self
            .entries
            .keys()
            .map(|key| {
                let mut out = String::with_capacity(key.len());
                for c in key.chars() {
                    match c {
                        '-' | '/' | '\\' | '^' | '$' | '*' | '+' | '?' | '.' | '(' | ')' | '|'
                        | '[' | ']' | '{' | '}' => {
                            out.push('\\');
                            out.push(c);
                        }
                        '\n' => out.push_str("\\n"),
                        '\r' => out.push_str("\\r"),
                        '\u{2028}' => out.push_str("\\u2028"),
                        '\u{2029}' => out.push_str("\\u2029"),
                        c => out.push(c),
                    }
                }
                out
            })
            .collect();
        let source = escaped.join("|");
        if source.is_empty() {
            "(?:)".to_string()
        } else {
            source
        }
    }

    /// The plugin's answer for an import of `path` that its filter passed.
    pub(super) fn on_resolve(&self, path: &str) -> OnResolve {
        match self.entries.get(path) {
            Some(value) if value.is_empty() => OnResolve::Unaliased,
            Some(value) => match require_resolve(&self.node, &self.root, value) {
                Ok(found) => OnResolve::Path(found),
                Err(error) => OnResolve::Error(format!("{error:#}")),
            },
            None if OBJECT_PROTOTYPE.contains(&path) => OnResolve::Error(format!(
                "Wrangler's alias plugin looks {path:?} up on the alias object, finds \
                 Object.prototype's {path:?}, and fails: The \"request\" argument must be of \
                 type string"
            )),
            None => OnResolve::Unaliased,
        }
    }
}

/// The builtins `require.resolve` returns as they are, by name or with the
/// `node:` scheme (`require('node:module').builtinModules` on Node 26.3).
const NODE_BUILTINS: [&str; 62] = [
    "_http_agent",
    "_http_client",
    "_http_common",
    "_http_incoming",
    "_http_outgoing",
    "_http_server",
    "_tls_common",
    "_tls_wrap",
    "assert",
    "assert/strict",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "constants",
    "crypto",
    "dgram",
    "diagnostics_channel",
    "dns",
    "dns/promises",
    "domain",
    "events",
    "fs",
    "fs/promises",
    "http",
    "http2",
    "https",
    "inspector",
    "inspector/promises",
    "module",
    "net",
    "os",
    "path",
    "path/posix",
    "path/win32",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "readline/promises",
    "repl",
    "stream",
    "stream/consumers",
    "stream/promises",
    "stream/web",
    "string_decoder",
    "sys",
    "timers",
    "timers/promises",
    "tls",
    "trace_events",
    "tty",
    "url",
    "util",
    "util/types",
    "v8",
    "vm",
    "wasi",
    "worker_threads",
    "zlib",
];

/// The builtins valid only with the `node:` scheme.
const SCHEME_ONLY_BUILTINS: [&str; 4] = ["sea", "sqlite", "test", "test/reporters"];

/// `BuiltinModule.normalizeRequirableId`.
fn is_builtin(request: &str) -> bool {
    match request.strip_prefix("node:") {
        Some(name) => NODE_BUILTINS.contains(&name) || SCHEME_ONLY_BUILTINS.contains(&name),
        None => NODE_BUILTINS.contains(&request),
    }
}

/// What Node's resolution reads besides the request and the paths.
struct Node {
    /// `process.cwd()`, for a request that `_resolveLookupPaths` resolves
    /// from `.`.
    cwd: PathBuf,
    /// The CommonJS conditions, besides `default`, which always matches.
    conditions: Vec<String>,
}

/// The CommonJS conditions of Node 26 (`initializeCjsConditions`):
/// `require`, `node`, `node-addons` unless `--no-addons`, each
/// `--conditions` or `-C`, and `module-sync`, since `--require-module` is
/// on by default. Wrangler's Node reads them from `NODE_OPTIONS`, split as
/// `ParseNodeOptionsEnvVar` splits it (`src/node_options.cc`): at spaces
/// outside double quotes, with `\` escaping inside them. The options that
/// would change resolution otherwise are refused.
fn cjs_conditions(node_options: Option<&str>) -> anyhow::Result<Vec<String>> {
    let mut args: Vec<String> = Vec::new();
    let (mut quoted, mut new_arg) = (false, true);
    let mut chars = node_options.unwrap_or("").chars();
    while let Some(mut c) = chars.next() {
        if c == '\\' && quoted {
            c = chars
                .next()
                .context("invalid value for NODE_OPTIONS (invalid escape)")?;
        } else if c == ' ' && !quoted {
            new_arg = true;
            continue;
        } else if c == '"' {
            quoted = !quoted;
            continue;
        }
        if new_arg {
            args.push(c.to_string());
            new_arg = false;
        } else {
            args.last_mut().expect("an argument was started").push(c);
        }
    }
    if quoted {
        bail!("invalid value for NODE_OPTIONS (unterminated string)");
    }
    let mut addons = true;
    let mut user = Vec::new();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        // Node reads `_` in an option's name as `-`.
        let (name, value) = match arg.split_once('=') {
            Some((name, value)) => (name.replace('_', "-"), Some(value.to_string())),
            None => (arg.replace('_', "-"), None),
        };
        match (name.as_str(), value) {
            ("--conditions", Some(value)) => user.push(value),
            ("--conditions" | "-C", None) => user.push(
                args.next()
                    .with_context(|| format!("{name} requires an argument"))?,
            ),
            ("-C", Some(_)) => bail!("{arg} is not allowed in NODE_OPTIONS"),
            ("--no-addons", None) => addons = false,
            ("--addons", None) => addons = true,
            (
                "--preserve-symlinks" | "--no-require-module" | "--no-experimental-require-module",
                _,
            ) => bail!(
                "NODE_OPTIONS sets {name}, which changes how Node resolves an `alias` target; \
                 celld resolves it as Node does by default"
            ),
            _ => {}
        }
    }
    let mut conditions = vec!["require".to_string(), "node".to_string()];
    if addons {
        conditions.push("node-addons".to_string());
    }
    conditions.extend(user);
    conditions.push("module-sync".to_string());
    Ok(conditions)
}

/// Node's `require.resolve(request, { paths: [root] })`
/// (`Module._resolveFilename`), as Wrangler calls it from its own module.
///
/// Two lookups Node would make are not made. Node's global folders
/// (`NODE_PATH`, `~/.node_modules`, `~/.node_libraries`) come after every
/// `node_modules` directory, so a package found only there fails here
/// instead of resolving. And Node first resolves `wrangler` and
/// `wrangler/…` against the running Wrangler's own package (`trySelf`);
/// here they resolve from the project's `node_modules` like any package.
/// Wrangler's package has no `imports`, so a `#name` request falls through
/// to the lookup below in both.
fn require_resolve(node: &Node, root: &Path, request: &str) -> anyhow::Result<String> {
    if is_builtin(request) {
        return Ok(request.to_string());
    }
    let paths = if is_relative(request) {
        vec![root.to_path_buf()]
    } else if request.starts_with("..") {
        // `_resolveLookupPaths` gives a request that starts with `..` but
        // is not relative, such as `..foo`, the parentless `['.']`.
        vec![node.cwd.clone()]
    } else {
        node_module_paths(root)
    };
    let found = find_path(request, &paths, &node.conditions)?
        .ok_or_else(|| anyhow!("Cannot find module '{request}'"))?;
    found
        .into_os_string()
        .into_string()
        .map_err(|path| anyhow!("the alias target resolves to a non-UTF-8 path {path:?}"))
}

/// `isRelative` in Node's CommonJS loader.
fn is_relative(request: &str) -> bool {
    request == "." || request == ".." || request.starts_with("./") || request.starts_with("../")
}

/// `Module._nodeModulePaths` on POSIX: `node_modules` in `from` and each
/// ancestor, skipping a directory that is itself named `node_modules`.
fn node_module_paths(from: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for dir in from.ancestors() {
        if dir.parent().is_none() {
            break;
        }
        if dir.file_name().is_some_and(|name| name == "node_modules") {
            continue;
        }
        paths.push(dir.join("node_modules"));
    }
    paths.push(PathBuf::from("/node_modules"));
    paths
}

/// `path.resolve(base, request)`, lexically: `..` pops a component, `.`
/// and a trailing `/` go.
fn resolve(base: &Path, request: impl AsRef<Path>) -> PathBuf {
    let mut out = PathBuf::new();
    for component in base.join(request).components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// `path.normalize` of a relative request: `.` segments and empty ones go,
/// and `..` cancels the segment before it.
fn normalize(request: &str) -> String {
    let mut segments: Vec<&str> = Vec::new();
    for segment in request.split('/') {
        match segment {
            "" | "." => {}
            ".." if segments.last().is_some_and(|last| *last != "..") => {
                segments.pop();
            }
            segment => segments.push(segment),
        }
    }
    segments.join("/")
}

/// What Node's `internalModuleStat` reports, following symlinks.
#[derive(PartialEq)]
enum Stat {
    File,
    Directory,
    Missing,
}

fn stat(path: &Path) -> Stat {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => Stat::Directory,
        Ok(_) => Stat::File,
        Err(_) => Stat::Missing,
    }
}

/// `tryFile`: the real path of `path` when it is a file.
fn try_file(path: &Path) -> anyhow::Result<Option<PathBuf>> {
    if stat(path) != Stat::File {
        return Ok(None);
    }
    path.canonicalize()
        .map(Some)
        .with_context(|| format!("resolve the real path of {}", path.display()))
}

/// `tryExtensions` with Node's `Module._extensions`.
fn try_extensions(base: &Path) -> anyhow::Result<Option<PathBuf>> {
    for extension in [".js", ".json", ".node"] {
        let mut with = base.as_os_str().to_owned();
        with.push(extension);
        if let Some(found) = try_file(Path::new(&with))? {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

/// `Module._findPath`.
fn find_path(
    request: &str,
    paths: &[PathBuf],
    conditions: &[String],
) -> anyhow::Result<Option<PathBuf>> {
    let absolute = Path::new(request).is_absolute();
    let empty = [PathBuf::new()];
    let paths = if absolute { &empty[..] } else { paths };
    let trailing_slash = request.ends_with('/')
        || request == "."
        || request.ends_with("/.")
        || request == ".."
        || request.ends_with("/..");
    // A relative request that leaves its directory is looked up even when
    // the directory does not exist.
    let inside_path = !(is_relative(request) && normalize(request).starts_with(".."));
    for current in paths {
        if inside_path && !current.as_os_str().is_empty() && stat(current) != Stat::Directory {
            continue;
        }
        if !absolute {
            if let Some(found) = resolve_exports(current, request, conditions)? {
                return Ok(Some(found));
            }
        }
        let base = resolve(current, request);
        let kind = stat(&base);
        let mut found = None;
        if !trailing_slash {
            if kind == Stat::File {
                found = try_file(&base)?;
            }
            if found.is_none() {
                found = try_extensions(&base)?;
            }
        }
        if found.is_none() && kind == Stat::Directory {
            found = try_package(&base)?;
        }
        if found.is_some() {
            return Ok(found);
        }
    }
    Ok(None)
}

/// `tryPackage`: a directory by its `package.json` `main`, then its
/// `index`.
fn try_package(dir: &Path) -> anyhow::Result<Option<PathBuf>> {
    let main = read_package(dir)?.and_then(|package| package.main);
    let Some(main) = main.filter(|main| !main.is_empty()) else {
        return try_extensions(&dir.join("index"));
    };
    let filename = resolve(dir, &main);
    if let Some(found) = try_file(&filename)? {
        return Ok(Some(found));
    }
    if let Some(found) = try_extensions(&filename)? {
        return Ok(Some(found));
    }
    if let Some(found) = try_extensions(&filename.join("index"))? {
        return Ok(Some(found));
    }
    // Node warns (DEP0128) and falls back to the directory's index.
    match try_extensions(&dir.join("index"))? {
        Some(found) => Ok(Some(found)),
        None => bail!(
            "Cannot find module '{}'. Please verify that the package.json has a valid \"main\" \
             entry",
            filename.display()
        ),
    }
}

/// The fields of a `package.json` that resolution reads, as Node's
/// `modulesBinding.readPackageJSON` reads them: a `main` that is a string,
/// an `exports` that is a string, array or object, and a `name` that must
/// be a string when present.
struct Package {
    main: Option<String>,
    exports: Option<Json>,
}

fn read_package(dir: &Path) -> anyhow::Result<Option<Package>> {
    let path = dir.join("package.json");
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(None);
    };
    let invalid = || anyhow!("Invalid package config {}.", path.display());
    let Ok(Json::Object(fields)) = serde_json::from_slice::<Json>(&bytes) else {
        return Err(invalid());
    };
    let mut package = Package {
        main: None,
        exports: None,
    };
    // The reader walks the fields in order, so a repeated key's last
    // readable value is the one kept.
    for (key, value) in fields {
        match (key.as_str(), value) {
            ("name", Json::String(_)) => {}
            ("name", _) => return Err(invalid()),
            ("main", Json::String(main)) => package.main = Some(main),
            ("exports", exports @ (Json::String(_) | Json::Array(_) | Json::Object(_))) => {
                package.exports = Some(exports)
            }
            _ => {}
        }
    }
    Ok(Some(package))
}

/// `EXPORTS_PATTERN` in Node's CommonJS loader: a package name and the
/// rest of the request. JavaScript's `.` stops at a line terminator.
static EXPORTS_PATTERN: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"^((?:@[^/\\%]+/)?[^./\\%][^/\\%]*)(/[^\n\r\u{2028}\u{2029}]*)?$")
        .expect("valid pattern")
});

/// `resolveExports`: the request through its package's `exports`, when
/// the package in `node_modules` has one.
fn resolve_exports(
    node_modules: &Path,
    request: &str,
    conditions: &[String],
) -> anyhow::Result<Option<PathBuf>> {
    let Some(captures) = EXPORTS_PATTERN.captures(request) else {
        return Ok(None);
    };
    let name = &captures[1];
    let expansion = captures.get(2).map_or("", |m| m.as_str());
    let dir = resolve(node_modules, name);
    let Some(Package {
        exports: Some(exports),
        ..
    }) = read_package(&dir)?
    else {
        return Ok(None);
    };
    let package_json = dir.join("package.json");
    let package_url = Url::from_file_path(&package_json)
        .map_err(|()| anyhow!("{} is not an absolute path", package_json.display()))?;
    let resolved = exports_resolve(&package_url, &format!(".{expansion}"), &exports, conditions)?;
    // `finalizeEsmResolution`.
    if ENCODED_SEPARATOR.is_match(resolved.as_str()) {
        bail!("Invalid module \"{resolved}\" must not include encoded \"/\" or \"\\\" characters");
    }
    let filename = resolved
        .to_file_path()
        .map_err(|()| anyhow!("{resolved} is not a file path"))?;
    match try_file(&filename)? {
        Some(found) => Ok(Some(found)),
        None => bail!("Cannot find module '{}'", filename.display()),
    }
}

/// `encodedSepRegEx`. Node's `/i` without `u` folds ASCII only (`ſ` is
/// not `s`), hence `-u` in this pattern and the next.
static ENCODED_SEPARATOR: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i-u)%2F|%5C").expect("valid pattern"));

/// `deprecatedInvalidSegmentRegEx` in Node's ESM resolver: a `.`, `..` or
/// `node_modules` segment, any of them percent-encoded. A target or
/// subpath with one is refused. Node's wider `invalidSegmentRegEx`, which
/// also matches an empty segment, only warns.
static INVALID_SEGMENT: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i-u)(^|\\|/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))(\\|/|$)",
    )
    .expect("valid pattern")
});

/// An `exports` target that Node skips in an array of fallbacks
/// (`ERR_INVALID_PACKAGE_TARGET`).
#[derive(Debug)]
struct InvalidTarget(String);

impl std::fmt::Display for InvalidTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for InvalidTarget {}

/// The directory of a `package.json` URL, with its trailing `/`, as Node's
/// messages print it.
fn package_dir(package_url: &Url) -> String {
    package_url
        .join(".")
        .ok()
        .and_then(|url| url.to_file_path().ok())
        .map(|path| {
            let mut dir = path.display().to_string();
            if !dir.ends_with('/') {
                dir.push('/');
            }
            dir
        })
        .unwrap_or_default()
}

fn invalid_target(package_url: &Url, key: &str, target: &str) -> anyhow::Error {
    let quoted = serde_json::to_string(target).expect("a string serializes");
    let hint = if !target.is_empty() && !target.starts_with("./") {
        "; targets must start with \"./\""
    } else {
        ""
    };
    let dir = package_dir(package_url);
    anyhow::Error::new(InvalidTarget(if key == "." {
        format!(
            "Invalid \"exports\" main target {quoted} defined in the package config \
             {dir}package.json{hint}"
        )
    } else {
        format!(
            "Invalid \"exports\" target {quoted} defined for '{key}' in the package config \
             {dir}package.json{hint}"
        )
    }))
}

fn not_exported(package_url: &Url, subpath: &str) -> anyhow::Error {
    let dir = package_dir(package_url);
    if subpath == "." {
        anyhow!("No \"exports\" main defined in {dir}package.json")
    } else {
        anyhow!("Package subpath '{subpath}' is not defined by \"exports\" in {dir}package.json")
    }
}

fn invalid_config(package_url: &Url, message: &str) -> anyhow::Error {
    let path = package_url
        .to_file_path()
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    anyhow!("Invalid package config {path}. {message}")
}

/// `packageExportsResolve`.
fn exports_resolve(
    package_url: &Url,
    subpath: &str,
    exports: &Json,
    conditions: &[String],
) -> anyhow::Result<Url> {
    let sugar;
    let map = match exports {
        Json::String(_) | Json::Array(_) => {
            sugar = vec![(".", exports)];
            &sugar
        }
        Json::Object(_) => {
            let entries = exports.entries();
            // `isConditionalExportsMainSugar`.
            let conditional = |key: &str| key.is_empty() || !key.starts_with('.');
            let first = entries.first().map(|(key, _)| conditional(key));
            if entries
                .iter()
                .any(|(key, _)| Some(conditional(key)) != first)
            {
                return Err(invalid_config(
                    package_url,
                    "\"exports\" cannot contain some keys starting with '.' and some not. The \
                     exports object must either be an object of package subpath keys or an \
                     object of main entry condition name keys only.",
                ));
            }
            if first == Some(true) {
                sugar = vec![(".", exports)];
            } else {
                sugar = entries;
            }
            &sugar
        }
        _ => unreachable!("read_package keeps only a string, array or object"),
    };
    if !subpath.contains('*') && !subpath.ends_with('/') {
        if let Some((_, target)) = map.iter().find(|(key, _)| *key == subpath) {
            return match resolve_target(package_url, target, None, subpath, conditions)? {
                Target::Url(url) => Ok(url),
                Target::Null | Target::Undefined => Err(not_exported(package_url, subpath)),
            };
        }
    }
    let mut best: Option<(&str, &str)> = None;
    for (key, _) in map {
        let Some(star) = key.find('*') else {
            continue;
        };
        if !subpath.starts_with(&key[..star]) {
            continue;
        }
        // Node warns (DEP0155) for a subpath ending in `/` here.
        let trailer = &key[star + 1..];
        if subpath.len() >= key.len()
            && subpath.ends_with(trailer)
            && pattern_key_compare(best.map_or("", |(key, _)| key), key) == 1
            && key.rfind('*') == Some(star)
        {
            best = Some((key, &subpath[star..subpath.len() - trailer.len()]));
        }
    }
    let Some((key, matched)) = best else {
        return Err(not_exported(package_url, subpath));
    };
    let target = map
        .iter()
        .find(|(candidate, _)| *candidate == key)
        .map(|(_, target)| *target)
        .expect("the best match is a key");
    match resolve_target(package_url, target, Some(matched), key, conditions)? {
        Target::Url(url) => Ok(url),
        Target::Null | Target::Undefined => Err(not_exported(package_url, subpath)),
    }
}

/// `patternKeyCompare`.
fn pattern_key_compare(a: &str, b: &str) -> i32 {
    let a_star = a.find('*');
    let b_star = b.find('*');
    let base_a = a_star.map_or(a.len(), |index| index + 1);
    let base_b = b_star.map_or(b.len(), |index| index + 1);
    if base_a > base_b {
        return -1;
    }
    if base_b > base_a {
        return 1;
    }
    if a_star.is_none() {
        return 1;
    }
    if b_star.is_none() {
        return -1;
    }
    match a.len().cmp(&b.len()) {
        std::cmp::Ordering::Greater => -1,
        std::cmp::Ordering::Less => 1,
        std::cmp::Ordering::Equal => 0,
    }
}

/// What `resolvePackageTarget` returns: a URL, `null` (excluded), or
/// `undefined` (no condition matched).
enum Target {
    Url(Url),
    Null,
    Undefined,
}

/// `resolvePackageTarget` for `exports`, with the CommonJS conditions.
/// `pattern` is the part of the subpath a `*` key matched.
fn resolve_target(
    package_url: &Url,
    target: &Json,
    pattern: Option<&str>,
    key: &str,
    conditions: &[String],
) -> anyhow::Result<Target> {
    match target {
        Json::String(target) => resolve_target_string(package_url, target, pattern, key),
        Json::Array(items) => {
            if items.is_empty() {
                return Ok(Target::Null);
            }
            // The last outcome decides when no item resolves: an invalid
            // target's error, a `null`, or nothing.
            let mut last: Option<anyhow::Error> = None;
            let mut null = false;
            for item in items {
                match resolve_target(package_url, item, pattern, key, conditions) {
                    Err(error) if error.is::<InvalidTarget>() => {
                        last = Some(error);
                        null = false;
                    }
                    Err(error) => return Err(error),
                    Ok(Target::Undefined) => {}
                    Ok(Target::Null) => {
                        last = None;
                        null = true;
                    }
                    Ok(url) => return Ok(url),
                }
            }
            match last {
                Some(error) => Err(error),
                None if null => Ok(Target::Null),
                None => Ok(Target::Undefined),
            }
        }
        Json::Object(_) => {
            let entries = target.entries();
            if entries.iter().any(|(key, _)| is_array_index(key)) {
                return Err(invalid_config(
                    package_url,
                    "\"exports\" cannot contain numeric property keys.",
                ));
            }
            for (condition, value) in entries {
                if condition == "default" || conditions.iter().any(|c| c == condition) {
                    match resolve_target(package_url, value, pattern, key, conditions)? {
                        Target::Undefined => continue,
                        resolved => return Ok(resolved),
                    }
                }
            }
            Ok(Target::Undefined)
        }
        Json::Null => Ok(Target::Null),
        Json::Bool(value) => Err(invalid_target(package_url, key, &value.to_string())),
        Json::Number(value) => Err(invalid_target(package_url, key, &value.to_string())),
    }
}

/// `isArrayIndex`: a key that JavaScript orders as an array index.
fn is_array_index(key: &str) -> bool {
    key.parse::<u32>()
        .is_ok_and(|index| index < u32::MAX && index.to_string() == key)
}

/// `resolvePackageTargetString` for `exports`.
fn resolve_target_string(
    package_url: &Url,
    target: &str,
    pattern: Option<&str>,
    key: &str,
) -> anyhow::Result<Target> {
    if !target.starts_with("./") || INVALID_SEGMENT.is_match(&target[2..]) {
        return Err(invalid_target(package_url, key, target));
    }
    let resolved = package_url
        .join(target)
        .map_err(|_| invalid_target(package_url, key, target))?;
    let package_path = package_url
        .join(".")
        .map(|url| url.path().to_string())
        .unwrap_or_default();
    if !resolved.path().starts_with(&package_path) {
        return Err(invalid_target(package_url, key, target));
    }
    let Some(matched) = pattern else {
        return Ok(Target::Url(resolved));
    };
    if INVALID_SEGMENT.is_match(matched) {
        bail!(
            "Invalid module \"{}\" request is not a valid match in pattern \"{key}\" for the \
             \"exports\" resolution of {}",
            key.replacen('*', matched, 1),
            package_url
                .to_file_path()
                .map(|path| path.display().to_string())
                .unwrap_or_default()
        );
    }
    let replaced = resolved.as_str().replace('*', matched);
    Url::parse(&replaced)
        .map(Target::Url)
        .with_context(|| format!("parse the resolved URL {replaced}"))
}

/// A JSON value with its object keys in source order, which `exports`
/// conditions depend on, and every repeated key kept.
#[derive(Clone, Debug, PartialEq)]
enum Json {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    /// An object's entries as `JSON.parse` leaves them: a repeated key
    /// keeps its first position and its last value.
    fn entries(&self) -> Vec<(&str, &Json)> {
        let Json::Object(fields) = self else {
            return Vec::new();
        };
        let mut entries: Vec<(&str, &Json)> = Vec::with_capacity(fields.len());
        for (key, value) in fields {
            match entries.iter_mut().find(|(seen, _)| *seen == key) {
                Some(entry) => entry.1 = value,
                None => entries.push((key, value)),
            }
        }
        entries
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct JsonVisitor;

        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = Json;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JSON value")
            }

            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }

            fn visit_bool<E>(self, value: bool) -> Result<Json, E> {
                Ok(Json::Bool(value))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Json, E> {
                Ok(Json::Number(value.into()))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Json, E> {
                Ok(Json::Number(value.into()))
            }

            fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Json, E> {
                serde_json::Number::from_f64(value)
                    .map(Json::Number)
                    .ok_or_else(|| E::custom("a JSON number is finite"))
            }

            fn visit_str<E>(self, value: &str) -> Result<Json, E> {
                Ok(Json::String(value.to_string()))
            }

            fn visit_string<E>(self, value: String) -> Result<Json, E> {
                Ok(Json::String(value))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Json::Array(items))
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                let mut fields = Vec::new();
                while let Some(field) = map.next_entry()? {
                    fields.push(field);
                }
                Ok(Json::Object(fields))
            }
        }

        deserializer.deserialize_any(JsonVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn object(value: Value) -> Map<String, Value> {
        let Value::Object(object) = value else {
            panic!("test config must be an object");
        };
        object
    }

    fn alias(entries: Value, root: &Path) -> anyhow::Result<Alias> {
        read_alias(&object(json!({ "alias": entries })), root)
    }

    #[test]
    fn alias_must_be_an_object_of_strings() {
        let refusal =
            |entries: Value| format!("{:#}", alias(entries, Path::new(".")).err().unwrap());
        assert_eq!(
            refusal(json!("x")),
            "Expected alias to be an object, but got string"
        );
        assert_eq!(refusal(json!(null)), "`alias` must be an object, not null");
        assert_eq!(
            refusal(json!([])),
            "`alias` must be an object, not an array"
        );
        assert_eq!(
            refusal(json!({ "a": 1, "b": "./c", "d": null })),
            "Expected alias[\"a\"] to be a string, but got number\n\
             Expected alias[\"d\"] to be a string, but got object"
        );
        assert!(refusal(json!({ "__proto__": "./a.js" })).contains("\"__proto__\" is refused"));
        // Any key is an import path, and a target is not resolved until its
        // key is imported.
        let read = alias(
            json!({ "./x.js": "./missing", "pkg/": "", "a/../b": "x", "": "y" }),
            Path::new("."),
        )
        .unwrap();
        assert_eq!(read.entries.len(), 4);
        assert!(read_alias(&Map::new(), Path::new(".")).unwrap().is_empty());
    }

    /// The `source` of Wrangler's `new RegExp(keys.map(escapeRegex).join("|"))`.
    #[test]
    fn the_filter_is_wranglers_pattern() {
        let filter = |entries: Value| alias(entries, Path::new(".")).unwrap().filter();
        assert_eq!(filter(json!({})), "(?:)");
        assert_eq!(
            filter(json!({ "./generated/bundled-blueprints.js": "./b.ts", "@scope/pkg": "./c" })),
            r"\.\/generated\/bundled\-blueprints\.js|@scope\/pkg"
        );
        assert_eq!(
            filter(json!({ "a^$*+?()|[]{}\\b": "./x", "line\n\u{2028}": "./y" })),
            r"a\^\$\*\+\?\(\)\|\[\]\{\}\\b|line\n\u2028"
        );
    }

    #[test]
    fn an_import_matches_a_key_literally() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.js"), "").unwrap();
        let alias = alias(
            json!({ "./gen.js": "./a.js", "pkg": "./a.js", "empty": "", "gone": "./missing", "t": "./a.js" }),
            root.path(),
        )
        .unwrap();
        let a = root.path().join("a.js").canonicalize().unwrap();
        let a = OnResolve::Path(a.to_str().unwrap().to_string());
        assert_eq!(alias.on_resolve("./gen.js"), a);
        assert_eq!(alias.on_resolve("pkg"), a);
        // A path that only contains a key passes the filter and is left
        // alone, as are subpaths of a key.
        assert_eq!(alias.on_resolve("./gen.jsx"), OnResolve::Unaliased);
        assert_eq!(alias.on_resolve("pkg/sub"), OnResolve::Unaliased);
        assert_eq!(alias.on_resolve("empty"), OnResolve::Unaliased);
        assert_eq!(
            alias.on_resolve("gone"),
            OnResolve::Error("Cannot find module './missing'".to_string())
        );
        // `alias["toString"]` is Object.prototype's under Wrangler.
        let OnResolve::Error(error) = alias.on_resolve("toString") else {
            panic!("toString resolved");
        };
        assert!(error.contains("Object.prototype"), "{error}");
    }

    /// `require.resolve(request, { paths: [<root>/project] })` on Node
    /// 26.3 in `<root>/cwd`, without NODE_OPTIONS, for each request on the
    /// tree below. Recorded from Node.
    const TREE: &[(&str, &str)] = &[
        ("project/lib/file.ts", ""),
        ("project/lib/noext.js", ""),
        ("project/lib/both.js", ""),
        ("project/lib/both/index.js", ""),
        ("project/lib/main/entry.js", ""),
        ("project/lib/main/package.json", "{ \"main\": \"entry\" }"),
        ("project/lib/index/index.js", ""),
        ("project/lib/badmain/index.json", ""),
        ("project/lib/badmain/package.json", "{ \"main\": \"missing.js\" }"),
        ("project/lib/nomain/package.json", "{ \"main\": \"missing.js\" }"),
        ("project/lib/notjson/index.js", ""),
        ("project/lib/notjson/package.json", "{ not json"),
        ("project/lib/badname/index.js", ""),
        ("project/lib/badname/package.json", "{ \"name\": 5 }"),
        ("project/lib/mainnum/index.js", ""),
        ("project/lib/mainnum/package.json", "{ \"main\": 5 }"),
        ("node_modules/up/index.js", ""),
        ("project/node_modules/cond/package.json", "{\"main\": \"main.js\", \"exports\": {\".\": {\"workerd\": \"./workerd.js\", \"import\": \"./esm.mjs\", \"node\": {\"import\": \"./node.mjs\", \"require\": \"./node.cjs\"}, \"require\": \"./req.cjs\"}, \"./sub\": {\"require\": \"./sub.cjs\", \"default\": \"./sub.js\"}, \"./import-only\": {\"import\": \"./x.mjs\"}, \"./excluded\": null, \"./fallback\": [\"../outside.js\", \"./fb.js\"], \"./fallback-null\": [null, \"./fb.js\"], \"./fallback-bad\": [\"bad.js\"], \"./missing\": \"./nope.js\", \"./lib/*\": \"./lib/*.js\", \"./lib/deep/*\": \"./deep/*.js\", \"./star/*/end.js\": \"./star/*/e.js\", \"./space\": \"./a%20b.js\", \"./dotdot/*\": \"./d/*\", \"./nm\": \"./node_modules/x.js\", \"./long-s\": \"./node_module\\u017f/x.js\", \"./upper\": \"./NODE_MODULES/x.js\"}}"),
        ("project/node_modules/cond/main.js", ""),
        ("project/node_modules/cond/node.cjs", ""),
        ("project/node_modules/cond/req.cjs", ""),
        ("project/node_modules/cond/sub.cjs", ""),
        ("project/node_modules/cond/fb.js", ""),
        ("project/node_modules/cond/lib/a.js", ""),
        ("project/node_modules/cond/lib/a/b.js", ""),
        ("project/node_modules/cond/deep/c.js", ""),
        ("project/node_modules/cond/star/q/e.js", ""),
        ("project/node_modules/cond/a b.js", ""),
        ("project/node_modules/cond/d/x.js", ""),
        ("project/node_modules/sugar/package.json", "{ \"exports\": \"./s.js\" }"),
        ("project/node_modules/sugar/s.js", ""),
        ("project/node_modules/sugarcond/package.json", "{ \"exports\": { \"require\": \"./r.js\", \"default\": \"./d.js\" } }"),
        ("project/node_modules/sugarcond/r.js", ""),
        ("project/node_modules/mixed/package.json", "{ \"exports\": { \".\": \"./a.js\", \"require\": \"./b.js\" } }"),
        ("project/node_modules/numeric/package.json", "{ \"exports\": { \"0\": \"./a.js\" } }"),
        ("project/node_modules/@scope/pkg/package.json", "{ \"exports\": { \"./x\": \"./x.js\" } }"),
        ("project/node_modules/@scope/pkg/x.js", ""),
        ("project/node_modules/plain/index.js", ""),
        ("project/node_modules/plain/other.js", ""),
        ("project/node_modules/dup/package.json", "{ \"exports\": { \"require\": \"./first.js\", \"import\": \"./i.js\", \"require\": \"./last.js\" } }"),
        ("project/node_modules/dup/first.js", ""),
        ("project/node_modules/dup/last.js", ""),
        ("project/node_modules/emptyexports/package.json", "{ \"exports\": {} }"),
        ("project/node_modules/nullexports/package.json", "{ \"exports\": null, \"main\": \"m.js\" }"),
        ("project/node_modules/nullexports/m.js", ""),
        ("project/node_modules/cond/node_moduleſ/x.js", ""),
        ("cwd/..foo.js", ""),
        ("cwd/.../x.js", ""),
        ("project/..foo.js", ""),
        ("project/node_modules/.x/index.js", ""),
    ];
    const RESOLVED: &[(&str, &str)] = &[
        ("./lib/file.ts", "<root>/project/lib/file.ts"),
        ("./lib/noext", "<root>/project/lib/noext.js"),
        ("./lib/both", "<root>/project/lib/both.js"),
        ("./lib/both/", "<root>/project/lib/both/index.js"),
        ("./lib/main", "<root>/project/lib/main/entry.js"),
        ("./lib/index/", "<root>/project/lib/index/index.js"),
        ("./lib/index", "<root>/project/lib/index/index.js"),
        ("./lib/badmain", "<root>/project/lib/badmain/index.json"),
        ("./lib/nomain", "ERR Cannot find module '<root>/project/lib/nomain/missing.js'. Please verify that the package.json has a valid \"main\" entry"),
        ("./lib/notjson", "ERR Invalid package config <root>/project/lib/notjson/package.json."),
        ("./lib/badname", "ERR Invalid package config <root>/project/lib/badname/package.json."),
        ("./lib/mainnum", "<root>/project/lib/mainnum/index.js"),
        ("./lib/file", "ERR Cannot find module './lib/file'"),
        ("lib/file.ts", "ERR Cannot find module 'lib/file.ts'"),
        ("up", "<root>/node_modules/up/index.js"),
        ("fs", "fs"),
        ("node:fs", "node:fs"),
        ("node:test", "node:test"),
        ("test", "ERR Cannot find module 'test'"),
        ("node:nope", "ERR Cannot find module 'node:nope'"),
        ("fs/promises", "fs/promises"),
        ("cond", "<root>/project/node_modules/cond/node.cjs"),
        ("cond/sub", "<root>/project/node_modules/cond/sub.cjs"),
        ("cond/import-only", "ERR Package subpath './import-only' is not defined by \"exports\" in <root>/project/node_modules/cond/package.json"),
        ("cond/excluded", "ERR Package subpath './excluded' is not defined by \"exports\" in <root>/project/node_modules/cond/package.json"),
        ("cond/fallback", "<root>/project/node_modules/cond/fb.js"),
        ("cond/fallback-null", "<root>/project/node_modules/cond/fb.js"),
        ("cond/fallback-bad", "ERR Invalid \"exports\" target \"bad.js\" defined for './fallback-bad' in the package config <root>/project/node_modules/cond/package.json; targets must start with \"./\""),
        ("cond/missing", "ERR Cannot find module '<root>/project/node_modules/cond/nope.js'"),
        ("cond/lib/a", "<root>/project/node_modules/cond/lib/a.js"),
        ("cond/lib/a/b", "<root>/project/node_modules/cond/lib/a/b.js"),
        ("cond/lib/deep/c", "<root>/project/node_modules/cond/deep/c.js"),
        ("cond/star/q/end.js", "<root>/project/node_modules/cond/star/q/e.js"),
        ("cond/space", "<root>/project/node_modules/cond/a b.js"),
        ("cond/dotdot/../x", "ERR Invalid module \"./dotdot/../x\" request is not a valid match in pattern \"./dotdot/*\" for the \"exports\" resolution of <root>/project/node_modules/cond/package.json"),
        ("cond/dotdot/x.js", "<root>/project/node_modules/cond/d/x.js"),
        ("cond/nm", "ERR Invalid \"exports\" target \"./node_modules/x.js\" defined for './nm' in the package config <root>/project/node_modules/cond/package.json"),
        ("cond/main.js", "ERR Package subpath './main.js' is not defined by \"exports\" in <root>/project/node_modules/cond/package.json"),
        ("cond/package.json", "ERR Package subpath './package.json' is not defined by \"exports\" in <root>/project/node_modules/cond/package.json"),
        ("sugar", "<root>/project/node_modules/sugar/s.js"),
        ("sugar/s.js", "ERR Package subpath './s.js' is not defined by \"exports\" in <root>/project/node_modules/sugar/package.json"),
        ("sugarcond", "<root>/project/node_modules/sugarcond/r.js"),
        ("mixed", "ERR Invalid package config <root>/project/node_modules/mixed/package.json. \"exports\" cannot contain some keys starting with '.' and some not. The exports object must either be an object of package subpath keys or an object of main entry condition name keys only."),
        ("numeric", "ERR Invalid package config <root>/project/node_modules/numeric/package.json. \"exports\" cannot contain numeric property keys."),
        ("@scope/pkg/x", "<root>/project/node_modules/@scope/pkg/x.js"),
        ("@scope/pkg", "ERR No \"exports\" main defined in <root>/project/node_modules/@scope/pkg/package.json"),
        ("plain", "<root>/project/node_modules/plain/index.js"),
        ("plain/other", "<root>/project/node_modules/plain/other.js"),
        ("dup", "<root>/project/node_modules/dup/last.js"),
        ("emptyexports", "ERR No \"exports\" main defined in <root>/project/node_modules/emptyexports/package.json"),
        ("nullexports", "<root>/project/node_modules/nullexports/m.js"),
        ("nope", "ERR Cannot find module 'nope'"),
        (".", "<root>/project/index.js"),
        ("./", "<root>/project/index.js"),
        ("./lib/../lib/noext", "<root>/project/lib/noext.js"),
        ("..foo", "<root>/cwd/..foo.js"),
        (".../x", "<root>/cwd/.../x.js"),
        (".x", "<root>/project/node_modules/.x/index.js"),
        ("cond/long-s", "<root>/project/node_modules/cond/node_moduleſ/x.js"),
        ("cond/upper", "ERR Invalid \"exports\" target \"./NODE_MODULES/x.js\" defined for './upper' in the package config <root>/project/node_modules/cond/package.json"),
    ];

    #[test]
    fn require_resolve_matches_node() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        for (path, contents) in TREE.iter().chain(&[("project/index.js", "")]) {
            let path = root.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, contents).unwrap();
        }
        let base = root.join("project");
        let node = Node {
            cwd: root.join("cwd"),
            conditions: cjs_conditions(None).unwrap(),
        };
        let root = root.to_str().unwrap();
        for (request, expected) in RESOLVED {
            let actual = match require_resolve(&node, &base, request) {
                Ok(found) => found.replace(root, "<root>"),
                Err(error) => format!("ERR {}", format!("{error:#}").replace(root, "<root>")),
            };
            assert_eq!(actual, *expected, "{request}");
        }
    }

    /// The conditions `NODE_OPTIONS` sets, and what Node resolves under
    /// each for `{ "custom": "./c.js", "other": "./o.js", "node-addons":
    /// "./a.js", "default": "./d.js" }`. Recorded from Node 26.3.
    #[test]
    fn node_options_set_the_conditions() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let package = root.join("node_modules/p");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"exports":{"custom":"./c.js","other":"./o.js","node-addons":"./a.js","default":"./d.js"}}"#,
        )
        .unwrap();
        for file in ["c.js", "o.js", "a.js", "d.js"] {
            std::fs::write(package.join(file), "").unwrap();
        }
        for (options, expected) in [
            ("", "a.js"),
            ("--conditions=custom", "c.js"),
            ("--conditions custom", "c.js"),
            ("-C custom", "c.js"),
            ("\"--conditions=custom\"", "c.js"),
            ("--conditions=\"cus tom\"", "a.js"),
            ("-C other -C custom", "c.js"),
            ("--no-addons", "d.js"),
            ("--no-addons -C custom", "c.js"),
            ("--max-old-space-size=4096  -C  custom", "c.js"),
        ] {
            let node = Node {
                cwd: root.clone(),
                conditions: cjs_conditions(Some(options)).unwrap(),
            };
            let found = require_resolve(&node, &root, "p").unwrap();
            assert!(
                found.ends_with(&format!("/{expected}")),
                "{options}: {found}"
            );
        }
        let refusal = |options: &str| format!("{:#}", cjs_conditions(Some(options)).unwrap_err());
        assert_eq!(
            refusal("-C=custom"),
            "-C=custom is not allowed in NODE_OPTIONS"
        );
        assert_eq!(refusal("--conditions"), "--conditions requires an argument");
        assert!(refusal("\"-C").contains("unterminated string"));
        assert!(refusal("\"a\\").contains("invalid escape"));
        assert!(refusal("--preserve-symlinks").contains("changes how Node resolves"));
        assert_eq!(
            cjs_conditions(Some("-C \"a \\\" b\"")).unwrap(),
            ["require", "node", "node-addons", "a \" b", "module-sync"]
        );
    }

    /// JavaScript's `/i` without `u` folds ASCII only.
    #[test]
    fn segment_checks_fold_ascii_case_only() {
        assert!(INVALID_SEGMENT.is_match("NODE_MODULES/x.js"));
        assert!(INVALID_SEGMENT.is_match("a/%2E%2e/b"));
        assert!(!INVALID_SEGMENT.is_match("node_module\u{17f}/x.js"));
        assert!(ENCODED_SEPARATOR.is_match("a%2fb"));
    }

    #[test]
    fn node_module_paths_skip_node_modules_directories() {
        assert_eq!(
            node_module_paths(Path::new("/a/node_modules/b")),
            [
                "/a/node_modules/b/node_modules",
                "/a/node_modules",
                "/node_modules"
            ]
            .map(PathBuf::from)
        );
        assert_eq!(
            node_module_paths(Path::new("/")),
            [PathBuf::from("/node_modules")]
        );
    }
}
