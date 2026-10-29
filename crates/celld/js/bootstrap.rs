// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! Isolate bootstrap: what a fresh context needs before user code runs.
//!
//! The prelude and the harness compile once per process and are cached, so a
//! new isolate pays for execution but not for compilation. On top of those go
//! the bindings — `env`, the routing table, the compatibility flags — which
//! differ per worker and are therefore built every time.
use super::*;

/// Per-process compiled-bytecode cache for the fixed bootstrap scripts.
/// Every cell wake pays a fresh isolate, and without this each one re-parses
/// and re-compiles the same ~23k lines of prelude + harness — the single
/// largest slice of cold-wake latency. The first isolate compiles
/// eagerly and publishes the cache; every later isolate consumes it and only
/// executes.
///
/// Keyed by script name alone. Each script compiles as a function whose
/// parameter list is `op_names()`, and V8's cache check does not cover that
/// list, so a cache is only valid while the list is the same for every
/// isolate of the process. `op_names()` is fixed at build time; an op that
/// varies per worker would have to enter the key.
type BootstrapCache = std::collections::HashMap<&'static str, std::sync::Arc<Vec<u8>>>;

macro_rules! static_source {
    ($name:ident, $file:literal) => {
        static $name: v8::OneByteConst =
            v8::String::create_external_onebyte_const(include_bytes!($file));
    };
}

struct BootstrapSource {
    name: &'static str,
    source: &'static v8::OneByteConst,
}

static_source!(TEXT_ENCODING_SOURCE, "text_encoding.js");
static_source!(URL_SEARCH_PARAMS_SOURCE, "url_search_params.js");
static_source!(URL_SOURCE, "url.js");
static_source!(ATOB_BTOA_SOURCE, "atob_btoa.js");
static_source!(HEADERS_SOURCE, "headers.js");
static_source!(STREAMS_SOURCE, "streams.js");
static_source!(WRITABLE_STREAM_SOURCE, "writable_stream.js");
static_source!(TEXT_ENCODING_STREAMS_SOURCE, "text_encoding_streams.js");
static_source!(MESSAGE_CHANNEL_SOURCE, "message_channel.js");
static_source!(EVENT_SOURCE_SOURCE, "event_source.js");
static_source!(CACHE_SOURCE, "cache.js");
static_source!(SOCKETS_SOURCE, "sockets.js");
static_source!(HTML_REWRITER_SOURCE, "html_rewriter.js");
static_source!(CRYPTO_SOURCE, "crypto.js");
static_source!(TRACING_SOURCE, "tracing.js");

static PRELUDE: &[BootstrapSource] = &[
    BootstrapSource {
        name: "text_encoding.js",
        source: &TEXT_ENCODING_SOURCE,
    },
    BootstrapSource {
        name: "url_search_params.js",
        source: &URL_SEARCH_PARAMS_SOURCE,
    },
    BootstrapSource {
        name: "url.js",
        source: &URL_SOURCE,
    },
    BootstrapSource {
        name: "atob_btoa.js",
        source: &ATOB_BTOA_SOURCE,
    },
    BootstrapSource {
        name: "headers.js",
        source: &HEADERS_SOURCE,
    },
    BootstrapSource {
        name: "streams.js",
        source: &STREAMS_SOURCE,
    },
    BootstrapSource {
        name: "writable_stream.js",
        source: &WRITABLE_STREAM_SOURCE,
    },
    BootstrapSource {
        name: "text_encoding_streams.js",
        source: &TEXT_ENCODING_STREAMS_SOURCE,
    },
];

static POST_HARNESS: &[BootstrapSource] = &[
    BootstrapSource {
        name: "message_channel.js",
        source: &MESSAGE_CHANNEL_SOURCE,
    },
    BootstrapSource {
        name: "event_source.js",
        source: &EVENT_SOURCE_SOURCE,
    },
    BootstrapSource {
        name: "cache.js",
        source: &CACHE_SOURCE,
    },
    BootstrapSource {
        name: "sockets.js",
        source: &SOCKETS_SOURCE,
    },
    BootstrapSource {
        name: "html_rewriter.js",
        source: &HTML_REWRITER_SOURCE,
    },
    BootstrapSource {
        name: "crypto.js",
        source: &CRYPTO_SOURCE,
    },
    BootstrapSource {
        name: "tracing.js",
        source: &TRACING_SOURCE,
    },
];

// The harness is fixed process data, so copying its ~450 KiB source into every
// isolate only gives V8 another owner for the same bytes. `OneByteConst` keeps
// one external buffer in the binary and checks the ASCII requirement at
// compile time. Compiled code and the objects created by the script remain
// isolate-local; this shares only the original source buffer.
#[cfg(any(
    all(not(celld_internal_tests), not(test)),
    all(test, celld_internal_tests)
))]
static HARNESS_SOURCE: v8::OneByteConst =
    v8::String::create_external_onebyte_const(HARNESS.as_bytes());

/// The harness and the services it shares with the workerd engine, which
/// each end in a function declaration the harness calls.
const HARNESS: &str = concat!(include_str!("harness.js"), include_str!("services/kv.js"));

fn bootstrap_code_cache() -> &'static std::sync::Mutex<BootstrapCache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<BootstrapCache>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

#[cfg(celld_internal_tests)]
fn run_bootstrap_script<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    name: &'static str,
    src: &str,
    arguments: &InternalArguments<'s>,
) -> Result<()> {
    let code = v8::String::new(scope, src).unwrap();
    run_internal_script(scope, Some(name), code, arguments)?;
    Ok(())
}

fn run_bootstrap_static_script<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    source: &'static BootstrapSource,
    arguments: &InternalArguments<'s>,
) -> Result<()> {
    let code = v8_strings::source(scope, source.source);
    run_internal_script(scope, Some(source.name), code, arguments)?;
    Ok(())
}

/// The resource name of every script celld runs inside an isolate: the
/// prelude, the harness, lazy builtins and host-written snippets. A startup
/// error leaves their frames out, as workerd's runtime APIs have none.
pub(super) const INTERNAL_SCRIPT_NAME: &str = "celld:internal";

/// Compile an internal script as one function whose parameters are the
/// internals object and the host ops, and run it. A script and not a
/// module, because the harness is one scope shared by every prelude file;
/// a function and not a global script, because a global script's top-level
/// declarations become bindings user code can name, and its ops would have
/// to be globals too. Returns what the body `return`s: a lazy global's
/// exports, or undefined.
pub(super) fn run_internal_script<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    cache: Option<&'static str>,
    code: v8::Local<'s, v8::String>,
    arguments: &InternalArguments<'s>,
) -> Result<v8::Local<'s, v8::Value>> {
    use v8::script_compiler::CompileOptions;
    use v8::script_compiler::NoCacheReason;
    let name = cache.unwrap_or("lazy script");
    let resource = v8::String::new(scope, INTERNAL_SCRIPT_NAME).unwrap();
    let origin = v8::ScriptOrigin::new(
        scope,
        resource.into(),
        0,
        0,
        false,
        0,
        None,
        false,
        false,
        false,
        None,
    );
    let cached = cache.and_then(|name| bootstrap_code_cache().lock().unwrap().get(name).cloned());
    let function = match cached {
        // `CachedData` borrows `bytes`; the Arc binding outlives the Source.
        Some(bytes) => {
            let data = v8::script_compiler::CachedData::new(&bytes);
            let mut source =
                v8::script_compiler::Source::new_with_cached_data(code, Some(&origin), data);
            let function = v8::script_compiler::compile_function(
                scope,
                &mut source,
                &arguments.names,
                &[],
                CompileOptions::ConsumeCodeCache,
                NoCacheReason::NoReason,
            )
            .ok_or_else(|| anyhow!("bootstrap compile {name}"))?;
            debug_assert!(
                !source.get_cached_data().is_some_and(|data| data.rejected()),
                "code cache rejected for {name}"
            );
            function
        }
        // Eager for a cached bootstrap script: a lazily-compiled cache would
        // push function-body compile cost back into every consumer's first
        // request. A lazy script keeps V8's lazy compile: most of a builtin
        // module is never called.
        None => {
            let mut source = v8::script_compiler::Source::new(code, Some(&origin));
            let options = match cache {
                Some(_) => CompileOptions::EagerCompile,
                None => CompileOptions::NoCompileOptions,
            };
            let function = v8::script_compiler::compile_function(
                scope,
                &mut source,
                &arguments.names,
                &[],
                options,
                NoCacheReason::NoReason,
            )
            .ok_or_else(|| anyhow!("bootstrap compile {name}"))?;
            if let Some((name, data)) = cache.zip(function.create_code_cache()) {
                bootstrap_code_cache()
                    .lock()
                    .unwrap()
                    .insert(name, std::sync::Arc::new(data.to_vec()));
            }
            function
        }
    };
    // The global receiver keeps top-level `this` what a script had.
    let receiver = scope.get_current_context().global(scope).into();
    function
        .call(scope, receiver, &arguments.values)
        .ok_or_else(|| anyhow!("bootstrap run {name}"))
}

#[cfg(all(test, celld_internal_tests))]
pub(super) fn harness_source_for_test<'s>(
    scope: &mut v8::PinScope<'s, '_>,
) -> v8::Local<'s, v8::String> {
    shipping_harness_source(scope)
}

#[cfg(all(test, celld_internal_tests))]
pub(super) fn bootstrap_sources_for_test<'s>(
    scope: &mut v8::PinScope<'s, '_>,
) -> Vec<(&'static str, v8::Local<'s, v8::String>)> {
    PRELUDE
        .iter()
        .chain(POST_HARNESS)
        .map(|source| (source.name, v8_strings::source(scope, source.source)))
        .collect()
}

