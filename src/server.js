const { loadConfig } = require("./config");
const { Pool, createDb } = require("./db");
const { createApp } = require("./index");
const Anthropic = require("@anthropic-ai/sdk");
async function main() {
  const config = loadConfig();
  const db = createDb(
    new Pool({
      connectionString: config.DATABASE_URL,
      connectionTimeoutMillis: 10000,
      statement_timeout: 15000,
    }),
  );
  await db.initSchema();
  const app = createApp({
    db,
    config,
    claudeClient: new Anthropic({
      apiKey: config.CLAUDE_API_KEY,
      maxRetries: 0,
      timeout: 30000,
    }),
  });
  const server = app.listen(config.PORT, () =>
    console.log("Relembot API v2 pronta"),
  );
  let running = false;
  const reconcile = async () => {
    if (running) return;
    running = true;
    try {
      await app.locals.billing.reconcile();
    } catch {
      console.error("[reconcile] unavailable");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(reconcile, 60000);
  timer.unref();
  reconcile();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      clearInterval(timer);
      server.close(() => db.pool.end());
    });
}
main().catch(() => {
  console.error(
    "Inicialização falhou. Confira configuração, credenciais e banco.",
  );
  process.exitCode = 1;
});
