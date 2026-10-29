// A D1 query past the query limit (Cloudflare's 30 s; the case sets 300 ms
// with CELLD_D1_QUERY_LIMIT_MS) fails with D1's error, its call's writes roll
// back, and the database serves the next query.
const RUNAWAY = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) AS n FROM c";

async function outcome(call) {
  try {
    return { value: await call() };
  } catch (error) {
    return { error: error.message };
  }
}

export default {
  async fetch(request, env) {
    const db = env.DB;
    switch (new URL(request.url).pathname) {
      case "/setup":
        await db.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
        return Response.json("ready");
      case "/prepared":
        return Response.json(await outcome(() => db.prepare(RUNAWAY).first("n")));
      case "/batch":
        return Response.json(
          await outcome(() =>
            db.batch([db.prepare("INSERT INTO t VALUES ('doomed')"), db.prepare(RUNAWAY)]),
          ),
        );
      case "/exec":
        return Response.json(await outcome(() => db.exec(`INSERT INTO t VALUES ('doomed'); ${RUNAWAY}`)));
      case "/next":
        await db.prepare("INSERT INTO t VALUES ('kept')").run();
        return Response.json(await outcome(async () => (await db.prepare("SELECT v FROM t").all()).results));
    }
    return new Response("not found", { status: 404 });
  },
};
