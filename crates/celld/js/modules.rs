// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! ES module resolution and compilation.
//!
//! A specifier is either a builtin, whose source this module holds, or an
//! import of another worker, which resolves through the loader. Most builtins
//! are lazy: a module compiles the first time something reads its global, so
//! a worker that never touches `node:zlib` never compiles it.
use super::*;

macro_rules! static_source {
    ($name:ident, $file:literal) => {
        static $name: v8::OneByteConst =
            v8::String::create_external_onebyte_const(include_bytes!($file));
    };
}

static_source!(NODE_ASSERT_SOURCE, "node_assert.js");
static_source!(NODE_TIMERS_SOURCE, "node_timers.js");
static_source!(NODE_TEST_SOURCE, "node_test.js");
static_source!(NODE_UTIL_SOURCE, "node_util.js");
static_source!(NODE_EVENTS_SOURCE, "node_events.js");
static_source!(NODE_OS_SOURCE, "node_os.js");
static_source!(NODE_PATH_SOURCE, "node_path.js");
static_source!(NODE_BUFFER_SOURCE, "node_buffer.js");
static_source!(NODE_CRYPTO_SOURCE, "node_crypto.js");
static_source!(NODE_ASYNC_HOOKS_SOURCE, "node_async_hooks.js");
static_source!(
    NODE_DIAGNOSTICS_CHANNEL_SOURCE,
    "node_diagnostics_channel.js"
);
static_source!(NODE_STREAM_SOURCE, "node_stream.js");
static_source!(NODE_ZLIB_SOURCE, "node_zlib.js");
static_source!(
    IDENTITY_TRANSFORM_STREAM_SOURCE,
    "identity_transform_stream.js"
);
static_source!(COMPRESSION_STREAMS_SOURCE, "compression_streams.js");
static_source!(BYTE_STREAMS_SOURCE, "byte_streams.js");
static_source!(SET_IMMEDIATE_SOURCE, "set_immediate.js");
static_source!(URL_PATTERN_SOURCE, "url_pattern.js");
static_source!(PERFORMANCE_SOURCE, "performance.js");

#[cfg(all(test, celld_internal_tests))]
static INTERNAL_MODULE_SOURCES: &[(&str, &v8::OneByteConst)] = &[
    ("node_assert.js", &NODE_ASSERT_SOURCE),
    ("node_timers.js", &NODE_TIMERS_SOURCE),
    ("node_test.js", &NODE_TEST_SOURCE),
    ("node_util.js", &NODE_UTIL_SOURCE),
    ("node_events.js", &NODE_EVENTS_SOURCE),
    ("node_os.js", &NODE_OS_SOURCE),
    ("node_path.js", &NODE_PATH_SOURCE),
    ("node_buffer.js", &NODE_BUFFER_SOURCE),
    ("node_crypto.js", &NODE_CRYPTO_SOURCE),
    ("node_async_hooks.js", &NODE_ASYNC_HOOKS_SOURCE),
    (
        "node_diagnostics_channel.js",
        &NODE_DIAGNOSTICS_CHANNEL_SOURCE,
    ),
    ("node_stream.js", &NODE_STREAM_SOURCE),
    ("node_zlib.js", &NODE_ZLIB_SOURCE),
    (
        "identity_transform_stream.js",
        &IDENTITY_TRANSFORM_STREAM_SOURCE,
    ),
    ("compression_streams.js", &COMPRESSION_STREAMS_SOURCE),
    ("byte_streams.js", &BYTE_STREAMS_SOURCE),
    ("set_immediate.js", &SET_IMMEDIATE_SOURCE),
    ("url_pattern.js", &URL_PATTERN_SOURCE),
    ("performance.js", &PERFORMANCE_SOURCE),
];

#[cfg(all(test, celld_internal_tests))]
pub(super) fn internal_sources_for_test<'s>(
    scope: &mut v8::PinScope<'s, '_>,
) -> Vec<(&'static str, v8::Local<'s, v8::String>)> {
    let mut sources = Vec::with_capacity(INTERNAL_MODULE_SOURCES.len());
    for &(name, source) in INTERNAL_MODULE_SOURCES {
        sources.push((name, v8_strings::source(scope, source)));
    }
    sources
}

pub(super) fn compile_module<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    name: &str,
    src: &str,
) -> Option<v8::Local<'s, v8::Module>> {
    let name = v8::String::new(scope, name)?;
    let source = v8::String::new(scope, src)?;
    let origin = v8::ScriptOrigin::new(
        scope,
        name.into(),
        0,
        0,
        false,
        0,
        None,
        false,
        false,
        true,
        None,
    );
    let mut src = v8::script_compiler::Source::new(source, Some(&origin));
    v8::script_compiler::compile_module(scope, &mut src)
}

/// specifier -> pre-compiled module. Plain keys serve static resolution, and
/// `dyn:` keys serve dynamic resolution and cache full-surface builtins.
///
/// **An isolate slot, not a thread-local.** These are `Global<Module>`
/// handles into *one* isolate's heap. Under D1 several isolates are built and
/// entered from the same thread, so a thread-local made them share one
/// table: `register_stubs` clearing it for a new isolate wiped a live one's
/// stubs, and `dynamic_namespace` could localise a handle belonging to a
/// different isolate — not a wrong answer but an invalid one. The registry
/// belongs to the isolate because its contents do.
#[derive(Default)]
pub(super) struct ModuleRegistry {
    modules: Mutex<HashMap<String, v8::Global<v8::Module>>>,
    /// Canonical names for source modules. V8 passes only the referrer module
    /// to the static resolve callback, so the registry must retain the name
    /// that relative imports use as their base.
    source_names: Mutex<Vec<(v8::Global<v8::Module>, String)>>,
    /// The host-generated stubs: the only modules whose `celld:internals`
    /// import resolves. A user module that names the specifier is refused
    /// by [`resolve_external`], so the internals object stays out of reach
    /// of every bundle and every loaded worker.
    trusted: Mutex<Vec<v8::Global<v8::Module>>>,
    internals: Mutex<Option<v8::Global<v8::Module>>>,
}

impl ModuleRegistry {
    /// Register `module` under every spec in `specs`. `trusted` admits it to
    /// `celld:internals`, and is the only way in: every host-generated stub
    /// registers here, and a user module never passes `true`.
    fn register(
        &self,
        scope: &mut v8::PinScope,
        specs: impl IntoIterator<Item = String>,
        module: v8::Local<v8::Module>,
        trusted: bool,
        source_name: Option<&str>,
    ) {
        let global = v8::Global::new(scope, module);
        if trusted {
            self.trusted.lock().unwrap().push(global.clone());
        }
        if let Some(source_name) = source_name {
            self.source_names
                .lock()
                .unwrap()
                .push((global.clone(), source_name.to_string()));
        }
        let mut modules = self.modules.lock().unwrap();
        for spec in specs {
            modules.insert(spec, global.clone());
        }
    }

    fn source_name(
        &self,
        scope: &mut v8::PinScope,
        module: v8::Local<v8::Module>,
    ) -> Option<String> {
        self.source_names
            .lock()
            .unwrap()
            .iter()
            .find(|(registered, _)| v8::Local::new(scope, registered) == module)
            .map(|(_, name)| name.clone())
    }

    fn trusts(&self, scope: &mut v8::PinScope, module: v8::Local<v8::Module>) -> bool {
        self.trusted
            .lock()
            .unwrap()
            .iter()
            .any(|trusted| v8::Local::new(scope, trusted) == module)
    }
}

/// The specifier the stubs import the internals object from. It is not a
/// builtin ([`BuiltinModules::provides`]), so a dynamic import() of it
/// rejects, and a static import from a user module fails to link.
const INTERNALS_SPECIFIER: &str = "celld:internals";

/// The host module of the Python Worker bundle that `celld deploy` builds.
/// Its exports condemn the calling isolate (`op_isolate_condemn`) and start
/// the interpreter in the isolate's startup window (`op_python_startup`).
const PYTHON_HOST_SPECIFIER: &str = "celld:python";

/// One synthetic module per isolate whose default export is the internals
/// object, built the first time a stub links.
fn internals_module<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Module> {
    let registry = modreg(scope);
    let cached = registry
        .internals
        .lock()
        .unwrap()
        .as_ref()
        .map(|module| v8::Local::new(scope, module));
    if let Some(module) = cached {
        return module;
    }
    let name = v8::String::new(scope, INTERNALS_SPECIFIER).unwrap();
    let default = v8::String::new(scope, "default").unwrap();
    let module =
        v8::Module::create_synthetic_module(scope, name, &[default], internals_evaluation_steps);
    *registry.internals.lock().unwrap() = Some(v8::Global::new(scope, module));
    module
}

fn internals_evaluation_steps<'s>(
    context: v8::Local<'s, v8::Context>,
    module: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Value>> {
    v8::callback_scope!(unsafe scope, context);
    let internals = internals(scope);
    let default = v8::String::new(scope, "default").unwrap();
    module.set_synthetic_module_export(scope, default, internals.into())?;
    Some(v8::undefined(scope).into())
}