#[cfg(any(
    all(not(celld_internal_tests), not(test)),
    all(test, celld_internal_tests)
))]
fn shipping_harness_source<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::String> {
    v8::String::new_from_onebyte_const(scope, &HARNESS_SOURCE).expect("static harness source")
}

/// WPT-conformant Web APIs: TextEncoder, URL/URLSearchParams, atob/btoa, and
/// Headers. Run once per isolate before the Cells/Cloudflare-specific harness.
pub(super) fn install_prelude<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    arguments: &InternalArguments<'s>,
) -> Result<()> {
    for source in PRELUDE {
        run_bootstrap_static_script(scope, source, arguments)?;
    }
    Ok(())
}

/// Where the harness takes `LIFTED_TEST_HOOK` in a test build.
#[cfg(test)]
const LIFTED_TEST_HOOK_MARK: &str = "/*__CELLD_TEST_LIFTED_HOOK__*/";

/// The lifted RPC and storage encodings, for `js::marker_key_tests`: the key
/// escape, the brand classification, an RPC payload and a stored row out and
/// back in, and the revival of a tree given as is. Only a test build has it.
#[cfg(test)]
const LIFTED_TEST_HOOK: &str = r#"__celld.__liftedForTest = {
  escape: (key) => __isMarkerKey(key) ? __escapeKey(key) : key,
  unescape: (key) => __isEscapedKey(key) ? __unescapeKey(key) : key,
  hostKind: (value) => __hostKind(value),
  cloned: (value) => (__util_type_flags(value) & __TYPE_CLONED) !== 0,
  rpc: (value) => __rpcDes(__rpcOut(value, true)),
  stored: (value) => __storedRevive(
    __sc_decode(__storedBytes(value, null).subarray(1))),
  revive: (tree) => __stubRevive(tree).value,
  storedRevive: __storedRevive,
  service: () => __entrypointStub("default", undefined),
  bodyBytes: __bodyBytesOf,
};"#;

pub(super) fn install_harness<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    arguments: &InternalArguments<'s>,
) -> Result<()> {
    #[cfg(celld_internal_tests)]
    let harness = HARNESS
        .replace(LIFTED_TEST_HOOK_MARK, LIFTED_TEST_HOOK)
        .replace(
            "/*__CELLD_TEST_WORKFLOW_EVENT_CONSUMED__*/",
            "__test_workflow_event_consumed();",
        )
        .replace(
            "/*__CELLD_TEST_WORKFLOW_META_CREATED__*/",
            "__test_workflow_meta_created();",
        )
        .replace(
            "/*__CELLD_TEST_WORKFLOW_TERMINAL_ALARM_SET__*/",
            "__test_workflow_terminal_alarm_set();",
        )
        .replace(
            "/*__CELLD_TEST_WORKFLOW_BEFORE_PAUSE_SETTLE__*/",
            concat!(
                "if (globalThis.__test_workflow_pause_settle_race === true) { ",
                "await this.__wfResume(); ",
                "globalThis.__test_workflow_pause_settle_race = false; }"
            ),
        )
        .replace(
            "/*__CELLD_TEST_WORKFLOW_AFTER_RUN_STARTED__*/",
            concat!(
                "if (globalThis.__test_workflow_pause_settle_race === true) { ",
                "await globalThis.__test_workflow_callback_started(); ",
                "await this.__wfPause(); globalThis.__test_workflow_release(); }"
            ),
        );
    #[cfg(celld_internal_tests)]
    run_bootstrap_script(scope, "harness.js", harness.as_str(), arguments)?;
    #[cfg(not(celld_internal_tests))]
    {
        #[cfg(test)]
        let harness = v8::String::new(
            scope,
            &HARNESS.replace(LIFTED_TEST_HOOK_MARK, LIFTED_TEST_HOOK),
        )
        .expect("test harness source");
        #[cfg(not(test))]
        let harness = shipping_harness_source(scope);
        run_internal_script(scope, Some("harness.js"), harness, arguments)?;
    }
    // After the harness: both build on its EventTarget, and EventSource
    // uses its fetch and timers.
    for source in POST_HARNESS {
        run_bootstrap_static_script(scope, source, arguments)?;
    }
    // Resolving the event hooks belongs to installing the harness, not to the
    // first event: the harness is what defines them, and a caller that
    // installed the harness without them would silently fall back to nothing
    // at all. `harness.js` has just run, so all four globals exist here.
    install_event_hooks(scope)
}

/// Resolve the per-event harness hooks once and hold them for the isolate.
/// See [`EventHooks`] for why all four resolve together.
fn install_event_hooks(scope: &mut v8::PinScope) -> Result<()> {
    let hooks = EventHooks {
        begin_event: internal_global(scope, "__beginEvent")?,
        end_event: internal_global(scope, "__endEvent")?,
        advance_io_time: internal_global(scope, "__advanceIoTime")?,
        abort_incoming_request: internal_global(scope, "__abortIncomingRequest")?,
    };
    actor_runtime_state(scope)
        .event_hooks
        .set(hooks)
        .map_err(|_| anyhow!("event hooks were already installed"))
}

fn internal_global(scope: &mut v8::PinScope, name: &str) -> Result<v8::Global<v8::Function>> {
    let function = internal_function(scope, name)?;
    Ok(v8::Global::new(scope, function))
}

/// An object with no prototype, for a harness registry the host fills: a
/// lookup or an assignment by name must not reach a getter or setter a
/// script put on `Object.prototype`.
fn null_prototype_object<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Object> {
    let object = v8::Object::new(scope);
    let null = v8::null(scope).into();
    object.set_prototype(scope, null);
    object
}

pub(super) fn register_class(
    scope: &mut v8::PinScope,
    name: &str,
    cls: v8::Local<v8::Value>,
) -> Result<()> {
    let cell = cell_state(scope)?;
    let clk = v8::String::new(scope, "classes").unwrap();
    let classes = cell
        .get(scope, clk.into())
        .unwrap()
        .to_object(scope)
        .unwrap();
    let nk = v8::String::new(scope, name).unwrap();
    classes.set(scope, nk.into(), cls);
    Ok(())
}

/// The load error for a Durable Object class, bound or migrated, that the
/// main module does not export as a class. workerd only warns, in these
/// words, and fails each call to the class. celld fails the load instead, so
/// a node refuses to adopt the deployment and keeps serving the one before.
pub(super) fn unexported_class_error(class: &str) -> anyhow::Error {
    anyhow!(
        "A DurableObjectNamespace in the config referenced the class \"{class}\", but no \
         such Durable Object class is exported from the worker. Please make sure the class \
         name matches, it is exported, and the class extends 'DurableObject'."
    )
}

/// Populate `cloudflare:workers` `exports` with the worker module's own exports:
/// a Durable Object class is exposed as its namespace (idFromName/get/RPC), any
/// other export by value. `default` is omitted (it is the fetch entrypoint, not
/// an importable export). Mirrors Workerd's `import { exports }` surface.
pub(super) fn populate_cf_exports(
    scope: &mut v8::PinScope,
    ns: v8::Local<v8::Object>,
    do_classes: &[String],
) -> Result<()> {
    let cf = internal_object(scope, "__cf")?;
    let exports = cf
        .get(scope, v8::String::new(scope, "exports").unwrap().into())
        .and_then(|value| value.to_object(scope))
        .ok_or_else(|| anyhow!("missing __cf.exports"))?;
    let cell = cell_state(scope)?;
    let make_ns: v8::Local<v8::Function> = cell
        .get(
            scope,
            v8::String::new(scope, "makeNamespace").unwrap().into(),
        )
        .and_then(|value| value.try_into().ok())
        .ok_or_else(|| anyhow!("missing __cell.makeNamespace"))?;
    let do_set: std::collections::HashSet<&str> = do_classes.iter().map(String::as_str).collect();
    let names = ns
        .get_own_property_names(scope, Default::default())
        .ok_or_else(|| anyhow!("no module export names"))?;
    for index in 0..names.length() {
        let name_value = names.get_index(scope, index).unwrap();
        let name = name_value.to_rust_string_lossy(scope);
        if name == "default" {
            continue;
        }
        let export_value = if do_set.contains(name.as_str()) {
            let arg = v8::String::new(scope, &name).unwrap().into();
            make_ns
                .call(scope, cell.into(), &[arg])
                .ok_or_else(|| anyhow!("makeNamespace({name}) failed"))?
        } else {
            ns.get(scope, name_value)
                .ok_or_else(|| anyhow!("export {name}"))?
        };
        let key = v8::String::new(scope, &name).unwrap();
        exports.set(scope, key.into(), export_value);
    }
    Ok(())
}

pub(super) fn inject_namespace_keys(
    scope: &mut v8::PinScope,
    script_name: &str,
    do_classes: &[String],
) -> Result<()> {
    let cell = cell_state(scope)?;
    let keys_key = v8::String::new(scope, "namespaceKeys").unwrap();
    let keys = cell
        .get(scope, keys_key.into())
        .and_then(|value| value.to_object(scope))
        .ok_or_else(|| anyhow!("missing Durable Object namespace registry"))?;
    let script_key = v8::String::new(scope, "script").unwrap();
    let script_value = v8::String::new(scope, script_name).unwrap();
    cell.set(scope, script_key.into(), script_value.into());
    for class_name in do_classes {
        let class_key = v8::String::new(scope, class_name).unwrap();
        let namespace_key = super::namespace_key(script_name, class_name);
        let namespace_key = v8::String::new(scope, &namespace_key).unwrap();
        if !keys
            .set(scope, class_key.into(), namespace_key.into())
            .unwrap_or(false)
        {
            anyhow::bail!("could not register namespace key for {class_name}");
        }
    }
    Ok(())
}

