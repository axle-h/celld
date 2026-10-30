// setImmediate/clearImmediate, which workerd's global scope has under
// nodejs_compat_v2 (api/global-scope.h): a zero-delay timer, after
// microtasks and before later timers, that answers with an Immediate. The
// harness makes them with node:timers' own (`__nodeTimers`), and takes the
// names off the global scope without the flag (`__applyCompat`). Compiled
// lazily the first time a bundle reads either name.
return __celld.__nodeTimers().globalImmediate;
