// Backing stores past the isolate's 128 MiB budget for them, each in its own
// way. None is in the V8 heap, so before plan 1.33 none met any limit. The
// Dynamic Workers run the same functions from their source text.
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
  // A refusal the Worker catches still counts.
  caught() {
    try {
      globalThis.keep = new ArrayBuffer(512 << 20);
    } catch {}
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
  // A WebAssembly memory cannot grow past the limit: the grow throws V8's
  // RangeError.
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
