// A second tenant with one stuck turn, which takes the node to its cap.
export default {
  fetch(request) {
    const ms = Number(new URL(request.url).searchParams.get("ms") ?? "0");
    if (ms > 0) __celldTestHold(ms);
    return new Response("held");
  },
};
