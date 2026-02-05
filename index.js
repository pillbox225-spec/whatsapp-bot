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
` : '';

      const prompt = `# ASSISTANT MÉDICAL MIA

## TON RÔLE:
Tu es Mia, assistante médicale IA pour Pillbox à ${CONFIG.ZONE_SERVICE}. Tu aides les utilisateurs avec:
1. Recherche de médicaments
2. Pharmacies de garde
3. Prise de rendez-vous médicaux
4. Commandes en ligne

## DONNÉES RÉELLES:

### ${medicaments}

### ${pharmacies}

### ${cliniques}

## HISTORIQUE:
${historiqueFormatte || "Première conversation"}

${etatUtilisateur}

## MESSAGE UTILISATEUR:
"${message}"

## INSTRUCTIONS CRITIQUES:

### 1. CORRECTION AUTOMATIQUE:
- Corrige TOUTES les fautes: "aujourdhui" → "aujourd'hui", "jaimerais" → "j'aimerais"
- Corrige les noms de médicaments: "metridonazole" → "metronidazole"

### 2. GESTION ORDONNANCES:
- Si médicament nécessite ordonnance: "📄 ORDONNANCE REQUISE - Envoyez une photo au ${CONFIG.SUPPORT_PHONE}"
- Ne permettez pas la commande sans mentionner cela

### 3. FLUX DE COMMANDE:
Si l'utilisateur confirme une commande ("oui"), tu DOIS:
1. Confirmer la création de commande
2. Donner un numéro de commande
3. Dire que la pharmacie et le livreur seront notifiés
4. NE PAS demander un autre médicament

### 4. COMPRÉHENSION CONTEXTE:
- "ses tout ce que je voulais" = la commande est terminée
- "jaimerais vois ma commande" = veut voir sa commande récente
- "merci" = fin de conversation, répondre poliment

### 5. FORMAT DES RÉPONSES:
- Sois naturel et conversationnel
- Utilise des émojis appropriés
- Donne des informations précises
- Termine par une question ou une prochaine étape

## EXEMPLES:

**Utilisateur:** "quelle pharmacie de garde aujourdhui"
**Toi:** "Je vérifie les pharmacies de garde à ${CONFIG.ZONE_SERVICE}..."
[Ensuite, code enverra la vraie liste]

**Utilisateur:** "acheter metronidazole"
**Toi:** "Je recherche metronidazole..."
[Ensuite, code cherchera et affichera les résultats]

**Utilisateur:** "oui" (après confirmation commande)
**Toi:** "✅ Commande confirmée ! Votre commande #CMD123 a été créée. La pharmacie et le livreur ont été notifiés. Vous recevrez un appel pour la livraison. 📞 Support: ${CONFIG.SUPPORT_PHONE}"

**Utilisateur:** "ses tout ce que je voulais"
**Toi:** "Parfait ! Votre commande est complète. Dites 'terminer' pour finaliser ou ajoutez d'autres médicaments."

