// A turn's writes that cannot commit reset the object (plan 1.30): a
// deferred foreign key, violated by a write the turn made, fails the commit
// at the turn's end. The call that made the write fails, the stub that made
// it stays broken, and a fresh stub reaches a new instance, on storage that
// never held the write. celld used to keep the instance, failed closed.
import { DurableObject } from "cloudflare:workers";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return `threw ${error.name}: ${error.message}`;
  }
}

export class Obj extends DurableObject {
  state = "new";

  setup() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS parent (id INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS child (
        parent INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);`);
    return "set up";
  }

  async violate() {
    this.state = "old";
    this.ctx.storage.sql.exec("INSERT INTO child VALUES (99)");
    // The turn ends here, and its commit fails.
    await sleep(10);
    return "returned";
  }

  read() {
    return {
      state: this.state,
      rows: this.ctx.storage.sql.exec("SELECT count(*) AS n FROM child").one().n,
    };
  }
}

export default {
  async fetch(request, env) {
    const stub = env.OBJ.getByName("x");
    const setup = await attempt(() => stub.setup());
    const violate = await attempt(() => stub.violate());
    await sleep(200);
    return Response.json({
      setup,
      violate,
      stale: await attempt(() => stub.read()),
      fresh: await attempt(() => env.OBJ.getByName("x").read()),
    });
  },
};