/// `__cell.crons`: the deployment's cron trigger expressions, verbatim as the
/// developer wrote them. The reserved cron cell reads them at each activation,
/// so a schedule change arrives with the deployment and needs no migration of
/// an alarm the previous deployment armed. Absent `triggers.crons`, the list
/// is empty and the cron cell retires itself.
pub(super) fn inject_crons(scope: &mut v8::PinScope, crons: &[String]) -> Result<()> {
    let cell = cell_state(scope)?;
    let list = v8::Array::new(scope, crons.len() as i32);
    for (index, cron) in crons.iter().enumerate() {
        let value = v8::String::new(scope, cron).ok_or_else(|| anyhow!("cron expression"))?;
        list.set_index(scope, index as u32, value.into());
    }
    let key = v8::String::new(scope, "crons").unwrap();
    cell.set(scope, key.into(), list.into());
    Ok(())
}

/// `__cell.workflows`: the deployment's workflow-name → class-name map. The
/// reserved workflow cell resolves the user class from it at each replay, so
/// a redeploy that renames the class takes effect on the next activation and
/// nothing about a running instance's ledger has to move.
pub(super) fn inject_workflows(
    scope: &mut v8::PinScope,
    script_name: &str,
    workflow_bindings: &[WorkflowBinding],
) -> Result<()> {
    let cell = cell_state(scope)?;
    let map = null_prototype_object(scope);
    for binding in workflow_bindings {
        let key =
            v8::String::new(scope, &binding.workflow).ok_or_else(|| anyhow!("workflow name"))?;
        let value =
            v8::String::new(scope, &binding.class).ok_or_else(|| anyhow!("workflow class"))?;
        map.set(scope, key.into(), value.into());
    }
    let key = v8::String::new(scope, "workflows").unwrap();
    cell.set(scope, key.into(), map.into());
    // Only when the deployment declares a workflow. The harness registers
    // `__WorkflowCell` in every isolate, so aliasing unconditionally would put
    // a class in the registry that this deployment never declared. It would be
    // inert -- `cell_configs` is built from the manifest's `do_classes` and
    // would not name it -- but "the harness registers what the deployment
    // declares" is worth keeping true rather than nearly true.
    if !workflow_bindings.is_empty() {
        alias_workflow_class(scope, cell, script_name)?;
    }
    Ok(())
}

/// `__cell.containers`: the classes whose objects get a `ctx.container`.
/// A class outside this map gets none, which is what the
/// `@cloudflare/containers` constructor checks.
pub(super) fn inject_containers(
    scope: &mut v8::PinScope,
    containers: &[crate::container::ContainerSpec],
) -> Result<()> {
    let cell = cell_state(scope)?;
    let map = null_prototype_object(scope);
    for spec in containers {
        let key =
            v8::String::new(scope, &spec.class_name).ok_or_else(|| anyhow!("container class"))?;
        let value = v8::Boolean::new(scope, true);
        map.set(scope, key.into(), value.into());
    }
    let key = v8::String::new(scope, "containers").unwrap();
    cell.set(scope, key.into(), map.into());
    Ok(())
}

/// Register the workflow cell class under its script-scoped name.
///
/// `harness.js` registers `__WorkflowCell` under the bare `__Workflow` at
/// install time, which is before `__cell.script` exists, so the script-scoped
/// name cannot be built there. This copies the registration across once the
/// script is known.
///
/// The bare entry stays behind and is inert: `cell_configs` is built from the
/// manifest's `do_classes`, which carries only the scoped name, so no cell can
/// start under it. Removing it would buy nothing and would leave the harness
/// and this function disagreeing about who owns the registration. Done through the V8 object API rather than a compiled
/// snippet, because this runs on every isolate load and a `Script::compile`
/// here cost ~100us per worker.
fn alias_workflow_class(
    scope: &mut v8::PinScope,
    cell: v8::Local<v8::Object>,
    script_name: &str,
) -> Result<()> {
    let alias = crate::deploy::workflow_class(script_name);
    let alias = v8::String::new(scope, &alias).ok_or_else(|| anyhow!("workflow class name"))?;
    let base = v8::String::new(scope, crate::deploy::WORKFLOW_CLASS).unwrap();
    for registry in ["classes", "doExports"] {
        let key = v8::String::new(scope, registry).unwrap();
        let table = cell
            .get(scope, key.into())
            .and_then(|value| value.to_object(scope))
            .ok_or_else(|| anyhow!("missing __cell.{registry}"))?;
        let value = table
            .get(scope, base.into())
            .ok_or_else(|| anyhow!("harness registered no {registry} entry for a workflow"))?;
        table.set(scope, alias.into(), value);
    }
    Ok(())
}

/// `__cell.kvLimits`: every bound `celld_logic::kv` declares, as data.
///
/// Injected rather than written in `harness.js` so the binding, `celld kv` and
/// deploy-time validation cannot disagree about what a valid key is. No host
/// op: a limit is data rather than a decision, so shipping the values is
/// enough, and D1 set the bar at one op with Workflows coming in under it.
///
/// Built through the V8 object API rather than by compiling a snippet, because
/// this runs on every isolate load.
pub(super) fn inject_kv_limits(scope: &mut v8::PinScope) -> Result<()> {
    let cell = cell_state(scope)?;
    let limits = v8::Object::new(scope);
    let entries = crate::kv_blob::limits();
    for (name, value) in entries.as_object().expect("kv limits are an object") {
        let key = v8::String::new(scope, name).unwrap();
        let value: v8::Local<v8::Value> = match value {
            serde_json::Value::Bool(flag) => v8::Boolean::new(scope, *flag).into(),
            other => v8::Number::new(scope, other.as_f64().expect("kv limit")).into(),
        };
        limits.set(scope, key.into(), value);
    }
    let key = v8::String::new(scope, "kvLimits").unwrap();
    cell.set(scope, key.into(), limits.into());
    Ok(())
}

/// `globalThis.Cloudflare.compatibilityFlags`: as in workerd, a sealed object
/// without a prototype whose read-only properties are enable flag names.
/// celld lists the flags it honours, with the values workerd computes, and
/// the flags it always behaves as on where workerd computes them on (see
/// [`crate::compat_flags::CompatFlags::reported`]). Any other flag is absent
/// (falsy) rather than reported with a value celld does not act on.
///
/// Built through the V8 object API rather than by compiling a snippet: this
/// runs on every isolate load, and a separate `Script::compile` there cost
/// ~100us per worker.
pub(super) fn inject_compatibility_flags(scope: &mut v8::PinScope, compat: Compat) -> Result<()> {
    let context = scope.get_current_context();
    let global = context.global(scope);
    let flags = v8::Object::new(scope);
    let null = v8::null(scope).into();
    flags.set_prototype(scope, null);
    for (name, value) in compat.flags.reported() {
        let key = v8::String::new(scope, name).unwrap();
        let value = v8::Boolean::new(scope, value);
        flags.define_own_property(
            scope,
            key.into(),
            value.into(),
            v8::PropertyAttribute::READ_ONLY,
        );
    }
    flags.set_integrity_level(scope, v8::IntegrityLevel::Sealed);
    let cloudflare = v8::Object::new(scope);
    let key = v8::String::new(scope, "compatibilityFlags").unwrap();
    cloudflare.set(scope, key.into(), flags.into());
    let key = v8::String::new(scope, "Cloudflare").unwrap();
    global.set(scope, key.into(), cloudflare.into());
    Ok(())
}