**Utilisateur:** "jaimerais vois ma commande"
**Toi:** "Je cherche votre dernière commande..."
[Ensuite, code affichera l'historique]

**Utilisateur:** "merci"
**Toi:** "Avec plaisir ! 😊 N'hésitez pas si vous avez besoin d'autre chose."

## MAINTENANT, RÉPONDS À:
"${message}"

Rappel important: Corrige les fautes, sois naturel, et gère correctement le contexte.`;

      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: CONFIG.GROQ_MODEL,
          messages: [
            {
              role: "system",
              content: "Tu es Mia, assistante médicale IA. Tu corriges automatiquement toutes les fautes. Tu es précise, empathique et utile. Tu travailles à San Pedro, Côte d'Ivoire."
            },
            { role: "user", content: prompt }
          ],
          temperature: 0.3,
          max_tokens: 800
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
      return "Je rencontre un problème technique. Contactez le support au " + CONFIG.SUPPORT_PHONE;
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
  derniereInteraction: Date.now()
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
      await sendWhatsAppMessage(userId, "Aucune pharmacie de garde trouvée.");
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
    
    message += `💊 Commander: "acheter [médicament]"`;
    
    await sendWhatsAppMessage(userId, message);
    
  } catch (error) {
    await sendWhatsAppMessage(userId, "Problème pour récupérer les pharmacies.");
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
      await sendWhatsAppMessage(userId, `Aucun résultat pour "${terme}".`);
      return null;
    }
    
    // Afficher résultats
    let message = `💊 RÉSULTATS POUR "${terme.toUpperCase()}"\n\n`;
    
    medicaments.slice(0, 5).forEach((med, index) => {
      message += `${index + 1}. ${med.nom}`;
      if (med.sousTitre) message += ` (${med.sousTitre})`;
      message += `\n   ${med.prix || '?'} FCFA | ${med.pharmacieNom}\n`;
      if (med.dosage || med.forme) message += `   ${med.dosage || ''} ${med.forme || ''}\n`;
      message += `   ${med.necessiteOrdonnance ? '📄 Ordonnance requise' : '✅ Sans ordonnance'}\n\n`;
    });
    
    message += `🛒 Commander: "ajouter [numéro] [quantité]"`;
    
    await sendWhatsAppMessage(userId, message);
    
    return medicaments;
    
  } catch (error) {
    await sendWhatsAppMessage(userId, "Problème lors de la recherche.");
    return null;
  }
}

async function ajouterAuPanier(userId, medicaments, numero, quantite, userState) {
  if (!userState.panier) userState.panier = [];
  
  const index = parseInt(numero) - 1;
  if (index < 0 || index >= medicaments.length) {
    await sendWhatsAppMessage(userId, "Numéro invalide.");
    return false;
  }
  
  const med = medicaments[index];
  
  // Vérifier ordonnance
  if (med.necessiteOrdonnance) {
    await sendWhatsAppMessage(
      userId,
      `📄 ORDONNANCE REQUISE\n\n` +
      `"${med.nom}" nécessite une ordonnance.\n\n` +
      `Pour commander, envoyez une photo de votre ordonnance au support:\n` +
      `${CONFIG.SUPPORT_PHONE}`
    );
    return false;
  }
  
  // Vérifier stock
  if (med.stock < quantite) {
    await sendWhatsAppMessage(userId, `Stock insuffisant. Disponible: ${med.stock}`);
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
  
  let message = `✅ Ajouté: ${med.nom} × ${quantite}\n\n`;
  message += `🛒 Panier (${userState.panier.length} article(s)): ${totalPanier} FCFA\n`;
  message += `🚚 Livraison: ${fraisLivraison} FCFA\n`;
  message += `💵 Total estimé: ${total} FCFA\n\n`;
  message += `Continuer? Dites "terminer" pour finaliser ou ajoutez d'autres médicaments.`;
  
  await sendWhatsAppMessage(userId, message);
  return true;
}