/// Compile a host-generated stub that imports `celld:internals` and register
/// it under `spec` as a trusted referrer.
fn register_internal_stub(scope: &mut v8::PinScope, spec: &str, source: &str) {
    let Some(module) = compile_module(scope, spec, source) else {
        tracing::warn!(%spec, "module stub failed to compile");
        return;
    };
    modreg(scope).register(scope, builtin_stub_keys(spec), module, true, None);
}

/// The stub for the builtin `spec`, which the Worker has, exporting `names`.
fn register_builtin_stub(
    scope: &mut v8::PinScope,
    spec: &str,
    names: &std::collections::BTreeSet<String>,
) {
    install_lazy_module(scope, spec);
    // `import * as x` binds the whole namespace, so the stub's exports
    // must be the module's full surface — probed from the backing
    // object, like dynamic import() — not just the scanned names.
    let source = if names.contains("*") {
        full_surface_source(scope, spec, names)
            .unwrap_or_else(|| stub_source(spec, names, lazy_module(spec)))
    } else {
        stub_source(spec, names, lazy_module(spec))
    };
    register_internal_stub(scope, spec, &source);
}

fn modreg(scope: &mut v8::PinScope) -> Arc<ModuleRegistry> {
    scope
        .get_slot::<Arc<ModuleRegistry>>()
        .cloned()
        .expect("isolate has no module registry")
}

/// Whether `spec` can name a builtin under some flags: a `node:`,
/// `cloudflare:` or `celld:python` specifier, or a bare Node.js name. The
/// scan keeps these; which of them a Worker has depends on its flags
/// ([`BuiltinModules`]).
fn may_be_builtin(spec: &str) -> bool {
    spec.starts_with("node:")
        || spec.starts_with("cloudflare:")
        || spec == PYTHON_HOST_SPECIFIER
        || NODE_BUILTIN_NAMES.contains(&spec)
}

/// The statements that name another module: a side-effect import, an import
/// with a clause, and a re-export (`export * from`, `export { a } from`).
/// The groups are the side-effect import's specifier, then the import's
/// clause and specifier, then the re-export's clause and specifier.
///
/// `Regex::new` compiles the pattern to a program and builds the matcher
/// scaffolding around it, so it is far more expensive than the scan itself on
/// a small bundle. Both patterns were function locals, so an isolate paid that
/// cost once for the main module and once more for each sibling module of a
/// Worker Loader bundle — on every isolate build.
static IMPORT_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    // A minifier can join `import` to `{`, `*` or a quote, and `export` to
    // `{` or `*`, but a default binding must keep whitespace. Preserve that
    // token boundary so an identifier that starts with `import` cannot look
    // like an import statement. The side-effect form comes first, so a
    // clause never runs on from it into the next statement.
    regex::Regex::new(concat!(
        r#"\bimport\s*["']([^"']+)["']"#,
        r#"|\bimport(\s+[^;]*?|\s*[{*][^;]*?)\s*from\s*["']([^"']+)["']"#,
        r#"|\bexport(\s*\*[^;]*?|\s*\{[^}]*\})\s*from\s*["']([^"']+)["']"#,
    ))
    .unwrap()
});
static IMPORT_BRACES_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"\{([^}]*)\}").unwrap());
static BLOCK_COMMENT_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"/\*[\s\S]*?\*/").unwrap());
// A scanned binding name is interpolated into a stub's source, so only an
// identifier may reach it; anything else (a quoted string name) is left out
// and fails to link as a missing export would.
static IDENTIFIER_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"^[\p{ID_Start}$_][\p{ID_Continue}$\x{200C}\x{200D}]*$").unwrap()
});

/// Counts scans of a source carrying [`SCAN_PROBE_MARKER`].
///
/// The counter is filtered by the marker rather than counting every scan, so a
/// bare global counter cannot move under an unrelated worker build.
#[cfg(celld_internal_tests)]
static IMPORT_SCANS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// A source puts this in a comment to have its scans counted.
#[cfg(celld_internal_tests)]
pub(super) const SCAN_PROBE_MARKER: &str = "celld-import-scan-probe";

/// How many times a source carrying [`SCAN_PROBE_MARKER`] has been scanned.
#[cfg(celld_internal_tests)]
#[doc(hidden)]
pub fn import_scans() -> usize {
    IMPORT_SCANS.load(std::sync::atomic::Ordering::Relaxed)
}

/// External specifier -> the bindings a bundle pulls from it.
pub(super) type ExternalImports =
    std::collections::BTreeMap<String, std::collections::BTreeSet<String>>;

/// Scan a bundle for the builtins it may import ([`may_be_builtin`]) and the
/// bindings pulled from each. V8 static-links these, so a stub must provide
/// exactly these names; a side-effect import needs none, and a namespace
/// import or `export *` the module's full surface (`*`).
pub(super) fn scan_external_imports(src: &str) -> ExternalImports {
    #[cfg(celld_internal_tests)]
    if src.contains(SCAN_PROBE_MARKER) {
        IMPORT_SCANS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
    let mut map = ExternalImports::default();
    for cap in IMPORT_RE.captures_iter(src) {
        let (spec, clause, import) = match (cap.get(1), cap.get(3), cap.get(5)) {
            (Some(spec), _, _) => (spec, None, false),
            (_, Some(spec), _) => (spec, cap.get(2), true),
            (_, _, Some(spec)) => (spec, cap.get(4), false),
            _ => unreachable!("every alternative captures a specifier"),
        };
        if !may_be_builtin(spec.as_str()) {
            continue;
        }
        let set = map.entry(spec.as_str().to_string()).or_default();
        let Some(clause) = clause else {
            continue; // a side-effect import binds nothing
        };
        let clause = BLOCK_COMMENT_RE.replace_all(clause.as_str(), " ");
        let clause = clause.trim();
        if let Some(b) = IMPORT_BRACES_RE.captures(clause) {
            for part in b[1].split(',') {
                let name = part.split_whitespace().next().unwrap_or("");
                // A commented-out binding, or a quoted name, is not taken.
                if IDENTIFIER_RE.is_match(name) {
                    set.insert(name.to_string());
                }
            }
        }
        let head = clause
            .split(['{', '*'])
            .next()
            .unwrap_or("")
            .trim()
            .trim_end_matches(',')
            .trim();
        if import && !head.is_empty() {
            set.insert("default".into());
        } // default import
          // `import * as x` and `export *` consume the whole namespace; the
          // stub must then export the module's full surface, not just the
          // scanned names.
        if clause.contains('*') {
            set.insert("*".into());
        }
    }
    map
}

/// A module Cells really implements in JS. Its source is injected into the
/// generated stub module, and `register_stubs` only builds stubs for
/// specifiers a bundle actually imports — so an isolate that never imports it
/// pays nothing at load. `global` is the internals property the source
/// defines and doubles as the redefinition guard when a bundle imports
/// several aliases.
struct LazyModule {
    specs: &'static [&'static str],
    global: &'static str,
    source: &'static v8::OneByteConst,
    /// The internals property that holds the module's default export, when
    /// it is not the namespace's backing object itself (workerd's modules
    /// that `export default` an object of their own).
    default: Option<&'static str>,
}

