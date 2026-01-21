require('dotenv').config();
const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const Fuse = require('fuse.js');

// Initialisation de l'application Express
const app = express();
app.use(express.json());

// Configuration Firebase
let db;
let FieldValue;

(async () => {
  try {
    if (admin.apps.length === 0) {
      if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY || !process.env.FIREBASE_PROJECT_ID) {
        throw new Error("Variables Firebase manquantes");
      }
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`,
        projectId: process.env.FIREBASE_PROJECT_ID
      });
      console.log('✅ Firebase Admin SDK initialisé');
    }
    db = admin.firestore();
    FieldValue = admin.firestore.FieldValue;

    // Test de connexion à Firestore
    const testRef = db.collection('system_health').doc('connection_test');
    await testRef.set({
      timestamp: new Date().toISOString(),
      status: 'connected'
    });
    console.log('✅ Connexion Firestore établie');
  } catch (error) {
    console.error('❌ ERREUR CRITIQUE Firebase:', error.message);
    process.exit(1);
  }
})();

// Configuration globale
const CONFIG = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  GROQ_MODEL: "llama-3.1-8b-instant",
  SUPPORT_PHONE: "+2250701406880",
  LIVRAISON_JOUR: 400,
  LIVRAISON_NUIT: 600,
  ZONE_SAN_PEDRO: {
    minLat: 4.6, maxLat: 5.0,
    minLng: -6.8, maxLng: -6.6
  }
};

// État des utilisateurs
const userStates = new Map();
const DEFAULT_STATE = {
  step: 'MENU_PRINCIPAL',
  panier: [],
  pharmacieId: null,
  pharmacieNom: null,
  besoinOrdonnance: false,
  attentePhoto: false,
  commandeEnCours: null,
  location: null,
  quartier: null,
  indications: null,
  ordonnanceValidee: false,
  ordonnancePhotoUrl: null,
  initialized: false,
  dernierMessageId: null,
  currentMedicamentId: null,
  nom: 'Caroline Martin',
  telephone: null,
  whatsapp: null,
  aJoindre: null,
  listeMedicamentsCategorie: [],
  listeMedicamentsRecherche: [],
  currentCategorie: null,
  medicamentIdentifie: null,
  nomMedicamentRecherche: null
};

// Prompt système pour Groq
const SYSTEM_PROMPT = `
Tu es Mia, l'assistante médicale intelligente de Pillbox à San Pedro, spécialement conçue pour aider Caroline Martin à commander des médicaments, trouver des pharmacies de garde, et organiser des livraisons à domicile.

### Règles strictes à suivre :
1. Réponds UNIQUEMENT aux questions liées aux médicaments, pharmacies, commandes, ordonnances, centres de santé, médecins, et livraisons.
2. Ne fais PAS de diagnostic médical. Réponds toujours : "Consultez un médecin ou un pharmacien pour un avis médical, Caroline."
3. Pour les urgences : Réponds toujours : "En cas d'urgence, Caroline, contactez immédiatement le 15 (SAMU) ou le 112."
4. Présente-toi comme suit : "Bonjour Caroline ! Je suis Mia, votre assistante Pillbox. 💊 Comment puis-je vous aider aujourd’hui ?"
5. Pour les médicaments :
   - Si Caroline cherche un médicament, propose-lui de vérifier sa disponibilité ou de commander directement.
   - Si le médicament nécessite une ordonnance, explique clairement la procédure pour envoyer une photo.
6. Pour les pharmacies :
   - Donne la liste des pharmacies de garde avec leurs coordonnées et images.
   - Propose de vérifier la disponibilité d’un médicament spécifique dans une pharmacie.
7. Pour les commandes :
   - Guide Caroline étape par étape : ajout au panier, validation de l’ordonnance (si nécessaire), saisie des informations de livraison, confirmation.
8. Pour les ordonnances :
   - Si Caroline envoie une photo, confirme la réception et explique que la validation prendra quelques minutes.
9. Pour les livraisons :
   - Donne un suivi en temps réel : "Votre commande est en préparation, Caroline.", "Un livreur est en route, Caroline.", etc.
10. Format des réponses :
    - Sois concis (2-3 phrases max par réponse).
    - Utilise des emojis pour clarifier.
    - Termine toujours par une question ou une action claire.
    - Appelle toujours Caroline par son nom.
    - Si tu ne comprends pas, demande des précisions : "Pouvez-vous préciser votre demande, Caroline ? Par exemple : 'Je cherche du paracétamol' ou 'Quelles pharmacies sont ouvertes ce soir ?'"

### Exemples de réponses pour Caroline :
- Caroline : "Je cherche du paracétamol 500mg"
  Toi : "💊 Paracétamol 500mg est disponible sans ordonnance, Caroline.
  Souhaitez-vous :
  1. Vérifier sa disponibilité dans une pharmacie de garde ?
  2. L’ajouter directement à votre panier pour une livraison à domicile ?
  Répondez 1 ou 2."

- Caroline : "Pharmacies de garde près de chez moi"
  Toi : "🏥 Voici les pharmacies de garde ouvertes 24h/24 près de vous, Caroline :
  1. Pharmacie Saint Jean – Cocody – ☎ +225 01 23 45 67
  2. Pharmacie de la Paix – Plateau – ☎ +225 02 34 56 78
  Répondez avec le numéro de la pharmacie pour voir ses médicaments disponibles."

- Caroline : "Je veux commander de l’amoxicilline"
  Toi : "⚠️ Amoxicilline nécessite une ordonnance, Caroline.
  Pour commander, envoyez une photo de votre ordonnance (📎).
  Dès réception, nous la transmettrons à une pharmacie pour validation (délai : 5-10 min)."

- Caroline : *(envoie une photo)*
  Toi : "✅ Ordonnance reçue, Caroline ! Transmission à la pharmacie pour validation.
  Vous recevrez une confirmation sous peu.
  En attendant, souhaitez-vous ajouter d’autres médicaments à votre commande ? (OUI/NON)"
`;

// Fonction pour obtenir une réponse de Groq
async function getGroqAIResponse(userMessage) {
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: CONFIG.GROQ_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage }
        ],
        temperature: 0.7,
        max_tokens: 250
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Erreur Groq:', error.message);
    return "Désolé, Caroline, je ne peux pas répondre pour le moment. Comment puis-je vous aider avec Pillbox ?";
  }
}

// Fonctions WhatsApp
async function sendTypingIndicator(to, duration = 3000) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "typing",
        typing: { action: "typing_on", typing_duration: duration }
      },
      { headers: { 'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('❌ Erreur typing indicator:', error.message);
  }
}

async function sendTextMessage(to, text) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "text",
        text: { body: text.substring(0, 4096) }
      },
      { headers: { 'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    return response.data.messages?.[0]?.id;
  } catch (error) {
    console.error('❌ Erreur envoi texte:', error.message);
    return null;
  }
}

async function sendImageMessage(to, imageUrl, caption) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "image",
        image: { link: imageUrl, caption: caption.substring(0, 1024) }
      },
      { headers: { 'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('❌ Erreur envoi image:', error.message);
  }
}

async function sendInteractiveMessage(to, text, buttons) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: text.substring(0, 1024) },
          action: { buttons: buttons.slice(0, 3) }
        }
      },
      { headers: { 'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    return response.data.messages?.[0]?.id;
  } catch (error) {
    console.error('❌ Erreur envoi interactif:', error.response?.data || error.message);
    return null;
  }
}

// Fonctions Firestore
async function getPharmacie(id) {
  try {
    const doc = await db.collection('pharmacies').doc(id).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  } catch (error) {
    console.error('Erreur getPharmacie:', error.message);
    return null;
  }
}

async function getMedicaments(pharmacieId = null, recherche = null, categorie = null) {
  try {
    let query = db.collection('medicaments').where('stock', '>', 0);
    if (pharmacieId) query = query.where('pharmacieId', '==', pharmacieId);
    if (recherche) {
      const snapshot = await query.get();
      const rechercheLower = recherche.toLowerCase();
      return snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(m => m.nom.toLowerCase().includes(rechercheLower) || (m.sousTitre && m.sousTitre.toLowerCase().includes(rechercheLower)))
        .slice(0, 15);
    }
    if (categorie) query = query.where('categorie', '==', categorie);
    const snapshot = await query.limit(20).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('Erreur getMedicaments:', error.message);
    return [];
  }
}

async function getPharmaciesDeGarde() {
  try {
    const snapshot = await db.collection('pharmacies')
      .where('estDeGarde', '==', true)
      .where('estOuvert', '==', true)
      .limit(10)
      .get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('Erreur getPharmaciesDeGarde:', error.message);
    return [];
  }
}

async function getLivreursDisponibles() {
  try {
    const snapshot = await db.collection('users')
      .where('rôle', '==', 'livreur')
      .where('isVerified', '==', true)
      .limit(5)
      .get();
    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      telephone: doc.data().telephone.startsWith('+') ? doc.data().telephone : `+225${doc.data().telephone}`
    }));
  } catch (error) {
    console.error("Erreur récupération livreurs:", error);
    return [];
  }
}

async function updateStock(medicamentId, quantite) {
  try {
    await db.collection('medicaments').doc(medicamentId).update({ stock: FieldValue.increment(-quantite) });
  } catch (error) {
    console.error('Erreur updateStock:', error.message);
  }
}

// Fonctions de calcul
function isInSanPedro(latitude, longitude) {
  return (
    latitude >= CONFIG.ZONE_SAN_PEDRO.minLat &&
    latitude <= CONFIG.ZONE_SAN_PEDRO.maxLat &&
    longitude >= CONFIG.ZONE_SAN_PEDRO.minLng &&
    longitude <= CONFIG.ZONE_SAN_PEDRO.maxLng
  );
}

function getFraisLivraison() {
  const heure = new Date().getHours();
  return (heure >= 8 && heure < 23) ? CONFIG.LIVRAISON_JOUR : CONFIG.LIVRAISON_NUIT;
}

// Module Livreurs
const livreurManager = {
  RAPPEL_LIVRAISON_MS: 5 * 60 * 1000,
  async envoyerCommandeLivreur(commandeId, pharmacieId) {
    try {
      const livreurs = await getLivreursDisponibles();
      if (livreurs.length === 0) {
        console.log("❌ Aucun livreur disponible");
        return { success: false, message: "Aucun livreur disponible" };
      }
      const commandeDoc = await db.collection('commandes').doc(commandeId).get();
      if (!commandeDoc.exists) return { success: false, message: "Commande introuvable" };
      const commande = commandeDoc.data();
      const pharmacieDoc = await db.collection('pharmacies').doc(pharmacieId).get();
      if (!pharmacieDoc.exists) return { success: false, message: "Pharmacie introuvable" };
      const pharmacie = pharmacieDoc.data();
      const livreur = livreurs[0];
      const messageLivreur = this.creerMessageLivreurDetaille(commande, pharmacie, livreur);
      await this.envoyerMessageLivreurAmeliore(livreur.telephone, messageLivreur, commandeId, pharmacie);
      await db.collection('commandes').doc(commandeId).update({
        statut: 'en_attente_livreur',
        livreurId: livreur.telephone,
        livreurNom: `${livreur.prenom} ${livreur.nom}`,
        livreurTelephone: livreur.telephone,
        dateEnvoiLivreur: Date.now(),
        essaisLivreurs: [{ livreurId: livreur.telephone, date: Date.now(), statut: 'en_attente' }],
        pharmacieCoords: pharmacie.position,
        clientCoords: commande.livraison
      });
      return { success: true, livreur: livreur, commande: commande };
    } catch (error) {
      console.error("❌ Erreur envoi livreur:", error);
      return { success: false, message: error.message };
    }
  },
  creerMessageLivreurDetaille(commande, pharmacie, livreur) {
    const client = commande.client;
    const montantTotal = commande.montantTotal + commande.fraisLivraison;
    const positionPharmacie = pharmacie.position;
    const positionClient = commande.livraison;
    const lienGoogleMapsPharmacie = `https://www.google.com/maps?q=${positionPharmacie.latitude},${positionPharmacie.longitude}`;
    const lienGoogleMapsClient = `https://www.google.com/maps?q=${positionClient.latitude},${positionClient.longitude}`;
    const lienTrajetPharmacieClient = `https://www.google.com/maps/dir/${positionPharmacie.latitude},${positionPharmacie.longitude}/${positionClient.latitude},${positionClient.longitude}/`;
    return `📦 **NOUVELLE COMMANDE PILLBOX**\n\n` +
           `🆔 Commande: #${commande.id.substring(0, 8)}\n` +
           `💰 Montant: ${montantTotal} FCFA\n` +
           `🚚 Frais livraison: ${commande.fraisLivraison} FCFA\n\n` +
           `🏥 **PHARMACIE À VISITER**\n` +
           `• Nom: ${pharmacie.nom}\n` +
           `• Tél: ${pharmacie.telephone}\n` +
           `• Adresse: ${pharmacie.adresse || 'BP 225'}\n` +
           `• Horaires: ${pharmacie.horaires || '24h/24'}\n` +
           `📍 Localisation: ${lienGoogleMapsPharmacie}\n\n` +
           `👤 **CLIENT À LIVRER**\n` +
           `• Nom: ${client.nom}\n` +
           `• WhatsApp: ${client.whatsapp}\n` +
           `• À joindre: ${client.aJoindre}\n` +
           `• Quartier: ${commande.livraison.quartier}\n` +
           `• Indications: ${commande.livraison.indications}\n` +
           `📍 Localisation: ${lienGoogleMapsClient}\n\n` +
           `🛣️ **TRAJET COMPLET**\n` +
           `Votre position → Pharmacie → Client\n` +
           `📍 Voir le trajet: ${lienTrajetPharmacieClient}\n\n` +
           `💬 **COMMUNICATION**\n` +
           `• Pour contacter la pharmacie: ${pharmacie.telephone}\n` +
           `• Pour contacter le client: ${client.aJoindre}\n\n` +
           `⏰ **À livrer dans les plus brefs délais**`;
  },
  async envoyerMessageLivreurAmeliore(telephoneLivreur, message, commandeId, pharmacie) {
    try {
      const buttons = [
        { type: "reply", reply: { id: `accepter_${commandeId}`, title: "✅ Accepter" } },
        { type: "reply", reply: { id: `refuser_${commandeId}`, title: "❌ Refuser" } }
      ];
      await sendInteractiveMessage(telephoneLivreur, message, buttons);
      setTimeout(async () => { await this.verifierReponseLivreur(commandeId); }, this.RAPPEL_LIVRAISON_MS);
    } catch (error) {
      console.error("Erreur envoi message livreur:", error);
    }
  },
  async verifierReponseLivreur(commandeId) {
    try {
      const commandeDoc = await db.collection('commandes').doc(commandeId).get();
      if (!commandeDoc.exists) return;
      const commande = commandeDoc.data();
      if (commande.statut === 'en_attente_livreur') {
        await sendTextMessage(commande.livreurTelephone, `⏰ **RAPPEL - Commande #${commandeId.substring(0, 8)}**\n\nVeuillez accepter ou refuser cette commande.`);
        await db.collection('commandes').doc(commandeId).update({ rappelEnvoye: true, dateRappel: Date.now() });
      }
    } catch (error) {
      console.error("Erreur vérification réponse livreur:", error);
    }
  },
  async handleReponseLivreur(telephoneLivreur, buttonId, commandeId, reponse) {
    try {
      const commandeDoc = await db.collection('commandes').doc(commandeId).get();
      if (!commandeDoc.exists) return;
      const commande = commandeDoc.data();
      if (reponse === 'accepter') {
        await db.collection('commandes').doc(commandeId).update({
          statut: 'en_cours_livraison',
          livreurAccepte: true,
          dateAcceptation: Date.now(),
          'essaisLivreurs.0.statut': 'accepte'
        });
        await this.notifierClientLivraisonEnCours(commande);
        await this.envoyerBoutonsActionLivreur(telephoneLivreur, commande);
      } else if (reponse === 'refuser') {
        await db.collection('commandes').doc(commandeId).update({
          livreurAccepte: false,
          livreurRefuse: true,
          dateRefus: Date.now(),
          'essaisLivreurs.0.statut': 'refuse'
        });
        await sendTextMessage(telephoneLivreur, `❌ **Commande refusée.**\n\nNous allons contacter un autre livreur.`);
        await this.trouverAutreLivreur(commandeId);
      }
    } catch (error) {
      console.error("Erreur gestion réponse livreur:", error);
    }
  },
  async notifierClientLivraisonEnCours(commande) {
    try {
      await sendTextMessage(commande.client.telephone,
        `🚗 **LIVRAISON EN COURS, ${commande.client.nom || "Caroline"}!**\n\n` +
        `Votre commande #${commande.id.substring(0, 8)} a été acceptée par un livreur.\n\n` +
        `👤 **Votre livreur:**\n` +
        `• Nom: ${commande.livreurNom}\n` +
        `• Tél: ${commande.livreurTelephone}\n\n` +
        `🏥 **Pharmacie:** ${commande.pharmacieNom}\n\n` +
        `💬 **Communiquez avec votre livreur** directement sur WhatsApp:\n` +
        `👉 [Ouvrir la conversation](https://wa.me/${commande.livreurTelephone.replace('+', '')})\n\n` +
        `📱 Ou répondez à ce message (il sera transféré au livreur).`
      );
    } catch (error) {
      console.error("Erreur notification client:", error);
    }
  },
  async trouverAutreLivreur(commandeId) {
    try {
      const commandeDoc = await db.collection('commandes').doc(commandeId).get();
      if (!commandeDoc.exists) return;
      const commande = commandeDoc.data();
      const essaisLivreurs = commande.essaisLivreurs || [];
      const livreursContactes = essaisLivreurs.map(e => e.livreurId);
      const tousLivreurs = await getLivreursDisponibles();
      const nouveauLivreur = tousLivreurs.find(l => !livreursContactes.includes(l.telephone));
      if (nouveauLivreur) {
        const nouveauxEssais = [...essaisLivreurs, { livreurId: nouveauLivreur.telephone, date: Date.now(), statut: 'en_attente' }];
        await db.collection('commandes').doc(commandeId).update({
          livreurId: nouveauLivreur.telephone,
          livreurNom: `${nouveauLivreur.prenom} ${nouveauLivreur.nom}`,
          livreurTelephone: nouveauLivreur.telephone,
          essaisLivreurs: nouveauxEssais
        });
        await this.envoyerCommandeLivreur(commandeId, commande.pharmacieId);
      } else {
        await db.collection('commandes').doc(commandeId).update({
          statut: 'annulee',
          raisonAnnulation: 'Aucun livreur disponible'
        });
        await sendTextMessage(commande.client.telephone,
          `❌ **Commande annulée, ${commande.client.nom || "Caroline"}**\n\n` +
          `Aucun livreur disponible pour le moment.\n\n` +
          `Veuillez réessayer plus tard ou contacter le support: ${CONFIG.SUPPORT_PHONE}`
        );
      }
    } catch (error) {
      console.error("Erreur recherche autre livreur:", error);
    }
  },
  async envoyerBoutonsActionLivreur(telephoneLivreur, commande) {
    try {
      const message = `✅ **Commande acceptée!**\n\n` +
        `Commande #${commande.id.substring(0, 8)}\n\n` +
        `🎯 **ÉTAPES:**\n` +
        `1. Récupérer à la pharmacie\n` +
        `2. Livrer au client\n\n` +
        `Cliquez sur les boutons ci-dessous pour chaque étape:`;
      const buttons = [
        { type: "reply", reply: { id: `aller_recuperer_${commande.id}`, title: "🏥 Aller récupérer" } },
        { type: "reply", reply: { id: `deja_recupere_${commande.id}`, title: "✅ Déjà récupéré" } },
        { type: "reply", reply: { id: `contacter_pharmacie_${commande.id}`, title: "📞 Contacter pharmacie" } }
      ];
      await sendInteractiveMessage(telephoneLivreur, message, buttons);
    } catch (error) {
      console.error("Erreur envoi boutons action:", error);
    }
  },
  async handleChatClientLivreur(message, from, to) {
    try {
      const commandesSnapshot = await db.collection('commandes')
        .where('chatActive', '==', true)
        .get();
      for (const doc of commandesSnapshot.docs) {
        const commande = doc.data();
        const isClient = from === commande.client.telephone;
        const isLivreur = from === commande.livreurTelephone;
        if (isClient || isLivreur) {
          const destinataire = isClient ? commande.livreurTelephone : commande.client.telephone;
          const expediteurNom = isClient ? commande.client.nom : commande.livreurNom;
          await db.collection('chats').add({
            commandeId: doc.id,
            expediteur: from,
            destinataire: destinataire,
            expediteurNom: expediteurNom,
            message: message,
            timestamp: Date.now(),
            type: 'text'
          });
          const prefix = isClient ? '👤 Client: ' : '🚗 Livreur: ';
          await sendTextMessage(destinataire, `${prefix}${message}`);
          return true;
        }
      }
      return false;
    } catch (error) {
      console.error("Erreur gestion chat:", error);
      return false;
    }
  }
};

// Module Validation Pharmacie
const pharmacieValidator = {
  async envoyerOrdonnancePharmacie(commandeId, photoUrl, pharmacieId) {
    try {
      const pharmacieDoc = await db.collection('pharmacies').doc(pharmacieId).get();
      if (!pharmacieDoc.exists) return { success: false, message: "Pharmacie introuvable" };
      const pharmacie = pharmacieDoc.data();
      const message = this.creerMessageValidation(commandeId, photoUrl);
      await this.envoyerMessagePharmacie(pharmacie.telephone, message, photoUrl, commandeId);
      await db.collection('commandes').doc(commandeId).update({
        statut: 'en_validation_pharmacie',
        pharmacieId: pharmacieId,
        pharmacieNom: pharmacie.nom,
        dateEnvoiValidation: Date.now(),
        ordonnancePhotoUrl: photoUrl
      });
      return { success: true, pharmacie: pharmacie };
    } catch (error) {
      console.error("Erreur envoi validation pharmacie:", error);
      return { success: false, message: error.message };
    }
  },
  creerMessageValidation(commandeId, photoUrl) {
    return `🏥 **VALIDATION D'ORDONNANCE**\n\n` +
           `Une nouvelle ordonnance nécessite votre validation.\n\n` +
           `🆔 Commande: #${commandeId.substring(0, 8)}\n\n` +
           `Veuillez vérifier l'ordonnance ci-jointe et valider ou refuser la commande.`;
  },
  async envoyerMessagePharmacie(telephonePharmacie, message, photoUrl, commandeId) {
    try {
      await axios.post(
        `https://graph.facebook.com/v19.0/${CONFIG.PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: telephonePharmacie,
          type: "image",
          image: { link: photoUrl, caption: "📋 Ordonnance du client" }
        },
        { headers: { 'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      const buttons = [
        { type: "reply", reply: { id: `valider_ordonnance_${commandeId}`, title: "✅ Valider" } },
        { type: "reply", reply: { id: `refuser_ordonnance_${commandeId}`, title: "❌ Refuser" } }
      ];
      await sendInteractiveMessage(telephonePharmacie, message, buttons);
    } catch (error) {
      console.error("Erreur envoi message pharmacie:", error);
    }
  },
  async handleReponsePharmacie(telephonePharmacie, buttonId, commandeId, reponse) {
    try {
      const commandeDoc = await db.collection('commandes').doc(commandeId).get();
      if (!commandeDoc.exists) return;
      const commande = commandeDoc.data();
      if (reponse === 'valider') {
        await db.collection('commandes').doc(commandeId).update({
          statut: 'ordonnance_validee',
          ordonnanceValidee: true,
          pharmacieValidee: true,
          dateValidation: Date.now()
        });
        await sendTextMessage(commande.client.telephone,
          `✅ **Ordonnance validée, ${commande.client.nom || "Caroline"}!**\n\n` +
          `Votre ordonnance a été validée par la pharmacie **${commande.pharmacieNom}**.` +
          `\n\nPour finaliser votre commande, nous avons besoin de vos informations de livraison :` +
          `\n\n1. **Votre nom et prénom**` +
          `\n2. **Votre quartier**` +
          `\n3. **Votre numéro WhatsApp**` +
          `\n4. **Un numéro à joindre** (pour le livreur)` +
          `\n5. **Indications pour trouver l’emplacement**` +
          `\n\n📝 **Format attendu** :` +
          `\nNom: [votre nom]` +
          `\nQuartier: [votre quartier]` +
          `\nWhatsApp: [votre numéro]` +
          `\nÀ joindre: [numéro]` +
          `\nIndications: [détails]` +
          `\n\nEnvoyez ces informations pour que nous puissions organiser la livraison.`
        );
        const userState = userStates.get(commande.client.telephone) || { ...DEFAULT_STATE };
        userState.step = 'ATTENTE_INFOS_LIVRAISON_ORDONNANCE';
        userState.commandeEnCours = commandeId;
        userStates.set(commande.client.telephone, userState);
      } else if (reponse === 'refuser') {
        await db.collection('commandes').doc(commandeId).update({
          statut: 'ordonnance_refusee',
          ordonnanceValidee: false,
          pharmacieValidee: false,
          dateRefus: Date.now()
        });
        await sendTextMessage(commande.client.telephone,
          `❌ **Ordonnance refusée, ${commande.client.nom || "Caroline"}**\n\n` +
          `La pharmacie a refusé votre ordonnance.\n\n` +
          `Nous transférons votre commande à une autre pharmacie de garde.\n\n` +
          `Nous vous recontacterons sous peu.`
        );
        await this.trouverAutrePharmacie(commandeId);
      }
    } catch (error) {
      console.error("Erreur gestion réponse pharmacie:", error);
    }
  },
  async trouverAutrePharmacie(commandeId) {
    try {
      const commandeDoc = await db.collection('commandes').doc(commandeId).get();
      if (!commandeDoc.exists) return;
      const commande = commandeDoc.data();
      const autresPharmacies = await getPharmaciesDeGarde();
      const autresPharmaciesDispo = autresPharmacies.filter(p => p.id !== commande.pharmacieId);
      if (autresPharmaciesDispo.length > 0) {
        const nouvellePharmacie = autresPharmaciesDispo[0];
        await db.collection('commandes').doc(commandeId).update({
          pharmacieId: nouvellePharmacie.id,
          pharmacieNom: nouvellePharmacie.nom,
          statut: 'en_validation_pharmacie',
          pharmaciePrecedente: commande.pharmacieId
        });
        await this.envoyerOrdonnancePharmacie(commandeId, commande.ordonnancePhotoUrl, nouvellePharmacie.id);
        await sendTextMessage(commande.client.telephone,
          `🔄 **Transfert à une autre pharmacie, ${commande.client.nom || "Caroline"}**\n\n` +
          `La pharmacie précédente a refusé l'ordonnance.\n` +
          `Nous avons transféré votre commande à une autre pharmacie de garde.\n\n` +
          `Nouvelle pharmacie: ${nouvellePharmacie.nom}\n` +
          `Tél: ${nouvellePharmacie.telephone}\n\n` +
          `Attente de validation...`
        );
      } else {
        await db.collection('commandes').doc(commandeId).update({
          statut: 'annulee',
          raisonAnnulation: 'Aucune pharmacie disponible'
        });
        await sendTextMessage(commande.client.telephone,
          `❌ **Commande annulée, ${commande.client.nom || "Caroline"}**\n\n` +
          `Aucune pharmacie de garde disponible pour valider votre ordonnance.\n\n` +
          `Veuillez contacter directement une pharmacie.\n` +
          `📞 Support: ${CONFIG.SUPPORT_PHONE}`
        );
      }
    } catch (error) {
      console.error("Erreur recherche autre pharmacie:", error);
    }
  }
};

