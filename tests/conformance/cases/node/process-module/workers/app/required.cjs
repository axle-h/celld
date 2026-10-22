// A CommonJS dependency that requires `process` by both names.
module.exports = {
  bare: require("process"),
  prefixed: require("node:process"),
};
