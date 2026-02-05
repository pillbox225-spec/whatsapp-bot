require('dotenv').config();
const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

// Initialisation Express
const app = express();
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

// Initialisation Firebase
let db;
let FieldValue;

(async () => {
  try {
    if (admin.apps.length === 0) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`,
        projectId: process.env.FIREBASE_PROJECT_ID
      });
    }
    db = admin.firestore();
    FieldValue = admin.firestore.FieldValue;
    
    console.log('✅ Firebase connecté');
  } catch (error) {
    console.error('❌ Firebase:', error.message);
    process.exit(1);
  }
})();

// Configuration globale
const CONFIG = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  GROQ_MODEL: process.env.GROQ_MODEL || "mixtral-8x7b-32768",
  SUPPORT_PHONE: process.env.SUPPORT_PHONE || "2250701406880",
  LIVRAISON_JOUR: parseInt(process.env.LIVRAISON_JOUR) || 400,
  LIVRAISON_NUIT: parseInt(process.env.LIVRAISON_NUIT) || 600,
  ZONE_SERVICE: process.env.ZONE_SERVICE || "San Pedro"
};

// =================== SYSTÈME DE LOGS ===================
class Logger {
  static info(...args) { console.log('ℹ️', ...args); }
  static error(...args) { console.error('❌', ...args); }
  static message(userId, direction, text) {
    const prefix = direction === 'in' ? '📩' : '📤';
    console.log(`${prefix} ${userId}: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
  }
}

// =================== ASSISTANT MÉDICAL IA ===================
class AssistantMedicalIA {
  constructor() {
    this.historiques = new Map();
  }

  async getMedicamentsDisponibles() {
    try {
      const snapshot = await db.collection('medicaments')
        .where('stock', '>', 0)
        .limit(30)
        .get();
      
      if (snapshot.empty) return "Aucun médicament en stock.";
      
      let data = "MÉDICAMENTS DISPONIBLES:\n";
      const medicaments = [];
      
      for (const doc of snapshot.docs) {
        const med = doc.data();
        const pharmacieDoc = await db.collection('pharmacies').doc(med.pharmacieId).get();
        const pharmacieNom = pharmacieDoc.exists ? pharmacieDoc.data().nom : 'Pharmacie';
        
        medicaments.push({
          id: doc.id,
          nom: med.nom || '',
          sousTitre: med.sousTitre || '',
          prix: med.prix || 0,
          stock: med.stock || 0,
          ordonnance: med.necessiteOrdonnance ? 'OUI' : 'NON',
          pharmacie: pharmacieNom,
          dosage: med.dosage || '',
          forme: med.forme || ''
        });
      }
      
      medicaments.slice(0, 15).forEach(med => {
        data += `• ${med.nom} ${med.sousTitre} ${med.dosage}${med.forme} | ${med.prix} FCFA | Stock: ${med.stock} | Ordonnance: ${med.ordonnance} | ${med.pharmacie}\n`;
      });
      
      return data;
    } catch (error) {
      return "Base médicaments temporairement indisponible.";
    }
  }

  async getPharmaciesDeGarde() {
    try {
      const snapshot = await db.collection('pharmacies')
        .where('estDeGarde', '==', true)
        .where('estOuvert', '==', true)
        .limit(10)
        .get();
      
      if (snapshot.empty) return "Aucune pharmacie de garde.";
      
      let data = "PHARMACIES DE GARDE:\n";
      snapshot.docs.forEach((doc, index) => {
        const p = doc.data();
        data += `${index + 1}. ${p.nom || 'Pharmacie'} | ${p.adresse || CONFIG.ZONE_SERVICE} | 📞 ${p.telephone || 'Non disponible'} | ⏰ ${p.horaires || '24h/24'}\n`;
      });
      
      return data;
    } catch (error) {
      return "Base pharmacies temporairement indisponible.";
    }
  }

  async getCliniques() {
    try {
      const snapshot = await db.collection('centres_sante')
        .where('estVerifie', '==', true)
        .limit(10)
        .get();
      
      if (snapshot.empty) return "Aucune clinique disponible.";
      
      let data = "CLINIQUES DISPONIBLES:\n";
      snapshot.docs.forEach((doc, index) => {
        const c = doc.data();
        const specialites = c.specialites && Array.isArray(c.specialites) 
          ? c.specialites.slice(0, 3).join(', ')
          : 'Non spécifié';
        data += `${index + 1}. ${c.nom || 'Clinique'} | ${c.adresse || CONFIG.ZONE_SERVICE} | 📞 ${c.telephone || 'Non disponible'} | 🩺 ${specialites}\n`;
      });
      
      return data;
    } catch (error) {
      return "Base cliniques temporairement indisponible.";
    }
  }

  async comprendreEtAgir(userId, message, userState) {
    try {
      // Récupérer toutes les données en parallèle
      const [medicaments, pharmacies, cliniques] = await Promise.all([
        this.getMedicamentsDisponibles(),
        this.getPharmaciesDeGarde(),
        this.getCliniques()
      ]);

      // Récupérer l'historique
      let historique = this.historiques.get(userId) || [];
      if (historique.length > 10) historique = historique.slice(-10);
      const historiqueFormatte = historique.map(h => `${h.role}: ${h.message}`).join('\n');

      // État utilisateur
      const etatUtilisateur = userState ? `
## ÉTAT UTILISATEUR:
- Panier: ${userState.panier?.length || 0} médicament(s)
- En cours de commande: ${userState.enCoursCommande ? 'Oui' : 'Non'}
- Attente confirmation: ${userState.attenteConfirmation ? 'Oui' : 'Non'}
- Derniers résultats recherche: ${userState.derniersResultats?.length || 0} médicament(s)
` : '';

      const prompt = `# ASSISTANT MÉDICAL MIA - PILLBOX ${CONFIG.ZONE_SERVICE}

## TON IDENTITÉ:
Tu es Mia, assistante médicale IA créée par Yousself et Delphin (Université Polytechnique de San Pedro).
Tu travailles pour Pillbox, service de livraison de médicaments et prise de rendez-vous à ${CONFIG.ZONE_SERVICE}, Côte d'Ivoire.

## DONNÉES RÉELLES (Firestore):

### ${medicaments}

### ${pharmacies}

### ${cliniques}

## HISTORIQUE DE CONVERSATION:
${historiqueFormatte || "Première conversation"}

${etatUtilisateur}

## MESSAGE UTILISATEUR ACTUEL:
"${message}"

## TES CAPACITÉS:

### 1. CORRECTION AUTOMATIQUE DES FAUTES:
- "aujourdhui" → "aujourd'hui"
- "jaimerais" → "j'aimerais"
- "metridonazole" → "metronidazole"
- "paracetemol" → "paracétamol"
- Corrige TOUTES les fautes automatiquement

### 2. COMPRÉHENSION DES SYMPTÔMES:
- "j'ai mal à la tête" → suggère paracétamol
- "je tousse" → suggère sirop pour la touse
- "fièvre" → suggère antipyrétique
- Comprend le langage naturel médical

### 3. GESTION DES ORDONNANCES:
⚠️ **TRÈS IMPORTANT:** Si un médicament nécessite une ordonnance, tu DOIS dire:
"📄 ORDONNANCE REQUISE - Pour commander ce médicament, envoyez une photo de votre ordonnance au support client: ${CONFIG.SUPPORT_PHONE}"
Ne JAMAIS omettre cette information!

### 4. FLUX DE COMMANDE INTELLIGENT:
- Si utilisateur dit "acheter [médicament]": chercher le médicament
- Si utilisateur dit "ajouter [numéro] [quantité]": ajouter au panier
- Si utilisateur dit "terminer": finaliser la commande
- Si utilisateur dit "oui" après confirmation: CONFIRMER LA COMMANDE (ne pas demander autre chose)
- Si utilisateur dit "ses tout ce que je voulais": comprendre que c'est terminé
- Si utilisateur dit "merci": répondre poliment

### 5. RECHERCHE ET RECOMMANDATIONS:
- Utilise les données réelles ci-dessus
- Propose des alternatives si médicament non disponible
- Donne les prix exacts
- Indique la pharmacie de disponibilité

### 6. FORMAT DES RÉPONSES:
- Sois naturel, conversationnel
- Utilise des émojis appropriés: 💊🏥🚚📞
- Structure clairement les informations
- Termine par une question ou prochaine étape quand c'est pertinent

## EXEMPLES DE RÉPONSES:

**Utilisateur:** "bonsoir"
**Toi:** "Bonsoir ! 😊 Je suis Mia, votre assistante médicale. Comment puis-je vous aider ce soir ?"

**Utilisateur:** "quelle pharmacie de garde aujourdhui"
**Toi:** "Je vérifie les pharmacies de garde à ${CONFIG.ZONE_SERVICE}..."
[Le code enverra ensuite la vraie liste]

**Utilisateur:** "acheter metronidazole"
**Toi:** "Je recherche metronidazole dans notre base de données..."
[Le code cherchera et affichera les résultats]

**Utilisateur:** "ajouter 1 2"
**Toi:** "✅ Ajout de metronidazole au panier..."
[Le code gérera l'ajout au panier]

**Utilisateur:** "terminer"
**Toi:** "Parfait ! Je finalise votre commande..."
[Le code démarrera le processus de commande]

**Utilisateur:** "oui" (après confirmation commande)
**Toi:** "✅ COMMANDE CONFIRMÉE ! Votre commande #CMD123 a été créée avec succès. La pharmacie et le livreur ont été notifiés. Vous recevrez un appel pour la livraison. 📞 Support: ${CONFIG.SUPPORT_PHONE}"

**Utilisateur:** "ses tout ce que je voulais"
**Toi:** "Parfait ! Votre commande est complète. Dites 'terminer' pour finaliser."

**Utilisateur:** "jaimerais vois ma commande"
**Toi:** "Je cherche vos commandes récentes..."
[Le code affichera l'historique]

**Utilisateur:** "merci"
**Toi:** "Avec plaisir ! 😊 N'hésitez pas si vous avez besoin d'autre chose."

## LOGIQUE DE DÉCISION:
1. Analyse le message utilisateur
2. Corrige les fautes automatiquement
3. Comprend l'intention (recherche, commande, information)
4. Utilise les données réelles pour répondre
5. Propose la prochaine étape logique

## MAINTENANT, RÉPONDS À:
"${message}"

Rappels critiques:
1. Corrige TOUTES les fautes d'orthographe
2. Pour les médicaments avec ordonnance: MENTIONNE OBLIGATOIREMENT le support ${CONFIG.SUPPORT_PHONE}
3. Après "oui" pour confirmation: CONFIRME LA COMMANDE, ne demande pas autre chose
4. Sois naturel et empathique`;

      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: CONFIG.GROQ_MODEL,
          messages: [
            {
              role: "system",
              content: "Tu es Mia, assistante médicale IA. Tu corriges automatiquement TOUTES les fautes d'orthographe. Tu es précise, empathique et professionnelle. Tu travailles exclusivement pour la zone de San Pedro, Côte d'Ivoire. Pour les médicaments nécessitant ordonnance, tu mentions TOUJOURS d'envoyer la photo au support client."
            },
            { role: "user", content: prompt }
          ],
          temperature: 0.3,
          max_tokens: 1000
        },
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      const reponseIA = response.data.choices[0].message.content;
      
      // Mettre à jour l'historique
      historique.push({ role: 'user', message });
      historique.push({ role: 'assistant', message: reponseIA });
      this.historiques.set(userId, historique);
      
      return reponseIA;
      
    } catch (error) {
      console.error('Erreur IA:', error.message);
      return `Je rencontre un problème technique momentané. 😔

Pour une assistance immédiate:
📞 Contactez notre support: ${CONFIG.SUPPORT_PHONE}
🏥 Pharmacie de garde: Pharmacie Cosmos - 24h/24

Je reviens dès que possible !`;
    }
  }

  nettoyerHistorique(userId) {
    this.historiques.delete(userId);
  }
}

