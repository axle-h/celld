// URLPattern -- WHATWG URLPattern over the Rust `urlpattern` crate, split
// the way Deno splits it: the host ops ($$urlPatternParse /
// $$urlPatternMatchInput) do pattern parsing and match-input
// canonicalization; the compiled component regexes execute here as plain
// JS RegExp. Compiled on first access (see LAZY_GLOBALS); a bundle that
// never names URLPattern never pays for this file.
return (() => {

const KEYS = ['protocol', 'username', 'password', 'hostname', 'port',
              'pathname', 'search', 'hash'];

// USVString: lone surrogates become U+FFFD so the value survives
// JSON.stringify into the host op.
const usv = (v) => `${v}`.toWellFormed();

// (URLPatternInit or USVString): null/undefined and objects convert as a
// dictionary of USVString members (baseURL included), anything else as a
// string.
function toInput(v) {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object') return usv(v);
  const init = {};
  for (const k of [...KEYS, 'baseURL'])
    if (v[k] !== undefined) init[k] = usv(v[k]);
  return init;
}

// Canonicalized 8-component values for a match input, or null when the
// input does not parse as a URL (per spec, a non-match).
// `method` names the call for workerd's error when the input cannot be
// matched at all, as an init with a separate base URL cannot.
function matchValues(input, baseURL, method) {
  let json;
  try {
    json = $$urlPatternMatchInput(JSON.stringify(input), baseURL);
  } catch {
    throw new TypeError(`Failed to ${method} URLPattern`);
  }
  return json === null ? null : JSON.parse(json);
}

const components = Symbol('components');
const jsg = __celld.__jsg;

class URLPattern {
  constructor(input, baseURLOrOptions, maybeOptions) {
    let baseURL, options;
    if (typeof baseURLOrOptions === 'string') {
      baseURL = usv(baseURLOrOptions);
      options = maybeOptions;
    } else {
      options = baseURLOrOptions;
    }
    // URLPatternOptions is a dictionary: undefined or null is empty, and a
    // value that is not an object is refused (jsg/struct.h).
    if (maybeOptions !== undefined && maybeOptions !== null &&
        typeof maybeOptions !== 'object' && typeof maybeOptions !== 'function')
      throw jsg.construct('URLPattern', 3, 'URLPatternOptions');
    const ignoreCase = !!(options && options.ignoreCase);
    input = JSON.stringify(toInput(input));
    // workerd's one error for a pattern or base URL that does not parse,
    // which gives no reason.
    let parsed;
    const flags = ignoreCase ? 'ui' : 'u';
    try {
      parsed = JSON.parse($$urlPatternParse(input, baseURL, ignoreCase));
      for (const k of KEYS) {
        const c = parsed[k];
        c.regexp = new RegExp(c.regexpString, flags);
      }
    } catch {
      throw new TypeError('Failed to construct URLPattern');
    }
    this[components] = parsed;
  }

  get protocol() { return this[components].protocol.patternString; }
  get username() { return this[components].username.patternString; }
  get password() { return this[components].password.patternString; }
  get hostname() { return this[components].hostname.patternString; }
  get port() { return this[components].port.patternString; }
  get pathname() { return this[components].pathname.patternString; }
  get search() { return this[components].search.patternString; }
  get hash() { return this[components].hash.patternString; }
  get hasRegExpGroups() { return this[components].hasRegexpGroups; }

  test(input, baseURL) {
    if (baseURL !== undefined) baseURL = usv(baseURL);
    const values = matchValues(toInput(input), baseURL, 'test');
    if (values === null) return false;
    const c = this[components];
    return KEYS.every((k, i) => c[k].regexp.test(values[i]));
  }

  exec(input, baseURL) {
    input = toInput(input);
    if (baseURL !== undefined) baseURL = usv(baseURL);
    const values = matchValues(input, baseURL, 'exec');
    if (values === null) return null;
    // An init input comes back as workerd's URLPatternInit struct, every
    // member optional (`__struct`).
    const inputs = [typeof input === 'string' ? input
      : __celld.__struct([...KEYS, 'baseURL'].map((k) => [k, input[k], true]))];
    if (baseURL !== undefined) inputs.push(baseURL);
    const result = { inputs };
    const c = this[components];
    for (let i = 0; i < 8; i++) {
      const k = KEYS[i];
      const m = c[k].regexp.exec(values[i]);
      if (m === null) return null;
      const groups = {};
      const names = c[k].groupNameList;
      for (let j = 0; j < names.length; j++) groups[names[j]] = m[j + 1];
      result[k] = { input: values[i], groups };
    }
    return result;
  }
}

__celld.__apiTag(URLPattern.prototype, 'URLPattern');

return { URLPattern };
})()