const LAZY_MODULES: &[LazyModule] = &[
    LazyModule {
        specs: &["node:assert"],
        global: "__assertModule",
        source: &NODE_ASSERT_SOURCE,
        default: None,
    },
    LazyModule {
        specs: &["node:assert/strict"],
        global: "__assertStrictModule",
        source: &NODE_ASSERT_SOURCE,
        default: None,
    },
    LazyModule {
        specs: &["node:timers/promises"],
        global: "__timersPromises",
        source: &NODE_TIMERS_SOURCE,
        default: None,
    },
    // Same source as node:timers/promises, whose namespace it carries.
    LazyModule {
        specs: &["node:timers"],
        global: "__timersModule",
        source: &NODE_TIMERS_SOURCE,
        default: Some("__timersDefault"),
    },
    // Shares its source with the `performance` LAZY_GLOBALS entry.
    LazyModule {
        specs: &["node:perf_hooks"],
        global: "__perfHooksModule",
        source: &PERFORMANCE_SOURCE,
        default: Some("__perfHooksDefault"),
    },
    LazyModule {
        specs: &["node:test"],
        global: "__nodeTest",
        source: &NODE_TEST_SOURCE,
        default: None,
    },
    LazyModule {
        specs: &["node:util"],
        global: "__utilModule",
        source: &NODE_UTIL_SOURCE,
        default: None,
    },
    // Same source, different namespace: node:util/types has the type
    // predicates as its named exports. The shared source defines both
    // globals, so either entry's guard covers the other.
    LazyModule {
        specs: &["node:util/types"],
        global: "__utilTypesModule",
        source: &NODE_UTIL_SOURCE,
        default: None,
    },
    LazyModule {
        specs: &["node:events"],
        global: "__eventsModule",
        source: &NODE_EVENTS_SOURCE,
        default: None,
    },
    LazyModule {
        specs: &["node:zlib"],
        global: "__zlibModule",
        source: &NODE_ZLIB_SOURCE,
        default: None,
    },
    LazyModule {
        specs: &["node:os"],
        global: "__osModule",
        source: &NODE_OS_SOURCE,
        default: None,
    },
    LazyModule {
        specs: &["node:path", "node:path/posix"],
        global: "__pathModule",
        source: &NODE_PATH_SOURCE,
        default: None,
    },
    // Same source; either entry's guard covers the other.
    LazyModule {
        specs: &["node:path/win32"],
        global: "__pathWin32Module",
        source: &NODE_PATH_SOURCE,
        default: None,
    },
    // Shares its source with the `Buffer` LAZY_GLOBALS entry; the script
    // is self-guarded, so whichever seam runs first wins and the other
    // reuses the same classes.
    LazyModule {
        specs: &["node:buffer"],
        global: "__buffer",
        source: &NODE_BUFFER_SOURCE,
        default: None,
    },
    LazyModule {
        specs: &["node:crypto"],
        global: "__cryptoModule",
        source: &NODE_CRYPTO_SOURCE,
        default: None,
    },
    LazyModule {
        specs: &["node:async_hooks"],
        global: "__asyncHooksModule",
        source: &NODE_ASYNC_HOOKS_SOURCE,
        default: None,
    },
    LazyModule {
        specs: &["node:diagnostics_channel"],
        global: "__diagnosticsChannelModule",
        source: &NODE_DIAGNOSTICS_CHANNEL_SOURCE,
        default: None,
    },
    // One source defines the whole stream family; whichever entry runs
    // first, its guard covers the others.
    LazyModule {
        specs: &["node:stream"],
        global: "__streamModule",
        source: &NODE_STREAM_SOURCE,
        default: None,
    },
    LazyModule {
        specs: &["node:stream/promises"],
        global: "__streamPromises",
        source: &NODE_STREAM_SOURCE,
        default: None,
    },
    LazyModule {
        specs: &["node:stream/web"],
        global: "__streamWeb",
        source: &NODE_STREAM_SOURCE,
        default: None,
    },
    LazyModule {
        specs: &["node:stream/consumers"],
        global: "__streamConsumers",
        source: &NODE_STREAM_SOURCE,
        default: None,
    },
];

/// A global whose definition only compiles when something reads the name.
/// One script may define several names; touching any of them installs them
/// all. A bundle that names none pays only the `SetLazyDataProperty` calls
/// at boot, so this is where a new global belongs unless the prelude has to
/// see it.
struct LazyGlobal {
    names: &'static [&'static str],
    source: &'static v8::OneByteConst,
}

const LAZY_GLOBALS: &[LazyGlobal] = &[
    LazyGlobal {
        names: &["IdentityTransformStream", "FixedLengthStream"],
        source: &IDENTITY_TRANSFORM_STREAM_SOURCE,
    },
    LazyGlobal {
        names: &["CompressionStream", "DecompressionStream"],
        source: &COMPRESSION_STREAMS_SOURCE,
    },
    LazyGlobal {
        names: &[
            "ReadableByteStreamController",
            "ReadableStreamBYOBReader",
            "ReadableStreamBYOBRequest",
        ],
        source: &BYTE_STREAMS_SOURCE,
    },
    LazyGlobal {
        names: &["Buffer"],
        source: &NODE_BUFFER_SOURCE,
    },
    LazyGlobal {
        names: &["setImmediate", "clearImmediate"],
        source: &SET_IMMEDIATE_SOURCE,
    },
    LazyGlobal {
        names: &["URLPattern"],
        source: &URL_PATTERN_SOURCE,
    },
    // The classes are taken off the global scope without their flags
    // (harness.js `__applyCompat`), and the script then exports only
    // `performance`.
    LazyGlobal {
        names: &[
            "performance",
            "Performance",
            "PerformanceEntry",
            "PerformanceMark",
            "PerformanceMeasure",
            "PerformanceResourceTiming",
            "PerformanceObserver",
            "PerformanceObserverEntryList",
        ],
        source: &PERFORMANCE_SOURCE,
    },
];

/// Runs once per group, the first time one of its names is read. V8 then
/// replaces the accessor with the returned value, so the script never
/// compiles twice.
fn lazy_global_getter(
    scope: &mut v8::PinScope,
    name: v8::Local<v8::Name>,
    args: v8::PropertyCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let index = args.data().integer_value(scope).unwrap();
    let group = &LAZY_GLOBALS[index as usize];
    let code = v8_strings::source(scope, group.source);
    let arguments = internal_arguments(scope);
    let exports = super::bootstrap::run_internal_script(scope, None, code, &arguments).unwrap();
    let exports: v8::Local<v8::Object> = exports.try_into().unwrap();
    // The group's other names are still lazy; define them now or reading one
    // would compile the same script again. Not this one — V8 asserts the
    // property is still an accessor when the getter returns. A name the
    // script does not export stays off the global scope.
    let global = scope.get_current_context().global(scope);
    for other in group.names {
        let key = v8::String::new(scope, other).unwrap();
        if name.strict_equals(key.into())
            || exports.has_own_property(scope, key.into()) != Some(true)
        {
            continue;
        }
        let value = exports.get(scope, key.into()).unwrap();
        global.create_data_property(scope, key.into(), value);
    }
    rv.set(exports.get(scope, name.into()).unwrap());
}

pub(super) fn install_lazy_globals(scope: &mut v8::PinScope) -> Result<()> {
    let global = scope.get_current_context().global(scope);
    for (i, group) in LAZY_GLOBALS.iter().enumerate() {
        let data = v8::Integer::new(scope, i as i32);
        for name in group.names {
            let key = v8::String::new(scope, name).unwrap();
            global.set_lazy_data_property_with_data(
                scope,
                key.into(),
                lazy_global_getter,
                data.into(),
                v8::PropertyAttribute::NONE,
                v8::SideEffectType::HasSideEffect,
                v8::SideEffectType::HasSideEffect,
            );
        }
    }
    Ok(())
}

/// Globals already installed by the src/js/harness for partially supported
/// builtins. These cost every isolate, so new modules belong in
/// `LAZY_MODULES` instead.
fn eager_module_global(spec: &str) -> Option<&'static str> {
    Some(match spec {
        "node:fs" => "__fs",
        "node:fs/promises" => "__fsPromises",
        "node:process" => "__process",
        _ => return None,
    })
}