// =================== GESTION UTILISATEUR ===================
const DEFAULT_STATE = {
  panier: [],
  enCoursCommande: false,
  commandeInfo: null,
  attenteConfirmation: false,
  attenteNom: false,
  attenteQuartier: false,
  attenteWhatsApp: false,
  attenteIndications: false,
  derniersResultats: null,
  derniereInteraction: Date.now(),
  rechercheEnCours: false
};

const userStates = new Map();
const assistantIA = new AssistantMedicalIA();

// =================== FONCTIONS UTILITAIRES ===================
async function sendWhatsAppMessage(to, text) {
  try {
    Logger.message(to, 'out', text);

    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "text",
        text: { body: text.substring(0, 4096) }
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    return response.data.messages?.[0]?.id;
  } catch (error) {
    Logger.error('Erreur envoi WhatsApp:', error.message);
    return null;
  }
}

async function markMessageAsRead(messageId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );
  } catch (error) {
    // Ignorer les erreurs de marquage
  }
}

function getFraisLivraison() {
  const heure = new Date().getHours();
  return (heure >= 0 && heure < 8) ? CONFIG.LIVRAISON_NUIT : CONFIG.LIVRAISON_JOUR;
}

async function afficherPharmaciesDeGarde(userId) {
  try {
    const snapshot = await db.collection('pharmacies')
      .where('estDeGarde', '==', true)
      .where('estOuvert', '==', true)
      .limit(5)
      .get();
    
    if (snapshot.empty) {
      await sendWhatsAppMessage(userId, "Aucune pharmacie de garde trouvée actuellement.");
      return;
    }
    
    let message = `🏥 PHARMACIES DE GARDE - ${CONFIG.ZONE_SERVICE.toUpperCase()}\n\n`;
    
    snapshot.docs.forEach((doc, index) => {
      const p = doc.data();
      message += `${index + 1}. ${p.nom || 'Pharmacie'}\n`;
      message += `   📍 ${p.adresse || CONFIG.ZONE_SERVICE}\n`;
      message += `   📞 ${p.telephone || 'Non disponible'}\n`;
      message += `   ⏰ ${p.horaires || '24h/24'}\n\n`;
    });
    
    message += `💊 Commander en ligne: "acheter [nom du médicament]"`;
    
    await sendWhatsAppMessage(userId, message);
    
  } catch (error) {
    await sendWhatsAppMessage(userId, "⚠️ Problème pour récupérer les pharmacies. Contactez le support.");
  }
}