pub(super) fn build_env(scope: &mut v8::PinScope, config: &WorkerConfig) -> Result<()> {
    let script_name = config.script_name.as_str();
    let bindings = config.bindings.as_slice();
    let r2_bindings = config.r2_bindings.as_slice();
    let d1_bindings = config.d1_bindings.as_slice();
    let kv_bindings = config.kv_bindings.as_slice();
    let queue_bindings = config.queue_bindings.as_slice();
    let workflow_bindings = config.workflow_bindings.as_slice();
    let vars = config.vars.as_slice();
    let services = config.services.as_slice();
    let asset_binding = config.asset_binding.as_deref();
    // call the harness: for each binding, env[bindingName] = makeNamespace(className)
    // Every name and value is a JavaScript string literal, never Rust's
    // `{:?}`, whose escapes are not JavaScript's: a NUL before a digit would
    // read as a legacy octal escape.
    let lit = |text: &str| js_string_literal(text);
    let src = {
        let mut lines = String::from("const e = __celld.__cell.env;\n");
        for (bname, cname) in bindings {
            lines.push_str(&format!(
                "e[{}] = __celld.__cell.makeNamespace({});\n",
                lit(bname)?,
                lit(cname)?
            ));
        }
        for (name, bucket) in r2_bindings {
            lines.push_str(&format!(
                "e[{}] = __celld.__makeR2Bucket({}, {});\n",
                lit(name)?,
                lit(name)?,
                lit(bucket)?
            ));
        }
        for (binding, id) in kv_bindings {
            // The cell name comes from `celld_logic::kv::cell_name`, never from
            // the harness. It carries the shard, and while there is one shard
            // that is a constant the binding must not be trusted to reproduce:
            // the name is hashed into the cell scope, so a formatting
            // disagreement would silently address a second, empty namespace
            // rather than fail. When shards outnumber one, this becomes a name
            // per shard and the choice moves here too.
            lines.push_str(&format!(
                "e[{}] = __celld.__makeKvNamespace({}, {});\n",
                lit(binding)?,
                lit(id)?,
                lit(&celld_logic::kv::cell_name(id, 0))?,
            ));
        }
        for binding in queue_bindings {
            lines.push_str(&format!(
                "e[{}] = __celld.__makeQueue({}, {}, {});\n",
                lit(&binding.environment)?,
                lit(&binding.queue)?,
                lit(celld_logic::queue::cell_name(&binding.queue))?,
                binding.delivery_delay,
            ));
        }
        for (name, database) in d1_bindings {
            lines.push_str(&format!(
                "e[{}] = __celld.__makeD1Database({});\n",
                lit(name)?,
                lit(database)?
            ));
        }
        for binding in workflow_bindings {
            lines.push_str(&format!(
                "e[{}] = __celld.__makeWorkflow({});\n",
                lit(&binding.environment)?,
                lit(&binding.workflow)?
            ));
        }
        for service in services {
            let entrypoint = match &service.entrypoint {
                Some(name) => lit(name)?,
                None => "null".to_string(),
            };
            // Encoded once, here, into the bytes every call on the binding
            // carries. No props stays `undefined`, not encoded `{}`, so a
            // same-script call to the default export keeps its direct path.
            let props = match &service.props {
                Some(props) => format!(
                    "__celld.__propsBytes({}, {})",
                    lit(&service.environment)?,
                    json_text_literal(props)?
                ),
                None => "undefined".to_string(),
            };
            lines.push_str(&format!(
                "e[{}] = __celld.__makeServiceBinding({}, {}, {});\n",
                lit(&service.environment)?,
                lit(&service.script)?,
                entrypoint,
                props
            ));
        }
        for (name, value) in vars {
            match value {
                WorkerVar::Text(text) => {
                    lines.push_str(&format!("e[{}] = {};\n", lit(name)?, lit(text)?));
                }
                // Parsed, as workerd parses a JSON binding, rather than
                // spliced in as a literal: JSON text is not always the same
                // value as a JavaScript literal (a `"__proto__"` key).
                WorkerVar::Json(text) => {
                    lines.push_str(&format!(
                        "e[{}] = JSON.parse({});\n",
                        lit(name)?,
                        lit(text)?
                    ));
                }
            }
        }
        if let Some(name) = asset_binding {
            lines.push_str(&format!(
                "e[{}] = __celld.__makeAssetsBinding({});\n",
                lit(name)?,
                lit(script_name)?
            ));
        }
        // One `__makeLoader()` call for each binding. Each call builds its own
        // `byName` cache, so two loaders are two namespaces, as they are in
        // workerd. Sharing one loader object between the names would merge the
        // caches and return one Worker for two different `get()` calls.
        for name in &config.loader_bindings {
            lines.push_str(&format!("e[{}] = __celld.__makeLoader();\n", lit(name)?));
        }
        lines
    };
    {
        let tc = std::pin::pin!(v8::TryCatch::new(scope));
        let tc = &mut tc.init();
        run_internal_snippet(tc, &src)
            .ok_or_else(|| anyhow!("env install failed: {}", exc!(tc)))?;
    }
    Ok(())
}

/// A loaded Worker's `env`, from the bytes its parent sent. Installed before
/// the main module evaluates, as workerd binds `env` before then: the module
/// can read it at module scope, and `process.env` is copied from it.
pub(super) fn install_loader_env(scope: &mut v8::PinScope, config: &WorkerConfig) -> Result<()> {
    let Some(env) = &config.loader_env else {
        return Ok(());
    };
    let installer = internal_function(scope, "__installLoaderEnv")?;
    // A flat [script, entrypoint, props, ...] array avoids one V8 array
    // allocation for every capability that the parent transfers.
    let routes = v8::Array::new(scope, env.routes.len().saturating_mul(3) as i32);
    for (index, route) in env.routes.iter().enumerate() {
        let offset = (index * 3) as u32;
        let script = v8::String::new(scope, &route.script).unwrap();
        routes.set_index(scope, offset, script.into());
        let entrypoint: v8::Local<v8::Value> = match &route.entrypoint {
            Some(name) => v8::String::new(scope, name).unwrap().into(),
            None => v8::null(scope).into(),
        };
        routes.set_index(scope, offset + 1, entrypoint);
        let props = super::bytes_value(scope, route.props.clone());
        routes.set_index(scope, offset + 2, props);
    }
    let bytes = super::bytes_value(scope, env.bytes.clone());
    let tc = std::pin::pin!(v8::TryCatch::new(scope));
    let tc = &mut tc.init();
    let receiver = v8::undefined(tc).into();
    installer
        .call(tc, receiver, &[bytes, routes.into()])
        .ok_or_else(|| anyhow!("loader env install: {}", exc!(tc)))?;
    Ok(())
}

/// `nodejs_compat_populate_process_env`: copy the env into `process.env`
/// before the main module evaluates, so a dependency that reads it at module
/// scope sees it, as on workerd. `build_env` runs after evaluation, because
/// service bindings and Durable Object namespaces need the module's exports,
/// so this copies what is known before then: a loaded Worker's own env
/// (`install_loader_env`) and the vars. No other binding is a string or plain
/// data, which are all that `process.env` takes.
///
/// The values cross as V8 values rather than as source text, and a JSON var
/// goes through V8's JSON parser, as `build_env` installs it. Through the V8
/// API rather than a compiled snippet because this runs on every isolate load.
pub(super) fn populate_process_env(scope: &mut v8::PinScope, config: &WorkerConfig) -> Result<()> {
    let populate = internal_function(scope, "__populateProcessEnv")?;
    let vars = v8::Array::new(scope, config.vars.len().try_into()?);
    for (index, (name, value)) in config.vars.iter().enumerate() {
        let key = v8::String::new(scope, name).ok_or_else(|| anyhow!("var {name} is too long"))?;
        let value: v8::Local<v8::Value> = match value {
            WorkerVar::Text(text) => v8::String::new(scope, text)
                .ok_or_else(|| anyhow!("var {name} is too long"))?
                .into(),
            WorkerVar::Json(text) => {
                let text = v8::String::new(scope, text)
                    .ok_or_else(|| anyhow!("var {name} is too long"))?;
                v8::json::parse(scope, text).ok_or_else(|| anyhow!("var {name} is not JSON"))?
            }
        };
        let pair = v8::Array::new_with_elements(scope, &[key.into(), value]);
        vars.set_index(scope, index.try_into()?, pair.into());
    }
    let tc = std::pin::pin!(v8::TryCatch::new(scope));
    let tc = &mut tc.init();
    let receiver = v8::undefined(tc).into();
    populate
        .call(tc, receiver, &[vars.into()])
        .ok_or_else(|| anyhow!("process.env install: {}", exc!(tc)))?;
    Ok(())
}

/// `value` as JSON text inside a JavaScript string literal, for the harness to
/// `JSON.parse`. Not an object literal: in one, a `"__proto__"` key sets the
/// prototype, where the manifest's JSON, parsed, has it as an own property.
/// U+2028 and U+2029 are escaped as well, though ES2019 allows them in string
/// literals, so the snippet never depends on that.
fn json_text_literal(value: &serde_json::Map<String, serde_json::Value>) -> Result<String> {
    js_string_literal(&serde_json::to_string(value)?)
}

