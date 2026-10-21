// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! The V8 surface over `crate::user_spans`, for the `tracing` API in
//! `tracing.js`.
//!
//! Every op works on the invocation of the context running the code, which
//! the host chose; a rider the harness passes only names a span within it.
//! The harness converts each argument the way workerd's bindings do before it
//! calls an op, so an op receives only the shapes `parse_update` accepts;
//! anything else is a harness bug and throws. These ops are harness-internal:
//! user code cannot name them.
use super::*;
use crate::telemetry::AttrValue;
use crate::telemetry::ExceptionCode;
use crate::telemetry::SpanStatus;
use crate::user_spans::Invocation;
use crate::user_spans::TraceRider;
use crate::user_spans::Update;

const UPDATE_QUERY: i32 = 0;
const UPDATE_ATTRIBUTE: i32 = 1;
const UPDATE_NAME: i32 = 2;
const UPDATE_STATUS: i32 = 3;
const UPDATE_EXCEPTION: i32 = 4;

/// An op argument, as far as span ops look at one.
#[derive(Clone, Debug, PartialEq)]
enum Arg {
    Undefined,
    Bool(bool),
    Number(f64),
    Text(String),
    Other,
}

fn arg(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Arg {
    if value.is_undefined() {
        Arg::Undefined
    } else if value.is_boolean() {
        Arg::Bool(value.boolean_value(scope))
    } else if value.is_number() {
        Arg::Number(value.number_value(scope).unwrap_or(f64::NAN))
    } else if value.is_string() {
        Arg::Text(value.to_rust_string_lossy(scope))
    } else {
        Arg::Other
    }
}

fn text(arg: Arg) -> Result<String, &'static str> {
    match arg {
        Arg::Text(text) => Ok(text),
        _ => Err("tracing: expected a string"),
    }
}

fn optional_text(arg: Arg) -> Result<Option<String>, &'static str> {
    match arg {
        Arg::Undefined => Ok(None),
        arg => text(arg).map(Some),
    }
}

/// The update one `__span_update` call asks for: `None` only asks whether the
/// span is traced.
fn parse_update(kind: Option<i32>, [a, b, c, d]: [Arg; 4]) -> Result<Option<Update>, &'static str> {
    Ok(match kind {
        Some(UPDATE_QUERY) => None,
        Some(UPDATE_ATTRIBUTE) => {
            let value = match b {
                Arg::Bool(value) => AttrValue::Bool(value),
                Arg::Number(value) => AttrValue::Double(value),
                Arg::Text(value) => AttrValue::String(value),
                _ => return Err("tracing: an attribute is a boolean, number or string"),
            };
            Some(Update::Attribute(text(a)?, value))
        }
        Some(UPDATE_NAME) => Some(Update::Name(text(a)?)),
        Some(UPDATE_STATUS) => {
            let code = match a {
                Arg::Number(0.0) => SpanStatus::Unset,
                Arg::Number(1.0) => SpanStatus::Ok,
                Arg::Number(2.0) => SpanStatus::Error,
                _ => return Err("tracing: unknown status code"),
            };
            Some(Update::Status(code, optional_text(b)?))
        }
        Some(UPDATE_EXCEPTION) => {
            let code = match a {
                Arg::Undefined => None,
                Arg::Number(code) => Some(ExceptionCode::Number(code)),
                Arg::Text(code) => Some(ExceptionCode::Text(code)),
                _ => return Err("tracing: an exception code is a number or string"),
            };
            Some(Update::Exception {
                code,
                name: text(b)?,
                message: text(c)?,
                stack: optional_text(d)?,
            })
        }
        _ => return Err("tracing: unknown span update"),
    })
}

fn throw_internal(scope: &mut v8::PinScope, message: &str) {
    let message = v8::String::new(scope, message).unwrap();
    let exception = v8::Exception::type_error(scope, message);
    scope.throw_exception(exception);
}

/// A span argument: undefined for the invocation span, else a rider.
fn span_arg(
    scope: &mut v8::PinScope,
    value: v8::Local<v8::Value>,
) -> Result<Option<TraceRider>, ()> {
    if value.is_undefined() {
        return Ok(None);
    }
    match trace_rider(value) {
        Some(rider) => Ok(Some(rider)),
        None => {
            throw_internal(scope, "tracing: not a span context");
            Err(())
        }
    }
}