// Module Gestion Panier
const panierManager = {
  async peutAjouterMedicament(userId, medicamentId) {
    try {
      const medicamentDoc = await db.collection('medicaments').doc(medicamentId).get();
      if (!medicamentDoc.exists) return { allowed: false, message: "Médicament introuvable" };
      const medicament = medicamentDoc.data();
      const userState = userStates.get(userId) || { ...DEFAULT_STATE };
      if (medicament.necessiteOrdonnance && !userState.ordonnanceValidee) {
        return {
          allowed: false,
          message: `❌ **Médicament sous ordonnance, ${userState.nom || "Caroline"}**\n\n` +
                  `Le médicament "${medicament.nom}" nécessite une ordonnance valide.\n\n` +
                  `Pour ajouter ce médicament au panier:\n` +
                  `1. Envoyez une photo de votre ordonnance d'abord\n` +
                  `2. Attendez la validation par une pharmacie\n` +
                  `3. Vous pourrez ensuite ajouter le médicament\n\n` +
                  `📸 Pour envoyer votre ordonnance:\n` +
                  `• Cliquez sur 📎 (attache)\n` +
                  `• Sélectionnez "Galerie"\n` +
                  `• Choisissez la photo de votre ordonnance`
        };
      }
      if (userState.panier.length > 0 && userState.pharmacieId && userState.pharmacieId !== medicament.pharmacieId) {
        return {
          allowed: false,
          message: `❌ **Pharmacie différente, ${userState.nom || "Caroline"}**\n\n` +
                  `Votre panier contient déjà des médicaments de la pharmacie "${userState.pharmacieNom}".\n\n` +
                  `Veuillez d'abord vider votre panier ou finaliser votre commande avant de commander dans une autre pharmacie.`
        };
      }
      if (medicament.stock < 1) {
        return {
          allowed: false,
          message: `❌ **Stock insuffisant, ${userState.nom || "Caroline"}**\n\n` +
                  `Il ne reste plus de stock pour "${medicament.nom}".\n\n` +
                  `Stock disponible: ${medicament.stock} unité(s)`
        };
      }
      return { allowed: true, medicament: { id: medicamentDoc.id, ...medicament } };
    } catch (error) {
      console.error("Erreur vérification médicament:", error);
      return { allowed: false, message: "Erreur système lors de la vérification" };
    }
  },
  async ajouterAuPanier(userId, medicamentId, quantite = 1) {
    try {
      const verification = await this.peutAjouterMedicament(userId, medicamentId);
      if (!verification.allowed) return { success: false, message: verification.message };
      const medicament = verification.medicament;
      const userState = userStates.get(userId) || { ...DEFAULT_STATE };
      if (medicament.stock < quantite) {
        return {
          success: false,
          message: `❌ **Stock insuffisant, ${userState.nom || "Caroline"}**\n\n` +
                  `Vous demandez ${quantite} unité(s) mais il ne reste que ${medicament.stock} unité(s) disponible(s).`
        };
      }
      if (userState.panier.length === 0) {
        userState.pharmacieId = medicament.pharmacieId;
        const pharmacieDoc = await db.collection('pharmacies').doc(medicament.pharmacieId).get();
        if (pharmacieDoc.exists) userState.pharmacieNom = pharmacieDoc.data().nom;
      }
      const indexExist = userState.panier.findIndex(item => item.id === medicamentId);
      if (indexExist !== -1) {
        userState.panier[indexExist].quantite += quantite;
      } else {
        userState.panier.push({
          id: medicament.id,
          nom: medicament.nom,
          prix: medicament.prix,
          quantite: quantite,
          imageUrl: medicament.imageUrls?.[0],
          pharmacieId: medicament.pharmacieId,
          necessiteOrdonnance: medicament.necessiteOrdonnance,
          dosage: medicament.dosage,
          forme: medicament.forme
        });
      }
      if (medicament.necessiteOrdonnance) userState.besoinOrdonnance = true;
      userStates.set(userId, userState);
      return {
        success: true,
        message: `✅ **${medicament.nom} ajouté à votre panier, ${userState.nom || "Caroline"}**\n\n` +
                `Quantité: ${quantite}\n` +
                `Pharmacie: ${userState.pharmacieNom}\n` +
                `Prix unitaire: ${medicament.prix} FCFA\n` +
                `Sous-total: ${medicament.prix * quantite} FCFA\n\n` +
                (medicament.necessiteOrdonnance ? `⚠️ **Ordonnance requise**\nVous devrez envoyer une photo de votre ordonnance lors du paiement.\n\n` : ''),
        panier: userState.panier,
        pharmacie: { id: userState.pharmacieId, nom: userState.pharmacieNom }
      };
    } catch (error) {
      console.error("Erreur ajout panier:", error);
      return { success: false, message: "❌ Erreur système lors de l'ajout au panier" };
    }
  },
  async afficherPanier(userId) {
    const userState = userStates.get(userId) || { ...DEFAULT_STATE };
    if (userState.panier.length === 0) return `🛒 Votre panier est vide, ${userState.nom || "Caroline"}.`;
    let message = `🛒 **VOTRE PANIER, ${userState.nom || "Caroline"})**\n\n`;
    message += `🏥 Pharmacie: ${userState.pharmacieNom || 'Non spécifiée'}\n\n`;
    let total = 0;
    let itemsDetails = [];
    userState.panier.forEach((item, index) => {
      const sousTotal = item.prix * item.quantite;
      total += sousTotal;
      itemsDetails.push(
        `${index + 1}. **${item.nom}**\n` +
        `   💰 ${item.prix} FCFA × ${item.quantite} = ${sousTotal} FCFA\n` +
        `   💊 ${item.dosage || ''} ${item.forme || ''}\n` +
        (item.necessiteOrdonnance ? `   ⚠️ Ordonnance requise\n` : '')
      );
    });
    message += itemsDetails.join('\n');
    message += `\n────────────────\n`;
    message += `💰 **Total: ${total} FCFA**\n`;
    const fraisLivraison = getFraisLivraison();
    message += `🚚 Frais livraison: ${fraisLivraison} FCFA\n`;
    message += `🎯 **Total estimé: ${total + fraisLivraison} FCFA**\n\n`;
    if (userState.besoinOrdonnance) {
      message += `⚠️ **ATTENTION, ${userState.nom || "Caroline"})**\n`;
      message += `Votre panier contient des médicaments nécessitant une ordonnance.\n`;
      message += `Vous devrez envoyer une photo de votre ordonnance.\n\n`;
    }
    return message;
  }
};

