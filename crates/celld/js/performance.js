// The Performance API and node:perf_hooks, as workerd v1.20261001.1 has them
// (src/workerd/api/performance.h and .c++, src/node/perf_hooks.ts).
//
// `performance` is always there: `timeOrigin` (0) and `now()`, which returns
// what `Date.now()` does, the time of the current I/O turn. With
// enable_global_performance_classes or enable_nodejs_perf_hooks_module,
// Performance is an EventTarget with the user-timing methods, and the
// PerformanceEntry classes are globals; with enable_nodejs_perf_hooks_module
// alone it also has workerd's Node.js stubs (`nodeTiming`,
// `eventLoopUtilization()`, `markResourceTiming()`, `timerify()`). Nothing is
// measured: marks and measures are only recorded, an observer never hears of
// one, and EventCounts is always empty, as in workerd.
//
// Compiled lazily: as a LAZY_GLOBALS entry (the first read of `performance`
// or one of the classes) and as the LAZY_MODULES source for node:perf_hooks.
// The script is self-guarded on `__performanceApi`, as both seams can run it.
// It runs after the Worker's code could have replaced the globals, so it uses
// the intrinsics the harness captured, and the objects it hands out are made
// from the prototypes it holds, whatever a script later puts in their place.
if (!__celld.__performanceApi) (() => {
  "use strict";
  const {
    ReflectConstruct, ObjectCreate, ObjectDefineProperty, ObjectFreeze,
    ObjectSetPrototypeOf, ArrayIsArray, IteratorPrototype, ObjectPrototype, TypeError,
    Error, SymbolIterator,
  } = __celld.__intrinsics;
  const compat = __celld.__cell.compat;
  const hooks = compat.nodejsPerfHooksModule;
  const classes = compat.globalPerformanceClasses || hooks;
  const ioNow = __celld.__ioNow;
  const illegal = __celld.__illegalInvocation;
  const struct = __celld.__struct;

  // JSG's conversions and their errors (jsg/value.h, jsg/struct.h).
  const execute = (method, owner, index, type) => new TypeError(
    `Failed to execute '${method}' on '${owner}': parameter ${index} is not ` +
    `of type '${type}'.`);
  const construct = (owner, index, type) => new TypeError(
    `Failed to construct '${owner}': constructor parameter ${index} is not ` +
    `of type '${type}'.`);
  const field = (name, owner, type) => new TypeError(
    `Incorrect type for the '${name}' field on '${owner}': the provided ` +
    `value is not of type '${type}'.`);
  const isObject = (value) =>
    (typeof value === "object" && value !== null) || typeof value === "function";
  // A required parameter is refused when the call leaves it out (`given`
  // false), and an undefined one given explicitly is converted: a string
  // parameter is then "undefined". An optional one is absent when undefined.
  const string = (given, value, error) => {
    if (!given) throw error();
    return `${value}`;
  };
  const optionalString = (value) => value === undefined ? undefined : `${value}`;
  const unsigned = (given, value, error) => {
    if (!given) throw error();
    const number = +value;
    if (number !== number || number === Infinity || number === -Infinity)
      throw new TypeError("The value cannot be converted because it is not an integer.");
    if (number < 0)
      throw new TypeError("The value cannot be converted because it is " +
        "negative and this API expects a positive number.");
    if (number > 4294967295)
      throw new TypeError("Value out of range. Must be less than or equal to 4294967295.");
    return number;
  };
  // A dictionary: undefined and null are empty, any other primitive is
  // refused, and the members are read in their declared order.
  const dictionary = (value, error, read) => {
    if (value === undefined || value === null) return read(undefined);
    if (!isObject(value)) throw error();
    return read(value);
  };
  const member = (value, name) => value === undefined ? undefined : value[name];
  const detailOf = (value, owner) => {
    const detail = member(value, "detail");
    if (detail !== undefined && !isObject(detail))
      throw field("detail", owner, "Object");
    return detail;
  };
  const numberOf = (value, name) => {
    const raw = member(value, name);
    return raw === undefined ? undefined : +raw;
  };

  // A method as JSG defines one: enumerable, with a length of 0.
  const methods = (target, list) => {
    for (let i = 0; i < list.length; i++) {
      const fn = list[i];
      ObjectDefineProperty(fn, "length", { __proto__: null, value: 0 });
      ObjectDefineProperty(target, fn.name, {
        __proto__: null, value: fn, writable: true, enumerable: true,
        configurable: true,
      });
    }
  };
  // Read-only prototype attributes: enumerable accessors whose getters have
  // no name. JSG_READONLY_PROTOTYPE_PROPERTY puts them on the prototype
  // whatever workers_api_getters_setters_on_prototype says.
  const getters = (target, list) => {
    for (let i = 0; i < list.length; i++) {
      const name = list[i][0];
      const get = list[i][1];
      ObjectDefineProperty(get, "name", { __proto__: null, value: "" });
      ObjectDefineProperty(target, name, {
        __proto__: null, get, enumerable: true, configurable: true,
      });
    }
  };
  // A JSG class's constructor: a plain function, so `prototype` is
  // writable, with a length of 0. One without a JSG constructor throws
  // "Illegal constructor" however it is called.
  const illegalConstructor = () => new TypeError("Illegal constructor");
  const define = (fn, parent) => {
    ObjectDefineProperty(fn, "length", { __proto__: null, value: 0 });
    const prototype = ObjectCreate(parent);
    ObjectDefineProperty(prototype, "constructor", {
      __proto__: null, value: fn, writable: true, configurable: true,
    });
    ObjectDefineProperty(fn, "prototype", { __proto__: null, value: prototype });
    return prototype;
  };
  const toArray = (list) => {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      ObjectDefineProperty(out, i, {
        __proto__: null, value: list[i], writable: true, enumerable: true,
        configurable: true,
      });
    }
    return out;
  };
  const json = (pairs) => {
    const out = ObjectCreate(null);
    for (let i = 0; i < pairs.length; i++) {
      ObjectDefineProperty(out, pairs[i][0], {
        __proto__: null, value: pairs[i][1], writable: true, enumerable: true,
        configurable: true,
      });
    }
    return out;
  };

  // An entry's state, in private fields of the object itself. The base
  // returns the object it is given, so a field class can stamp an object the
  // entry's constructor made.
  class Stamp {
    constructor(target) { return target; }
  }
  let isEntry, entryName, entryType, entryStart, entryDuration;
  class EntryFields extends Stamp {
    #name; #type; #start; #duration;
    constructor(target, name, type, start, duration) {
      super(target);
      this.#name = name;
      this.#type = type;
      this.#start = start;
      this.#duration = duration;
    }
    static {
      isEntry = (value) => isObject(value) && #name in value;
      entryName = (entry) => entry.#name;
      entryType = (entry) => entry.#type;
      entryStart = (entry) => entry.#start;
      entryDuration = (entry) => entry.#duration;
    }
  }
  // A mark's or a measure's detail: null unless one was given.
  let detailKind, entryDetail;
  class DetailFields extends Stamp {
    #kind; #detail;
    constructor(target, kind, detail) {
      super(target);
      this.#kind = kind;
      this.#detail = detail;
    }
    static {
      detailKind = (value) => isObject(value) && #kind in value ? value.#kind : null;
      entryDetail = (entry) => entry.#detail;
    }
  }
  const entryJson = (entry, withDetail) => {
    const out = json([["name", entryName(entry)], ["entryType", entryType(entry)],
      ["startTime", entryStart(entry)], ["duration", entryDuration(entry)]]);
    if (withDetail && entryDetail(entry) !== undefined) {
      ObjectDefineProperty(out, "detail", {
        __proto__: null, value: entryDetail(entry), writable: true,
        enumerable: true, configurable: true,
      });
    }
    return out;
  };

  function PerformanceEntry() { throw illegalConstructor(); }
  const EntryPrototype = define(PerformanceEntry, ObjectPrototype);
  const checkEntry = (value) => {
    if (!isEntry(value)) throw illegal();
    return value;
  };
  getters(EntryPrototype, [
    ["name", function () { return entryName(checkEntry(this)); }],
    ["entryType", function () { return entryType(checkEntry(this)); }],
    ["startTime", function () { return entryStart(checkEntry(this)); }],
    ["duration", function () { return entryDuration(checkEntry(this)); }],
  ]);
  methods(EntryPrototype, [
    function toJSON() { return entryJson(checkEntry(this), false); },
  ]);

  // The mark and measure classes share their shape: a `detail` getter and a
  // `toJSON()` that adds it, each checking for its own kind.
  const detailClass = (fn, kind) => {
    const prototype = define(fn, EntryPrototype);
    const check = (value) => {
      if (detailKind(value) !== kind) throw illegal();
      return value;
    };
    getters(prototype, [["detail", function () {
      const detail = entryDetail(check(this));
      return detail === undefined ? null : detail;
    }]]);
    methods(prototype, [function toJSON() { return entryJson(check(this), true); }]);
    return prototype;
  };
  const markOptions = (value, error) => dictionary(value, error, (options) => {
    const detail = detailOf(options, "Options");
    return { __proto__: null, detail, startTime: numberOf(options, "startTime") };
  });
  const stampMark = (target, name, detail, startTime) => {
    new EntryFields(target, name, "mark", startTime, 0);
    new DetailFields(target, "mark", detail);
    return target;
  };
  function PerformanceMark(name, options) {
    if (new.target === undefined) throw __celld.__calledWithoutNew("PerformanceMark");
    const markName = string(arguments.length > 0, name,
      () => construct("PerformanceMark", 1, "string"));
    const { detail, startTime } =
      markOptions(options, () => construct("PerformanceMark", 2, "Options"));
    return stampMark(this, markName, detail, startTime === undefined ? ioNow() : startTime);
  }
  const MarkPrototype = detailClass(PerformanceMark, "mark");

  function PerformanceMeasure() { throw illegalConstructor(); }
  const MeasurePrototype = detailClass(PerformanceMeasure, "measure");

  // Never made: workerd has no resource timing in a Worker.
  function PerformanceResourceTiming() { throw illegalConstructor(); }
  const ResourceTimingPrototype = define(PerformanceResourceTiming, EntryPrototype);
  {
    const names = ["connectEnd", "connectStart", "decodedBodySize",
      "domainLookupEnd", "domainLookupStart", "encodedBodySize", "fetchStart",
      "initiatorType", "nextHopProtocol", "redirectEnd", "redirectStart",
      "requestStart", "responseEnd", "responseStart", "responseStatus",
      "secureConnectionStart", "transferSize", "workerStart"];
    for (let i = 0; i < names.length; i++)
      getters(ResourceTimingPrototype, [[names[i], function () { throw illegal(); }]]);
  }

  // Never made either: workerd hands out none.
  function PerformanceObserverEntryList() { throw illegalConstructor(); }
  const EntryListPrototype = define(PerformanceObserverEntryList, ObjectPrototype);
  methods(EntryListPrototype, [
    function getEntries() { throw illegal(); },
    function getEntriesByType() { throw illegal(); },
    function getEntriesByName() { throw illegal(); },
  ]);

  let isObserver;
  class ObserverFields extends Stamp {
    #callback;
    constructor(target, callback) {
      super(target);
      this.#callback = callback;
    }
    static {
      isObserver = (value) => isObject(value) && #callback in value;
    }
  }
  const checkObserver = (value) => {
    if (!isObserver(value)) throw illegal();
  };
  // The callback is any value but undefined, and is never called.
  function PerformanceObserver(callback) {
    if (new.target === undefined) throw __celld.__calledWithoutNew("PerformanceObserver");
    if (arguments.length < 1) throw construct("PerformanceObserver", 1, "Value");
    new ObserverFields(this, callback);
  }
  const ObserverPrototype = define(PerformanceObserver, ObjectPrototype);
  methods(ObserverPrototype, [
    function disconnect() { checkObserver(this); },
    function observe(options) {
      checkObserver(this);
      const refused = () => execute("observe", "PerformanceObserver", 1, "ObserveOptions");
      dictionary(options, refused, (value) => {
        const durationThreshold = member(value, "durationThreshold");
        const entryTypes = member(value, "entryTypes");
        if (durationThreshold !== undefined) unsigned(true, durationThreshold);
        if (entryTypes !== undefined) {
          if (!ArrayIsArray(entryTypes))
            throw field("entryTypes", "ObserveOptions", "Array");
          for (let i = 0; i < entryTypes.length; i++) `${entryTypes[i]}`;
        }
        const type = member(value, "type");
        if (type !== undefined) `${type}`;
      });
    },
    function takeRecords() { checkObserver(this); return []; },
  ]);
  // A new array on every read, as workerd's static accessor gives one.
  __instance_accessors(PerformanceObserver, [
    ["supportedEntryTypes", () => ["measure", "mark"]],
  ]);

  // EventCounts: read-only and always empty. Its iterators are classes of
  // their own, as JSG_ITERATOR makes them.
  let isEventCounts;
  class EventCountsFields extends Stamp {
    #counts = true;
    static {
      isEventCounts = (value) => isObject(value) && #counts in value;
    }
  }
  const checkCounts = (value) => {
    if (!isEventCounts(value)) throw illegal();
  };
  const iteratorClass = (name) => {
    const fn = function () { throw illegalConstructor(); };
    ObjectDefineProperty(fn, "name", { __proto__: null, value: name });
    const prototype = define(fn, IteratorPrototype);
    let made;
    class Fields extends Stamp {
      #done = false;
      static {
        made = (value) => isObject(value) && #done in value;
      }
    }
    methods(prototype, [function next() {
      if (!made(this)) throw illegal();
      return __celld.__iterResult(true);
    }]);
    __celld.__apiTag(prototype, name);
    ObjectDefineProperty(prototype, SymbolIterator, {
      __proto__: null, value: [function () { return this; }][0], writable: true,
      configurable: true,
    });
    return () => new Fields(ObjectCreate(prototype));
  };
  const entryIterator = iteratorClass("EntryIterator");
  const keyIterator = iteratorClass("KeyIterator");
  const valueIterator = iteratorClass("ValueIterator");
  function EventCounts() { throw illegalConstructor(); }
  const EventCountsPrototype = define(EventCounts, ObjectPrototype);
  getters(EventCountsPrototype, [["size", function () {
    checkCounts(this);
    return 0;
  }]]);
  methods(EventCountsPrototype, [
    function get(eventType) {
      checkCounts(this);
      string(arguments.length > 0, eventType,
        () => execute("get", "EventCounts", 1, "string"));
      return undefined;
    },
    function has(eventType) {
      checkCounts(this);
      string(arguments.length > 0, eventType,
        () => execute("has", "EventCounts", 1, "string"));
      return false;
    },
    function entries() { checkCounts(this); return entryIterator(); },
    function keys() { checkCounts(this); return keyIterator(); },
    function values() { checkCounts(this); return valueIterator(); },
    function forEach(callback) {
      checkCounts(this);
      if (typeof callback !== "function")
        throw execute("forEach", "EventCounts", 1, "function");
    },
  ]);
  __celld.__apiTag(EventCountsPrototype, "EventCounts");
  ObjectDefineProperty(EventCountsPrototype, SymbolIterator, {
    __proto__: null,
    value: [function () { checkCounts(this); return entryIterator(); }][0],
    writable: true, configurable: true,
  });
  const newEventCounts = () => new EventCountsFields(ObjectCreate(EventCountsPrototype));

  // PerformanceNodeTiming: Node.js's startup milestones, all 0. Its
  // attributes are the instance's own (JSG_READONLY_INSTANCE_PROPERTY), in
  // the reverse of their declared order, at either date.
  function PerformanceNodeTiming() { throw illegalConstructor(); }
  const NodeTimingPrototype = define(PerformanceNodeTiming, EntryPrototype);
  const uvMetricsInfo = () => struct([["loopCount", 0], ["events", 0], ["eventsWaiting", 0]]);
  const zero = () => 0;
  const NODE_TIMING = [
    ["uvMetricsInfo", uvMetricsInfo], ["idleTime", zero], ["loopExit", zero],
    ["loopStart", zero], ["environment", zero], ["bootstrapComplete", zero],
    ["v8Start", zero], ["nodeStart", zero],
  ];
  methods(NodeTimingPrototype, [function toJSON() {
    checkEntry(this);
    if (entryType(this) !== "node") throw illegal();
    const uv = json([["loopCount", 0], ["events", 0], ["eventsWaiting", 0]]);
    return json([["name", "node"], ["entryType", "node"], ["startTime", 0],
      ["duration", 0], ["nodeStart", 0], ["v8Start", 0],
      ["bootstrapComplete", 0], ["environment", 0], ["loopStart", 0],
      ["loopExit", 0], ["idleTime", 0], ["uvMetricsInfo", uv]]);
  }]);
  const newNodeTiming = () => {
    const timing = new EntryFields(ObjectCreate(NodeTimingPrototype), "node", "node", 0, 0);
    __instance_accessors(timing, NODE_TIMING);
    return timing;
  };

  // The one Performance: an EventTarget when the classes are on.
  function Performance() { throw illegalConstructor(); }
  const PerformancePrototype =
    define(Performance, classes ? __celld.__EventTarget.prototype : ObjectPrototype);
  const performance = classes
    ? ReflectConstruct(__celld.__EventTarget, [], Performance)
    : ObjectCreate(PerformancePrototype);
  const checkPerformance = (value) => {
    if (value !== performance) throw illegal();
  };
  // The recorded marks and measures, in the order they were made. Without a
  // prototype, so no setter a script puts on Array.prototype runs here.
  const list = () => ObjectSetPrototypeOf([], null);
  let entries = list();
  const keep = (from, test) => {
    const kept = list();
    for (let i = 0; i < from.length; i++) {
      if (test(from[i])) kept[kept.length] = from[i];
    }
    return kept;
  };
  const named = (name, type) => keep(entries, (entry) =>
    entryName(entry) === name && (type === undefined || entryType(entry) === type));

  getters(PerformancePrototype, [["timeOrigin", function () {
    checkPerformance(this);
    return 0;
  }]]);
  methods(PerformancePrototype, [function now() {
    if (this !== performance) throw illegal();
    return ioNow();
  }]);
  if (classes) {
    getters(PerformancePrototype, [["eventCounts", function () {
      checkPerformance(this);
      return newEventCounts();
    }]]);
    methods(PerformancePrototype, [
      function clearMarks(name) {
        checkPerformance(this);
        const only = optionalString(name);
        entries = keep(entries, (entry) => only === undefined
          ? entryType(entry) !== "mark" : entryName(entry) !== only);
      },
      function clearMeasures(name) {
        checkPerformance(this);
        const only = optionalString(name);
        entries = keep(entries, (entry) => only === undefined
          ? entryType(entry) !== "measure" : entryName(entry) !== only);
      },
      function clearResourceTimings() {
        checkPerformance(this);
        entries = keep(entries, (entry) =>
          entryType(entry) !== "resource" && entryType(entry) !== "navigation");
      },
      function getEntries() {
        checkPerformance(this);
        return toArray(entries);
      },
      function getEntriesByName(name, type) {
        checkPerformance(this);
        const wanted = string(arguments.length > 0, name,
          () => execute("getEntriesByName", "Performance", 1, "string"));
        return toArray(named(wanted, optionalString(type)));
      },
      function getEntriesByType(type) {
        checkPerformance(this);
        const wanted = string(arguments.length > 0, type,
          () => execute("getEntriesByType", "Performance", 1, "string"));
        return toArray(keep(entries, (entry) => entryType(entry) === wanted));
      },
      function mark(name, options) {
        checkPerformance(this);
        const markName = string(arguments.length > 0, name,
          () => execute("mark", "Performance", 1, "string"));
        const { detail, startTime } =
          markOptions(options, () => execute("mark", "Performance", 2, "Options"));
        const entry = stampMark(ObjectCreate(MarkPrototype), markName, detail,
          startTime === undefined ? ioNow() : startTime);
        entries[entries.length] = entry;
        return entry;
      },
      // measure(name), measure(name, startMark[, endMark]) and
      // measure(name, options[, endMark]), whose endMark is then ignored.
      // An object, a function or null is the options; anything else names
      // the start mark. A mark that is not there leaves the default.
      function measure(name, startOrOptions, endMark) {
        checkPerformance(this);
        const measureName = string(arguments.length > 0, name,
          () => execute("measure", "Performance", 1, "string"));
        let startTime = 0;
        let endTime = ioNow();
        let detail;
        if (startOrOptions === null || isObject(startOrOptions)) {
          const options = startOrOptions === null ? undefined : startOrOptions;
          detail = detailOf(options, "Options");
          const start = numberOf(options, "start");
          const duration = numberOf(options, "duration");
          const end = numberOf(options, "end");
          if (start !== undefined) startTime = start;
          if (end !== undefined) endTime = end;
          else if (duration !== undefined) endTime = startTime + duration;
        } else if (startOrOptions !== undefined) {
          const startMarks = named(`${startOrOptions}`, "mark");
          const endName = optionalString(endMark);
          if (startMarks.length > 0) startTime = entryStart(startMarks[0]);
          if (endName !== undefined) {
            const endMarks = named(endName, "mark");
            if (endMarks.length > 0) endTime = entryStart(endMarks[0]);
          }
        }
        const entry = new EntryFields(ObjectCreate(MeasurePrototype), measureName,
          "measure", startTime, endTime >= startTime ? endTime - startTime : 0);
        new DetailFields(entry, "measure", detail);
        entries[entries.length] = entry;
        return entry;
      },
      function setResourceTimingBufferSize(size) {
        checkPerformance(this);
        unsigned(arguments.length > 0, size,
          () => execute("setResourceTimingBufferSize", "Performance", 1, "unsigned integer"));
      },
      function toJSON() {
        checkPerformance(this);
        return json([["timeOrigin", 0]]);
      },
    ]);
  }
  if (hooks) {
    getters(PerformancePrototype, [["nodeTiming", function () {
      checkPerformance(this);
      return newNodeTiming();
    }]]);
    methods(PerformancePrototype, [
      function eventLoopUtilization() {
        checkPerformance(this);
        return struct([["idle", 0], ["active", 0], ["utilization", 0]]);
      },
      function markResourceTiming() { checkPerformance(this); },
      function timerify(fn) {
        checkPerformance(this);
        if (typeof fn !== "function") throw execute("timerify", "Performance", 1, "function");
        return fn;
      },
    ]);
  }

  const tag = __celld.__apiTag;
  tag(PerformancePrototype, "Performance");
  tag(EntryPrototype, "PerformanceEntry");
  tag(MarkPrototype, "PerformanceMark");
  tag(MeasurePrototype, "PerformanceMeasure");
  tag(ResourceTimingPrototype, "PerformanceResourceTiming");
  tag(ObserverPrototype, "PerformanceObserver");
  tag(EntryListPrototype, "PerformanceObserverEntryList");
  tag(NodeTimingPrototype, "PerformanceNodeTiming");

  const api = { __proto__: null, performance };
  if (classes) {
    api.Performance = Performance;
    api.PerformanceEntry = PerformanceEntry;
    api.PerformanceMark = PerformanceMark;
    api.PerformanceMeasure = PerformanceMeasure;
    api.PerformanceResourceTiming = PerformanceResourceTiming;
    api.PerformanceObserver = PerformanceObserver;
    api.PerformanceObserverEntryList = PerformanceObserverEntryList;
  }
  __celld.__performanceApi = api;

  // node:perf_hooks (src/node/perf_hooks.ts). Its module resolves only with
  // nodejs_compat and enable_nodejs_perf_hooks_module, which turns the
  // classes on too.
  if (!hooks) return;
  // workerd's internal_errors.ts classes, as its module throws them.
  class NodeErrorAbstraction extends Error {
    constructor(name, code, message) {
      super(message);
      this.code = code;
      this.name = name;
    }
    toString() {
      return `${this.name} [${this.code}]: ${this.message}`;
    }
  }
  class NodeError extends NodeErrorAbstraction {
    constructor(code, message) {
      super("Error", code, message);
    }
  }
  class ERR_METHOD_NOT_IMPLEMENTED extends NodeError {
    constructor(name) {
      super("ERR_METHOD_NOT_IMPLEMENTED", `The ${name} method is not implemented`);
    }
  }
  const constants = ObjectFreeze({
    NODE_PERFORMANCE_GC_MAJOR: 4,
    NODE_PERFORMANCE_GC_MINOR: 1,
    NODE_PERFORMANCE_GC_INCREMENTAL: 8,
    NODE_PERFORMANCE_GC_WEAKCB: 16,
    NODE_PERFORMANCE_GC_FLAGS_NO: 0,
    NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED: 2,
    NODE_PERFORMANCE_GC_FLAGS_FORCED: 4,
    NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING: 8,
    NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE: 16,
    NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY: 32,
    NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE: 64,
    NODE_PERFORMANCE_ENTRY_TYPE_GC: 0,
    NODE_PERFORMANCE_ENTRY_TYPE_HTTP: 1,
    NODE_PERFORMANCE_ENTRY_TYPE_HTTP2: 2,
    NODE_PERFORMANCE_ENTRY_TYPE_NET: 3,
    NODE_PERFORMANCE_ENTRY_TYPE_DNS: 4,
    NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN_TIMESTAMP: 0,
    NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN: 1,
    NODE_PERFORMANCE_MILESTONE_ENVIRONMENT: 2,
    NODE_PERFORMANCE_MILESTONE_NODE_START: 3,
    NODE_PERFORMANCE_MILESTONE_V8_START: 4,
    NODE_PERFORMANCE_MILESTONE_LOOP_START: 5,
    NODE_PERFORMANCE_MILESTONE_LOOP_EXIT: 6,
    NODE_PERFORMANCE_MILESTONE_BOOTSTRAP_COMPLETE: 7,
  });
  const exported = {
    eventLoopUtilization: function eventLoopUtilization(_utilization1, _utilization2) {
      return { idle: 0, active: 0, utilization: 0 };
    },
    timerify: function timerify(fn) { return fn; },
    createHistogram: function createHistogram() {
      throw new ERR_METHOD_NOT_IMPLEMENTED("createHistogram");
    },
    monitorEventLoopDelay: function monitorEventLoopDelay() {
      throw new ERR_METHOD_NOT_IMPLEMENTED("monitorEventLoopDelay");
    },
  };
  __celld.__perfHooksModule = {
    Performance,
    PerformanceEntry,
    PerformanceMark,
    PerformanceMeasure,
    PerformanceObserver,
    PerformanceObserverEntryList,
    PerformanceResourceTiming,
    constants,
    createHistogram: exported.createHistogram,
    eventLoopUtilization: exported.eventLoopUtilization,
    monitorEventLoopDelay: exported.monitorEventLoopDelay,
    performance,
    timerify: exported.timerify,
  };
  __celld.__perfHooksDefault = {
    Performance,
    PerformanceEntry,
    PerformanceMark,
    PerformanceMeasure,
    PerformanceObserver,
    PerformanceObserverEntryList,
    PerformanceResourceTiming,
    monitorEventLoopDelay: exported.monitorEventLoopDelay,
    createHistogram: exported.createHistogram,
    eventLoopUtilization: exported.eventLoopUtilization,
    timerify: exported.timerify,
    performance,
    constants,
  };
})();
// The lazy-global getter's exports: `performance`, and the classes when
// they are on.
return __celld.__performanceApi;