async function rechercherMedicament(userId, terme) {
  try {
    const snapshot = await db.collection('medicaments')
      .where('stock', '>', 0)
      .limit(20)
      .get();
    
    const medicaments = [];
    
    for (const doc of snapshot.docs) {
      const med = doc.data();
      const nomMed = (med.nom || '').toLowerCase();
      const sousTitre = (med.sousTitre || '').toLowerCase();
      const termeLower = terme.toLowerCase();
      
      if (nomMed.includes(termeLower) || sousTitre.includes(termeLower)) {
        const pharmacieDoc = await db.collection('pharmacies').doc(med.pharmacieId).get();
        const pharmacieNom = pharmacieDoc.exists ? pharmacieDoc.data().nom : 'Pharmacie';
        
        medicaments.push({
          id: doc.id,
          ...med,
          pharmacieNom: pharmacieNom
        });
      }
    }
    
    if (medicaments.length === 0) {
      await sendWhatsAppMessage(userId, `❌ Aucun résultat pour "${terme}" en stock.\n\n📞 Support: ${CONFIG.SUPPORT_PHONE}`);
      return null;
    }
    
    // Afficher résultats
    let message = `💊 RÉSULTATS POUR "${terme.toUpperCase()}"\n\n`;
    
    medicaments.slice(0, 5).forEach((med, index) => {
      message += `${index + 1}. ${med.nom}`;
      if (med.sousTitre) message += ` (${med.sousTitre})`;
      message += `\n   💰 ${med.prix || '?'} FCFA\n   🏥 ${med.pharmacieNom}\n`;
      if (med.dosage || med.forme) {
        message += `   📏 ${med.dosage || ''} ${med.forme || ''}\n`;
      }
      message += `   ${med.necessiteOrdonnance ? '📄 Ordonnance requise' : '✅ Sans ordonnance'}\n\n`;
    });
    
    message += `🛒 POUR COMMANDER:\n"ajouter [numéro] [quantité]"\nEx: "ajouter 1 2" pour 2 du n°1\n\n`;
    message += `Après ajout, dites "continuer" ou "terminer".`;
    
    await sendWhatsAppMessage(userId, message);
    
    return medicaments;
    
  } catch (error) {
    await sendWhatsAppMessage(userId, `⚠️ Problème lors de la recherche.\n\n📞 Support: ${CONFIG.SUPPORT_PHONE}`);
    return null;
  }
}