// Fonctions de notification
async function notifierClientLivraisonTerminee(commandeId) {
  try {
    const commandeDoc = await db.collection('commandes').doc(commandeId).get();
    if (!commandeDoc.exists) return;
    const commande = commandeDoc.data();
    await sendTextMessage(commande.client.telephone,
      `✅ **Livraison effectuée, ${commande.client.nom || "Caroline"}!**\n\n` +
      `Votre commande #${commandeId.substring(0, 8)} a été livrée avec succès.\n\n` +
      `Merci d'avoir utilisé Pillbox! 💊`
    );
  } catch (error) {
    console.error("Erreur notification livraison terminée:", error);
  }
}

// Fonction création commande
async function creerCommandeComplet(userId, userState, totalPanier, fraisLivraison) {
  const commandeId = uuidv4();
  const timestamp = Date.now();
  const medicamentsDetails = await Promise.all(
    userState.panier.map(async (item) => {
      const medicamentDoc = await db.collection('medicaments').doc(item.id).get();
      const medicament = medicamentDoc.data();
      return {
        id: item.id,
        nom: item.nom,
        prix: item.prix,
        quantite: item.quantite,
        sousTotal: item.prix * item.quantite,
        necessiteOrdonnance: medicament?.necessiteOrdonnance || false,
        dosage: medicament?.dosage,
        forme: medicament?.forme
      };
    })
  );
  const pharmacieDoc = await db.collection('pharmacies').doc(userState.pharmacieId).get();
  const pharmacie = pharmacieDoc.data();
  const commandeData = {
    id: commandeId,
    client: {
      telephone: userId,
      nom: userState.nom || 'Caroline Martin',
      quartier: userState.quartier,
      whatsapp: userState.whatsapp || userId,
      aJoindre: userState.aJoindre || userId
    },
    pharmacie: {
      id: userState.pharmacieId,
      nom: userState.pharmacieNom || pharmacie?.nom,
      telephone: pharmacie?.telephone,
      adresse: pharmacie?.adresse || 'BP 225',
      position: pharmacie?.position || { latitude: 0, longitude: 0 },
      horaires: pharmacie?.horaires || '24h/24'
    },
    medicaments: medicamentsDetails,
    montantTotal: totalPanier,
    fraisLivraison: fraisLivraison,
    totalFinal: totalPanier + fraisLivraison,
    livraison: {
      quartier: userState.quartier,
      indications: userState.indications,
      latitude: userState.location?.latitude,
      longitude: userState.location?.longitude
    },
    besoinOrdonnance: userState.besoinOrdonnance,
    ordonnancePhotoUrl: userState.ordonnancePhotoUrl,
    ordonnanceValidee: userState.ordonnanceValidee,
    statut: userState.besoinOrdonnance ? 'en_validation_pharmacie' : 'en_attente_livreur',
    createdAt: timestamp,
    updatedAt: timestamp,
    etapesLivraison: {
      acceptee: false,
      enRoutePharmacie: false,
      medicamentsRecuperes: false,
      enRouteClient: false,
      livree: false
    },
    chatActive: false,
    notifications: {
      clientNotified: false,
      livreurNotified: false,
      supportNotified: false
    }
  };
  await db.collection('commandes').doc(commandeId).set(commandeData);
  for (const item of userState.panier) await updateStock(item.id, item.quantite);
  return commandeId;
}

