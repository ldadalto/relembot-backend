# Relembot API v2

Esta versão exige o app da branch `fix/auditoria-confiabilidade-20260921` de `ldadalto/relembot`. Teste num backend e PostgreSQL de staging separados antes da publicação conjunta: o APK antigo usa token compartilhado e não autentica nesta API. O booleano antigo `users.is_subscribed` deixa de autorizar acesso.

## Preparar staging

1. Use Node 22+ (CI: Node 24) e PostgreSQL 17. Execute `npm ci --ignore-scripts`.
2. Configure as variáveis de `.env.example` no ambiente do processo; o servidor não carrega `.env` automaticamente. `DATABASE_URL`, `CLAUDE_API_KEY`, `GOOGLE_WEB_CLIENT_ID`, `ADMIN_TOKEN` e `PURCHASE_TOKEN_KEY` são obrigatórias. Gere valores independentes: `openssl rand -hex 32`. Guarde a chave de criptografia; trocá-la sem recriptografar os registros impede restaurar os comprovantes salvos.
3. Habilite a Google Play Android Developer API no projeto Google Cloud e conceda à conta de serviço acesso ao app no Play Console, incluindo consulta de compras/assinaturas e reconhecimento de compras. Monte o JSON fora do repositório e aponte `GOOGLE_APPLICATION_CREDENTIALS` para ele. O pacote é `com.relembot.app` e os produtos aceitos são `relembot_pro_monthly` e `relembot_pro_annual`.
4. Use o mesmo cliente OAuth **web** em `GOOGLE_WEB_CLIENT_ID` no app e backend; registre também o cliente Android com package/SHA-1 da assinatura de teste. Para validar compras, instale o app pelo canal de teste interno do Google Play e use um testador de licença.
5. Inicie com `npm start`. A migração é aditiva: preserva usuários, início do trial e custos existentes. `/health` deve retornar `apiVersion: 2`. Falta de configuração/banco encerra o startup. Faça backup antes de qualquer migração de produção.
6. Se houver proxy reverso, configure `TRUST_PROXY_HOPS` apenas com a quantidade exata de proxies confiáveis; o padrão é zero. Esse valor afeta o limite de login por IP. Limites de orçamento usam PostgreSQL e funcionam entre instâncias.

## Contrato

- `POST /auth/google {idToken}` valida assinatura, audiência e e-mail verificado no Google e retorna `accessToken`, `refreshToken`, `expiresAt`, `sub`, `trialStartTs`, `name`.
- `POST /auth/refresh {refreshToken}` troca ambos os tokens; replay é rejeitado. Access token dura 1h, refresh até 90 dias da sessão inicial. Tokens são armazenados somente como hashes no banco.
- Rotas de IA, feedback e billing exigem `Authorization: Bearer <accessToken>`. Enviar `googleSub` não autentica. `GET /admin/usage` aceita somente o `ADMIN_TOKEN` independente, nunca incluído no APK.
- `POST /billing/sync {purchaseTokens: [...]}` consulta `subscriptionsv2`, valida produto, vínculo e validade. Tokens são criptografados com AES-256-GCM. Booleanos de assinatura são rejeitados. `GET /account/entitlement` retorna a mesma situação verificada.
- Novas compras usam SHA-256 do Google sub como `obfuscatedAccountId`. Compras antigas sem esse identificador podem ser restauradas pelo primeiro titular autenticado que apresentar o token válido; o vínculo torna-se exclusivo no banco. O teste de upgrade deve usar a mesma conta Google do app e Play. Não se migra o booleano legado como prova de compra.
- ACTIVE, IN_GRACE_PERIOD e CANCELED dão acesso somente até o vencimento confirmado. ON_HOLD, PAUSED e EXPIRED não dão acesso pago. Compras pendentes não são reconhecidas. Falha no reconhecimento fica persistida para nova tentativa.
- Verificação de assinatura é renovada a cada 5 minutos, consultada nas requisições e por job executado a cada minuto. Revogações podem levar essa janela mais o tempo da API; indisponibilidade de verificação necessária resulta em 503, sem conceder acesso com base no booleano antigo. Configure RTDN para reação mais rápida: Pub/Sub push autenticado para `/billing/rtdn`, com audience e e-mail da conta de serviço nas variáveis correspondentes. RTDN sem configuração retorna 404; remetente inválido, 401.
- Extração exige `timeZone` IANA e `messageTimestamp` em milissegundos. IA devolve data local estruturada; o backend converte para epoch e rejeita horários inexistentes/ambíguos. Nunca confia em epoch calculado pelo modelo.
- Payload: até 256 KiB; mensagem até 16.000 caracteres; busca até 500 tarefas; faxina/tags até 100 por lote. Resumo recebe até 10 exemplos e `totalPending` separado.

## Custos e indisponibilidade

Antes de chamar a IA, uma transação reserva uma estimativa conservadora de custo nos limites mensal e diário por usuário. Chamadas concorrentes não passam sobre o saldo reservado. O custo real é liquidado antes de interpretar JSON. Resposta inválida/truncada também conta. Falha de transporte pode ter consumido tokens: a reserva permanece contabilizada; erro definitivo 4xx do provedor, exceto timeout, libera o valor. Não há retry automático do SDK. Inspecione reservas não liquidadas ao reconciliar faturas; não as zere automaticamente sem evidência do provedor. A estimativa usa os preços do modelo Haiku 4.5 (US$ 1/5 por milhão de tokens de entrada/saída) e deve ser revista se o modelo/preço mudar.

## Validar

```bash
npm ci --ignore-scripts
npm test
npm audit --audit-level=moderate
```

`npm test` sem `TEST_DATABASE_URL` informa que o teste PostgreSQL foi pulado. Para validação completa, use **um banco descartável** nessa variável; o teste apaga suas tabelas. Nunca aponte para produção. O CI inicia esse banco automaticamente e executa a integração (migração legada, 20 reservas concorrentes, vínculo de compra e rotação de sessão).

Os testes usam respostas simuladas do Google/Anthropic, sem gastos. Compras reais de teste, OAuth e RTDN precisam ser homologados com a configuração de staging. Consulte o roteiro no PR do app.

## Dados e operação

O backend mantém sub/e-mail Google, início do trial, hashes de sessão, comprovantes de compra criptografados, estado/validade e contadores de uso. Não grava mensagens/tarefas em tabelas ou logs. Sessões expiradas e uso diário/reservas liquidadas com mais de 90 dias são removidos. Reservas não liquidadas e contadores mensais são conservados para reconciliação. Configure retenção de infraestrutura e Firebase conforme a política publicada; desinstalar o app não apaga a conta no backend.

Antes de produção, combine lançamento do app, configuração Play/OAuth, política de privacidade e backend. Não faça downgrade isolado para o backend antigo: ele reintroduz autorização por booleano. As tabelas novas são aditivas, mas a chave dos comprovantes precisa ser preservada.

Referências: [segurança do Play Billing](https://developer.android.com/google/play/billing/security), [subscriptionsv2](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2), [RTDN](https://developer.android.com/google/play/billing/rtdn-reference).
