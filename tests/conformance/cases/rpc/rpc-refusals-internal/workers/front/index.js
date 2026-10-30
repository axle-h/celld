// A KV, Queue or D1 binding calls a runtime cell through a Durable Object
// stub, which user code once reached as the binding's `_stub`. Now the
// binding keeps its cell private.
//
// The receiver's refusal of reserved and Object.prototype names, which no
// stub sends, is a unit test
// (`js::rpc_params_tests::reserved_and_object_prototype_names_are_refused`):
// celld has no getRpcMethodForTestOnly(), as workerd has none without the
// experimental flag (`rpc/fetcher-test-only-method`).

// The properties a binding's stub, namespace or cell name was once read
// through.
const STUB_ROUTES = ["_stub", "_namespace", "_cellName", "_queue", "_databaseName", "_database"];

export default {
  async fetch(request, env) {
    // The stubs were once a binding's `_stub`; now nothing a binding holds
    // names its cell. The cells' own method refusals are unit tests
    // (`js::runtime_cell_tests`), since no script reaches a stub to call.
    const reach = (binding) => STUB_ROUTES.filter((name) => name in binding);
    return Response.json({
      kv: reach(env.KV),
      queue: reach(env.QUEUE),
      db: reach(env.DB),
      session: reach(env.DB.withSession()),
      statement: reach(env.DB.prepare("SELECT 1")),
    });
  },
};