async function ajouterAuPanier(userId, medicaments, numero, quantite, userState) {
  if (!userState.panier) userState.panier = [];
  
  const index = parseInt(numero) - 1;
  if (index < 0 || index >= medicaments.length) {
    await sendWhatsAppMessage(userId, "❌ Numéro invalide. Vérifiez la liste et réessayez.");
    return false;
  }
  
  const med = medicaments[index];
  
  // Vérifier ordonnance
  if (med.necessiteOrdonnance) {
    await sendWhatsAppMessage(
      userId,
      `📄 **ORDONNANCE REQUISE**\n\n` +
      `Le médicament "${med.nom}" nécessite une ordonnance médicale.\n\n` +
      `Pour commander:\n` +
      `1. Prenez une photo claire de votre ordonnance\n` +
      `2. Envoyez-la au support client:\n` +
      `📞 ${CONFIG.SUPPORT_PHONE}\n\n` +
      `Notre équipe vérifiera votre ordonnance et vous confirmera la commande.\n\n` +
      `⚠️ Sans ordonnance valide, nous ne pouvons pas fournir ce médicament.`
    );
    return false;
  }
  
  // Vérifier stock
  if (med.stock < quantite) {
    await sendWhatsAppMessage(userId, `❌ Stock insuffisant.\n\nDisponible: ${med.stock}\nDemandé: ${quantite}\n\nRéduisez la quantité ou choisissez un autre médicament.`);
    return false;
  }
  
  // Ajouter au panier
  const existe = userState.panier.findIndex(item => item.id === med.id);
  if (existe >= 0) {
    userState.panier[existe].quantite += quantite;
  } else {
    userState.panier.push({
      id: med.id,
      nom: med.nom,
      sousTitre: med.sousTitre || '',
      prix: med.prix || 0,
      quantite: quantite,
      pharmacieNom: med.pharmacieNom,
      necessiteOrdonnance: med.necessiteOrdonnance || false
    });
  }
  
  userStates.set(userId, userState);
  
  // Afficher confirmation
  const totalPanier = userState.panier.reduce((sum, item) => sum + (item.prix * item.quantite), 0);
  const fraisLivraison = getFraisLivraison();
  const total = totalPanier + fraisLivraison;
  
  let message = `✅ **AJOUTÉ AU PANIER**\n\n`;
  message += `💊 ${med.nom} × ${quantite}\n`;
  message += `💰 ${med.prix} FCFA × ${quantite} = ${med.prix * quantite} FCFA\n\n`;
  message += `🛒 **VOTRE PANIER:** ${userState.panier.length} médicament(s)\n`;
  message += `📦 Sous-total: ${totalPanier} FCFA\n`;
  message += `🚚 Livraison: ${fraisLivraison} FCFA\n`;
  message += `💵 **Total estimé: ${total} FCFA**\n\n`;
  message += `**Que souhaitez-vous faire ?**\n`;
  message += `• "continuer" pour ajouter un autre médicament\n`;
  message += `• "terminer" pour finaliser la commande\n`;
  message += `• "panier" pour voir le panier\n`;
  message += `• "vider" pour vider le panier`;
  
  await sendWhatsAppMessage(userId, message);
  return true;
}

async function afficherPanier(userId, userState) {
  const panier = userState.panier || [];
  
  if (panier.length === 0) {
    await sendWhatsAppMessage(userId, "🛒 Votre panier est vide.\n\nDites-moi ce dont vous avez besoin !");
    return;
  }
  
  const totalPanier = panier.reduce((sum, item) => sum + (item.prix * item.quantite), 0);
  const fraisLivraison = getFraisLivraison();
  const total = totalPanier + fraisLivraison;
  
  let message = `🛒 **VOTRE PANIER** (${panier.length} médicament(s))\n\n`;
  
  panier.forEach((item, index) => {
    message += `${index + 1}. ${item.nom}`;
    if (item.sousTitre) message += ` (${item.sousTitre})`;
    message += ` × ${item.quantite}\n`;
    message += `   ${item.prix} FCFA × ${item.quantite} = ${item.prix * item.quantite} FCFA\n\n`;
  });
  
  message += `🏥 **Pharmacie:** ${panier[0].pharmacieNom}\n`;
  message += `💰 **Sous-total:** ${totalPanier} FCFA\n`;
  message += `🚚 **Livraison:** ${fraisLivraison} FCFA\n`;
  message += `💵 **TOTAL: ${total} FCFA**\n\n`;
  message += `**Options:**\n`;
  message += `• "continuer" pour ajouter d'autres médicaments\n`;
  message += `• "terminer" pour finaliser la commande\n`;
  message += `• "vider" pour vider le panier`;
  
  await sendWhatsAppMessage(userId, message);
}

