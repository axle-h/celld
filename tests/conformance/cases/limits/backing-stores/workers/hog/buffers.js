// Backing stores past the isolate's 128 MiB budget for them, each in its own
// way. None is in the V8 heap, so before plan 1.33 none met any limit. What
// JavaScript asks for past the budget is refused with V8's RangeError and
// takes nothing, so the isolate lives on (plan 1.35); what the isolate comes
// to hold past it condemns the isolate. The Dynamic Workers run the same
// functions from their source text.
// The functions' text runs in Dynamic Workers too, so each module that runs
// them declares `growerModule` at its module scope from `prelude`: Wasm
// compiles from bytes only while a module evaluates, as in workerd.
// (memory 1) (func "grow" (param i32) (result i32) memory.grow)
// (func "touch" fills the whole memory with memory.fill)
const GROWER = "AGFzbQEAAAABCQJgAX8Bf2AAAAMDAgABBQMBAAEHEAIEZ3JvdwAABXRvdWNoAAEKFwIGACAAQAALDgBBAEEBPwBBEHT8CwAL";
export const prelude = "const growerModule = new WebAssembly.Module(Uint8Array.from(" +
  `atob(${JSON.stringify(GROWER)}), (character) => character.charCodeAt(0)));`;
const growerModule = new WebAssembly.Module(Uint8Array.from(
  atob(GROWER), (character) => character.charCodeAt(0)));

export const buffers = {
  // Many buffers of 64 MiB, about 2.5 GB in all.
  many() {
    const keep = [];
    for (let i = 0; i < 40; i++) keep.push(new Uint8Array(64 << 20).fill(1));
    globalThis.keep = keep;
  },
  // One buffer of 512 MiB.
  one() {
    globalThis.keep = new Uint8Array(512 << 20).fill(1);
  },
  // A refusal the Worker catches costs it nothing.
  caught() {
    try {
      globalThis.keep = new ArrayBuffer(512 << 20);
    } catch (error) {
      globalThis.result = error.message;
    }
  },
  // A resizable buffer, which V8 grows outside the allocator, to 1 GiB.
  resizable() {
    const buffer = new ArrayBuffer(0, { maxByteLength: 2 ** 31 });
    buffer.resize(1 << 30);
    new Uint8Array(buffer).fill(1);
    globalThis.keep = buffer;
  },
  // Within the budget.
  fits() {
    globalThis.keep = new Uint8Array(64 << 20).fill(1);
  },
  // WebAssembly memory shares the budget: one memory of 100 MiB and a
  // buffer of 30 MiB are past it together, as are two memories of 100 MiB.
  wasmAndBuffer() {
    const memory = new WebAssembly.Memory({ initial: 1600 });
    new Uint8Array(memory.buffer).fill(1);
    globalThis.keep = [memory, new Uint8Array(30 << 20).fill(1)];
  },
  twoWasm() {
    const memories = [];
    for (let i = 0; i < 2; i++) {
      const memory = new WebAssembly.Memory({ initial: 1600 });
      new Uint8Array(memory.buffer).fill(1);
      memories.push(memory);
    }
    globalThis.keep = memories;
  },
  // Ten instances of a module whose memory is its own, which Wasm code grows
  // with `memory.grow` and fills, where no JavaScript sees it.
  wasmInternal() {
    const module = growerModule;
    const keep = [];
    for (let i = 0; i < 10; i++) {
      const instance = new WebAssembly.Instance(module);
      for (let pages = 0; pages < 1900; pages += 50) {
        instance.exports.grow(50);
        instance.exports.touch();
      }
      keep.push(instance);
    }
    globalThis.keep = keep;
  },
  // The same growth from inside a memory descriptor's getter, which V8
  // would read while the memory is made: the watch still sees it.
  wasmInDescriptor() {
    const module = growerModule;
    const instances = [];
    for (let i = 0; i < 10; i++) instances.push(new WebAssembly.Instance(module));
    globalThis.keep = instances;
    new WebAssembly.Memory({
      get initial() {
        for (const instance of instances) {
          for (let pages = 0; pages < 1900; pages += 50) {
            instance.exports.grow(50);
            instance.exports.touch();
          }
        }
        return 1;
      },
    });
  },
  // Ten WebAssembly memories of 100 MiB, made in one turn.
  tenWasm() {
    const memories = [];
    for (let i = 0; i < 10; i++) {
      const memory = new WebAssembly.Memory({ initial: 1600 });
      new Uint8Array(memory.buffer).fill(1);
      memories.push(memory);
    }
    globalThis.keep = memories;
  },
  // A transfer of a resizable buffer commits the new length outside the
  // allocator, as a resize does, and one memset would fill it at once.
  transfer() {
    const buffer = new ArrayBuffer(0, { maxByteLength: 2 ** 31 });
    const moved = buffer.transfer(2 ** 31);
    new Uint8Array(moved).fill(1);
    globalThis.keep = moved;
  },
  transferToFixedLength() {
    const buffer = new ArrayBuffer(0, { maxByteLength: 2 ** 31 });
    const moved = buffer.transferToFixedLength(2 ** 31);
    new Uint8Array(moved).fill(1);
    globalThis.keep = moved;
  },
  // A resizable buffer made 1 GiB long at once.
  resizableInitial() {
    globalThis.keep = new Uint8Array(new ArrayBuffer(1 << 30, { maxByteLength: 2 ** 31 })).fill(1);
  },
  // A growable SharedArrayBuffer grown to 1 GiB.
  growable() {
    const buffer = new SharedArrayBuffer(0, { maxByteLength: 2 ** 31 });
    buffer.grow(1 << 30);
    new Uint8Array(buffer).fill(1);
    globalThis.keep = buffer;
  },
  // A clone of a resizable buffer of 100 MiB, which with the original is
  // past the budget.
  clone() {
    const buffer = new ArrayBuffer(100 << 20, { maxByteLength: 128 << 20 });
    new Uint8Array(buffer).fill(1);
    globalThis.keep = [buffer, structuredClone(buffer)];
  },
  // Emscripten's `_emscripten_resize_heap`: a grow past the budget, with
  // the 20 MiB the module holds besides, is refused, and the module asks for
  // less, which fits.
  fallback() {
    const held = new Uint8Array(20 << 20).fill(1);
    const memory = new WebAssembly.Memory({ initial: 1200, maximum: 65536 });
    const tried = [];
    for (const pages of [800, 400]) {
      try {
        memory.grow(pages);
        tried.push(`grew ${pages}`);
        break;
      } catch (error) {
        tried.push(`${error.name}: ${error.message}`);
      }
    }
    new Uint8Array(memory.buffer).fill(1);
    globalThis.keep = [held, memory];
    globalThis.result = tried.join("; ");
  },
  // A WebAssembly memory cannot grow past the budget: the grow throws V8's
  // RangeError, which the Worker catches.
  wasm() {
    const memory = new WebAssembly.Memory({ initial: 1 });
    try {
      memory.grow(4000);
      globalThis.result = "grew";
    } catch (error) {
      globalThis.result = error.name;
    }
  },
};
