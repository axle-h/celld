// Symbol.toStringTag on celld's API classes. Under set_tostring_tag workerd
// gives every resource type's prototype its class name (jsg/resource.h),
// writable and configurable but not enumerable; without the flag none has
// one. A class tags itself with `__apiTag` as it is defined. The Worker's
// flags are known only after the prelude and the harness have run, so the
// tags given until then are taken off when the flag is off
// (`__applyApiTags`), and a class defined later, a lazy global, is tagged
// only when it is on.
const tagged = [];
let decided = false;
let enabled = true;
__celld.__apiTag = (target, name) => {
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
  if (!on) {
    for (let i = 0; i < tagged.length; i++)
      Reflect.deleteProperty(tagged[i], Symbol.toStringTag);
  }
  tagged.length = 0;
};
