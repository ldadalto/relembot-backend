const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      google_sub TEXT PRIMARY KEY,
      email TEXT,
      trial_start_ts BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Status de assinatura auto-declarado pelo app (BillingManager consulta o Play
  // Billing no aparelho e reporta o resultado aqui via POST /billing/sync). Não é
  // verificação server-side do token de compra junto ao Google — fica sujeito a
  // um app adulterado mentir sobre isso — mas já é muito melhor do que a trava
  // hoje inexistente, e cobre 100% dos casos normais (app original, sem root).
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_subscribed BOOLEAN NOT NULL DEFAULT false;
  `);

  // Contador de gasto estimado com a API da Claude, por mês (chave 'YYYY-MM').
  // Usado pelo freio de orçamento GLOBAL em index.js.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_monthly (
      month_key TEXT PRIMARY KEY,
      total_cost_usd NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Gasto por usuário e por dia (chave 'YYYY-MM-DD' + google_sub).
  //
  // Existe por dois motivos. O primeiro é o teto diário por usuário em index.js:
  // o freio acima é um total único do mês, então uma única pessoa abusando
  // esgotava o orçamento e derrubava TODOS os clientes pagantes com 503. O
  // segundo é visibilidade — até aqui o backend registrava só o total agregado,
  // então não havia como saber quem estava gastando o quê.
  //
  // Sem chave estrangeira para users de propósito: registro de uso é histórico e
  // não deve falhar nem sumir se a linha do usuário for removida.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_daily_user (
      day_key TEXT NOT NULL,
      google_sub TEXT NOT NULL,
      cost_usd NUMERIC NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (day_key, google_sub)
    );
  `);
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function getMonthlyCostUsd() {
  const result = await pool.query(
    `SELECT total_cost_usd FROM usage_monthly WHERE month_key = $1`,
    [currentMonthKey()]
  );
  return result.rows[0] ? Number(result.rows[0].total_cost_usd) : 0;
}

async function addUsageCostUsd(costUsd) {
  if (!costUsd || costUsd <= 0) return;
  await pool.query(
    `INSERT INTO usage_monthly (month_key, total_cost_usd, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (month_key) DO UPDATE
       SET total_cost_usd = usage_monthly.total_cost_usd + EXCLUDED.total_cost_usd,
           updated_at = now()`,
    [currentMonthKey(), costUsd]
  );
}

function currentDayKey() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD' em UTC
}

// Quanto este usuário já gastou hoje. Usado pelo teto diário (requireUserQuota).
async function getUserDailyCostUsd(googleSub) {
  const result = await pool.query(
    `SELECT cost_usd FROM usage_daily_user WHERE day_key = $1 AND google_sub = $2`,
    [currentDayKey(), googleSub]
  );
  return result.rows[0] ? Number(result.rows[0].cost_usd) : 0;
}

async function addUserUsageCostUsd(googleSub, costUsd) {
  if (!googleSub || !costUsd || costUsd <= 0) return;
  await pool.query(
    `INSERT INTO usage_daily_user (day_key, google_sub, cost_usd, calls, updated_at)
     VALUES ($1, $2, $3, 1, now())
     ON CONFLICT (day_key, google_sub) DO UPDATE
       SET cost_usd = usage_daily_user.cost_usd + EXCLUDED.cost_usd,
           calls = usage_daily_user.calls + 1,
           updated_at = now()`,
    [currentDayKey(), googleSub, costUsd]
  );
}

// Maiores gastadores de hoje — para o /admin/usage. Serve para calibrar o teto
// com dados reais e para flagrar abuso.
async function getTopUsersToday(limit = 10) {
  const result = await pool.query(
    `SELECT google_sub, cost_usd, calls FROM usage_daily_user
      WHERE day_key = $1
      ORDER BY cost_usd DESC
      LIMIT $2`,
    [currentDayKey(), limit]
  );
  return result.rows.map((r) => ({
    googleSub: r.google_sub,
    costUsd: Number(r.cost_usd),
    calls: Number(r.calls),
  }));
}

// Usado pela trava de trial/assinatura em index.js (requireActiveUser).
async function getUserBySub(googleSub) {
  const result = await pool.query(
    `SELECT google_sub, trial_start_ts, is_subscribed FROM users WHERE google_sub = $1`,
    [googleSub]
  );
  return result.rows[0] || null;
}

// Chamado por POST /billing/sync toda vez que o BillingManager do app reconsulta
// o Play Billing (ao conectar, após uma compra, ou ao restaurar compras).
async function setSubscriptionStatus(googleSub, isSubscribed) {
  await pool.query(
    `UPDATE users SET is_subscribed = $2 WHERE google_sub = $1`,
    [googleSub, !!isSubscribed]
  );
}

module.exports = {
  pool,
  initSchema,
  currentMonthKey,
  currentDayKey,
  getMonthlyCostUsd,
  addUsageCostUsd,
  getUserDailyCostUsd,
  addUserUsageCostUsd,
  getTopUsersToday,
  getUserBySub,
  setSubscriptionStatus,
};