/// The traced invocation of the context running this code.
fn current_invocation(scope: &mut v8::PinScope) -> Option<Arc<Invocation>> {
    reaction_or_current_context(scope)?.user_spans().cloned()
}

/// `__span_owner()`: the identity of the invocation running this code, which
/// a Span records and checks; undefined outside an invocation, as at module
/// scope.
pub(super) fn op_span_owner(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Some(context) =
        reaction_or_current_context(scope).filter(|context| context.accepts_wait_until())
    else {
        return;
    };
    rv.set(v8::Number::new(scope, context.identity() as f64).into());
}

/// `__span_start(parent, name)`: a custom span's rider, or undefined when the
/// span is untraced. An undefined parent is the invocation span.
pub(super) fn op_span_start(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Ok(parent) = span_arg(scope, args.get(0)) else {
        return;
    };
    let name = match text(arg(scope, args.get(1))) {
        Ok(name) => name,
        Err(error) => return throw_internal(scope, error),
    };
    let Some(invocation) = current_invocation(scope) else {
        return;
    };
    let now = crate::telemetry::now_unix_us();
    let Some(rider) = invocation.start(parent.as_ref(), name, now) else {
        return;
    };
    if let Some(buffer) = trace_rider_buffer(scope, &rider) {
        rv.set(buffer.into());
    }
}

/// `__span_enter(rider, callback)`: call `callback` with `rider` as the trace
/// context, so what it starts, logs or sends is the span's child. V8 restores
/// the slot for each continuation the callback schedules; the previous slot
/// is back for whatever follows the call, even when the callback throws.
pub(super) fn op_span_enter(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let rider = args.get(0);
    if trace_rider(rider).is_none() {
        return throw_internal(scope, "tracing: not a span context");
    }
    let Ok(callback) = v8::Local::<v8::Function>::try_from(args.get(1)) else {
        return throw_internal(scope, "tracing: expected a function");
    };
    let previous = scope.get_continuation_preserved_embedder_data();
    let frame = cped_frame(scope);
    let io_context = cped_io_context(scope);
    set_cped(scope, frame, rider, io_context);
    let receiver = v8::undefined(scope).into();
    let result = callback.call(scope, receiver, &[]);
    scope.set_continuation_preserved_embedder_data(previous);
    if let Some(result) = result {
        rv.set(result);
    }
}

/// `__span_update(span, kind, a, b, c, d)`: apply one `Span` method to a
/// traced span of the current invocation. Answers whether the span is still
/// traced, which is all the query kind does.
pub(super) fn op_span_update(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Ok(span) = span_arg(scope, args.get(0)) else {
        return;
    };
    let kind = args.get(1).int32_value(scope);
    let values = [2, 3, 4, 5].map(|index| arg(scope, args.get(index)));
    let update = match parse_update(kind, values) {
        Ok(update) => update,
        Err(error) => return throw_internal(scope, error),
    };
    let traced = current_invocation(scope).is_some_and(|invocation| {
        invocation.update(span.as_ref(), update, crate::telemetry::now_unix_us())
    });
    rv.set(v8::Boolean::new(scope, traced).into());
}