async function finaliserCommande(userId, userState) {
  const panier = userState.panier || [];
  
  if (panier.length === 0) {
    await sendWhatsAppMessage(userId, "Votre panier est vide.");
    return;
  }
  
  const totalPanier = panier.reduce((sum, item) => sum + (item.prix * item.quantite), 0);
  const fraisLivraison = getFraisLivraison();
  const total = totalPanier + fraisLivraison;
  
  let message = `✅ PANIER FINALISÉ\n\n`;
  
  panier.forEach((item, index) => {
    message += `${index + 1}. ${item.nom}`;
    if (item.sousTitre) message += ` (${item.sousTitre})`;
    message += ` × ${item.quantite}\n`;
    message += `   ${item.prix} FCFA × ${item.quantite} = ${item.prix * item.quantite} FCFA\n\n`;
  });
  
  message += `🏥 Pharmacie: ${panier[0].pharmacieNom}\n`;
  message += `🚚 Livraison: ${fraisLivraison} FCFA\n`;
  message += `💵 TOTAL: ${total} FCFA\n\n`;
  message += `Pour finaliser, envoyez:\n\n`;
  message += `1. Votre nom complet\n`;
  message += `2. Votre quartier\n`;
  message += `3. Votre numéro WhatsApp\n`;
  message += `4. Indications pour la livraison\n\n`;
  message += `Commencez par votre nom:`;
  
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
    await sendWhatsAppMessage(userId, "Quel est votre quartier ?");
    return;
  }
  
  if (userState.attenteQuartier) {
    userState.commandeInfo.quartier = message;
    userState.attenteQuartier = false;
    userState.attenteWhatsApp = true;
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "Quel est votre numéro WhatsApp ?");
    return;
  }
  
  if (userState.attenteWhatsApp) {
    userState.commandeInfo.whatsapp = message;
    userState.attenteWhatsApp = false;
    userState.attenteIndications = true;
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "Indications pour la livraison ?\n(ex: maison bleue, sonnez 2 fois)");
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
  
  let message = `✅ CONFIRMATION DE COMMANDE\n\n`;
  message += `👤 Nom: ${cmd.nom}\n`;
  message += `📍 Quartier: ${cmd.quartier}\n`;
  message += `📞 WhatsApp: ${cmd.whatsapp}\n`;
  message += `📝 Indications: ${cmd.indications || 'Aucune'}\n\n`;
  message += `📦 VOTRE COMMANDE:\n\n`;
  
  cmd.panier.forEach((item, index) => {
    message += `${index + 1}. ${item.nom}`;
    if (item.sousTitre) message += ` (${item.sousTitre})`;
    message += ` × ${item.quantite}\n`;
    message += `   ${item.prix} FCFA × ${item.quantite} = ${item.prix * item.quantite} FCFA\n\n`;
  });
  
  message += `🏥 Pharmacie: ${cmd.panier[0].pharmacieNom}\n`;
  message += `🚚 Livraison: ${cmd.fraisLivraison} FCFA\n`;
  message += `💵 TOTAL: ${cmd.total} FCFA\n\n`;
  message += `Confirmez-vous cette commande ?\n`;
  message += `"oui" pour confirmer\n`;
  message += `"non" pour annuler`;
  
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
    
    await commandeRef.set({
      clientId: userId,
      clientNom: cmd.nom,
      date_commande: admin.firestore.Timestamp.now(),
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
        statut_livraison: 'en_attente'
      },
      pharmacieId: cmd.panier[0].id,
      pharmacienom: cmd.panier[0].pharmacieNom,
      code_securite: Math.floor(100000 + Math.random() * 900000).toString()
    });
    
    // Message de confirmation
    await sendWhatsAppMessage(
      userId,
      `✅ COMMANDE #${commandeId} CONFIRMÉE !\n\n` +
      `Votre commande a été créée avec succès.\n\n` +
      `📦 **Détails:**\n` +
      `• ${cmd.panier.length} médicament(s)\n` +
      `• Total: ${cmd.total} FCFA\n` +
      `• Livraison à: ${cmd.quartier}\n\n` +
      `🔔 **Prochaines étapes:**\n` +
      `1. La pharmacie prépare votre commande\n` +
      `2. Un livreur vous contactera pour la livraison\n` +
      `3. Paiement à la livraison\n\n` +
      `📞 **Support:** ${CONFIG.SUPPORT_PHONE}\n` +
      `_Merci pour votre confiance !_`
    );
    
    // Réinitialiser l'état utilisateur
    userState.panier = [];
    userState.enCoursCommande = false;
    userState.commandeInfo = null;
    userState.attenteConfirmation = false;
    userStates.set(userId, userState);
    
    // Nettoyer l'historique IA
    assistantIA.nettoyerHistorique(userId);
    
  } catch (error) {
    console.error('Erreur création commande:', error.message);
    await sendWhatsAppMessage(userId, "Erreur lors de la création de la commande. Contactez le support.");
  }
}

