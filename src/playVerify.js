const { GoogleAuth } = require('google-auth-library');

// Verificação server-side de assinaturas junto ao Google Play (Android Publisher API).
//
// Antes, POST /billing/sync aceitava "estou assinado" vindo do app sem conferir
// nada — e o token do app fica dentro do APK, então qualquer um podia liberar uso
// ilimitado da IA para a própria conta. Agora o app manda o purchaseToken da compra
// e o backend confirma com o Google se aquela assinatura existe e está vigente.
//
// Configuração (Railway):
//   GOOGLE_PLAY_SERVICE_ACCOUNT_JSON — conteúdo JSON da chave de uma conta de
//     serviço com acesso ao app no Play Console (permissão "Ver dados financeiros").
//   PLAY_PACKAGE_NAME — opcional, padrão com.relembot.app.
//
// Sem a variável configurada, isEnabled() devolve false e o /billing/sync volta ao
// comportamento antigo (confia no app), com aviso no log — para não derrubar os
// assinantes antes da conta de serviço existir.

const PACKAGE_NAME = process.env.PLAY_PACKAGE_NAME || 'com.relembot.app';

let auth = null;
function getAuth() {
  if (auth) return auth;
  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  auth = new GoogleAuth({
    credentials: JSON.parse(raw),
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  return auth;
}

function isEnabled() {
  return !!process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
}

// Estados em que o usuário ainda tem direito ao serviço. CANCELED = cancelou a
// renovação mas o período pago ainda não acabou (confirmado pelo expiryTime abaixo).
const ENTITLED_STATES = new Set([
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
  'SUBSCRIPTION_STATE_CANCELED',
]);

/**
 * Consulta a assinatura no Google Play.
 * @returns {Promise<{active: boolean, expiryTs: number|null}>}
 * Lança em erro de rede/credencial — quem chama decide o que fazer. Token
 * inexistente/inválido (HTTP 400/404/410) devolve active=false.
 */
async function verifySubscription(purchaseToken) {
  const client = await getAuth().getClient();
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodeURIComponent(PACKAGE_NAME)}/purchases/subscriptionsv2/tokens/` +
    `${encodeURIComponent(purchaseToken)}`;

  let data;
  try {
    ({ data } = await client.request({ url }));
  } catch (err) {
    const status = err.response?.status;
    if (status === 400 || status === 404 || status === 410) {
      return { active: false, expiryTs: null };
    }
    throw err;
  }

  const expiryTs = (data.lineItems || [])
    .map((li) => Date.parse(li.expiryTime))
    .filter((t) => !Number.isNaN(t))
    .reduce((max, t) => Math.max(max, t), 0) || null;

  const active =
    ENTITLED_STATES.has(data.subscriptionState) && expiryTs !== null && expiryTs > Date.now();

  return { active, expiryTs };
}

module.exports = { isEnabled, verifySubscription };
