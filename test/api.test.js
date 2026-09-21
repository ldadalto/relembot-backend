const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/index");
const { hash, createAuth } = require("../src/auth");
const { createBilling } = require("../src/billing");
const { normalizeExtraction } = require("../src/validation");
const { loadConfig } = require("../src/config");
const config = {
  PURCHASE_TOKEN_KEY: "a".repeat(64),
  ADMIN_TOKEN: "admin-".repeat(8),
  GOOGLE_WEB_CLIENT_ID: "aud",
  CLAUDE_MONTHLY_BUDGET_USD: 40,
  USER_DAILY_BUDGET_USD: 1,
  USER_DAILY_REQUESTS: 600,
};
function fixture() {
  const subs = new Map(),
    sessions = new Map(),
    now = Date.now();
  const user = { google_sub: "alice", trial_start_ts: now };
  const db = {
    getUser: async () => user,
    upsertUser: async () => now,
    createSession: async (t, r, s) => sessions.set(t, user),
    findSession: async (t) => sessions.get(t),
    getSubscriptions: async (s) =>
      [...subs.values()].filter((r) => r.google_sub === s),
    getSubscription: async (t) => subs.get(t),
    saveSubscription: async (r) => subs.set(r.token_hash, { ...r }),
    reserveUsage: async () => "reservation",
    settleUsage: async (id, cost) => {
      db.spent += cost;
    },
    spent: 0,
    getMonthlyCostUsd: async () => 0,
  };
  const google = {
    verifyIdToken: async ({ audience }) => {
      assert.equal(audience, "aud");
      return {
        getPayload: () => ({
          sub: "alice",
          email_verified: true,
          name: "Alice",
        }),
      };
    },
  };
  const play = {
    get: async () => ({
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
      externalAccountIdentifiers: {
        obfuscatedExternalAccountId: hash("alice"),
      },
      lineItems: [
        {
          productId: "relembot_pro_monthly",
          expiryTime: new Date(now + 86400000).toISOString(),
        },
      ],
    }),
    acknowledge: async () => {},
  };
  const claudeClient = {
    messages: {
      create: async () => ({
        content: [{ text: '{"temTarefa":false}' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    },
  };
  return { db, config, google, play, claudeClient, user, subs, sessions };
}
async function server(t, f = fixture()) {
  const s = createApp(f).listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  t.after(() => s.close());
  const base = `http://127.0.0.1:${s.address().port}`;
  const call = async (path, body, token) => {
    const r = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  const login = await call("/auth/google", { idToken: "valid" });
  return { ...f, call, token: login.data.accessToken };
}
const extract = {
  contact: "Contato",
  message: "Me liga",
  timeZone: "America/Sao_Paulo",
  messageTimestamp: Date.now(),
};
test("config requires separate secrets and database", () =>
  assert.throws(() => loadConfig({})));
test("shared token/body identity cannot authenticate; account session cannot administer", async (t) => {
  const { call, token } = await server(t);
  assert.equal(
    (
      await call(
        "/extract-task",
        { ...extract, googleSub: "alice" },
        "apk-token",
      )
    ).status,
    401,
  );
  assert.equal((await call("/admin/usage", undefined, token)).status, 401);
  assert.equal(
    (await call("/admin/usage", undefined, config.ADMIN_TOKEN)).status,
    200,
  );
});
test("billing rejects boolean and verifies purchase/account", async (t) => {
  const f = await server(t);
  assert.equal(
    (await f.call("/billing/sync", { subscriptionActive: true }, f.token))
      .status,
    400,
  );
  assert.equal(
    (await f.call("/billing/sync", { purchaseTokens: ["valid"] }, f.token)).data
      .subscriptionActive,
    true,
  );
  f.play.get = async () => ({
    externalAccountIdentifiers: { obfuscatedExternalAccountId: "other" },
  });
  assert.equal(
    (await f.call("/billing/sync", { purchaseTokens: ["wrong"] }, f.token))
      .status,
    403,
  );
});
test("database failure denies access before model invocation", async (t) => {
  const f = await server(t);
  f.db.getSubscriptions = async () => {
    throw Error("database down secret");
  };
  const r = await f.call("/extract-task", extract, f.token);
  assert.equal(r.status, 503);
  assert.equal(f.db.spent, 0);
  assert.ok(!JSON.stringify(r).includes("secret"));
});
test("malformed payloads stay inside error middleware; process stays alive", async (t) => {
  const { call, token } = await server(t);
  for (const body of [
    { ...extract, message: {} },
    { ...extract, existingTags: "oops" },
    null,
  ])
    assert.equal((await call("/extract-task", body, token)).status, 400);
  assert.equal((await call("/health")).status, 200);
});
test("expired verified state and legacy boolean do not grant access", async (t) => {
  const f = await server(t);
  f.user.trial_start_ts = 1;
  f.user.is_subscribed = true;
  assert.equal((await f.call("/extract-task", extract, f.token)).status, 402);
});
test("model invalid JSON still counts cost; malformed result returns no task", async (t) => {
  const f = await server(t);
  f.claudeClient.messages.create = async () => ({
    content: [{ text: "not json" }],
    usage: { input_tokens: 10, output_tokens: 20 },
  });
  assert.equal((await f.call("/extract-task", extract, f.token)).status, 502);
  assert.ok(f.db.spent > 0);
});
test("AI can classify a sent promise as minha", async (t) => {
  const f = await server(t);
  f.claudeClient.messages.create = async () => ({
    content: [
      {
        text: JSON.stringify({
          temTarefa: true,
          tarefa: "Enviar relatório",
          tipo: "minha",
          prazoLocal: "2026-09-22T09:00",
        }),
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const r = await f.call(
    "/extract-task",
    { ...extract, sentByMe: true },
    f.token,
  );
  assert.equal(r.status, 200);
  assert.equal(r.data.tipo, "minha");
  assert.equal(r.data.prazoTimestamp, Date.parse("2026-09-22T12:00:00Z"));
});
test("nonexistent/ambiguous local times are rejected", () => {
  for (const prazoLocal of ["2026-03-08T02:30", "2026-11-01T01:30"])
    assert.throws(() =>
      normalizeExtraction(
        { temTarefa: true, tarefa: "x", tipo: "minha", prazoLocal },
        { timeZone: "America/New_York" },
      ),
    );
});
test("acknowledgement failure is persisted and retried; cancellation respects expiry", async () => {
  const f = fixture();
  let attempts = 0;
  f.play.acknowledge = async () => {
    if (++attempts === 1) throw Error("network");
  };
  const b = createBilling(f.db, config, f.play);
  await b.verify("alice", "valid");
  assert.equal([...f.subs.values()][0].acknowledged, false);
  await b.entitlement(f.user);
  assert.equal(attempts, 2);
  assert.equal([...f.subs.values()][0].acknowledged, true);
  f.play.get = async () => ({
    subscriptionState: "SUBSCRIPTION_STATE_EXPIRED",
    lineItems: [
      {
        productId: "relembot_pro_monthly",
        expiryTime: new Date(Date.now() - 1).toISOString(),
      },
    ],
  });
  assert.equal((await b.entitlement(f.user, true)).subscriptionActive, false);
});
test("foreign cleanup ids and invalid confidence rejected", async (t) => {
  const f = await server(t);
  f.claudeClient.messages.create = async () => ({
    content: [
      {
        text: '{"results":[{"id":999,"veredicto":"resolvida","confianca":1.2}]}',
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  assert.equal(
    (
      await f.call(
        "/cleanup-analysis",
        {
          hoje: "2026-09-21",
          tasks: [
            { id: 1, tarefa: "x", contato: "x", tipo: "MINHA", diasParada: 1 },
          ],
        },
        f.token,
      )
    ).status,
    502,
  );
});
test("refresh rotates tokens and rejects replay", async () => {
  const f = fixture();
  let used = false;
  f.db.rotateSession = async () => (used ? null : ((used = true), f.user));
  const a = createAuth(f.db, config, f.google),
    r = await a.refresh("x".repeat(43));
  assert.equal(r.accessToken.length, 43);
  await assert.rejects(a.refresh("x".repeat(43)), { code: "session_expired" });
});
test("daily summary reports full total, not the ten-item sample", async (t) => {
  const f = await server(t);
  let prompt = "";
  f.claudeClient.messages.create = async (params) => {
    prompt = params.messages[0].content;
    return {
      content: [{ text: "Resumo" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  };
  const r = await f.call(
    "/daily-summary",
    {
      totalPending: 40,
      urgentCount: 3,
      pendingTasks: Array.from({ length: 10 }, () => ({
        tarefa: "x",
        contato: "Ana",
        prioridade: "NORMAL",
      })),
    },
    f.token,
  );
  assert.equal(r.status, 200);
  assert.match(prompt, /40 tarefa\(s\) pendente/);
});
test("provider failure conservatively retains cost reservation and refunds definite rejections", async (t) => {
  const f = await server(t);
  let settled = 0;
  f.db.settleUsage = async () => {
    settled++;
  };
  f.claudeClient.messages.create = async () => {
    throw Error("timeout");
  };
  assert.equal((await f.call("/extract-task", extract, f.token)).status, 503);
  assert.equal(settled, 0);
  f.claudeClient.messages.create = async () => {
    throw { status: 400 };
  };
  await f.call("/extract-task", extract, f.token);
  assert.equal(settled, 1);
});
test("Google verification outage does not activate subscription", async (t) => {
  const f = await server(t);
  f.play.get = async () => {
    throw Error("offline");
  };
  assert.equal(
    (await f.call("/billing/sync", { purchaseTokens: ["unknown"] }, f.token))
      .status,
    503,
  );
  assert.equal(f.subs.size, 0);
});

for (const status of [404, 410]) {
  test(`obsolete purchase (${status}) does not block replacement or revocation sync`, async (t) => {
    const f = await server(t);
    f.user.trial_start_ts = 1;
    await f.call("/billing/sync", { purchaseTokens: ["old"] }, f.token);
    const valid = f.play.get;
    f.play.get = async token => {
      if (token === "old") throw { response: { status } };
      return valid(token);
    };
    const revoked = await f.call("/billing/sync", { purchaseTokens: ["old"] }, f.token);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.data.subscriptionActive, false);
    assert.equal(revoked.data.subscriptionExpiresAt, 0);
    const restored = await f.call("/billing/sync", { purchaseTokens: ["old", "replacement"] }, f.token);
    assert.equal(restored.status, 200);
    assert.equal(restored.data.subscriptionActive, true);
  });
}
