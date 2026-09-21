const crypto = require("node:crypto");
const { GoogleAuth, OAuth2Client } = require("google-auth-library");
const { hash } = require("./auth");
const { HttpError } = require("./errors");
const PRODUCTS = new Set(["relembot_pro_monthly", "relembot_pro_annual"]);
const ENTITLED = new Set([
  "SUBSCRIPTION_STATE_ACTIVE",
  "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
  "SUBSCRIPTION_STATE_CANCELED",
]);
const TRIAL_MS = 7 * 24 * 60 * 60 * 1000;
function createPlay(config) {
  const google = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  const base =
    "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/" +
    encodeURIComponent(config.PLAY_PACKAGE_NAME);
  return {
    async get(token) {
      return (
        await google.request({
          url:
            base +
            "/purchases/subscriptionsv2/tokens/" +
            encodeURIComponent(token),
          timeout: 10000,
          retry: false,
        })
      ).data;
    },
    async acknowledge(token, product) {
      await google.request({
        url:
          base +
          "/purchases/subscriptions/" +
          encodeURIComponent(product) +
          "/tokens/" +
          encodeURIComponent(token) +
          ":acknowledge",
        method: "POST",
        data: {},
        timeout: 10000,
        retry: false,
      });
    },
  };
}
function createBilling(db, config, play = createPlay(config)) {
  const key = Buffer.from(config.PURCHASE_TOKEN_KEY, "hex");
  function encrypt(value) {
    const iv = crypto.randomBytes(12),
      cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    return Buffer.concat([
      iv,
      cipher.update(value, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
  }
  function decrypt(value) {
    const data = Buffer.from(value, "base64"),
      cipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        data.subarray(0, 12),
      );
    cipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([
      cipher.update(data.subarray(12, -16)),
      cipher.final(),
    ]).toString("utf8");
  }
  async function verify(sub, token) {
    const tokenHash = hash(token),
      previous = await db.getSubscription(tokenHash);
    if (previous && previous.google_sub !== sub)
      throw new HttpError(409, "purchase_already_linked");
    let purchase;
    try {
      purchase = await play.get(token);
    } catch (e) {
      const status = e.response?.status || e.code;
      if (status === 404 || status === 410) {
        if (previous)
          await db.saveSubscription({
            ...previous,
            state: "SUBSCRIPTION_STATE_EXPIRED",
            expires_at: 0,
            verified_at: Date.now(),
          });
        throw new HttpError(400, "invalid_purchase");
      }
      throw new HttpError(503, "billing_unavailable");
    }
    if (purchase.linkedPurchaseToken) {
      const linked = await db.getSubscription(
        hash(purchase.linkedPurchaseToken),
      );
      if (linked && linked.google_sub !== sub)
        throw new HttpError(409, "purchase_already_linked");
    }
    const external =
      purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId;
    if (external && external !== hash(sub))
      throw new HttpError(403, "purchase_account_mismatch");
    const items = (purchase.lineItems || []).filter((i) =>
      PRODUCTS.has(i.productId),
    );
    if (!items.length) throw new HttpError(400, "invalid_product");
    const item = items.reduce((a, b) =>
      Date.parse(a.expiryTime || 0) > Date.parse(b.expiryTime || 0) ? a : b,
    );
    const expires = Date.parse(item.expiryTime || "") || 0;
    const row = {
      token_hash: tokenHash,
      google_sub: sub,
      token_cipher: previous?.token_cipher || encrypt(token),
      product_id: item.productId,
      state: purchase.subscriptionState,
      expires_at: expires,
      verified_at: Date.now(),
      acknowledged:
        purchase.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    };
    // Claim atomically BEFORE acknowledging. Legacy tokens without account ID can be
    // restored once by their authenticated holder; subsequent cross-account claims fail.
    await db.saveSubscription(row);
    if (!row.acknowledged && ENTITLED.has(row.state) && expires > Date.now()) {
      try {
        await play.acknowledge(token, row.product_id);
        row.acknowledged = true;
        await db.saveSubscription(row);
      } catch {
        /* Persistent row remains unacknowledged; job/next request retries. */
      }
    }
    return row;
  }
  async function entitlement(user, force = false) {
    let rows = await db.getSubscriptions(user.google_sub);
    for (const row of rows) {
      if (
        force ||
        (!row.acknowledged &&
          ENTITLED.has(row.state) &&
          Number(row.expires_at) > Date.now()) ||
        Date.now() - Number(row.verified_at) > 300000
      ) {
        try {
          await verify(user.google_sub, decrypt(row.token_cipher));
        } catch (e) {
          if (e.code !== "invalid_purchase") throw e;
        }
      }
    }
    rows = await db.getSubscriptions(user.google_sub);
    const paidUntil = Math.max(
      0,
      ...rows
        .filter((r) => ENTITLED.has(r.state))
        .map((r) => Number(r.expires_at)),
    );
    const trialUntil = Number(user.trial_start_ts) + TRIAL_MS;
    return {
      subscriptionActive: paidUntil > Date.now(),
      subscriptionExpiresAt: paidUntil,
      trialStartTs: Number(user.trial_start_ts),
      accessUntil: Math.max(paidUntil, trialUntil),
      serverTime: Date.now(),
    };
  }
  async function reconcile() {
    for (const row of await db.reconciliationCandidates()) {
      try {
        await verify(row.google_sub, decrypt(row.token_cipher));
      } catch (e) {
        console.warn("[billing-reconcile]", e.code || "unavailable");
      }
    }
    await db.maintenance();
  }
  async function rtdn(req, res) {
    if (!config.RTDN_AUDIENCE || !config.RTDN_SERVICE_ACCOUNT_EMAIL)
      throw new HttpError(404, "not_found");
    let payload;
    try {
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      payload = (
        await new OAuth2Client().verifyIdToken({
          idToken: token,
          audience: config.RTDN_AUDIENCE,
        })
      ).getPayload();
      if (
        payload.email !== config.RTDN_SERVICE_ACCOUNT_EMAIL ||
        !payload.email_verified
      )
        throw Error("identity");
    } catch {
      throw new HttpError(401, "invalid_rtdn_identity");
    }
    let notification;
    try {
      notification = JSON.parse(
        Buffer.from(req.body.message.data, "base64").toString("utf8"),
      );
    } catch {
      throw new HttpError(400, "invalid_notification");
    }
    if (notification.packageName !== config.PLAY_PACKAGE_NAME)
      throw new HttpError(400, "invalid_package");
    const token = notification.subscriptionNotification?.purchaseToken;
    if (token) {
      const row = await db.getSubscription(hash(token));
      if (row) await verify(row.google_sub, token);
    }
    res.json({ ok: true });
  }
  return { verify, entitlement, reconcile, rtdn };
}
module.exports = { createBilling, ENTITLED };
