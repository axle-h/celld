// The Performance API under each state of its flags (workerd
// api/performance.h): `performance` alone has `timeOrigin` and `now()`;
// enable_global_performance_classes or enable_nodejs_perf_hooks_module make
// Performance an EventTarget with the user-timing methods and the entry
// classes globals; enable_nodejs_perf_hooks_module adds the Node.js stubs.
// Each Worker runs this under its own date and flags.
//
// Left out, as listed differences of their own: where the classes live (on
// workerd's global prototype, celld's global object itself), EventTarget's
// own members, workerd's internal symbols, and the iterator helpers on
// Iterator.prototype, which follow each runtime's V8. Times are normalized.
// A Worker with nodejs_compat and neither flag is not here: wrangler then
// bundles unenv's performance polyfill, which celld does not.
const describe = (e) => (e && typeof e === "object" && "message" in e)
  ? `${e.constructor?.name}/${e.name}: ${e.message}` : String(e);
const t = (f) => {
  try {
    const value = f();
    return value === undefined ? "undefined" : value;
  } catch (e) {
    return "threw " + describe(e);
  }
};
const descriptor = (o, k) => {
  const x = Object.getOwnPropertyDescriptor(o, k);
  if (!x) return null;
  const out = [];
  if ("value" in x) {
    out.push(typeof x.value === "function" ? `fn:${x.value.name}/${x.value.length}`
      : "value:" + (typeof x.value === "object"
        ? (x.value === null ? "null" : "object") : JSON.stringify(x.value)));
  }
  if (x.get) out.push(`get:${JSON.stringify(x.get.name)}`);
  if (x.set) out.push(`set:${JSON.stringify(x.set.name)}`);
  out.push((x.enumerable ? "e" : "") + (x.writable ? "w" : "") + (x.configurable ? "c" : ""));
  return out.join(" ");
};
const INTERNAL = /cloudflare:internal-class|kResourceTypeInspect/;
const keysOf = (o) => Reflect.ownKeys(o).filter((k) => !INTERNAL.test(String(k)))
  .map((k) => [String(k), descriptor(o, k)]);
const parentName = (o) => {
  const parent = Object.getPrototypeOf(o);
  return parent === Object.prototype ? "Object" : parent?.constructor?.name ?? null;
};
const NAMES = ["Performance", "PerformanceEntry", "PerformanceMark", "PerformanceMeasure",
  "PerformanceResourceTiming", "PerformanceObserver", "PerformanceObserverEntryList",
  "EventCounts", "PerformanceNodeTiming"];
const IteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));

function surface(out) {
  out.globals = NAMES.map((n) => [n, typeof globalThis[n]]);
  out.performance = {
    descriptor: descriptor(globalThis, "performance"),
    own: keysOf(performance),
    prototype: keysOf(Object.getPrototypeOf(performance)),
    parent: parentName(Object.getPrototypeOf(performance)),
    tag: Object.prototype.toString.call(performance),
    nowIsDate: performance.now() === Date.now(),
    timeOrigin: performance.timeOrigin,
    nowOther: t(() => Object.getPrototypeOf(performance).now.call({})),
    nowDetached: t(() => { const f = performance.now; return f(); }),
    timeOriginOther: t(() => Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(performance), "timeOrigin").get.call({})),
    construct: t(() => new (Object.getPrototypeOf(performance).constructor)()),
    call: t(() => (Object.getPrototypeOf(performance).constructor)()),
    replace: t(() => {
      const saved = performance;
      globalThis.performance = 1;
      const replaced = globalThis.performance;
      globalThis.performance = saved;
      return replaced;
    }),
  };
  out.classes = {};
  for (const n of NAMES) {
    const C = globalThis[n];
    if (typeof C !== "function") continue;
    out.classes[n] = {
      name: C.name,
      length: C.length,
      statics: keysOf(C),
      prototype: keysOf(C.prototype),
      parent: parentName(C.prototype),
      constructorParent: Object.getPrototypeOf(C) === Function.prototype
        ? "Function" : Object.getPrototypeOf(C)?.name,
      construct: t(() => {
        const v = new C();
        return [Object.prototype.toString.call(v), keysOf(v)];
      }),
      call: t(() => C()),
    };
  }
}

