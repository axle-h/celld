// Copyright 2026 Deno Land Inc. Apache-2.0 license.

// Telemetry is observational and does not affect Actor decisions.
#![allow(clippy::disallowed_methods)]

//! Custom spans: the Workers `tracing` API (`cloudflare:workers`), on the host.
//!
//! Each traced invocation has one [`Invocation`], which holds the custom spans
//! it has open and what the Worker set on the invocation's own span. The
//! runtime task that records the invocation span creates it
//! ([`InvocationGuard`]), and the request's `IoContext` adopts it before any
//! JavaScript runs. The span ops find it through the context running the
//! code, never through anything JavaScript passes, so code can reach only
//! its own invocation.
//!
//! JavaScript holds a custom span as a *rider*: the bytes CPED carries for the
//! trace context of the running code (`js.rs`, `cped_rider`). A request's own
//! rider names the invocation span; a custom span's rider also names its
//! invocation. `enterSpan` installs its span's rider for the callback, which
//! is how console lines, outbound `fetch()`, Durable Object `fetch()` calls
//! and nested spans inside it become its children. A rider is only a name:
//! one that does not belong to the current invocation names nothing.
//!
//! Span data lives here, not in the isolate, so that two of workerd's
//! guarantees hold: a span the Worker never ends is still recorded when its
//! invocation ends, and the invocation span itself takes attributes.
//!
//! The limits are workerd's (`src/workerd/api/tracing.c++` at
//! v1.20261001.1): names are cut to 64 bytes, and a span takes about 64 KiB
//! of attributes and exceptions, past which a write is dropped and the span
//! carries workerd's `span_data_limit_exceeded` warning. Because the data is
//! in host memory rather than the isolate heap, celld also bounds what is held
//! open, counting each attribute's and span's own overhead: per invocation,
//! 1,024 spans and 1 MiB, and across the process 64 MiB. A span refused by
//! these bounds is untraced, an attribute is dropped with the same warning,
//! and the invocation span counts the refused spans.

use crate::telemetry::AttrValue;
use crate::telemetry::ByteBudget;
use crate::telemetry::ExceptionCode;
use crate::telemetry::Span;
use crate::telemetry::SpanException;
use crate::telemetry::SpanStatus;
use crate::telemetry::TraceContext;
use crate::telemetry::TraceIds;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

/// workerd's `MAX_USER_OPERATION_NAME_BYTES`.
pub const NAME_MAX_BYTES: usize = 64;
/// workerd's `MAX_SPAN_BYTES`: the soft budget for one span's attributes
/// and exceptions, and the cap on a status message.
pub const SPAN_DATA_MAX_BYTES: usize = 64 * 1024;
/// The spans one invocation may hold open at once.
pub const OPEN_SPANS_MAX: usize = 1_024;
/// The bytes one invocation's open spans may hold, overhead included.
pub const OPEN_BYTES_MAX: usize = 1024 * 1024;
/// The bytes every invocation's open spans may hold together.
pub const HOST_OPEN_BYTES_MAX: usize = 64 * 1024 * 1024;

/// What an open span costs before its data: the entry, its map slot and the
/// span's fields.
const SPAN_OVERHEAD: usize = 256;
/// What one attribute costs besides its key and value bytes.
const ATTRIBUTE_OVERHEAD: usize = 80;
/// What one recorded exception costs besides its strings.
const EXCEPTION_OVERHEAD: usize = 128;

const WARNING_TYPE: &str = "cloudflare.warning.type";
const WARNING_MESSAGE: &str = "cloudflare.warning.message";
/// Keys celld sets itself. A Worker's attribute under one is dropped, so no
/// custom span can carry or override celld's own facts.
const RESERVED_PREFIX: &str = "celld.";
const SPANS_DROPPED: &str = "celld.tracing.spans_dropped";

static HOST_BUDGET: ByteBudget = ByteBudget::new(HOST_OPEN_BYTES_MAX);

/// The trace context the CPED trace rider carries: 16 trace-id bytes, 8
/// span-id bytes and a sampled byte, then for a custom span the 8-byte id
/// of its invocation's span.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TraceRider {
    pub trace_id: [u8; 16],
    pub span_id: [u8; 8],
    pub sampled: bool,
    /// `None` for the invocation's own rider.
    pub invocation: Option<[u8; 8]>,
}

impl TraceRider {
    pub const INVOCATION_LEN: usize = 25;
    pub const CUSTOM_LEN: usize = 33;

    pub fn from_context(context: &TraceContext) -> TraceRider {
        TraceRider {
            trace_id: context.trace_id,
            span_id: context.span_id,
            sampled: context.sampled,
            invocation: None,
        }
    }

