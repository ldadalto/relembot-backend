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
  // Usado pelo freio de orçamento em index.js — como as chamadas às 5 rotas de IA
  // não carregam identificação de usuário nenhuma (ver comentário em index.js),
  // esse é hoje o único jeito de limitar o prejuízo: um teto GLOBAL de gasto
  // mensal, não por usuário.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_monthly (
      month_key TEXT PRIMARY KEY,
      total_cost_usd NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
  getMonthlyCostUsd,
  addUsageCostUsd,
  getUserBySub,
  setSubscriptionStatus,
};