function timing(out) {
  out.mark = t(() => {
    const m = performance.mark("a");
    return [Object.prototype.toString.call(m), keysOf(m), m.name, m.entryType,
      typeof m.startTime, m.duration, m.detail, m.toJSON(), m instanceof PerformanceEntry];
  });
  out.markArguments = {
    none: t(() => performance.mark().name),
    undefined: t(() => performance.mark(undefined).name),
    null: t(() => performance.mark(null).name),
    number: t(() => performance.mark(5).name),
    symbol: t(() => performance.mark(Symbol("x"))),
    options: t(() => {
      const m = performance.mark("b", { startTime: 5, detail: { x: 1 } });
      return [m.startTime, m.detail, m.toJSON()];
    }),
    detailNumber: t(() => performance.mark("c", { detail: 5 }).detail),
    detailNull: t(() => performance.mark("c2", { detail: null }).detail),
    detailArray: t(() => performance.mark("da", { detail: [1] }).detail),
    detailFunction: t(() => typeof performance.mark("df", { detail: () => 1 }).detail),
    startString: t(() => performance.mark("d", { startTime: "7" }).startTime),
    startNaN: t(() => performance.mark("d2", { startTime: "x" }).startTime),
    startBigInt: t(() => performance.mark("d3", { startTime: 1n }).startTime),
    optionsNull: t(() => performance.mark("e", null).name),
    optionsNumber: t(() => performance.mark("e2", 5).name),
    optionsString: t(() => performance.mark("e3", "x").name),
  };
  out.measure = {
    plain: t(() => {
      const m = performance.measure("m1");
      return [keysOf(m), m.startTime, typeof m.duration, m.detail, m.entryType];
    }),
    startMark: t(() => {
      const m = performance.measure("m2", "b");
      return [m.startTime, typeof m.duration, m.detail];
    }),
    marks: t(() => {
      const m = performance.measure("m3", "b", "a");
      return [m.startTime, typeof m.duration];
    }),
    options: t(() => {
      const m = performance.measure("m4", { start: 10, end: 30, detail: { y: 2 } });
      return [m.startTime, m.duration, m.detail, m.toJSON()];
    }),
    duration: t(() => {
      const m = performance.measure("m5", { start: 10, duration: 3 });
      return [m.startTime, m.duration];
    }),
    backwards: t(() => {
      const m = performance.measure("m6", { start: 30, end: 10 });
      return [m.startTime, m.duration];
    }),
    missingMarks: t(() => {
      const m = performance.measure("m7", "nope", "nope2");
      return [m.startTime, typeof m.duration];
    }),
    optionsThenMark: t(() => {
      const m = performance.measure("m8", { start: 10 }, "a");
      return [m.startTime, typeof m.duration];
    }),
    number: t(() => [performance.measure("m9", 5).startTime === performance.getEntriesByName("5")[0].startTime]),
    null: t(() => {
      const m = performance.measure("m10", null);
      return [m.startTime, typeof m.duration];
    }),
    undefinedStart: t(() => {
      const m = performance.measure("m11", undefined, "a");
      return [m.startTime, typeof m.duration];
    }),
    strings: t(() => {
      const m = performance.measure("x", { start: "5", end: "9" });
      return [m.startTime, m.duration];
    }),
    empty: t(() => {
      const m = performance.measure("x2", {});
      return [m.startTime, typeof m.duration, m.detail];
    }),
    end: t(() => {
      const m = performance.measure("x3", { end: 5 });
      return [m.startTime, m.duration];
    }),
    onlyDuration: t(() => {
      const m = performance.measure("x3b", { duration: 5 });
      return [m.startTime, m.duration];
    }),
    endWins: t(() => {
      const m = performance.measure("x3c", { end: 9, duration: 5, start: 1 });
      return [m.startTime, m.duration];
    }),
    detailNumber: t(() => performance.measure("x4", { detail: 5 }).detail),
    detailNull: t(() => performance.measure("x4b", { detail: null }).detail),
    boolean: t(() => performance.measure("x5", true).name),
    function: t(() => performance.measure("x6", () => 1).startTime),
    symbol: t(() => performance.measure("x6b", Symbol("s")).name),
    none: t(() => performance.measure().name),
    nan: t(() => {
      const m = performance.measure("x7", { start: "q" });
      return [m.startTime, m.duration];
    }),
    endMarkNumber: t(() => {
      performance.mark("9", { startTime: 50 });
      const m = performance.measure("x8", "nope", 9);
      return [m.startTime, m.duration];
    }),
    firstMark: t(() => {
      performance.mark("dup", { startTime: 3 });
      performance.mark("dup", { startTime: 4 });
      return performance.measure("md", "dup", "dup").startTime;
    }),
  };
  out.entries = {
    list: performance.getEntries().map((e) => [e.name, e.entryType]),
    fresh: performance.getEntries() !== performance.getEntries(),
    byName: performance.getEntriesByName("a").map((e) => e.entryType),
    byNameAndType: performance.getEntriesByName("a", "measure").length,
    byNameUndefinedType: performance.getEntriesByName("a", undefined).length,
    byNameNullType: performance.getEntriesByName("null", null).length,
    byType: performance.getEntriesByType("measure").length,
    byNameNone: t(() => performance.getEntriesByName().length),
    byTypeNone: t(() => performance.getEntriesByType().length),
  };
  out.clear = {
    marksNamed: (performance.clearMarks("a"), performance.getEntries().map((e) => e.name)),
    measures: (performance.clearMeasures(), performance.getEntries().map((e) => e.name)),
    marks: (performance.clearMarks(), performance.getEntries().length),
    marksUndefined: t(() => {
      performance.mark("cm");
      performance.clearMarks(undefined);
      return performance.getEntriesByType("mark").length;
    }),
    marksNull: t(() => {
      performance.mark("null");
      performance.mark("cm2");
      performance.clearMarks(null);
      return performance.getEntriesByType("mark").map((m) => m.name);
    }),
    marksByMeasureName: t(() => {
      performance.measure("mm");
      performance.clearMarks("mm");
      return performance.getEntriesByName("mm").length;
    }),
    resourceTimings: t(() => performance.clearResourceTimings()),
    order: t(() => {
      performance.clearMarks();
      performance.clearMeasures();
      performance.mark("o1", { startTime: 9 });
      performance.mark("o2", { startTime: 1 });
      return performance.getEntries().map((e) => e.name);
    }),
  };
  out.bufferSize = [5, -1, "x", 1.5, 2 ** 32, NaN, null, "7", undefined]
    .map((v) => t(() => performance.setResourceTimingBufferSize(v)))
    .concat([t(() => performance.setResourceTimingBufferSize())]);
  out.toJSON = t(() => [performance.toJSON(), Object.getPrototypeOf(performance.toJSON())]);
  out.toJSONPrototypes = t(() => [Object.getPrototypeOf(performance.mark("tj").toJSON()),
    Object.getPrototypeOf(performance.measure("tj").toJSON())]);
  out.toJSONDetailOrder = t(() => Object.keys(performance.mark("tj2", { detail: {} }).toJSON()));
  out.detailIdentity = t(() => {
    const o = {};
    return [performance.mark("ds", { detail: o }).detail === o,
      new PerformanceMark("ds", { detail: o }).detail === o,
      performance.measure("ds", { detail: o }).detail === o];
  });
  out.listener = t(() => {
    let n = 0;
    performance.addEventListener("x", () => n++);
    performance.dispatchEvent(new Event("x"));
    return n;
  });
  out.brands = {
    markOther: t(() => performance.mark.call({}, "z")),
    nameOther: t(() => Object.getOwnPropertyDescriptor(PerformanceEntry.prototype, "name").get.call({})),
    entryGetterOnMark: t(() => typeof Object.getOwnPropertyDescriptor(
      PerformanceEntry.prototype, "startTime").get.call(performance.mark("g"))),
    markDetailOnMeasure: t(() => Object.getOwnPropertyDescriptor(
      PerformanceMark.prototype, "detail").get.call(performance.measure("g2"))),
    resourceTiming: t(() => Object.getOwnPropertyDescriptor(
      PerformanceResourceTiming.prototype, "connectEnd").get.call(performance.mark("g3"))),
    markToJSONOnMeasure: t(() => PerformanceMark.prototype.toJSON.call(performance.measure("g4"))),
    entryToJSONOnMark: t(() => Object.keys(PerformanceEntry.prototype.toJSON.call(
      performance.mark("g5", { detail: {} })))),
    resourceToJSON: PerformanceResourceTiming.prototype.toJSON === PerformanceEntry.prototype.toJSON,
    entryList: t(() => PerformanceObserverEntryList.prototype.getEntries.call({})),
    observer: t(() => PerformanceObserver.prototype.observe.call({})),
  };
}

