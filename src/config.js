const { z } = require("zod");
const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  CLAUDE_API_KEY: z.string().min(1),
  GOOGLE_WEB_CLIENT_ID: z.string().min(1),
  PURCHASE_TOKEN_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  ADMIN_TOKEN: z.string().min(32),
  PLAY_PACKAGE_NAME: z.literal("com.relembot.app").default("com.relembot.app"),
  CLAUDE_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(40),
  USER_DAILY_BUDGET_USD: z.coerce.number().positive().default(1),
  USER_DAILY_REQUESTS: z.coerce.number().int().positive().default(600),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  RTDN_AUDIENCE: z.string().url().optional(),
  RTDN_SERVICE_ACCOUNT_EMAIL: z.string().email().optional(),
});
function loadConfig(env = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      "Configuração inválida: " +
        parsed.error.issues.map((i) => i.path.join(".")).join(", "),
    );
  return parsed.data;
}
module.exports = { loadConfig };