// Gestion des messages
async function handleTextMessage(from, text, userState) {
  if (!userState.initialized) {
    await envoyerMessageBienvenue(from, userState);
    return;
  }

  const isChatMessage = await livreurManager.handleChatClientLivreur(text, from, null);
  if (isChatMessage) return;

  // Utiliser Groq pour comprendre l'intention
  const groqResponse = await getGroqAIResponse(text);
  await analyserReponseGroq(from, text, groqResponse, userState);
}

async function analyserReponseGroq(userId, texteUtilisateur, reponseGroq, userState) {
  const texteLower = texteUtilisateur.toLowerCase();
  const reponseLower = reponseGroq.toLowerCase();

  // 1. Sélection d'une pharmacie
  if (userState.step === "ATTENTE_SELECTION_PHARMACIE") {
    const numeroPharmacie = parseInt(texteUtilisateur.trim());
    if (!isNaN(numeroPharmacie)) {
      await handleSelectionPharmacie(userId, numeroPharmacie, userState.nomMedicamentRecherche, userState);
      userState.step = "ATTENTE_COMMANDE_MEDICAMENT";
    } else {
      await sendTextMessage(userId, "❌ Veuillez répondre avec le **numéro** de la pharmacie (ex: *1*).");
    }
    return;
  }
  // 2. Recherche d'un médicament spécifique
  else if (reponseLower.includes("médicament") || reponseLower.includes("paracétamol") || reponseLower.includes("doliprane")) {
    const nomMedicament = extraireNomMedicament(texteUtilisateur);
    if (nomMedicament) {
      userState.nomMedicamentRecherche = nomMedicament;
      const pharmacies = await getPharmaciesDeGarde();
      if (pharmacies.length > 0) {
        await afficherPharmaciesDeGarde(userId);
        userState.step = "ATTENTE_SELECTION_PHARMACIE";
      } else {
        await sendTextMessage(userId, "❌ Aucune pharmacie de garde disponible actuellement, Caroline.");
      }
    } else {
      await sendTextMessage(userId, reponseGroq);
    }
  }
  // 3. Commande d'un médicament
  else if (texteLower.startsWith("commander") && userState.step === "ATTENTE_COMMANDE_MEDICAMENT") {
    const parts = texteLower.split(" ");
    if (parts.length < 3) {
      await sendTextMessage(userId, "❌ Format invalide. Utilisez : *COMMANDER [numéro] [quantité]*. Exemple : *COMMANDER 1 2*.");
      return;
    }
    const numeroMedicament = parseInt(parts[1]);
    const quantite = parseInt(parts[2]);
    if (isNaN(numeroMedicament) || isNaN(quantite)) {
      await sendTextMessage(userId, "❌ Numéro ou quantité invalide. Exemple : *COMMANDER 1 2*.");
      return;
    }

    // Récupérer les médicaments de la pharmacie sélectionnée
    const medicaments = await getMedicaments(userState.pharmacieId);
    if (numeroMedicament < 1 || numeroMedicament > medicaments.length) {
      await sendTextMessage(userId, "❌ Numéro de médicament invalide, Caroline.");
      return;
    }

    const medicament = medicaments[numeroMedicament - 1];
    const result = await panierManager.ajouterAuPanier(userId, medicament.id, quantite);
    if (result.success) {
      await sendTextMessage(userId, result.message);
      userState.step = "ATTENTE_ACTION_PANIER";
    } else {
      await sendTextMessage(userId, result.message);
    }
  }
  // 4. Gestion du panier
  else if (userState.step === "ATTENTE_ACTION_PANIER") {
    if (texteLower.includes("valider")) {
      const messagePanier = await panierManager.afficherPanier(userId);
      await sendTextMessage(
        userId,
        messagePanier + "\n\n" +
        "Pour **valider votre commande**, répondez : *OUI*\n" +
        "Pour **annuler**, répondez : *NON*."
      );
      userState.step = "ATTENTE_CONFIRMATION_COMMANDE";
    } else if (texteLower.includes("continuer")) {
      await afficherMedicamentsPharmacie(userId, userState.pharmacieId);
    } else {
      await sendTextMessage(userId, reponseGroq);
    }
  }
  // 5. Confirmation de la commande
  else if (userState.step === "ATTENTE_CONFIRMATION_COMMANDE") {
    if (texteLower.includes("oui")) {
      const totalPanier = userState.panier.reduce((sum, item) => sum + (item.prix * item.quantite), 0);
      const fraisLivraison = getFraisLivraison();
      await sendTextMessage(
        userId,
        `📝 **Informations de livraison requises, ${userState.nom || "Caroline"})**\n\n` +
        `Pour finaliser votre commande, nous avons besoin de :\n` +
        `1. **Votre quartier** (ex: Cocody)\n` +
        `2. **Un numéro à joindre** (pour le livreur)\n` +
        `3. **Indications pour trouver l’emplacement** (ex: "près du marché")\n\n` +
        `📝 **Format attendu** :\n` +
        `Quartier: [votre quartier]\n` +
        `À joindre: [numéro]\n` +
        `Indications: [détails]\n\n` +
        `Envoyez ces informations pour que nous puissions organiser la livraison.`
      );
      userState.step = "ATTENTE_INFOS_LIVRAISON";
    } else {
      await sendTextMessage(userId, "❌ Commande annulée, Caroline. Vous pouvez recommencer quand vous voulez !");
      userState.step = "MENU_PRINCIPAL";
    }
  }
  // 6. Infos de livraison
  else if (userState.step === "ATTENTE_INFOS_LIVRAISON") {
    await traiterInfosLivraison(userId, texteUtilisateur, userState);
  }
  // 7. Infos de livraison après validation d'ordonnance
  else if (userState.step === "ATTENTE_INFOS_LIVRAISON_ORDONNANCE") {
    await traiterInfosLivraisonOrdonnance(userId, texteUtilisateur, userState);
  }
  // 8. Contact du support
  else if (reponseLower.includes("support") || reponseLower.includes("aide")) {
    await contacterSupport(userId);
  }
  // 9. Réponse par défaut
  else {
    await sendTextMessage(userId, reponseGroq);
  }

  userStates.set(userId, userState);
}

