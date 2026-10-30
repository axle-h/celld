import { probe } from "../../probe.js";
export default { async fetch() { return Response.json(await probe()); } };
