const crypto = require("node:crypto");
const { OAuth2Client } = require("google-auth-library");
const { HttpError } = require("./errors");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const opaque = () => crypto.randomBytes(32).toString("base64url");
const SESSION_MS = 60 * 60 * 1000;
const REFRESH_MS = 90 * 24 * 60 * 60 * 1000;
function createAuth(db, config, google = new OAuth2Client()) {
  function tokens(sub) {
    const accessToken = opaque(),
      refreshToken = opaque(),
      expiresAt = Date.now() + SESSION_MS;
    return { accessToken, refreshToken, expiresAt, sub };
  }
  async function signIn(idToken) {
    let payload;
    try {
      payload = (
        await google.verifyIdToken({
          idToken,
          audience: config.GOOGLE_WEB_CLIENT_ID,
        })
      ).getPayload();
      if (!payload?.sub || !payload.email_verified)
        throw new Error("invalid identity");
    } catch {
      throw new HttpError(401, "invalid_google_token");
    }
    const trialStartTs = await db.upsertUser(payload.sub, payload.email);
    const result = tokens(payload.sub);
    await db.createSession(
      hash(result.accessToken),
      hash(result.refreshToken),
      payload.sub,
      result.expiresAt,
      Date.now() + REFRESH_MS,
    );
    return { ...result, trialStartTs, name: payload.name || "" };
  }
  async function refresh(refreshToken) {
    const result = tokens("");
    const row = await db.rotateSession(
      hash(refreshToken),
      hash(result.accessToken),
      hash(result.refreshToken),
      result.expiresAt,
    );
    if (!row) throw new HttpError(401, "session_expired");
    return {
      ...result,
      sub: row.google_sub,
      trialStartTs: Number(row.trial_start_ts),
    };
  }
  async function authenticate(req, res, next) {
    const token = req.headers.authorization?.match(
      /^Bearer ([A-Za-z0-9_-]{43})$/,
    )?.[1];
    if (!token) throw new HttpError(401, "account_required");
    const row = await db.findSession(hash(token));
    if (!row) throw new HttpError(401, "session_expired");
    req.user = row;
    next();
  }
  function admin(req, res, next) {
    const actual = Buffer.from(req.headers.authorization || "");
    const expected = Buffer.from("Bearer " + config.ADMIN_TOKEN);
    if (
      !config.ADMIN_TOKEN ||
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    )
      throw new HttpError(401, "unauthorized");
    next();
  }
  return { signIn, refresh, authenticate, admin };
}
module.exports = { createAuth, hash };