async function viderPanier(userId, userState) {
  userState.panier = [];
  userStates.set(userId, userState);
  
  await sendWhatsAppMessage(userId, "🗑️ **Panier vidé.**\n\nDites-moi ce dont vous avez besoin !");
}

async function finaliserCommande(userId, userState) {
  const panier = userState.panier || [];
  
  if (panier.length === 0) {
    await sendWhatsAppMessage(userId, "❌ Votre panier est vide.\n\nDites-moi ce dont vous avez besoin !");
    return;
  }
  
  const totalPanier = panier.reduce((sum, item) => sum + (item.prix * item.quantite), 0);
  const fraisLivraison = getFraisLivraison();
  const total = totalPanier + fraisLivraison;
  
  let message = `✅ **PANIER FINALISÉ**\n\n`;
  message += `**Votre commande (${panier.length} médicament(s)):**\n\n`;
  
  panier.forEach((item, index) => {
    message += `${index + 1}. ${item.nom}`;
    if (item.sousTitre) message += ` (${item.sousTitre})`;
    message += ` × ${item.quantite}\n`;
    message += `   ${item.prix} FCFA × ${item.quantite} = ${item.prix * item.quantite} FCFA\n\n`;
  });
  
  message += `🏥 **Pharmacie:** ${panier[0].pharmacieNom}\n`;
  message += `🚚 **Frais de livraison:** ${fraisLivraison} FCFA\n`;
  message += `💵 **TOTAL: ${total} FCFA**\n\n`;
  message += `**Pour finaliser, envoyez vos informations:**\n\n`;
  message += `1. **Votre nom complet**\n`;
  message += `2. **Votre quartier**\n`;
  message += `3. **Votre numéro WhatsApp**\n`;
  message += `4. **Indications pour la livraison**\n\n`;
  message += `**Commencez par votre nom:**`;
  
  await sendWhatsAppMessage(userId, message);
  
  userState.enCoursCommande = true;
  userState.commandeInfo = {
    panier: panier,
    total: total,
    fraisLivraison: fraisLivraison,
    totalPanier: totalPanier
  };
  userState.attenteNom = true;
  userStates.set(userId, userState);
}

async function collecterInfosCommande(userId, message, userState) {
  if (userState.attenteNom) {
    userState.commandeInfo.nom = message;
    userState.attenteNom = false;
    userState.attenteQuartier = true;
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "📍 **Quel est votre quartier ?**");
    return;
  }
  
  if (userState.attenteQuartier) {
    userState.commandeInfo.quartier = message;
    userState.attenteQuartier = false;
    userState.attenteWhatsApp = true;
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "📞 **Quel est votre numéro WhatsApp ?**");
    return;
  }
  
  if (userState.attenteWhatsApp) {
    userState.commandeInfo.whatsapp = message;
    userState.attenteWhatsApp = false;
    userState.attenteIndications = true;
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "📝 **Indications pour la livraison ?**\n(ex: maison bleue, sonnez 2 fois, porte à gauche)");
    return;
  }
  
  if (userState.attenteIndications) {
    userState.commandeInfo.indications = message;
    userState.attenteIndications = false;
    userState.attenteConfirmation = true;
    userStates.set(userId, userState);
    
    await confirmerCommande(userId, userState);
    return;
  }
}

async function confirmerCommande(userId, userState) {
  const cmd = userState.commandeInfo;
  
  let message = `✅ **CONFIRMATION DE COMMANDE**\n\n`;
  message += `**Informations client:**\n`;
  message += `👤 **Nom:** ${cmd.nom}\n`;
  message += `📍 **Quartier:** ${cmd.quartier}\n`;
  message += `📞 **WhatsApp:** ${cmd.whatsapp}\n`;
  message += `📝 **Indications:** ${cmd.indications || 'Aucune'}\n\n`;
  message += `**Votre commande:**\n\n`;
  
  cmd.panier.forEach((item, index) => {
    message += `${index + 1}. ${item.nom}`;
    if (item.sousTitre) message += ` (${item.sousTitre})`;
    message += ` × ${item.quantite}\n`;
    message += `   ${item.prix} FCFA × ${item.quantite} = ${item.prix * item.quantite} FCFA\n\n`;
  });
  
  message += `🏥 **Pharmacie:** ${cmd.panier[0].pharmacieNom}\n`;
  message += `🚚 **Frais de livraison:** ${cmd.fraisLivraison} FCFA\n`;
  message += `💵 **TOTAL: ${cmd.total} FCFA**\n\n`;
  message += `**Confirmez-vous cette commande ?**\n`;
  message += `✅ "oui" pour confirmer\n`;
  message += `❌ "non" pour annuler`;
  
  await sendWhatsAppMessage(userId, message);
}

