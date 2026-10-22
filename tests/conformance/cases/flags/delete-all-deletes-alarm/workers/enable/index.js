import { Base, report } from "../../object.js";

export class EnableObject extends Base {}

export default {
  fetch(request, env) {
    return report(env);
  },
};
