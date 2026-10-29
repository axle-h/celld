// The AbortSignal checks in lib/worker/abortsignal-rpc.js, without the
// experimental enable_abortsignal_rpc flag: every serialization of a signal
// fails with "AbortSignal serialization is not enabled.".
export { Echo, Obj, default } from "#abortsignal-rpc";
