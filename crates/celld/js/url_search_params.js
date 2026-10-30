// URLSearchParams (WHATWG spec subset)
{
// Decode application/x-www-form-urlencoded per spec:
// + -> space, percent-decode to bytes (only strict 2-hex
// sequences -- stray % is literal), UTF-8 decode with
// replacement. ignoreBOM so a leading U+FEFF survives
// round-trip through percent-encoding.
const _hexRe = /^[0-9A-Fa-f]{2}$/;
const _uspDecode = (s) => {
  s = s.replace(/\+/g, ' ');
  const bytes = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '%' && i + 2 < s.length
        && _hexRe.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 3;
      continue;
    }
    const c = s.charCodeAt(i);
    if (c < 0x80) { bytes.push(c); i++; continue; }
    // Handle astral chars: consume the surrogate pair
    // (or lone surrogate, which encodes as U+FFFD).
    const consumed = c >= 0xD800 && c <= 0xDBFF
      && i + 1 < s.length
      && s.charCodeAt(i + 1) >= 0xDC00
      && s.charCodeAt(i + 1) <= 0xDFFF ? 2 : 1;
    for (const b of new TextEncoder()
        .encode(s.slice(i, i + consumed)))
      bytes.push(b);
    i += consumed;
  }
  return new TextDecoder(
    'utf-8', { ignoreBOM: true }
  ).decode(new Uint8Array(bytes));
};

// Convert a DOMString to a USVString: replace each lone
// surrogate (unpaired high/low) with U+FFFD.
const _surrogateRe = /[\uD800-\uDFFF]/;
const _toUSVString = (s) => {
  // ToString, which throws for a Symbol, as JSG's conversion does.
  s = `${s}`;
  if (!_surrogateRe.test(s)) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      if (i + 1 < s.length) {
        const n = s.charCodeAt(i + 1);
        if (n >= 0xDC00 && n <= 0xDFFF) {
          out += s[i] + s[i + 1];
          i += 2;
          continue;
        }
      }
      out += '\uFFFD';
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      out += '\uFFFD';
    } else {
      out += s[i];
    }
    i++;
  }
  return out;
};

// Encode per application/x-www-form-urlencoded: the only unescaped bytes are
// ASCII alphanumerics and * - . _ (space becomes +). encodeURIComponent also
// leaves ! ' ( ) ~ alone, so those are escaped explicitly.
const _uspEncode = (s) =>
  encodeURIComponent(s)
    .replace(/%20/g, '+')
    .replace(/[!'()~]/g, (c) =>
      '%' + c.charCodeAt(0).toString(16).toUpperCase());

const _parseString = (s) => {
  const params = [];
  if (!s) return params;
  for (const pair of s.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) {
      params.push([_uspDecode(pair), '']);
    } else {
      params.push([
        _uspDecode(pair.slice(0, eq)),
        _uspDecode(pair.slice(eq + 1)),
      ]);
    }
  }
  return params;
};

const _jsg = __celld.__jsg;
// A required USVString parameter of a method (`count` of them), which the
// call must not leave out.
const _required = (args, count, method) => {
  if (args.length < count)
    throw _jsg.execute(method, 'URLSearchParams', args.length + 1, 'USVString');
};

// The parameter list of a URLSearchParams, for its iterators.
let paramsOf;
class URLSearchParams {
  #params = [];
  _url = null; // live-bound URL, if any

