export default {
  fetch(request) {
    return Response.json({ length: request.cf.big.length });
  },
};
