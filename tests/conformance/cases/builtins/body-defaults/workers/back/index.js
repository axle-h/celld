export default {
  fetch() {
    return new Response("made", { status: 201, statusText: "Made" });
  },
};