function others(out) {
  out.eventCounts = t(() => {
    const e = performance.eventCounts;
    const entries = e.entries();
    return [e === performance.eventCounts, Object.prototype.toString.call(e), e.size,
      e.get("x"), e.has("x"), e.get(undefined), [...e], [...e.keys()], [...e.values()],
      keysOf(Object.getPrototypeOf(e)), Object.prototype.toString.call(entries),
      keysOf(Object.getPrototypeOf(entries)),
      Object.getPrototypeOf(Object.getPrototypeOf(entries)) === IteratorPrototype,
      entries.next(), entries[Symbol.iterator]() === entries,
      e[Symbol.iterator] === e.entries, e.forEach(() => {}), t(() => e.forEach()),
      t(() => e.get()), t(() => e.entries.call({})),
      t(() => new (e.constructor)()), e.constructor.name];
  });
  out.newMark = t(() => {
    const m = new PerformanceMark("x", { startTime: 3, detail: { a: 1 } });
    return [keysOf(m), m.startTime, m.detail, m.entryType, performance.getEntriesByName("x").length];
  });
  out.newMarkDefault = t(() => {
    const m = new PerformanceMark("x");
    return [typeof m.startTime, m.startTime === Date.now(), m.detail];
  });
  out.newMarkArguments = [
    t(() => new PerformanceMark().name),
    t(() => new PerformanceMark(undefined).name),
    t(() => new PerformanceMark("a", null).name),
    t(() => new PerformanceMark("a", 5).name),
  ];
  out.subclass = t(() => {
    class X extends PerformanceMark { constructor() { super("sub"); } }
    const x = new X();
    return [x instanceof X, Object.prototype.toString.call(x), x.name,
      performance.getEntriesByName("sub").length];
  });
  out.observer = t(() => {
    const o = new PerformanceObserver(() => {});
    return [keysOf(o), o.observe(), o.observe({ type: "mark" }), o.disconnect(), o.takeRecords(),
      PerformanceObserver.supportedEntryTypes,
      PerformanceObserver.supportedEntryTypes === PerformanceObserver.supportedEntryTypes,
      Object.isFrozen(PerformanceObserver.supportedEntryTypes)];
  });
  out.observerArguments = [
    t(() => typeof new PerformanceObserver()),
    t(() => typeof new PerformanceObserver(undefined)),
    t(() => typeof new PerformanceObserver(5)),
    t(() => new PerformanceObserver(() => {}).observe(5)),
    t(() => new PerformanceObserver(() => {}).observe(null)),
    t(() => new PerformanceObserver(() => {}).observe({ entryTypes: 5 })),
    t(() => new PerformanceObserver(() => {}).observe({ entryTypes: ["a", 1] })),
    t(() => new PerformanceObserver(() => {}).observe(
      { entryTypes: ["x"], type: "y", buffered: "q", durationThreshold: -1 })),
    t(() => new PerformanceObserver(() => {}).observe({ durationThreshold: 5 })),
  ];
}