  // workerd's init is a sequence of pairs, a record or a string, tried in
  // that order (url-standard.h `Initializer`): anything but an object,
  // `null` included, converts to a string.
  constructor(init) {
    if (init === undefined) return;
    // WebIDL `object` includes callables, so a class or function is a
    // valid record init (e.g. `new URLSearchParams(DOMException)`
    // enumerates its constants).
    if (typeof init !== 'object' && typeof init !== 'function' ||
        init === null) {
      const s = _toUSVString(init);
      this.#params = _parseString(s.startsWith('?') ? s.slice(1) : s);
    } else {
      // Check for iterable (Symbol.iterator) first.
      if (typeof init[Symbol.iterator]
            === 'function') {
        for (const pair of init) {
          // Each pair is itself a sequence, which a string is not
          // (jsg/iterator.h `Sequence`).
          if (pair === null || typeof pair !== 'object' &&
              typeof pair !== 'function' ||
              typeof pair[Symbol.iterator] !== 'function')
            throw _jsg.other('Sequence');
          const arr = [...pair];
          if (arr.length !== 2)
            throw new TypeError('Invalid URL search params sequence.');
          this.#params.push([
            _toUSVString(arr[0]),
            _toUSVString(arr[1]),
          ]);
        }
      } else {
        // Record conversion: USVString-normalize keys
        // and dedupe (last value wins, first position
        // kept -- matches WebIDL ordered-map semantics).
        const byKey = new Map();
        const order = [];
        for (const [k, v] of Object.entries(init)) {
          const nk = _toUSVString(k);
          if (!byKey.has(nk)) order.push(nk);
          byKey.set(nk, _toUSVString(v));
        }
        for (const nk of order)
          this.#params.push([nk, byKey.get(nk)]);
      }
    }
  }

  #sync() {
    if (this._url) this._url._updateSearch(this);
  }

  _initFromSearch(search) {
    const s = search.startsWith('?')
      ? search.slice(1) : search;
    this.#params = _parseString(s);
  }

  get(name) {
    _required(arguments, 1, 'get');
    name = _toUSVString(name);
    const p = this.#params.find(
      ([k]) => k === name);
    return p ? p[1] : null;
  }

  getAll(name) {
    _required(arguments, 1, 'getAll');
    name = _toUSVString(name);
    return this.#params.filter(
      ([k]) => k === name).map(([, v]) => v);
  }

  has(name, value) {
    _required(arguments, 1, 'has');
    name = _toUSVString(name);
    if (value !== undefined) {
      value = _toUSVString(value);
      return this.#params.some(
        ([k, v]) => k === name && v === value);
    }
    return this.#params.some(([k]) => k === name);
  }

  set(name, value) {
    _required(arguments, 2, 'set');
    name = _toUSVString(name);
    value = _toUSVString(value);
    let found = false;
    this.#params = this.#params.filter(([k]) => {
      if (k === name && !found) {
        found = true; return true;
      }
      return k !== name;
    });
    if (found) {
      const i = this.#params.findIndex(
        ([k]) => k === name);
      this.#params[i][1] = value;
    } else {
      this.#params.push([name, value]);
    }
    this.#sync();
  }

  append(name, value) {
    _required(arguments, 2, 'append');
    this.#params.push(
      [_toUSVString(name), _toUSVString(value)]);
    this.#sync();
  }

  delete(name, value) {
    _required(arguments, 1, 'delete');
    name = _toUSVString(name);
    if (value !== undefined) {
      value = _toUSVString(value);
      this.#params = this.#params.filter(
        ([k, v]) => !(k === name && v === value));
    } else {
      this.#params = this.#params.filter(
        ([k]) => k !== name);
    }
    this.#sync();
  }

  sort() {
    this.#params.sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    this.#sync();
  }

  toString() {
    return this.#params
      .map(([k, v]) =>
        `${_uspEncode(k)}=${_uspEncode(v)}`)
      .join('&');
  }

  // workerd's iterators (JSG_ITERATOR) read the live list by index, and
  // their steps are its `Next` struct.
  entries() { return new URLSearchParamsIterator(this, 2); }
  keys() { return new URLSearchParamsIterator(this, 0); }
  values() { return new URLSearchParamsIterator(this, 1); }
  static {
    paramsOf = (search) => search.#params;
  }
  [Symbol.iterator]() { return this.entries(); }

  forEach(callback, thisArg) {
    if (typeof callback !== 'function')
      throw _jsg.execute('forEach', 'URLSearchParams', 1, 'function');
    for (let i = 0; i < this.#params.length; i++) {
      callback.call(
        thisArg, this.#params[i][1],
        this.#params[i][0], this);
    }
  }

  get size() { return this.#params.length; }
}

class URLSearchParamsIterator {
  #search;
  #kind;
  #index = 0;
  constructor(search, kind) {
    this.#search = search;
    this.#kind = kind;
  }
  next() {
    const params = paramsOf(this.#search);
    if (this.#index >= params.length) return __celld.__iterResult(true);
    const pair = params[this.#index++];
    return __celld.__iterResult(false,
      this.#kind === 2 ? [pair[0], pair[1]] : pair[this.#kind]);
  }
}
Object.setPrototypeOf(URLSearchParamsIterator.prototype,
  Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())));

globalThis.URLSearchParams = URLSearchParams;
__celld.__apiTag(URLSearchParams.prototype, 'URLSearchParams');
} // end block scope
