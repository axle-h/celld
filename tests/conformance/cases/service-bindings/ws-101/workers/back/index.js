// A stateless Worker that accepts the server end of a WebSocketPair and
// returns the client end in a 101. The front reaches it through a service
// binding, so the socket is held in this script's isolate, not the front's.
//
// Every socket has a close listener that answers the peer's Close with the
// same code: before 2026-04-07 nothing replies automatically
// (web_socket_auto_reply_to_close).
import { serve } from "../../shared.js";

export default {
  fetch(request) {
    return serve(request, "back");
  },
};
