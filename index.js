const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Configuration POUR RENDER
const CONFIG = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  GOOGLE_AI_API_KEY: process.env.GOOGLE_AI_API_KEY,
  MODEL_NAME: "gemini-2.0-flash-exp"  // Modèle gratuit disponible
};

// Vérification des variables au démarrage
const requiredVars = ['VERIFY_TOKEN', 'PHONE_NUMBER_ID', 'WHATSAPP_TOKEN', 'GOOGLE_AI_API_KEY'];
const missingVars = requiredVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.warn(`⚠️  Variables manquantes: ${missingVars.join(', ')}`);
  console.warn('Elles doivent être configurées sur Render.com');
}

// Vérification du webhook
app.get('/api/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log(`Webhook vérification: mode=${mode}, token=${token}`);

  if (mode && token === CONFIG.VERIFY_TOKEN) {
    console.log('✅ Webhook vérifié avec succès');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Échec de la vérification du webhook');
    res.status(403).send('Token invalide');
  }
});

// Traitement des messages entrants
app.post('/api/webhook', async (req, res) => {
  console.log('📩 Message reçu');
  
  // Répondre immédiatement à WhatsApp
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    const entry = body.entry && body.entry[0];
    const change = entry.changes && entry.changes[0];
    const value = change.value;
    const message = value.messages && value.messages[0];
    const from = message.from;
    const text = message.text && message.text.body;

    if (text) {
      console.log(`👤 Message de ${from}: ${text}`);

      const aiResponse = await getGoogleAIResponse(text);
      console.log(`🤖 Réponse IA: ${aiResponse.substring(0, 100)}...`);

      await sendMessage(from, aiResponse);
    }
  } catch (error) {
    console.error('💥 Erreur:', error.message);
  }
});

// Fonction pour obtenir une réponse de l'IA Gemini
async function getGoogleAIResponse(userMessage) {
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODEL_NAME}:generateContent?key=${CONFIG.GOOGLE_AI_API_KEY}`,
      {
        contents: [{
          parts: [{
            text: `Tu es une assistante médicale. Réponds de manière concise et utile aux questions sur la santé, les médicaments, et les urgences. Ne fais pas de diagnostic. Pour les urgences, recommande d'appeler le 185 (SAMU) ou le 1410 (pharmacies de garde). Voici la question de l'utilisateur: ${userMessage}`
          }]
        }]
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      }
    );

    if (response.data.candidates && response.data.candidates[0].content.parts) {
      return response.data.candidates[0].content.parts[0].text;
    } else {
      return "Désolé, je n'ai pas pu générer de réponse. Veuillez réessayer.";
    }
  } catch (error) {
    console.error("Erreur avec l'IA:", error.message);
    return "Je rencontre des difficultés techniques. Veuillez réessayer plus tard.";
  }
}

// Fonction pour envoyer un message via WhatsApp
async function sendMessage(to, text) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "text",
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    console.log(`✅ Message envoyé à ${to}`);
  } catch (error) {
    console.error(`❌ Erreur envoi à ${to}:`, error.response?.data || error.message);
  }
}

// Route de santé pour Render
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'WhatsApp Webhook',
    variables: {
      VERIFY_TOKEN: !!CONFIG.VERIFY_TOKEN,
      PHONE_NUMBER_ID: !!CONFIG.PHONE_NUMBER_ID,
      WHATSAPP_TOKEN: !!CONFIG.WHATSAPP_TOKEN,
      GOOGLE_AI_API_KEY: !!CONFIG.GOOGLE_AI_API_KEY
    }
  });
});

// Route racine
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>WhatsApp Medical Bot</title></head>
      <body style="font-family: Arial; padding: 20px;">
        <h1>🤖 WhatsApp Medical Bot</h1>
        <p>Service en ligne et fonctionnel !</p>
        <p><a href="/health">Vérifier l'état du service</a></p>
        <p>Webhook: <code>/api/webhook</code></p>
      </body>
    </html>
  `);
});

// Démarrer le serveur - IMPORTANT POUR RENDER
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
=======================================
🚀 Serveur WhatsApp Bot démarré
📍 Port: ${PORT}
🔗 Local: http://localhost:${PORT}
🌐 Webhook: /api/webhook
🏥 Health: /health
=======================================
Variables d'environnement:
✅ VERIFY_TOKEN: ${CONFIG.VERIFY_TOKEN ? 'Défini' : 'MANQUANT'}
✅ PHONE_NUMBER_ID: ${CONFIG.PHONE_NUMBER_ID ? 'Défini' : 'MANQUANT'}
✅ WHATSAPP_TOKEN: ${CONFIG.WHATSAPP_TOKEN ? 'Défini' : 'MANQUANT'}
✅ GOOGLE_AI_API_KEY: ${CONFIG.GOOGLE_AI_API_KEY ? 'Défini' : 'MANQUANT'}
=======================================
  `);
});