/// `text` as a JavaScript string literal.
fn js_string_literal(text: &str) -> Result<String> {
    Ok(serde_json::to_string(text)?
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029"))
}

/// Install the deployment-wide Queue consumer catalog and lease budget.
///
/// Every co-hosted config gets the same catalog before an isolate starts, so a
/// shared `__Queue` class cannot dispatch according to whichever producer
/// registered the class first.
pub(super) fn inject_queue_config(scope: &mut v8::PinScope, config: &WorkerConfig) -> Result<()> {
    let queue = crate::queue_policy::consumer_config(config)?;
    let source = format!(
        "const q = {queue};\n\
         const c = __celld.__cell;\n\
         c.queueConsumers = Object.assign({{ __proto__: null }}, q.consumers);\n\
         c.queueLeaseDurationMs = q.leaseDurationMs;\n\
         c.queueLimits = q.limits;"
    );
    run_internal_snippet(scope, &source).ok_or_else(|| anyhow!("queue config install failed"))?;
    Ok(())
}

/// Record every exported class deriving from `WorkerEntrypoint` in
/// `__cell.entrypoints`, so a service binding with `entrypoint = "Name"` can
/// resolve it, and every export deriving from `DurableObject` in
/// `__cell.doExports`, so misrouting a DO class as a stateless entrypoint is
/// reported as such (Workerd getExportedHandler()). Every class export that
/// is not an entrypoint or a workflow also lands in `__cell.classes`, so a
/// facet can start it. Runs once per load; the check is a prototype walk, not a
/// call into user code.
pub(super) fn register_entrypoints(
    scope: &mut v8::PinScope,
    ns: v8::Local<v8::Object>,
) -> Result<()> {
    let cell = cell_state(scope)?;
    let key = v8::String::new(scope, "entrypoints").unwrap();
    let entrypoints = cell
        .get(scope, key.into())
        .and_then(|value| value.to_object(scope))
        .ok_or_else(|| anyhow!("missing entrypoint registry"))?;
    let key = v8::String::new(scope, "objectEntrypoints").unwrap();
    let object_entrypoints = cell
        .get(scope, key.into())
        .and_then(|value| value.to_object(scope))
        .ok_or_else(|| anyhow!("missing object-entrypoint registry"))?;
    let key = v8::String::new(scope, "doExports").unwrap();
    let do_exports = cell
        .get(scope, key.into())
        .and_then(|value| value.to_object(scope))
        .ok_or_else(|| anyhow!("missing doExports registry"))?;
    let key = v8::String::new(scope, "classes").unwrap();
    let classes = cell
        .get(scope, key.into())
        .and_then(|value| value.to_object(scope))
        .ok_or_else(|| anyhow!("missing Durable Object class registry"))?;
    let cf = internal_object(scope, "__cf")?;
    let key = v8::String::new(scope, "WorkerEntrypoint").unwrap();
    let entrypoint_base = cf
        .get(scope, key.into())
        .ok_or_else(|| anyhow!("missing WorkerEntrypoint base"))?;
    let key = v8::String::new(scope, "DurableObject").unwrap();
    let durable_base = cf
        .get(scope, key.into())
        .ok_or_else(|| anyhow!("missing DurableObject base"))?;
    let key = v8::String::new(scope, "WorkflowEntrypoint").unwrap();
    let workflow_base = cf
        .get(scope, key.into())
        .ok_or_else(|| anyhow!("missing WorkflowEntrypoint base"))?;
    let Some(names) = ns.get_own_property_names(scope, Default::default()) else {
        return Ok(());
    };
    let yes = v8::Boolean::new(scope, true);
    let extends = compile_fn(scope, EXTENDS_SRC)?;
    for index in 0..names.length() {
        let Some(name) = names.get_index(scope, index) else {
            continue;
        };
        let Some(value) = ns.get(scope, name) else {
            continue;
        };
        if !value.is_function() {
            // A plain-object export is Workerd's non-class entrypoint; its
            // handler functions dispatch as fn(arg, env, ctx).
            if value.is_object() {
                object_entrypoints.set(scope, name, value);
            }
            continue;
        }
        // Walk the prototype chain rather than calling anything. The walk
        // runs in JS: Reflect.getPrototypeOf honors Proxy exports (SDK shims
        // like workers-rs wrap their classes), which the host-side
        // Object::GetPrototype does not.
        if call_extends(scope, extends, value, entrypoint_base)? {
            entrypoints.set(scope, name, value);
        } else if call_extends(scope, extends, value, durable_base)? {
            do_exports.set(scope, name, yes.into());
            classes.set(scope, name, value);
        } else if !call_extends(scope, extends, value, workflow_base)? {
            // Workerd processEntrypointClass(): a class that extends none of
            // the runtime bases is a Durable Object class (missingSuperclass).
            // A loaded Worker's facet class reaches `_instance` only through
            // this registry, so without it a plain class fails with "no DO
            // class". It stays out of `doExports`: that entry grants RPC
            // without the js_rpc flag, which workerd gives only a subclass.
            classes.set(scope, name, value);
        }
    }
    Ok(())
}

/// Validate the deployment's workflow classes at load: each configured
/// `class_name` must be a module export that extends `WorkflowEntrypoint`
/// from `cloudflare:workers`, so a wrong class fails the load loudly,
/// exactly as a Durable Object export does. The per-replay resolution off
/// `__cell.workflows` and `__cf.exports` is unchanged; this checks the same
/// names once, up front, instead of erroring the first instance at run time.
pub(super) fn validate_workflow_classes(
    scope: &mut v8::PinScope,
    ns: v8::Local<v8::Object>,
    workflow_bindings: &[WorkflowBinding],
) -> Result<()> {
    if workflow_bindings.is_empty() {
        return Ok(());
    }
    let cf = internal_object(scope, "__cf")?;
    let key = v8::String::new(scope, "WorkflowEntrypoint").unwrap();
    let base = cf
        .get(scope, key.into())
        .ok_or_else(|| anyhow!("missing WorkflowEntrypoint base"))?;
    let extends = compile_fn(scope, EXTENDS_SRC)?;
    for binding in workflow_bindings {
        let class_name = binding.class.as_str();
        let key = v8::String::new(scope, class_name).unwrap();
        let class = ns
            .get(scope, key.into())
            .filter(|value| !value.is_undefined())
            .ok_or_else(|| {
                anyhow!("workflow class {class_name} is not exported by the Worker module")
            })?;
        if !class.is_function() || !call_extends(scope, extends, class, base)? {
            anyhow::bail!(
                "workflow class {class_name} must extend WorkflowEntrypoint \
                 from cloudflare:workers"
            );
        }
    }
    Ok(())
}

/// `(cls, base) => base is on cls's prototype chain`, via Reflect so Proxy
/// wrappers report the prototype their handler exposes. A getPrototypeOf trap
/// also makes the chain user-controlled (a cycle, or a fresh Proxy per hop,
/// is spec-legal on an extensible target), so track visited links and cap the
/// walk rather than let it hang the load.
const EXTENDS_SRC: &str = "((cls, base) => { \
    const seen = new Set(); \
    for (let p = Reflect.getPrototypeOf(cls); p; p = Reflect.getPrototypeOf(p)) { \
        if (p === base) return true; \
        if (seen.has(p) || seen.size >= 1000) return false; \
        seen.add(p); \
    } \
    return false; })";

/// The walk crosses into user code when an export is a Proxy, so it can throw
/// (a revoked Proxy, a throwing getPrototypeOf trap). Pin a TryCatch and
/// surface that as a load error rather than misclassifying the export.
fn call_extends(
    scope: &mut v8::PinScope,
    extends: v8::Local<v8::Function>,
    class: v8::Local<v8::Value>,
    base: v8::Local<v8::Value>,
) -> Result<bool> {
    let tc = std::pin::pin!(v8::TryCatch::new(scope));
    let scope = &mut tc.init();
    let recv = v8::undefined(scope).into();
    match extends.call(scope, recv, &[class, base]) {
        Some(result) => Ok(result.is_true()),
        None => Err(anyhow!("inspect export prototype chain: {}", exc!(scope))),
    }
}

/// Record the node id. Every cell scope routes through the host, whichever node
/// owns it.
pub(super) fn inject_routing(scope: &mut v8::PinScope, node: &str) -> Result<()> {
    let src = format!("__celld.__cell.node = {node:?};");
    run_internal_snippet(scope, &src).ok_or_else(|| anyhow!("routing install failed"))?;
    Ok(())
}

/// Release a cell's instance and restore its id name.
///
/// The isolate-side half of taking a cell in or giving it back: taking it opens
/// the cell's storage, giving it back releases what the isolate holds and closes
/// the database, so state cannot span two epochs.
pub(super) fn adopt_cell(
    tc: &mut v8::PinScope,
    cell: &str,
    cell_storage: Option<CellStorage<'_>>,
    compat: Compat,
) -> Result<Option<i64>> {
    let owned = cell_storage.is_some();
    // No cell enters a condemned isolate, and refusing before the open keeps
    // its database closed.
    if owned && super::heap_limit_reached(tc) {
        return Err(anyhow!(super::MEMORY_EXCEEDED));
    }
    if let Some(cell_storage) = cell_storage {
        storage::open_at_epoch(
            cell,
            cell_storage.path,
            cell_storage.epoch,
            cell_storage.replicated_wake,
            cell_storage.vfs,
            compat.sqlite_vec,
        )
        .context("cell storage open failed")?;
    }
    finish_cell_adoption(tc, cell, owned)
}

pub(super) struct EmbeddedStartup {
    pub id_sc: Vec<u8>,
    pub props_sc: Vec<u8>,
    pub path: std::path::PathBuf,
    pub restored: bool,
}

pub(super) fn adopt_embedded_cell(
    tc: &mut v8::PinScope,
    cell: &str,
    parent: &storage::StorageIdentity,
    name: &str,
    startup: EmbeddedStartup,
    compat: Compat,
) -> Result<Option<i64>> {
    storage::open_embedded(
        cell,
        parent,
        name,
        &startup.path,
        startup.restored,
        compat.sqlite_vec,
    )
    .context("facet storage open failed")?;
    let alarm = finish_cell_adoption(tc, cell, true)?;
    let depth = parent.facet_path.len() + 1;
    // Decode in the loaded isolate and install the value directly. A JSON
    // source string flattened structured-clone types before the constructor
    // could read them, and it represented absent props as an explicit null.
    let cell_state = cell_state(tc)?;
    let configs_key = v8::String::new(tc, "facetConfigs").unwrap();
    let configs = cell_state
        .get(tc, configs_key.into())
        .and_then(|value| value.to_object(tc))
        .ok_or_else(|| anyhow!("missing facet config registry"))?;
    let config = null_prototype_object(tc);
    let id_key = v8::String::new(tc, "id").unwrap();
    let id_value =
        storage_ops::deserialize_storage_value(tc, storage::StoredValue::V8(startup.id_sc))
            .ok_or_else(|| anyhow!("decode facet identity"))?;
    config.set(tc, id_key.into(), id_value);
    let props = if startup.props_sc.is_empty() {
        v8::undefined(tc).into()
    } else {
        storage_ops::deserialize_storage_value(tc, storage::StoredValue::V8(startup.props_sc))
            .ok_or_else(|| anyhow!("decode facet props"))?
    };
    let props_key = v8::String::new(tc, "props").unwrap();
    config.set(tc, props_key.into(), props);
    let depth_key = v8::String::new(tc, "depth").unwrap();
    let depth_value = v8::Integer::new(tc, depth as i32);
    config.set(tc, depth_key.into(), depth_value.into());
    let cell_key = v8::String::new(tc, cell).unwrap();
    configs.set(tc, cell_key.into(), config.into());
    Ok(alarm)
}

fn finish_cell_adoption(tc: &mut v8::PinScope, cell: &str, owned: bool) -> Result<Option<i64>> {
    // Every cell dispatch goes out through the host and arrives as an ordinary
    // reentrant `CellJob::Fetch`. There is no same-isolate shortcut, and there
    // will not be one.
    //
    // A dispatch that ran the callee's handler inside the caller's execution
    // would skip the callee's IoContext, its input gate, and its request
    // accounting: a `blockConcurrencyWhile` held by the callee would not hold
    // off such a call. That is a different semantic, not an optimisation. The
    // nesting deadlock that first disabled the shortcut -- A calls B, B calls
    // back into A, and the stack never unwinds -- was the symptom of crossing
    // that boundary rather than the reason to avoid it.
    //
    // The script releases everything the isolate holds for this cell's
    // residency, on both edges: the give-back frees what the application left
    // behind — memory the node cannot shed, because the cell has left
    // residency — and the take-in stops state spanning two epochs, which
    // corrupts rather than leaks. `__cell.release` lives in the harness
    // because what a residency owns is decided by the maps that hold it; this
    // side only says when.
    //
    // The release loses nothing the cell needs back: `register_actor_name`
    // persists the id name before writing it here, so the take-in below reads
    // it back.
    // A condemned isolate runs no JavaScript again, so a cell leaving one
    // skips the release, whose memory goes with the isolate, and keeps the
    // host's side below. None can enter one (`adopt_cell`).
    let condemned = super::heap_limit_reached(tc);
    if condemned && owned {
        return Err(anyhow!(super::MEMORY_EXCEEDED));
    }
    // The host's side first, and whatever the script's side does: the grants
    // the released residency held go with the objects that held them, and so
    // do the TCP sockets and HTMLRewriter transforms its objects made.
    crate::ws_registry::ws_release_grants(&crate::ws_registry::WsOwner::Cell(cell.to_string()));
    super::tcp::release_cell(cell);
    super::html_rewriter::release_cell(cell);
    let released = if condemned {
        Ok(())
    } else {
        let source = format!("__celld.__cell.release({cell:?});");
        run_internal_snippet(tc, &source)
            .map(drop)
            .ok_or_else(|| anyhow!("adopt failed"))
    };
    if !owned {
        // A facet of the root's own class lives in this isolate, and nothing
        // else releases it: its realm and connection would outlive the root.
        // Every facet's host side is released even if a script release fails;
        // the first failure is the answer.
        let mut released = released;
        for facet in storage::embedded_facets(cell) {
            if !condemned {
                let source = format!("__celld.__cell.release({facet:?});");
                let facet_released = run_internal_snippet(tc, &source)
                    .map(drop)
                    .ok_or_else(|| anyhow!("release failed"));
                released = released.and(facet_released);
            }
            storage::close(&facet);
            crate::ws_registry::ws_close_facet(&facet, "the parent Durable Object was released");
            super::tcp::release_cell(&facet);
            super::html_rewriter::release_cell(&facet);
        }
        storage::close(cell);
        released?;
        return Ok(None);
    }
    released?;
    let name = storage::get_actor_name(cell).context("read actor name")?;
    register_actor_name(tc, cell, name.as_deref())?;
    Ok(storage::get_alarm(cell))
}

pub(super) fn inject_storage_compatibility(scope: &mut v8::PinScope, compat: Compat) -> Result<()> {
    let source = format!(
        "const c = __celld.__cell;\n\
         c.deleteAllDeletesAlarm = {};\n\
         c.compat.jsRpc = {};\n\
         c.compat.fetcherGetPutDelete = {};\n\
         c.compat.websocketStandardBinaryType = {};\n\
         c.compat.webSocketAutoReplyToClose = {};\n\
         c.compat.queueJsonMessages = {};\n\
         c.compat.allowIrrevocableStubStorage = {};\n\
         c.compat.disallowImportableEnv = {};\n\
         c.compat.serviceBindingExtraHandlers = {};\n\
         c.compat.rpcParamsDupStubs = {};",
        compat.delete_all_deletes_alarm,
        compat.js_rpc,
        compat.fetcher_get_put_delete,
        compat.websocket_standard_binary_type,
        compat.web_socket_auto_reply_to_close,
        compat.queue_json_messages,
        compat.allow_irrevocable_stub_storage,
        compat.disallow_importable_env,
        compat.service_binding_extra_handlers,
        compat.rpc_params_dup_stubs,
    );
    run_internal_snippet(scope, &source).ok_or_else(|| anyhow!("compatibility install failed"))?;
    Ok(())
}

/// `__cell.env`, the bindings object every handler receives as its second
/// argument.
///
/// This runs per request, so both keys come from the constant table. The
/// *value* stays a live lookup: unlike the event hooks, `env` is an ordinary
/// data property that a worker's own code can replace, and holding the object
/// this returns would make the host ignore that. The saving there is one
/// property read, so the correctness question decides it.
pub(super) fn harness_env<'s>(
    scope: &mut v8::PinScope<'s, '_>,
) -> Result<v8::Local<'s, v8::Value>> {
    let cell = cell_state(scope)?;
    let ek = static_key(scope, &v8_strings::ENV);
    Ok(cell.get(scope, ek.into()).unwrap())
}

