// atob / btoa.
// Own IIFE: captures the host ops it needs, attaches to
// globalThis, exits. The $$-prefixed host ops stay defined
// for the life of the isolate -- non-enumerable (see the ops
// macro in js.rs), not removed. DOMException is installed
// later, by harness.js, and is only referenced at call time.
(function () {
    // The host op does the whole WHATWG forgiving-base64 decode, including
    // ASCII whitespace removal, so this wrapper only does what Web IDL asks
    // for: argument-count and DOMString conversion, and the DOMException
    // re-wrap the op cannot build (the op throws a plain Error).
    //
    // Both wrappers are method shorthands rather than arrow functions for
    // two reasons an arrow cannot satisfy: an arrow has no `arguments`, so
    // it cannot tell `atob()` from `atob(undefined)`, and an arrow's `name`
    // would be the empty string instead of "atob". A function declaration
    // would fix the name but is constructible, and Workerd's `atob` is not.
    const _atob = $$atob;
    const _btoa = $$btoa;
    const _jsg = __celld.__jsg;

    globalThis.atob = {
        atob(s) {
            // Web IDL: a missing argument for a required parameter is a
            // TypeError, while an explicit `undefined` converts to the string
            // "undefined" and fails later as invalid base64. workerd names
            // atob's parameter a 'string' and btoa's a 'String' (its C++
            // types, kj::String and jsg::JsString).
            if (arguments.length === 0) {
                throw _jsg.execute("atob", "ServiceWorkerGlobalScope", 1, "string");
            }
            // Template ToString, not String(): String(Symbol()) returns
            // "Symbol()" and would decode as base64, while Web IDL DOMString
            // conversion must throw a TypeError for a Symbol.
            s = `${s}`;
            try {
                return _atob(s);
            } catch {
                // workerd's text (global-scope.c++ `atob`), which gives no
                // reason.
                throw new DOMException(
                    "atob() called with invalid base64-encoded data. (Only " +
                    "whitespace, '+', '/', alphanumeric ASCII, and up to two " +
                    "terminal '=' signs when the input data length is " +
                    "divisible by 4 are allowed.)",
                    "InvalidCharacterError",
                );
            }
        },
    }.atob;

    globalThis.btoa = {
        btoa(s) {
            if (arguments.length === 0) {
                throw _jsg.execute("btoa", "ServiceWorkerGlobalScope", 1, "String");
            }
            s = `${s}`;
            for (let i = 0; i < s.length; i++) {
                if (s.charCodeAt(i) > 0xff) {
                    throw new DOMException(
                        "btoa() can only operate on characters in the Latin1 " +
                        "(ISO/IEC 8859-1) range.",
                        "InvalidCharacterError",
                    );
                }
            }
            return _btoa(s);
        },
    }.btoa;
})();
