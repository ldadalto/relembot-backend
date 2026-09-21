const { Pool } = require("pg");
const { randomUUID } = require("node:crypto");
const { HttpError } = require("./errors");
function createDb(pool) {
  async function tx(work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  return {
    pool,
    async initSchema() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (google_sub TEXT PRIMARY KEY, email TEXT, trial_start_ts BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, refresh_hash TEXT UNIQUE NOT NULL, google_sub TEXT NOT NULL REFERENCES users(google_sub) ON DELETE CASCADE, expires_at BIGINT NOT NULL, refresh_expires_at BIGINT NOT NULL);
        CREATE TABLE IF NOT EXISTS verified_subscriptions (token_hash TEXT PRIMARY KEY, google_sub TEXT NOT NULL REFERENCES users(google_sub) ON DELETE CASCADE, token_cipher TEXT NOT NULL, product_id TEXT NOT NULL, state TEXT NOT NULL, expires_at BIGINT NOT NULL, verified_at BIGINT NOT NULL, acknowledged BOOLEAN NOT NULL DEFAULT false);
        CREATE INDEX IF NOT EXISTS subscriptions_user ON verified_subscriptions(google_sub);
        CREATE TABLE IF NOT EXISTS usage_monthly (month_key TEXT PRIMARY KEY, total_cost_usd NUMERIC NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS usage_daily (day_key TEXT NOT NULL, google_sub TEXT NOT NULL, cost_usd NUMERIC NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day_key, google_sub));
        CREATE TABLE IF NOT EXISTS usage_reservations (id UUID PRIMARY KEY, month_key TEXT NOT NULL, day_key TEXT NOT NULL, google_sub TEXT NOT NULL, reserved_usd NUMERIC NOT NULL, settled BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      `);
      // The old self-reported users.is_subscribed column is deliberately never read.
    },
    async upsertUser(sub, email) {
      const r = await pool.query(
        "INSERT INTO users(google_sub,email,trial_start_ts) VALUES($1,$2,$3) ON CONFLICT(google_sub) DO UPDATE SET email=EXCLUDED.email RETURNING trial_start_ts",
        [sub, email, Date.now()],
      );
      return Number(r.rows[0].trial_start_ts);
    },
    async getUser(sub) {
      return (
        await pool.query("SELECT * FROM users WHERE google_sub=$1", [sub])
      ).rows[0];
    },
    async createSession(token, refresh, sub, expires, refreshExpires) {
      await pool.query("INSERT INTO sessions VALUES($1,$2,$3,$4,$5)", [
        token,
        refresh,
        sub,
        expires,
        refreshExpires,
      ]);
    },
    async findSession(token) {
      return (
        await pool.query(
          "SELECT u.google_sub,u.trial_start_ts FROM sessions s JOIN users u USING(google_sub) WHERE s.token_hash=$1 AND s.expires_at>$2",
          [token, Date.now()],
        )
      ).rows[0];
    },
    async rotateSession(oldRefresh, token, refresh, expires) {
      const r = await pool.query(
        "UPDATE sessions SET token_hash=$2,refresh_hash=$3,expires_at=$4 WHERE refresh_hash=$1 AND refresh_expires_at>$5 RETURNING google_sub",
        [oldRefresh, token, refresh, expires, Date.now()],
      );
      return r.rows[0] ? this.getUser(r.rows[0].google_sub) : null;
    },
    async getSubscriptions(sub) {
      return (
        await pool.query(
          "SELECT * FROM verified_subscriptions WHERE google_sub=$1",
          [sub],
        )
      ).rows;
    },
    async getSubscription(token) {
      return (
        await pool.query(
          "SELECT * FROM verified_subscriptions WHERE token_hash=$1",
          [token],
        )
      ).rows[0];
    },
    async saveSubscription(row) {
      const r = await pool.query(
        `INSERT INTO verified_subscriptions VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(token_hash) DO UPDATE SET product_id=EXCLUDED.product_id,state=EXCLUDED.state,expires_at=EXCLUDED.expires_at,verified_at=EXCLUDED.verified_at,acknowledged=EXCLUDED.acknowledged
        WHERE verified_subscriptions.google_sub=EXCLUDED.google_sub RETURNING token_hash`,
        [
          row.token_hash,
          row.google_sub,
          row.token_cipher,
          row.product_id,
          row.state,
          row.expires_at,
          row.verified_at,
          row.acknowledged,
        ],
      );
      if (!r.rowCount) throw new HttpError(409, "purchase_already_linked");
    },
    async reconciliationCandidates() {
      return (
        await pool.query(
          "SELECT * FROM verified_subscriptions WHERE verified_at < $1 AND (expires_at > $2 OR state NOT IN ('SUBSCRIPTION_STATE_EXPIRED','SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED')) ORDER BY verified_at LIMIT 100",
          [Date.now() - 300000, Date.now()],
        )
      ).rows;
    },
    async reserveUsage(sub, reserve, config) {
      const month = new Date().toISOString().slice(0, 7),
        day = new Date().toISOString().slice(0, 10);
      return tx(async (c) => {
        // One lock order for all instances prevents concurrent requests overspending the balance.
        await c.query("SELECT pg_advisory_xact_lock(87194001)");
        await c.query(
          "INSERT INTO usage_monthly(month_key) VALUES($1) ON CONFLICT DO NOTHING",
          [month],
        );
        await c.query(
          "INSERT INTO usage_daily(day_key,google_sub) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [day, sub],
        );
        const m = (
          await c.query(
            "SELECT total_cost_usd FROM usage_monthly WHERE month_key=$1",
            [month],
          )
        ).rows[0];
        const d = (
          await c.query(
            "SELECT cost_usd,requests FROM usage_daily WHERE day_key=$1 AND google_sub=$2",
            [day, sub],
          )
        ).rows[0];
        if (
          Number(m.total_cost_usd) + reserve >
          config.CLAUDE_MONTHLY_BUDGET_USD
        )
          throw new HttpError(503, "ai_budget_exceeded");
        if (
          Number(d.cost_usd) + reserve > config.USER_DAILY_BUDGET_USD ||
          d.requests >= config.USER_DAILY_REQUESTS
        )
          throw new HttpError(429, "daily_limit");
        await c.query(
          "UPDATE usage_monthly SET total_cost_usd=total_cost_usd+$2,updated_at=now() WHERE month_key=$1",
          [month, reserve],
        );
        await c.query(
          "UPDATE usage_daily SET cost_usd=cost_usd+$3,requests=requests+1 WHERE day_key=$1 AND google_sub=$2",
          [day, sub, reserve],
        );
        const id = randomUUID();
        await c.query(
          "INSERT INTO usage_reservations(id,month_key,day_key,google_sub,reserved_usd) VALUES($1,$2,$3,$4,$5)",
          [id, month, day, sub, reserve],
        );
        return id;
      });
    },
    async settleUsage(id, actual) {
      await tx(async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(87194001)");
        const r = (
          await c.query(
            "UPDATE usage_reservations SET settled=true WHERE id=$1 AND NOT settled RETURNING *",
            [id],
          )
        ).rows[0];
        if (!r) return;
        const delta = Number((actual - Number(r.reserved_usd)).toFixed(12));
        await c.query(
          "UPDATE usage_monthly SET total_cost_usd=total_cost_usd+$2,updated_at=now() WHERE month_key=$1",
          [r.month_key, delta],
        );
        await c.query(
          "UPDATE usage_daily SET cost_usd=cost_usd+$3 WHERE day_key=$1 AND google_sub=$2",
          [r.day_key, r.google_sub, delta],
        );
      });
    },
    async getMonthlyCostUsd() {
      return Number(
        (
          await pool.query(
            "SELECT total_cost_usd FROM usage_monthly WHERE month_key=$1",
            [new Date().toISOString().slice(0, 7)],
          )
        ).rows[0]?.total_cost_usd || 0,
      );
    },
    async maintenance() {
      await pool.query("DELETE FROM sessions WHERE refresh_expires_at < $1", [
        Date.now(),
      ]);
      await pool.query(
        "DELETE FROM usage_reservations WHERE settled AND created_at < now()-interval '90 days'",
      );
      await pool.query(
        "DELETE FROM usage_daily WHERE day_key < to_char(now()-interval '90 days','YYYY-MM-DD')",
      );
    },
  };
}
module.exports = { createDb, Pool };