pub(super) fn begin_event_context<'s>(
    scope: &mut v8::PinScope<'s, '_>,
) -> Result<v8::Local<'s, v8::Value>> {
    let function = event_hook(scope, |hooks| &hooks.begin_event)?;
    let recv = v8::undefined(scope).into();
    function
        .call(scope, recv, &[])
        .ok_or_else(|| anyhow!("__beginEvent threw"))
}

pub(super) fn end_event_context<'s>(
    scope: &mut v8::PinScope<'s, '_>,
) -> Result<Option<v8::Local<'s, v8::Promise>>> {
    let function = event_hook(scope, |hooks| &hooks.end_event)?;
    let recv = v8::undefined(scope).into();
    let value = function
        .call(scope, recv, &[])
        .ok_or_else(|| anyhow!("__endEvent threw"))?;
    if value.is_null_or_undefined() {
        Ok(None)
    } else {
        Ok(Some(value.try_into().map_err(|_| {
            anyhow!("__endEvent did not return a promise")
        })?))
    }
}

// ---- module compilation + request/response marshalling ----

#[cfg(test)]
mod tests {
    use super::*;

    /// Loads `src` as a deployment's main module with `do_classes`, on a
    /// thread started after V8 is, as `runtime::init_v8` requires.
    fn load(src: &str, do_classes: &[&str]) -> Result<(), String> {
        load_with_services(src, do_classes, Vec::new())
    }

    fn load_with_services(
        src: &str,
        do_classes: &[&str],
        services: Vec<crate::js::ServiceBinding>,
    ) -> Result<(), String> {
        let config = config(src, do_classes, services);
        std::thread::spawn(move || {
            Worker::load_config(config)
                .map(drop)
                .map_err(|error| error.to_string())
        })
        .join()
        .expect("load thread panicked")
    }

    fn config(
        src: &str,
        do_classes: &[&str],
        services: Vec<crate::js::ServiceBinding>,
    ) -> Arc<WorkerConfig> {
        Engine::init();
        Arc::new(
            WorkerConfig::new(WorkerConfigOptions {
                src: src.to_string(),
                script_name: "test".to_string(),
                do_classes: do_classes.iter().map(|class| class.to_string()).collect(),
                bindings: Vec::new(),
                r2_bindings: Vec::new(),
                d1_bindings: Vec::new(),
                kv_bindings: Vec::new(),
                queue_bindings: Vec::new(),
                queue_consumers: Vec::new(),
                workflow_bindings: Vec::new(),
                vars: Vec::new(),
                node: String::new(),
                modules: Vec::new(),
                compat: Compat::default(),
            })
            .with_services(services),
        )
    }

    const HANDLER: &str = "export default { fetch() { return new Response(); } };\n";

    #[test]
    fn a_durable_object_class_the_module_does_not_export_fails_the_load() {
        let refused = "A DurableObjectNamespace in the config referenced the class \"Room\", \
                       but no such Durable Object class is exported from the worker. Please \
                       make sure the class name matches, it is exported, and the class extends \
                       'DurableObject'."
            .to_string();
        assert_eq!(load(HANDLER, &["Room"]), Err(refused.clone()));
        let not_a_class = format!("{HANDLER}export const Room = {{ fetch() {{}} }};\n");
        assert_eq!(load(&not_a_class, &["Room"]), Err(refused));
        let exported = format!("{HANDLER}export class Room {{}}\n");
        assert_eq!(load(&exported, &["Room"]), Ok(()));
    }

    fn service(props: serde_json::Value) -> crate::js::ServiceBinding {
        let serde_json::Value::Object(props) = props else {
            panic!("props must be an object");
        };
        crate::js::ServiceBinding {
            environment: "REPORTER".to_string(),
            script: "errors".to_string(),
            entrypoint: None,
            props: Some(props),
        }
    }

