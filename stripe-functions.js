/* =====================================================================
   LISTA OFF — Firebase Functions do Stripe (compra de CRÉDITOS)
   =====================================================================
   Reutiliza a MESMA conta Stripe do iGastei (mesma secret key).
   Diferença: no iGastei é ASSINATURA; aqui é PAGAMENTO ÚNICO de crédito.
   Quando a compra é paga, o webhook SOMA créditos na conta do dono.

   Coloque este arquivo dentro da pasta `functions/` do projeto Firebase
   `lista-off-bc957` (ou junto das functions que você já tem).
   ===================================================================== */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// A secret key fica em variável de ambiente — NUNCA no código.
// defina com:  firebase functions:secrets:set STRIPE_SECRET
// (modo produção usa sk_live_...)
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_LISTAOFF; // whsec_...

// URL do app (pra onde o Stripe volta depois do pagamento)
const APP_URL = "https://listaoff.com.br";

/* ---------------------------------------------------------------------
   1) createCheckoutListaOff — abre o checkout de um pacote de créditos
   O app chama isto via fetch POST { priceId, uid, email, eventos, pacote }
   --------------------------------------------------------------------- */
exports.createCheckoutListaOff = functions
  .region("us-central1")
  .https.onRequest(async (req, res) => {
    // CORS (o app está em listaoff.com.br)
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).send("");

    try {
      const { priceId, uid, email, eventos, pacote } = req.body || {};
      if (!priceId || !uid) return res.status(400).json({ error: "faltam dados" });

      const session = await stripe.checkout.sessions.create({
        mode: "payment", // pagamento único, não assinatura
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        customer_email: email || undefined,
        // esses metadados voltam no webhook pra sabermos quem creditar
        metadata: { uid, eventos: String(eventos || 0), pacote: pacote || "" },
        success_url: `${APP_URL}/?v=painel&pag=ok`,
        cancel_url: `${APP_URL}/?v=painel&pag=cancel`,
      });

      return res.json({ url: session.url });
    } catch (e) {
      console.error("createCheckoutListaOff", e);
      return res.status(500).json({ error: e.message });
    }
  });

/* ---------------------------------------------------------------------
   2) webhookListaOff — Stripe avisa que a compra foi paga → soma créditos
   Configure este endpoint no painel do Stripe (evento: checkout.session.completed)
   --------------------------------------------------------------------- */
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

    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      const uid = s.metadata && s.metadata.uid;
      const eventos = parseInt((s.metadata && s.metadata.eventos) || "0", 10);
      const valor = (s.amount_total || 0) / 100;

      if (uid && eventos > 0) {
        try {
          await db.collection("contas").doc(uid).set(
            {
              creditos: admin.firestore.FieldValue.increment(eventos),
              gastoTotal: admin.firestore.FieldValue.increment(valor),
            },
            { merge: true }
          );
          // registro da compra (pra você acompanhar vendas no back)
          await db.collection("compras").add({
            uid,
            eventos,
            valor,
            pacote: (s.metadata && s.metadata.pacote) || "",
            email: s.customer_email || "",
            stripeSession: s.id,
            criadoEm: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`+${eventos} créditos para ${uid} (R$ ${valor})`);
        } catch (e) {
          console.error("erro ao creditar", e);
        }
      }
    }

    return res.json({ received: true });
  });
