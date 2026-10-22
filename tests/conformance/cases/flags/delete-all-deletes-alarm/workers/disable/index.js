import { Base, report } from "../../object.js";

export class DisableObject extends Base {}

export default {
  fetch(request, env) {
    return report(env);
  },
};
