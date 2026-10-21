// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! OTLP/HTTP protobuf encoding for the telemetry sink, by hand.
//!
//! The export messages celld emits are a small, stable corner of the
//! OTLP proto — flat spans and log records with scalar attributes — and
//! protobuf's wire format is varints and length-delimited fields. Hand
//! encoding keeps prost, tonic, and the generated proto crates out of
//! the binary, the same trade the Parquet sink made by skipping arrow.
//! Field numbers follow opentelemetry-proto v1: trace/v1/trace.proto,
//! logs/v1/logs.proto, common/v1/common.proto, resource/v1/resource.proto.

use crate::telemetry::AttrValue;
use crate::telemetry::ExceptionCode;
use crate::telemetry::Log;
use crate::telemetry::Span;
use crate::telemetry::SpanException;
use crate::telemetry::SpanStatus;

const WIRE_VARINT: u64 = 0;
const WIRE_FIXED64: u64 = 1;
const WIRE_LEN: u64 = 2;

fn varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn key(out: &mut Vec<u8>, field: u64, wire: u64) {
    varint(out, (field << 3) | wire);
}

fn field_bytes(out: &mut Vec<u8>, field: u64, bytes: &[u8]) {
    key(out, field, WIRE_LEN);
    varint(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

fn field_str(out: &mut Vec<u8>, field: u64, value: &str) {
    field_bytes(out, field, value.as_bytes());
}

fn field_varint(out: &mut Vec<u8>, field: u64, value: u64) {
    key(out, field, WIRE_VARINT);
    varint(out, value);
}

fn field_fixed64(out: &mut Vec<u8>, field: u64, value: u64) {
    key(out, field, WIRE_FIXED64);
    out.extend_from_slice(&value.to_le_bytes());
}

/// common.v1.AnyValue: string_value=1, bool_value=2, int_value=3,
/// double_value=4.
fn any_string(value: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(value.len() + 4);
    field_str(&mut out, 1, value);
    out
}

fn any_bool(value: bool) -> Vec<u8> {
    let mut out = Vec::new();
    field_varint(&mut out, 2, value as u64);
    out
}

fn any_int(value: i64) -> Vec<u8> {
    let mut out = Vec::new();
    field_varint(&mut out, 3, value as u64);
    out
}

fn any_double(value: f64) -> Vec<u8> {
    let mut out = Vec::new();
    field_fixed64(&mut out, 4, value.to_bits());
    out
}

fn any_attr(value: &AttrValue) -> Vec<u8> {
    match value {
        AttrValue::Bool(value) => any_bool(*value),
        AttrValue::Double(value) => any_double(*value),
        AttrValue::String(value) => any_string(value),
    }
}

/// common.v1.KeyValue: key=1, value=2 (AnyValue).
fn key_value(out: &mut Vec<u8>, field: u64, name: &str, value: Vec<u8>) {
    let mut kv = Vec::with_capacity(name.len() + value.len() + 8);
    field_str(&mut kv, 1, name);
    field_bytes(&mut kv, 2, &value);
    field_bytes(out, field, &kv);
}

/// resource.v1.Resource: attributes=1.
fn resource(node: &str, region: &str, service: &str) -> Vec<u8> {
    let mut out = Vec::new();
    key_value(&mut out, 1, "service.name", any_string(service));
    key_value(
        &mut out,
        1,
        "service.version",
        any_string(env!("CARGO_PKG_VERSION")),
    );
    key_value(&mut out, 1, "service.instance.id", any_string(node));
    key_value(&mut out, 1, "celld.region", any_string(region));
    out
}

/// common.v1.InstrumentationScope: name=1, version=2.
fn scope() -> Vec<u8> {
    let mut out = Vec::new();
    field_str(&mut out, 1, "celld");
    field_str(&mut out, 2, env!("CARGO_PKG_VERSION"));
    out
}

/// trace.v1.Span.
fn span_message(span: &Span) -> Vec<u8> {
    let mut out = Vec::new();
    field_bytes(&mut out, 1, &span.ids.trace_id);
    field_bytes(&mut out, 2, &span.ids.span_id);
    if let Some(parent) = span.parent_span_id {
        field_bytes(&mut out, 4, &parent);
    }
    field_str(&mut out, 5, &span.name);
    field_varint(&mut out, 6, span.kind as u64);
    let start_ns = span.start_unix_us.max(0) as u64 * 1_000;
    let end_ns = start_ns + span.duration_us.max(0) as u64 * 1_000;
    field_fixed64(&mut out, 7, start_ns);
    field_fixed64(&mut out, 8, end_ns);
    // Attributes (9): the same promoted columns the Parquet schema has,
    // under otel semantic-convention names where one exists, then the
    // Worker's. Each key appears once, and celld's own value wins.
    let runtime: [(&str, Option<Vec<u8>>); 8] = [
        ("url.full", span.url.as_deref().map(any_string)),
        (
            "http.response.status_code",
            span.http_status.map(|status| any_int(status as i64)),
        ),
        (
            "celld.request_id",
            span.request_id.as_deref().map(any_string),
        ),
        ("celld.cell", span.cell.as_deref().map(any_string)),
        ("celld.epoch", span.epoch.map(|epoch| any_int(epoch as i64))),
        (
            "celld.isolate",
            span.isolate.map(|isolate| any_int(isolate as i64)),
        ),
        ("celld.queue_wait_us", span.queue_wait_us.map(any_int)),
        ("celld.parent_remote", span.parent_remote.map(any_bool)),
    ];
    let mut emitted = Vec::new();
    for (name, value) in runtime {
        if let Some(value) = value {
            key_value(&mut out, 9, name, value);
            emitted.push(name);
        }
    }
    for (name, value) in &span.attributes {
        if !emitted.contains(&name.as_str()) {
            key_value(&mut out, 9, name, any_attr(value));
            emitted.push(name.as_str());
        }
    }
    // Events (11): each recorded exception.
    for exception in &span.exceptions {
        field_bytes(&mut out, 11, &exception_event(exception));
    }
    // Status (15): left out when unset, per the spec; OK (code=3 value 1)
    // only when a Worker set it; ERROR (value 2) with the message.
    match span.status {
        SpanStatus::Unset => {}
        SpanStatus::Ok => {
            let mut status = Vec::new();
            field_varint(&mut status, 3, 1);
            field_bytes(&mut out, 15, &status);
        }
        SpanStatus::Error => {
            let mut status = Vec::new();
            if let Some(error) = &span.error {
                field_str(&mut status, 2, error);
            }
            field_varint(&mut status, 3, 2);
            field_bytes(&mut out, 15, &status);
        }
    }
    out
}

/// trace.v1.Span.Event: time_unix_nano=1, name=2, attributes=3, under the
/// semantic conventions' `exception` event. workerd's exception also has a
/// code, which has no convention; it goes in `exception.code`.
fn exception_event(exception: &SpanException) -> Vec<u8> {
    let mut out = Vec::new();
    field_fixed64(&mut out, 1, exception.time_unix_us.max(0) as u64 * 1_000);
    field_str(&mut out, 2, "exception");
    match &exception.code {
        Some(ExceptionCode::Text(code)) => {
            key_value(&mut out, 3, "exception.code", any_string(code))
        }
        Some(ExceptionCode::Number(code)) => {
            key_value(&mut out, 3, "exception.code", any_double(*code))
        }
        None => {}
    }
    if !exception.name.is_empty() {
        key_value(&mut out, 3, "exception.type", any_string(&exception.name));
    }
    if !exception.message.is_empty() {
        key_value(
            &mut out,
            3,
            "exception.message",
            any_string(&exception.message),
        );
    }
    if let Some(stack) = &exception.stack {
        key_value(&mut out, 3, "exception.stacktrace", any_string(stack));
    }
    out
}

/// collector.v1.ExportTraceServiceRequest: resource_spans=1, holding one
/// ResourceSpans{resource=1, scope_spans=2{scope=1, spans=2}}.
pub fn traces_request(spans: &[Span], node: &str, region: &str, service: &str) -> Vec<u8> {
    let mut scope_spans = Vec::new();
    field_bytes(&mut scope_spans, 1, &scope());
    for span in spans {
        field_bytes(&mut scope_spans, 2, &span_message(span));
    }
    let mut resource_spans = Vec::new();
    field_bytes(&mut resource_spans, 1, &resource(node, region, service));
    field_bytes(&mut resource_spans, 2, &scope_spans);
    let mut out = Vec::new();
    field_bytes(&mut out, 1, &resource_spans);
    out
}

/// logs.v1.LogRecord: time=1, severity_number=2, severity_text=3, body=5,
/// trace_id=9, span_id=10, observed_time=11.
fn log_message(log: &Log) -> Vec<u8> {
    let mut out = Vec::new();
    let time_ns = log.time_unix_us.max(0) as u64 * 1_000;
    field_fixed64(&mut out, 1, time_ns);
    field_varint(&mut out, 2, log.severity.number() as u64);
    field_str(&mut out, 3, log.severity.text());
    field_bytes(&mut out, 5, &any_string(&log.body));
    if let Some(trace_id) = log.trace_id {
        field_bytes(&mut out, 9, &trace_id);
    }
    if let Some(span_id) = log.span_id {
        field_bytes(&mut out, 10, &span_id);
    }
    field_fixed64(&mut out, 11, time_ns);
    out
}

/// collector.v1.ExportLogsServiceRequest: resource_logs=1, holding one
/// ResourceLogs{resource=1, scope_logs=2{scope=1, log_records=2}}.
pub fn logs_request(logs: &[Log], node: &str, region: &str, service: &str) -> Vec<u8> {
    let mut scope_logs = Vec::new();
    field_bytes(&mut scope_logs, 1, &scope());
    for log in logs {
        field_bytes(&mut scope_logs, 2, &log_message(log));
    }
    let mut resource_logs = Vec::new();
    field_bytes(&mut resource_logs, 1, &resource(node, region, service));
    field_bytes(&mut resource_logs, 2, &scope_logs);
    let mut out = Vec::new();
    field_bytes(&mut out, 1, &resource_logs);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::TraceIds;

    /// One decoded protobuf field: its number and its varint, fixed64 or
    /// length-delimited payload.
    #[derive(Debug, PartialEq)]
    enum Field {
        Varint(u64),
        Fixed64(u64),
        Bytes(Vec<u8>),
    }

    fn read_varint(bytes: &[u8], at: &mut usize) -> u64 {
        let mut value = 0;
        for shift in (0..64).step_by(7) {
            let byte = bytes[*at];
            *at += 1;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                break;
            }
        }
        value
    }

    fn decode(bytes: &[u8]) -> Vec<(u64, Field)> {
        let mut at = 0;
        let mut out = Vec::new();
        while at < bytes.len() {
            let key = read_varint(bytes, &mut at);
            let field = match key & 7 {
                WIRE_VARINT => Field::Varint(read_varint(bytes, &mut at)),
                WIRE_FIXED64 => {
                    let value = u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
                    at += 8;
                    Field::Fixed64(value)
                }
                WIRE_LEN => {
                    let length = read_varint(bytes, &mut at) as usize;
                    let value = bytes[at..at + length].to_vec();
                    at += length;
                    Field::Bytes(value)
                }
                wire => panic!("unexpected wire type {wire}"),
            };
            out.push((key >> 3, field));
        }
        out
    }

    fn all(message: &[u8], number: u64) -> Vec<Vec<u8>> {
        decode(message)
            .into_iter()
            .filter_map(|(field, value)| match value {
                Field::Bytes(bytes) if field == number => Some(bytes),
                _ => None,
            })
            .collect()
    }

    fn one(message: &[u8], number: u64) -> Field {
        decode(message)
            .into_iter()
            .find(|(field, _)| *field == number)
            .unwrap_or_else(|| panic!("no field {number}"))
            .1
    }

    /// A KeyValue as (key, the AnyValue's field).
    fn key_value_of(bytes: &[u8]) -> (String, (u64, Field)) {
        let Field::Bytes(key) = one(bytes, 1) else {
            panic!("key")
        };
        let Field::Bytes(value) = one(bytes, 2) else {
            panic!("value")
        };
        let mut any = decode(&value);
        assert_eq!(any.len(), 1, "an AnyValue holds one value");
        (String::from_utf8(key).unwrap(), any.remove(0))
    }

    fn span() -> Span {
        Span::new(
            TraceIds {
                trace_id: [1; 16],
                span_id: [2; 8],
            },
            "custom",
            crate::telemetry::KIND_INTERNAL,
        )
    }

    /// The single span of a one-span export request.
    fn exported(span: &Span) -> Vec<u8> {
        let request = traces_request(std::slice::from_ref(span), "node", "region", "service");
        let resource_spans = &all(&request, 1)[0];
        let scope_spans = &all(resource_spans, 2)[0];
        all(scope_spans, 2).remove(0)
    }

    #[test]
    fn custom_attributes_keep_their_types() {
        let mut span = span();
        span.attributes = vec![
            ("text".into(), AttrValue::String("a".into())),
            ("number".into(), AttrValue::Double(1.5)),
            ("flag".into(), AttrValue::Bool(true)),
        ];
        let message = exported(&span);
        let Field::Bytes(name) = one(&message, 5) else {
            panic!("name")
        };
        assert_eq!(name, b"custom");
        let attributes: Vec<_> = all(&message, 9).iter().map(|kv| key_value_of(kv)).collect();
        assert_eq!(
            attributes,
            [
                ("text".to_string(), (1, Field::Bytes(b"a".to_vec()))),
                ("number".to_string(), (4, Field::Fixed64(1.5f64.to_bits()))),
                ("flag".to_string(), (2, Field::Varint(1))),
            ]
        );
    }

    #[test]
    fn exceptions_are_exception_events() {
        let mut span = span();
        span.exceptions = vec![
            SpanException {
                time_unix_us: 7,
                code: Some(ExceptionCode::Number(42.0)),
                name: "TypeError".into(),
                message: "boom".into(),
                stack: Some("at x".into()),
            },
            SpanException {
                time_unix_us: 8,
                code: Some(ExceptionCode::Text("E_CODE".into())),
                name: String::new(),
                message: String::new(),
                stack: None,
            },
        ];
        let events = all(&exported(&span), 11);
        assert_eq!(events.len(), 2);
        assert_eq!(one(&events[0], 1), Field::Fixed64(7_000));
        assert_eq!(one(&events[0], 2), Field::Bytes(b"exception".to_vec()));
        let attributes: Vec<_> = all(&events[0], 3)
            .iter()
            .map(|kv| key_value_of(kv))
            .collect();
        assert_eq!(
            attributes,
            [
                (
                    "exception.code".to_string(),
                    (4, Field::Fixed64(42f64.to_bits()))
                ),
                (
                    "exception.type".to_string(),
                    (1, Field::Bytes(b"TypeError".to_vec()))
                ),
                (
                    "exception.message".to_string(),
                    (1, Field::Bytes(b"boom".to_vec()))
                ),
                (
                    "exception.stacktrace".to_string(),
                    (1, Field::Bytes(b"at x".to_vec()))
                ),
            ]
        );
        // An empty name or message is left out, not sent empty.
        let attributes: Vec<_> = all(&events[1], 3)
            .iter()
            .map(|kv| key_value_of(kv))
            .collect();
        assert_eq!(
            attributes,
            [(
                "exception.code".to_string(),
                (1, Field::Bytes(b"E_CODE".to_vec()))
            )]
        );
    }

    #[test]
    fn status_is_unset_ok_or_error_with_its_message() {
        let mut span = span();
        assert!(all(&exported(&span), 15).is_empty());

        span.status = SpanStatus::Ok;
        let status = all(&exported(&span), 15).remove(0);
        assert_eq!(decode(&status), [(3, Field::Varint(1))]);

        span.set_outcome(false, Some("failed".into()));
        let status = all(&exported(&span), 15).remove(0);
        assert_eq!(
            decode(&status),
            [(2, Field::Bytes(b"failed".to_vec())), (3, Field::Varint(2))]
        );
    }

    #[test]
    fn each_key_is_sent_once_and_celld_s_own_wins() {
        let mut span = span();
        span.url = Some("https://celld.test/".into());
        span.attributes = vec![
            ("url.full".into(), AttrValue::String("spoofed".into())),
            ("k".into(), AttrValue::Bool(true)),
            ("k".into(), AttrValue::Bool(false)),
        ];
        let attributes: Vec<_> = all(&exported(&span), 9)
            .iter()
            .map(|kv| key_value_of(kv))
            .collect();
        assert_eq!(
            attributes,
            [
                (
                    "url.full".to_string(),
                    (1, Field::Bytes(b"https://celld.test/".to_vec()))
                ),
                ("k".to_string(), (2, Field::Varint(1))),
            ]
        );
    }

    #[test]
    fn a_child_carries_its_parent_id() {
        let mut span = span();
        assert!(all(&exported(&span), 4).is_empty());
        span.parent_span_id = Some([3; 8]);
        let message = exported(&span);
        assert_eq!(one(&message, 1), Field::Bytes(vec![1; 16]));
        assert_eq!(one(&message, 2), Field::Bytes(vec![2; 8]));
        assert_eq!(one(&message, 4), Field::Bytes(vec![3; 8]));
    }
}
