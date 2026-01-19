const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Configuration POUR GROQ
const CONFIG = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  GROQ_MODEL: "llama-3.1-8b-instant"  // Modèle gratuit et rapide
};

// Cache pour éviter les appels répétitifs (optionnel mais recommandé)
const responseCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// ==================== FONCTION GROQ AI ====================
async function getGroqAIResponse(userMessage) {
  try {
    console.log(`🤖 Appel Groq AI: "${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}"`);
    
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: CONFIG.GROQ_MODEL,
        messages: [
          {
            role: "system",
            content: `Tu es une assistante médicale francophone stricte.
RÈGLES ABSOLUES:
1. Réponse en 2-3 phrases MAXIMUM
2. JAMAIS de diagnostic
3. URGENCES: "Composez le 15 (SAMU) ou 112 IMMÉDIATEMENT"
4. Autres: conseils généraux seulement
5. Pas de formules de politesse inutiles`
          },
          {
            role: "user", 
            content: userMessage
          }
        ],
        temperature: 0.7,
        max_tokens: 120,
        stream: false
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 8000  // Timeout court
      }
    );

    // Vérification rigoureuse de la réponse
    if (!response.data || 
        !response.data.choices || 
        !Array.isArray(response.data.choices) || 
        response.data.choices.length === 0 ||
        !response.data.choices[0].message ||
        !response.data.choices[0].message.content ||
        response.data.choices[0].message.content.trim() === '') {
      
      console.error('❌ Réponse Groq vide ou invalide:', JSON.stringify(response.data));
      throw new Error('Réponse IA vide');
    }

    const aiResponse = response.data.choices[0].message.content.trim();
    console.log(`✅ Réponse Groq: "${aiResponse.substring(0, 80)}${aiResponse.length > 80 ? '...' : ''}"`);
    
    return aiResponse;

  } catch (error) {
    console.error('💥 Erreur Groq API:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    
    // PROPAGER l'erreur au lieu de retourner un message par défaut
    throw new Error(`Erreur IA: ${error.message}`);
  }
}

// ==================== WEBHOOK GET ====================
app.get('/api/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log(`🔐 Vérification webhook: mode=${mode}, token=${token ? '***' : 'none'}`);

  if (mode && token === CONFIG.VERIFY_TOKEN) {
    console.log('✅ Webhook vérifié');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Échec vérification webhook');
    res.status(403).send('Token invalide');
  }
});

// ==================== WEBHOOK POST ====================
app.post('/api/webhook', async (req, res) => {
  console.log('📩 Webhook POST reçu');
  
  // Répondre immédiatement à WhatsApp
  res.status(200).send('EVENT_RECEIVED');

  try {
    const { body } = req;
    
    // Validation rigoureuse de la structure
    if (!body.entry || 
        !Array.isArray(body.entry) || 
        body.entry.length === 0 ||
        !body.entry[0].changes ||
        !Array.isArray(body.entry[0].changes) ||
        body.entry[0].changes.length === 0 ||
        !body.entry[0].changes[0].value ||
        !body.entry[0].changes[0].value.messages ||
        !Array.isArray(body.entry[0].changes[0].value.messages)) {
      
      console.log('⚠️ Structure webhook invalide');
      return;
    }

    const message = body.entry[0].changes[0].value.messages[0];
    
    if (!message || message.type !== 'text' || !message.text || !message.text.body) {
      console.log(`⚠️ Message non-textuel ou invalide: type=${message?.type}`);
      return;
    }

    const from = message.from;
    const text = message.text.body;

    console.log(`👤 ${from}: "${text}"`);

    let aiResponse;
    try {
      // Vérification cache
      const cacheKey = `${from}:${text.toLowerCase().substring(0, 30)}`;
      const cached = responseCache.get(cacheKey);
      
      if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
        console.log('📦 Utilisation cache');
        aiResponse = cached.response;
      } else {
        // Appel réel à Groq
        aiResponse = await getGroqAIResponse(text);
        
        // Mettre en cache
        responseCache.set(cacheKey, {
          response: aiResponse,
          timestamp: Date.now()
        });
        
        // Limiter la taille du cache
        if (responseCache.size > 100) {
          const firstKey = responseCache.keys().next().value;
          responseCache.delete(firstKey);
        }
      }

      // Envoyer la réponse via WhatsApp
      await sendWhatsAppMessage(from, aiResponse);
      
    } catch (aiError) {
      // Ici on ne fait RIEN si l'IA échoue
      console.error(`🚨 ÉCHEC GROQ pour ${from}:`, aiError.message);
      // PAS de message par défaut, PAS de réponse WhatsApp
      return; // On sort simplement
    }

  } catch (error) {
    console.error('💥 Erreur générale webhook:', error.message, error.stack);
  }
});