/// Node.js's builtin module names, as workerd's `checkNodeSpecifier` knows
/// them (jsg/util.c++ `NODEJS_BUILTINS` at v1.20261001.1). With Node.js
/// compatibility a bare one names `node:<name>`; without it, it is a path
/// like any other.
const NODE_BUILTIN_NAMES: &[&str] = &[
    "_http_agent",
    "_http_client",
    "_http_common",
    "_http_incoming",
    "_http_outgoing",
    "_http_server",
    "_stream_duplex",
    "_stream_passthrough",
    "_stream_readable",
    "_stream_transform",
    "_stream_wrap",
    "_stream_writable",
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
    "sqlite",
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

/// The public modules of workerd's Node.js bundle (`src/node/*.ts` and its
/// subdirectories at v1.20261001.1). `node:test` has no bare name, and
/// `node:process` is not one: workerd's resolver redirects it to an
/// internal module, which every Worker has.
const NODE_MODULES: &[&str] = &[
    "node:_http_agent",
    "node:_http_client",
    "node:_http_common",
    "node:_http_incoming",
    "node:_http_outgoing",
    "node:_http_server",
    "node:_stream_duplex",
    "node:_stream_passthrough",
    "node:_stream_readable",
    "node:_stream_transform",
    "node:_stream_wrap",
    "node:_stream_writable",
    "node:_tls_common",
    "node:_tls_wrap",
    "node:assert",
    "node:assert/strict",
    "node:async_hooks",
    "node:buffer",
    "node:child_process",
    "node:cluster",
    "node:console",
    "node:constants",
    "node:crypto",
    "node:dgram",
    "node:diagnostics_channel",
    "node:dns",
    "node:dns/promises",
    "node:domain",
    "node:events",
    "node:fs",
    "node:fs/promises",
    "node:http",
    "node:http2",
    "node:https",
    "node:inspector",
    "node:inspector/promises",
    "node:module",
    "node:net",
    "node:os",
    "node:path",
    "node:path/posix",
    "node:path/win32",
    "node:perf_hooks",
    "node:punycode",
    "node:querystring",
    "node:readline",
    "node:readline/promises",
    "node:repl",
    "node:sqlite",
    "node:stream",
    "node:stream/consumers",
    "node:stream/promises",
    "node:stream/web",
    "node:string_decoder",
    "node:test",
    "node:timers",
    "node:timers/promises",
    "node:tls",
    "node:trace_events",
    "node:tty",
    "node:url",
    "node:util",
    "node:util/types",
    "node:v8",
    "node:vm",
    "node:wasi",
    "node:worker_threads",
    "node:zlib",
];

/// The Node.js modules that need a flag of their own besides Node.js
/// compatibility (api/node/node.h `registerNodeJsCompatModules`). Most of
/// these flags come with `nodejs_compat` from a date. `node:fs/promises`
/// needs no flag, as there.
const GATED_NODE_MODULES: &[(&str, crate::compat_flags::FlagId)] = {
    use crate::compat_flags as f;
    &[
        ("node:_http_agent", f::ENABLE_NODEJS_HTTP_MODULES),
        ("node:_http_client", f::ENABLE_NODEJS_HTTP_MODULES),
        ("node:_http_common", f::ENABLE_NODEJS_HTTP_MODULES),
        ("node:_http_incoming", f::ENABLE_NODEJS_HTTP_MODULES),
        ("node:_http_outgoing", f::ENABLE_NODEJS_HTTP_MODULES),
        ("node:_http_server", f::ENABLE_NODEJS_HTTP_SERVER_MODULES),
        ("node:_stream_wrap", f::ENABLE_NODEJS_STREAM_WRAP_MODULE),
        ("node:child_process", f::ENABLE_NODEJS_CHILD_PROCESS_MODULE),
        ("node:cluster", f::ENABLE_NODEJS_CLUSTER_MODULE),
        ("node:console", f::ENABLE_NODEJS_CONSOLE_MODULE),
        ("node:dgram", f::ENABLE_NODEJS_DGRAM_MODULE),
        ("node:domain", f::ENABLE_NODEJS_DOMAIN_MODULE),
        ("node:fs", f::ENABLE_NODEJS_FS_MODULE),
        ("node:http", f::ENABLE_NODEJS_HTTP_MODULES),
        ("node:http2", f::ENABLE_NODEJS_HTTP2_MODULE),
        ("node:https", f::ENABLE_NODEJS_HTTP_MODULES),
        ("node:inspector", f::ENABLE_NODEJS_INSPECTOR_MODULE),
        ("node:inspector/promises", f::ENABLE_NODEJS_INSPECTOR_MODULE),
        ("node:os", f::ENABLE_NODEJS_OS_MODULE),
        ("node:perf_hooks", f::ENABLE_NODEJS_PERF_HOOKS_MODULE),
        ("node:punycode", f::ENABLE_NODEJS_PUNYCODE_MODULE),
        ("node:readline", f::ENABLE_NODEJS_READLINE_MODULE),
        ("node:readline/promises", f::ENABLE_NODEJS_READLINE_MODULE),
        ("node:repl", f::ENABLE_NODEJS_REPL_MODULE),
        ("node:sqlite", f::ENABLE_NODEJS_SQLITE_MODULE),
        ("node:trace_events", f::ENABLE_NODEJS_TRACE_EVENTS_MODULE),
        ("node:tty", f::ENABLE_NODEJS_TTY_MODULE),
        ("node:v8", f::ENABLE_NODEJS_V8_MODULE),
        ("node:vm", f::ENABLE_NODEJS_VM_MODULE),
        ("node:wasi", f::ENABLE_NODEJS_WASI_MODULE),
        (
            "node:worker_threads",
            f::ENABLE_NODEJS_WORKER_THREADS_MODULE,
        ),
    ]
};

/// The modules of workerd's `cloudflare:` bundle (`src/cloudflare/*.ts` at
/// v1.20261001.1), which every Worker has whatever its flags. celld
/// implements `workers`, `sockets` and `workflows`; the others are
/// stubs whose first call throws.
const CLOUDFLARE_MODULES: &[&str] = &[
    "cloudflare:ai",
    "cloudflare:br",
    "cloudflare:durable-objects",
    "cloudflare:email",
    "cloudflare:node",
    "cloudflare:pipelines",
    "cloudflare:sockets",
    "cloudflare:vectorize",
    "cloudflare:workers",
    "cloudflare:workflows",
];

/// Which builtin modules this isolate's Worker can import, from its flags,
/// set before its modules link (`inject_storage_compatibility`). Every
/// static import, `import()` and `process.getBuiltinModule()` asks here, so
/// a module workerd's registry leaves out names no module on celld either.
pub(super) struct BuiltinModules {
    flags: crate::compat_flags::CompatFlags,
    /// `nodejs_compat` or `nodejs_compat_v2`, as workerd's
    /// `isNodeJsCompatEnabled` reads them.
    nodejs_compat: bool,
    /// `celld:python`, which only a deployed Python Worker's bundle can
    /// import (`WorkerConfig::with_python_runtime`).
    python_host: bool,
}

impl BuiltinModules {
    pub(super) fn new(compat: Compat, python_host: bool) -> BuiltinModules {
        BuiltinModules {
            flags: compat.flags,
            nodejs_compat: compat.nodejs_compat,
            python_host,
        }
    }

    /// `spec` as workerd's resolver reads it before it looks the module up:
    /// with Node.js compatibility, `checkNodeSpecifier` gives a bare Node.js
    /// name its `node:` prefix, and `sys` is `node:util`.
    fn canonical<'a>(&self, spec: &'a str) -> std::borrow::Cow<'a, str> {
        if !self.nodejs_compat {
            return spec.into();
        }
        node_specifier(spec).map_or(spec.into(), Into::into)
    }

    /// Whether the module `spec` (as [`BuiltinModules::canonical`] gives it)
    /// is a builtin this Worker has.
    fn provides(&self, spec: &str) -> bool {
        if spec == "node:process" || CLOUDFLARE_MODULES.contains(&spec) {
            return true;
        }
        if spec == PYTHON_HOST_SPECIFIER {
            return self.python_host;
        }
        if !NODE_MODULES.contains(&spec) {
            return false;
        }
        // nodejs_als alone registers node:async_hooks.
        if !self.nodejs_compat {
            return spec == "node:async_hooks" && self.flags.get(crate::compat_flags::NODEJS_ALS);
        }
        GATED_NODE_MODULES
            .iter()
            .find(|(name, _)| *name == spec)
            .is_none_or(|(_, flag)| self.flags.get(*flag))
    }
}

/// workerd's `checkNodeSpecifier`: the `node:` specifier a Node.js module
/// name stands for, or `None` for a specifier that is not one.
fn node_specifier(spec: &str) -> Option<String> {
    if spec == "sys" || spec == "node:sys" {
        return Some("node:util".into());
    }
    if NODE_BUILTIN_NAMES.contains(&spec) {
        return Some(format!("node:{spec}"));
    }
    spec.starts_with("node:").then(|| spec.to_string())
}

fn builtin_modules(scope: &v8::Isolate) -> &BuiltinModules {
    scope
        .get_slot::<BuiltinModules>()
        .expect("isolate has no builtin modules")
}

/// The lazy module that implements `spec`.
fn lazy_module(spec: &str) -> Option<&'static LazyModule> {
    LAZY_MODULES
        .iter()
        .find(|module| module.specs.contains(&spec))
}

/// Materialize an imported builtin from its external source before its small
/// ES module wrapper links. The old wrapper concatenated the full setup text,
/// which turned a shared static source back into one owned string per isolate.
fn install_lazy_module(scope: &mut v8::PinScope, spec: &str) -> Option<&'static LazyModule> {
    let module = lazy_module(spec)?;
    if internal_value(scope, module.global).is_some() {
        return Some(module);
    }
    let code = v8_strings::source(scope, module.source);
    let arguments = internal_arguments(scope);
    super::bootstrap::run_internal_script(scope, None, code, &arguments).ok()?;
    Some(module)
}

const CLOUDFLARE_WORKERS: &str = "cloudflare:workers";

/// Every export of `cloudflare:workers`, as declared by workerd's
/// `src/cloudflare/workers.ts` at tag v1.20261001.1 (the workerd that
/// `tests/conformance` pins; its `modules/cloudflare-workers-exports` case
/// fails on drift). `__celld.__cf` defines each one; a name celld does not
/// implement is a stub there that throws on use. Any other name, `default`
/// included, is absent, so importing it fails to link, as on workerd.
const CLOUDFLARE_WORKERS_EXPORTS: &[&str] = &[
    "DurableObject",
    "RpcPromise",
    "RpcProperty",
    "RpcStub",
    "RpcTarget",
    "ServiceStub",
    "WorkerEntrypoint",
    "WorkflowEntrypoint",
    "abortIsolate",
    "cache",
    "env",
    "exports",
    "restore",
    "tracing",
    "waitUntil",
    "withEnv",
    "withEnvAndExports",
    "withExports",
];

