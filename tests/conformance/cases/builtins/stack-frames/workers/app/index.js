// A stack's frames down to the handler, by function name: the locations
// differ between the two bundles, and Wrangler's dev middleware calls the
// handler on workerd.
function frames(stack) {
  const lines = String(stack).split("\n");
  const kept = [lines[0]];
  for (const line of lines.slice(1)) {
    kept.push(line.replace(/ \(.*\)$/, "").replace(/ [^ ]*:\d+:\d+$/, " <location>"));
    if (/ Object\.fetch$/.test(line.replace(/ \(.*\)$/, ""))) break;
  }
  return kept;
}
function stackOf(run) {
  try {
    run();
    return "no throw";
  } catch (error) {
    return frames(error.stack);
  }
}
async function asyncStackOf(run) {
  try {
    await run();
    return "no throw";
  } catch (error) {
    return frames(error.stack);
  }
}
function badStatus() {
  return new Response(null, { status: 99 });
}
function badHeader() {
  new Headers().set("bad name", "x");
}
function throwInToString() {
  new Response({
    toString() {
      throw new Error("from toString");
    },
  });
}
function domException() {
  throw new DOMException("dom", "DataError");
}
class Mine extends DOMException {
  constructor() {
    super("sub", "DataError");
  }
}
function subclass() {
  throw new Mine();
}
function parseDirect() {
  JSON.parse("{");
}
function parseAliased() {
  const parse = JSON.parse;
  parse("{");
}
// A setter on Array.prototype sees no call site.
function prototypeSetter() {
  let seen = 0;
  Object.defineProperty(Array.prototype, "0", {
    configurable: true,
    set() { seen++; },
    get() { return undefined; },
  });
  const previous = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (error, sites) => sites.length > 0;
    const prepared = new Error("x").stack;
    Error.prepareStackTrace = previous;
    const plain = String(new Error("y").stack).split("\n")[0];
    return { seen, prepared, plain };
  } finally {
    Error.prepareStackTrace = previous;
    delete Array.prototype[0];
  }
}
function stringifyCycle() {
  const cycle = {};
  cycle.self = cycle;
  JSON.stringify(cycle);
}
async function badJson() {
  await new Response("{").json();
}
function captured() {
  const target = {};
  Error.captureStackTrace(target);
  return frames(target.stack);
}
function prepared() {
  const previous = Error.prepareStackTrace;
  Error.prepareStackTrace = (error, sites) =>
    sites.map((site) => `${site.getFunctionName()} ${typeof site.getFileName()}`).slice(0, 2);
  try {
    return new Error("prepared").stack;
  } finally {
    Error.prepareStackTrace = previous;
  }
}
export default {
  async fetch() {
    return Response.json({
      badStatus: stackOf(badStatus),
      badHeader: stackOf(badHeader),
      throwInToString: stackOf(throwInToString),
      domException: stackOf(domException),
      subclass: stackOf(subclass),
      badJson: await asyncStackOf(badJson),
      parseDirect: stackOf(parseDirect),
      parseAliased: stackOf(parseAliased),
      prototypeSetter: prototypeSetter(),
      stringifyCycle: stackOf(stringifyCycle),
      jsonNames: [JSON.parse.name, JSON.parse.length, String(JSON.parse), JSON.stringify.name, JSON.stringify.length, String(JSON.stringify)],
      captured: captured(),
      prepared: prepared(),
    });
  },
};