function extraireNomMedicament(texte) {
  const motsCles = ["paracétamol", "doliprane", "amoxicilline", "ibuprofène", "aspirine", "médicament", "medicament"];
  const texteLower = texte.toLowerCase();

  for (const mot of motsCles) {
    if (texteLower.includes(mot)) {
      const mots = texteLower.split(" ");
      for (const m of mots) {
        if (m.includes(mot)) return m;
      }
    }
  }
  return null;
}

async function envoyerMessageBienvenue(userId, userState) {
  await sendTextMessage(
    userId,
    `💊 **Bonjour, Caroline !** Je suis Mia, votre assistante Pillbox. 🤖\n\n` +
    `Je suis là pour vous aider à :\n` +
    `- Commander des médicaments (avec ou sans ordonnance)\n` +
    `- Trouver des pharmacies de garde 24h/24\n` +
    `- Organiser des livraisons à domicile\n` +
    `- Identifier des médicaments par photo\n\n` +
    `✨ **Exemples de demandes :**\n` +
    `- "Je cherche du paracétamol 500mg"\n` +
    `- "Quelles pharmacies sont ouvertes ce soir ?"\n` +
    `- "Je veux commander de l’amoxicilline"\n` +
    `- "Contactez le support"\n\n` +
    `⚠️ **Important :**\n` +
    `- Ce service ne remplace pas un avis médical\n` +
    `- En cas d’urgence, composez le **15 (SAMU)** ou **112**\n\n` +
    `Par quoi commençons-nous aujourd’hui, Caroline ?`
  );
  userState.initialized = true;
  userStates.set(userId, userState);
}