    pub fn parse(bytes: &[u8]) -> Option<TraceRider> {
        if bytes.len() != Self::INVOCATION_LEN && bytes.len() != Self::CUSTOM_LEN {
            return None;
        }
        Some(TraceRider {
            trace_id: bytes[..16].try_into().unwrap(),
            span_id: bytes[16..24].try_into().unwrap(),
            sampled: bytes[24] != 0,
            invocation: (bytes.len() == Self::CUSTOM_LEN).then(|| bytes[25..].try_into().unwrap()),
        })
    }

    pub fn byte_len(&self) -> usize {
        match self.invocation {
            None => Self::INVOCATION_LEN,
            Some(_) => Self::CUSTOM_LEN,
        }
    }

    /// Write the rider into `out`, which is exactly `byte_len()` bytes. In
    /// place, because a traced request writes one on every turn.
    pub fn write(&self, out: &mut [u8]) {
        out[..16].copy_from_slice(&self.trace_id);
        out[16..24].copy_from_slice(&self.span_id);
        out[24] = u8::from(self.sampled);
        if let Some(invocation) = self.invocation {
            out[25..].copy_from_slice(&invocation);
        }
    }

    pub fn context(&self) -> TraceContext {
        TraceContext {
            trace_id: self.trace_id,
            span_id: self.span_id,
            sampled: self.sampled,
            remote: false,
        }
    }
}

/// One `Span` method call, its arguments already converted as workerd's
/// bindings convert them.
#[derive(Clone, Debug, PartialEq)]
pub enum Update {
    Attribute(String, AttrValue),
    Name(String),
    Status(SpanStatus, Option<String>),
    Exception {
        code: Option<ExceptionCode>,
        name: String,
        message: String,
        stack: Option<String>,
    },
}

/// `text` cut to at most `max` bytes, at a character boundary. workerd cuts
/// at the byte; a cut inside a character would not be a string.
pub fn truncate(mut text: String, max: usize) -> String {
    if text.len() > max {
        let mut end = max;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

fn held_size(value: &AttrValue) -> usize {
    match value {
        AttrValue::String(text) => text.len(),
        AttrValue::Bool(_) | AttrValue::Double(_) => 8,
    }
}

fn attribute_cost(key: &str, value: &AttrValue) -> usize {
    ATTRIBUTE_OVERHEAD + key.len() + held_size(value)
}

/// The bytes an invocation holds, charged to its own bound and the host's.
struct Account<'a> {
    held: &'a mut usize,
    host: &'a ByteBudget,
}

impl Account<'_> {
    fn take(&mut self, bytes: usize) -> bool {
        if *self.held + bytes > OPEN_BYTES_MAX || !self.host.try_take(bytes) {
            return false;
        }
        *self.held += bytes;
        true
    }

    /// For the bounded bytes of a limit warning, which must land even when
    /// the budget is full.
    fn force(&mut self, bytes: usize) {
        self.host.force_take(bytes);
        *self.held += bytes;
    }

    fn give_back(&mut self, bytes: usize) {
        self.host.give_back(bytes);
        *self.held -= bytes;
    }
}

/// What a Worker set on one span.
#[derive(Debug, Default)]
struct SpanData {
    /// `None` keeps the runtime's name for the invocation span.
    name: Option<String>,
    /// Keyed for replacement, with the order each key was first set.
    attributes: HashMap<String, (usize, AttrValue)>,
    status: Option<(SpanStatus, Option<String>)>,
    exceptions: Vec<SpanException>,
    /// workerd's `bytesUsed`: every attribute and exception write counts,
    /// including writes that replace an earlier value or are refused.
    bytes_used: usize,
    /// The bytes this span holds now, overhead included.
    held: usize,
}

impl SpanData {
    fn apply(&mut self, update: Update, account: &mut Account, now_unix_us: i64) {
        match update {
            Update::Attribute(key, value) => {
                if self.bytes_used > SPAN_DATA_MAX_BYTES {
                    return;
                }
                let size = value.estimated_size();
                self.bytes_used += key.len() + size;
                if self.bytes_used > SPAN_DATA_MAX_BYTES {
                    self.limit_warning(account, "attribute", &key, size);
                    return;
                }
                if key.starts_with(RESERVED_PREFIX) {
                    return;
                }
                if !self.set_attribute(account, key.clone(), value) {
                    self.limit_warning(account, "attribute", &key, size);
                }
            }
            Update::Name(name) => {
                let name = truncate(name, NAME_MAX_BYTES);
                let old = self.name.as_deref().map_or(0, str::len);
                if name.len() > old && !account.take(name.len() - old) {
                    return;
                }
                if name.len() < old {
                    account.give_back(old - name.len());
                }
                self.held = self.held + name.len() - old;
                self.name = Some(name);
            }
            Update::Status(code, message) => {
                let old = self.status_bytes();
                account.give_back(old);
                self.held -= old;
                let message = (code == SpanStatus::Error)
                    .then_some(message)
                    .flatten()
                    .map(|message| truncate(message, SPAN_DATA_MAX_BYTES))
                    .filter(|message| account.take(message.len()));
                self.held += message.as_deref().map_or(0, str::len);
                self.status = Some((code, message));
            }
            Update::Exception {
                code,
                name,
                message,
                stack,
            } => {
                let code_size = match &code {
                    Some(ExceptionCode::Text(text)) => text.len(),
                    Some(ExceptionCode::Number(_)) => 8,
                    None => 0,
                };
                let size =
                    name.len() + message.len() + code_size + stack.as_deref().map_or(0, str::len);
                self.bytes_used += size;
                if self.bytes_used > SPAN_DATA_MAX_BYTES || !account.take(EXCEPTION_OVERHEAD + size)
                {
                    self.limit_warning(account, "exception", &name, size);
                    return;
                }
                self.held += EXCEPTION_OVERHEAD + size;
                self.exceptions.push(SpanException {
                    time_unix_us: now_unix_us,
                    code,
                    name,
                    message,
                    stack,
                });
            }
        }
    }