/// The `cloudflare:workers` module. Its surface is fixed, so one source
/// serves named, namespace and dynamic imports alike, whatever names the
/// importer scanned.
fn cloudflare_workers_source() -> String {
    let mut out = internals_import();
    for name in CLOUDFLARE_WORKERS_EXPORTS {
        // `env` and `exports` honour disallow_importable_env; see
        // `__cfImportable` in harness.js.
        if matches!(*name, "env" | "exports") {
            out.push_str(&format!(
                "export const {name} = __celld.__cfImportable({name:?});\n"
            ));
        } else {
            out.push_str(&format!("export const {name} = __celld.__cf.{name};\n"));
        }
    }
    out
}

/// Registry keys for a builtin stub. `cloudflare:workers` exports its full
/// surface statically, so `import()` shares the static module, as it does on
/// workerd; other static stubs carry only the scanned names.
fn builtin_stub_keys(spec: &str) -> Vec<String> {
    if spec == CLOUDFLARE_WORKERS {
        vec![spec.to_string(), format!("dyn:{spec}")]
    } else {
        vec![spec.to_string()]
    }
}

/// A stub ES module for `spec` that binds each scanned name from the
/// builtin's backing object in `__celld`. `cloudflare:workers` always gets its
/// fixed surface. An unsupported builtin binds a stub that throws on first
/// call. `lazy` is the lazy module `spec` names, if the flags make it
/// available (`lazy_module`).
fn stub_source(
    spec: &str,
    names: &std::collections::BTreeSet<String>,
    lazy: Option<&'static LazyModule>,
) -> String {
    if spec == CLOUDFLARE_WORKERS {
        return cloudflare_workers_source();
    }
    let cf_sockets = spec == "cloudflare:sockets";
    // `cloudflare:workflows` is real, not a pass-through proxy: its one
    // export is `NonRetryableError`, and a proxy standing in for an Error
    // subclass would make `throw new NonRetryableError(...)` throw a value
    // the retry policy cannot recognize — the step would retry, silently.
    let cf_workflows = spec == "cloudflare:workflows";
    let python_host = spec == PYTHON_HOST_SPECIFIER;
    let eager = eager_module_global(spec);
    let base = if cf_sockets {
        "__celld.__cfSockets".to_string()
    } else if cf_workflows {
        "__celld.__cfWorkflows".to_string()
    } else if python_host {
        "__celld.__pythonHost".to_string()
    } else if let Some(m) = lazy {
        format!("__celld.{}", m.global)
    } else if let Some(global) = eager {
        format!("__celld.{global}")
    } else {
        // Unsupported: a path-carrying stub whose property walks stay
        // inert but whose calls throw, so first use fails loudly with the
        // specifier in the message instead of silently passing through.
        format!(
            "__celld.__nodeStubFor({})",
            serde_json::to_string(spec).unwrap()
        )
    };
    let mut out = internals_import();
    for n in names {
        if n == "*" {
            continue; // namespace imports take the full-surface path
        } else if n == "default" {
            match lazy.and_then(|module| module.default) {
                Some(default) => out.push_str(&format!("export default __celld.{default};\n")),
                None => out.push_str(&format!("export default {base};\n")),
            }
        } else {
            out.push_str(&format!("export const {n} = {base}.{n};\n"));
        }
    }
    out
}

/// The first line of every host-generated stub.
fn internals_import() -> String {
    format!("import __celld from {INTERNALS_SPECIFIER:?};\n")
}

/// Compile one stub module per builtin the Worker's modules import, and has,
/// into the isolate's module registry. Run before instantiating a real
/// bundle; `resolve_external` then serves them. A builtin its flags leave
/// out gets no stub, so its import fails to link with workerd's error.
pub(super) fn register_stubs(scope: &mut v8::PinScope, config: &WorkerConfig) {
    let registry = modreg(scope);
    registry.modules.lock().unwrap().clear();
    registry.trusted.lock().unwrap().clear();
    // One stub per module with the names every module of the Worker pulls
    // from it: under Node.js compatibility `path` and `node:path` are one
    // module, and a sibling may import other names than the main module.
    let mut builtins = ExternalImports::default();
    let modules = builtin_modules(scope);
    let scans = std::iter::once(&config.main_imports)
        .chain(config.es_modules().map(|(_name, _source, imports)| imports));
    for (spec, names) in scans.flatten() {
        let spec = modules.canonical(spec);
        if modules.provides(&spec) {
            builtins
                .entry(spec.into_owned())
                .or_default()
                .extend(names.iter().cloned());
        }
    }
    for (spec, names) in &builtins {
        register_builtin_stub(scope, spec, names);
    }
    // sibling text modules (wrangler Text rule: `import md from './x.md'`)
    for (spec, source) in &config.modules {
        let ModuleSource::Text(content) = source else {
            continue;
        };
        let s = format!(
            "export default {};",
            serde_json::to_string(content).unwrap()
        );
        match compile_module(scope, spec, &s) {
            Some(m) => modreg(scope).register(scope, [spec.clone()], m, false, None),
            None => tracing::warn!(%spec, "text module failed to compile"),
        }
    }
    tracing::debug!(
        mods = modreg(scope).modules.lock().unwrap().len(),
        "registered import stubs + text modules"
    );
}

/// Compile `source` and insert it into the isolate's module registry under
/// both `name` and `./name`, so bare and relative sibling imports resolve to
/// one module. `None` when it does not compile, with the compile error
/// pending in the caller's TryCatch.
fn register_sibling_module(
    scope: &mut v8::PinScope,
    name: &str,
    source: &str,
    trusted: bool,
) -> Option<()> {
    let m = compile_module(scope, name, source)?;
    register_named_module(scope, name, m, trusted);
    Some(())
}

fn register_named_module(
    scope: &mut v8::PinScope,
    name: &str,
    module: v8::Local<v8::Module>,
    trusted: bool,
) {
    // The dynamic key makes the same module available to import() without
    // making a narrow static builtin stub look like a full namespace.
    let specs = [name.to_string(), format!("./{name}")]
        .into_iter()
        .flat_map(|spec| [format!("dyn:{spec}"), spec]);
    modreg(scope).register(scope, specs, module, trusted, Some(name));
}

/// Compiled-wasm modules shared process-wide: the first isolate to see a blob
/// compiles it and caches the `CompiledWasmModule`; every later isolate (each
/// pool thread, each DO cell activation) rehydrates that without recompiling,
/// as workerd does via `FromCompiledModule`. Bounded LRU: deployed modules
/// are fixed at startup (a redeploy restarts the process), but the Worker
/// Loader can stream in distinct wasm blobs at runtime, so modules that
/// evicted dynamic workers leave behind age out instead of accumulating
/// for the life of the daemon.
#[derive(Default)]
struct CompiledWasmCache {
    entries: HashMap<[u8; 32], (v8::CompiledWasmModule, u64)>,
    tick: u64,
}

const MAX_COMPILED_WASM_MODULES: usize = 32;

impl CompiledWasmCache {
    fn get(&mut self, hash: &[u8; 32]) -> Option<&v8::CompiledWasmModule> {
        self.tick += 1;
        let tick = self.tick;
        self.entries.get_mut(hash).map(|(module, used)| {
            *used = tick;
            &*module
        })
    }

    fn insert(&mut self, hash: [u8; 32], module: v8::CompiledWasmModule) {
        if self.entries.len() >= MAX_COMPILED_WASM_MODULES {
            let lru = self
                .entries
                .iter()
                .min_by_key(|(_, (_, used))| *used)
                .map(|(hash, _)| *hash);
            if let Some(lru) = lru {
                self.entries.remove(&lru);
            }
        }
        self.tick += 1;
        self.entries.insert(hash, (module, self.tick));
    }
}

/// Compile wasm bytes behind a TryCatch (so invalid bytes cannot leave a
/// pending exception dangling over the rest of the load) and record the
/// compiled module in the shared cache for later isolates. The compile runs
/// outside the cache lock; only the insert takes it.
fn compile_wasm<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    bytes: &[u8],
    hash: [u8; 32],
    cache: &Mutex<CompiledWasmCache>,
) -> Result<v8::Local<'s, v8::WasmModuleObject>, String> {
    let compiled = {
        let tc = std::pin::pin!(v8::TryCatch::new(scope));
        let tcs = &mut tc.init();
        match v8::WasmModuleObject::compile(tcs, bytes) {
            Some(module) => {
                cache
                    .lock()
                    .unwrap()
                    .insert(hash, module.get_compiled_module());
                Ok(v8::Global::new(tcs, module))
            }
            None => Err(exc!(tcs)),
        }
    };
    compiled.map(|module| v8::Local::new(scope, &module))
}

