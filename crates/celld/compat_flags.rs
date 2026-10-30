// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! Compatibility flags: every flag of workerd's `compatibility-date.capnp` at
//! [`WORKERD_VERSION`], and what celld does with each. Everything in celld
//! that reads a flag reads it from this table.
//!
//! [`compile`] computes a Worker's flags from its compatibility date and flags
//! as workerd does (`compileCompatibilityFlags` in `compatibility-date.c++`)
//! and refuses what workerd refuses, with workerd's messages. It also refuses
//! a flag that would select a behaviour celld lacks, an experimental flag
//! celld does not honour, and a date past [`NEWEST_DATE`].
//!
//! Each flag's [`Support`] says what celld does:
//! - [`Support::Honoured`]: celld follows the computed value, and
//!   `Cloudflare.compatibilityFlags` reports it as workerd does. One is
//!   honoured only in part: `service_binding_extra_handlers` (see its entry).
//! - [`Support::NoEffect`]: the flag does not change anything celld runs.
//! - [`Support::On`] and [`Support::Off`]: celld always behaves as the flag
//!   being on, or off. `Cloudflare.compatibilityFlags` reports an On flag,
//!   as `true`, only where workerd computes it on too. The name that selects that state is accepted; the other
//!   is refused. A compatibility date that selects the other state is a
//!   difference that `docs/cloudflare-compat.md` lists.
//! - [`Support::Unmodelled`]: celld behaves as neither state; both names are
//!   refused.
//! - [`Support::Experimental`]: an experimental flag celld does not honour;
//!   its enable name is refused, as Cloudflare refuses it.
//!
//! To move to a new workerd, replace `compat_flags/compatibility-date.capnp`
//! with the file at the new tag and set [`WORKERD_VERSION`]: the tests fail
//! until every new or changed flag here matches it and has a [`Support`], and
//! until the version matches the workerd that `tests/conformance` pins.

use std::fmt;

use Support::{Experimental, Honoured, NoEffect, Off, On, Unmodelled};

/// The workerd release whose flags this table holds: the one wrangler
/// resolves in `tests/conformance`.
pub const WORKERD_VERSION: &str = "1.20261001.1";

/// The newest compatibility date celld models. Every flag enabled by a date up
/// to this one has a [`Support`] that accounts for its date.
pub const NEWEST_DATE: Date = Date::new(2026, 10, 1);

/// A compatibility date, which workerd accepts only as `YYYY-MM-DD`.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct Date {
    year: u16,
    month: u8,
    day: u8,
}

impl Date {
    const fn new(year: u16, month: u8, day: u8) -> Date {
        Date { year, month, day }
    }

    /// Parse a date as workerd does: `YYYY-MM-DD`, with a year from 2000 to
    /// 2999, a month from 1 to 12 and a day from 1 to 31.
    pub fn parse(text: &str) -> Option<Date> {
        let bytes = text.as_bytes();
        let well_formed = bytes.len() == 10
            && bytes.iter().enumerate().all(|(index, byte)| match index {
                4 | 7 => *byte == b'-',
                _ => byte.is_ascii_digit(),
            });
        if !well_formed {
            return None;
        }
        let number = |range: std::ops::Range<usize>| text[range].parse::<u16>().ok();
        let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
        if !(2000..3000).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
            return None;
        }
        Some(Date::new(year, month as u8, day as u8))
    }

    /// `$compatEnableAllDates`: on whatever the date.
    pub const ALL: Date = Date::new(0, 0, 0);

    /// Today's date in UTC.
    pub fn today() -> Date {
        let days = crate::asyncrt::wall_ms().div_euclid(86_400_000);
        let (year, month, day) = crate::telemetry::civil_from_days(days);
        Date::new(year as u16, month as u8, day as u8)
    }
}