    fn status_bytes(&self) -> usize {
        self.status
            .as_ref()
            .and_then(|(_, message)| message.as_deref())
            .map_or(0, str::len)
    }

    /// Set or replace an attribute, charging what it holds beyond the value
    /// it replaces. False when the bound refuses it.
    fn set_attribute(&mut self, account: &mut Account, key: String, value: AttrValue) -> bool {
        let new = attribute_cost(&key, &value);
        let order = self.attributes.len();
        match self.attributes.get_mut(&key) {
            Some((_, slot)) => {
                let old = attribute_cost(&key, slot);
                if new > old && !account.take(new - old) {
                    return false;
                }
                if new < old {
                    account.give_back(old - new);
                }
                self.held = self.held + new - old;
                *slot = value;
            }
            None => {
                if !account.take(new) {
                    return false;
                }
                self.held += new;
                self.attributes.insert(key, (order, value));
            }
        }
        true
    }

    /// workerd's `recordSpanDataLimitError`, word for word. Its two
    /// attributes are bounded, so they land even past the budget.
    fn limit_warning(&mut self, account: &mut Account, kind: &str, name: &str, size: usize) {
        let short = if name.len() > 64 {
            let mut end = 64;
            while !name.is_char_boundary(end) {
                end -= 1;
            }
            format!("\"{}...\" (key length {})", &name[..end], name.len())
        } else {
            format!("\"{name}\"")
        };
        let message = format!(
            "exceeded span data limit while trying to record {kind} {short} of size {size}"
        );
        for (key, value) in [
            (WARNING_TYPE, "span_data_limit_exceeded".to_string()),
            (WARNING_MESSAGE, message),
        ] {
            let value = AttrValue::String(value);
            if !self.set_attribute(account, key.to_string(), value.clone()) {
                account.force(attribute_cost(key, &value));
                self.held += attribute_cost(key, &value);
                let order = self.attributes.len();
                // Replaced when present, so the force above counts the new
                // value; the old one stays counted, which only over-counts.
                self.attributes.insert(key.to_string(), (order, value));
            }
        }
    }

    /// Merge into a span the runtime built. The runtime's failure outranks
    /// a status the Worker set; a Worker's error status fails the span.
    fn merge_into(self, span: &mut Span) {
        if let Some(name) = self.name {
            span.name = name.into();
        }
        let mut attributes: Vec<_> = self.attributes.into_iter().collect();
        attributes.sort_by_key(|(_, (order, _))| *order);
        span.attributes
            .extend(attributes.into_iter().map(|(key, (_, value))| (key, value)));
        span.exceptions.extend(self.exceptions);
        if let Some((code, message)) = self.status {
            if span.status != SpanStatus::Error {
                span.status = code;
                span.error = message;
            }
        }
    }
}

#[derive(Debug)]
struct OpenSpan {
    parent: [u8; 8],
    start_unix_us: i64,
    data: SpanData,
}

impl OpenSpan {
    fn held(&self) -> usize {
        SPAN_OVERHEAD + self.data.held
    }

    fn finish(self, trace_id: [u8; 16], span_id: [u8; 8], end_unix_us: i64) -> Span {
        let mut span = Span::new(
            TraceIds { trace_id, span_id },
            String::new(),
            crate::telemetry::KIND_INTERNAL,
        );
        span.parent_span_id = Some(self.parent);
        span.start_unix_us = self.start_unix_us;
        span.duration_us = (end_unix_us - self.start_unix_us).max(0);
        self.data.merge_into(&mut span);
        span
    }
}

#[derive(Debug, Default)]
struct State {
    /// What the Worker set on the invocation span itself.
    updates: SpanData,
    /// The runtime has recorded the invocation span. Its custom spans can
    /// still run, as `waitUntil` work does after the response.
    recorded: bool,
    /// The invocation has ended: nothing more is traced.
    closed: bool,
    open: HashMap<[u8; 8], OpenSpan>,
    /// This invocation's share of the host budget.
    held: usize,
    refused: u64,
}

