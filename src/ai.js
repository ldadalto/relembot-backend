const { HttpError } = require("./errors");
function createAi(db, config, client) {
  let concurrent = 0;
  return async function complete(sub, params) {
    if (concurrent >= 8) throw new HttpError(429, "busy");
    concurrent++;
    try {
      // UTF-8 bytes bound the text token count conservatively, plus protocol overhead.
      const inputBound =
        Buffer.byteLength(JSON.stringify(params.messages), "utf8") + 2048;
      const reserve = (inputBound + params.max_tokens * 5) / 1000000;
      const id = await db.reserveUsage(sub, reserve, config);
      let response;
      try {
        response = await client.messages.create(params, {
          timeout: 30000,
          maxRetries: 0,
        });
      } catch (e) {
        // Transport failure may already have consumed tokens. Keep the reservation.
        if (e.status >= 400 && e.status < 500 && e.status !== 408)
          await db.settleUsage(id, 0);
        throw new HttpError(503, "ai_unavailable");
      }
      const usage = response.usage;
      if (usage)
        await db.settleUsage(
          id,
          (Number(usage.input_tokens || 0) +
            Number(usage.output_tokens || 0) * 5) /
            1000000,
        );
      // Account for a successful model response even if its JSON is invalid/truncated.
      if (response.stop_reason === "max_tokens")
        throw new HttpError(502, "ai_response_truncated");
      return response;
    } finally {
      concurrent--;
    }
  };
}
module.exports = { createAi };