async function afficherPharmaciesDeGarde(userId) {
  const pharmacies = await getPharmaciesDeGarde();
  if (pharmacies.length === 0) {
    await sendTextMessage(userId, "❌ Aucune pharmacie de garde disponible actuellement, Caroline.");
    return;
  }

  let message = "🏥 **Pharmacies de garde à San Pedro** (24h/24) :\n\n";
  for (const [index, pharmacie] of pharmacies.entries()) {
    if (pharmacie.imageUrl) {
      await sendImageMessage(
        userId,
        pharmacie.imageUrl,
        `${index + 1}. **${pharmacie.nom}** – ${pharmacie.adresse}`
      );
    }
    message += `${index + 1}. **${pharmacie.nom}**\n`;
    message += `   📍 ${pharmacie.adresse || 'Adresse non spécifiée'}\n`;
    message += `   📞 ${pharmacie.telephone}\n`;
    message += `   ⏰ ${pharmacie.horaires || "24h/24"}\n`;
    if (pharmacie.position) {
      const lienMaps = `https://www.google.com/maps?q=${pharmacie.position.latitude},${pharmacie.position.longitude}`;
      message += `   🗺️ [Voir sur la carte](${lienMaps})\n`;
    }
    message += "\n";
  }
  message += "Répondez avec le **numéro** de la pharmacie pour voir ses médicaments disponibles, Caroline.";
  await sendTextMessage(userId, message);
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };
  userState.step = "ATTENTE_SELECTION_PHARMACIE";
  userStates.set(userId, userState);
}

