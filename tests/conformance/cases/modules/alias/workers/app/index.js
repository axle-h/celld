import file from "virtual-file";
import noext from "virtual-noext";
import dir from "virtual-dir";
import outside from "@scope/outside";
import path from "node:path";
// Not aliased: only node:path is.
import { posix } from "path";
// A relative key, which no file backs, from this file and from one in
// another directory.
import generated from "./generated/module.js";
import nested from "./lib/nested/importer.js";
// The key "./lib/file" matches only itself: "./lib/file.js" contains it and
// resolves as usual. So does "./lib/dir/entry.js", a subpath of the key
// "./lib/dir".
import relativeKey from "./lib/file";
import containsKey from "./lib/file.js";
import subpath from "./lib/dir/entry.js";
import relativeDir from "./lib/dir";
// Packages: Node resolves capnweb by its `require` condition, esbuild by
// `workerd`, so the two are different builds. wrangler's exports map
// "./package.json".
import * as rpc from "rpc";
import * as capnweb from "capnweb";
import wranglerPackage from "wrangler-package";

export default {
  fetch() {
    return Response.json({
      file,
      noext,
      dir,
      outside,
      path,
      unaliased: typeof posix.join,
      generated,
      nested,
      relativeKey,
      containsKey,
      subpath,
      relativeDir,
      rpc: typeof rpc.RpcTarget,
      rpcIsTheWorkerdBuild: rpc.RpcTarget === capnweb.RpcTarget,
      wranglerPackage: wranglerPackage.name,
    });
  },
};
