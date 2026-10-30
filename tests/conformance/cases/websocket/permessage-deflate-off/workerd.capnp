# The workerd config lib/workerd-direct.mjs records this case's transcript
# with: the case's Worker, served by workerd itself.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(name = "app", worker = .app)],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "app")],
);

const app :Workerd.Worker = (
  modules = [(name = "index.js", esModule = embed "workers/app/index.js")],
  compatibilityDate = "2026-09-04",
  compatibilityFlags = ["no_web_socket_compression"],
);
