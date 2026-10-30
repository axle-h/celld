// Symbol.toStringTag on celld's API classes. Under set_tostring_tag workerd
// gives every resource type's prototype its class name (jsg/resource.h),
// writable and configurable but not enumerable; without the flag none has
// one. A class tags itself with `__apiTag` as it is defined. The Worker's
// flags are known only after the prelude and the harness have run, so the
// tags given until then are taken off when the flag is off
// (`__applyApiTags`), and a class defined later, a lazy global, is tagged
// only when it is on.
//
// workerd's prototypes list `constructor` after their members, where a
// class has it first, so it moves to the end once the prototype is complete:
// when the flags are known, or as a later class is tagged.
const tagged = [];
let decided = false;
let enabled = true;
const constructorLast = (target) => {
  const descriptor = Object.getOwnPropertyDescriptor(target, "constructor");
  if (descriptor === undefined) return;
  Reflect.deleteProperty(target, "constructor");
  Object.defineProperty(target, "constructor", descriptor);
};
__celld.__apiTag = (target, name) => {
  if (decided) constructorLast(target);
  if (decided && !enabled) return;
  Object.defineProperty(target, Symbol.toStringTag, {
    __proto__: null, value: name, writable: true, enumerable: false,
    configurable: true,
  });
  if (!decided) tagged[tagged.length] = target;
};
__celld.__applyApiTags = (on) => {
  decided = true;
  enabled = on;
  for (let i = 0; i < tagged.length; i++) {
    constructorLast(tagged[i]);
    if (!on) Reflect.deleteProperty(tagged[i], Symbol.toStringTag);
  }
  tagged.length = 0;
};

// workerd's TypeError for a method or accessor called on the wrong kind of
// object.
__celld.__illegalInvocation = () => new TypeError(
  "Illegal invocation: function called with incorrect `this` " +
  "reference. See https://developers.cloudflare.com/workers/" +
  "observability/errors/#illegal-invocation-errors for details.");

// The structs workerd's APIs return (jsg/struct.h) keep their members in
// declaration order. Under enable_fast_jsg_struct an absent optional member
// is there as undefined; without it, it is left out. `__applyCompat` sets
// the flag once the Worker's flags are known.
__celld.__fastJsgStruct = false;
const defineProperty = Object.defineProperty;
// A struct from `[key, value, optional]` members, an optional one absent
// when its value is undefined.
__celld.__struct = (members) => {
  const out = {};
  const fast = __celld.__fastJsgStruct;
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    if (member[2] && member[1] === undefined && !fast) continue;
    defineProperty(out, member[0], {
      __proto__: null, value: member[1], writable: true, enumerable: true,
      configurable: true,
    });
  }
  return out;
};
// A sync or async iterator's step (jsg/iterator.h `Next`): `done`, then
// `value`, which a finished iterator does not have.
__celld.__iterResult = (done, value) => done
  ? (__celld.__fastJsgStruct ? { done, value: undefined } : { done })
  : { done, value };
// A stream read's result (streams/common.h `ReadResult`): `value`, which a
// read at the end does not have, then `done`.
__celld.__readResult = (value, done) =>
  done && value === undefined && !__celld.__fastJsgStruct
    ? { done } : { value, done };

// workerd's error for an API constructor called without `new`, which the
// constructors written as functions throw (Body, Request, Response,
// ReadableStream): a class constructor's cannot be changed.
__celld.__calledWithoutNew = (name) => new TypeError(
  `Failed to construct '${name}': Please use the 'new' operator, this ` +
  "object constructor cannot be called as a function.");
// Puts a class's static and prototype members on the constructor function
// `target`, whose `prototype` then is read-only, as a class's is.
__celld.__installMembers = (target, members) => {
  const copy = (from, to, skip) => {
    const keys = Reflect.ownKeys(from);
    for (let i = 0; i < keys.length; i++) {
      if (skip.includes(keys[i])) continue;
      Object.defineProperty(to, keys[i],
        Object.getOwnPropertyDescriptor(from, keys[i]));
    }
  };
  copy(members, target, ["length", "name", "prototype"]);
  copy(members.prototype, target.prototype, ["constructor"]);
  Object.defineProperty(target, "prototype", { __proto__: null, writable: false });
};