/// One traced invocation's custom spans.
#[derive(Debug)]
pub struct Invocation {
    ids: TraceIds,
    host: &'static ByteBudget,
    state: Mutex<State>,
}

impl Invocation {
    pub fn new(ids: TraceIds) -> Arc<Invocation> {
        Self::with_budget(ids, &HOST_BUDGET)
    }

    fn with_budget(ids: TraceIds, host: &'static ByteBudget) -> Arc<Invocation> {
        Arc::new(Invocation {
            ids,
            host,
            state: Mutex::default(),
        })
    }

    /// Whether `rider` names a custom span of this invocation.
    fn owns(&self, rider: &TraceRider) -> bool {
        rider.trace_id == self.ids.trace_id && rider.invocation == Some(self.ids.span_id)
    }

    /// Start a custom span under `parent`, or under the invocation span when
    /// there is none. `None` when the span is untraced: the parent is not
    /// this invocation's, the invocation has ended, or a bound refuses it.
    pub fn start(
        &self,
        parent: Option<&TraceRider>,
        name: String,
        now_unix_us: i64,
    ) -> Option<TraceRider> {
        let parent = match parent {
            Some(parent) if self.owns(parent) => parent.span_id,
            Some(_) => return None,
            None => self.ids.span_id,
        };
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return None;
        }
        let name = truncate(name, NAME_MAX_BYTES);
        let cost = SPAN_OVERHEAD + name.len();
        let State { held, open, .. } = &mut *state;
        let mut account = Account {
            held,
            host: self.host,
        };
        if open.len() >= OPEN_SPANS_MAX || !account.take(cost) {
            state.refused += 1;
            return None;
        }
        let span_id = loop {
            let id: [u8; 8] = rand::random();
            if id != [0; 8] && id != self.ids.span_id && !state.open.contains_key(&id) {
                break id;
            }
        };
        state.open.insert(
            span_id,
            OpenSpan {
                parent,
                start_unix_us: now_unix_us,
                data: SpanData {
                    held: name.len(),
                    name: Some(name),
                    ..SpanData::default()
                },
            },
        );
        Some(TraceRider {
            trace_id: self.ids.trace_id,
            span_id,
            sampled: true,
            invocation: Some(self.ids.span_id),
        })
    }

    /// Apply `update` to a custom span, or to the invocation span when
    /// `rider` is `None`, if it is still traced. `None` only asks; the answer
    /// is `Span.isTraced`.
    pub fn update(
        &self,
        rider: Option<&TraceRider>,
        update: Option<Update>,
        now_unix_us: i64,
    ) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return false;
        }
        let State {
            updates,
            recorded,
            open,
            held,
            ..
        } = &mut *state;
        let mut account = Account {
            held,
            host: self.host,
        };
        let data = match rider {
            None if *recorded => return false,
            None => updates,
            Some(rider) if self.owns(rider) => match open.get_mut(&rider.span_id) {
                Some(span) => &mut span.data,
                None => return false,
            },
            Some(_) => return false,
        };
        if let Some(update) = update {
            data.apply(update, &mut account, now_unix_us);
        }
        true
    }

    /// End a custom span: the finished span, or `None` if it had already
    /// ended or is not this invocation's.
    pub fn end(&self, rider: &TraceRider, now_unix_us: i64) -> Option<Span> {
        if !self.owns(rider) {
            return None;
        }
        let mut state = self.state.lock().unwrap();
        let span = state.open.remove(&rider.span_id)?;
        let held = span.held();
        self.host.give_back(held);
        state.held -= held;
        drop(state);
        Some(span.finish(self.ids.trace_id, rider.span_id, now_unix_us))
    }

    /// Merge what the Worker set on the invocation span into the span the
    /// runtime is about to record. Later updates to it are ignored.
    pub fn merge(&self, span: &mut Span) {
        if span.ids.span_id != self.ids.span_id || span.ids.trace_id != self.ids.trace_id {
            return;
        }
        let mut state = self.state.lock().unwrap();
        if state.recorded {
            return;
        }
        state.recorded = true;
        let updates = std::mem::take(&mut state.updates);
        self.host.give_back(updates.held);
        state.held -= updates.held;
        let refused = state.refused;
        drop(state);
        updates.merge_into(span);
        if refused > 0 {
            span.attributes
                .push((SPANS_DROPPED.to_string(), AttrValue::Double(refused as f64)));
        }
    }

    /// End the invocation: the spans it left open, ended now, as workerd
    /// ends them when the request's context is destroyed.
    pub fn close(&self, now_unix_us: i64) -> Vec<Span> {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        let open = std::mem::take(&mut state.open);
        self.host.give_back(state.held);
        state.held = 0;
        state.updates = SpanData::default();
        drop(state);
        open.into_iter()
            .map(|(span_id, span)| span.finish(self.ids.trace_id, span_id, now_unix_us))
            .collect()
    }
}

