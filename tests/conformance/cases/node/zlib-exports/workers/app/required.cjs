// A CommonJS module's view of node:zlib, for the identity checks in index.js.
module.exports = { bare: require("zlib"), prefixed: require("node:zlib") };