// ==================== ENVOI WHATSAPP ====================
async function sendWhatsAppMessage(to, text) {
  try {
    console.log(`📤 Envoi à ${to}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
    
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
          'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    console.log(`✅ Message envoyé à ${to}, ID: ${response.data?.messages?.[0]?.id || 'N/A'}`);
    
  } catch (error) {
    console.error(`❌ Échec envoi WhatsApp à ${to}:`, {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    // Ne pas propager, on logue seulement
  }
}

// ==================== ROUTES UTILITAIRES ====================
app.get('/health', (req, res) => {
  const health = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'WhatsApp Medical Bot (Groq)',
    variables: {
      VERIFY_TOKEN: !!CONFIG.VERIFY_TOKEN,
      PHONE_NUMBER_ID: !!CONFIG.PHONE_NUMBER_ID,
      WHATSAPP_TOKEN: !!CONFIG.WHATSAPP_TOKEN,
      GROQ_API_KEY: !!CONFIG.GROQ_API_KEY
    },
    cache: {
      size: responseCache.size,
      maxAge: `${CACHE_DURATION / 60000} minutes`
    }
  };
  
  res.status(200).json(health);
});

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>WhatsApp Medical Bot - Groq AI</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }
          .status { padding: 10px; border-radius: 5px; margin: 10px 0; }
          .ok { background: #d4edda; color: #155724; }
          .error { background: #f8d7da; color: #721c24; }
        </style>
      </head>
      <body>
        <h1>🤖 WhatsApp Medical Bot</h1>
        <p><strong>IA:</strong> Groq (${CONFIG.GROQ_MODEL})</p>
        <p><strong>Status:</strong> <span class="status ok">En ligne</span></p>
        <p><strong>URL:</strong> https://whatsapp-bot-d2i4.onrender.com</p>
        <p><strong>Webhook:</strong> <code>/api/webhook</code></p>
        <p><strong>Health:</strong> <a href="/health">/health</a></p>
        <hr>
        <p><strong>Comportement:</strong></p>
        <ul>
          <li>Réponses uniquement via Groq AI</li>
          <li>Si Groq échoue → PAS de réponse WhatsApp</li>
          <li>Cache activé (5 min)</li>
          <li>Validation stricte des messages</li>
        </ul>
      </body>
    </html>
  `);
});

// ==================== DÉMARRAGE SERVEUR ====================
const PORT = process.env.PORT || 10000;

// Vérification des variables au démarrage
const requiredVars = ['VERIFY_TOKEN', 'PHONE_NUMBER_ID', 'WHATSAPP_TOKEN', 'GROQ_API_KEY'];
const missingVars = requiredVars.filter(varName => !process.env[varName]);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
=======================================
🚀 WhatsApp Medical Bot (Groq Edition)
📍 Port: ${PORT}
🌐 URL: https://whatsapp-bot-d2i4.onrender.com
🤖 IA: Groq ${CONFIG.GROQ_MODEL}
=======================================
Variables requises:
${requiredVars.map(varName => 
  `  ${process.env[varName] ? '✅' : '❌'} ${varName}: ${process.env[varName] ? 'Défini' : 'MANQUANT'}`
).join('\n')}
${missingVars.length > 0 ? `\n⚠️  Variables manquantes: ${missingVars.join(', ')}` : ''}
=======================================
  `);
});