impl Drop for Invocation {
    fn drop(&mut self) {
        let held = self.state.get_mut().map_or(0, |state| state.held);
        self.host.give_back(held);
    }
}

/// A traced invocation's custom spans, for as long as its work runs.
/// Dropping it records the spans the Worker left open.
pub struct InvocationGuard {
    invocation: Arc<Invocation>,
}

impl InvocationGuard {
    pub fn open(ids: TraceIds) -> InvocationGuard {
        InvocationGuard {
            invocation: Invocation::new(ids),
        }
    }

    /// The state the request's `IoContext` adopts.
    pub fn invocation(&self) -> Arc<Invocation> {
        self.invocation.clone()
    }

    /// Merge the Worker's changes into the invocation span before it is
    /// recorded.
    pub fn merge(&self, span: &mut Span) {
        self.invocation.merge(span);
    }
}

impl Drop for InvocationGuard {
    fn drop(&mut self) {
        let now = crate::telemetry::now_unix_us();
        for span in self.invocation.close(now) {
            crate::telemetry::record(span);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRACE: [u8; 16] = [7; 16];
    const INVOCATION: [u8; 8] = [1; 8];
    const IDS: TraceIds = TraceIds {
        trace_id: TRACE,
        span_id: INVOCATION,
    };

    /// An invocation on a budget of its own, so tests running in parallel
    /// do not share one.
    fn invocation_with(cap: usize) -> (Arc<Invocation>, &'static ByteBudget) {
        let host: &'static ByteBudget = Box::leak(Box::new(ByteBudget::new(cap)));
        (Invocation::with_budget(IDS, host), host)
    }

    fn invocation() -> Arc<Invocation> {
        invocation_with(HOST_OPEN_BYTES_MAX).0
    }

    fn attribute(key: &str, value: AttrValue) -> Option<Update> {
        Some(Update::Attribute(key.to_string(), value))
    }

    fn text(value: &str) -> AttrValue {
        AttrValue::String(value.to_string())
    }

    fn encode(rider: &TraceRider) -> Vec<u8> {
        let mut out = vec![0; rider.byte_len()];
        rider.write(&mut out);
        out
    }

    fn keys(span: &Span) -> Vec<&str> {
        span.attributes
            .iter()
            .map(|(key, _)| key.as_str())
            .collect()
    }

    #[test]
    fn rider_round_trips_both_layouts() {
        let invocation = TraceRider {
            trace_id: TRACE,
            span_id: INVOCATION,
            sampled: true,
            invocation: None,
        };
        let bytes = encode(&invocation);
        assert_eq!(bytes.len(), TraceRider::INVOCATION_LEN);
        assert_eq!(TraceRider::parse(&bytes), Some(invocation));

        let custom = TraceRider {
            span_id: [2; 8],
            invocation: Some(INVOCATION),
            ..invocation
        };
        let bytes = encode(&custom);
        assert_eq!(bytes.len(), TraceRider::CUSTOM_LEN);
        assert_eq!(TraceRider::parse(&bytes), Some(custom));
        assert_eq!(TraceRider::parse(&bytes[..24]), None);
        assert_eq!(TraceRider::parse(&[0; 34]), None);
    }

    #[test]
    fn children_carry_their_parent_and_invocation_ids() {
        let invocation = invocation();
        let outer = invocation.start(None, "outer".into(), 10).unwrap();
        assert_eq!(outer.trace_id, TRACE);
        assert_eq!(outer.invocation, Some(INVOCATION));
        let inner = invocation.start(Some(&outer), "inner".into(), 11).unwrap();
        assert_ne!(inner.span_id, outer.span_id);

        let outer_span = invocation.end(&outer, 20).unwrap();
        // A parent that has ended still parents a new span, as in workerd.
        let late = invocation.start(Some(&outer), "late".into(), 21).unwrap();
        let inner_span = invocation.end(&inner, 30).unwrap();
        let late_span = invocation.end(&late, 31).unwrap();

        assert_eq!(outer_span.parent_span_id, Some(INVOCATION));
        assert_eq!(outer_span.parent_remote, None);
        assert_eq!(outer_span.ids.span_id, outer.span_id);
        assert_eq!(outer_span.name, "outer");
        assert_eq!((outer_span.start_unix_us, outer_span.duration_us), (10, 10));
        assert_eq!(inner_span.parent_span_id, Some(outer.span_id));
        assert_eq!(late_span.parent_span_id, Some(outer.span_id));
        assert_eq!(inner_span.kind, crate::telemetry::KIND_INTERNAL);
        // Ending twice records once.
        assert!(invocation.end(&inner, 40).is_none());
    }

    #[test]
    fn a_rider_from_another_invocation_names_nothing() {
        let invocation = invocation();
        let (other, _) = invocation_with(HOST_OPEN_BYTES_MAX);
        let mine = invocation.start(None, "mine".into(), 0).unwrap();
        for forged in [
            // Another trace.
            TraceRider {
                trace_id: [8; 16],
                ..mine
            },
            // Another invocation of the same trace.
            TraceRider {
                invocation: Some([9; 8]),
                ..mine
            },
            // The invocation's own rider is not a custom span.
            TraceRider {
                invocation: None,
                span_id: INVOCATION,
                ..mine
            },
        ] {
            assert_eq!(invocation.start(Some(&forged), "x".into(), 0), None);
            assert!(!invocation.update(Some(&forged), attribute("k", text("v")), 0));
            assert!(invocation.end(&forged, 0).is_none());
        }
        // The same rider names nothing in another invocation that shares the
        // ids but holds no such span.
        assert!(!Arc::ptr_eq(&invocation, &other));
        assert!(!other.update(Some(&mine), None, 0));
        assert!(other.end(&mine, 0).is_none());
        assert!(invocation.update(Some(&mine), None, 0));
    }

    #[test]
    fn closing_an_invocation_ends_the_spans_left_open() {
        let (invocation, host) = invocation_with(HOST_OPEN_BYTES_MAX);
        let ended = invocation.start(None, "ended".into(), 1).unwrap();
        let forgotten = invocation.start(None, "forgotten".into(), 2).unwrap();
        invocation.update(Some(&forgotten), attribute("k", AttrValue::Bool(true)), 3);
        invocation.end(&ended, 4).unwrap();
        let spans = invocation.close(9);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].ids.span_id, forgotten.span_id);
        assert_eq!(spans[0].duration_us, 7);
        assert_eq!(
            spans[0].attributes,
            vec![("k".to_string(), AttrValue::Bool(true))]
        );
        assert_eq!(host.used(), 0);
        // A closed invocation traces nothing more.
        assert_eq!(invocation.start(None, "x".into(), 10), None);
        assert!(!invocation.update(None, None, 10));
        assert!(!invocation.update(Some(&forgotten), None, 10));
    }