async function creerCommandeFirestore(userId, userState) {
  try {
    const cmd = userState.commandeInfo;
    const commandeId = uuidv4().substring(0, 8).toUpperCase();
    
    // Créer la commande dans Firebase
    const commandeRef = db.collection('commandes_medicales').doc();
    
    const articles = cmd.panier.map(item => ({
      medicamentId: item.id,
      medicamentNom: item.nom,
      sousTitre: item.sousTitre || '',
      quantite: item.quantite,
      prix_unitaire: item.prix,
      necessiteOrdonnance: item.necessiteOrdonnance || false
    }));
    
    // Générer un code de sécurité
    const codeSecurite = Math.floor(100000 + Math.random() * 900000).toString();
    
    await commandeRef.set({
      clientId: userId,
      clientNom: cmd.nom,
      date_commande: admin.firestore.Timestamp.now(),
      date_modification: admin.firestore.Timestamp.now(),
      statut: 'en_attente',
      articles: articles,
      paiement: {
        montant_total: cmd.total,
        statut_paiement: 'en_attente',
        mode: 'cash_livraison'
      },
      livraison: {
        adresse: cmd.quartier,
        indications: cmd.indications || '',
        statut_livraison: 'en_attente',
        livreurId: null,
        livreurNom: null,
        livreurTelephone: null
      },
      pharmacieId: cmd.panier[0].id,
      pharmacienom: cmd.panier[0].pharmacieNom,
      code_securite: codeSecurite,
      ordonnanceUrl: null
    });
    
    // Message de confirmation
    await sendConfirmationCommande(userId, cmd, commandeId, codeSecurite);
    
    // Réinitialiser l'état utilisateur
    userState.panier = [];
    userState.enCoursCommande = false;
    userState.commandeInfo = null;
    userState.attenteConfirmation = false;
    userState.derniersResultats = null;
    userState.rechercheEnCours = false;
    userStates.set(userId, userState);
    
    // Nettoyer l'historique IA
    assistantIA.nettoyerHistorique(userId);
    
  } catch (error) {
    console.error('Erreur création commande:', error.message);
    await sendWhatsAppMessage(userId, `❌ Erreur lors de la création de la commande.\n\n📞 Contactez le support: ${CONFIG.SUPPORT_PHONE}`);
  }
}

async function sendConfirmationCommande(userId, cmd, commandeId, codeSecurite) {
  let message = `🎉 **COMMANDE #${commandeId} CONFIRMÉE !**\n\n`;
  
  message += `✅ Votre commande a été créée avec succès.\n\n`;
  message += `**Détails de la commande:**\n`;
  message += `📦 ${cmd.panier.length} médicament(s)\n`;
  message += `💰 Total: ${cmd.total} FCFA\n`;
  message += `📍 Livraison à: ${cmd.quartier}\n`;
  message += `📞 Contact: ${cmd.whatsapp}\n\n`;
  
  message += `**Prochaines étapes:**\n`;
  message += `1. ✅ La pharmacie prépare votre commande\n`;
  message += `2. 📞 Un livreur vous contactera pour la livraison\n`;
  message += `3. 💵 Paiement à la livraison (cash)\n`;
  message += `4. 🔒 Code de sécurité: ${codeSecurite}\n\n`;
  
  message += `**Informations importantes:**\n`;
  message += `• Présentez le code de sécurité au livreur\n`;
  message += `• Vérifiez les médicaments avant paiement\n`;
  message += `• Conservez vos médicaments correctement\n\n`;
  
  message += `📞 **Support client:** ${CONFIG.SUPPORT_PHONE}\n`;
  message += `_Merci pour votre confiance !_ 😊`;
  
  await sendWhatsAppMessage(userId, message);
}

async function afficherHistoriqueCommandes(userId) {
  try {
    const snapshot = await db.collection('commandes_medicales')
      .where('clientId', '==', userId)
      .orderBy('date_commande', 'desc')
      .limit(3)
      .get();
    
    if (snapshot.empty) {
      await sendWhatsAppMessage(userId, "📭 Vous n'avez pas encore passé de commande.\n\nDites-moi ce dont vous avez besoin !");
      return;
    }
    
    let message = `📋 **VOS DERNIÈRES COMMANDES**\n\n`;
    
    snapshot.docs.forEach((doc, index) => {
      const cmd = doc.data();
      message += `${index + 1}. **Commande #${doc.id.substring(0, 8)}**\n`;
      message += `   📅 ${new Date(cmd.date_commande.seconds * 1000).toLocaleDateString('fr-FR')}\n`;
      message += `   💰 ${cmd.paiement?.montant_total || 0} FCFA\n`;
      message += `   📍 ${cmd.livraison?.adresse || 'Non spécifié'}\n`;
      message += `   📦 ${cmd.statut || 'En attente'}\n\n`;
    });
    
    message += `Pour plus de détails, contactez le support: ${CONFIG.SUPPORT_PHONE}`;
    
    await sendWhatsAppMessage(userId, message);
    
  } catch (error) {
    await sendWhatsAppMessage(userId, `⚠️ Problème pour récupérer vos commandes.\n\n📞 Support: ${CONFIG.SUPPORT_PHONE}`);
  }
}

