// The AbortSignal checks in lib/worker/abortsignal-rpc.js, with
// enable_abortsignal_rpc: a signal crosses RPC and its abort follows it, and
// everywhere else refuses it as "only serialized for RPC".
export { Echo, Obj, default } from "#abortsignal-rpc";