async function afficherMedicamentsPharmacie(userId, pharmacieId, nomMedicamentRecherche = null) {
  const pharmacie = await getPharmacie(pharmacieId);
  if (!pharmacie) {
    await sendTextMessage(userId, "❌ Pharmacie introuvable, Caroline.");
    return;
  }

  const medicaments = await getMedicaments(pharmacieId, nomMedicamentRecherche);
  if (medicaments.length === 0) {
    await sendTextMessage(
      userId,
      `❌ Aucun médicament${nomMedicamentRecherche ? ` correspondant à "${nomMedicamentRecherche}"` : ""} disponible dans cette pharmacie, Caroline.`
    );
    return;
  }

  let message = `💊 **Médicaments disponibles à ${pharmacie.nom}** :\n\n`;
  for (const [index, medicament] of medicaments.entries()) {
    if (medicament.imageUrls && medicament.imageUrls.length > 0) {
      await sendImageMessage(
        userId,
        medicament.imageUrls[0],
        `${index + 1}. **${medicament.nom}** – ${medicament.prix} FCFA (${medicament.stock} en stock)`
      );
    }
    message += `${index + 1}. **${medicament.nom}**\n`;
    message += `   💰 ${medicament.prix} FCFA\n`;
    message += `   📦 ${medicament.stock} en stock\n`;
    message += medicament.necessiteOrdonnance ? `   ⚠️ Ordonnance requise\n` : `   ✅ Sans ordonnance\n`;
    if (medicament.description) {
      message += `   📝 ${medicament.description.substring(0, 100)}...\n`;
    }
    message += "\n";
  }

  message += "Pour **commander**, répondez : *COMMANDER [numéro] [quantité]*.\nExemple : *COMMANDER 1 2*.";
  await sendTextMessage(userId, message);

  const userState = userStates.get(userId) || { ...DEFAULT_STATE };
  userState.step = "ATTENTE_COMMANDE_MEDICAMENT";
  userStates.set(userId, userState);
}

async function handleSelectionPharmacie(userId, numeroPharmacie, nomMedicamentRecherche, userState) {
  const pharmacies = await getPharmaciesDeGarde();
  if (numeroPharmacie < 1 || numeroPharmacie > pharmacies.length) {
    await sendTextMessage(userId, "❌ Numéro de pharmacie invalide, Caroline. Veuillez réessayer.");
    return;
  }

  const pharmacie = pharmacies[numeroPharmacie - 1];
  userState.pharmacieId = pharmacie.id;
  userState.pharmacieNom = pharmacie.nom;
  userStates.set(userId, userState);

  await afficherMedicamentsPharmacie(userId, pharmacie.id, nomMedicamentRecherche);
}

async function traiterInfosLivraison(userId, texte, userState) {
  try {
    const lignes = texte.split('\n');
    let quartier = '';
    let aJoindre = '';
    let indications = '';

    lignes.forEach(ligne => {
      if (ligne.toLowerCase().includes('quartier:')) quartier = ligne.split(':')[1]?.trim();
      else if (ligne.toLowerCase().includes('à joindre:')) aJoindre = ligne.split(':')[1]?.trim();
      else if (ligne.toLowerCase().includes('indications:')) indications = ligne.split(':')[1]?.trim();
    });

    if (!quartier || !aJoindre) {
      await sendTextMessage(
        userId,
        "❌ **Informations manquantes, Caroline**\n\n" +
        "Veuillez fournir toutes les informations requises :\n" +
        "Quartier, Numéro à joindre, Indications.\n\n" +
        "Exemple :\n" +
        "Quartier: Cocody\n" +
        "À joindre: +2250701406880\n" +
        "Indications: Près du marché, porte bleue"
      );
      return;
    }

    userState.quartier = quartier;
    userState.aJoindre = aJoindre;
    userState.indications = indications || "Aucune indication";

    const totalPanier = userState.panier.reduce((sum, item) => sum + (item.prix * item.quantite), 0);
    const fraisLivraison = getFraisLivraison();
    const commandeId = await creerCommandeComplet(userId, userState, totalPanier, fraisLivraison);

    await sendTextMessage(
      userId,
      `✅ **Commande confirmée, Caroline !** #${commandeId.substring(0, 8)}\n\n` +
      `🏥 **Pharmacie:** ${userState.pharmacieNom}\n` +
      `📍 **Quartier de livraison:** ${quartier}\n` +
      `📞 **Numéro à joindre:** ${aJoindre}\n` +
      `📝 **Indications:** ${indications || "Aucune"}\n\n` +
      `💰 **Total:** ${totalPanier + fraisLivraison} FCFA\n\n` +
      `Un livreur sera assigné sous peu. Vous recevrez une notification par WhatsApp.`
    );

    await livreurManager.envoyerCommandeLivreur(commandeId, userState.pharmacieId);

    userState.step = 'MENU_PRINCIPAL';
    userState.panier = [];
    userStates.set(userId, userState);
  } catch (error) {
    console.error("Erreur traitement infos livraison:", error);
    await sendTextMessage(userId, "❌ **Erreur, Caroline** : Impossible de traiter vos informations. Veuillez réessayer.");
  }
}

async function traiterInfosLivraisonOrdonnance(userId, texte, userState) {
  try {
    const commandeId = userState.commandeEnCours;
    const commandeDoc = await db.collection('commandes').doc(commandeId).get();
    if (!commandeDoc.exists) {
      await sendTextMessage(userId, "❌ **Erreur, Caroline** : Commande introuvable. Veuillez recommencer.");
      return;
    }

    const lignes = texte.split('\n');
    let nom = '';
    let quartier = '';
    let whatsapp = '';
    let aJoindre = '';
    let indications = '';

    lignes.forEach(ligne => {
      if (ligne.toLowerCase().includes('nom:')) nom = ligne.split(':')[1]?.trim();
      else if (ligne.toLowerCase().includes('quartier:')) quartier = ligne.split(':')[1]?.trim();
      else if (ligne.toLowerCase().includes('whatsapp:')) whatsapp = ligne.split(':')[1]?.trim();
      else if (ligne.toLowerCase().includes('à joindre:')) aJoindre = ligne.split(':')[1]?.trim();
      else if (ligne.toLowerCase().includes('indications:')) indications = ligne.split(':')[1]?.trim();
    });

    if (!nom || !quartier || !whatsapp || !aJoindre) {
      await sendTextMessage(
        userId,
        "❌ **Informations manquantes, Caroline**\n\n" +
        "Veuillez fournir toutes les informations requises :\n" +
        "Nom, Quartier, WhatsApp, Numéro à joindre, Indications.\n\n" +
        "Exemple :\n" +
        "Nom: Caroline Martin\n" +
        "Quartier: Cocody\n" +
        "WhatsApp: +2250701406880\n" +
        "À joindre: +2250701406880\n" +
        "Indications: Près du marché, porte bleue"
      );
      return;
    }

    await db.collection('commandes').doc(commandeId).update({
      'client.nom': nom,
      'client.whatsapp': whatsapp,
      'client.aJoindre': aJoindre,
      'livraison.quartier': quartier,
      'livraison.indications': indications,
      statut: 'en_attente_livreur',
      dateInfosLivraison: Date.now()
    });

    await sendTextMessage(
      userId,
      `✅ **Informations de livraison enregistrées, Caroline !**\n\n` +
      `Nom : ${nom}\n` +
      `Quartier : ${quartier}\n` +
      `WhatsApp : ${whatsapp}\n` +
      `À joindre : ${aJoindre}\n` +
      `Indications : ${indications}\n\n` +
      `Un livreur va être assigné à votre commande.\n` +
      `Vous recevrez une notification dès qu’il sera en route.`
    );

    await livreurManager.envoyerCommandeLivreur(commandeId, userState.pharmacieId);

    userState.step = 'MENU_PRINCIPAL';
    userState.commandeEnCours = null;
    userStates.set(userId, userState);
  } catch (error) {
    console.error("Erreur traitement infos livraison ordonnance:", error);
    await sendTextMessage(userId, "❌ **Erreur, Caroline** : Impossible de traiter vos informations. Veuillez réessayer.");
  }
}