    #[test]
    fn props_reach_the_snippet_as_json_text_with_line_separators_escaped() {
        let serde_json::Value::Object(props) = serde_json::json!({
            "__proto__": { "a": "\"\\\u{2028}\u{2029}" },
        }) else {
            unreachable!()
        };
        assert_eq!(
            json_text_literal(&props).unwrap(),
            r#""{\"__proto__\":{\"a\":\"\\\"\\\\\u2028\u2029\"}}""#
        );
    }

    /// Props at the deploy's bound encode within the limit, whatever their
    /// shape: anything `celld deploy` accepts starts.
    #[test]
    fn service_binding_props_the_deploy_accepts_load() {
        let limit = 1024 * 1024;
        let record = serde_json::json!({
            "n": -1.5, "i": 12, "big": 1u64 << 40, "b": true, "z": null,
            "l": [1, "x", { "é": "\u{2028}" }], "key😀": "text",
        });
        let records = |count: usize| serde_json::json!({ "r": vec![record.clone(); count] });
        let per_record = crate::deploy::encoded_props_bound(&records(1))
            - crate::deploy::encoded_props_bound(&records(0));
        let fill = records((limit - crate::deploy::encoded_props_bound(&records(0))) / per_record);
        let body = |unit: usize| limit - 24 - (limit - 24) % unit;
        for props in [
            serde_json::json!({ "s": "a".repeat(body(1)) }),
            serde_json::json!({ "s": "é".repeat(body(1)) }),
            serde_json::json!({ "s": "\u{2028}".repeat(body(2) / 2) }),
            serde_json::json!({ "s": "😀".repeat(body(4) / 4) }),
            fill,
        ] {
            let bound = crate::deploy::encoded_props_bound(&props);
            assert!(bound <= limit && bound > limit - 1024, "{bound}");
            assert_eq!(
                load_with_services(HANDLER, &[], vec![service(props)]),
                Ok(())
            );
        }
    }

    /// A manifest from another control plane skips the deploy's check, so
    /// the isolate checks the encoding too.
    #[test]
    fn service_binding_props_over_one_mebibyte_encoded_fail_the_load() {
        let fits = format!("{}\u{2028}", "a".repeat(500_000));
        assert_eq!(
            load_with_services(
                HANDLER,
                &[],
                vec![service(serde_json::json!({ "s": fits }))]
            ),
            Ok(())
        );
        let over = format!("{}\u{2028}", "a".repeat(600_000));
        assert_eq!(
            load_with_services(
                HANDLER,
                &[],
                vec![service(serde_json::json!({ "s": over }))]
            ),
            Err(
                "env install failed: RangeError: Service binding REPORTER props size \
                 (1200014 bytes) exceeds the maximum allowed size of 1048576 bytes."
                    .to_string()
            )
        );
    }

    /// Module scope that retains past the heap limit fails the load, where it
    /// used to grow the process for as long as it allocated. The isolate is
    /// discarded, so the next load starts clean. Each module retains about
    /// four times the default limit, so a regression loads rather than
    /// exhausting the machine.
    #[test]
    fn module_scope_past_the_heap_limit_fails_the_load() {
        let arrays = format!(
            "const keep = []; for (let i = 0; i < 8e6; i++) keep.push([i, 1, 2]);\n{HANDLER}"
        );
        assert_eq!(load(&arrays, &[]), Err(STARTUP_MEMORY_EXCEEDED.to_string()));
        // toUpperCase() copies each string flat: a repeat() result shares its
        // parts, so it would retain a tenth as much.
        let strings = format!(
            "const keep = []; for (let i = 0; i < 1.2e5; i++) keep.push((\"x\".repeat(4096) + i).toUpperCase());\n{HANDLER}"
        );
        assert_eq!(
            load(&strings, &[]),
            Err(STARTUP_MEMORY_EXCEEDED.to_string())
        );
        assert_eq!(load(HANDLER, &[]), Ok(()));
    }

    /// The same for a Durable Object class's module, which a cell isolate
    /// loads through the same path.
    #[test]
    fn a_durable_object_module_past_the_heap_limit_fails_the_load() {
        let src = format!(
            "const keep = []; for (let i = 0; i < 8e6; i++) keep.push([i, 1, 2]);\n\
             {HANDLER}export class Room {{}}\n"
        );
        assert_eq!(
            load(&src, &["Room"]),
            Err(STARTUP_MEMORY_EXCEEDED.to_string())
        );
    }

    /// One allocation larger than the limit at module scope finishes before
    /// the termination lands, rather than aborting the process: the 1 GB
    /// array is V8's largest object, built while the 1 GB array it converts
    /// is still live, and the string is a 512 MB two-byte one.
    #[test]
    fn one_allocation_past_the_heap_limit_fails_the_load() {
        let array = format!("globalThis.keep = new Array(1.3e8).fill(1.5);\n{HANDLER}");
        assert_eq!(load(&array, &[]), Err(STARTUP_MEMORY_EXCEEDED.to_string()));
        let string =
            format!("globalThis.keep = \"\\u1234\".repeat(2 ** 28).toLowerCase();\n{HANDLER}");
        assert_eq!(load(&string, &[]), Err(STARTUP_MEMORY_EXCEEDED.to_string()));
    }

    /// One allocation past the limit by a wide margin: a 400 MB two-byte
    /// string, well under V8's largest (`String::kMaxLength`, 2^29 - 24
    /// characters), so a V8 upgrade does not turn it into a RangeError.
    const ONE_ALLOCATION: &str =
        "globalThis.keep = \"\\u1234\".repeat(2e8).toLowerCase(); keep.length";

    /// What a loaded isolate makes of `source`, run as a request would after
    /// the load: the script's result, the error its turn takes, the answer to
    /// a fetch that arrives next (`began` when it runs), and whether the
    /// load's limit fired.
    fn run_after_load(source: &'static str) -> (Option<String>, String, String, bool) {
        let config = config(HANDLER, &[], Vec::new());
        std::thread::spawn(move || {
            let mut worker = Worker::load_config(config).expect("the handler loads");
            let (result, first, load_exceeded) = {
                let (mut locker, _cells) = worker.lock();
                v8::scope!(let hs, &mut *locker);
                let realm = worker.realm(hs);
                let scope = &mut v8::ContextScope::new(hs, realm.context);
                let source = v8::String::new(scope, source).unwrap();
                let result = v8::Script::compile(scope, source, None)
                    .and_then(|script| script.run(scope))
                    .map(|value| value.to_rust_string_lossy(scope));
                let first = take_execution_termination(scope)
                    .map_or_else(String::new, |error| error.to_string());
                let state = scope.get_slot::<Arc<HeapLimitState>>().unwrap().clone();
                (result, first, state.load_exceeded.load(Ordering::Relaxed))
            };
            // `HANDLER` answers 200 if it runs at all.
            let (reply, mut answer) = tokio::sync::oneshot::channel();
            let job = crate::WorkerJob::Fetch {
                queued_at: Instant::now(),
                entrypoint: None,
                invocation_limits: None,
                url: "http://worker/".to_string(),
                method: "GET".to_string(),
                body: crate::js::RequestBody::Bytes(Default::default()),
                headers: Vec::new(),
                request_id: None,
                tail_report: None,
                reply,
            };
            // A condemned isolate fails the fetch at once, without running it.
            let (begun, _ops) = worker.turn_begin(job, None, None);
            let next = if begun.is_some() {
                "began".to_string()
            } else {
                match answer.try_recv().expect("the fetch is answered at once") {
                    Ok(response) => format!("answered {}", response.status),
                    Err(error) => error.to_string(),
                }
            };
            (result, first, next, load_exceeded)
        })
        .join()
        .expect("the request thread panicked")
    }

    /// After the load, reaching the heap limit terminates what runs and
    /// condemns the isolate: no JavaScript runs there again, so the next
    /// event fails with workerd's error without running, and the load's own
    /// limit stays out of it.
    #[test]
    fn reaching_the_heap_limit_after_the_load_condemns_the_isolate() {
        // About 180 MB retained, past the 128 MiB default.
        let (result, first, next, load_exceeded) = run_after_load(
            "globalThis.keep = []; for (let i = 0; i < 3e6; i++) keep.push([i, 1, 2]); keep.length",
        );
        assert_eq!(result, None);
        assert_eq!(first, MEMORY_EXCEEDED);
        assert_eq!(next, MEMORY_EXCEEDED);
        assert!(!load_exceeded);
    }

    /// One allocation past the limit after the load finishes, rather than V8
    /// aborting the process. The script can end before the termination lands, and the
    /// turn fails either way.
    #[test]
    fn one_allocation_past_the_heap_limit_after_the_load_condemns_the_isolate() {
        let (_, first, next, _) = run_after_load(ONE_ALLOCATION);
        assert_eq!(first, MEMORY_EXCEEDED);
        assert_eq!(next, MEMORY_EXCEEDED);
    }

