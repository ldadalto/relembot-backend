const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { initSchema } = require('./db');
const { verifyGoogleIdToken, upsertUserAndGetTrialStart } = require('./auth');

const app = express();
// Padrão do Express é 100kb — a busca envia a lista inteira de tarefas pendentes/concluídas
// no corpo, e usuários com backlog grande (100-1000 tarefas) estouram esse limite facilmente.
app.use(express.json({ limit: '5mb' }));

const claudeClient = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const APP_TOKEN = process.env.APP_TOKEN;

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!APP_TOKEN) return next(); // sem token configurado = modo dev local
  if (!auth || auth !== `Bearer ${APP_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ── POST /auth/google ─────────────────────────────────────────────────────────
// Verifica o ID Token do Google Sign-In e retorna o trial_start_ts autoritativo
// (ancorado na conta Google — sobrevive a desinstalar/reinstalar o app).

app.post('/auth/google', requireAuth, async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken is required' });

  try {
    const payload = await verifyGoogleIdToken(idToken);
    const trialStartTs = await upsertUserAndGetTrialStart(payload.sub, payload.email);
    res.json({ trialStartTs });
  } catch (err) {
    console.error('[auth/google]', err.message);
    res.status(401).json({ error: 'Invalid Google ID token' });
  }
});

// ── POST /extract-task ────────────────────────────────────────────────────────

app.post('/extract-task', requireAuth, async (req, res) => {
  const { contact, message, userName = '', isGroup = false, sentByMe = false } = req.body;

  if (!contact || !message) {
    return res.status(400).json({ error: 'contact and message are required' });
  }

  const eu = userName || 'Eu';
  const nowDate = new Date().toLocaleDateString('pt-BR');

  const direcao = sentByMe ? `
DIREÇÃO: Mensagem ENVIADA por ${eu} para ${contact} (lado DIREITO do WhatsApp, bolha verde).
REGRA: ${eu} é o REMETENTE. ${contact} é o DESTINATÁRIO.
Qualquer pedido, solicitação ou expectativa nesta mensagem é de ${eu} para ${contact}.
→ Se há tarefa: tipo = "delegada", responsavel = "${contact}"
→ ${eu} está pedindo algo PARA ${contact} fazer.

EXEMPLOS com esta direção (eu enviei):
- "Aguardo sua avaliação" → delegada para ${contact} (${contact} que avalia)
- "Pode me mandar o relatório?" → delegada para ${contact} (${contact} que envia)
- "Preciso que você confirme" → delegada para ${contact} (${contact} que confirma)
` : `
DIREÇÃO: Mensagem RECEBIDA por ${eu}, enviada por ${contact} (lado ESQUERDO do WhatsApp, bolha cinza).
REGRA: ${contact} é o REMETENTE. ${eu} é o DESTINATÁRIO.
Qualquer pedido, solicitação ou expectativa nesta mensagem é de ${contact} para ${eu}.
→ Se há tarefa: tipo = "minha", responsavel = "${eu}"
→ ${eu} precisa fazer algo que ${contact} está pedindo.

EXEMPLOS com esta direção (recebi):
- "Você pode avaliar meu artigo?" → minha (${eu} que avalia)
- "Me manda o relatório" → minha (${eu} que envia)
- "Preciso que você confirme" → minha (${eu} que confirma)
`;

  const prompt = `Você é assistente de produtividade para profissionais brasileiros no WhatsApp.
Usuário: ${eu} | Data: ${nowDate}

${direcao}

IDENTIFIQUE TAREFAS — explícitas ou implícitas. Não crie tarefa para conversa casual, saudações ou confirmações simples.

Responda APENAS com JSON puro sem markdown:
{
  "temTarefa": true ou false,
  "tarefa": "descrição clara da ação",
  "contexto": "resumo de 1-2 linhas: quem pediu, o que está em jogo, detalhes relevantes para lembrar depois",
  "responsavel": "nome de quem EXECUTA a tarefa",
  "tipo": "minha" ou "delegada",
  "prazo": "prazo em português ou null",
  "prazoTimestamp": timestamp Unix ms ou null,
  "prioridade": "Urgente|Normal|Baixa",
  "categoria": "Financeiro|Reunião|Cliente|Entrega|Outro"
}

Se não houver tarefa: {"temTarefa":false}

Contato: ${contact}
Mensagem: "${message}"`;

  try {
    const response = await claudeClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content[0].text
      .replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    const result = JSON.parse(raw);

    // Força a direção caso a IA ignore
    if (result.temTarefa) {
      if (sentByMe && result.tipo === 'minha') result.tipo = 'delegada';
      if (!sentByMe && result.tipo === 'delegada') result.tipo = 'minha';
    }

    res.json(result);
  } catch (err) {
    console.error('[extract-task]', err.message);
    res.status(500).json({ error: 'Claude API error', detail: err.message });
  }
});

// ── POST /search-tasks ────────────────────────────────────────────────────────

app.post('/search-tasks', requireAuth, async (req, res) => {
  const { query, tasks = [] } = req.body;

  if (!query) return res.status(400).json({ error: 'query is required' });
  if (tasks.length === 0) {
    return res.json({ answer: 'Você ainda não tem tarefas registradas.', indices: [] });
  }

  const taskList = tasks.map((t, i) => {
    let line = `${i + 1}. "${t.tarefa}" | Contato: ${t.contato}`;
    line += ` | ${t.tipo === 'delegada' ? 'Delegada' : 'Minha'}`;
    line += ` | ${t.prioridade}`;
    line += ` | ${t.status === 'CONCLUIDA' ? 'Concluída' : 'Pendente'}`;
    if (t.prazo) line += ` | Prazo: ${t.prazo}`;
    if (t.responsavel) line += ` | Responsável: ${t.responsavel}`;
    if (t.contexto) line += ` | Contexto: ${t.contexto}`;
    return line;
  }).join('\n');

  const prompt = `Você é o assistente de busca do Relembot, app de gestão de tarefas do WhatsApp.
O usuário tem ${tasks.length} tarefa(s). Responda em português, de forma direta e objetiva.

TAREFAS (numeradas a partir de 1):
${taskList}

PERGUNTA: ${query}

Responda APENAS com JSON puro sem markdown, "answer" em no máximo 2 frases:
{
  "answer": "sua resposta em texto para o usuário",
  "indices": [lista com os números (1-based) das tarefas relevantes encontradas, ou [] se nenhuma]
}`;

  try {
    const response = await claudeClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content[0].text
      .replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    // A IA às vezes escreve um comentário antes/depois do JSON apesar da instrução —
    // isolar do primeiro '{' ao último '}' evita falhar o parse por causa disso.
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    const jsonSlice = jsonStart >= 0 && jsonEnd > jsonStart ? raw.slice(jsonStart, jsonEnd + 1) : raw;

    const result = JSON.parse(jsonSlice);
    res.json(result);
  } catch (err) {
    console.error('[search-tasks]', err.message);
    res.status(500).json({ error: 'Claude API error', detail: err.message });
  }
});

// ── POST /daily-summary ───────────────────────────────────────────────────────

app.post('/daily-summary', requireAuth, async (req, res) => {
  const { userName = '', pendingTasks = [], urgentCount = 0, completedYesterday = 0, decayedYesterday = 0 } = req.body;
  const eu = userName || 'Você';

  if (pendingTasks.length === 0 && completedYesterday === 0 && decayedYesterday === 0) {
    return res.json({ summary: `Bom dia, ${eu}! Nenhuma tarefa pendente no momento. 🎉` });
  }

  const taskList = pendingTasks.map((t, i) => {
    let line = `${i + 1}. "${t.tarefa}"`;
    if (t.contato) line += ` — ${t.contato}`;
    line += ` (${t.prioridade})`;
    return line;
  }).join('\n');

  const prompt = `Você é o assistente do Relembot, app de gestão de tarefas via WhatsApp.
Escreva o texto de uma notificação de "bom dia" para ${eu}, em português, resumindo o dia.

DADOS:
- ${pendingTasks.length} tarefa(s) pendente(s), sendo ${urgentCount} urgente(s)
- Tarefas pendentes:
${taskList || '(nenhuma)'}
- Ontem ${eu} concluiu ${completedYesterday} tarefa(s)
${decayedYesterday > 0 ? `- Ontem o decaimento automático arquivou ${decayedYesterday} tarefa(s) parada(s) há muito tempo (mencione isso e que dá pra resgatar em Arquivadas)` : ''}

REGRAS:
- No máximo 2 frases curtas, tom direto e motivador, como o corpo de uma notificação push
- Se houver tarefa urgente, cite ela ou o contato específico
- Sem markdown, sem aspas ao redor do texto

Responda APENAS com o texto da notificação.`;

  try {
    const response = await claudeClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });

    const summary = response.content[0].text.trim();
    res.json({ summary });
  } catch (err) {
    console.error('[daily-summary]', err.message);
    res.status(500).json({ error: 'Claude API error', detail: err.message });
  }
});

// ── POST /cleanup-analysis ────────────────────────────────────────────────────
// Faxina com IA: classifica um lote (até 100) de tarefas pendentes em
// resolvida | expirada | duplicada | relevante. A aritmética de datas (diasParada,
// prazoVencidoDias) já vem pronta do app — o modelo nunca faz contas de data.

app.post('/cleanup-analysis', requireAuth, async (req, res) => {
  const { userName = '', hoje = '', tasks = [] } = req.body;

  if (!Array.isArray(tasks) || tasks.length === 0) {
    return res.status(400).json({ error: 'tasks (não vazio) é obrigatório' });
  }
  if (tasks.length > 100) {
    return res.status(400).json({ error: 'no máximo 100 tarefas por lote' });
  }

  const eu = userName || 'o usuário';
  const taskList = tasks.map((t) => {
    let line = `${t.id} | "${t.tarefa}" | ${t.contato} | ${t.tipo} | diasParada=${t.diasParada}`;
    line += ` | prazoVencidoDias=${t.prazoVencidoDias ?? 'null'}`;
    if (t.prazo) line += ` | prazo="${t.prazo}"`;
    return line;
  }).join('\n');

  const prompt = `Você é o motor de triagem do Relembot, um organizador de tarefas capturadas do WhatsApp.
Usuário: ${eu}. Data de hoje: ${hoje}.

Classifique cada tarefa abaixo em exatamente um veredicto:

- "expirada": prazoVencidoDias > 7 (o prazo passou e a janela de ação morreu).
- "duplicada": mesmo contato + mesma ação em essência (variações de texto da
  mesma solicitação). Aponte em duplicadaDe o id da tarefa que deve PERMANECER
  (a mais recente, ou a que tem prazo). Nunca marque todas do grupo como
  duplicadas — uma sempre fica.
- "resolvida": tarefa pontual (não recorrente), sem prazo futuro, parada há
  mais de 30 dias — provavelmente já foi feita na vida real ou perdeu sentido.
- "relevante": todo o resto. NA DÚVIDA, use "relevante". É melhor manter uma
  tarefa morta do que arquivar uma viva.

Regras:
- Tarefas do tipo DELEGADA só podem ser "resolvida" se diasParada > 60
  (cobranças pendentes tendem a continuar relevantes).
- confianca entre 0 e 1. Se < 0.7, o app vai manter a tarefa de qualquer forma.
- A aritmética de datas (diasParada, prazoVencidoDias) já foi calculada pelo
  app — não faça contas de data, apenas aplique as regras acima.
- Inclua um objeto de resultado para CADA id recebido, sem pular nenhum.
- Responda APENAS com JSON puro sem markdown, no formato:
  {"results":[{"id":123,"veredicto":"...","confianca":0.85,"duplicadaDe":null}]}

Tarefas (id | tarefa | contato | tipo | diasParada | prazoVencidoDias):
${taskList}`;

  try {
    const response = await claudeClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content[0].text
      .replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    const result = JSON.parse(raw);
    res.json(result);
  } catch (err) {
    console.error('[cleanup-analysis]', err.message);
    res.status(500).json({ error: 'Claude API error', detail: err.message });
  }
});

// ── POST /cleanup-feedback ─────────────────────────────────────────────────────
// Métricas agregadas e anônimas da Faxina com IA (sem user id, sem conteúdo de tarefa).
// Fire-and-forget do lado do app — aqui só logamos, sem tabela nova (sem infra de
// eventos por enquanto; falha aqui nunca pode atrapalhar a aplicação da faxina).

app.post('/cleanup-feedback', requireAuth, (req, res) => {
  console.log('[cleanup-feedback]', JSON.stringify(req.body));
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
initSchema()
  .then(() => app.listen(PORT, () => console.log(`Relembot backend running on port ${PORT}`)))
  .catch((err) => {
    console.error('[db] Falha ao inicializar schema:', err.message);
    process.exit(1);
  });