/// Register each sibling wasm module under its name and `./name` as a stub
/// whose default export is the compiled `WebAssembly.Module` — the shape
/// workerd gives a `CompiledWasm` module import, which is what
/// wasm-bindgen/workers-rs bundles expect from `import x from "./x.wasm"`.
/// Each stub reads its compiled module from `__celld.__wasmModules`, and
/// its one-time evaluation consumes that entry.
pub(super) fn register_wasm_modules(scope: &mut v8::PinScope, modules: &[(String, ModuleSource)]) {
    static COMPILED: OnceLock<Mutex<CompiledWasmCache>> = OnceLock::new();
    let wasm = modules.iter().filter_map(|(name, source)| match source {
        ModuleSource::Wasm(bytes) => Some((name, bytes)),
        _ => None,
    });
    let mut table = None;
    let cache = COMPILED.get_or_init(Default::default);
    for (name, bytes) in wasm {
        let table = *table.get_or_insert_with(|| {
            let internals = internals(scope);
            let table = v8::Object::new(scope);
            let table_key = v8::String::new(scope, "__wasmModules").unwrap();
            internals.set(scope, table_key.into(), table.into());
            table
        });
        use sha2::Digest;
        let hash: [u8; 32] = sha2::Sha256::digest(bytes).into();
        // `CompiledWasmModule` is not Clone, so the rehydrate reads the cache
        // entry in place; `from_compiled_module` shares the compiled code
        // rather than recompiling, so the lock is held only briefly.
        let cached = {
            let mut cache = cache.lock().unwrap();
            cache
                .get(&hash)
                .and_then(|compiled| v8::WasmModuleObject::from_compiled_module(scope, compiled))
        };
        let module = match cached {
            Some(module) => Ok(module),
            None => compile_wasm(scope, bytes, hash, cache),
        };
        let quoted = serde_json::to_string(name).unwrap();
        let source = match module {
            Ok(module) => {
                let key = v8::String::new(scope, name).unwrap();
                table.set(scope, key.into(), module.into());
                let mut source = internals_import();
                source.push_str(&format!(
                    "const m = __celld.__wasmModules[{quoted}];\n\
                     delete __celld.__wasmModules[{quoted}];\n\
                     export default m;"
                ));
                source
            }
            // The importing module reports the failure, matching the eager
            // `new WebAssembly.Module(bytes)` stub this replaces.
            Err(error) => {
                tracing::warn!(%name, %error, "wasm module failed to compile");
                let message =
                    serde_json::to_string(&format!("{name} failed to compile: {error}")).unwrap();
                format!("throw new WebAssembly.CompileError({message});")
            }
        };
        if register_sibling_module(scope, name, &source, true).is_none() {
            tracing::warn!(%name, "wasm module wrapper failed to compile");
        }
    }
}

/// Register a loaded worker's sibling JS modules (Worker Loader multi-module
/// bundles), beside the builtins `register_stubs` already added for every
/// module's scan. Each module is registered under its own name and `./name`
/// so both bare and relative sibling imports resolve; the whole graph links
/// when the main module instantiates. `None` when a sibling does not
/// compile, which fails the Worker's start with the compile error pending in
/// the caller's TryCatch.
pub(super) fn register_loader_modules(
    scope: &mut v8::PinScope,
    config: &WorkerConfig,
    main: v8::Local<v8::Module>,
) -> Option<()> {
    register_named_module(scope, &config.main_module_name, main, false);
    for (name, source, _imports) in config.es_modules() {
        register_sibling_module(scope, name, source, false)?;
    }
    register_requested_builtins(scope);
    Some(())
}

/// Give every builtin a module requests, and the Worker has, a stub, for
/// the requests the scan did not see (`import /* why */ "node:fs"`): the
/// stub is the module's full surface, so every name it has links. V8 lists
/// each module's requests exactly; only the names come from the scan.
fn register_requested_builtins(scope: &mut v8::PinScope) {
    let registry = modreg(scope);
    let sources: Vec<v8::Global<v8::Module>> = registry
        .source_names
        .lock()
        .unwrap()
        .iter()
        .map(|(module, _name)| module.clone())
        .collect();
    let mut missing = std::collections::BTreeSet::new();
    for module in &sources {
        let requests = v8::Local::new(scope, module).get_module_requests();
        for index in 0..requests.length() {
            let Some(request) = requests
                .get(scope, index)
                .and_then(|data| v8::Local::<v8::ModuleRequest>::try_from(data).ok())
            else {
                continue;
            };
            let spec = request.get_specifier().to_rust_string_lossy(scope);
            let modules = builtin_modules(scope);
            let spec = modules.canonical(&spec);
            if modules.provides(&spec) && !registry.modules.lock().unwrap().contains_key(&*spec) {
                missing.insert(spec.into_owned());
            }
        }
    }
    let everything = std::collections::BTreeSet::from(["*".to_string()]);
    for spec in missing {
        register_builtin_stub(scope, &spec, &everything);
    }
}

/// `throw_on_unrecognized_import_assertion`, which the isolate holds: workerd
/// implements no import attribute, and with the flag refuses an import that
/// gives any (jsg/modules.c++ `resolveCallback`, jsg/modules.h
/// `dynamicImportCallback`); without it, it ignores them.
pub(super) struct ImportAttributes {
    pub(super) refuse: bool,
}

const UNRECOGNIZED_IMPORT_ATTRIBUTES: &str = "Unrecognized import attributes specified";

fn refuses_import_attributes(scope: &v8::Isolate, attributes: v8::Local<v8::FixedArray>) -> bool {
    attributes.length() > 0
        && scope
            .get_slot::<ImportAttributes>()
            .is_some_and(|attributes| attributes.refuse)
}

/// Module resolve callback: serve a registered stub for `cloudflare:*`/`node:*`.
/// celld bundles are single-file, so anything else is genuinely unresolvable.
pub(super) fn resolve_external<'s>(
    context: v8::Local<'s, v8::Context>,
    specifier: v8::Local<'s, v8::String>,
    attributes: v8::Local<'s, v8::FixedArray>,
    referrer: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    v8::callback_scope!(unsafe scope, context);
    if refuses_import_attributes(scope, attributes) {
        let message = v8::String::new(scope, UNRECOGNIZED_IMPORT_ATTRIBUTES).unwrap();
        let exception = v8::Exception::error(scope, message);
        scope.throw_exception(exception);
        return None;
    }
    let spec = specifier.to_rust_string_lossy(scope);
    let registry = modreg(scope);
    // A user module that names the stubs' private specifier finds no module
    // below, as on workerd.
    if spec == INTERNALS_SPECIFIER && registry.trusts(scope, referrer) {
        return Some(internals_module(scope));
    }
    // Under Node.js compatibility a bare Node.js name is its `node:` module,
    // read before anything else, as workerd's `checkNodeSpecifier` reads it.
    let spec = builtin_modules(scope).canonical(&spec).into_owned();
    let referrer_name = registry.source_name(scope, referrer);
    let resolved = referrer_name
        .as_deref()
        .and_then(|referrer| resolve_relative_specifier(referrer, &spec));
    let key = resolved.as_deref().unwrap_or(&spec);
    let m = registry
        .modules
        .lock()
        .unwrap()
        .get(key)
        .map(|module| v8::Local::new(scope, module));
    if m.is_some() {
        return m;
    }
    // workerd's link errors name the module by its path from the bundle's
    // root, which a specifier that climbs past the root does not have.
    let referrer_name = referrer_name.unwrap_or_default();
    let Some(path) = workerd_module_path(&referrer_name, &spec) else {
        let text =
            format!("Invalid module specifier \"{spec}\".\n  imported from \"{referrer_name}\".");
        let message = v8::String::new(scope, &text).unwrap();
        let exception = v8::Exception::type_error(scope, message);
        scope.throw_exception(exception);
        return None;
    };
    // A specifier from the root ("/x.js") names the module at that path.
    if spec.starts_with('/') {
        let found = registry
            .modules
            .lock()
            .unwrap()
            .get(&path)
            .map(|module| v8::Local::new(scope, module));
        if found.is_some() {
            return found;
        }
    }
    let text = format!("No such module \"{path}\".\n  imported from \"{referrer_name}\"");
    let message = v8::String::new(scope, &text).unwrap();
    let exception = v8::Exception::error(scope, message);
    scope.throw_exception(exception);
    None
}

/// A module specifier as workerd's `kj::Path` evaluation reads it: the path
/// from the bundle's root, taken from the importing module's directory, or
/// from the root when it starts with `/`. A builtin's specifier is itself.
/// `None` when it climbs past the root.
fn workerd_module_path(referrer: &str, spec: &str) -> Option<String> {
    if ["node:", "cloudflare:", "workerd:"]
        .iter()
        .any(|prefix| spec.starts_with(prefix))
    {
        return Some(spec.to_string());
    }
    let mut segments: Vec<&str> = if spec.starts_with('/') {
        Vec::new()
    } else {
        referrer
            .rsplit_once('/')
            .map_or("", |(parent, _)| parent)
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect()
    };
    for segment in spec.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            _ => segments.push(segment),
        }
    }
    Some(segments.join("/"))
}