async function afficherHistoriqueCommandes(userId) {
  try {
    const snapshot = await db.collection('commandes_medicales')
      .where('clientId', '==', userId)
      .orderBy('date_commande', 'desc')
      .limit(3)
      .get();
    
    if (snapshot.empty) {
      await sendWhatsAppMessage(userId, "Vous n'avez pas encore passé de commande.");
      return;
    }
    
    let message = `📋 VOS DERNIÈRES COMMANDES\n\n`;
    
    snapshot.docs.forEach((doc, index) => {
      const cmd = doc.data();
      message += `${index + 1}. Commande #${doc.id.substring(0, 8)}\n`;
      message += `   📅 ${new Date(cmd.date_commande.seconds * 1000).toLocaleDateString('fr-FR')}\n`;
      message += `   💰 ${cmd.paiement.montant_total || 0} FCFA\n`;
      message += `   📍 ${cmd.livraison.adresse || 'Non spécifié'}\n`;
      message += `   📦 ${cmd.statut || 'En attente'}\n\n`;
    });
    
    await sendWhatsAppMessage(userId, message);
    
  } catch (error) {
    await sendWhatsAppMessage(userId, "Problème pour récupérer vos commandes.");
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
      
      // Gestion des états spéciaux
      if (userState.attenteConfirmation) {
        if (text.toLowerCase() === 'oui') {
          await creerCommandeFirestore(userId, userState);
          return;
        } else if (text.toLowerCase() === 'non') {
          userState.enCoursCommande = false;
          userState.commandeInfo = null;
          userState.attenteConfirmation = false;
          userStates.set(userId, userState);
          await sendWhatsAppMessage(userId, "Commande annulée. Que souhaitez-vous faire ?");
          return;
        }
      }
      
      if (userState.attenteNom || userState.attenteQuartier || 
          userState.attenteWhatsApp || userState.attenteIndications) {
        await collecterInfosCommande(userId, text, userState);
        return;
      }
      
      // Analyser le message avec l'IA
      const reponseIA = await assistantIA.comprendreEtAgir(userId, text, userState);
      
      // Actions spéciales basées sur la réponse IA
      const texteLower = text.toLowerCase();
      
      // 1. Pharmacies de garde
      if (reponseIA.includes('pharmacie de garde') || texteLower.includes('pharmacie de garde')) {
        await afficherPharmaciesDeGarde(userId);
        return;
      }
      
      // 2. Recherche médicament
      if (reponseIA.includes('recherche') && texteLower.includes('acheter')) {
        const medicament = texteLower.replace('acheter', '').trim();
        if (medicament) {
          const resultats = await rechercherMedicament(userId, medicament);
          if (resultats) {
            // Sauvegarder les résultats pour commande
            userState.derniersResultats = resultats;
            userStates.set(userId, userState);
          }
        }
        return;
      }
      
      // 3. Ajouter au panier
      const ajouterMatch = texteLower.match(/ajouter\s+(\d+)(?:\s+(\d+))?/);
      if (ajouterMatch && userState.derniersResultats) {
        const numero = ajouterMatch[1];
        const quantite = ajouterMatch[2] ? parseInt(ajouterMatch[2]) : 1;
        await ajouterAuPanier(userId, userState.derniersResultats, numero, quantite, userState);
        return;
      }
      
      // 4. Finaliser commande
      if (texteLower === 'terminer' || texteLower === 'fini' || texteLower.includes('finaliser')) {
        await finaliserCommande(userId, userState);
        return;
      }
      
      // 5. Voir historique commandes
      if (texteLower.includes('ma commande') || texteLower.includes('mes commandes') || 
          texteLower.includes('historique')) {
        await afficherHistoriqueCommandes(userId);
        return;
      }
      
      // 6. Envoyer la réponse IA
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
    service: 'Pillbox WhatsApp Bot IA Simplifié',
    users: userStates.size,
    timestamp: new Date().toISOString()
  });
});

// =================== DÉMARRAGE ===================
app.listen(PORT, HOST, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║  🚀 PILLBOX WHATSAPP BOT - IA SIMPLIFIÉ     ║
║  ✅ UN SEUL SYSTÈME - PAS DE DOUBLONS       ║
╚══════════════════════════════════════════════╝

📞 Support: ${CONFIG.SUPPORT_PHONE}
🌍 Zone: ${CONFIG.ZONE_SERVICE}
🤖 Modèle: ${CONFIG.GROQ_MODEL}
🔧 Port: ${PORT}

✅ Prêt à recevoir des messages !
  `);
});

// Nettoyage périodique
setInterval(() => {
  const maintenant = Date.now();
  for (const [userId, state] of userStates.entries()) {
    if (maintenant - state.derniereInteraction > 3600000) { // 1 heure
      userStates.delete(userId);
      assistantIA.nettoyerHistorique(userId);
    }
  }
}, 300000); // Toutes les 5 minutes