    #[test]
    fn names_are_cut_to_64_bytes_at_a_character_boundary() {
        assert_eq!(truncate("a".repeat(100), NAME_MAX_BYTES).len(), 64);
        assert_eq!(truncate("short".into(), NAME_MAX_BYTES), "short");
        // 63 ASCII bytes and a two-byte character straddle the limit.
        let straddling = format!("{}é", "a".repeat(63));
        assert_eq!(truncate(straddling, NAME_MAX_BYTES), "a".repeat(63));

        let invocation = invocation();
        let span = invocation.start(None, "n".repeat(100), 0).unwrap();
        invocation.update(Some(&span), Some(Update::Name("m".repeat(70))), 0);
        assert_eq!(invocation.end(&span, 0).unwrap().name, "m".repeat(64));
    }

    #[test]
    fn attributes_replace_and_stop_at_workerds_budget_with_its_warning() {
        let invocation = invocation();
        let span = invocation.start(None, "s".into(), 0).unwrap();
        let set = |key: &str, value| invocation.update(Some(&span), attribute(key, value), 0);
        set("k", AttrValue::Double(1.0));
        // workerd counts every write, a replacement included: 1 + 8 twice.
        set("k", AttrValue::Double(2.0));
        // This one takes the total to exactly the budget, which still fits.
        let fits = SPAN_DATA_MAX_BYTES - 18 - 3;
        set("big", text(&"x".repeat(fits)));
        set("over", AttrValue::Bool(true));
        // Past the budget, a write is dropped without a new warning.
        set("later", text("y"));
        let finished = invocation.end(&span, 0).unwrap();
        assert_eq!(keys(&finished), ["k", "big", WARNING_TYPE, WARNING_MESSAGE]);
        assert_eq!(finished.attributes[0].1, AttrValue::Double(2.0));
        assert_eq!(finished.attributes[2].1, text("span_data_limit_exceeded"));
        assert_eq!(
            finished.attributes[3].1,
            text("exceeded span data limit while trying to record attribute \"over\" of size 8")
        );
    }

    #[test]
    fn many_distinct_keys_stop_at_the_budget() {
        let (invocation, host) = invocation_with(HOST_OPEN_BYTES_MAX);
        let span = invocation.start(None, "s".into(), 0).unwrap();
        for index in 0..6_000 {
            invocation.update(
                Some(&span),
                attribute(&index.to_string(), AttrValue::Bool(true)),
                0,
            );
        }
        let held = host.used();
        let finished = invocation.end(&span, 0).unwrap();
        // About 64 KiB of keys at 8 bytes a value: under 6,000 attributes.
        let count = finished.attributes.len() - 2;
        assert!(count < 6_000 && count > 4_000, "{count} attributes");
        // What the host held counts each attribute's overhead, not only its
        // key and value bytes.
        assert!(
            held > count * ATTRIBUTE_OVERHEAD,
            "{held} bytes for {count} attributes"
        );
        assert_eq!(host.used(), 0);
    }

