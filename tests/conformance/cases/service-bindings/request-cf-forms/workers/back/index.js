// The same server as front's `serve`.
// Whether `cf` and an object in it are frozen, too.
const serve = (request) => {
  const cf = request.cf;
  if (cf === undefined || cf === null) return Response.json(cf === undefined ? "undefined" : null);
  return Response.json({
    cf,
    frozen: Object.isFrozen(cf),
    nestedFrozen: typeof cf.nested === "object" ? Object.isFrozen(cf.nested) : null,
  });
};

export default { fetch: serve };
