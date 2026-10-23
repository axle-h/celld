import file from "virtual-file";
import noext from "virtual-noext";
import dir from "virtual-dir";
import outside from "@scope/outside";
import path from "node:path";
// Not aliased: only node:path is.
import { posix } from "path";

export default {
  fetch() {
    return Response.json({ file, noext, dir, outside, path, unaliased: typeof posix.join });
  },
};
