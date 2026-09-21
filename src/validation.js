const { z } = require("zod");
const { DateTime } = require("luxon");
const { HttpError } = require("./errors");
const text = z.string().max(16000);
const short = z.string().max(300);
const optional = short.nullish();
const task = z.object({
  tarefa: text,
  contato: short,
  prioridade: short,
  tipo: short,
  status: optional,
  prazo: optional,
  responsavel: optional,
  contexto: text.nullish(),
  tags: text.optional(),
});
const id = z.number().int().positive().safe();
const zone = z
  .string()
  .max(80)
  .refine((v) => DateTime.now().setZone(v).isValid);
const schemas = {
  "/extract-task": z.object({
    contact: short.min(1),
    message: text.min(1),
    userName: short.default(""),
    isGroup: z.boolean().default(false),
    sentByMe: z.boolean().default(false),
    existingTags: z.array(short).max(100).default([]),
    timeZone: zone,
    messageTimestamp: z.number().int().positive().max(8640000000000000),
  }),
  "/search-tasks": z.object({
    query: text.min(1),
    tasks: z.array(task).max(500).default([]),
  }),
  "/daily-summary": z.object({
    userName: short.default(""),
    pendingTasks: z
      .array(task.pick({ tarefa: true, contato: true, prioridade: true }))
      .max(10)
      .default([]),
    totalPending: z.number().int().min(0),
    urgentCount: z.number().int().min(0).default(0),
    completedYesterday: z.number().int().min(0).default(0),
    decayedYesterday: z.number().int().min(0).default(0),
  }),
  "/cleanup-analysis": z.object({
    userName: short.default(""),
    hoje: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    tasks: z
      .array(
        z.object({
          id,
          tarefa: text,
          contato: short,
          tipo: z.enum(["MINHA", "DELEGADA"]),
          diasParada: z.number().int().min(0),
          prazoVencidoDias: z.number().int().nullish(),
          prazo: optional,
        }),
      )
      .min(1)
      .max(100),
  }),
  "/regenerate-tags": z.object({
    tasks: z
      .array(
        z.object({
          id,
          tarefa: text,
          contato: short,
          tipo: short,
          contexto: text.nullish(),
        }),
      )
      .min(1)
      .max(100),
  }),
  "/cleanup-feedback": z.object({
    totalAnalisadas: z.number().int().min(0).max(100000),
    aplicadas: z.number().int().min(0).max(100000),
    sugeridas: z.record(z.number().int().min(0)),
    desmarcadas: z.record(z.number().int().min(0)),
  }),
};
function validate(req, res, next) {
  req.body = schemas[req.path].parse(req.body);
  if (
    req.path === "/daily-summary" &&
    (req.body.totalPending < req.body.pendingTasks.length ||
      req.body.urgentCount > req.body.totalPending)
  )
    throw new HttpError(400, "invalid_counts");
  next();
}
function normalizeExtraction(result, body) {
  const value = z
    .object({
      temTarefa: z.boolean(),
      tarefa: text.optional(),
      contexto: text.nullish(),
      responsavel: short.nullish(),
      tipo: z.enum(["minha", "delegada"]).optional(),
      prazo: short.nullish(),
      prazoLocal: z.string().nullish(),
      prioridade: z.enum(["Urgente", "Normal", "Baixa"]).optional(),
      tags: z.array(short).max(3).optional(),
    })
    .parse(result);
  if (!value.temTarefa) return { temTarefa: false };
  if (!value.tarefa?.trim() || !value.tipo)
    throw new HttpError(502, "invalid_ai_response");
  let prazoTimestamp = null;
  if (value.prazoLocal) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value.prazoLocal))
      throw new HttpError(502, "invalid_ai_date");
    const dt = DateTime.fromISO(value.prazoLocal, { zone: body.timeZone });
    if (
      !dt.isValid ||
      dt.toFormat(
        value.prazoLocal.length === 16
          ? "yyyy-MM-dd'T'HH:mm"
          : "yyyy-MM-dd'T'HH:mm:ss",
      ) !== value.prazoLocal ||
      dt.getPossibleOffsets().length !== 1
    )
      throw new HttpError(502, "invalid_ai_date");
    prazoTimestamp = dt.toMillis();
  }
  return { ...value, prazoTimestamp };
}
function normalizeResult(path, result, body) {
  try {
    if (path === "/extract-task") return normalizeExtraction(result, body);
    if (path === "/search-tasks")
      return z
        .object({
          answer: text,
          indices: z.array(id.max(body.tasks.length)).max(body.tasks.length),
        })
        .parse(result);
    const entry =
      path === "/cleanup-analysis"
        ? z.object({
            id,
            veredicto: z.enum([
              "resolvida",
              "expirada",
              "duplicada",
              "relevante",
            ]),
            confianca: z.number().finite().min(0).max(1),
            duplicadaDe: id.nullish(),
          })
        : z.object({ id, tags: z.array(short.min(1)).max(3) });
    const parsed = z
      .object({ results: z.array(entry).max(body.tasks.length) })
      .parse(result);
    const ids = new Set(body.tasks.map((t) => t.id)),
      seen = new Set();
    for (const row of parsed.results) {
      if (
        !ids.has(row.id) ||
        seen.has(row.id) ||
        (row.duplicadaDe &&
          (!ids.has(row.duplicadaDe) || row.duplicadaDe === row.id))
      )
        throw Error("foreign_id");
      seen.add(row.id);
    }
    if (seen.size !== ids.size) throw Error("missing_id");
    // Never allow an entire duplicate chain/cycle to be archived.
    const byId = new Map(parsed.results.map((r) => [r.id, r]));
    for (const row of parsed.results)
      if (
        row.veredicto === "duplicada" &&
        byId.get(row.duplicadaDe)?.veredicto !== "relevante"
      )
        row.veredicto = "relevante";
    return parsed;
  } catch {
    throw new HttpError(502, "invalid_ai_response");
  }
}
module.exports = { validate, normalizeExtraction, normalizeResult, schemas };
