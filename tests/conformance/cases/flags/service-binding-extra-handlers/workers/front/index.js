// `scheduled()` and `queue()` on a service binding, with and without
// service_binding_extra_handlers.
async function attempt(fn) {
  try {
    return { value: await fn() };
  } catch (error) {
    return { error: `${error.name}: ${error.message}` };
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/with-flag") return env.FLAGGED.fetch(request);
    return Response.json({
      scheduledType: typeof env.BACK.scheduled,
      queueType: typeof env.BACK.queue,
      scheduled: await attempt(() => env.BACK.scheduled({ cron: "* * * * *" })),
      queue: await attempt(() => env.BACK.queue("jobs", [{ id: "1" }])),
      reported: Cloudflare.compatibilityFlags.service_binding_extra_handlers,
    });
  },
};