    #[test]
    fn replacing_an_attribute_holds_only_the_new_value() {
        let (invocation, host) = invocation_with(HOST_OPEN_BYTES_MAX);
        let span = invocation.start(None, "s".into(), 0).unwrap();
        let base = host.used();
        invocation.update(Some(&span), attribute("k", text(&"x".repeat(1_000))), 0);
        let large = host.used();
        invocation.update(Some(&span), attribute("k", text("y")), 0);
        assert_eq!(host.used(), base + attribute_cost("k", &text("y")));
        assert!(large > host.used());
        invocation.update(
            Some(&span),
            Some(Update::Status(SpanStatus::Error, Some("m".repeat(100)))),
            0,
        );
        invocation.update(
            Some(&span),
            Some(Update::Status(SpanStatus::Error, Some("m".into()))),
            0,
        );
        assert_eq!(host.used(), base + attribute_cost("k", &text("y")) + 1);
        invocation.end(&span, 0).unwrap();
        assert_eq!(host.used(), 0);
    }

    #[test]
    fn reserved_keys_are_dropped_and_count_toward_workerds_budget() {
        let invocation = invocation();
        let span = invocation.start(None, "s".into(), 0).unwrap();
        invocation.update(Some(&span), attribute("celld.cell", text("spoofed")), 0);
        invocation.update(Some(&span), attribute("celldish", text("kept")), 0);
        assert_eq!(keys(&invocation.end(&span, 0).unwrap()), ["celldish"]);
    }

    #[test]
    fn exceptions_count_toward_the_budget_and_name_long_keys_briefly() {
        let invocation = invocation();
        let span = invocation.start(None, "s".into(), 0).unwrap();
        invocation.update(
            Some(&span),
            Some(Update::Exception {
                code: Some(ExceptionCode::Number(42.0)),
                name: "Error".into(),
                message: "boom".into(),
                stack: Some("at x".into()),
            }),
            5,
        );
        let long = "e".repeat(SPAN_DATA_MAX_BYTES);
        invocation.update(
            Some(&span),
            Some(Update::Exception {
                code: None,
                name: long.clone(),
                message: String::new(),
                stack: None,
            }),
            6,
        );
        let finished = invocation.end(&span, 0).unwrap();
        assert_eq!(finished.exceptions.len(), 1);
        assert_eq!(finished.exceptions[0].time_unix_us, 5);
        assert_eq!(
            finished.exceptions[0].code,
            Some(ExceptionCode::Number(42.0))
        );
        assert_eq!(
            finished.attributes[1].1,
            text(&format!(
                "exceeded span data limit while trying to record exception \"{}...\" (key length {}) of size {}",
                "e".repeat(64),
                long.len(),
                long.len()
            ))
        );
    }

    #[test]
    fn status_keeps_a_message_only_for_errors() {
        let invocation = invocation();
        let span = invocation.start(None, "s".into(), 0).unwrap();
        invocation.update(
            Some(&span),
            Some(Update::Status(SpanStatus::Ok, Some("dropped".into()))),
            0,
        );
        let finished = invocation.end(&span, 0).unwrap();
        assert_eq!((finished.status, finished.error), (SpanStatus::Ok, None));

        let span = invocation.start(None, "s".into(), 0).unwrap();
        let long = "m".repeat(SPAN_DATA_MAX_BYTES + 10);
        invocation.update(
            Some(&span),
            Some(Update::Status(SpanStatus::Error, Some(long))),
            0,
        );
        let finished = invocation.end(&span, 0).unwrap();
        assert_eq!(finished.status, SpanStatus::Error);
        assert_eq!(finished.error.unwrap().len(), SPAN_DATA_MAX_BYTES);
    }

    #[test]
    fn the_invocation_span_takes_updates_until_it_is_recorded() {
        let (invocation, host) = invocation_with(HOST_OPEN_BYTES_MAX);
        assert!(invocation.update(None, attribute("user", text("a")), 0));
        assert!(invocation.update(None, Some(Update::Name("renamed".into())), 0));
        assert!(invocation.update(None, Some(Update::Status(SpanStatus::Ok, None)), 0));

        let mut span = Span::new(IDS, "celld.fetch", crate::telemetry::KIND_SERVER);
        span.set_outcome(false, Some("handler threw".into()));
        invocation.merge(&mut span);
        assert_eq!(span.name, "renamed");
        assert_eq!(span.attributes, vec![("user".to_string(), text("a"))]);
        // The runtime's failure outranks the Worker's status.
        assert_eq!(span.status, SpanStatus::Error);
        assert_eq!(span.error.as_deref(), Some("handler threw"));
        assert_eq!(host.used(), 0);

        assert!(!invocation.update(None, None, 0));
        // Its custom spans still run, as `waitUntil` work does.
        assert!(invocation.start(None, "after".into(), 0).is_some());
    }

