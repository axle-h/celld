// Another Worker on the node, which keeps serving while the others' isolates
// are condemned.
export default { fetch: () => new Response("other ok") };
