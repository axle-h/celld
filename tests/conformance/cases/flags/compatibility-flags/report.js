// Cloudflare.compatibilityFlags for the flags celld honours: the value
// workerd computes from the date and flags, on a sealed object without a
// prototype whose properties are read-only.
const HONOURED = [
  "nodejs_compat",
  "nodejs_compat_v2",
  "nodejs_compat_populate_process_env",
  "nodejs_als",
  "service_binding_extra_handlers",
  "js_rpc",
  "queues_json_messages",
  "fetcher_no_get_put_delete",
  "disallow_importable_env",
  "assets_navigation_prefers_asset_serving",
  "allow_irrevocable_stub_storage",
  "rpc_params_dup_stubs",
  "delete_all_deletes_alarm",
  "websocket_standard_binary_type",
  "web_socket_auto_reply_to_close",
  "enhanced_error_serialization",
  "enable_nodejs_global_timers",
  "cache_option_enabled",
  "cache_no_cache_enabled",
  "fetch_iterable_type_support",
  "fetch_iterable_type_support_override_adjustment",
  "encoder_stream_spec_compliant_backpressure",
  "fixup-transform-stream-backpressure",
  "blob_standard_mime_type",
  "set_tostring_tag",
  "python_workers",
  "python_workers_20250116",
  "python_no_global_handlers",
  "python_workers_force_new_vendor_path",
  "enable_python_external_sdk",
  "python_workflows_implicit_dependencies",
  "python_request_headers_preserve_commas",
  "python_process_pth_files",
  "python_workers_20260610",
  "python_workers_314",
  "enable_request_signal",
  "workflows_enable_fast_engine_creation",
  "spec_compliant_dispatch_exceptions",
  "throw_on_unrecognized_import_assertion",
  "internal_writable_stream_abort_clears_queue",
  "bind_asynclocalstorage_snapshot_to_request",
  "unhandled_rejection_after_microtask_checkpoint",
  "queue_expose_error_codes",
  "enable_fast_jsg_struct",
  "strip_bom_in_read_all_text",
  "text_decoder_replace_surrogates",
  "websocket_close_reason_byte_limit",
  "writable_stream_spec_compliant_writer",
  "enable_nodejs_perf_hooks_module",
  "enable_global_performance_classes",
  "allow_eval_during_startup",
];

// Flags celld always behaves as on. celld reports one, as true, only where
// workerd computes it on too, so only whether each is true is compared.
const ALWAYS_ON = [
  "url_standard",
  "capture_async_api_throws",
  "upper_case_all_http_methods",
  "enable_ctx_exports",
];

export function report() {
  const flags = Cloudflare.compatibilityFlags;
  const descriptor = Object.getOwnPropertyDescriptor(flags, "nodejs_compat");
  // Module code is strict, so a write to a read-only property throws.
  let assigned;
  try {
    flags.nodejs_compat = "changed";
    assigned = "no error";
  } catch (error) {
    assigned = error.name;
  }
  return Response.json({
    values: Object.fromEntries(HONOURED.map((name) => [name, flags[name] ?? null])),
    alwaysOn: Object.fromEntries(ALWAYS_ON.map((name) => [name, flags[name] === true])),
    prototype: Object.getPrototypeOf(flags),
    sealed: Object.isSealed(flags),
    frozen: Object.isFrozen(flags),
    descriptor,
    assigned,
    unknown: flags.no_such_flag ?? null,
  });
}