/// Resolve a relative module specifier against the importing module's name.
/// Module names use URL-style `/` separators even on Windows, so filesystem
/// path utilities would give platform-dependent answers here.
fn resolve_relative_specifier(referrer: &str, spec: &str) -> Option<String> {
    if !spec.starts_with("./") && !spec.starts_with("../") {
        return None;
    }
    let absolute = referrer.starts_with('/');
    let mut segments: Vec<&str> = referrer
        .rsplit_once('/')
        .map_or("", |(parent, _)| parent)
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    for segment in spec.split('/') {
        match segment {
            "" | "." => {}
            ".." if segments.last().is_some_and(|segment| *segment != "..") => {
                segments.pop();
            }
            ".." if !absolute => segments.push(segment),
            ".." => {}
            _ => segments.push(segment),
        }
    }
    let path = segments.join("/");
    Some(if absolute { format!("/{path}") } else { path })
}

/// The backing-object expression for a builtin specifier, or `None` if
/// `spec` names no builtin this Worker has. A lazy module is materialized
/// from its external source first.
fn builtin_source(scope: &mut v8::PinScope, spec: &str) -> Option<String> {
    if !builtin_modules(scope).provides(spec) {
        return None;
    }
    if spec == "cloudflare:sockets" {
        return Some("__celld.__cfSockets".into());
    }
    if spec == "cloudflare:workflows" {
        return Some("__celld.__cfWorkflows".into());
    }
    if spec == PYTHON_HOST_SPECIFIER {
        return Some("__celld.__pythonHost".into());
    }
    if let Some(module) = install_lazy_module(scope, spec) {
        return Some(format!("__celld.{}", module.global));
    }
    if let Some(global) = eager_module_global(spec) {
        return Some(format!("__celld.{global}"));
    }
    Some(format!(
        "__celld.__nodeStubFor({})",
        serde_json::to_string(spec).unwrap()
    ))
}

/// Full-surface module source for a builtin: run the (guarded) setup, probe
/// the backing object's enumerable keys, and re-export each one. Serves both
/// `import * as x` stubs and dynamic import(). `extra` adds statically
/// scanned names the probe may have missed, so mixed named + namespace
/// imports still link. String export names sidestep identifier restrictions.
fn full_surface_source(
    scope: &mut v8::PinScope,
    spec: &str,
    extra: &std::collections::BTreeSet<String>,
) -> Option<String> {
    if spec == CLOUDFLARE_WORKERS {
        return Some(cloudflare_workers_source());
    }
    let expr = builtin_source(scope, spec)?;
    let probe = format!("return JSON.stringify(Object.keys(Object({expr})));");
    let keys = run_internal_snippet(scope, &probe)?.to_rust_string_lossy(scope);
    let mut names: Vec<String> = serde_json::from_str(&keys).unwrap_or_default();
    for name in extra {
        if name != "*" && !names.contains(name) {
            names.push(name.clone());
        }
    }
    let default = builtin_default(spec).unwrap_or_else(|| "__b".to_string());
    let mut src = internals_import();
    src.push_str(&format!("const __b = {expr};\nexport default {default};\n"));
    for (i, name) in names.iter().enumerate() {
        if name == "default" {
            continue;
        }
        let name = serde_json::to_string(name).unwrap();
        src.push_str(&format!(
            "const __e{i} = __b[{name}]; export {{ __e{i} as {name} }};\n"
        ));
    }
    Some(src)
}

/// The default export of a lazy module that has one of its own, once
/// `builtin_source` installed it.
fn builtin_default(spec: &str) -> Option<String> {
    let default = lazy_module(spec)?.default?;
    Some(format!("__celld.{default}"))
}

/// `process.getBuiltinModule(id)`, as workerd's `ProcessModule` answers it:
/// a Node.js module's default export (its backing object, unless it has a
/// default of its own), another builtin's namespace, or undefined for a
/// module the Worker does not have. The id reads as `checkNodeSpecifier`
/// gives it, whatever the flags.
pub(super) fn op_builtin_module(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let id = args.get(0).to_rust_string_lossy(scope);
    if let Some(spec) = node_specifier(&id) {
        let Some(expr) = builtin_source(scope, &spec) else {
            return;
        };
        let expr = builtin_default(&spec).unwrap_or(expr);
        if let Some(value) = run_internal_snippet(scope, &format!("return {expr};")) {
            rv.set(value);
        }
        return;
    }
    // celld:python is the host's, not one of workerd's builtins.
    if !CLOUDFLARE_MODULES.contains(&id.as_str()) {
        return;
    }
    let Ok(module) = dynamic_module(scope, &id, &id) else {
        return;
    };
    if module.get_status() == v8::ModuleStatus::Instantiated && module.evaluate(scope).is_none() {
        return;
    }
    rv.set(module.get_module_namespace());
}

/// Return a registered sibling, or compile a full-namespace builtin once per
/// isolate. A `dyn:` key distinguishes both from a narrow static builtin stub.
fn dynamic_module<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    spec: &str,
    path: &str,
) -> Result<v8::Local<'s, v8::Module>> {
    let key = format!("dyn:{spec}");
    let registry = modreg(scope);
    let cached = registry
        .modules
        .lock()
        .unwrap()
        .get(&key)
        .map(|module| v8::Local::new(scope, module));
    let module = match cached {
        Some(module) => module,
        None => {
            let Some(src) = full_surface_source(scope, spec, &Default::default()) else {
                // workerd's error, made here so that it has the frames of
                // the import() call.
                let text = format!("No such module \"{path}\".");
                let message = v8::String::new(scope, &text).unwrap();
                let exception = v8::Exception::error(scope, message);
                scope.throw_exception(exception);
                return Err(anyhow!("{text}"));
            };
            let module = compile_module(scope, spec, &src)
                .ok_or_else(|| anyhow!("dynamic module for {spec} did not compile"))?;
            modreg(scope).register(scope, [key], module, true, None);
            module
        }
    };
    if module.get_status() == v8::ModuleStatus::Uninstantiated {
        module
            .instantiate_module(scope, resolve_external)
            .filter(|linked| *linked)
            .ok_or_else(|| anyhow!("dynamic module for {spec} did not link"))?;
    }
    Ok(module)
}

fn return_callback_data(
    _scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    rv.set(args.data());
}

/// Evaluate a dynamic module and translate V8's evaluation promise into the
/// namespace promise that import() requires. The chain preserves a top-level
/// await delay and forwards its rejection.
fn evaluate_dynamic_module<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    spec: &str,
    path: &str,
) -> Result<v8::Local<'s, v8::Promise>> {
    let module = dynamic_module(scope, spec, path)?;
    let evaluated = module
        .evaluate(scope)
        .ok_or_else(|| anyhow!("dynamic module for {spec} threw"))?
        .try_cast::<v8::Promise>()
        .map_err(|_| anyhow!("dynamic module for {spec} returned no promise"))?;
    let namespace = module.get_module_namespace();
    let return_namespace = v8::Function::builder(return_callback_data)
        .data(namespace)
        .build(scope)
        .ok_or_else(|| anyhow!("dynamic module for {spec} created no namespace callback"))?;
    evaluated
        .then(scope, return_namespace)
        .ok_or_else(|| anyhow!("dynamic module for {spec} created no namespace promise"))
}

