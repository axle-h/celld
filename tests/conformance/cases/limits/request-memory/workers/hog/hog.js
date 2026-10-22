// Allocates past the 128 MiB heap limit in a request: either retained
// gradually, or as one allocation that must be allowed to finish before the
// termination lands. The one allocation is a 400 MB two-byte string, past
// the limit by a wide margin and well under V8's largest string, so a V8
// upgrade does not turn it into a RangeError.
export function hog(mode) {
  if (mode === "one") return "\u1234".repeat(2e8).toLowerCase().length;
  const keep = [];
  for (let i = 0; i < 8e6; i++) keep.push([i, 1, 2]);
  return keep.length;
}
