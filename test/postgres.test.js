const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDb, Pool } = require("../src/db");
const { hash } = require("../src/auth");
test(
  "PostgreSQL migration, concurrent budget, token ownership and session rotation",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    t.after(() => pool.end());
    // Dedicated disposable database only. Never accept the production variable here.
    await pool.query(
      "DROP TABLE IF EXISTS usage_reservations,usage_daily,verified_subscriptions,sessions,usage_monthly,users CASCADE",
    );
    await pool.query(
      "CREATE TABLE users (google_sub TEXT PRIMARY KEY,email TEXT,trial_start_ts BIGINT NOT NULL,created_at TIMESTAMPTZ DEFAULT now(),is_subscribed BOOLEAN DEFAULT false)",
    );
    await pool.query(
      "INSERT INTO users(google_sub,trial_start_ts,is_subscribed) VALUES('old',123,true)",
    );
    const db = createDb(pool);
    await db.initSchema();
    await db.initSchema();
    assert.equal(await db.upsertUser("old", "test@example.invalid"), 123);
    await db.upsertUser("other", "other@example.invalid");
    const config = {
      CLAUDE_MONTHLY_BUDGET_USD: 0.1,
      USER_DAILY_BUDGET_USD: 1,
      USER_DAILY_REQUESTS: 100,
    };
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => db.reserveUsage("old", 0.06, config)),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    assert.equal(ok.length, 1);
    assert.equal(await db.getMonthlyCostUsd(), 0.06);
    await db.settleUsage(ok[0].value, 0.01);
    await db.settleUsage(ok[0].value, 0);
    assert.equal(await db.getMonthlyCostUsd(), 0.01);
    const row = {
      token_hash: hash("purchase"),
      google_sub: "old",
      token_cipher: "encrypted",
      product_id: "sku",
      state: "SUBSCRIPTION_STATE_ACTIVE",
      expires_at: Date.now() + 1000,
      verified_at: Date.now(),
      acknowledged: false,
    };
    const claims = await Promise.allSettled([
      db.saveSubscription(row),
      db.saveSubscription({ ...row, google_sub: "other" }),
    ]);
    assert.equal(claims.filter((r) => r.status === "fulfilled").length, 1);
    await db.createSession(
      "a",
      "r",
      "old",
      Date.now() + 1000,
      Date.now() + 2000,
    );
    const rotations = await Promise.all([
      db.rotateSession("r", "b", "s", Date.now() + 1000),
      db.rotateSession("r", "c", "t", Date.now() + 1000),
    ]);
    assert.equal(rotations.filter(Boolean).length, 1);
    assert.equal(await db.findSession("a"), undefined);
  },
);
