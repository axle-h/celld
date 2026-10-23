import rpc from "rpc";
export default { fetch() { return new Response(typeof rpc); } };
