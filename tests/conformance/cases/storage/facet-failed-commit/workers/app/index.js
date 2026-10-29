// A facet whose turn cannot commit (plan 1.59, found by 1.30): a deferred
// foreign key its write violated. On workerd the facet resets: the call
// fails, and the next call through a fresh facet stub reaches a new
// instance on storage without the write. celld's facet fails closed, every
// call refused, until its root object moves; a root object resets
// (`storage/reset-failed-commit`).
import { DurableObject } from "cloudflare:workers";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return `threw ${error.message.slice(0, 60)}`;
  }
}

export class Child extends DurableObject {
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

export class Root extends DurableObject {
  #child() {
    return this.ctx.facets.get("child", () => ({ class: this.ctx.exports.Child }));
  }

  async run() {
    const setup = await attempt(() => this.#child().setup());
    const violate = await attempt(() => this.#child().violate());
    await sleep(200);
    return { setup, violate, after: await attempt(() => this.#child().read()) };
  }
}

export default {
  async fetch(request, env) {
    return Response.json(await env.ROOT.getByName("root").run());
  },
};