impl fmt::Display for Date {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

/// What celld does with a flag. The text says what celld does instead of what
/// the flag selects, or why the flag changes nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Support {
    Honoured,
    NoEffect(&'static str),
    On(&'static str),
    Off(&'static str),
    Unmodelled(&'static str),
    Experimental,
}

/// Workerd's `$impliedByAfterDate`: the flag is on from `date` while any of
/// the flags named in `by` (capnp field names) is on, unless the flag's own
/// disable flag is set.
#[derive(Debug)]
pub struct Implied {
    pub by: &'static [&'static str],
    pub date: Date,
}

/// One field of workerd's `CompatibilityFlags`.
#[derive(Debug)]
pub struct Flag {
    /// The capnp field name.
    pub field: &'static str,
    pub enable: Option<&'static str>,
    pub disable: Option<&'static str>,
    /// `$compatEnableDate`, or [`Date::ALL`] for `$compatEnableAllDates`.
    pub date: Option<Date>,
    pub implied: Option<Implied>,
    pub experimental: bool,
    pub support: Support,
}

/// How a configuration's flag name fares in celld.
#[derive(Debug, PartialEq, Eq)]
pub enum Class {
    Honoured,
    /// Accepted, with the reason it changes nothing celld does.
    NoOp(&'static str),
    /// Refused, with the message `celld deploy` prints.
    Refused(String),
}

impl Flag {
    /// The class of `name`, which is this flag's enable or disable name.
    pub fn class(&self, name: &str) -> Class {
        let enable = self.enable == Some(name);
        debug_assert!(enable || self.disable == Some(name));
        let refused = |why: &str| {
            Class::Refused(format!(
                "The compatibility flag {name} is not supported by celld: {why}."
            ))
        };
        match self.support {
            Support::Honoured => Class::Honoured,
            Support::NoEffect(why) => Class::NoOp(why),
            Support::On(what) if enable => Class::NoOp(what),
            Support::Off(what) if !enable => Class::NoOp(what),
            Support::On(what) => refused(&format!(
                "celld always behaves as {} does: {what}",
                self.enable.expect("an On flag has an enable name")
            )),
            Support::Off(what) | Support::Unmodelled(what) => refused(what),
            Support::Experimental if enable => Class::Refused(format!(
                "The compatibility flag {name} is experimental and cannot be used with celld."
            )),
            Support::Experimental => Class::NoOp(
                "it turns off an experimental flag, which is off unless its enable flag is set",
            ),
        }
    }
}

/// Flags celld adds to workerd's. workerd refuses them as unknown.
pub const CELLD_FLAGS: &[(&str, &str)] = &[(
    "sqlite_vec",
    "exposes the pre-v1 sqlite-vec extension to SQLite-backed Durable Objects",
)];

const COUNT: usize = FLAGS.len();
const WORDS: usize = (COUNT + CELLD_FLAGS.len()).div_ceil(64);

/// One flag, by its index in [`FLAGS`] or, past them, in [`CELLD_FLAGS`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FlagId(usize);

const fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

/// The flag whose enable name is `name`, checked when celld compiles.
pub const fn id(name: &str) -> FlagId {
    let mut i = 0;
    while i < COUNT {
        if let Some(enable) = FLAGS[i].enable {
            if same(enable, name) {
                return FlagId(i);
            }
        }
        i += 1;
    }
    let mut j = 0;
    while j < CELLD_FLAGS.len() {
        if same(CELLD_FLAGS[j].0, name) {
            return FlagId(COUNT + j);
        }
        j += 1;
    }
    panic!("no compatibility flag has this enable name");
}

fn field_index(field: &str) -> usize {
    FLAGS
        .iter()
        .position(|flag| flag.field == field)
        .unwrap_or_else(|| panic!("no compatibility flag field {field}"))
}

pub const ABORTSIGNAL_RPC: FlagId = id("enable_abortsignal_rpc");
pub const ALLOW_EVAL_DURING_STARTUP: FlagId = id("allow_eval_during_startup");
pub const ALLOW_IRREVOCABLE_STUB_STORAGE: FlagId = id("allow_irrevocable_stub_storage");
pub const ASSETS_NAVIGATION_PREFERS_ASSET_SERVING: FlagId =
    id("assets_navigation_prefers_asset_serving");
pub const BIND_ASYNCLOCALSTORAGE_SNAPSHOT_TO_REQUEST: FlagId =
    id("bind_asynclocalstorage_snapshot_to_request");
pub const BLOB_STANDARD_MIME_TYPE: FlagId = id("blob_standard_mime_type");
pub const CACHE_NO_CACHE: FlagId = id("cache_no_cache_enabled");
pub const CACHE_OPTION_ENABLED: FlagId = id("cache_option_enabled");
pub const DELETE_ALL_DELETES_ALARM: FlagId = id("delete_all_deletes_alarm");
pub const DISALLOW_IMPORTABLE_ENV: FlagId = id("disallow_importable_env");
pub const ENABLE_FAST_JSG_STRUCT: FlagId = id("enable_fast_jsg_struct");
pub const ENABLE_GLOBAL_PERFORMANCE_CLASSES: FlagId = id("enable_global_performance_classes");
pub const ENABLE_NODEJS_CHILD_PROCESS_MODULE: FlagId = id("enable_nodejs_child_process_module");
pub const ENABLE_NODEJS_CLUSTER_MODULE: FlagId = id("enable_nodejs_cluster_module");
pub const ENABLE_NODEJS_CONSOLE_MODULE: FlagId = id("enable_nodejs_console_module");
pub const ENABLE_NODEJS_DGRAM_MODULE: FlagId = id("enable_nodejs_dgram_module");
pub const ENABLE_NODEJS_DOMAIN_MODULE: FlagId = id("enable_nodejs_domain_module");
pub const ENABLE_NODEJS_FS_MODULE: FlagId = id("enable_nodejs_fs_module");
pub const ENABLE_NODEJS_GLOBAL_TIMERS: FlagId = id("enable_nodejs_global_timers");
pub const ENABLE_NODEJS_HTTP2_MODULE: FlagId = id("enable_nodejs_http2_module");
pub const ENABLE_NODEJS_HTTP_MODULES: FlagId = id("enable_nodejs_http_modules");
pub const ENABLE_NODEJS_HTTP_SERVER_MODULES: FlagId = id("enable_nodejs_http_server_modules");
pub const ENABLE_NODEJS_INSPECTOR_MODULE: FlagId = id("enable_nodejs_inspector_module");
pub const ENABLE_NODEJS_OS_MODULE: FlagId = id("enable_nodejs_os_module");
pub const ENABLE_NODEJS_PERF_HOOKS_MODULE: FlagId = id("enable_nodejs_perf_hooks_module");
pub const ENABLE_NODEJS_PUNYCODE_MODULE: FlagId = id("enable_nodejs_punycode_module");
pub const ENABLE_NODEJS_READLINE_MODULE: FlagId = id("enable_nodejs_readline_module");
pub const ENABLE_NODEJS_REPL_MODULE: FlagId = id("enable_nodejs_repl_module");
pub const ENABLE_NODEJS_SQLITE_MODULE: FlagId = id("enable_nodejs_sqlite_module");
pub const ENABLE_NODEJS_STREAM_WRAP_MODULE: FlagId = id("enable_nodejs_stream_wrap_module");
pub const ENABLE_NODEJS_TRACE_EVENTS_MODULE: FlagId = id("enable_nodejs_trace_events_module");
pub const ENABLE_NODEJS_TTY_MODULE: FlagId = id("enable_nodejs_tty_module");
pub const ENABLE_NODEJS_V8_MODULE: FlagId = id("enable_nodejs_v8_module");
pub const ENABLE_NODEJS_VM_MODULE: FlagId = id("enable_nodejs_vm_module");
pub const ENABLE_NODEJS_WASI_MODULE: FlagId = id("enable_nodejs_wasi_module");
pub const ENABLE_NODEJS_WORKER_THREADS_MODULE: FlagId = id("enable_nodejs_worker_threads_module");
pub const ENABLE_REQUEST_SIGNAL: FlagId = id("enable_request_signal");
pub const ENCODER_STREAM_SPEC_COMPLIANT_BACKPRESSURE: FlagId =
    id("encoder_stream_spec_compliant_backpressure");
pub const ENHANCED_ERROR_SERIALIZATION: FlagId = id("enhanced_error_serialization");
pub const FETCHER_NO_GET_PUT_DELETE: FlagId = id("fetcher_no_get_put_delete");
pub const FETCH_ITERABLE_TYPE_SUPPORT: FlagId = id("fetch_iterable_type_support");
pub const FETCH_ITERABLE_TYPE_SUPPORT_OVERRIDE_ADJUSTMENT: FlagId =
    id("fetch_iterable_type_support_override_adjustment");
pub const FIXUP_TRANSFORM_STREAM_BACKPRESSURE: FlagId = id("fixup-transform-stream-backpressure");
pub const INTERNAL_WRITABLE_STREAM_ABORT_CLEARS_QUEUE: FlagId =
    id("internal_writable_stream_abort_clears_queue");
pub const JS_RPC: FlagId = id("js_rpc");
pub const NODEJS_ALS: FlagId = id("nodejs_als");
pub const NODEJS_COMPAT: FlagId = id("nodejs_compat");
pub const NODEJS_COMPAT_POPULATE_PROCESS_ENV: FlagId = id("nodejs_compat_populate_process_env");
pub const NODEJS_COMPAT_V2: FlagId = id("nodejs_compat_v2");
pub const QUEUES_JSON_MESSAGES: FlagId = id("queues_json_messages");
pub const QUEUE_EXPOSE_ERROR_CODES: FlagId = id("queue_expose_error_codes");
pub const RPC_PARAMS_DUP_STUBS: FlagId = id("rpc_params_dup_stubs");
pub const SERVICE_BINDING_EXTRA_HANDLERS: FlagId = id("service_binding_extra_handlers");
pub const SET_TOSTRING_TAG: FlagId = id("set_tostring_tag");
pub const SPEC_COMPLIANT_DISPATCH_EXCEPTIONS: FlagId = id("spec_compliant_dispatch_exceptions");
pub const SQLITE_VEC: FlagId = id("sqlite_vec");
pub const STRIP_BOM_IN_READ_ALL_TEXT: FlagId = id("strip_bom_in_read_all_text");
pub const TEXT_DECODER_REPLACE_SURROGATES: FlagId = id("text_decoder_replace_surrogates");
pub const THROW_ON_UNRECOGNIZED_IMPORT_ASSERTION: FlagId =
    id("throw_on_unrecognized_import_assertion");
pub const UNHANDLED_REJECTION_AFTER_MICROTASK_CHECKPOINT: FlagId =
    id("unhandled_rejection_after_microtask_checkpoint");
pub const WEBSOCKET_CLOSE_REASON_BYTE_LIMIT: FlagId = id("websocket_close_reason_byte_limit");
pub const WEB_SOCKET_AUTO_REPLY_TO_CLOSE: FlagId = id("web_socket_auto_reply_to_close");
pub const WEBSOCKET_STANDARD_BINARY_TYPE: FlagId = id("websocket_standard_binary_type");
pub const WORKERS_API_GETTERS_SETTERS_ON_PROTOTYPE: FlagId =
    id("workers_api_getters_setters_on_prototype");
pub const WORKFLOWS_ENABLE_FAST_ENGINE_CREATION: FlagId =
    id("workflows_enable_fast_engine_creation");
pub const WRITABLE_STREAM_SPEC_COMPLIANT_WRITER: FlagId =
    id("writable_stream_spec_compliant_writer");

/// A Worker's computed flags.
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct CompatFlags {
    bits: [u64; WORDS],
}

impl CompatFlags {
    pub fn get(&self, flag: FlagId) -> bool {
        self.bits[flag.0 / 64] & (1 << (flag.0 % 64)) != 0
    }

    fn set(&mut self, index: usize, value: bool) {
        let bit = 1 << (index % 64);
        if value {
            self.bits[index / 64] |= bit;
        } else {
            self.bits[index / 64] &= !bit;
        }
    }

    /// What `Cloudflare.compatibilityFlags` holds, in workerd's order: each
    /// honoured flag's computed value, as workerd reports it, and `true` for
    /// a flag celld always behaves as on where workerd computes it on too, so
    /// the report never contradicts workerd's nor claims a behaviour celld
    /// lacks. celld's own flags follow.
    pub fn reported(&self) -> impl Iterator<Item = (&'static str, bool)> + '_ {
        let workerd = FLAGS.iter().enumerate().filter_map(|(index, flag)| {
            let value = self.get(FlagId(index));
            let reported = match flag.support {
                Support::Honoured => true,
                Support::On(_) => value,
                _ => false,
            };
            if reported {
                Some((flag.enable?, value))
            } else {
                None
            }
        });
        let celld = CELLD_FLAGS
            .iter()
            .enumerate()
            .map(|(index, (name, _))| (*name, self.get(FlagId(COUNT + index))));
        workerd.chain(celld)
    }
}

/// Who compiles a Worker's flags, which decides how experimental flags fare.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Context {
    /// `celld deploy` and `celld dev`: an experimental flag celld honours is
    /// accepted.
    Deploy,
    /// The Worker Loader: every experimental flag is refused, as workerd's
    /// WorkerLoader::extractCompatFlags refuses them even under
    /// `--experimental` unless the code sets `allowExperimental`, which celld
    /// does not support.
    Loader,
}

/// Compute the flags of a Worker whose date and flags `celld deploy` or the
/// Worker Loader accepted, refusing what workerd or celld would refuse. The
/// errors come in workerd's order, each a full message.
pub fn compile(
    date: Option<&str>,
    flags: &[&str],
    context: Context,
) -> Result<CompatFlags, Vec<String>> {
    compile_at(date, flags, context, Date::today())
}

fn compile_at(
    date: Option<&str>,
    flags: &[&str],
    context: Context,
    today: Date,
) -> Result<CompatFlags, Vec<String>> {
    let mut errors = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for flag in flags {
        if !seen.insert(*flag) {
            errors.push(format!(
                "Compatibility flag specified multiple times: {flag}"
            ));
        }
    }
    let parsed = match date {
        None => None,
        Some(text) => match Date::parse(text) {
            Some(parsed) => Some(parsed),
            None => {
                errors.push(format!("Invalid compatibility date: {text}"));
                None
            }
        },
    };
    if let Some(parsed) = parsed {
        if parsed > NEWEST_DATE {
            errors.push(format!(
                "This Worker requires compatibility date \"{parsed}\", but the newest date \
                 supported by this server binary is \"{NEWEST_DATE}\"."
            ));
        }
        if parsed > today {
            errors.push(format!(
                "Can't set compatibility date in the future: \"{parsed}\". Today's date (UTC) \
                 is \"{today}\"."
            ));
        }
    }
    let names = |name: Option<&str>| name.is_some_and(|name| seen.contains(name));
    for flag in FLAGS {
        let (enabled, disabled) = (names(flag.enable), names(flag.disable));
        if let (true, true, Some(enable), Some(disable)) =
            (enabled, disabled, flag.enable, flag.disable)
        {
            errors.push(format!(
                "Compatibility flags are mutually contradictory: {enable} vs {disable}"
            ));
        }
        for (set, name) in [(enabled, flag.enable), (disabled, flag.disable)] {
            if let (true, Some(name)) = (set, name) {
                if flag.experimental && context == Context::Loader && Some(name) == flag.enable {
                    errors.push(format!(
                        "The compatibility flag {name} is experimental and may break or be \
                         removed in a future version of workerd. To use this flag, you must \
                         pass --experimental on the command line."
                    ));
                } else if let Class::Refused(message) = flag.class(name) {
                    errors.push(message);
                }
            }
        }
    }
    let mut unknown = std::collections::HashSet::new();
    for flag in flags {
        let known = FLAGS
            .iter()
            .any(|known| known.enable == Some(flag) || known.disable == Some(flag))
            || CELLD_FLAGS.iter().any(|(name, _)| name == flag);
        if !known && unknown.insert(*flag) {
            errors.push(format!("No such compatibility flag: {flag}"));
        }
    }
    if errors.is_empty() {
        Ok(compute(parsed, &seen))
    } else {
        Err(errors)
    }
}

/// Compute the flags of a Worker that a node loads, which `celld deploy`
/// checked when it was deployed: an unknown name or a bad date has no effect
/// here.
pub fn compile_lenient(date: Option<&str>, flags: &[&str]) -> CompatFlags {
    compute(date.and_then(Date::parse), &flags.iter().copied().collect())
}

/// workerd's computation: each flag from its date and names, then each
/// `$impliedByAfterDate` in field order, which lets one implied flag imply
/// another declared after it.
fn compute(date: Option<Date>, set: &std::collections::HashSet<&str>) -> CompatFlags {
    let has = |name: Option<&str>| name.is_some_and(|name| set.contains(name));
    let since = |day: Date| day == Date::ALL || date.is_some_and(|date| date >= day);
    let mut out = CompatFlags::default();
    let mut implied = Vec::new();
    for (index, flag) in FLAGS.iter().enumerate() {
        let (enabled, disabled) = (has(flag.enable), has(flag.disable));
        let by_date = flag.date.is_some_and(since);
        out.set(index, enabled || (by_date && !disabled));
        if let Some(rule) = &flag.implied {
            if since(rule.date) && !disabled {
                implied.extend(rule.by.iter().map(|by| (index, field_index(by))));
            }
        }
    }
    for (index, by) in implied {
        if out.get(FlagId(by)) {
            out.set(index, true);
        }
    }
    for (offset, (name, _)) in CELLD_FLAGS.iter().enumerate() {
        out.set(COUNT + offset, set.contains(name));
    }
    out
}

/// The flags at [`WORKERD_VERSION`], in capnp field order.
pub const FLAGS: &[Flag] = &[
    Flag {
        field: "formDataParserSupportsFiles",
        enable: Some("formdata_parser_supports_files"),
        disable: Some("formdata_parser_converts_files_to_strings"),
        date: Some(Date::new(2021, 11, 3)),
        implied: None,
        experimental: false,
        support: On("formData() returns a file field as a File"),
    },
    Flag {
        field: "fetchRefusesUnknownProtocols",
        enable: Some("fetch_refuses_unknown_protocols"),
        disable: Some("fetch_treats_unknown_protocols_as_http"),
        date: Some(Date::new(2021, 11, 10)),
        implied: None,
        experimental: false,
        support: On("fetch() rejects a URL whose scheme is not http or https"),
    },
    Flag {
        field: "esiIncludeIsVoidTag",
        enable: Some("html_rewriter_treats_esi_include_as_void_tag"),
        disable: None,
        date: None,
        implied: None,
        experimental: false,
        support: Off("HTMLRewriter parses <esi:include> as an element with an end tag"),
    },
    Flag {
        field: "obsolete3",
        enable: None,
        disable: None,
        date: None,
        implied: None,
        experimental: false,
        support: NoEffect("it has no flag names"),
    },
    Flag {
        field: "durableObjectFetchRequiresSchemeAuthority",
        enable: Some("durable_object_fetch_requires_full_url"),
        disable: Some("durable_object_fetch_allows_relative_url"),
        date: Some(Date::new(2021, 11, 10)),
        implied: None,
        experimental: false,
        support: On("a Durable Object stub's fetch() needs an absolute URL"),
    },
    Flag {
        field: "streamsByobReaderDetachesBuffer",
        enable: Some("streams_byob_reader_detaches_buffer"),
        disable: Some("streams_byob_reader_does_not_detach_buffer"),
        date: Some(Date::new(2021, 11, 10)),
        implied: None,
        experimental: false,
        support: On("a BYOB read detaches the buffer it is given"),
    },
    Flag {
        field: "streamsJavaScriptControllers",
        enable: Some("streams_enable_constructors"),
        disable: Some("streams_disable_constructors"),
        date: Some(Date::new(2022, 11, 30)),
        implied: None,
        experimental: false,
        support: On("the ReadableStream and WritableStream constructors take JavaScript sources and sinks"),
    },
    Flag {
        field: "jsgPropertyOnPrototypeTemplate",
        enable: Some("workers_api_getters_setters_on_prototype"),
        disable: Some("workers_api_getters_setters_on_instance"),
        date: Some(Date::new(2022, 1, 31)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "minimalSubrequests",
        enable: Some("minimal_subrequests"),
        disable: Some("no_minimal_subrequests"),
        date: Some(Date::new(2022, 4, 5)),
        implied: None,
        experimental: false,
        support: NoEffect("it changes only how Cloudflare's CDN treats subrequests"),
    },
    Flag {
        field: "noCotsOnExternalFetch",
        enable: Some("no_cots_on_external_fetch"),
        disable: Some("cots_on_external_fetch"),
        date: Some(Date::new(2022, 3, 8)),
        implied: None,
        experimental: false,
        support: NoEffect("it selects only Cloudflare's origin trust store"),
    },
    Flag {
        field: "specCompliantUrl",
        enable: Some("url_standard"),
        disable: Some("url_original"),
        date: Some(Date::new(2022, 10, 31)),
        implied: None,
        experimental: false,
        support: On("URL follows the WHATWG URL Standard"),
    },
    Flag {
        field: "globalNavigator",
        enable: Some("global_navigator"),
        disable: Some("no_global_navigator"),
        date: Some(Date::new(2022, 3, 21)),
        implied: None,
        experimental: false,
        support: On("navigator is defined"),
    },
    Flag {
        field: "captureThrowsAsRejections",
        enable: Some("capture_async_api_throws"),
        disable: Some("do_not_capture_async_api_throws"),
        date: Some(Date::new(2022, 10, 31)),
        implied: None,
        experimental: false,
        support: On("a promise-returning API rejects instead of throwing"),
    },
    Flag {
        field: "r2PublicBetaApi",
        enable: Some("r2_public_beta_bindings"),
        disable: Some("r2_internal_beta_bindings"),
        date: Some(Date::ALL),
        implied: None,
        experimental: false,
        support: On("R2 bindings have the public R2 API"),
    },
    Flag {
        field: "obsolete14",
        enable: Some("durable_object_alarms"),
        disable: None,
        date: None,
        implied: None,
        experimental: false,
        support: NoEffect("it is obsolete; alarms are always available"),
    },
    Flag {
        field: "noSubstituteNull",
        enable: Some("dont_substitute_null_on_type_error"),
        disable: Some("substitute_null_on_type_error"),
        date: Some(Date::new(2022, 6, 1)),
        implied: None,
        experimental: false,
        support: On("an API never substitutes null for an argument of the wrong type"),
    },
    Flag {
        field: "transformStreamJavaScriptControllers",
        enable: Some("transformstream_enable_standard_constructor"),
        disable: Some("transformstream_disable_standard_constructor"),
        date: Some(Date::new(2022, 11, 30)),
        implied: None,
        experimental: false,
        support: On("the TransformStream constructor follows the Streams Standard"),
    },
    Flag {
        field: "r2ListHonorIncludeFields",
        enable: Some("r2_list_honor_include"),
        disable: None,
        date: Some(Date::new(2022, 8, 4)),
        implied: None,
        experimental: false,
        support: On("R2 list() returns only the metadata `include` names"),
    },
    Flag {
        field: "exportCommonJsDefaultNamespace",
        enable: Some("export_commonjs_default"),
        disable: Some("export_commonjs_namespace"),
        date: Some(Date::new(2022, 10, 31)),
        implied: None,
        experimental: false,
        support: NoEffect("celld has no CommonJS module type; esbuild resolves require() when it bundles"),
    },
    Flag {
        field: "obsolete19",
        enable: Some("durable_object_rename"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "webSocketCompression",
        enable: Some("web_socket_compression"),
        disable: Some("no_web_socket_compression"),
        date: Some(Date::new(2023, 8, 15)),
        implied: None,
        experimental: false,
        support: Off("celld never negotiates permessage-deflate on a WebSocket"),
    },
    Flag {
        field: "nodeJsCompat",
        enable: Some("nodejs_compat"),
        disable: Some("no_nodejs_compat"),
        date: Some(Date::new(2026, 8, 4)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "obsolete22",
        enable: Some("tcp_sockets_support"),
        disable: None,
        date: None,
        implied: None,
        experimental: false,
        support: NoEffect("it is obsolete; TCP sockets are always available"),
    },
    Flag {
        field: "specCompliantResponseRedirect",
        enable: Some("response_redirect_url_standard"),
        disable: Some("response_redirect_url_original"),
        date: Some(Date::new(2023, 3, 14)),
        implied: None,
        experimental: false,
        support: On("Response.redirect() serializes its URL with the WHATWG URL Standard"),
    },
    Flag {
        field: "workerdExperimental",
        enable: Some("experimental"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "durableObjectGetExisting",
        enable: Some("durable_object_get_existing"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "httpHeadersGetSetCookie",
        enable: Some("http_headers_getsetcookie"),
        disable: Some("no_http_headers_getsetcookie"),
        date: Some(Date::new(2023, 3, 1)),
        implied: None,
        experimental: false,
        support: On("Headers has getSetCookie() and iterates each Set-Cookie separately"),
    },
    Flag {
        field: "dispatchExceptionTunneling",
        enable: Some("dynamic_dispatch_tunnel_exceptions"),
        disable: Some("dynamic_dispatch_treat_exceptions_as_500"),
        date: Some(Date::new(2023, 3, 1)),
        implied: None,
        experimental: false,
        support: NoEffect("it applies to dispatch namespace bindings, which celld does not support"),
    },
    // Honoured in part, because what is missing fails loudly: `queue()`
    // always throws, and `scheduled()` throws except on a binding to the
    // Worker's own default export.
    Flag {
        field: "serviceBindingExtraHandlers",
        enable: Some("service_binding_extra_handlers"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Honoured,
    },
    Flag {
        field: "noCfBotManagementDefault",
        enable: Some("no_cf_botmanagement_default"),
        disable: Some("cf_botmanagement_default"),
        date: Some(Date::new(2023, 8, 1)),
        implied: None,
        experimental: false,
        support: On("request.cf never has default botManagement data"),
    },
    Flag {
        field: "urlSearchParamsDeleteHasValueArg",
        enable: Some("urlsearchparams_delete_has_value_arg"),
        disable: Some("no_urlsearchparams_delete_has_value_arg"),
        date: Some(Date::new(2023, 7, 1)),
        implied: None,
        experimental: false,
        support: On("URLSearchParams delete() and has() take a value argument"),
    },
    Flag {
        field: "strictCompression",
        enable: Some("strict_compression_checks"),
        disable: Some("no_strict_compression_checks"),
        date: Some(Date::new(2023, 8, 1)),
        implied: None,
        experimental: false,
        support: On("DecompressionStream errors on trailing or truncated data"),
    },
    Flag {
        field: "brotliContentEncoding",
        enable: Some("brotli_content_encoding"),
        disable: Some("no_brotli_content_encoding"),
        date: Some(Date::new(2024, 4, 29)),
        implied: None,
        experimental: false,
        support: Off("celld neither compresses nor decodes a br body: it passes as it is"),
    },
    Flag {
        field: "strictCrypto",
        enable: Some("strict_crypto_checks"),
        disable: Some("no_strict_crypto_checks"),
        date: Some(Date::new(2023, 8, 1)),
        implied: None,
        experimental: false,
        support: On("Web Crypto validates RSA sizes and exponents and public key usages"),
    },
    Flag {
        field: "rttiApi",
        enable: Some("rtti_api"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "obsolete35",
        enable: Some("webgpu"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "cryptoPreservePublicExponent",
        enable: Some("crypto_preserve_public_exponent"),
        disable: Some("no_crypto_preserve_public_exponent"),
        date: Some(Date::new(2023, 12, 1)),
        implied: None,
        experimental: false,
        support: On("an RSA key's publicExponent is a Uint8Array"),
    },
    Flag {
        field: "vectorizeQueryMetadataOptional",
        enable: Some("vectorize_query_metadata_optional"),
        disable: Some("vectorize_query_original"),
        date: Some(Date::new(2023, 11, 8)),
        implied: None,
        experimental: false,
        support: NoEffect("it applies to Vectorize bindings, which celld does not support"),
    },
    Flag {
        field: "unsafeModule",
        enable: Some("unsafe_module"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "jsRpc",
        enable: Some("js_rpc"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Honoured,
    },
    Flag {
        field: "noImportScripts",
        enable: Some("no_global_importscripts"),
        disable: Some("global_importscripts"),
        date: Some(Date::new(2024, 3, 4)),
        implied: None,
        experimental: false,
        support: On("importScripts is undefined"),
    },
    Flag {
        field: "nodeJsAls",
        enable: Some("nodejs_als"),
        disable: Some("no_nodejs_als"),
        date: None,
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "queuesJsonMessages",
        enable: Some("queues_json_messages"),
        disable: Some("no_queues_json_messages"),
        date: Some(Date::new(2024, 3, 18)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "pythonWorkers",
        enable: Some("python_workers"),
        disable: None,
        date: None,
        implied: Some(Implied { by: &["pythonWorkersDevPyodide"], date: Date::new(2000, 1, 1) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "fetcherNoGetPutDelete",
        enable: Some("fetcher_no_get_put_delete"),
        disable: Some("fetcher_has_get_put_delete"),
        date: Some(Date::new(2024, 3, 26)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "unwrapCustomThenables",
        enable: Some("unwrap_custom_thenables"),
        disable: Some("no_unwrap_custom_thenables"),
        date: Some(Date::new(2024, 4, 1)),
        implied: None,
        experimental: false,
        support: On("an API that takes a promise also accepts a thenable"),
    },
    Flag {
        field: "fetcherRpc",
        enable: Some("rpc"),
        disable: Some("no_rpc"),
        date: Some(Date::new(2024, 4, 3)),
        implied: None,
        experimental: false,
        support: On("service bindings and Durable Object stubs support RPC"),
    },
    Flag {
        field: "internalStreamByobReturn",
        enable: Some("internal_stream_byob_return_view"),
        disable: Some("internal_stream_byob_return_undefined"),
        date: Some(Date::new(2024, 5, 13)),
        implied: None,
        experimental: false,
        support: On("a BYOB read that ends a platform stream returns an empty view"),
    },
    Flag {
        field: "blobStandardMimeType",
        enable: Some("blob_standard_mime_type"),
        disable: Some("blob_legacy_mime_type"),
        date: Some(Date::new(2024, 6, 3)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "fetchStandardUrl",
        enable: Some("fetch_standard_url"),
        disable: Some("fetch_legacy_url"),
        date: Some(Date::new(2024, 6, 3)),
        implied: None,
        experimental: false,
        support: On("fetch() parses its URL with the WHATWG URL Standard"),
    },
    Flag {
        field: "nodeJsCompatV2",
        enable: Some("nodejs_compat_v2"),
        disable: Some("no_nodejs_compat_v2"),
        date: Some(Date::new(2026, 8, 4)),
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2024, 9, 23) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "globalFetchStrictlyPublic",
        enable: Some("global_fetch_strictly_public"),
        disable: Some("global_fetch_private_origin"),
        date: None,
        implied: None,
        experimental: false,
        support: NoEffect("it chooses how Cloudflare routes a fetch() to the Worker's own zone, and celld has no zone; the egress policy applies whatever the flag says"),
    },
    Flag {
        field: "newModuleRegistry",
        enable: Some("new_module_registry"),
        disable: Some("legacy_module_registry"),
        date: None,
        implied: None,
        experimental: false,
        support: Off("celld does not implement workerd's new module registry"),
    },
    Flag {
        field: "cacheOptionEnabled",
        enable: Some("cache_option_enabled"),
        disable: Some("cache_option_disabled"),
        date: Some(Date::new(2024, 11, 11)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "kvDirectBinding",
        enable: Some("kv_direct_binding"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "allowCustomPorts",
        enable: Some("allow_custom_ports"),
        disable: Some("ignore_custom_ports"),
        date: Some(Date::new(2024, 9, 2)),
        implied: None,
        experimental: false,
        support: On("fetch() uses the URL's port"),
    },
    Flag {
        field: "increaseWebsocketMessageSize",
        enable: Some("increase_websocket_message_size"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "internalWritableStreamAbortClearsQueue",
        enable: Some("internal_writable_stream_abort_clears_queue"),
        disable: Some("internal_writable_stream_abort_does_not_clear_queue"),
        date: Some(Date::new(2024, 9, 2)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "pythonWorkersDevPyodide",
        enable: Some("python_workers_development"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "nodeJsZlib",
        enable: Some("nodejs_zlib"),
        disable: Some("no_nodejs_zlib"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat", "nodeJsCompatV2"], date: Date::new(2024, 9, 23) }),
        experimental: false,
        support: NoEffect("celld's Node.js modules and globals do not depend on this flag (see Node.js compatibility)"),
    },
    Flag {
        field: "replicaRouting",
        enable: Some("replica_routing"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "obsolete61",
        enable: Some("enable_d1_with_sessions_api"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "handleCrossRequestPromiseResolution",
        enable: Some("handle_cross_request_promise_resolution"),
        disable: Some("no_handle_cross_request_promise_resolution"),
        date: Some(Date::new(2024, 10, 14)),
        implied: None,
        experimental: false,
        support: Off("a promise's continuations run in the request that resolves it, as V8 runs them"),
    },
    Flag {
        field: "obsolete63",
        enable: None,
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "setToStringTag",
        enable: Some("set_tostring_tag"),
        disable: Some("do_not_set_tostring_tag"),
        date: Some(Date::new(2024, 9, 26)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "upperCaseAllHttpMethods",
        enable: Some("upper_case_all_http_methods"),
        disable: Some("no_upper_case_all_http_methods"),
        date: Some(Date::new(2024, 10, 14)),
        implied: None,
        experimental: false,
        support: On("a Request upper-cases a known method name"),
    },
    Flag {
        field: "obsolete66",
        enable: Some("python_external_packages"),
        disable: None,
        date: None,
        implied: None,
        experimental: false,
        support: NoEffect("it is obsolete"),
    },
    Flag {
        field: "noTopLevelAwaitInRequire",
        enable: Some("disable_top_level_await_in_require"),
        disable: Some("enable_top_level_await_in_require"),
        date: Some(Date::new(2024, 12, 2)),
        implied: None,
        experimental: false,
        support: NoEffect("celld has no run-time require() of a module; esbuild resolves it when it bundles"),
    },
    Flag {
        field: "fixupTransformStreamBackpressure",
        enable: Some("fixup-transform-stream-backpressure"),
        disable: Some("original-transform-stream-backpressure"),
        date: Some(Date::new(2024, 12, 16)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "obsolete69",
        enable: Some("tail_worker_user_spans"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "cacheNoCache",
        enable: Some("cache_no_cache_enabled"),
        disable: Some("cache_no_cache_disabled"),
        date: None,
        implied: Some(Implied { by: &["cacheOptionEnabled"], date: Date::new(2025, 8, 7) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "pythonWorkers20250116",
        enable: Some("python_workers_20250116"),
        disable: Some("no_python_workers_20250116"),
        date: None,
        implied: Some(Implied { by: &["pythonWorkers"], date: Date::new(2025, 9, 29) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "requestCfOverridesCacheRules",
        enable: Some("request_cf_overrides_cache_rules"),
        disable: Some("no_request_cf_overrides_cache_rules"),
        date: Some(Date::new(2025, 4, 2)),
        implied: None,
        experimental: false,
        support: NoEffect("it changes only Cloudflare's cache rules, and celld has no edge cache"),
    },
    Flag {
        field: "memoryCacheDelete",
        enable: Some("memory_cache_delete"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "obsolete74",
        enable: Some("unique_ctx_per_invocation"),
        disable: None,
        date: Some(Date::new(2025, 3, 10)),
        implied: None,
        experimental: false,
        support: NoEffect("it is obsolete; each invocation gets its own ctx"),
    },
    Flag {
        field: "reuseCtxAcrossNonclassEvents",
        enable: Some("nonclass_entrypoint_reuses_ctx_across_invocations"),
        disable: None,
        date: None,
        implied: None,
        experimental: false,
        support: Off("each event gets its own ctx"),
    },
    Flag {
        field: "queueConsumerNoWaitForWaitUntil",
        enable: Some("queue_consumer_no_wait_for_wait_until"),
        disable: Some("queue_consumer_wait_for_wait_until"),
        date: None,
        implied: None,
        experimental: false,
        support: Unmodelled("celld does not model when a queue consumer reports its outcome relative to waitUntil()"),
    },
    Flag {
        field: "populateProcessEnv",
        enable: Some("nodejs_compat_populate_process_env"),
        disable: Some("nodejs_compat_do_not_populate_process_env"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2025, 4, 1) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "cacheApiRequestCfOverridesCacheRules",
        enable: Some("cache_api_request_cf_overrides_cache_rules"),
        disable: Some("no_cache_api_request_cf_overrides_cache_rules"),
        date: Some(Date::new(2025, 5, 19)),
        implied: None,
        experimental: false,
        support: NoEffect("celld's Cache API stores nothing"),
    },
    Flag {
        field: "disableImportableEnv",
        enable: Some("disallow_importable_env"),
        disable: Some("allow_importable_env"),
        date: None,
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "assetsSecFetchModeNavigateHeaderPrefersAssetServing",
        enable: Some("assets_navigation_prefers_asset_serving"),
        disable: Some("assets_navigation_has_no_effect"),
        date: Some(Date::new(2025, 4, 1)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "cacheApiCompatFlags",
        enable: Some("cache_api_compat_flags"),
        disable: Some("no_cache_api_compat_flags"),
        date: Some(Date::new(2025, 4, 19)),
        implied: None,
        experimental: false,
        support: NoEffect("it passes flags only to Cloudflare's cache, and celld's Cache API stores nothing"),
    },
    Flag {
        field: "obsolete81",
        enable: Some("python_workers_durable_objects"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "obsolete82",
        enable: Some("streaming_tail_worker"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "specCompliantUrlpattern",
        enable: Some("urlpattern_standard"),
        disable: Some("urlpattern_original"),
        date: Some(Date::new(2025, 5, 1)),
        implied: None,
        experimental: false,
        support: On("URLPattern follows the WHATWG URLPattern Standard"),
    },
    Flag {
        field: "jsWeakRef",
        enable: Some("enable_weak_ref"),
        disable: Some("disable_weak_ref"),
        date: Some(Date::new(2025, 5, 5)),
        implied: None,
        experimental: false,
        support: On("WeakRef and FinalizationRegistry are defined"),
    },
    Flag {
        field: "requestSignalPassthrough",
        enable: Some("request_signal_passthrough"),
        disable: Some("no_request_signal_passthrough"),
        date: None,
        implied: None,
        experimental: false,
        support: Off("an incoming request's signal never reaches a subrequest"),
    },
    Flag {
        field: "enableNavigatorLanguage",
        enable: Some("enable_navigator_language"),
        disable: Some("disable_navigator_language"),
        date: Some(Date::new(2025, 5, 19)),
        implied: None,
        experimental: false,
        support: On("navigator.language is defined"),
    },
    Flag {
        field: "webFileSystem",
        enable: Some("enable_web_file_system"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "abortSignalRpc",
        enable: Some("enable_abortsignal_rpc"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Honoured,
    },
    Flag {
        field: "allowEvalDuringStartup",
        enable: Some("allow_eval_during_startup"),
        disable: Some("disallow_eval_during_startup"),
        date: Some(Date::new(2025, 6, 1)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableRequestSignal",
        enable: Some("enable_request_signal"),
        disable: Some("disable_request_signal"),
        date: None,
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "connectPassThrough",
        enable: Some("connect_pass_through"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "bindAsyncLocalStorageSnapshot",
        enable: Some("bind_asynclocalstorage_snapshot_to_request"),
        disable: Some("do_not_bind_asynclocalstorage_snapshot_to-request"),
        date: Some(Date::new(2025, 6, 16)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "throwOnUnrecognizedImportAssertion",
        enable: Some("throw_on_unrecognized_import_assertion"),
        disable: Some("ignore_unrecognized_import_assertion"),
        date: Some(Date::new(2025, 6, 16)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "pythonWorkflows",
        enable: Some("python_workflows"),
        disable: Some("disable_python_workflows"),
        date: None,
        implied: Some(Implied { by: &["pythonWorkers"], date: Date::new(2025, 9, 20) }),
        experimental: false,
        support: NoEffect("celld does not run Workflows in Python Workers"),
    },
    Flag {
        field: "unsupportedProcessActualPlatform",
        enable: Some("unsupported_process_actual_platform"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "enableNodeJsProcessV2",
        enable: Some("enable_nodejs_process_v2"),
        disable: Some("disable_nodejs_process_v2"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2025, 9, 15) }),
        experimental: false,
        support: NoEffect("celld's Node.js modules and globals do not depend on this flag (see Node.js compatibility)"),
    },
    Flag {
        field: "setEventTargetThis",
        enable: Some("set_event_target_this"),
        disable: Some("no_set_event_target_this"),
        date: Some(Date::new(2025, 8, 1)),
        implied: None,
        experimental: false,
        support: On("an event listener runs with the EventTarget as `this`"),
    },
    Flag {
        field: "enableForwardableEmailFullHeaders",
        enable: Some("set_forwardable_email_full_headers"),
        disable: Some("set_forwardable_email_single_headers"),
        date: Some(Date::new(2025, 8, 1)),
        implied: None,
        experimental: false,
        support: NoEffect("it applies to Email Workers, which celld does not run"),
    },
    Flag {
        field: "enableNodejsHttpModules",
        enable: Some("enable_nodejs_http_modules"),
        disable: Some("disable_nodejs_http_modules"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2025, 8, 15) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "pedanticWpt",
        enable: Some("pedantic_wpt"),
        disable: Some("non_pedantic_wpt"),
        date: None,
        implied: None,
        experimental: false,
        support: Off("celld does not implement workerd's pedantic WPT mode"),
    },
    Flag {
        field: "exposeGlobalMessageChannel",
        enable: Some("expose_global_message_channel"),
        disable: Some("no_expose_global_message_channel"),
        date: Some(Date::new(2025, 8, 15)),
        implied: None,
        experimental: false,
        support: On("MessageChannel and MessagePort are globals"),
    },
    Flag {
        field: "enableNodejsHttpServerModules",
        enable: Some("enable_nodejs_http_server_modules"),
        disable: Some("disable_nodejs_http_server_modules"),
        date: None,
        implied: Some(Implied { by: &["enableNodejsHttpModules"], date: Date::new(2025, 9, 1) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "pythonNoGlobalHandlers",
        enable: Some("python_no_global_handlers"),
        disable: Some("disable_python_no_global_handlers"),
        date: Some(Date::new(2025, 8, 14)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsFsModule",
        enable: Some("enable_nodejs_fs_module"),
        disable: Some("disable_nodejs_fs_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2025, 9, 15) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsOsModule",
        enable: Some("enable_nodejs_os_module"),
        disable: Some("disable_nodejs_os_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2025, 9, 15) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "pythonWorkersForceNewVendorPath",
        enable: Some("python_workers_force_new_vendor_path"),
        disable: None,
        date: Some(Date::new(2025, 8, 11)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "removeNodejsCompatEOL",
        enable: Some("remove_nodejs_compat_eol"),
        disable: Some("add_nodejs_compat_eol"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2025, 9, 1) }),
        experimental: false,
        support: NoEffect("celld's Node.js modules and globals do not depend on this flag (see Node.js compatibility)"),
    },
    Flag {
        field: "enableWorkflowScriptValidation",
        enable: Some("enable_validate_workflow_entrypoint"),
        disable: Some("disable_validate_workflow_entrypoint"),
        date: Some(Date::new(2025, 9, 20)),
        implied: None,
        experimental: false,
        support: NoEffect("it adds checks to Cloudflare's upload; `celld deploy` applies its own Workflows checks whatever the flag says"),
    },
    Flag {
        field: "pythonDedicatedSnapshot",
        enable: Some("python_dedicated_snapshot"),
        disable: Some("disable_python_dedicated_snapshot"),
        date: None,
        implied: Some(Implied { by: &["pythonWorkers20250116"], date: Date::new(2025, 10, 16) }),
        experimental: false,
        support: NoEffect("celld takes no Python memory snapshots"),
    },
    Flag {
        field: "typescriptStripTypes",
        enable: Some("typescript_strip_types"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "enableNodeJsHttp2Module",
        enable: Some("enable_nodejs_http2_module"),
        disable: Some("disable_nodejs_http2_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2025, 9, 1) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "experimentalAllowEvalAlways",
        enable: Some("allow_insecure_inefficient_logged_eval"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "stripAuthorizationOnCrossOriginRedirect",
        enable: Some("strip_authorization_on_cross_origin_redirect"),
        disable: Some("retain_authorization_on_cross_origin_redirect"),
        date: Some(Date::new(2025, 9, 1)),
        implied: None,
        experimental: false,
        support: On("fetch() drops Authorization when it follows a redirect to another origin"),
    },
    Flag {
        field: "enhancedErrorSerialization",
        enable: Some("enhanced_error_serialization"),
        disable: Some("legacy_error_serialization"),
        date: Some(Date::new(2026, 4, 21)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "emailSendingQueuing",
        enable: Some("enable_email_sending_queuing"),
        disable: Some("disable_email_sending_queuing"),
        date: None,
        implied: None,
        experimental: false,
        support: NoEffect("it applies to send_email bindings, which celld does not support"),
    },
    Flag {
        field: "removeNodejsCompatEOLv22",
        enable: Some("remove_nodejs_compat_eol_v22"),
        disable: Some("add_nodejs_compat_eol_v22"),
        date: None,
        implied: Some(Implied { by: &["removeNodejsCompatEOL"], date: Date::new(2027, 4, 30) }),
        experimental: false,
        support: NoEffect("celld's Node.js modules and globals do not depend on this flag (see Node.js compatibility)"),
    },
    Flag {
        field: "removeNodejsCompatEOLv23",
        enable: Some("remove_nodejs_compat_eol_v23"),
        disable: Some("add_nodejs_compat_eol_v23"),
        date: None,
        implied: Some(Implied { by: &["removeNodejsCompatEOLv24"], date: Date::new(2025, 9, 1) }),
        experimental: false,
        support: NoEffect("celld's Node.js modules and globals do not depend on this flag (see Node.js compatibility)"),
    },
    Flag {
        field: "removeNodejsCompatEOLv24",
        enable: Some("remove_nodejs_compat_eol_v24"),
        disable: Some("add_nodejs_compat_eol_v24"),
        date: None,
        implied: Some(Implied { by: &["removeNodejsCompatEOL"], date: Date::new(2028, 4, 30) }),
        experimental: false,
        support: NoEffect("celld's Node.js modules and globals do not depend on this flag (see Node.js compatibility)"),
    },
    Flag {
        field: "enableNodeJsConsoleModule",
        enable: Some("enable_nodejs_console_module"),
        disable: Some("disable_nodejs_console_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2025, 9, 21) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsVmModule",
        enable: Some("enable_nodejs_vm_module"),
        disable: Some("disable_nodejs_vm_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2025, 10, 1) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsPerfHooksModule",
        enable: Some("enable_nodejs_perf_hooks_module"),
        disable: Some("disable_nodejs_perf_hooks_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2026, 3, 17) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableGlobalPerformanceClasses",
        enable: Some("enable_global_performance_classes"),
        disable: Some("disable_global_performance_classes"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2026, 3, 17) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsDomainModule",
        enable: Some("enable_nodejs_domain_module"),
        disable: Some("disable_nodejs_domain_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2025, 12, 4) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsV8Module",
        enable: Some("enable_nodejs_v8_module"),
        disable: Some("disable_nodejs_v8_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2026, 3, 17) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsTtyModule",
        enable: Some("enable_nodejs_tty_module"),
        disable: Some("disable_nodejs_tty_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2026, 3, 17) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsPunycodeModule",
        enable: Some("enable_nodejs_punycode_module"),
        disable: Some("disable_nodejs_punycode_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2025, 12, 4) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsClusterModule",
        enable: Some("enable_nodejs_cluster_module"),
        disable: Some("disable_nodejs_cluster_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2025, 12, 4) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsChildProcessModule",
        enable: Some("enable_nodejs_child_process_module"),
        disable: Some("disable_nodejs_child_process_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2026, 3, 17) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsWorkerThreadsModule",
        enable: Some("enable_nodejs_worker_threads_module"),
        disable: Some("disable_nodejs_worker_threads_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2026, 3, 17) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsStreamWrapModule",
        enable: Some("enable_nodejs_stream_wrap_module"),
        disable: Some("disable_nodejs_stream_wrap_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2026, 1, 29) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsWasiModule",
        enable: Some("enable_nodejs_wasi_module"),
        disable: Some("disable_nodejs_wasi_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2025, 12, 4) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsDgramModule",
        enable: Some("enable_nodejs_dgram_module"),
        disable: Some("disable_nodejs_dgram_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2026, 1, 29) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsInspectorModule",
        enable: Some("enable_nodejs_inspector_module"),
        disable: Some("disable_nodejs_inspector_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2026, 1, 29) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsTraceEventsModule",
        enable: Some("enable_nodejs_trace_events_module"),
        disable: Some("disable_nodejs_trace_events_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2025, 12, 4) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsReadlineModule",
        enable: Some("enable_nodejs_readline_module"),
        disable: Some("disable_nodejs_readline_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2026, 3, 17) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsReplModule",
        enable: Some("enable_nodejs_repl_module"),
        disable: Some("disable_nodejs_repl_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2026, 3, 17) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsSqliteModule",
        enable: Some("enable_nodejs_sqlite_module"),
        disable: Some("disable_nodejs_sqlite_module"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2026, 1, 29) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableCtxExports",
        enable: Some("enable_ctx_exports"),
        disable: Some("disable_ctx_exports"),
        date: Some(Date::new(2025, 11, 17)),
        implied: None,
        experimental: false,
        support: On("ctx.exports is defined"),
    },
    Flag {
        field: "pythonExternalSDK",
        enable: Some("enable_python_external_sdk"),
        disable: Some("disable_python_external_sdk"),
        date: Some(Date::new(2026, 4, 21)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "fastJsgStruct",
        enable: Some("enable_fast_jsg_struct"),
        disable: Some("disable_fast_jsg_struct"),
        date: Some(Date::new(2025, 12, 3)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "cacheReload",
        enable: Some("cache_reload_enabled"),
        disable: Some("cache_reload_disabled"),
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "streamsNodejsV24Compat",
        enable: Some("enable_streams_nodejs_v24_compat"),
        disable: Some("disable_streams_nodejs_v24_compat"),
        date: None,
        implied: None,
        experimental: false,
        support: Unmodelled("celld does not model the Node.js 24 stream changes"),
    },
    Flag {
        field: "pythonCheckRngState",
        enable: Some("python_check_rng_state"),
        disable: Some("disable_python_check_rng_state"),
        date: None,
        implied: Some(Implied { by: &["pythonWorkers"], date: Date::new(2025, 12, 16) }),
        experimental: false,
        support: NoEffect("celld takes no Python memory snapshots"),
    },
    Flag {
        field: "shouldSetImmutablePrototype",
        enable: Some("immutable_api_prototypes"),
        disable: Some("mutable_api_prototypes"),
        date: None,
        implied: None,
        experimental: false,
        support: Off("API prototypes are mutable"),
    },
    Flag {
        field: "fetchIterableTypeSupport",
        enable: Some("fetch_iterable_type_support"),
        disable: Some("no_fetch_iterable_type_support"),
        date: Some(Date::new(2026, 2, 19)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "envModuleNullableSupport",
        enable: Some("env_module_nullable_support"),
        disable: Some("no_env_module_nullable_support"),
        date: None,
        implied: None,
        experimental: false,
        support: NoEffect("it changes only withEnv() and withExports(), which celld does not implement"),
    },
    Flag {
        field: "preciseTimers",
        enable: Some("precise_timers"),
        disable: Some("no_precise_timers"),
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "fetchIterableTypeSupportOverrideAdjustment",
        enable: Some("fetch_iterable_type_support_override_adjustment"),
        disable: Some("no_fetch_iterable_type_support_override_adjustment"),
        date: None,
        implied: Some(Implied { by: &["fetchIterableTypeSupport"], date: Date::new(2026, 1, 15) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "stripBomInReadAllText",
        enable: Some("strip_bom_in_read_all_text"),
        disable: Some("do_not_strip_bom_in_read_all_text"),
        date: Some(Date::new(2026, 1, 13)),
        implied: Some(Implied { by: &["pedanticWpt"], date: Date::new(2026, 1, 13) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "allowIrrevocableStubStorage",
        enable: Some("allow_irrevocable_stub_storage"),
        disable: None,
        date: None,
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "rpcParamsDupStubs",
        enable: Some("rpc_params_dup_stubs"),
        disable: Some("rpc_params_transfer_stubs"),
        date: Some(Date::new(2026, 1, 20)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodejsGlobalTimers",
        enable: Some("enable_nodejs_global_timers"),
        disable: Some("no_nodejs_global_timers"),
        date: None,
        implied: Some(Implied { by: &["nodeJsCompat"], date: Date::new(2026, 2, 10) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "noAutoAllocateChunkSize",
        enable: Some("streams_no_default_auto_allocate_chunk_size"),
        disable: Some("streams_auto_allocate_chunk_size_default"),
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "pythonWorkflowsImplicitDeps",
        enable: Some("python_workflows_implicit_dependencies"),
        disable: Some("no_python_workflows_implicit_dependencies"),
        date: None,
        implied: Some(Implied { by: &["pythonWorkers"], date: Date::new(2026, 2, 25) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "requireReturnsDefaultExport",
        enable: Some("require_returns_default_export"),
        disable: Some("require_returns_namespace"),
        date: Some(Date::new(2026, 1, 22)),
        implied: None,
        experimental: false,
        support: NoEffect("celld has no run-time require() of a module; esbuild resolves it when it bundles"),
    },
    Flag {
        field: "pythonRequestHeadersPreserveCommas",
        enable: Some("python_request_headers_preserve_commas"),
        disable: Some("disable_python_request_headers_preserve_commas"),
        date: Some(Date::new(2026, 2, 17)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "queueExposeErrorCodes",
        enable: Some("queue_expose_error_codes"),
        disable: Some("no_queue_expose_error_codes"),
        date: Some(Date::new(2026, 3, 12)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "textDecoderReplaceSurrogates",
        enable: Some("text_decoder_replace_surrogates"),
        disable: Some("disable_text_decoder_replace_surrogates"),
        date: Some(Date::new(2026, 2, 24)),
        implied: Some(Implied { by: &["pedanticWpt"], date: Date::new(2026, 2, 24) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "containersPidNamespace",
        enable: Some("containers_pid_namespace"),
        disable: Some("no_containers_pid_namespace"),
        date: Some(Date::new(2026, 4, 1)),
        implied: None,
        experimental: false,
        support: On("a container has its own PID namespace"),
    },
    Flag {
        field: "deleteAllDeletesAlarm",
        enable: Some("delete_all_deletes_alarm"),
        disable: Some("delete_all_preserves_alarm"),
        date: Some(Date::new(2026, 2, 24)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "unhandledRejectionAfterMicrotaskCheckpoint",
        enable: Some("unhandled_rejection_after_microtask_checkpoint"),
        disable: Some("no_unhandled_rejection_after_microtask_checkpoint"),
        date: Some(Date::new(2026, 3, 3)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "textDecoderCjkDecoder",
        enable: Some("text_decoder_cjk_decoder"),
        disable: Some("disable_text_decoder_cjk_decoder"),
        date: Some(Date::new(2026, 3, 3)),
        implied: None,
        experimental: false,
        support: On("TextDecoder decodes CJK encodings per the Encoding Standard"),
    },
    Flag {
        field: "websocketCloseReasonByteLimit",
        enable: Some("websocket_close_reason_byte_limit"),
        disable: Some("no_websocket_close_reason_byte_limit"),
        date: Some(Date::new(2026, 3, 3)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableVersionApi",
        enable: Some("enable_version_api"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "websocketBinaryTypeDefault",
        enable: Some("websocket_standard_binary_type"),
        disable: Some("no_websocket_standard_binary_type"),
        date: Some(Date::new(2026, 3, 17)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "writableStreamSpecCompliantWriter",
        enable: Some("writable_stream_spec_compliant_writer"),
        disable: Some("no_writable_stream_spec_compliant_writer"),
        date: Some(Date::new(2026, 3, 24)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "encoderStreamSpecCompliantBackpressure",
        enable: Some("encoder_stream_spec_compliant_backpressure"),
        disable: Some("no_encoder_stream_spec_compliant_backpressure"),
        date: Some(Date::new(2026, 3, 24)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "specCompliantPropertyAttributes",
        enable: Some("spec_compliant_property_attributes"),
        disable: Some("no_spec_compliant_property_attributes"),
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "workflowsPreserveNonRetryableErrorMessage",
        enable: Some("workflows_preserve_non_retryable_error_message"),
        disable: Some("workflows_replace_non_retryable_error_message"),
        date: Some(Date::new(2026, 5, 14)),
        implied: None,
        experimental: false,
        support: On("a NonRetryableError keeps its message and name"),
    },
    Flag {
        field: "webSocketAutoReplyToClose",
        enable: Some("web_socket_auto_reply_to_close"),
        disable: Some("web_socket_manual_reply_to_close"),
        date: Some(Date::new(2026, 4, 7)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableCtxVersionMetadata",
        enable: Some("enable_ctx_version_metadata"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "noResizableArrayBufferInBlob",
        enable: Some("no_resizable_array_buffer_in_blob"),
        disable: Some("resizable_array_buffer_in_blob"),
        date: None,
        implied: None,
        experimental: false,
        support: Off("Blob accepts a resizable ArrayBuffer"),
    },
    Flag {
        field: "diagnosticsChannelHasSubscribersGetter",
        enable: Some("diagnostics_channel_has_subscribers_getter"),
        disable: Some("no_diagnostics_channel_has_subscribers_getter"),
        date: Some(Date::new(2026, 5, 19)),
        implied: None,
        experimental: false,
        support: On("diagnostics_channel's hasSubscribers is a getter"),
    },
    Flag {
        field: "workflowsStepRollback",
        enable: Some("workflows_step_rollback"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "pythonProcessPthFiles",
        enable: Some("python_process_pth_files"),
        disable: Some("disable_python_process_pth_files"),
        date: Some(Date::new(2026, 5, 26)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "throwOnNotImplementedTlsOptions",
        enable: Some("throw_on_not_implemented_tls_options"),
        disable: Some("no_throw_on_not_implemented_tls_options"),
        date: Some(Date::new(2026, 6, 16)),
        implied: None,
        experimental: false,
        support: NoEffect("celld's Node.js modules and globals do not depend on this flag (see Node.js compatibility)"),
    },
    Flag {
        field: "autoGrpcConvert",
        enable: Some("auto_grpc_convert"),
        disable: None,
        date: None,
        implied: None,
        experimental: false,
        support: Off("celld does not convert a gRPC-web subrequest to gRPC"),
    },
    Flag {
        field: "pythonWorkers20260610",
        enable: Some("python_workers_20260610"),
        disable: Some("no_python_workers_20260610"),
        date: None,
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "enableNodeJsInspectorLocalDev",
        enable: Some("enable_nodejs_inspector_local_dev"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "d1BindingJsrpc",
        enable: Some("d1_binding_jsrpc"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "workflowsBindingsRpc",
        enable: Some("workflows_bindings_rpc"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "typeScriptImplementedStreams",
        enable: Some("typescript_implemented_streams"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "exposeDrainingReader",
        enable: Some("expose_draining_reader"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "workflowsEnableFastEngineCreation",
        enable: Some("workflows_enable_fast_engine_creation"),
        disable: Some("workflows_disable_fast_engine_creation"),
        date: Some(Date::new(2026, 8, 11)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "wasmMemoryDiscard",
        enable: Some("wasm_memory_discard"),
        disable: None,
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "pythonWorkers314",
        enable: Some("python_workers_314"),
        disable: Some("no_python_workers_314"),
        date: None,
        implied: Some(Implied { by: &["pythonWorkers"], date: Date::new(2026, 9, 8) }),
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "specCompliantDispatchExceptions",
        enable: Some("spec_compliant_dispatch_exceptions"),
        disable: Some("no_spec_compliant_dispatch_exceptions"),
        date: Some(Date::new(2026, 9, 15)),
        implied: None,
        experimental: false,
        support: Honoured,
    },
    Flag {
        field: "autoInjectPythonWorkers",
        enable: Some("auto_inject_python_workers"),
        disable: Some("no_auto_inject_python_workers"),
        date: None,
        implied: None,
        experimental: true,
        support: Experimental,
    },
    Flag {
        field: "durableObjectIoTasksPreventEviction",
        enable: Some("durable_object_io_tasks_prevent_eviction"),
        disable: Some("durable_object_io_tasks_do_not_prevent_eviction"),
        date: Some(Date::new(2026, 10, 1)),
        implied: None,
        experimental: false,
        support: Off("an idle Durable Object can be evicted while its waitUntil() work is pending"),
    },
    Flag {
        field: "webCryptoModernAlgorithms",
        enable: Some("webcrypto_modern_algorithms"),
        disable: None,
        date: None,
        implied: None,
        experimental: false,
        support: Off("Web Crypto has no ML-KEM or ML-DSA"),
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    /// workerd's `src/workerd/io/compatibility-date.capnp` at
    /// [`WORKERD_VERSION`], unchanged.
    const CAPNP: &str = include_str!("compat_flags/compatibility-date.capnp");

    #[derive(Debug, PartialEq)]
    struct Upstream {
        field: String,
        enable: Option<String>,
        disable: Option<String>,
        date: Option<String>,
        implied: Option<(Vec<String>, String)>,
        experimental: bool,
    }

    /// The quoted strings in `text`.
    fn quoted(text: &str) -> Vec<String> {
        text.split('"')
            .skip(1)
            .step_by(2)
            .map(str::to_string)
            .collect()
    }

    /// The text between `$name(` and its `)`.
    fn annotation<'a>(declaration: &'a str, name: &str) -> Option<&'a str> {
        let start = declaration.find(&format!("${name}("))? + name.len() + 2;
        let end = start + declaration[start..].find(')')?;
        Some(&declaration[start..end])
    }

    /// Each `name @N :Bool ...;` field of `struct CompatibilityFlags`.
    fn upstream() -> Vec<Upstream> {
        let start = CAPNP
            .find("struct CompatibilityFlags")
            .expect("the capnp declares CompatibilityFlags");
        let body = CAPNP[start..]
            .lines()
            .map(|line| line.split('#').next().unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n");
        let mut fields = Vec::new();
        for declaration in body.split(';') {
            let mut words = declaration.split_whitespace();
            let (Some(field), Some(ordinal)) = (words.next(), words.next()) else {
                continue;
            };
            let ordinal = ordinal.trim_end_matches(':');
            let is_field = ordinal.len() > 1
                && ordinal.starts_with('@')
                && ordinal[1..].bytes().all(|byte| byte.is_ascii_digit());
            let rest = declaration[declaration.find(ordinal).unwrap() + ordinal.len()..]
                .trim_start()
                .trim_start_matches(':')
                .trim_start();
            if !is_field || !rest.starts_with("Bool") {
                continue;
            }
            let one = |name: &str| annotation(declaration, name).map(|text| quoted(text).remove(0));
            let implied = annotation(declaration, "impliedByAfterDate").map(|text| {
                let at = text.find("date").expect("impliedByAfterDate has a date");
                (quoted(&text[..at]), quoted(&text[at..]).remove(0))
            });
            fields.push(Upstream {
                field: field.to_string(),
                enable: one("compatEnableFlag"),
                disable: one("compatDisableFlag"),
                date: if declaration.contains("$compatEnableAllDates") {
                    Some("all".into())
                } else {
                    one("compatEnableDate")
                },
                implied,
                experimental: declaration.contains("$experimental"),
            });
        }
        fields
    }

    fn ours(flag: &Flag) -> Upstream {
        Upstream {
            field: flag.field.to_string(),
            enable: flag.enable.map(str::to_string),
            disable: flag.disable.map(str::to_string),
            date: flag.date.map(|date| {
                if date == Date::ALL {
                    "all".to_string()
                } else {
                    date.to_string()
                }
            }),
            implied: flag.implied.as_ref().map(|implied| {
                (
                    implied.by.iter().map(|by| by.to_string()).collect(),
                    implied.date.to_string(),
                )
            }),
            experimental: flag.experimental,
        }
    }

    /// A new workerd's flags fail this test until each is in [`FLAGS`], in
    /// capnp order, with a [`Support`].
    #[test]
    fn table_matches_the_pinned_workerd() {
        let upstream = upstream();
        assert!(
            upstream.len() > 150,
            "the capnp parser found {} flags",
            upstream.len()
        );
        let mut problems = Vec::new();
        for index in 0..upstream.len().max(FLAGS.len()) {
            match (upstream.get(index), FLAGS.get(index).map(ours)) {
                (Some(theirs), Some(ours)) if *theirs == ours => {}
                (Some(theirs), Some(ours)) => {
                    problems.push(format!("  workerd: {theirs:?}\n  celld:   {ours:?}"))
                }
                (Some(theirs), None) => problems.push(format!("  missing: {theirs:?}")),
                (None, Some(ours)) => problems.push(format!("  not in workerd: {ours:?}")),
                (None, None) => unreachable!(),
            }
        }
        assert!(
            problems.is_empty(),
            "compat_flags::FLAGS differs from workerd {WORKERD_VERSION}'s \
             compatibility-date.capnp. Add or update each flag, in capnp order, and give \
             it a Support:\n{}",
            problems.join("\n")
        );
    }

    #[test]
    fn workerd_version_is_the_one_the_conformance_corpus_pins() {
        let lock = include_str!("../../tests/conformance/pnpm-lock.yaml");
        assert!(
            lock.contains(&format!("\n  workerd@{WORKERD_VERSION}:")),
            "tests/conformance pins another workerd than WORKERD_VERSION \
             ({WORKERD_VERSION}); vendor that workerd's compatibility-date.capnp"
        );
    }

    #[test]
    fn flag_names_are_unique_and_implications_resolve() {
        let mut names = std::collections::HashSet::new();
        for flag in FLAGS {
            for name in [flag.enable, flag.disable].into_iter().flatten() {
                assert!(names.insert(name), "{name} names two flags");
            }
            for by in flag.implied.iter().flat_map(|implied| implied.by) {
                field_index(by);
            }
            if flag.experimental {
                assert!(
                    matches!(flag.support, Support::Experimental | Support::Honoured),
                    "experimental {} needs Support::Experimental or Honoured",
                    flag.field
                );
            }
        }
        for (name, _) in CELLD_FLAGS {
            assert!(names.insert(name), "{name} is also a workerd flag");
        }
    }

    /// The section of docs/cloudflare-compat.md under `heading`, which is
    /// `###` or `####` and its title, up to the next heading of its level or
    /// above.
    fn docs_section<'a>(docs: &'a str, heading: &str) -> &'a str {
        let start = docs
            .find(&format!("\n{heading}\n"))
            .unwrap_or_else(|| panic!("docs/cloudflare-compat.md has no `{heading}`"));
        let rest = &docs[start + heading.len() + 2..];
        let level = heading.split(' ').next().unwrap();
        let end = (2..=level.len())
            .filter_map(|hashes| rest.find(&format!("\n{} ", "#".repeat(hashes))))
            .min()
            .unwrap_or(rest.len());
        &rest[..end]
    }

    /// Every flag name written in backticks in `text`.
    fn flags_named(text: &str) -> std::collections::BTreeSet<&str> {
        let known = |name: &str| {
            FLAGS
                .iter()
                .any(|flag| flag.enable == Some(name) || flag.disable == Some(name))
                || CELLD_FLAGS.iter().any(|(own, _)| *own == name)
        };
        text.split('`')
            .skip(1)
            .step_by(2)
            .filter(|name| known(name))
            .collect()
    }

    fn names(
        names: impl Iterator<Item = &'static str>,
    ) -> std::collections::BTreeSet<&'static str> {
        names.collect()
    }

    /// Each flag name is in the docs section of its class and in no other.
    /// Experimental flags celld refuses are covered by one sentence.
    #[test]
    fn docs_list_every_flag_in_its_class_only() {
        let docs = include_str!("../../docs/cloudflare-compat.md");
        let all = || {
            FLAGS.iter().flat_map(|flag| {
                [flag.enable, flag.disable]
                    .into_iter()
                    .flatten()
                    .map(move |name| (flag, name))
            })
        };
        let class = |want: fn(&Class) -> bool| {
            names(
                all()
                    .filter(move |(flag, name)| want(&flag.class(name)))
                    .map(|(_, name)| name),
            )
        };
        let mut honoured = class(|class| *class == Class::Honoured);
        honoured.extend(CELLD_FLAGS.iter().map(|(name, _)| *name));
        let no_op = class(|class| matches!(class, Class::NoOp(_)));
        let refused = names(
            all()
                .filter(|(flag, name)| {
                    matches!(flag.class(name), Class::Refused(_))
                        && flag.support != Support::Experimental
                })
                .map(|(_, name)| name),
        );
        for (heading, expected) in [
            ("### Honoured flags", honoured),
            ("### Flags without effect", no_op),
            ("### Refused flags", refused),
        ] {
            assert_eq!(
                flags_named(docs_section(docs, heading)),
                expected,
                "{heading}"
            );
        }
    }

    /// The docs list each flag whose date gives a Worker on Cloudflare a
    /// behaviour celld lacks.
    #[test]
    fn docs_list_every_difference_a_date_selects() {
        let docs = include_str!("../../docs/cloudflare-compat.md");
        fn date(flag: &Flag) -> Option<Date> {
            flag.date
                .or(flag.implied.as_ref().map(|implied| implied.date))
        }
        let enabled = |pick: fn(&Flag) -> bool| {
            names(
                FLAGS
                    .iter()
                    .filter(|flag| pick(flag))
                    .filter_map(|flag| flag.enable),
            )
        };
        let from = enabled(|flag| {
            matches!(flag.support, Support::Off(_) | Support::Unmodelled(_))
                && date(flag).is_some_and(|day| day != Date::ALL && day <= NEWEST_DATE)
        });
        let before = enabled(|flag| {
            matches!(flag.support, Support::On(_)) && date(flag).is_some_and(|day| day != Date::ALL)
        });
        let always = enabled(|flag| matches!(flag.support, Support::On(_)) && date(flag).is_none());
        for (heading, expected) in [
            ("#### From a date", from),
            ("#### Before a date", before),
            ("#### Whatever the date", always),
        ] {
            // A class with no flags has no section.
            let listed = if expected.is_empty() && !docs.contains(&format!("\n{heading}\n")) {
                Default::default()
            } else {
                flags_named(docs_section(docs, heading))
            };
            assert_eq!(listed, expected, "{heading}");
        }
    }

    const TODAY: Date = Date::new(2026, 10, 22);

    fn values(date: &str, flags: &[&str]) -> CompatFlags {
        compile_at(Some(date), flags, Context::Deploy, TODAY).expect("valid flags")
    }

    fn errors(date: Option<&str>, flags: &[&str]) -> Vec<String> {
        compile_at(date, flags, Context::Deploy, TODAY).expect_err("invalid flags")
    }

    #[test]
    fn dates_parse_as_workerd_parses_them() {
        assert_eq!(Date::parse("2026-09-04"), Some(Date::new(2026, 9, 4)));
        for bad in [
            "",
            "2026-9-4",
            "2026-09-4",
            "2026-2-1",
            "2026-09",
            "2026-09-04-01",
            "1999-01-01",
            "2026-13-01",
            "2026-00-01",
            "2026-01-32",
            "2026-01-0x",
            "+2026-01-01",
            "2026-01-01 ",
        ] {
            assert_eq!(Date::parse(bad), None, "{bad:?}");
        }
        assert_eq!(Date::new(2026, 1, 2).to_string(), "2026-01-02");
    }

    #[test]
    fn a_date_enables_its_flags_and_a_disable_flag_overrides_it() {
        let flag = WEBSOCKET_STANDARD_BINARY_TYPE;
        assert!(!values("2026-03-16", &[]).get(flag));
        assert!(values("2026-03-17", &[]).get(flag));
        assert!(values("2026-01-01", &["websocket_standard_binary_type"]).get(flag));
        assert!(!values("2026-09-04", &["no_websocket_standard_binary_type"]).get(flag));
        assert!(!compile_lenient(None, &[]).get(flag));
    }

    #[test]
    fn the_close_reply_follows_its_date_and_the_manual_flag() {
        let flag = WEB_SOCKET_AUTO_REPLY_TO_CLOSE;
        assert!(!values("2026-04-06", &[]).get(flag));
        assert!(values("2026-04-07", &[]).get(flag));
        assert!(values("2026-01-01", &["web_socket_auto_reply_to_close"]).get(flag));
        assert!(!values("2026-09-04", &["web_socket_manual_reply_to_close"]).get(flag));
        let reported: std::collections::HashMap<_, _> =
            values("2026-01-01", &[]).reported().collect();
        assert_eq!(reported.get("web_socket_auto_reply_to_close"), Some(&false));
    }

    #[test]
    fn the_flags_of_plan_1_36_follow_their_dates_and_implications() {
        // enable_nodejs_global_timers: nodejs_compat implies it from
        // 2026-02-10, and the flag alone turns it on.
        let timers = ENABLE_NODEJS_GLOBAL_TIMERS;
        assert!(!values("2026-02-09", &["nodejs_compat"]).get(timers));
        assert!(values("2026-02-10", &["nodejs_compat"]).get(timers));
        assert!(values("2026-09-04", &[]).get(timers));
        assert!(!values("2026-09-04", &["no_nodejs_compat"]).get(timers));
        assert!(!values("2026-09-04", &["no_nodejs_global_timers"]).get(timers));
        assert!(values("2026-01-01", &["enable_nodejs_global_timers"]).get(timers));
        // cache_no_cache_enabled: cache_option_enabled implies it from
        // 2025-08-07.
        let before = values("2025-08-06", &[]);
        assert!(before.get(CACHE_OPTION_ENABLED) && !before.get(CACHE_NO_CACHE));
        assert!(values("2025-08-07", &[]).get(CACHE_NO_CACHE));
        assert!(!values("2024-11-10", &[]).get(CACHE_OPTION_ENABLED));
        assert!(!values("2026-09-04", &["cache_no_cache_disabled"]).get(CACHE_NO_CACHE));
        // The override adjustment follows fetch_iterable_type_support from
        // 2026-01-15.
        let early = values("2026-01-01", &["fetch_iterable_type_support"]);
        assert!(early.get(FETCH_ITERABLE_TYPE_SUPPORT));
        assert!(!early.get(FETCH_ITERABLE_TYPE_SUPPORT_OVERRIDE_ADJUSTMENT));
        let late = values("2026-01-20", &["fetch_iterable_type_support"]);
        assert!(late.get(FETCH_ITERABLE_TYPE_SUPPORT_OVERRIDE_ADJUSTMENT));
        assert!(!values("2026-02-18", &[]).get(FETCH_ITERABLE_TYPE_SUPPORT));
        // The rest by date.
        for (flag, day) in [
            (ENHANCED_ERROR_SERIALIZATION, ("2026-04-20", "2026-04-21")),
            (BLOB_STANDARD_MIME_TYPE, ("2024-06-02", "2024-06-03")),
            (SET_TOSTRING_TAG, ("2024-09-25", "2024-09-26")),
            (
                WORKFLOWS_ENABLE_FAST_ENGINE_CREATION,
                ("2026-08-10", "2026-08-11"),
            ),
            (
                SPEC_COMPLIANT_DISPATCH_EXCEPTIONS,
                ("2026-09-14", "2026-09-15"),
            ),
            (ENABLE_FAST_JSG_STRUCT, ("2025-12-02", "2025-12-03")),
            (QUEUE_EXPOSE_ERROR_CODES, ("2026-03-11", "2026-03-12")),
            (
                UNHANDLED_REJECTION_AFTER_MICROTASK_CHECKPOINT,
                ("2026-03-02", "2026-03-03"),
            ),
            (
                BIND_ASYNCLOCALSTORAGE_SNAPSHOT_TO_REQUEST,
                ("2025-06-15", "2025-06-16"),
            ),
            (
                THROW_ON_UNRECOGNIZED_IMPORT_ASSERTION,
                ("2025-06-15", "2025-06-16"),
            ),
            (
                INTERNAL_WRITABLE_STREAM_ABORT_CLEARS_QUEUE,
                ("2024-09-01", "2024-09-02"),
            ),
            (
                FIXUP_TRANSFORM_STREAM_BACKPRESSURE,
                ("2024-12-15", "2024-12-16"),
            ),
            (
                ENCODER_STREAM_SPEC_COMPLIANT_BACKPRESSURE,
                ("2026-03-23", "2026-03-24"),
            ),
        ] {
            assert!(!values(day.0, &[]).get(flag), "{flag:?}");
            assert!(values(day.1, &[]).get(flag), "{flag:?}");
        }
    }

    #[test]
    fn implications_follow_their_date_and_chain_in_field_order() {
        // nodejs_compat implies nodejs_compat_v2 from 2024-09-23, and either
        // implies nodejs_zlib from then.
        let zlib = id("nodejs_zlib");
        assert!(!values("2024-09-22", &["nodejs_compat"]).get(NODEJS_COMPAT_V2));
        let flags = values("2024-09-23", &["nodejs_compat"]);
        assert!(flags.get(NODEJS_COMPAT_V2) && flags.get(zlib));
        assert!(!values("2024-09-23", &["nodejs_compat", "no_nodejs_zlib"]).get(zlib));
        // enable_nodejs_http_server_modules follows enable_nodejs_http_modules,
        // itself implied by nodejs_compat, which the date turns on.
        let server = id("enable_nodejs_http_server_modules");
        assert!(values("2026-09-04", &[]).get(server));
        assert!(!values("2026-09-04", &["no_nodejs_compat"]).get(server));
        // An implication needs the date: without one, nothing is implied.
        assert!(!compile_lenient(None, &["nodejs_compat"]).get(NODEJS_COMPAT_V2));
        // All dates: r2_public_beta_bindings is on without a date.
        assert!(compile_lenient(None, &[]).get(id("r2_public_beta_bindings")));
    }

    #[test]
    fn workerd_refusals_use_workerd_messages() {
        assert_eq!(
            errors(Some("2026-01-01"), &["no_such_flag", "no_such_flag"]),
            [
                "Compatibility flag specified multiple times: no_such_flag",
                "No such compatibility flag: no_such_flag",
            ]
        );
        assert_eq!(
            errors(
                Some("2026-01-01"),
                &["rpc_params_dup_stubs", "rpc_params_transfer_stubs"]
            ),
            [
                "Compatibility flags are mutually contradictory: rpc_params_dup_stubs vs \
              rpc_params_transfer_stubs"
            ]
        );
        assert_eq!(
            errors(Some("2026-1"), &[]),
            ["Invalid compatibility date: 2026-1"]
        );
        assert_eq!(
            errors(Some("2026-10-02"), &[]),
            [
                "This Worker requires compatibility date \"2026-10-02\", but the newest date \
              supported by this server binary is \"2026-10-01\"."
            ]
        );
        assert_eq!(
            compile_at(
                Some("2026-09-04"),
                &[],
                Context::Deploy,
                Date::new(2026, 9, 3)
            )
            .unwrap_err(),
            [
                "Can't set compatibility date in the future: \"2026-09-04\". Today's date (UTC) \
              is \"2026-09-03\"."
            ]
        );
        assert_eq!(
            errors(Some("2026-01-01"), &["experimental"]),
            ["The compatibility flag experimental is experimental and cannot be used with celld."]
        );
    }

    #[test]
    fn celld_refuses_a_behaviour_it_lacks_and_accepts_one_it_has() {
        // On: the enable name is accepted, the disable name refused.
        assert!(compile_at(
            Some("2021-01-01"),
            &["url_standard"],
            Context::Deploy,
            TODAY
        )
        .is_ok());
        assert_eq!(
            errors(Some("2026-01-01"), &["url_original"]),
            [
                "The compatibility flag url_original is not supported by celld: celld always \
              behaves as url_standard does: URL follows the WHATWG URL Standard."
            ]
        );
        // Off: the other way round.
        assert!(compile_at(
            Some("2026-09-04"),
            &["mutable_api_prototypes"],
            Context::Deploy,
            TODAY
        )
        .is_ok());
        assert_eq!(
            errors(Some("2026-01-01"), &["immutable_api_prototypes"]),
            [
                "The compatibility flag immutable_api_prototypes is not supported by celld: API \
              prototypes are mutable."
            ]
        );
        // Unmodelled: both names.
        assert_eq!(
            errors(Some("2026-01-01"), &["enable_streams_nodejs_v24_compat"]).len(),
            1
        );
        assert_eq!(
            errors(Some("2026-01-01"), &["disable_streams_nodejs_v24_compat"]).len(),
            1
        );
        // Honoured experimental flags and celld's own flags are accepted.
        let flags = values(
            "2026-01-01",
            &[
                "js_rpc",
                "service_binding_extra_handlers",
                "enable_abortsignal_rpc",
                "sqlite_vec",
                "no_precise_timers",
            ],
        );
        assert!(flags.get(JS_RPC) && flags.get(SERVICE_BINDING_EXTRA_HANDLERS));
        assert!(flags.get(ABORTSIGNAL_RPC) && flags.get(SQLITE_VEC));
    }

    /// Every switch with both an enable and a disable name refuses the two
    /// together, with workerd's message, whatever each name's class.
    #[test]
    fn every_contradictory_pair_is_refused() {
        let mut pairs = 0;
        for flag in FLAGS {
            let (Some(enable), Some(disable)) = (flag.enable, flag.disable) else {
                continue;
            };
            pairs += 1;
            let contradiction =
                format!("Compatibility flags are mutually contradictory: {enable} vs {disable}");
            for context in [Context::Deploy, Context::Loader] {
                let errors = compile_at(Some("2026-01-01"), &[enable, disable], context, TODAY)
                    .expect_err(enable);
                assert_eq!(errors[0], contradiction, "{context:?}");
            }
        }
        assert!(pairs > 100, "{pairs} switches");
    }

    #[test]
    fn the_loader_refuses_every_experimental_flag() {
        let refused = |flag: &str| {
            format!(
                "The compatibility flag {flag} is experimental and may break or be removed in a \
                 future version of workerd. To use this flag, you must pass --experimental on \
                 the command line."
            )
        };
        for flag in [
            "experimental",
            "js_rpc",
            "service_binding_extra_handlers",
            "enable_abortsignal_rpc",
        ] {
            assert_eq!(
                compile_at(Some("2026-01-01"), &[flag], Context::Loader, TODAY).unwrap_err(),
                [refused(flag)]
            );
        }
        // Turning an experimental flag off is not refused.
        compile_at(
            Some("2026-01-01"),
            &["no_precise_timers"],
            Context::Loader,
            TODAY,
        )
        .unwrap();
    }

    #[test]
    fn every_error_is_reported() {
        assert_eq!(
            errors(
                Some("2026-10-02"),
                &["bogus", "url_original", "experimental"]
            )
            .len(),
            4
        );
    }

    #[test]
    fn lenient_compilation_ignores_what_deploy_refuses() {
        let flags = compile_lenient(Some("not a date"), &["bogus", "nodejs_als"]);
        assert!(flags.get(NODEJS_ALS));
        assert!(!flags.get(NODEJS_COMPAT));
    }

    #[test]
    fn the_performance_flags_follow_nodejs_compat_from_their_date() {
        for flag in [
            ENABLE_GLOBAL_PERFORMANCE_CLASSES,
            ENABLE_NODEJS_PERF_HOOKS_MODULE,
        ] {
            assert!(!values("2026-03-16", &["nodejs_compat"]).get(flag));
            assert!(values("2026-03-17", &["nodejs_compat"]).get(flag));
            assert!(!values("2026-09-04", &["no_nodejs_compat"]).get(flag));
        }
        let alone = values("2025-01-01", &["enable_global_performance_classes"]);
        assert!(alone.get(ENABLE_GLOBAL_PERFORMANCE_CLASSES));
        assert!(!alone.get(ENABLE_NODEJS_PERF_HOOKS_MODULE));
        let without = values("2026-09-04", &["disable_nodejs_perf_hooks_module"]);
        assert!(without.get(ENABLE_GLOBAL_PERFORMANCE_CLASSES));
        assert!(!without.get(ENABLE_NODEJS_PERF_HOOKS_MODULE));
        let reported: std::collections::HashMap<_, _> = without.reported().collect();
        assert_eq!(
            reported.get("enable_global_performance_classes"),
            Some(&true)
        );
        assert_eq!(
            reported.get("enable_nodejs_perf_hooks_module"),
            Some(&false)
        );
    }

    #[test]
    fn reported_flags_are_the_honoured_ones() {
        let flags = values("2026-09-04", &["nodejs_als"]);
        let reported: std::collections::HashMap<_, _> = flags.reported().collect();
        assert_eq!(reported.get("nodejs_als"), Some(&true));
        assert_eq!(reported.get("nodejs_compat"), Some(&true));
        assert_eq!(reported.get("websocket_standard_binary_type"), Some(&true));
        assert_eq!(reported.get("js_rpc"), Some(&false));
        assert_eq!(reported.get("enable_abortsignal_rpc"), Some(&false));
        assert_eq!(reported.get("sqlite_vec"), Some(&false));
        assert_eq!(reported.get("url_standard"), Some(&true));
        assert_eq!(reported.get("enhanced_error_serialization"), Some(&true));
        assert_eq!(reported.get("immutable_api_prototypes"), None);
        // Before its date workerd computes url_standard off: not reported.
        let old: std::collections::HashMap<_, _> = values("2022-01-01", &[]).reported().collect();
        assert_eq!(old.get("url_standard"), None);
        assert_eq!(old.get("rpc_params_dup_stubs"), Some(&false));
        assert_eq!(reported.get("minimal_subrequests"), None);
        assert_eq!(reported.get("blob_standard_mime_type"), Some(&true));
        assert_eq!(old.get("blob_standard_mime_type"), Some(&false));
        assert_eq!(reported.get("experimental"), None);
        // enable_request_signal has no date: off unless set.
        assert_eq!(reported.get("enable_request_signal"), Some(&false));
        let signal: std::collections::HashMap<_, _> =
            values("2026-09-04", &["enable_request_signal"])
                .reported()
                .collect();
        assert_eq!(signal.get("enable_request_signal"), Some(&true));
    }
}