/// Dynamic `import()` host hook. A loaded Worker's registered siblings resolve
/// before builtins, so the lookup cannot escape into another Worker registry.
/// Anything absent from both sources rejects.
pub(super) fn host_import_module_dynamically<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    _host_defined_options: v8::Local<'s, v8::Data>,
    resource_name: v8::Local<'s, v8::Value>,
    specifier: v8::Local<'s, v8::String>,
    import_attributes: v8::Local<'s, v8::FixedArray>,
) -> Option<v8::Local<'s, v8::Promise>> {
    let resolver = v8::PromiseResolver::new(scope)?;
    let promise = resolver.get_promise(scope);
    if refuses_import_attributes(scope, import_attributes) {
        let message = v8::String::new(scope, UNRECOGNIZED_IMPORT_ATTRIBUTES).unwrap();
        let exception = v8::Exception::error(scope, message);
        resolver.reject(scope, exception);
        return Some(promise);
    }
    let spec = specifier.to_rust_string_lossy(scope);
    let spec = builtin_modules(scope).canonical(&spec).into_owned();
    let referrer = resource_name.to_rust_string_lossy(scope);
    let resolved = resolve_relative_specifier(&referrer, &spec);
    let path = workerd_module_path(&referrer, &spec).unwrap_or_else(|| spec.clone());
    let spec = resolved.as_deref().unwrap_or(&spec);
    let tc = std::pin::pin!(v8::TryCatch::new(scope));
    let tc = &mut tc.init();
    match evaluate_dynamic_module(tc, spec, &path) {
        Ok(import) => return Some(import),
        Err(error) => {
            let caught = tc.exception();
            tc.reset();
            let exception = caught.unwrap_or_else(|| {
                let message = v8::String::new(tc, &error.to_string()).unwrap();
                v8::Exception::error(tc, message)
            });
            resolver.reject(tc, exception);
        }
    }
    Some(promise)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn names(list: &[&str]) -> BTreeSet<String> {
        list.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn cloudflare_workers_list_is_sorted_and_unique() {
        let mut sorted = CLOUDFLARE_WORKERS_EXPORTS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted, CLOUDFLARE_WORKERS_EXPORTS);
    }

    /// Known and unimplemented names alike bind to `__celld.__cf`, and `env`
    /// and `exports` through `__cfImportable`; scanned names off the list,
    /// `default` included, are not exported, so they fail to link.
    #[test]
    fn cloudflare_workers_stub_is_the_full_surface_whatever_was_scanned() {
        let mut expected = internals_import();
        for name in CLOUDFLARE_WORKERS_EXPORTS {
            let value = match *name {
                "env" => "__celld.__cfImportable(\"env\")".to_string(),
                "exports" => "__celld.__cfImportable(\"exports\")".to_string(),
                _ => format!("__celld.__cf.{name}"),
            };
            expected.push_str(&format!("export const {name} = {value};\n"));
        }
        for scanned in [
            names(&[]),
            names(&["*"]),
            names(&["DurableObject", "tracing", "NotAnExport", "default"]),
        ] {
            assert_eq!(stub_source(CLOUDFLARE_WORKERS, &scanned, None), expected);
        }
    }

    #[test]
    fn only_cloudflare_workers_shares_its_static_stub_with_import() {
        assert_eq!(
            builtin_stub_keys(CLOUDFLARE_WORKERS),
            ["cloudflare:workers", "dyn:cloudflare:workers"]
        );
        assert_eq!(builtin_stub_keys("node:fs"), ["node:fs"]);
    }

    fn scan(src: &str) -> Vec<(String, Vec<String>)> {
        scan_external_imports(src)
            .into_iter()
            .map(|(spec, names)| (spec, names.into_iter().collect()))
            .collect()
    }

    fn entry(spec: &str, names: &[&str]) -> (String, Vec<String>) {
        (
            spec.to_string(),
            names.iter().map(|name| name.to_string()).collect(),
        )
    }

    #[test]
    fn the_scan_reads_every_static_form() {
        assert_eq!(
            scan(concat!(
                "import fs, { readFile as read, /* c */ stat } from \"node:fs\";\n",
                "import * as path from 'path';\n",
                "import \"node:buffer\";\n",
                "import\"node:events\";import{a}from\"node:util\";\n",
                "export * from \"node:os\";\n",
                "export * as zlib from \"node:zlib\";\n",
                "export { default as x, join } from \"node:path\";\n",
                "export{Buffer}from\"buffer\";\n",
                "import local from \"./node:fs\";\n",
                "import \"lodash\";\n",
                "const importer = 1; import.meta.url; import(\"node:crypto\");\n",
            )),
            [
                entry("buffer", &["Buffer"]),
                entry("node:buffer", &[]),
                entry("node:events", &[]),
                entry("node:fs", &["default", "readFile", "stat"]),
                entry("node:os", &["*"]),
                entry("node:path", &["default", "join"]),
                entry("node:util", &["a"]),
                entry("node:zlib", &["*"]),
                entry("path", &["*"]),
            ]
        );
    }

    /// A side-effect import ends where its specifier does, so the next
    /// statement's clause and names stay its own.
    #[test]
    fn a_side_effect_import_does_not_swallow_the_next_statement() {
        assert_eq!(
            scan("import \"cloudflare:email\"\nimport { connect } from \"cloudflare:sockets\""),
            [
                entry("cloudflare:email", &[]),
                entry("cloudflare:sockets", &["connect"]),
            ]
        );
    }

    /// Scanned names reach a stub's source, so only identifiers are taken.
    #[test]
    fn the_scan_takes_only_identifiers() {
        assert_eq!(
            scan(concat!(
                "import { \"a-b\" as x, $c, _d, é } from \"node:util\";\n",
                "import { a=globalThis.leak=__celld, b } from \"node:fs\";\n",
            )),
            [
                entry("node:fs", &["b"]),
                entry("node:util", &["$c", "_d", "é"]),
            ]
        );
    }

    fn modules(date: &str, flags: &[&str]) -> BuiltinModules {
        let flags = crate::compat_flags::compile_lenient(Some(date), flags);
        BuiltinModules::new(Compat::from_flags(flags), false)
    }

    fn resolves(modules: &BuiltinModules, spec: &str) -> Option<String> {
        let spec = modules.canonical(spec);
        modules.provides(&spec).then(|| spec.into_owned())
    }

    /// Recorded from workerd by loader/builtin-modules.
    #[test]
    fn without_node_compatibility_only_process_and_cloudflare_modules_resolve() {
        let none = modules("2026-01-01", &[]);
        for spec in [
            "node:process",
            "cloudflare:workers",
            "cloudflare:email",
            "cloudflare:ai",
        ] {
            assert_eq!(resolves(&none, spec).as_deref(), Some(spec));
        }
        for spec in [
            "node:fs",
            "node:buffer",
            "node:async_hooks",
            "path",
            "process",
            "node:sys",
            "cloudflare:nope",
            "cloudflare:test",
            "workerd:unsafe",
            "celld:python",
            "celld:internals",
        ] {
            assert_eq!(resolves(&none, spec), None, "{spec}");
        }
        let als = modules("2026-01-01", &["nodejs_als"]);
        assert_eq!(
            resolves(&als, "node:async_hooks").as_deref(),
            Some("node:async_hooks")
        );
        assert_eq!(resolves(&als, "async_hooks"), None);
        let python = BuiltinModules::new(Compat::default(), true);
        assert!(python.provides(PYTHON_HOST_SPECIFIER));
    }

    #[test]
    fn node_compatibility_gives_bare_names_and_ungated_modules() {
        for compat in [
            modules("2026-01-01", &["nodejs_compat"]),
            modules("2026-01-01", &["nodejs_compat_v2"]),
        ] {
            assert_eq!(resolves(&compat, "path").as_deref(), Some("node:path"));
            assert_eq!(resolves(&compat, "sys").as_deref(), Some("node:util"));
            assert_eq!(resolves(&compat, "node:sys").as_deref(), Some("node:util"));
            assert_eq!(
                resolves(&compat, "process").as_deref(),
                Some("node:process")
            );
            assert_eq!(
                resolves(&compat, "fs/promises").as_deref(),
                Some("node:fs/promises")
            );
            assert_eq!(resolves(&compat, "node:test").as_deref(), Some("node:test"));
            for spec in ["test", "node:test/reporters", "node:nope", "node:v8", "v8"] {
                assert_eq!(resolves(&compat, spec), None, "{spec}");
            }
        }
        // nodejs_compat turns the module flags on from their dates;
        // nodejs_compat_v2 alone does not.
        let compat = modules("2026-01-01", &["nodejs_compat"]);
        assert!(compat.provides("node:fs") && compat.provides("node:http"));
        assert!(!compat.provides("node:perf_hooks") && !compat.provides("node:sqlite"));
        let v2 = modules("2026-01-01", &["nodejs_compat_v2"]);
        assert!(!v2.provides("node:fs") && !v2.provides("node:http"));
        let v2_fs = modules(
            "2026-01-01",
            &["nodejs_compat_v2", "enable_nodejs_fs_module"],
        );
        assert!(v2_fs.provides("node:fs"));
        let dated = modules("2026-10-01", &[]);
        assert!(NODE_MODULES.iter().all(|spec| dated.provides(spec)));
        let disabled = modules(
            "2026-10-01",
            &["disable_nodejs_fs_module", "disable_nodejs_http_modules"],
        );
        for spec in ["node:fs", "node:http", "node:https", "node:_http_server"] {
            assert!(!disabled.provides(spec), "{spec}");
        }
        assert!(disabled.provides("node:fs/promises") && disabled.provides("node:http2"));
    }

    #[test]
    fn the_builtin_tables_agree() {
        for list in [NODE_BUILTIN_NAMES, NODE_MODULES, CLOUDFLARE_MODULES] {
            let mut sorted = list.to_vec();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(sorted, list);
        }
        // Every bare name but process (redirected) and sys (node:util) is
        // a bundle module, and node:test is the bundle's only other one.
        let bare: Vec<String> = NODE_BUILTIN_NAMES
            .iter()
            .filter(|name| !matches!(**name, "process" | "sys"))
            .map(|name| format!("node:{name}"))
            .chain(["node:test".to_string()])
            .collect();
        let mut bare = bare;
        bare.sort_unstable();
        assert_eq!(bare, NODE_MODULES);
        for (spec, _flag) in GATED_NODE_MODULES {
            assert!(NODE_MODULES.contains(spec), "{spec}");
        }
        for module in LAZY_MODULES {
            for spec in module.specs {
                assert!(NODE_MODULES.contains(spec), "{spec}");
            }
        }
    }

    #[test]
    fn other_builtins_export_only_the_scanned_names() {
        let source = stub_source("cloudflare:sockets", &names(&["connect", "default"]), None);
        assert!(source.contains("export const connect = __celld.__cfSockets.connect;\n"));
        assert!(source.contains("export default __celld.__cfSockets;\n"));
    }
}
