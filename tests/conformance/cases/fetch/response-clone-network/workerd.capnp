# The workerd config lib/workerd-direct.mjs records this case's transcript
# with: the case's Worker and the `#clone` module it imports, with a network
# service that reaches loopback as its globalOutbound, so workerd itself
# follows the upstream's redirects.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "app", worker = .app),
    (name = "internet", network = (allow = ["public", "private", "local"])),
  ],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "app")],
);

const app :Workerd.Worker = (
  modules = [
    (name = "index.js", esModule = embed "workers/app/index.js"),
    (name = "#clone", esModule = embed "../../../lib/worker/clone.js"),
  ],
  compatibilityDate = "2026-01-01",
  globalOutbound = "internet",
);