    /// A load that fails reports as workerd does: "Uncaught " and the thrown
    /// value's description, then where an `Error` was made or where the
    /// parser stopped. A Worker Loader puts its own line in front, and types
    /// a startup limit as an `Error`.
    #[test]
    fn a_failed_load_reports_as_workerd_does() {
        let cases = [
            (
                format!("{HANDLER}function f() {{ throw new TypeError('no'); }}\nf();"),
                "Uncaught TypeError: no\n  at worker.js:2:22 in f\n  at worker.js:3:1",
            ),
            (format!("{HANDLER}throw 'text';"), "Uncaught Error: text"),
            (
                format!("{HANDLER}const e = new Error('x'); e.name = 'Mine'; throw e;"),
                "Uncaught Error: Mine: x\n  at worker.js:2:11",
            ),
            (
                format!("{HANDLER}let = = 1;"),
                "Uncaught SyntaxError: Unexpected strict mode reserved word\n  at worker.js:2",
            ),
            (
                format!("import './gone.js';\n{HANDLER}"),
                "Uncaught Error: No such module \"gone.js\".\n  imported from \"worker.js\"",
            ),
            (
                format!("import '../up.js';\n{HANDLER}"),
                "Uncaught TypeError: Invalid module specifier \"../up.js\".\n  imported from \"worker.js\".",
            ),
            // celld's own frames are left out.
            (
                format!("{HANDLER}structuredClone(() => {{}});"),
                "Uncaught DOMException(DataCloneError): () => {} could not be cloned.\n  at worker.js:2:1",
            ),
            (
                format!("{HANDLER}await new Promise(() => {{}});"),
                "Uncaught Error: Top-level await in module is unsettled.",
            ),
        ];
        for (source, report) in cases {
            assert_eq!(load(&source, &[]), Err(report.to_string()), "{source}");
        }
        assert_eq!(
            failed_to_start(&anyhow!("Uncaught Error: text")),
            "Failed to start Worker:\nUncaught Error: text"
        );
        assert_eq!(
            failed_to_start(&anyhow::Error::new(StartupCpuExceeded)),
            format!("Failed to start Worker:\nError: {STARTUP_CPU_EXCEEDED}")
        );
        assert_eq!(
            failed_to_start(&anyhow!(STARTUP_MEMORY_EXCEEDED)),
            format!("Failed to start Worker:\nError: {STARTUP_MEMORY_EXCEEDED}")
        );
    }

    /// A buffer the budget refuses at module scope throws V8's RangeError,
    /// which fails the load as any throw there does, and does not count as
    /// the memory limit: a refusal takes no memory. Caught, it costs nothing.
    #[test]
    fn module_scope_buffers_past_the_budget_are_refused() {
        for buffers in [
            "const keep = []; for (let i = 0; i < 40; i++) keep.push(new Uint8Array(64 << 20));",
            "globalThis.keep = new Uint8Array(512 << 20);",
        ] {
            let error = load(&format!("{buffers}\n{HANDLER}"), &[]).unwrap_err();
            assert_eq!(
                error.lines().next(),
                Some("Uncaught RangeError: Array buffer allocation failed"),
                "{buffers}"
            );
        }
        for fits in [
            "try { globalThis.keep = new ArrayBuffer(512 << 20); } catch {}",
            "globalThis.keep = new Uint8Array(64 << 20);",
        ] {
            assert_eq!(load(&format!("{fits}\n{HANDLER}"), &[]), Ok(()), "{fits}");
        }
    }

    /// Memory V8 grows outside the allocator is bounded within the load, not
    /// only when it ends. Growth JavaScript asks for past the budget is
    /// refused with V8's RangeError (a resizable buffer resized past it, a
    /// transfer that grows one, many WebAssembly memories); a module that
    /// grows its own memory in Wasm is stopped by the watch, and fails the
    /// load as the memory limit does.
    #[test]
    fn growth_outside_the_allocator_is_bounded_within_the_load() {
        const GROWS_ITSELF: &str = "AGFzbQEAAAABCQJgAX8Bf2AAAAMDAgABBQMBAAEHEAIEZ3JvdwAABXRvdWNoAAEKFwIGACAAQAALDgBBAEEBPwBBEHT8CwAL";
        for (growth, refusal) in [
            (
                "const b = new ArrayBuffer(0, { maxByteLength: 2 ** 31 }); b.resize(1 << 30);",
                "ArrayBuffer.prototype.resize: Out of memory",
            ),
            (
                "const b = new ArrayBuffer(0, { maxByteLength: 2 ** 31 }); \
                 new Uint8Array(b.transfer(2 ** 31)).fill(1);",
                "Array buffer allocation failed",
            ),
            (
                "const k = []; for (let i = 0; i < 10; i++) k.push(new WebAssembly.Memory({ initial: 1600 }));",
                "WebAssembly.Memory(): could not allocate memory",
            ),
        ] {
            let error = load(&format!("{growth}\n{HANDLER}"), &[]).unwrap_err();
            assert_eq!(
                error.lines().next(),
                Some(format!("Uncaught RangeError: {refusal}").as_str()),
                "{growth}"
            );
            // The frames start at the Worker's call, with no harness frames.
            assert!(
                error.lines().nth(1).is_some_and(|frame| frame.starts_with("  at worker.js:")),
                "{error}"
            );
        }
        let grows_itself = format!(
            "const m = new WebAssembly.Module(Uint8Array.from(atob('{GROWS_ITSELF}'), (c) => c.charCodeAt(0))); \
             const k = []; for (let i = 0; i < 10; i++) {{ const x = new WebAssembly.Instance(m); \
             for (let p = 0; p < 1900; p += 50) {{ x.exports.grow(50); x.exports.touch(); }} k.push(x); }}"
        );
        assert_eq!(
            load(&format!("{grows_itself}\n{HANDLER}"), &[]),
            Err(STARTUP_MEMORY_EXCEEDED.to_string())
        );
        let fits = "const m = new WebAssembly.Memory({ initial: 16 }); m.grow(16);\n";
        assert_eq!(load(&format!("{fits}{HANDLER}"), &[]), Ok(()));
    }

    /// After the load, a buffer the budget refuses throws V8's RangeError in
    /// the turn and leaves the isolate serving.
    #[test]
    fn a_buffer_refused_after_the_load_leaves_the_isolate_serving() {
        let (result, first, next, _) =
            run_after_load("globalThis.keep = new Uint8Array(512 << 20); keep.length");
        assert_eq!(
            (result, first, next.as_str()),
            (None, String::new(), "began")
        );
        let (result, first, next, _) = run_after_load(
            "let e; try { new Uint8Array(512 << 20) } catch (error) { e = error.message } e",
        );
        assert_eq!(
            (result.as_deref(), first, next.as_str()),
            (
                Some("Array buffer allocation failed"),
                String::new(),
                "began"
            )
        );
    }

    /// A refusal does not hide the heap limit reached after it: V8 calls the
    /// heap-limit callback for a refused buffer, which leaves the isolate be,
    /// and for the heap, which still condemns it rather than aborting.
    #[test]
    fn the_heap_limit_after_a_refused_buffer_still_condemns_the_isolate() {
        let (_, first, next, _) = run_after_load(
            "try { new Uint8Array(512 << 20); } catch {} \
             globalThis.keep = \"\\u1234\".repeat(2e8).toLowerCase(); keep.length",
        );
        assert_eq!(first, MEMORY_EXCEEDED);
        assert_eq!(next, MEMORY_EXCEEDED);
    }

    /// Only an isolate that has made WebAssembly has its turns watched: a
    /// resizable buffer grows only through the checked methods.
    #[test]
    fn only_webassembly_watches_the_isolate() {
        let config = config(HANDLER, &[], Vec::new());
        std::thread::spawn(move || {
            let worker = Worker::load_config(config).expect("the handler loads");
            let watched = |source: &str| {
                let (mut locker, _cells) = worker.lock();
                v8::scope!(let hs, &mut *locker);
                let realm = worker.realm(hs);
                let scope = &mut v8::ContextScope::new(hs, realm.context);
                let source = v8::String::new(scope, source).unwrap();
                v8::Script::compile(scope, source, None)
                    .and_then(|script| script.run(scope))
                    .expect("the script runs");
                scope
                    .get_slot::<Arc<BackingStoreBudget>>()
                    .unwrap()
                    .watched
                    .load(Ordering::Relaxed)
            };
            assert!(!watched(
                "new ArrayBuffer(0, { maxByteLength: 64 }).resize(32); \
                 new SharedArrayBuffer(0, { maxByteLength: 64 }).grow(32);"
            ));
            assert!(watched("new WebAssembly.Memory({ initial: 1 });"));
        })
        .join()
        .expect("the test thread panicked");
    }

    /// A load past the startup CPU limit carries a type a loader can retry,
    /// whichever path took the termination; a throw at module scope does not.
    #[test]
    fn only_the_startup_cpu_limit_is_typed_as_transient() {
        let transient = |src: String| {
            let config = config(&src, &[], Vec::new());
            std::thread::spawn(move || {
                Worker::load_config(config)
                    .err()
                    .map(|error| error.is::<StartupCpuExceeded>())
            })
            .join()
            .expect("load thread panicked")
        };
        assert_eq!(
            transient(format!("while (true) {{}}\n{HANDLER}")),
            Some(true)
        );
        let getter = "export default { get fetch() { while (true) {} } };\n".to_string();
        assert_eq!(transient(getter), Some(true));
        assert_eq!(
            transient(format!("throw new Error('no');\n{HANDLER}")),
            Some(false)
        );
    }

    /// Module scope that never returns, or a handler lookup that never does,
    /// fails the load after the startup CPU limit instead of holding its
    /// thread for good.
    #[test]
    fn a_load_past_the_startup_cpu_limit_fails() {
        let module_scope = format!("while (true) {{}}\n{HANDLER}");
        assert_eq!(
            load(&module_scope, &[]),
            Err(STARTUP_CPU_EXCEEDED.to_string())
        );
        let getter = "export default { get fetch() { while (true) {} } };\n";
        assert_eq!(load(getter, &[]), Err(STARTUP_CPU_EXCEEDED.to_string()));
        assert_eq!(load(HANDLER, &[]), Ok(()));
    }
}
