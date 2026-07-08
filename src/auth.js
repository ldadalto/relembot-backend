const { OAuth2Client } = require('google-auth-library');
const { pool } = require('./db');

const client = new OAuth2Client();

async function verifyGoogleIdToken(idToken) {
  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_WEB_CLIENT_ID,
  });
  return ticket.getPayload();
}

async function upsertUserAndGetTrialStart(sub, email) {
  const result = await pool.query(
    `INSERT INTO users (google_sub, email, trial_start_ts)
     VALUES ($1, $2, $3)
     ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email
     RETURNING trial_start_ts`,
    [sub, email, Date.now()]
  );
  return Number(result.rows[0].trial_start_ts);
}

module.exports = { verifyGoogleIdToken, upsertUserAndGetTrialStart };
