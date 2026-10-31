# The workerd config lib/workerd-direct.mjs records this case's transcript
# with: the case's Worker, with a network service that reaches loopback as its
# globalOutbound, so its sockets reach the upstream from workerd.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "app", worker = .app),
    (name = "internet", network = (allow = ["public", "private", "local"])),
  ],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "app")],
);

const app :Workerd.Worker = (
  modules = [(name = "index.js", esModule = embed "workers/app/index.js")],
  compatibilityDate = "2026-09-04",
  globalOutbound = "internet",
);
