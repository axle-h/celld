// The checked forms of ArrayBuffer, SharedArrayBuffer and WebAssembly that
// count growth against the isolate's memory (plan 1.35) look and fail as
// V8's own do, as feature detection and error handling see them.
const attempt = (run) => {
  try {
    return run();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};
const text = (fn) => Function.prototype.toString.call(fn);
const descriptor = (target, name) => JSON.stringify(
  Object.getOwnPropertyDescriptor(target, name),
  (key, value) => (typeof value === "function" ? "fn" : value));

export default {
  async fetch() {
    const out = {};
    for (const [label, fn] of Object.entries({
      ArrayBuffer,
      SharedArrayBuffer,
      Memory: WebAssembly.Memory,
      resize: ArrayBuffer.prototype.resize,
      transfer: ArrayBuffer.prototype.transfer,
      transferToFixedLength: ArrayBuffer.prototype.transferToFixedLength,
      grow: SharedArrayBuffer.prototype.grow,
      memoryGrow: WebAssembly.Memory.prototype.grow,
      toString: Function.prototype.toString,
    })) {
      out[label] = [fn.name, fn.length, text(fn), descriptor(fn, "length")];
    }
    // workerd wraps these two in JavaScript of its own, whose text and
    // descriptor celld does not copy.
    out.wrapped = [WebAssembly.Instance.name, WebAssembly.Instance.length,
      WebAssembly.instantiate.name, WebAssembly.instantiate.length];
    out.toStringOfNonFunction = attempt(() => text({}));
    out.descriptors = [
      descriptor(globalThis, "ArrayBuffer"),
      descriptor(globalThis, "SharedArrayBuffer"),
      descriptor(WebAssembly, "Memory"),
      descriptor(ArrayBuffer.prototype, "resize"),
      descriptor(Function.prototype, "toString"),
    ];
    out.keys = Object.getOwnPropertyNames(ArrayBuffer).sort().join(",");
    out.identity = [
      new ArrayBuffer(1).constructor === ArrayBuffer,
      ArrayBuffer.prototype.constructor === ArrayBuffer,
      ArrayBuffer[Symbol.species] === ArrayBuffer,
      ArrayBuffer.isView(new Uint8Array(1)),
      new Uint8Array(4).buffer.constructor === ArrayBuffer,
      new ArrayBuffer(8).slice(0, 4).constructor === ArrayBuffer,
      structuredClone(new ArrayBuffer(4)).constructor === ArrayBuffer,
      new WebAssembly.Memory({ initial: 1 }).constructor === WebAssembly.Memory,
      new Uint8Array(4) instanceof Uint8Array && new ArrayBuffer(4) instanceof ArrayBuffer,
      Object.prototype.toString.call(new ArrayBuffer(1)),
    ];
    class Sub extends ArrayBuffer {}
    const sub = new Sub(4, { maxByteLength: 8 });
    out.subclass = [
      sub instanceof Sub, Object.getPrototypeOf(sub) === Sub.prototype, sub.resizable,
      Object.getPrototypeOf(Reflect.construct(ArrayBuffer, [4], Sub)) === Sub.prototype,
    ];
    out.called = attempt(() => ArrayBuffer(4));
    // Growth that fits, and the result each makes.
    const buffer = new ArrayBuffer(2, { maxByteLength: 64 });
    buffer.resize(16);
    const moved = buffer.transfer(32);
    const fixed = moved.transferToFixedLength();
    const shared = new SharedArrayBuffer(4, { maxByteLength: 64 });
    shared.grow(16);
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
    out.grown = [
      buffer.detached, moved.byteLength, moved.maxByteLength, moved.detached,
      fixed.byteLength, fixed.resizable, shared.byteLength, memory.grow(2),
      memory.buffer.byteLength, structuredClone(new ArrayBuffer(4, { maxByteLength: 8 })).maxByteLength,
      new ArrayBuffer(0, { maxByteLength: 8 }).transfer().resizable,
      new ArrayBuffer(4, { maxByteLength: 8 }).resize(undefined) ?? "undefined",
    ];
    // What the originals reject, which must be their own errors.
    const resizableOf = (length = 0) => new ArrayBuffer(length, { maxByteLength: 16 });
    let reads = 0;
    const counted = { valueOf() { reads++; return 4; } };
    resizableOf().resize(counted);
    out.convertedOnce = reads;
    const detachedBuffer = resizableOf(4);
    detachedBuffer.transfer();
    out.errors = {
      resizeBigInt: attempt(() => resizableOf().resize(1n)),
      resizeSymbol: attempt(() => resizableOf().resize(Symbol())),
      resizeBigIntObject: attempt(() => resizableOf().resize({ valueOf: () => 1n })),
      resizeNonResizable: attempt(() => new ArrayBuffer(8).resize(4)),
      resizeShared: attempt(() => ArrayBuffer.prototype.resize.call(new SharedArrayBuffer(8), 4)),
      resizeNotBuffer: attempt(() => ArrayBuffer.prototype.resize.call({}, 4)),
      resizeTooBig: attempt(() => resizableOf().resize(32)),
      resizeNegative: attempt(() => resizableOf().resize(-1)),
      resizeDetached: attempt(() => detachedBuffer.resize(4)),
      transferTooBig: attempt(() => resizableOf().transfer(32)),
      transferNegative: attempt(() => resizableOf().transfer(-1)),
      transferDetached: attempt(() => detachedBuffer.transfer(4)),
      transferBigInt: attempt(() => resizableOf().transfer(1n)),
      fixedDetached: attempt(() => detachedBuffer.transferToFixedLength(4)),
      transferShared: attempt(() => ArrayBuffer.prototype.transfer.call(new SharedArrayBuffer(8))),
      constructTooBig: attempt(() => new ArrayBuffer(32, { maxByteLength: 16 })),
      constructNegative: attempt(() => new ArrayBuffer(-1, { maxByteLength: 16 })),
      constructBadMax: attempt(() => new ArrayBuffer(1, { maxByteLength: -1 })),
      constructBigInt: attempt(() => new ArrayBuffer(1n, { maxByteLength: 16 })),
      constructMaxBigInt: attempt(() => new ArrayBuffer(1, { maxByteLength: 1n })),
      growNotGrowable: attempt(() => new SharedArrayBuffer(8).grow(16)),
      growShrink: attempt(() => new SharedArrayBuffer(8, { maxByteLength: 16 }).grow(4)),
      growTooBig: attempt(() => new SharedArrayBuffer(8, { maxByteLength: 16 }).grow(32)),
      memoryPastMax: attempt(() => new WebAssembly.Memory({ initial: 1, maximum: 2 }).grow(5)),
      memoryNegative: attempt(() => new WebAssembly.Memory({ initial: 1 }).grow(-1)),
      memoryNaN: attempt(() => new WebAssembly.Memory({ initial: 1 }).grow(NaN)),
      memoryBigInt: attempt(() => new WebAssembly.Memory({ initial: 1 }).grow(1n)),
      memoryNotMemory: attempt(() => WebAssembly.Memory.prototype.grow.call({}, 1)),
      memoryDescriptor: attempt(() => new WebAssembly.Memory({})),
    };
    // A memory descriptor is read once, member by member in V8's order,
    // and converted as V8 converts it.
    const memberReads = [];
    const traced = new Proxy({ initial: { valueOf() { memberReads.push("valueOf"); return 1; } }, maximum: 2 }, {
      get(target, key) {
        memberReads.push(String(key));
        return target[key];
      },
    });
    new WebAssembly.Memory(traced);
    out.descriptorReads = memberReads.join(",");
    out.descriptorErrors = [
      attempt(() => new WebAssembly.Memory({ initial: {} })),
      attempt(() => new WebAssembly.Memory({ initial: { valueOf: () => 1n } })),
      attempt(() => new WebAssembly.Memory({ initial: { [Symbol.toPrimitive]: () => ({}) } })),
      attempt(() => new WebAssembly.Memory({ initial: 1, address: "i33" })),
      attempt(() => new WebAssembly.Memory(1)),
    ];
    class Pages extends WebAssembly.Memory {}
    out.memorySubclass = Object.getPrototypeOf(new Pages({ initial: 1 })) === Pages.prototype;
    return Response.json(out);
  },
};