// =================== WEBHOOK WHATSAPP ===================
app.get('/api/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (mode && token === CONFIG.VERIFY_TOKEN) {
    Logger.info('Webhook vérifié');
    res.status(200).send(challenge);
  } else {
    Logger.error('Token invalide');
    res.status(403).send('Token invalide');
  }
});

app.post('/api/webhook', async (req, res) => {
  Logger.message('SYSTEM', 'in', 'Webhook reçu');
  
  res.status(200).send('EVENT_RECEIVED');
  
  setImmediate(async () => {
    try {
      const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!message) return;
      
      const userId = message.from;
      const messageType = message.type;
      
      if (message.id) {
        await markMessageAsRead(message.id);
      }
      
      if (messageType !== 'text') return;
      
      const text = message.text.body.trim();
      Logger.message(userId, 'in', text);
      
      // Récupérer ou créer l'état utilisateur
      let userState = userStates.get(userId);
      if (!userState) {
        userState = { ...DEFAULT_STATE };
        userStates.set(userId, userState);
      }
      userState.derniereInteraction = Date.now();
      
      const texteLower = text.toLowerCase();
      
      // =================== GESTION DES ÉTATS SPÉCIAUX ===================
      
      // 1. CONFIRMATION DE COMMANDE
      if (userState.attenteConfirmation) {
        if (texteLower === 'oui' || texteLower === 'oui pour confirmer') {
          await creerCommandeFirestore(userId, userState);
          return;
        } else if (texteLower === 'non' || texteLower === 'non pour annuler') {
          userState.enCoursCommande = false;
          userState.commandeInfo = null;
          userState.attenteConfirmation = false;
          userStates.set(userId, userState);
          await sendWhatsAppMessage(userId, "❌ Commande annulée.\n\nQue souhaitez-vous faire ?");
          return;
        }
      }
      
      // 2. COLLECTE D'INFORMATIONS POUR COMMANDE
      if (userState.attenteNom || userState.attenteQuartier || 
          userState.attenteWhatsApp || userState.attenteIndications) {
        await collecterInfosCommande(userId, text, userState);
        return;
      }
      
      // =================== COMMANDES DIRECTES ===================
      
      // 3. PHARMACIES DE GARDE
      if (texteLower.includes('pharmacie de garde') || 
          texteLower.includes('pharmacie ouverte') ||
          (texteLower.includes('pharmacie') && texteLower.includes('aujourd'))) {
        
        const reponseIA = await assistantIA.comprendreEtAgir(userId, text, userState);
        await sendWhatsAppMessage(userId, reponseIA);
        await afficherPharmaciesDeGarde(userId);
        return;
      }
      
      // 4. RECHERCHE MÉDICAMENT ("acheter X")
      if (texteLower.startsWith('acheter ') || 
          (texteLower.includes('acheter') && texteLower.length > 8)) {
        
        const reponseIA = await assistantIA.comprendreEtAgir(userId, text, userState);
        await sendWhatsAppMessage(userId, reponseIA);
        
        const medicament = text.toLowerCase().replace('acheter', '').trim();
        if (medicament) {
          const resultats = await rechercherMedicament(userId, medicament);
          if (resultats) {
            userState.derniersResultats = resultats;
            userState.rechercheEnCours = true;
            userStates.set(userId, userState);
          }
        }
        return;
      }
      
      // 5. AJOUTER AU PANIER ("ajouter X Y")
      const ajouterMatch = texteLower.match(/ajouter\s+(\d+)(?:\s+(\d+))?/);
      if (ajouterMatch && userState.derniersResultats) {
        const reponseIA = await assistantIA.comprendreEtAgir(userId, text, userState);
        await sendWhatsAppMessage(userId, reponseIA);
        
        const numero = ajouterMatch[1];
        const quantite = ajouterMatch[2] ? parseInt(ajouterMatch[2]) : 1;
        await ajouterAuPanier(userId, userState.derniersResultats, numero, quantite, userState);
        return;
      }
      
      // 6. FINALISER COMMANDE
      if (texteLower === 'terminer' || texteLower === 'fini' || texteLower.includes('finaliser')) {
        const reponseIA = await assistantIA.comprendreEtAgir(userId, text, userState);
        await sendWhatsAppMessage(userId, reponseIA);
        await finaliserCommande(userId, userState);
        return;
      }
      
      // 7. VOIR PANIER
      if (texteLower === 'panier' || texteLower.includes('voir panier')) {
        const reponseIA = await assistantIA.comprendreEtAgir(userId, text, userState);
        await sendWhatsAppMessage(userId, reponseIA);
        await afficherPanier(userId, userState);
        return;
      }
      
      // 8. VIDER PANIER
      if (texteLower === 'vider' || texteLower.includes('vider panier')) {
        const reponseIA = await assistantIA.comprendreEtAgir(userId, text, userState);
        await sendWhatsAppMessage(userId, reponseIA);
        await viderPanier(userId, userState);
        return;
      }
      
      // 9. HISTORIQUE DES COMMANDES
      if (texteLower.includes('ma commande') || 
          texteLower.includes('mes commandes') || 
          texteLower.includes('historique') ||
          texteLower.includes('dernière commande')) {
        
        const reponseIA = await assistantIA.comprendreEtAgir(userId, text, userState);
        await sendWhatsAppMessage(userId, reponseIA);
        await afficherHistoriqueCommandes(userId);
        return;
      }
      
      // 10. CONTINUER (après ajout au panier)
      if (texteLower === 'continuer' || texteLower === 'oui' || texteLower === 'encore') {
        const reponseIA = await assistantIA.comprendreEtAgir(userId, text, userState);
        await sendWhatsAppMessage(userId, reponseIA);
        await sendWhatsAppMessage(userId, "Dites-moi le nom du prochain médicament.");
        return;
      }
      
      // =================== RÉPONSE IA GÉNÉRALE ===================
      // Pour tous les autres messages, utiliser l'IA
      const reponseIA = await assistantIA.comprendreEtAgir(userId, text, userState);
      await sendWhatsAppMessage(userId, reponseIA);
      
    } catch (error) {
      Logger.error('Erreur webhook:', error.message);
    }
  });
});