    #[test]
    fn an_invocation_bounds_its_open_spans_and_counts_refusals() {
        let invocation = invocation();
        let spans: Vec<_> = (0..OPEN_SPANS_MAX)
            .map(|_| invocation.start(None, "s".into(), 0).unwrap())
            .collect();
        assert_eq!(invocation.start(None, "s".into(), 0), None);
        invocation.end(&spans[0], 0).unwrap();
        assert!(invocation.start(None, "s".into(), 0).is_some());

        let mut span = Span::new(IDS, "celld.fetch", crate::telemetry::KIND_SERVER);
        invocation.merge(&mut span);
        assert_eq!(
            span.attributes,
            vec![(SPANS_DROPPED.to_string(), AttrValue::Double(1.0))]
        );
    }

    #[test]
    fn an_invocation_bounds_the_bytes_its_open_spans_hold() {
        let (invocation, host) = invocation_with(HOST_OPEN_BYTES_MAX);
        let chunk = "x".repeat(SPAN_DATA_MAX_BYTES / 2);
        let mut spans = Vec::new();
        loop {
            let span = invocation.start(None, "s".into(), 0).unwrap();
            invocation.update(Some(&span), attribute("k", text(&chunk)), 0);
            let finished_keys = spans.len();
            spans.push(span);
            if host.used() + attribute_cost("k", &text(&chunk)) + SPAN_OVERHEAD > OPEN_BYTES_MAX {
                assert!(finished_keys > 0);
                break;
            }
        }
        let full = invocation.start(None, "s".into(), 0).unwrap();
        invocation.update(Some(&full), attribute("k", text(&chunk)), 0);
        assert_eq!(
            keys(&invocation.end(&full, 0).unwrap()),
            [WARNING_TYPE, WARNING_MESSAGE]
        );
        assert!(host.used() <= OPEN_BYTES_MAX);
        // Ending a span returns its bytes.
        invocation.end(&spans[0], 0).unwrap();
        let next = invocation.start(None, "s".into(), 0).unwrap();
        invocation.update(Some(&next), attribute("k", text(&chunk)), 0);
        assert_eq!(keys(&invocation.end(&next, 0).unwrap()), ["k"]);
    }

    #[test]
    fn the_host_bound_spans_invocations_and_fails_to_untraced() {
        let host: &'static ByteBudget = Box::leak(Box::new(ByteBudget::new(4 * SPAN_OVERHEAD)));
        let first = Invocation::with_budget(IDS, host);
        let second = Invocation::with_budget(
            TraceIds {
                trace_id: [3; 16],
                span_id: [4; 8],
            },
            host,
        );
        let a = first.start(None, "a".into(), 0).unwrap();
        let _b = first.start(None, "b".into(), 0).unwrap();
        let _c = second.start(None, "c".into(), 0).unwrap();
        // The fourth span would take the host past its bound.
        assert_eq!(second.start(None, "dd".into(), 0), None);
        first.end(&a, 0).unwrap();
        assert!(second.start(None, "dd".into(), 0).is_some());
        let mut span = Span::new(second.ids, "celld.fetch", crate::telemetry::KIND_SERVER);
        second.merge(&mut span);
        assert_eq!(
            span.attributes,
            vec![(SPANS_DROPPED.to_string(), AttrValue::Double(1.0))]
        );
        drop(first);
        second.close(0);
        assert_eq!(host.used(), 0);
    }

    #[test]
    fn concurrent_invocations_across_threads_return_every_byte() {
        let host: &'static ByteBudget = Box::leak(Box::new(ByteBudget::new(HOST_OPEN_BYTES_MAX)));
        let threads: Vec<_> = (0..8u8)
            .map(|thread| {
                std::thread::spawn(move || {
                    let mut recorded = 0;
                    for round in 0..50u8 {
                        let invocation = Invocation::with_budget(
                            TraceIds {
                                trace_id: [thread; 16],
                                span_id: [round + 1; 8],
                            },
                            host,
                        );
                        let ended = invocation.start(None, "ended".into(), 0).unwrap();
                        let left = invocation.start(Some(&ended), "left".into(), 0).unwrap();
                        invocation.update(Some(&left), attribute("k", text("v")), 0);
                        recorded += usize::from(invocation.end(&ended, 1).is_some());
                        recorded += invocation.close(2).len();
                        assert!(!invocation.update(Some(&left), None, 3));
                    }
                    recorded
                })
            })
            .collect();
        let recorded: usize = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .sum();
        assert_eq!(recorded, 8 * 50 * 2);
        assert_eq!(host.used(), 0);
    }

    #[test]
    fn dropping_an_unclosed_invocation_returns_its_bytes() {
        let (invocation, host) = invocation_with(HOST_OPEN_BYTES_MAX);
        let span = invocation.start(None, "s".into(), 0).unwrap();
        invocation.update(Some(&span), attribute("k", text("v")), 0);
        assert!(host.used() > 0);
        drop(invocation);
        assert_eq!(host.used(), 0);
    }
}
