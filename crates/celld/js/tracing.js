// The Workers custom-spans API: `tracing` from `cloudflare:workers`, and
// `ctx.tracing` on an ExecutionContext. It follows workerd's
// src/workerd/api/tracing.c++ at v1.20261001.1: the same classes, argument
// conversion, error messages and span lifecycle.
//
// A span is traced only when the request is: with telemetry on (CELLD_OTEL)
// and the request sampled. Otherwise every span reports isTraced = false and
// its methods only convert their arguments, as on an unsampled Cloudflare
// request. A traced span's data lives on the host (span_ops.rs,
// user_spans.rs), which works on the invocation of the context running the
// code, whatever this script passes it.
//
// A span belongs to the request that made it. Used from another request, its
// methods throw workerd's I/O error, as its state is request-owned there. A
// span made at module scope belongs to no request.
//
// The active span rides the async-context frame, so it follows awaits as an
// AsyncLocalStorage store does. enterSpan and startActiveSpan also install
// the span's trace context for the callback, so the console lines, fetch()
// calls, Durable Object fetch() calls and spans it makes are its children.
//
// Worker code runs after this script and can replace any global or prototype
// method, so everything called after load is captured here first. Runtime
// paths avoid the iteration protocol and prototype lookups on their own
// arrays and descriptors for the same reason.
(function () {
  const ReflectApply = Reflect.apply;
  const ObjectKeys = Object.keys;
  const ObjectDefineProperty = Object.defineProperty;
  const ObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
  const ArrayIsArray = Array.isArray;
  const SafeMap = Map;
  const MapPrototypeGet = Map.prototype.get;
  const MapPrototypeSet = Map.prototype.set;
  const MapPrototypeDelete = Map.prototype.delete;
  const MapPrototypeForEach = Map.prototype.forEach;
  const SafePromise = Promise;
  const PromisePrototypeThen = Promise.prototype.then;
  const SafeWeakRef = WeakRef;
  const WeakRefPrototypeDeref = WeakRef.prototype.deref;
  const SafeFinalizationRegistry = FinalizationRegistry;
  const FinalizationRegistryPrototypeRegister = FinalizationRegistry.prototype.register;
  const SafeTypeError = TypeError;
  const SafeError = Error;
  const SafeSymbol = Symbol;
  const SymbolToStringTag = Symbol.toStringTag;
  const globalObject = globalThis;

  const mapGet = (map, key) => ReflectApply(MapPrototypeGet, map, [key]);
  const mapSet = (map, key, value) => ReflectApply(MapPrototypeSet, map, [key, value]);

  const kCreate = SafeSymbol("celld.tracing.create");
  const kActiveSpan = SafeSymbol("celld.tracing.activeSpan");
  // __span_update kinds, as span_ops.rs numbers them.
  const UPDATE_QUERY = 0;
  const UPDATE_ATTRIBUTE = 1;
  const UPDATE_NAME = 2;
  const UPDATE_STATUS = 3;
  const UPDATE_EXCEPTION = 4;
  const STATUS_CODES = { __proto__: null, unset: 0, ok: 1, error: 2 };
  const STATUS_ERROR = STATUS_CODES.error;
  // The `promise` bit of __util_type_flags (op_util_type_flags in js.rs).
  const IS_PROMISE = 1 << 13;

  const illegalInvocation = () => new SafeTypeError(
    "Illegal invocation: function called with incorrect `this` reference. " +
    "See https://developers.cloudflare.com/workers/observability/errors/" +
    "#illegal-invocation-errors for details.");
  const badParameter = (method, type, index, expected) => new SafeTypeError(
    `Failed to execute '${method}' on '${type}': parameter ${index} is not ` +
    `of type '${expected}'.`);
  // workerd's IoOwn error for state owned by another request.
  const foreignRequest = () => new SafeError(
    "Cannot perform I/O on behalf of a different request. I/O objects (such " +
    "as streams, request/response bodies, and others) created in the context " +
    "of one request handler cannot be accessed from a different request's " +
    "handler. This is a limitation of Cloudflare Workers which allows us to " +
    "improve overall performance. (I/O type: SpanState)");
  // workerd's string conversion is ToString, which throws for a Symbol.
  const toStr = (value) => `${value}`;
  // A tag value is bool | double | string. Booleans and numbers keep their
  // type; a BigInt fails the numeric conversion; anything else becomes a
  // string.
  const toTagValue = (value) => {
    if (typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "bigint") return +value;
    return toStr(value);
  };
  // An exception code is string | double.
  const toCode = (value) => {
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return +value;
    return toStr(value);
  };
  const isObject = (value) =>
    (typeof value === "object" && value !== null) || typeof value === "function";
  const isPromise = (value) =>
    isObject(value) && (__util_type_flags(value) & IS_PROMISE) !== 0;
  const activeSpan = () => {
    const frame = __als_get();
    return frame === undefined ? undefined : mapGet(frame, kActiveSpan);
  };
  // Defined, not assigned, so a setter on Array.prototype sees nothing.
  const defineIndex = (array, index, value) => ObjectDefineProperty(array, index, {
    __proto__: null, value, writable: true, enumerable: true, configurable: true,
  });

  // workerd's JSG classes put methods on the prototype as enumerable data
  // properties, `constructor` last, with a writable Symbol.toStringTag. Runs
  // at load, before any Worker code.
  const shapePrototype = (cls, tag) => {
    const proto = cls.prototype;
    for (const name of ObjectGetOwnPropertyNames(proto)) {
      if (name !== "constructor") {
        ObjectDefineProperty(proto, name, { enumerable: true });
      }
    }
    delete proto.constructor;
    ObjectDefineProperty(proto, "constructor", {
      value: cls, writable: true, enumerable: false, configurable: true,
    });
    ObjectDefineProperty(proto, SymbolToStringTag, {
      value: tag, writable: true, enumerable: false, configurable: true,
    });
  };

  let newSpan;
  let spanRider;
  let endSpan;

  class Span {
    // The span's trace context on the host; undefined for an untraced span.
    #rider;
    #ended = false;
    // The invocation's own span: the runtime ends it, not end().
    #invocation;
    // The request this span belongs to; undefined for one made at module
    // scope.
    #owner;

    constructor(...args) {
      if (args[0] !== kCreate) throw new SafeTypeError("Illegal constructor");
      this.#rider = args[1];
      this.#invocation = args[2];
      this.#owner = args[3];
    }

    static {
      newSpan = (rider, invocation, owner) => new Span(kCreate, rider, invocation, owner);
      spanRider = (span) => span.#rider;
      endSpan = (span) => span.#settle();
    }

    static #check(span) {
      if (!isObject(span) || !(#rider in span)) throw illegalInvocation();
    }

    // Where workerd reaches the span's request-owned state.
    #own() {
      if (this.#owner !== undefined && this.#owner !== __span_owner()) {
        throw foreignRequest();
      }
    }

    // Apply an update on the host while the span is traced; answers whether
    // it is.
    #update(kind, a, b, c, d) {
      this.#own();
      if (this.#ended) return false;
      if (this.#invocation) return __span_update(undefined, kind, a, b, c, d);
      if (this.#rider === undefined) return false;
      return __span_update(this.#rider, kind, a, b, c, d);
    }

    #end() {
      this.#own();
      this.#settle();
    }

    // enterSpan's automatic end, which never throws: the promise it waits on
    // can settle in another request's turn, where the span is not that
    // request's. The host ends only a span of the invocation running the
    // code, so from another request this ends nothing, and the span's own
    // invocation records it when it ends.
    #settle() {
      if (this.#invocation || this.#ended) return;
      this.#ended = true;
      if (this.#rider !== undefined) __span_end(this.#rider);
    }

    get isTraced() {
      Span.#check(this);
      return this.#update(UPDATE_QUERY);
    }

    setAttribute(...args) {
      Span.#check(this);
      if (args.length < 1) throw badParameter("setAttribute", "Span", 1, "string");
      const key = toStr(args[0]);
      if (args[1] === undefined) {
        this.#own();
      } else {
        this.#update(UPDATE_ATTRIBUTE, key, toTagValue(args[1]));
      }
      return this;
    }

    setAttributes(...args) {
      Span.#check(this);
      const attributes = args[0];
      if (!isObject(attributes) || ArrayIsArray(attributes)) {
        throw badParameter("setAttributes", "Span", 1, "object");
      }
      // Every value converts before any is set, as the binding converts the
      // whole dictionary first.
      const names = ObjectKeys(attributes);
      const keys = { __proto__: null };
      const values = { __proto__: null };
      let count = 0;
      for (let index = 0; index < names.length; index++) {
        const key = names[index];
        const value = attributes[key];
        if (value !== undefined) {
          keys[count] = key;
          values[count] = toTagValue(value);
          count++;
        }
      }
      for (let index = 0; index < count; index++) {
        this.#update(UPDATE_ATTRIBUTE, keys[index], values[index]);
      }
      return this;
    }

    recordException(...args) {
      Span.#check(this);
      if (args.length < 1) throw badParameter("recordException", "Span", 1, "Value");
      // workerd returns before it reads the exception of an untraced span.
      if (!this.#update(UPDATE_QUERY)) return;
      const exception = args[0];
      let code;
      let name = "";
      let message = "";
      let stack;
      if (typeof exception === "string") {
        message = exception;
      } else if (isObject(exception)) {
        // ExceptionData's fields, read and converted in declaration order.
        const rawCode = exception.code;
        code = rawCode === undefined ? undefined : toCode(rawCode);
        const rawName = exception.name;
        const hasName = rawName !== undefined;
        if (hasName) name = toStr(rawName);
        const rawMessage = exception.message;
        const hasMessage = rawMessage !== undefined;
        if (hasMessage) message = toStr(rawMessage);
        const rawStack = exception.stack;
        if (rawStack !== undefined) stack = toStr(rawStack);
        // The OpenTelemetry exception needs a code, a name or a message.
        if (code === undefined && !hasName && !hasMessage) return;
      } else {
        return;
      }
      this.#update(UPDATE_EXCEPTION, code, name, message, stack);
    }

    updateName(...args) {
      Span.#check(this);
      if (args.length < 1) throw badParameter("updateName", "Span", 1, "string");
      this.#update(UPDATE_NAME, toStr(args[0]));
      return this;
    }

    setStatus(...args) {
      Span.#check(this);
      if (args.length < 1) {
        throw badParameter("setStatus", "Span", 1, "TracingSpanStatus");
      }
      const status = args[0];
      if (status === undefined || status === null) {
        // workerd's message names the C++ struct, mangled.
        throw new SafeTypeError(
          "Cannot initialize N7workerd3api12user_tracing17TracingSpanStatusE " +
          "with required members from an undefined or null value.");
      }
      if (!isObject(status)) {
        throw badParameter("setStatus", "Span", 1, "TracingSpanStatus");
      }
      const code = STATUS_CODES[toStr(status.code)];
      const rawMessage = status.message;
      const message = rawMessage === undefined ? undefined : toStr(rawMessage);
      if (code === undefined) {
        throw new SafeTypeError("Span status code must be 'unset', 'ok', or 'error'.");
      }
      this.#update(UPDATE_STATUS, code, code === STATUS_ERROR ? message : undefined);
      return this;
    }

    end() {
      Span.#check(this);
      this.#end();
    }
  }
  shapePrototype(Span, "Span");

  // A new span, child of the active span, or of the invocation's span when
  // none is active. Untraced outside a traced invocation, or when its parent
  // is.
  const createSpan = (name) => {
    const owner = __span_owner();
    let rider;
    if (owner !== undefined) {
      const active = activeSpan();
      if (active === undefined) {
        rider = __span_start(undefined, name);
      } else {
        const parent = spanRider(active);
        if (parent !== undefined) rider = __span_start(parent, name);
      }
    }
    return newSpan(rider, false, owner);
  };

  // Run `fn` with `span` active: in the async-context frame for
  // getActiveSpan, and as the trace context the host reads.
  const withActiveSpan = (span, fn) => {
    const prior = __als_get();
    const frame = new SafeMap();
    if (prior !== undefined) {
      ReflectApply(MapPrototypeForEach, prior, [(value, key) => mapSet(frame, key, value)]);
    }
    mapSet(frame, kActiveSpan, span);
    __als_set(frame);
    try {
      const rider = spanRider(span);
      return rider === undefined ? fn() : __span_enter(rider, fn);
    } finally {
      __als_set(prior);
    }
  };

  // enterSpan ends the span when the callback returns or throws, or when the
  // promise it returns settles; it returns a new promise for that, as
  // workerd does. startActiveSpan leaves the ending to the caller.
  const runSpan = (method, args, autoEnd) => {
    if (args.length < 1) throw badParameter(method, "Tracing", 1, "string");
    const name = toStr(args[0]);
    const callback = args[1];
    if (typeof callback !== "function") {
      throw badParameter(method, "Tracing", 2, "Function");
    }
    const span = createSpan(name);
    const callbackArgs = [];
    defineIndex(callbackArgs, 0, span);
    for (let index = 2; index < args.length; index++) {
      defineIndex(callbackArgs, index - 1, args[index]);
    }
    return withActiveSpan(span, () => {
      let result;
      try {
        result = ReflectApply(callback, globalObject, callbackArgs);
      } catch (error) {
        if (autoEnd) endSpan(span);
        throw error;
      }
      if (!autoEnd) return result;
      if (!isPromise(result)) {
        endSpan(span);
        return result;
      }
      return new SafePromise((resolve, reject) => {
        ReflectApply(PromisePrototypeThen, result, [
          (value) => {
            try {
              endSpan(span);
            } finally {
              resolve(value);
            }
          },
          (error) => {
            try {
              endSpan(span);
            } finally {
              reject(error);
            }
          },
        ]);
      });
    });
  };

  // The invocation's span, as getActiveSpan returns it outside any custom
  // span: one object per request, for as long as anything holds it.
  const invocationSpans = new SafeMap();
  const forgetInvocationSpan = new SafeFinalizationRegistry((owner) => {
    const held = mapGet(invocationSpans, owner);
    if (held !== undefined && ReflectApply(WeakRefPrototypeDeref, held, []) === undefined) {
      ReflectApply(MapPrototypeDelete, invocationSpans, [owner]);
    }
  });
  const invocationSpan = (owner) => {
    const held = mapGet(invocationSpans, owner);
    let span = held === undefined ? undefined : ReflectApply(WeakRefPrototypeDeref, held, []);
    if (span === undefined) {
      span = newSpan(undefined, true, owner);
      mapSet(invocationSpans, owner, new SafeWeakRef(span));
      ReflectApply(FinalizationRegistryPrototypeRegister, forgetInvocationSpan, [span, owner]);
    }
    return span;
  };

  class Tracing {
    #brand;

    constructor(...args) {
      if (args[0] !== kCreate) throw new SafeTypeError("Illegal constructor");
      this.#brand = true;
    }

    static #check(tracing) {
      if (!isObject(tracing) || !(#brand in tracing)) throw illegalInvocation();
    }

    enterSpan(...args) {
      Tracing.#check(this);
      return runSpan("enterSpan", args, true);
    }

    startActiveSpan(...args) {
      Tracing.#check(this);
      return runSpan("startActiveSpan", args, false);
    }

    startSpan(...args) {
      Tracing.#check(this);
      if (args.length < 1) throw badParameter("startSpan", "Tracing", 1, "string");
      return createSpan(toStr(args[0]));
    }

    // The active custom span; else the invocation's span inside an
    // invocation; else undefined, as at module scope.
    getActiveSpan() {
      Tracing.#check(this);
      const active = activeSpan();
      if (active !== undefined) return active;
      const owner = __span_owner();
      return owner === undefined ? undefined : invocationSpan(owner);
    }
  }
  ObjectDefineProperty(Tracing.prototype, "Span", {
    value: Span, writable: true, enumerable: true, configurable: true,
  });
  shapePrototype(Tracing, "Tracing");

  __celld.__cf.tracing = new Tracing(kCreate);
  // Each ExecutionContext has its own Tracing, made on first read, as
  // workerd's JSG_LAZY_INSTANCE_PROPERTY makes it.
  const newTracing = () => new Tracing(kCreate);
  __celld.__defineContextTracing = (ctx) => __lazy_data_property(ctx, "tracing", newTracing);
})();