// =================== ENDPOINTS ADMIN ===================
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Pillbox WhatsApp Bot IA - Production',
    version: '3.1.0',
    users_actifs: userStates.size,
    timestamp: new Date().toISOString(),
    zone: CONFIG.ZONE_SERVICE,
    support: CONFIG.SUPPORT_PHONE,
    model_ia: CONFIG.GROQ_MODEL,
    createurs: 'Yousself & Delphin - Université Polytechnique de San Pedro'
  });
});

app.get('/api/stats', (req, res) => {
  const stats = {
    users_actifs: userStates.size,
    conversations_actives: Array.from(assistantIA.historiques.keys()).length,
    timestamp: new Date().toISOString(),
    paniers_actifs: Array.from(userStates.values()).filter(s => s.panier && s.panier.length > 0).length,
    commandes_en_cours: Array.from(userStates.values()).filter(s => s.enCoursCommande).length
  };
  res.json(stats);
});

// =================== DÉMARRAGE SERVEUR ===================
app.listen(PORT, HOST, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║  🚀 PILLBOX WHATSAPP BOT IA - PRODUCTION V3.1.0         ║
║  🔥 MIATRONAL-8x7b-32768 - IA À 100%                    ║
╚═══════════════════════════════════════════════════════════╝

✅ **FONCTIONNALITÉS ACTIVES:**

🧠 **INTELLIGENCE MÉDICALE COMPLÈTE**
   • Comprend les symptômes et suggère des médicaments
   • Corrige TOUTES les fautes d'orthographe automatiquement
   • Gestion intelligente du contexte conversationnel

💊 **GESTION DES ORDONNANCES**
   • Détection automatique des médicaments nécessitant ordonnance
   • Message EXPLICITE: "Envoyez photo au ${CONFIG.SUPPORT_PHONE}"
   • Blocage des commandes sans ordonnance valide

🛒 **FLUX DE COMMANDE OPTIMISÉ**
   • Pas de doublons de messages
   • Processus clair: recherche → panier → finalisation
   • Confirmation avec numéro de commande et code sécurité

🏥 **DONNÉES RÉELLES**
   • Médicaments en stock avec prix actualisés
   • Pharmacies de garde vérifiées
   • Cliniques disponibles avec spécialités

📞 **SUPPORT INTÉGRÉ**
   • Support client: ${CONFIG.SUPPORT_PHONE}
   • Zone: ${CONFIG.ZONE_SERVICE}
   • Livraison: ${CONFIG.LIVRAISON_JOUR}F (jour) / ${CONFIG.LIVRAISON_NUIT}F (nuit)

🔧 **TECHNOLOGIE**
   • Modèle IA: ${CONFIG.GROQ_MODEL}
   • Base: Firebase Firestore
   • API: WhatsApp Business
   • Hébergement: Production-ready

👥 **CRÉATEURS**
   • Yousself & Delphin
   • Université Polytechnique de San Pedro
   • Côte d'Ivoire

🌐 **SERVEUR**
   • Port: ${PORT}
   • Host: ${HOST}
   • Démarrage: ${new Date().toLocaleString('fr-FR')}

╔═══════════════════════════════════════════════════════════╗
║  ✅ SYSTÈME PRÊT POUR LA PRODUCTION EN TEMPS RÉEL       ║
║  🤖 L'ASSISTANT MÉDICAL IA EST OPÉRATIONNEL !           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

// =================== NETTOYAGE PÉRIODIQUE ===================
setInterval(() => {
  const maintenant = Date.now();
  const deuxHeures = 2 * 60 * 60 * 1000;
  
  for (const [userId, state] of userStates.entries()) {
    if (maintenant - state.derniereInteraction > deuxHeures) {
      Logger.info(`Nettoyage session inactive: ${userId}`);
      userStates.delete(userId);
      assistantIA.nettoyerHistorique(userId);
    }
  }
}, 30 * 60 * 1000); // Toutes les 30 minutes

// Gestion des erreurs globales
process.on('uncaughtException', (error) => {
  Logger.error('ERREUR NON GÉRÉE:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
  Logger.error('REJET DE PROMESSE NON GÉRÉ:', reason);
});