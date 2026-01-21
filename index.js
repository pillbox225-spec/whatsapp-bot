require('dotenv').config();
const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const Fuse = require('fuse.js');
const { vision } = require('@google-cloud/vision');

// Initialisation Express
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
  listeMedicamentsRecherche: [],
  currentCategorie: null,
  medicamentIdentifie: null,
  nomMedicamentRecherche: null,
  listeMedicamentsAvecIndex: [],
  resultatsRechercheMedicaments: null
};

// Client Google Vision pour OCR
const clientVision = new vision.ImageAnnotatorClient({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
});

// Prompt système pour Groq
const SYSTEM_PROMPT = `
Tu es Mia, l'assistante médicale intelligente de Pillbox à San Pedro, spécialement conçue pour aider les utilisateurs à :
- Commander des médicaments (avec ou sans ordonnance).
- Trouver des pharmacies de garde et des cliniques.
- Prendre des rendez-vous médicaux.
- Obtenir des conseils en psychologie, nutrition, médecine générale, sexologie ou coaching.

### Règles strictes à suivre :
1. Réponds UNIQUEMENT aux questions liées à la santé, médicaments, pharmacies, commandes, ordonnances, cliniques, médecins et livraisons.
2. Ne fais PAS de diagnostic médical. Réponds toujours : "Consultez un médecin ou un professionnel de santé pour un avis médical."
3. Pour les urgences : Réponds toujours : "En cas d'urgence, contactez immédiatement le support client."
4. Sois concis (2-3 phrases max par réponse), utilise des emojis pour clarifier, et termine toujours par une question ou une action claire.
5. Appelle l'utilisateur par son nom s'il est connu, sinon utilise "vous".
6. Pour les médicaments :
   - Si l'utilisateur cherche un médicament, propose de vérifier sa disponibilité ou de commander directement.
   - Si le médicament nécessite une ordonnance, explique clairement la procédure pour envoyer une photo.
7. Pour les rendez-vous :
   - Guide l'utilisateur étape par étape : choix du médecin, date/heure, confirmation.
8. Pour les conseils santé :
   - Donne des conseils généraux (ex: gestion du stress, alimentation) mais oriente toujours vers un professionnel pour un suivi personnalisé.
9. Format des réponses :
   - Utilise des listes numérotées pour les choix.
   - Donne toujours un exemple de réponse attendue (ex: "Répondez : OUI ou NON").
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
    return "Désolé, je ne peux pas répondre pour le moment. Comment puis-je vous aider avec Pillbox ?";
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

async function getMedicaments(pharmacieId = null, recherche = null) {
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

async function getCentresSante() {
  try {
    const snapshot = await db.collection('centres_sante')
      .where('estVerifie', '==', true)
      .get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('Erreur getCentresSante:', error.message);
    return [];
  }
}

async function getMedecinsParClinique(centreSanteId) {
  try {
    const snapshot = await db.collection('centres_sante').doc(centreSanteId).collection('medecins').get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('Erreur getMedecinsParClinique:', error.message);
    return [];
  }
}

async function getServicesMedicaux(centreSanteId) {
  try {
    const snapshot = await db.collection('centres_sante').doc(centreSanteId).collection('services_medicale').get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('Erreur getServicesMedicaux:', error.message);
    return [];
  }
}

async function creerRendezVous(centreSanteId, medecinId, serviceId, patientNom, patientTelephone, date, notes = "") {
  try {
    const rendezVousId = uuidv4();
    const rendezVousData = {
      id: rendezVousId,
      centreSanteId,
      medecinId,
      serviceId,
      patientId: patientTelephone,
      patientNom,
      patientTelephone,
      date: admin.firestore.Timestamp.fromDate(new Date(date)),
      dateCreation: admin.firestore.FieldValue.serverTimestamp(),
      statut: "confirme",
      notes,
      typeConsultation: "presentiel"
    };
    await db.collection('rendez_vous').doc(rendezVousId).set(rendezVousData);
    return { success: true, rendezVousId };
  } catch (error) {
    console.error('Erreur creerRendezVous:', error.message);
    return { success: false, message: error.message };
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
        `🚗 **LIVRAISON EN COURS, ${commande.client.nom || "vous"}!**\n\n` +
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
          `❌ **Commande annulée, ${commande.client.nom || "vous"}**\n\n` +
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
          `✅ **Ordonnance validée, ${commande.client.nom || "vous"}!**\n\n` +
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
          `❌ **Ordonnance refusée, ${commande.client.nom || "vous"}**\n\n` +
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
          `🔄 **Transfert à une autre pharmacie, ${commande.client.nom || "vous"}**\n\n` +
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
          `❌ **Commande annulée, ${commande.client.nom || "vous"}**\n\n` +
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
          message: `❌ **Médicament sous ordonnance**\n\n` +
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
          message: `❌ **Pharmacie différente**\n\n` +
                  `Votre panier contient déjà des médicaments de la pharmacie "${userState.pharmacieNom}".\n\n` +
                  `Veuillez d'abord vider votre panier ou finaliser votre commande avant de commander dans une autre pharmacie.`
        };
      }
      if (medicament.stock < 1) {
        return {
          allowed: false,
          message: `❌ **Stock insuffisant**\n\n` +
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
          message: `❌ **Stock insuffisant**\n\n` +
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
        message: `✅ **${medicament.nom} ajouté à votre panier**\n\n` +
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
    if (userState.panier.length === 0) return `🛒 Votre panier est vide.`;
    let message = `🛒 **VOTRE PANIER**\n\n`;
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
      message += `⚠️ **ATTENTION**\n`;
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
      `✅ **Livraison effectuée!**\n\n` +
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
      nom: userState.nom || 'Client Pillbox',
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

// Fonctions pour la recherche de médicaments
async function rechercherMedicamentDansPharmacies(nomMedicament) {
  try {
    const medicamentsSnapshot = await db.collection('medicaments')
      .where('stock', '>', 0)
      .where('nomLower', '>=', nomMedicament.toLowerCase())
      .where('nomLower', '<=', nomMedicament.toLowerCase() + '\uf8ff')
      .get();

    const medicamentsParPharmacie = {};
    medicamentsSnapshot.docs.forEach(doc => {
      const medicament = { id: doc.id, ...doc.data() };
      const pharmacieId = medicament.pharmacieId;
      if (!medicamentsParPharmacie[pharmacieId]) {
        medicamentsParPharmacie[pharmacieId] = {
          pharmacie: null,
          medicaments: []
        };
      }
      medicamentsParPharmacie[pharmacieId].medicaments.push(medicament);
    });

    for (const pharmacieId in medicamentsParPharmacie) {
      const pharmacieDoc = await db.collection('pharmacies').doc(pharmacieId).get();
      if (pharmacieDoc.exists) {
        medicamentsParPharmacie[pharmacieId].pharmacie = {
          id: pharmacieDoc.id,
          ...pharmacieDoc.data()
        };
      }
    }

    return medicamentsParPharmacie;
  } catch (error) {
    console.error("Erreur recherche médicament:", error);
    return {};
  }
}

async function afficherMedicamentsFiltres(userId, nomMedicament) {
  const medicamentsParPharmacie = await rechercherMedicamentDansPharmacies(nomMedicament);

  if (Object.keys(medicamentsParPharmacie).length === 0) {
    await sendTextMessage(
      userId,
      `❌ Aucun médicament correspondant à "${nomMedicament}" n'est disponible.\n` +
      "Vérifiez l'orthographe ou essayez une autre recherche."
    );
    return;
  }

  const userState = userStates.get(userId) || { ...DEFAULT_STATE };
  userState.resultatsRechercheMedicaments = medicamentsParPharmacie;
  userState.nomMedicamentRecherche = nomMedicament;
  userStates.set(userId, userState);

  let message = `💊 **Résultats pour "${nomMedicament}"** :\n\n`;
  let indexGlobal = 1;
  const medicamentsAvecIndex = [];

  for (const pharmacieId in medicamentsParPharmacie) {
    const { pharmacie, medicaments } = medicamentsParPharmacie[pharmacieId];
    if (!pharmacie) continue;

    message += `🏥 **${pharmacie.nom}** (${pharmacie.adresse})\n`;
    for (const medicament of medicaments) {
      if (medicament.imageUrls && medicament.imageUrls.length > 0) {
        await sendImageMessage(
          userId,
          medicament.imageUrls[0],
          `${indexGlobal}. **${medicament.nom}**\n` +
          `💰 ${medicament.prix} FCFA | 📦 ${medicament.stock} en stock\n` +
          `${medicament.necessiteOrdonnance ? `⚠️ Ordonnance requise` : `✅ Sans ordonnance`}`
        );
      }
      message += `${indexGlobal}. **${medicament.nom}**\n`;
      message += `   💰 ${medicament.prix} FCFA | 📦 ${medicament.stock} en stock\n`;
      message += `   ${medicament.necessiteOrdonnance ? `⚠️ Ordonnance requise` : `✅ Sans ordonnance`}\n`;
      medicamentsAvecIndex.push({
        index: indexGlobal,
        pharmacieId: pharmacie.id,
        pharmacieNom: pharmacie.nom,
        medicament: medicament
      });
      indexGlobal++;
    }
    message += "\n";
  }

  message += `Pour **commander**, répondez : *COMMANDER [numéro] [quantité]*.\n` +
             `Exemple : *COMMANDER 1 2*.`;
  await sendTextMessage(userId, message);

  userState.listeMedicamentsAvecIndex = medicamentsAvecIndex;
  userState.step = "ATTENTE_COMMANDE_MEDICAMENT_FILTRE";
  userStates.set(userId, userState);
}

async function handleCommandeMedicamentFiltre(userId, texte, userState) {
  const texteLower = texte.toLowerCase();
  if (!texteLower.startsWith("commander")) {
    await sendTextMessage(
      userId,
      "❌ Format invalide.\n" +
      "Utilisez : *COMMANDER [numéro] [quantité]*.\nExemple : *COMMANDER 1 2*."
    );
    return;
  }

  const parts = texteLower.split(" ");
  if (parts.length < 3) {
    await sendTextMessage(
      userId,
      "❌ Format invalide.\n" +
      "Utilisez : *COMMANDER [numéro] [quantité]*.\nExemple : *COMMANDER 1 2*."
    );
    return;
  }

  const numeroMedicament = parseInt(parts[1]);
  const quantite = parseInt(parts[2]);
  if (isNaN(numeroMedicament) || isNaN(quantite)) {
    await sendTextMessage(
      userId,
      "❌ Numéro ou quantité invalide.\n" +
      "Exemple : *COMMANDER 1 2*."
    );
    return;
  }

  const medicamentSelectionne = userState.listeMedicamentsAvecIndex.find(m => m.index === numeroMedicament);
  if (!medicamentSelectionne) {
    await sendTextMessage(userId, "❌ Numéro de médicament invalide. Veuillez réessayer.");
    return;
  }

  userState.pharmacieId = medicamentSelectionne.pharmacieId;
  userState.pharmacieNom = medicamentSelectionne.pharmacieNom;
  userStates.set(userId, userState);

  const result = await panierManager.ajouterAuPanier(
    userId,
    medicamentSelectionne.medicament.id,
    quantite
  );

  if (result.success) {
    await sendTextMessage(userId, result.message);
    userState.step = "ATTENTE_ACTION_PANIER";
  } else {
    await sendTextMessage(userId, result.message);
  }
  userStates.set(userId, userState);
}

// Fonction pour analyser une image de médicament (OCR)
async function analyserImageMedicament(userId, imageUrl) {
  try {
    await sendTextMessage(userId, "🔍 **Analyse de l'image en cours...**\nPatientez quelques secondes.");

    const [result] = await clientVision.textDetection(imageUrl);
    const detections = result.textAnnotations;
    const texteExtrait = detections.length > 0 ? detections[0].description : null;

    if (!texteExtrait) {
      await sendTextMessage(
        userId,
        "❌ **Impossible d'extraire le texte de l'image.**\n" +
        "Veuillez envoyer une photo plus nette ou utiliser la recherche par nom."
      );
      return null;
    }

    const nomMedicament = extraireNomMedicamentOCR(texteExtrait);
    if (!nomMedicament) {
      await sendTextMessage(
        userId,
        "❌ **Aucun médicament reconnu dans cette image.**\n" +
        "Essayez avec une autre photo ou tapez le nom du médicament."
      );
      return null;
    }

    await afficherMedicamentsFiltres(userId, nomMedicament);
    return nomMedicament;
  } catch (error) {
    console.error("Erreur analyse OCR:", error);
    await sendTextMessage(
      userId,
      "❌ **Erreur lors de l'analyse de l'image.**\n" +
      "Veuillez réessayer ou contacter le support."
    );
    return null;
  }
}

function extraireNomMedicamentOCR(texte) {
  const motsClesMedicaments = [
    "paracétamol", "doliprane", "amoxicilline", "ibuprofène", "aspirine",
    "mg", "comprimé", "gélule", "sirop", "dosage", "500mg", "1g"
  ];

  const texteNettoye = texte.replace(/[^\w\s]/gi, ' ').replace(/\s+/g, ' ').toLowerCase();

  for (const mot of motsClesMedicaments) {
    if (texteNettoye.includes(mot)) {
      const index = texteNettoye.indexOf(mot);
      const debut = Math.max(0, index - 20);
      const fin = Math.min(texteNettoye.length, index + 30);
      return texteNettoye.substring(debut, fin).trim();
    }
  }

  return texteNettoye.split(' ').slice(0, 3).join(' ');
}

// Gestion des messages
async function handleTextMessage(from, text, userState) {
  if (!userState.initialized) {
    await envoyerMessageBienvenue(from, userState);
    return;
  }

  const isChatMessage = await livreurManager.handleChatClientLivreur(text, from, null);
  if (isChatMessage) return;

  const texteLower = text.toLowerCase();

  // Recherche de médicament
  if (userState.step === "ATTENTE_RECHERCHE_MEDICAMENT") {
    await afficherMedicamentsFiltres(from, text);
    return;
  }

  // Commande d'un médicament filtré
  if (userState.step === "ATTENTE_COMMANDE_MEDICAMENT_FILTRE") {
    await handleCommandeMedicamentFiltre(from, text, userState);
    return;
  }

  // Prise de rendez-vous
  if (texteLower.includes("rendez-vous") || texteLower.includes("médecin") || texteLower.includes("clinique")) {
    await handlePriseRendezVous(from, text, userState);
    return;
  }

  // Conseils santé (psychologie, nutrition, etc.)
  const motsClesSoutien = [
    "stress", "anxiété", "déprimé", "triste", "poids", "alimentation",
    "nutrition", "régime", "malade", "symptôme", "sexualité", "relation",
    "motivation", "objectif", "coaching", "conseil"
  ];
  const estDemandeSoutien = motsClesSoutien.some(mot => texteLower.includes(mot));
  if (estDemandeSoutien) {
    await handleDemandeSoutien(from, text, userState);
    return;
  }

  // Utiliser Groq pour les autres demandes
  const groqResponse = await getGroqAIResponse(text);
  await analyserReponseGroq(from, text, groqResponse, userState);
}

async function handlePriseRendezVous(userId, texte, userState) {
  if (userState.step === "ATTENTE_SELECTION_MEDECIN") {
    const numeroMedecin = parseInt(texte.trim());
    const medecins = userState.listeMedecins || [];
    if (numeroMedecin >= 1 && numeroMedecin <= medecins.length) {
      const medecin = medecins[numeroMedecin - 1];
      userState.medecinId = medecin.id;
      userState.medecinNom = medecin.nomComplet;
      await demanderDateHeureRendezVous(userId, medecin.nomComplet, userState.cliniqueNom);
      userState.step = "ATTENTE_DATE_HEURE_RENDEZ_VOUS";
      userStates.set(userId, userState);
    } else {
      await sendTextMessage(userId, "❌ Numéro de médecin invalide. Veuillez réessayer.");
    }
    return;
  }

  if (userState.step === "ATTENTE_DATE_HEURE_RENDEZ_VOUS") {
    const dateHeureRegex = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/;
    const match = texte.trim().match(dateHeureRegex);
    if (!match) {
      await sendTextMessage(
        userId,
        "❌ **Format invalide.**\n" +
        "Veuillez utiliser le format *JJ/MM/AAAA HH:MM* (ex: *25/12/2025 14:30*)."
      );
      return;
    }
    const [_, jour, mois, annee, heure, minute] = match;
    const dateRendezVous = new Date(`${annee}-${mois}-${jour}T${heure}:${minute}:00Z`);
    if (dateRendezVous <= new Date()) {
      await sendTextMessage(userId, "❌ **Date ou heure invalide.**\nVeuillez choisir une date et une heure futures.");
      return;
    }
    userState.dateRendezVous = dateRendezVous;
    await confirmerRendezVous(userId, userState);
    return;
  }

  if (userState.step === "ATTENTE_CONFIRMATION_RENDEZ_VOUS") {
    if (texteLower.includes("oui")) {
      await finaliserRendezVous(userId, userState);
    } else {
      await sendTextMessage(userId, "❌ Rendez-vous annulé. Vous pouvez en prendre un autre quand vous voulez !");
      userState.step = "MENU_PRINCIPAL";
      userStates.set(userId, userState);
    }
    return;
  }

  // Recherche de médecin par spécialité
  const specialites = ["dermatologue", "pédiatre", "gynécologue", "cardiologue", "nutritionniste", "psychologue"];
  const specialiteTrouvee = specialites.find(s => texteLower.includes(s));
  if (specialiteTrouvee) {
    const medecins = await rechercherMedecinsParSpecialite(specialiteTrouvee);
    if (medecins.length === 0) {
      await sendTextMessage(userId, `❌ Aucun ${specialiteTrouvee} disponible à San Pedro.`);
      return;
    }
    let message = `👨⚕️ **${specialiteTrouvee.charAt(0).toUpperCase() + specialiteTrouvee.slice(1)}s disponibles** :\n\n`;
    userState.listeMedecins = medecins;
    for (const [index, medecin] of medecins.entries()) {
      if (medecin.photoUrl) {
        await sendImageMessage(
          userId,
          medecin.photoUrl,
          `${index + 1}. **${medecin.nomComplet}**\n` +
          `🌟 ${medecin.anneesExperience} ans d'expérience\n` +
          `🏥 **Clinique** : ${medecin.centreSanteNom || 'Non spécifiée'}`
        );
      }
      message += `${index + 1}. **${medecin.nomComplet}**\n`;
      message += `   🌟 ${medecin.anneesExperience} ans d'expérience\n`;
      message += `   🏥 Clinique : ${medecin.centreSanteNom || 'Non spécifiée'}\n\n`;
    }
    message += "Pour choisir un médecin, répondez avec son numéro.\nExemple : 1";
    await sendTextMessage(userId, message);
    userState.step = "ATTENTE_SELECTION_MEDECIN";
    userStates.set(userId, userState);
    return;
  }

  // Recherche de médicament
  if (texteLower.includes("cherche") || texteLower.includes("médicament") || texteLower.includes("paracétamol")) {
    const nomMedicament = texteLower.split("cherche")[1]?.trim() || texteLower;
    await afficherMedicamentsFiltres(userId, nomMedicament);
    userState.step = "ATTENTE_RECHERCHE_MEDICAMENT";
    userStates.set(userId, userState);
    return;
  }

  // Utiliser Groq pour comprendre l'intention
  const groqResponse = await getGroqAIResponse(texte);
  await analyserReponseGroq(userId, texte, groqResponse, userState);
}

async function handleDemandeSoutien(userId, texte, userState) {
  const groqResponse = await getGroqAIResponse(texte);
  await sendTextMessage(userId, groqResponse);

  const texteLower = texte.toLowerCase();
  if (texteLower.includes("stress") || texteLower.includes("anxiété") || texteLower.includes("déprimé")) {
    await sendTextMessage(
      userId,
      "💙 **Ressources à San Pedro** :\n" +
      "Si vous souhaitez parler à un professionnel, voici des cliniques avec des psychologues :\n" +
      "1. **Clinique Pasteur** – ☎ +225 07 07 07 07 07\n" +
      "2. **Centre de Santé Mental** – ☎ +225 01 23 45 67 89\n\n" +
      "Souhaitez-vous que je vous aide à prendre rendez-vous ? (OUI/NON)"
    );
  } else if (texteLower.includes("poids") || texteLower.includes("alimentation") || texteLower.includes("nutrition")) {
    await sendTextMessage(
      userId,
      "🍏 **Conseil nutritionnel** :\n" +
      "Pour un suivi personnalisé, voici des nutritionnistes à San Pedro :\n" +
      "1. **Dr. Aka (Nutritionniste)** – Clinique Pasteur – ☎ +225 07 07 07 07 07\n" +
      "2. **Mme Koffi (Diététicienne)** – Centre Bien-Être – ☎ +225 02 34 56 78 90\n\n" +
      "Souhaitez-vous que je vous aide à prendre rendez-vous ? (OUI/NON)"
    );
  }
}

async function demanderDateHeureRendezVous(userId, medecinNom, cliniqueNom) {
  await sendTextMessage(
    userId,
    `📅 **Choisissez une date et une heure pour votre rendez-vous avec ${medecinNom}**\n\n` +
    `Veuillez indiquer la **date** (ex: *25/12/2025*) et l'**heure** (ex: *14:30*) de votre choix.\n` +
    `📝 **Format attendu** : *JJ/MM/AAAA HH:MM*\n` +
    `Exemple : *25/12/2025 14:30*`
  );
}

async function confirmerRendezVous(userId, userState) {
  let message = `🔍 **Confirmation de votre rendez-vous** :\n\n`;
  message += `👨⚕️ **Médecin** : ${userState.medecinNom}\n`;
  message += `🏥 **Clinique** : ${userState.cliniqueNom}\n`;
  message += `📅 **Date/Heure** : ${userState.dateRendezVous.toLocaleString('fr-FR')}\n\n`;
  message += `Pour **confirmer**, répondez : *OUI*\n`;
  message += `Pour **annuler**, répondez : *NON*.`;
  await sendTextMessage(userId, message);
  userState.step = "ATTENTE_CONFIRMATION_RENDEZ_VOUS";
  userStates.set(userId, userState);
}

async function finaliserRendezVous(userId, userState) {
  const result = await creerRendezVous(
    userState.cliniqueId,
    userState.medecinId,
    null,
    userState.nom || "Client Pillbox",
    userId,
    userState.dateRendezVous,
    "Rendez-vous pris via WhatsApp"
  );
  if (result.success) {
    await sendTextMessage(
      userId,
      `✅ **Rendez-vous confirmé !** 🎉\n\n` +
      `📝 **ID Rendez-vous** : #${result.rendezVousId.substring(0, 8)}\n` +
      `👨⚕️ **Médecin** : ${userState.medecinNom}\n` +
      `🏥 **Clinique** : ${userState.cliniqueNom}\n` +
      `📅 **Date/Heure** : ${userState.dateRendezVous.toLocaleString('fr-FR')}\n\n` +
      `🔔 **Un rappel vous sera envoyé 24h avant le rendez-vous.**`
    );
  } else {
    await sendTextMessage(userId, `❌ **Erreur** : ${result.message}`);
  }
  userState.step = "MENU_PRINCIPAL";
  userStates.set(userId, userState);
}

async function envoyerMessageBienvenue(userId, userState) {
  await sendTextMessage(
    userId,
    `💊 **Bonjour !** Je suis Mia, votre assistante Pillbox. 🤖\n\n` +
    `Je suis là pour vous aider à :\n` +
    `- Commander des médicaments (avec ou sans ordonnance)\n` +
    `- Trouver des pharmacies de garde 24h/24\n` +
    `- Prendre des rendez-vous médicaux\n` +
    `- Obtenir des conseils \n\n` +
    `✨ **Exemples de demandes :**\n` +
    `- "Je cherche du paracétamol 500mg"\n` +
    `- "Prendre un rendez-vous avec un dermatologue"\n` +
    `- "Je me sens stressé, que faire ?"\n` +
    `- "Je veux perdre du poids, des conseils ?"\n\n` +
    `⚠️ **Important :**\n` +
    `- Ce service ne remplace pas un avis médical\n` +
    `- En cas d’urgence, contactez le support client\n\n` +
    `Par quoi commençons-nous aujourd’hui ?`
  );
  userState.initialized = true;
  userStates.set(userId, userState);
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
    let userState = userStates.get(from) || { ...DEFAULT_STATE, nom: "Client Pillbox" };

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
          "✅ **Ordonnance reçue !**\n\n" +
          "Votre ordonnance a été envoyée à la pharmacie pour validation.\n" +
          "Vous recevrez une confirmation sous peu."
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
    await sendTextMessage(from, "❌ Option non reconnue. Retour au menu principal.");
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
💊 Service: Commandes médicaments & Rendez-vous San Pedro
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