function node(out) {
  out.nodeTiming = t(() => {
    const n = performance.nodeTiming;
    return [n === performance.nodeTiming, n.uvMetricsInfo === n.uvMetricsInfo,
      Object.prototype.toString.call(n), keysOf(n), keysOf(Object.getPrototypeOf(n)),
      parentName(Object.getPrototypeOf(n)), n.toJSON(), Object.getPrototypeOf(n.toJSON()),
      n.uvMetricsInfo, n.name, n.entryType, n.startTime, n.duration,
      t(() => new (n.constructor)()), n.constructor.name];
  });
  out.eventLoopUtilization = t(() => [performance.eventLoopUtilization(),
    performance.eventLoopUtilization(1, 2)]);
  out.timerify = t(() => {
    const f = () => 1;
    return [performance.timerify(f) === f, t(() => performance.timerify(5)),
      t(() => performance.timerify())];
  });
  out.markResourceTiming = t(() => performance.markResourceTiming(1, 2, 3));
}

export function probe() {
  const out = {};
  out.flags = Object.fromEntries(["enable_global_performance_classes",
    "enable_nodejs_perf_hooks_module", "nodejs_compat",
    "workers_api_getters_setters_on_prototype", "set_tostring_tag"]
    .map((k) => [k, Cloudflare.compatibilityFlags[k] ?? null]));
  surface(out);
  if (typeof PerformanceMark === "function") {
    timing(out);
    others(out);
  }
  if ("nodeTiming" in performance) node(out);
  return JSON.parse(JSON.stringify(out, (k, v) => typeof v === "number" && v > 1e12 ? "<time>" : v));
}
