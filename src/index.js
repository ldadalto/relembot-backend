const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

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

Responda APENAS com JSON puro sem markdown:
{
  "answer": "sua resposta em texto para o usuário",
  "indices": [lista com os números (1-based) das tarefas relevantes encontradas, ou [] se nenhuma]
}`;

  try {
    const response = await claudeClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content[0].text
      .replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    const result = JSON.parse(raw);
    res.json(result);
  } catch (err) {
    console.error('[search-tasks]', err.message);
    res.status(500).json({ error: 'Claude API error', detail: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Relembot backend running on port ${PORT}`));