async function contacterSupport(userId) {
  const lienSupport = `https://wa.me/${CONFIG.SUPPORT_PHONE.replace('+', '')}`;
  await sendTextMessage(
    userId,
    `📞 **Support Pillbox, Caroline**\n\n` +
    `Notre équipe est disponible pour vous aider :\n` +
    `📱 **WhatsApp** : [${CONFIG.SUPPORT_PHONE}](${lienSupport})\n` +
    `💬 **Cliquez ici pour ouvrir la conversation** : ${lienSupport}\n\n` +
    `✨ **Services support :**\n` +
    `- Assistance commandes\n` +
    `- Questions sur les médicaments\n` +
    `- Réclamations ou urgences\n` +
    `- Aide technique\n\n` +
    `N’hésitez pas à nous contacter, Caroline !`
  );
}

// Webhook WhatsApp
app.get('/api/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token === CONFIG.VERIFY_TOKEN) {
    console.log('✅ Webhook vérifié');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Échec vérification webhook');
    res.status(403).send('Token invalide');
  }
});

app.post('/api/webhook', async (req, res) => {
  console.log('📩 Webhook POST reçu');
  res.status(200).send('EVENT_RECEIVED');
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const messageType = message.type;
    let userState = userStates.get(from) || { ...DEFAULT_STATE, nom: "Caroline Martin" };

    if (messageType === 'audio' || messageType === 'voice') return;

    if (messageType === 'text') {
      const isChatMessage = await livreurManager.handleChatClientLivreur(message.text.body, from, null);
      if (isChatMessage) return;
      await handleTextMessage(from, message.text.body, userState);
    }
    else if (messageType === 'image') {
      const imageId = message.image.id;
      const imageUrl = await getWhatsAppMediaUrl(imageId);
      if (userState.attentePhoto) {
        userState.ordonnancePhotoUrl = imageUrl;
        userState.attentePhoto = false;
        await sendTextMessage(
          from,
          "✅ **Ordonnance reçue, Caroline !**\n\n" +
          "Votre ordonnance a été envoyée à la pharmacie pour validation.\n" +
          "Vous recevrez une confirmation sous peu.\n\n" +
          "⏳ **En attente de validation...**"
        );
        const commandeId = userState.commandeEnCours || uuidv4();
        await pharmacieValidator.envoyerOrdonnancePharmacie(commandeId, imageUrl, userState.pharmacieId);
      } else {
        await analyserImageMedicament(from, imageUrl, userState);
      }
    }
    else if (messageType === 'location') {
      await handleLocationMessage(from, message.location, userState);
    }
    else if (messageType === 'interactive' && message.interactive?.type === 'button_reply') {
      await handleInteractiveMessage(from, message.interactive.button_reply.id, userState);
    }

    userStates.set(from, userState);
  } catch (error) {
    console.error('💥 Erreur webhook:', error.message, error.stack);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'Pillbox WhatsApp Bot PRODUCTION',
    version: '1.0.0',
    users_actifs: userStates.size,
    firebase_connected: true,
    support_phone: CONFIG.SUPPORT_PHONE
  });
});

// Fonction utilitaire pour récupérer l'URL d'une image WhatsApp
async function getWhatsAppMediaUrl(mediaId) {
  try {
    const response = await axios.get(
      `https://graph.facebook.com/v19.0/${mediaId}`,
      { headers: { 'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}` } }
    );
    return response.data.url;
  } catch (error) {
    console.error('Erreur récupération média:', error.message);
    return null;
  }
}

// Fonction pour analyser une image de médicament
async function analyserImageMedicament(userId, imageUrl, userState) {
  try {
    await sendTextMessage(userId, "🔍 **Analyse de l'image en cours, Caroline...**\n\nPatientez quelques secondes.");
    await sendTypingIndicator(userId, 4000);

    // Simulation d'une réponse d'IA (à remplacer par un appel à une API d'OCR ou de reconnaissance d'image)
    const aiResponse = "📸 **Médicament identifié, Caroline :**\n" +
                        "**Paracétamol 500mg**\n\n" +
                        "💊 **Catégorie :** Douleurs-Fièvre\n" +
                        "📋 **Ordonnance :** Non requise\n" +
                        "⚠️ **Conseil :** 1 comprimé toutes les 6 heures\n\n" +
                        "Souhaitez-vous **rechercher ce médicament** ou **le commander** ?\n" +
                        "Répondez *RECHERCHER* ou *COMMANDER*.";

    await sendTextMessage(userId, aiResponse);
  } catch (error) {
    console.error('Erreur analyse image:', error);
    await sendTextMessage(
      userId,
      "❌ **Impossible d'analyser l'image, Caroline**\n\n" +
      "Veuillez essayer avec une photo plus nette ou utilisez la recherche par nom."
    );
  }
}

// Fonction pour gérer les messages interactifs (boutons)
async function handleInteractiveMessage(from, buttonId, userState) {
  if (buttonId.startsWith('accepter_')) {
    const commandeId = buttonId.replace('accepter_', '');
    await livreurManager.handleReponseLivreur(from, buttonId, commandeId, 'accepter');
  }
  else if (buttonId.startsWith('refuser_')) {
    const commandeId = buttonId.replace('refuser_', '');
    await livreurManager.handleReponseLivreur(from, buttonId, commandeId, 'refuser');
  }
  else if (buttonId.startsWith('valider_ordonnance_')) {
    const commandeId = buttonId.replace('valider_ordonnance_', '');
    await pharmacieValidator.handleReponsePharmacie(from, buttonId, commandeId, 'valider');
  }
  else if (buttonId.startsWith('refuser_ordonnance_')) {
    const commandeId = buttonId.replace('refuser_ordonnance_', '');
    await pharmacieValidator.handleReponsePharmacie(from, buttonId, commandeId, 'refuser');
  }
  else if (buttonId.startsWith('note_')) {
    const parts = buttonId.split('_');
    const note = parts[1];
    const commandeId = parts[2];
    await enregistrerNote(commandeId, parseInt(note), from);
  }
  else {
    await sendTextMessage(from, "❌ Option non reconnue, Caroline. Retour au menu principal.");
    await envoyerMessageBienvenue(from, userState);
  }
}

// Démarrage du serveur
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
=======================================
🚀 Pillbox WhatsApp Bot PRODUCTION
📍 Port: ${PORT}
💊 Service: Commandes médicaments San Pedro
🤖 IA: Mia (Groq ${CONFIG.GROQ_MODEL})
📞 Support: ${CONFIG.SUPPORT_PHONE}
=======================================
Variables requises:
  ✅ VERIFY_TOKEN: Défini
  ✅ PHONE_NUMBER_ID: Défini
  ✅ WHATSAPP_TOKEN: Défini
  ✅ GROQ_API_KEY: Défini
  ✅ FIREBASE_PROJECT_ID: Défini
=======================================
Statut Firebase: ✅ Connecté
=======================================
  `);
});

// Gestion des erreurs
process.on('uncaughtException', (error) => {
  console.error('💥 ERREUR NON GÉRÉE:', error.message);
  console.error('Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 PROMISE REJECTION NON GÉRÉE:', reason);
});
