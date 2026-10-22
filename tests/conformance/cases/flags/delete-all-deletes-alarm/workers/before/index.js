import { Base, report } from "../../object.js";

export class BeforeObject extends Base {}

export default {
  fetch(request, env) {
    return report(env);
  },
};
