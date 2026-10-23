const tables = async (db) =>
  (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'written'").all()).results.length;

export default {
  async fetch(request, env) {
    return Response.json({
      bucketProd: (await env.PROD.get("written")) !== null,
      bucketPreview: (await env.PREVIEW.get("written")) !== null,
      dbProd: await tables(env.DB_PROD),
      dbPreview: await tables(env.DB_PREVIEW),
    });
  },
};