/// `__span_end(rider)`: end a custom span and queue it for export.
pub(super) fn op_span_end(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let Ok(Some(rider)) = span_arg(scope, args.get(0)) else {
        return;
    };
    let Some(invocation) = current_invocation(scope) else {
        return;
    };
    if let Some(span) = invocation.end(&rider, crate::telemetry::now_unix_us()) {
        crate::telemetry::record(span);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_arg(value: &str) -> Arg {
        Arg::Text(value.to_string())
    }

    const NONE: [Arg; 4] = [
        Arg::Undefined,
        Arg::Undefined,
        Arg::Undefined,
        Arg::Undefined,
    ];

    #[test]
    fn each_kind_takes_its_converted_arguments() {
        assert_eq!(parse_update(Some(UPDATE_QUERY), NONE), Ok(None));
        for (value, expected) in [
            (Arg::Bool(true), AttrValue::Bool(true)),
            (Arg::Number(1.5), AttrValue::Double(1.5)),
            (text_arg("v"), AttrValue::String("v".into())),
        ] {
            assert_eq!(
                parse_update(
                    Some(UPDATE_ATTRIBUTE),
                    [text_arg("k"), value, Arg::Undefined, Arg::Undefined]
                ),
                Ok(Some(Update::Attribute("k".into(), expected)))
            );
        }
        assert_eq!(
            parse_update(
                Some(UPDATE_NAME),
                [
                    text_arg("n"),
                    Arg::Undefined,
                    Arg::Undefined,
                    Arg::Undefined
                ]
            ),
            Ok(Some(Update::Name("n".into())))
        );
        assert_eq!(
            parse_update(
                Some(UPDATE_STATUS),
                [
                    Arg::Number(2.0),
                    text_arg("m"),
                    Arg::Undefined,
                    Arg::Undefined
                ]
            ),
            Ok(Some(Update::Status(SpanStatus::Error, Some("m".into()))))
        );
        assert_eq!(
            parse_update(
                Some(UPDATE_STATUS),
                [
                    Arg::Number(1.0),
                    Arg::Undefined,
                    Arg::Undefined,
                    Arg::Undefined
                ]
            ),
            Ok(Some(Update::Status(SpanStatus::Ok, None)))
        );
        assert_eq!(
            parse_update(
                Some(UPDATE_EXCEPTION),
                [
                    Arg::Number(42.0),
                    text_arg("E"),
                    text_arg("m"),
                    Arg::Undefined
                ]
            ),
            Ok(Some(Update::Exception {
                code: Some(ExceptionCode::Number(42.0)),
                name: "E".into(),
                message: "m".into(),
                stack: None,
            }))
        );
    }

    #[test]
    fn anything_else_is_refused() {
        let refused = [
            (None, NONE),
            (Some(5), NONE),
            (Some(-1), NONE),
            // An attribute needs a string key and a tag value.
            (
                Some(UPDATE_ATTRIBUTE),
                [
                    Arg::Number(1.0),
                    Arg::Bool(true),
                    Arg::Undefined,
                    Arg::Undefined,
                ],
            ),
            (
                Some(UPDATE_ATTRIBUTE),
                [
                    text_arg("k"),
                    Arg::Undefined,
                    Arg::Undefined,
                    Arg::Undefined,
                ],
            ),
            (
                Some(UPDATE_ATTRIBUTE),
                [text_arg("k"), Arg::Other, Arg::Undefined, Arg::Undefined],
            ),
            (
                Some(UPDATE_NAME),
                [Arg::Other, Arg::Undefined, Arg::Undefined, Arg::Undefined],
            ),
            // A status code is 0, 1 or 2, and its message a string.
            (
                Some(UPDATE_STATUS),
                [
                    Arg::Number(3.0),
                    Arg::Undefined,
                    Arg::Undefined,
                    Arg::Undefined,
                ],
            ),
            (
                Some(UPDATE_STATUS),
                [
                    text_arg("ok"),
                    Arg::Undefined,
                    Arg::Undefined,
                    Arg::Undefined,
                ],
            ),
            (
                Some(UPDATE_STATUS),
                [
                    Arg::Number(2.0),
                    Arg::Number(5.0),
                    Arg::Undefined,
                    Arg::Undefined,
                ],
            ),
            // An exception's code is a number or string; name and message strings.
            (
                Some(UPDATE_EXCEPTION),
                [
                    Arg::Bool(true),
                    text_arg("E"),
                    text_arg("m"),
                    Arg::Undefined,
                ],
            ),
            (
                Some(UPDATE_EXCEPTION),
                [
                    Arg::Undefined,
                    Arg::Undefined,
                    text_arg("m"),
                    Arg::Undefined,
                ],
            ),
            (
                Some(UPDATE_EXCEPTION),
                [
                    Arg::Undefined,
                    text_arg("E"),
                    text_arg("m"),
                    Arg::Number(1.0),
                ],
            ),
        ];
        for (kind, args) in refused {
            let described = format!("{kind:?} {args:?}");
            assert!(
                parse_update(kind, args).is_err(),
                "{described} was accepted"
            );
        }
    }
}
