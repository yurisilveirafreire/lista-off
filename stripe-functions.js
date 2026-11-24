/* =====================================================================
   LISTA OFF — Firebase Functions do Stripe
   Assinatura R$ 99/mês com 7 DIAS DE TESTE GRÁTIS (trial)
   =====================================================================
   Usa a MESMA conta Stripe do iGastei.
   Plano ativo (ou em trial) => eventos, listas e links ilimitados.

   Coloque dentro da pasta `functions/` do projeto `lista-off-bc957`.
   Secrets (nunca no código):
     STRIPE_SECRET            -> sk_live_...
     STRIPE_WEBHOOK_LISTAOFF  -> whsec_... (do webhook deste app)
   ===================================================================== */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const stripe = require("stripe")(process.env.STRIPE_SECRET);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_LISTAOFF;
const APP_URL = "https://listaoff.com.br";
const TRIAL_DIAS = 7;

/* 1) createCheckoutListaOff — abre o checkout da ASSINATURA com trial
   body: { priceId, uid, email } */
exports.createCheckoutListaOff = functions
  .region("us-central1")
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).send("");

    try {
      const { priceId, uid, email } = req.body || {};
      if (!priceId || !uid) return res.status(400).json({ error: "faltam dados" });

      // reusa o customer do Stripe se a conta já tiver um
      let customer;
      const contaSnap = await db.collection("contas").doc(uid).get();
      const conta = contaSnap.exists ? contaSnap.data() : {};
      if (conta.stripeCustomerId) customer = conta.stripeCustomerId;

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        customer: customer || undefined,
        customer_email: customer ? undefined : email || undefined,
        subscription_data: {
          trial_period_days: TRIAL_DIAS,         // 7 dias grátis
          metadata: { uid, plano: "mensal" },
        },
        metadata: { uid, plano: "mensal" },
        success_url: `${APP_URL}/?v=painel&pag=ok`,
        cancel_url: `${APP_URL}/?v=painel&pag=cancel`,
      });

      return res.json({ url: session.url });
    } catch (e) {
      console.error("createCheckoutListaOff", e);
      return res.status(500).json({ error: e.message });
    }
  });

/* 2) portalListaOff — portal do cliente (gerenciar/cancelar assinatura)
   body: { uid } */
exports.portalListaOff = functions
  .region("us-central1")
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).send("");

    try {
      const { uid } = req.body || {};
      const snap = await db.collection("contas").doc(uid).get();
      const conta = snap.exists ? snap.data() : {};
      if (!conta.stripeCustomerId) return res.status(400).json({ error: "sem assinatura" });
      const session = await stripe.billingPortal.sessions.create({
        customer: conta.stripeCustomerId,
        return_url: `${APP_URL}/?v=painel`,
      });
      return res.json({ url: session.url });
    } catch (e) {
      console.error("portalListaOff", e);
      return res.status(500).json({ error: e.message });
    }
  });

/* 3) webhookListaOff — Stripe avisa mudanças da assinatura -> atualiza a conta
   Eventos a escutar no painel:
     checkout.session.completed
     customer.subscription.created
     customer.subscription.updated
     customer.subscription.deleted */
exports.webhookListaOff = functions
  .region("us-central1")
  .https.onRequest(async (req, res) => {
    let event;
    try {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(req.rawBody, sig, WEBHOOK_SECRET);
    } catch (e) {
      console.error("assinatura do webhook inválida", e.message);
      return res.status(400).send(`Webhook Error: ${e.message}`);
    }

    try {
      // liga a conta ao customer do Stripe assim que a compra fecha
      if (event.type === "checkout.session.completed") {
        const s = event.data.object;
        const uid = s.metadata && s.metadata.uid;
        if (uid && s.customer) {
          await db.collection("contas").doc(uid).set(
            { stripeCustomerId: s.customer }, { merge: true }
          );
          await db.collection("compras").add({
            uid, plano: (s.metadata && s.metadata.plano) || "mensal",
            email: s.customer_email || "",
            stripeSession: s.id, criadoEm: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }

      // assinatura criada/renovada/em trial -> grava plano + validade + trial
      if (event.type === "customer.subscription.created" ||
          event.type === "customer.subscription.updated") {
        const sub = event.data.object;
        const uid = sub.metadata && sub.metadata.uid;
        // ativo se paga OU em período de teste
        const ativo = sub.status === "active" || sub.status === "trialing";
        const ate = sub.current_period_end
          ? admin.firestore.Timestamp.fromMillis(sub.current_period_end * 1000)
          : null;
        const trialAte = sub.trial_end
          ? admin.firestore.Timestamp.fromMillis(sub.trial_end * 1000)
          : null;
        if (uid) {
          await db.collection("contas").doc(uid).set(
            {
              plano: ativo ? "mensal" : null,
              planoAte: ativo ? ate : null,
              trialAte: trialAte,
              stripeCustomerId: sub.customer,
            },
            { merge: true }
          );
        }
      }

      // assinatura cancelada/expirada -> tira o plano
      if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;
        const uid = sub.metadata && sub.metadata.uid;
        if (uid) {
          await db.collection("contas").doc(uid).set(
            { plano: null, planoAte: null }, { merge: true }
          );
        }
      }
    } catch (e) {
      console.error("erro ao processar webhook", e);
    }

    return res.json({ received: true });
  });
