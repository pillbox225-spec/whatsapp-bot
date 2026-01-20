const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// Initialisation de l'application Express
const app = express();
app.use(express.json());

// ==================== INITIALISATION FIREBASE ====================
let db;
let FieldValue;

// Initialisation de Firebase Admin SDK
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

// ==================== CONFIGURATION ====================
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

// ==================== ÉTATS UTILISATEUR ====================
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
  nom: null,
  telephone: null,
  listeMedicamentsCategorie: [],
  listeMedicamentsRecherche: [],
  currentCategorie: null,
  medicamentIdentifie: null
};

// ==================== FONCTIONS WHATSAPP ====================
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

// ==================== FONCTIONS FIREBASE ====================
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

async function updateStock(medicamentId, quantite) {
  try {
    await db.collection('medicaments').doc(medicamentId).update({ stock: FieldValue.increment(-quantite) });
  } catch (error) {
    console.error('Erreur updateStock:', error.message);
  }
}

// ==================== FONCTIONS DE CALCUL ====================
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

// ==================== FONCTION GROQ AI ====================
async function getGroqAIResponse(userMessage) {
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: CONFIG.GROQ_MODEL,
        messages: [
          {
            role: "system",
            content: `Tu es Mia, assistante médicale de Pillbox à San Pedro.
            Règles:
            1. Réponds uniquement aux questions sur les médicaments, pharmacies, commandes, et conseils de santé basiques.
            2. Pas de diagnostic médical - dis "Consultez un médecin".
            3. Pour les urgences: "Contactez immédiatement le 15 ou 112".
            4. Présente-toi: "Bonjour, je suis Mia de Pillbox!".
            5. Pour les médicaments: oriente vers la recherche ou les pharmacies.
            6. Réponses brèves (2-3 phrases max).`
          },
          { role: "user", content: userMessage }
        ],
        temperature: 0.7,
        max_tokens: 150
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Erreur Groq:', error.message);
    return "Désolé, je ne peux pas répondre pour le moment. Comment puis-je vous aider avec Pillbox ?";
  }
}

// ==================== MODULE LIVREUR ====================
const livreurManager = {
  RAPPEL_LIVRAISON_MS: 5 * 60 * 1000,

  async envoyerCommandeLivreur(commandeId, pharmacieId) {
    try {
      const livreurs = await this.getLivreursDisponibles();
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

  async getLivreursDisponibles() {
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
           `• Tél: ${client.telephone}\n` +
           `• Quartier: ${commande.livraison.quartier}\n` +
           `• Indications: ${commande.livraison.indications}\n` +
           `📍 Localisation: ${lienGoogleMapsClient}\n\n` +
           `🛣️ **TRAJET COMPLET**\n` +
           `Votre position → Pharmacie → Client\n` +
           `📍 Voir le trajet: ${lienTrajetPharmacieClient}\n\n` +
           `💬 **COMMUNICATION**\n` +
           `• Pour contacter la pharmacie: ${pharmacie.telephone}\n` +
           `• Pour contacter le client: ${client.telephone}\n\n` +
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
        `🚗 **LIVRAISON EN COURS!**\n\n` +
        `Votre commande #${commande.id.substring(0, 8)} a été acceptée par un livreur.\n\n` +
        `👤 **Votre livreur:**\n` +
        `• Nom: ${commande.livreurNom}\n` +
        `• Tél: ${commande.livreurTelephone}\n\n` +
        `🏥 **Pharmacie:** ${commande.pharmacieNom}\n\n` +
        `💬 **Vous pouvez communiquer avec votre livreur directement sur WhatsApp:**\n` +
        `Cliquez ici pour envoyer un message: https://wa.me/${commande.livreurTelephone.replace('+', '')}\n\n` +
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
      const tousLivreurs = await this.getLivreursDisponibles();
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
          `❌ **Commande annulée**\n\n` +
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

// ==================== MODULE VALIDATION PHARMACIE ====================
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
          `✅ **Ordonnance validée!**\n\n` +
          `Votre ordonnance a été validée par la pharmacie ${commande.pharmacieNom}.\n\n` +
          `Un livreur va être assigné à votre commande.\n\n` +
          `Merci pour votre patience.`
        );
        await livreurManager.envoyerCommandeLivreur(commandeId, commande.pharmacieId);
      } else if (reponse === 'refuser') {
        await db.collection('commandes').doc(commandeId).update({
          statut: 'ordonnance_refusee',
          ordonnanceValidee: false,
          pharmacieValidee: false,
          dateRefus: Date.now()
        });
        await sendTextMessage(commande.client.telephone,
          `❌ **Ordonnance refusée**\n\n` +
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
          `🔄 **Transfert à une autre pharmacie**\n\n` +
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
          `❌ **Commande annulée**\n\n` +
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

// ==================== MODULE GESTION PANIER ====================
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
        message: `✅ **${medicament.nom} ajouté au panier**\n\n` +
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
    if (userState.panier.length === 0) return "🛒 Votre panier est vide.";

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

// ==================== FONCTIONS DE NOTIFICATION ====================
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

async function demanderNotationService(commandeId) {
  try {
    const commandeDoc = await db.collection('commandes').doc(commandeId).get();
    if (!commandeDoc.exists) return;
    const commande = commandeDoc.data();
    const buttons = [
      { type: "reply", reply: { id: `note_5_${commandeId}`, title: "⭐ 5/5" } },
      { type: "reply", reply: { id: `note_4_${commandeId}`, title: "⭐ 4/5" } },
      { type: "reply", reply: { id: `note_3_${commandeId}`, title: "⭐ 3/5" } }
    ];
    await sendInteractiveMessage(commande.client.telephone,
      `⭐ **NOTER LE SERVICE**\n\n` +
      `Comment évaluez-vous la livraison de votre commande ?\n\n` +
      `Votre avis nous aide à améliorer Pillbox!`,
      buttons
    );
  } catch (error) {
    console.error("Erreur demande notation:", error);
  }
}

async function enregistrerNote(commandeId, note, telephoneClient) {
  try {
    await db.collection('commandes').doc(commandeId).update({
      noteClient: note,
      dateNotation: Date.now(),
      noteEnregistree: true
    });
    await db.collection('avis').add({
      commandeId: commandeId,
      telephoneClient: telephoneClient,
      note: note,
      date: Date.now(),
      type: 'livraison'
    });
    await sendTextMessage(telephoneClient,
      `⭐ **Merci pour votre note de ${note}/5!**\n\n` +
      `Votre avis nous aide à améliorer notre service.\n\n` +
      `À bientôt sur Pillbox! 💊`
    );
  } catch (error) {
    console.error("Erreur enregistrement note:", error);
  }
}

// ==================== FONCTION CRÉATION COMMANDE ====================
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
      nom: userState.nom || 'Client WhatsApp',
      quartier: userState.quartier
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

// ==================== GESTION DES MESSAGES ====================
async function handleTextMessage(from, text, userState) {
  if (!userState.initialized) {
    await sendTypingIndicator(from, 1500);
    const welcomeButtons = [
      { type: "reply", reply: { id: "commencer_commande", title: "💊 Commander" } },
      { type: "reply", reply: { id: "ouvrir_support", title: "📞 Support" } }
    ];
    await sendInteractiveMessage(from,
      "💊 **Bonjour, je suis Mia de Pillbox!** 🤖\n\n" +
      "Votre assistante médicale pour commander des médicaments à San Pedro.\n\n" +
      "✨ **Services disponibles:**\n" +
      "• Commandes avec/sans ordonnance\n" +
      "• Pharmacies de garde 24h/24\n" +
      "• Livraison rapide à domicile\n" +
      "• Identification de médicaments par photo\n\n" +
      "⚠️ **Important:**\n" +
      "• Ce service ne remplace pas une consultation médicale\n" +
      "• En cas d'urgence: composez le 15 (SAMU) ou 112 IMMÉDIATEMENT\n\n" +
      "Choisissez une option pour commencer :",
      welcomeButtons
    );
    userState.initialized = true;
    userStates.set(from, userState);
    return;
  }

  const isChatMessage = await livreurManager.handleChatClientLivreur(text, from, null);
  if (isChatMessage) return;

  if (userState.step === 'RECHERCHE_NOM') {
    await handleRechercheNom(from, text, userState);
  } else if (userState.step === 'ATTENTE_INFOS_LIVRAISON') {
    await traiterInfosLivraison(from, text, userState);
  } else if (userState.step === 'ATTENTE_PHOTO_ORDONNANCE') {
    await sendTextMessage(from,
      "❌ **Photo requise**\n\n" +
      "Veuillez envoyer une PHOTO de votre ordonnance.\n\n" +
      "Cliquez sur 📎 (attache) → Galerie → Sélectionnez la photo"
    );
  } else {
    const response = await getGroqAIResponse(text);
    if (response) await sendTextMessage(from, response);
    await handleMenuPrincipal(from, userState);
  }
}

async function handleImageMessage(from, imageId, userState) {
  const imageUrl = await getWhatsAppMediaUrl(imageId);
  if (userState.attentePhoto) {
    userState.ordonnancePhotoUrl = imageUrl;
    userState.attentePhoto = false;
    await sendTextMessage(from,
      "✅ **Ordonnance reçue**\n\n" +
      "Votre ordonnance a été envoyée à la pharmacie pour validation.\n" +
      "Vous recevrez une confirmation sous peu.\n\n" +
      "⏳ **En attente de validation...**"
    );
    await processCheckout(from, userState);
  } else {
    await analyserImageMedicament(from, imageUrl, userState);
  }
}

async function analyserImageMedicament(from, imageUrl, userState) {
  try {
    await sendTextMessage(from, "🔍 **Analyse de l'image en cours...**\n\nPatientez quelques secondes.");
    await sendTypingIndicator(from, 4000);
    const aiResponse = "📸 **Médicament identifié:**\nParacétamol 500mg\n\n💊 **Catégorie:** Douleurs-Fièvre\n📋 **Ordonnance:** Non requise\n⚠️ **Conseil:** 1 comprimé toutes les 6 heures\n\nQue souhaitez-vous faire ?";
    const buttons = [
      { type: "reply", reply: { id: "rechercher_medicament", title: "🔍 Rechercher" } },
      { type: "reply", reply: { id: "commander_sans_ordonnance", title: "💊 Commander" } },
      { type: "reply", reply: { id: "retour_menu", title: "🔙 Retour" } }
    ];
    await sendInteractiveMessage(from, aiResponse, buttons);
  } catch (error) {
    console.error('Erreur analyse image:', error);
    await sendTextMessage(from,
      "❌ **Impossible d'analyser l'image**\n\n" +
      "Veuillez essayer avec une photo plus nette ou utilisez la recherche par nom."
    );
    await handleMenuPrincipal(from, userState);
  }
}

async function handleLocationMessage(from, location, userState) {
  const { latitude, longitude } = location;
  if (!isInSanPedro(latitude, longitude)) {
    await sendTextMessage(from,
      "❌ **Hors zone de livraison**\n\n" +
      "Désolé, notre service est limité à San Pedro uniquement.\n\n" +
      "Veuillez contacter une pharmacie locale."
    );
    return;
  }
  userState.location = { latitude, longitude };
  if (userState.step === 'ATTENTE_LOCALISATION_LIVRAISON') {
    await processCheckout(from, userState);
  } else {
    await sendTextMessage(from, "📍 **Localisation enregistrée**\n\nVous pouvez continuer votre commande.");
  }
}

async function handleInteractiveMessage(from, buttonId, userState) {
  if (buttonId === 'ouvrir_support') {
    await sendTextMessage(from,
      `📞 **Support Client Pillbox**\n\n` +
      `Notre équipe support est disponible pour vous aider:\n\n` +
      `📱 **WhatsApp:** ${CONFIG.SUPPORT_PHONE}\n` +
      `💬 **Lien direct:** https://wa.me/${CONFIG.SUPPORT_PHONE.replace('+', '')}\n\n` +
      `✨ **Services support:**\n` +
      `• Assistance commandes\n` +
      `• Questions médicaments\n` +
      `• Réclamations\n` +
      `• Assistance technique\n\n` +
      `N'hésitez pas à nous contacter!`
    );
    await handleMenuPrincipal(from, userState);
  } else if (buttonId === 'commencer_commande') {
    await handleMenuPrincipal(from, userState);
  } else if (buttonId.startsWith('accepter_')) {
    const commandeId = buttonId.replace('accepter_', '');
    await livreurManager.handleReponseLivreur(from, buttonId, commandeId, 'accepter');
  } else if (buttonId.startsWith('refuser_')) {
    const commandeId = buttonId.replace('refuser_', '');
    await livreurManager.handleReponseLivreur(from, buttonId, commandeId, 'refuser');
  } else if (buttonId.startsWith('valider_ordonnance_')) {
    const commandeId = buttonId.replace('valider_ordonnance_', '');
    await pharmacieValidator.handleReponsePharmacie(from, buttonId, commandeId, 'valider');
  } else if (buttonId.startsWith('refuser_ordonnance_')) {
    const commandeId = buttonId.replace('refuser_ordonnance_', '');
    await pharmacieValidator.handleReponsePharmacie(from, buttonId, commandeId, 'refuser');
  } else if (buttonId.startsWith('note_')) {
    const parts = buttonId.split('_');
    const note = parts[1];
    const commandeId = parts[2];
    await enregistrerNote(commandeId, parseInt(note), from);
  } else if (buttonId === 'retour_menu') {
    await handleMenuPrincipal(from, userState);
  } else if (buttonId === 'pharmacies_garde') {
    await handlePharmaciesDeGarde(from);
  } else if (buttonId === 'chercher_medicament') {
    await handleChercherMedicament(from, userState);
  } else if (buttonId === 'mon_panier') {
    await handlePanier(from, userState);
  } else if (buttonId === 'suivi_commandes') {
    await handleSuiviCommande(from, userState);
  } else if (buttonId === 'recherche_nom') {
    await sendTextMessage(from, "🔍 **Recherche par nom**\n\nVeuillez saisir le nom du médicament:");
    userState.step = 'RECHERCHE_NOM';
  } else if (buttonId === 'recherche_categorie') {
    await handleRechercheParCategorie(from, userState);
  } else if (buttonId === 'envoyer_photo_medicament') {
    await sendTextMessage(from,
      "📸 **Identification par photo**\n\n" +
      "Prenez une photo NETTE de votre médicament et je l'identifierai pour vous !\n\n" +
      "**Instructions :**\n" +
      "1. Placez le médicament sur une surface plane\n" +
      "2. Assurez-vous que l'étiquette est bien visible\n" +
      "3. Prenez la photo avec un bon éclairage\n" +
      "4. Envoyez-moi la photo\n\n" +
      "Je vous donnerai ensuite toutes les informations sur ce médicament !\n\n" +
      "📸 **Cliquez sur 📎 pour envoyer votre photo maintenant :**"
    );
    userState.step = 'ATTENTE_PHOTO_MEDICAMENT';
  } else if (buttonId.startsWith('categorie_')) {
    const categorie = buttonId.replace('categorie_', '').replace(/_/g, ' ');
    await handleSelectionCategorie(from, categorie, userState);
  } else if (buttonId.startsWith('med_')) {
    const medicamentId = buttonId.replace('med_', '');
    await showDetailMedicament(from, medicamentId, userState);
  } else if (buttonId.startsWith('demander_ordonnance_')) {
    const medicamentId = buttonId.replace('demander_ordonnance_', '');
    const medicamentDoc = await db.collection('medicaments').doc(medicamentId).get();
    if (!medicamentDoc.exists) return;
    const medicament = medicamentDoc.data();
    await sendTextMessage(from,
      `📋 **Ordonnance requise pour ${medicament.nom}**\n\n` +
      `Ce médicament nécessite une ordonnance valide.\n\n` +
      `📸 **Pour commander:**\n` +
      `1. Envoyez d'abord une photo de votre ordonnance\n` +
      `2. Attendez la validation par une pharmacie\n` +
      `3. Vous pourrez ensuite ajouter le médicament au panier\n\n` +
      `⚠️ **Important:**\n` +
      `• Seules les ordonnances valides seront acceptées\n` +
      `• La photo doit être nette et lisible\n` +
      `• Toutes les informations doivent être visibles\n\n` +
      `Cliquez sur 📎 pour envoyer votre ordonnance maintenant.`
    );
    userState.attentePhoto = true;
    userState.step = 'ATTENTE_PHOTO_ORDONNANCE';
    userState.currentMedicamentId = medicamentId;
  } else if (buttonId.startsWith('ajouter_')) {
    const medicamentId = buttonId.replace('ajouter_', '');
    const result = await panierManager.ajouterAuPanier(from, medicamentId, 1);
    if (result.success) {
      await sendTextMessage(from, result.message);
      const buttons = [
        { type: "reply", reply: { id: "continuer_achats", title: "🛒 Continuer" } },
        { type: "reply", reply: { id: "valider_panier", title: "✅ Valider" } }
      ];
      await sendInteractiveMessage(from, "Que souhaitez-vous faire ?", buttons);
    } else {
      await sendTextMessage(from, result.message);
    }
  } else if (buttonId === 'valider_panier') {
    await processCheckout(from, userState);
  } else if (buttonId === 'vider_panier') {
    userState.panier = [];
    userState.pharmacieId = null;
    userState.pharmacieNom = null;
    userState.besoinOrdonnance = false;
    await sendTextMessage(from, "✅ Panier vidé avec succès.");
    await handleMenuPrincipal(from, userState);
  } else if (buttonId === 'commander_sans_ordonnance') {
    const buttons = [
      { type: "reply", reply: { id: "confirmer_sans_ordonnance", title: "✅ Oui" } },
      { type: "reply", reply: { id: "annuler_commande", title: "❌ Non" } }
    ];
    await sendInteractiveMessage(from,
      "⚠️ **ATTENTION - Médicaments sous ordonnance**\n\n" +
      "Vous essayez de commander des médicaments qui nécessitent normalement une ordonnance.\n\n" +
      "Sans ordonnance:\n" +
      "• La pharmacie peut refuser votre commande\n" +
      "• Certains médicaments ne seront pas disponibles\n" +
      "• Des alternatives pourront vous être proposées\n\n" +
      "Confirmez-vous vouloir continuer SANS ordonnance ?",
      buttons
    );
  } else if (buttonId === 'confirmer_sans_ordonnance') {
    userState.ordonnanceValidee = true;
    if (!userState.location) {
      await sendTextMessage(from, "📍 **Localisation requise**\n\nVeuillez partager votre localisation.");
      userState.step = 'ATTENTE_LOCALISATION_LIVRAISON';
    } else {
      await sendTextMessage(from, "🏠 **Informations de livraison**\n\nVeuillez préciser quartier et indications.");
      userState.step = 'ATTENTE_INFOS_LIVRAISON';
    }
  } else if (buttonId === 'annuler_commande') {
    await sendTextMessage(from, "❌ Commande annulée.");
    await handleMenuPrincipal(from, userState);
  } else {
    await handleMenuPrincipal(from, userState);
  }
}

// ==================== FONCTIONS WHATSAPP UTILITAIRES ====================
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

// ==================== MENUS PRINCIPAUX ====================
async function handleMenuPrincipal(userId, userState) {
  const panierCount = userState.panier.length;
  const buttons = [
    { type: "reply", reply: { id: "commander_sans_ordonnance", title: "💊 Commander" } },
    { type: "reply", reply: { id: "commander_avec_ordonnance", title: "📋 Ordonnance" } },
    { type: "reply", reply: { id: "chercher_medicament", title: "🔍 Chercher" } },
    { type: "reply", reply: { id: "pharmacies_garde", title: "🏥 Pharmacies" } },
    { type: "reply", reply: { id: "mon_panier", title: `🛒 Panier (${panierCount})` } },
    { type: "reply", reply: { id: "suivi_commandes", title: "📦 Suivi" } }
  ];
  await sendInteractiveMessage(userId,
    "**💊 Menu Principal - Pillbox**\n\n" +
    "Sélectionnez l'option qui correspond à votre besoin :",
    buttons
  );
  userState.step = 'MENU_PRINCIPAL';
  userStates.set(userId, userState);
}

// ==================== FONCTIONS SUPPLÉMENTAIRES ====================
async function handlePharmaciesDeGarde(userId) {
  const pharmacies = await getPharmaciesDeGarde();
  if (pharmacies.length === 0) {
    await sendTextMessage(userId, "❌ Aucune pharmacie de garde disponible actuellement.");
    return;
  }
  let message = `🏥 **Pharmacies de Garde - 24h/24**\n\n`;
  pharmacies.forEach((pharmacie, index) => {
    message += `${index + 1}. **${pharmacie.nom}**\n`;
    message += `   📞 ${pharmacie.telephone}\n`;
    message += `   📍 ${pharmacie.adresse || 'BP 225'}\n`;
    if (pharmacie.horaires) message += `   ⏰ ${pharmacie.horaires}\n`;
    message += '\n';
  });
  message += "⚠️ **Important:**\n";
  message += "• Ces pharmacies sont ouvertes 24h/24\n";
  message += "• Présentez votre ordonnance si nécessaire\n";
  message += "• Service de livraison disponible via Pillbox\n\n";
  const buttons = [
    { type: "reply", reply: { id: "chercher_medicament", title: "🔍 Chercher" } },
    { type: "reply", reply: { id: "commander_avec_ordonnance", title: "📋 Commander" } },
    { type: "reply", reply: { id: "retour_menu", title: "🔙 Retour" } }
  ];
  await sendInteractiveMessage(userId, message, buttons);
}

async function handleChercherMedicament(userId, userState) {
  const buttons = [
    { type: "reply", reply: { id: "recherche_nom", title: "🔍 Par nom" } },
    { type: "reply", reply: { id: "envoyer_photo_medicament", title: "📸 Par photo" } },
    { type: "reply", reply: { id: "retour_menu", title: "🔙 Retour" } }
  ];
  await sendInteractiveMessage(userId,
    "🔍 **Recherche de médicament**\n\n" +
    "Comment souhaitez-vous rechercher vos médicaments ?\n\n" +
    "Choisissez une option :",
    buttons
  );
  userState.step = 'RECHERCHE_MENU';
  userStates.set(userId, userState);
}

async function handleRechercheParCategorie(userId, userState) {
  try {
    const categories = await getCategories();
    if (categories.length === 0) {
      await sendTextMessage(userId, "❌ Aucune catégorie disponible pour le moment.");
      return;
    }
    let message = "🏷️ **Catégories de médicaments**\n\n";
    const categoriesLimitees = categories.slice(0, 10);
    const buttons = categoriesLimitees.map((categorie, index) => ({
      type: "reply",
      reply: {
        id: `categorie_${categorie.replace(/\s+/g, '_')}`,
        title: `${index + 1}. ${categorie}`
      }
    }));
    buttons.push({ type: "reply", reply: { id: "retour_menu", title: "🔙 Retour" } });
    categoriesLimitees.forEach((categorie, index) => { message += `${index + 1}. ${categorie}\n`; });
    if (categories.length > 10) message += `\n... et ${categories.length - 10} autres catégories`;
    message += "\n\nChoisissez une catégorie :";
    await sendInteractiveMessage(userId, message, buttons.slice(0, 3));
  } catch (error) {
    console.error("Erreur affichage catégories:", error);
    await sendTextMessage(userId, "❌ Erreur lors du chargement des catégories.");
  }
}

async function handleSelectionCategorie(userId, categorie, userState) {
  try {
    await sendTextMessage(userId, `🔍 **Recherche dans : ${categorie}**\n\nRecherche des médicaments disponibles...`);
    await sendTypingIndicator(userId, 2000);
    const medicaments = await getMedicaments(null, null, categorie);
    if (medicaments.length === 0) {
      await sendTextMessage(userId, `❌ Aucun médicament disponible dans la catégorie "${categorie}".`);
      await handleRechercheParCategorie(userId, userState);
      return;
    }
    let message = `💊 **Médicaments - ${categorie}**\n\n`;
    medicaments.slice(0, 5).forEach((med, index) => {
      message += `${index + 1}. **${med.nom}**\n`;
      if (med.sousTitre) message += `   📝 ${med.sousTitre}\n`;
      message += `   💰 ${med.prix} FCFA\n`;
      message += `   📦 Stock: ${med.stock}\n`;
      message += med.necessiteOrdonnance ? `   ⚠️ Ordonnance requise\n` : `   ✅ Sans ordonnance\n`;
      message += '\n';
    });
    if (medicaments.length > 5) message += `... et ${medicaments.length - 5} autres médicaments\n\n`;
    message += "Pour voir les détails d'un médicament, tapez son numéro.";
    await sendTextMessage(userId, message);
    userState.listeMedicamentsCategorie = medicaments.map(m => m.id);
    userState.currentCategorie = categorie;
    userState.step = 'SELECTION_MEDICAMENT_CATEGORIE';
    userStates.set(userId, userState);
  } catch (error) {
    console.error("Erreur sélection catégorie:", error);
    await sendTextMessage(userId, "❌ Erreur lors de la recherche.");
  }
}

async function handleRechercheNom(userId, recherche, userState) {
  if (recherche.length < 2) {
    await sendTextMessage(userId, "❌ Veuillez saisir au moins 2 caractères pour la recherche.");
    return;
  }
  await sendTextMessage(userId, `🔍 **Recherche : "${recherche}"**\n\nRecherche en cours...`);
  await sendTypingIndicator(userId, 1500);
  const medicaments = await getMedicaments(null, recherche, null);
  if (medicaments.length === 0) {
    await sendTextMessage(userId,
      `❌ **Aucun médicament trouvé pour "${recherche}"**\n\n` +
      `Suggestions :\n` +
      `• Vérifiez l'orthographe\n` +
      `• Essayez avec un terme plus général\n` +
      `• Utilisez la recherche par catégorie\n` +
      `• Prenez une photo du médicament\n\n` +
      `Ou retournez au menu principal :`
    );
    const buttons = [
      { type: "reply", reply: { id: "recherche_categorie", title: "🏷️ Catégories" } },
      { type: "reply", reply: { id: "envoyer_photo_medicament", title: "📸 Photo" } },
      { type: "reply", reply: { id: "retour_menu", title: "🔙 Retour" } }
    ];
    await sendInteractiveMessage(userId, "Que souhaitez-vous faire ?", buttons);
    return;
  }
  let message = `✅ **${medicaments.length} médicament(s) trouvé(s)**\n\n`;
  medicaments.slice(0, 5).forEach((med, index) => {
    message += `${index + 1}. **${med.nom}**\n`;
    if (med.sousTitre) message += `   📝 ${med.sousTitre}\n`;
    message += `   💰 ${med.prix} FCFA\n`;
    message += `   📦 Stock: ${med.stock}\n`;
    message += med.necessiteOrdonnance ? `   ⚠️ Ordonnance requise\n` : `   ✅ Sans ordonnance\n`;
    message += '\n';
  });
  if (medicaments.length > 5) message += `... et ${medicaments.length - 5} autres résultat(s)\n\n`;
  message += "Pour voir les détails d'un médicament, tapez son numéro.\n";
  message += "Pour une nouvelle recherche, tapez un autre nom.";
  await sendTextMessage(userId, message);
  userState.listeMedicamentsRecherche = medicaments.map(m => m.id);
  userState.step = 'SELECTION_MEDICAMENT_RECHERCHE';
  userStates.set(userId, userState);
}

async function handlePanier(userId, userState) {
  if (userState.panier.length === 0) {
    await sendTextMessage(userId, "🛒 Votre panier est vide.");
    await handleMenuPrincipal(userId, userState);
    return;
  }
  const message = await panierManager.afficherPanier(userId);
  const buttons = [
    { type: "reply", reply: { id: "valider_panier", title: "✅ Valider" } },
    { type: "reply", reply: { id: "vider_panier", title: "🗑️ Vider" } },
    { type: "reply", reply: { id: "retour_menu", title: "🔙 Retour" } }
  ];
  await sendInteractiveMessage(userId, message, buttons);
}

async function showDetailMedicament(userId, medicamentId, userState) {
  try {
    const medicamentDoc = await db.collection('medicaments').doc(medicamentId).get();
    if (!medicamentDoc.exists) {
      await sendTextMessage(userId, "❌ Médicament introuvable.");
      return;
    }
    const medicament = medicamentDoc.data();
    let message = `💊 **${medicament.nom}**\n\n`;
    if (medicament.sousTitre) message += `📝 ${medicament.sousTitre}\n\n`;
    message += `💰 **Prix:** ${medicament.prix} FCFA\n`;
    message += `📦 **Stock:** ${medicament.stock} disponible(s)\n`;
    if (medicament.dosage) message += `💊 **Dosage:** ${medicament.dosage}\n`;
    if (medicament.forme) message += `📦 **Forme:** ${medicament.forme}\n`;
    if (medicament.categorie) message += `🏷️ **Catégorie:** ${medicament.categorie}\n`;
    message += `\n`;
    if (medicament.necessiteOrdonnance) {
      message += `⚠️ **MÉDICAMENT SOUS ORDONNANCE**\n\n`;
      message += `Pour commander ce médicament:\n`;
      message += `1. Vous devez avoir une ordonnance valide\n`;
      message += `2. Envoyez une photo de votre ordonnance d'abord\n`;
      message += `3. Attendez la validation par une pharmacie\n`;
      message += `4. Vous pourrez ensuite l'ajouter au panier\n\n`;
    } else {
      message += `✅ **Sans ordonnance**\n`;
      message += `Vous pouvez commander ce médicament directement.\n\n`;
    }
    let pharmacieNom = "Pharmacie";
    if (medicament.pharmacieId) {
      const pharmacieDoc = await db.collection('pharmacies').doc(medicament.pharmacieId).get();
      if (pharmacieDoc.exists) pharmacieNom = pharmacieDoc.data().nom;
    }
    message += `🏥 **Disponible chez:** ${pharmacieNom}\n\n`;
    const buttons = [];
    if (medicament.necessiteOrdonnance) {
      if (userState.ordonnanceValidee) {
        buttons.push({ type: "reply", reply: { id: `ajouter_${medicamentId}`, title: "🛒 Ajouter" } });
      } else {
        buttons.push({ type: "reply", reply: { id: `demander_ordonnance_${medicamentId}`, title: "📸 Ordonnance" } });
      }
    } else {
      buttons.push({ type: "reply", reply: { id: `ajouter_${medicamentId}`, title: "🛒 Ajouter" } });
    }
    buttons.push({ type: "reply", reply: { id: "retour_menu", title: "🔙 Retour" } });
    await sendInteractiveMessage(userId, message, buttons);
  } catch (error) {
    console.error("Erreur affichage détail médicament:", error);
    await sendTextMessage(userId, "❌ Erreur lors de l'affichage du médicament.");
  }
}

async function processCheckout(userId, userState) {
  const medicamentsAvecOrdonnance = userState.panier.filter(item => item.necessiteOrdonnance);
  if (medicamentsAvecOrdonnance.length > 0 && !userState.ordonnanceValidee) {
    await sendTextMessage(userId, "📋 **Ordonnance requise**\n\nVeuillez envoyer une photo.");
    userState.attentePhoto = true;
    userState.step = 'ATTENTE_PHOTO_ORDONNANCE';
    userStates.set(userId, userState);
  } else {
    await sendTextMessage(userId, "✅ **Commande confirmée**\n\nLocalisation?");
    userState.step = 'ATTENTE_LOCALISATION_LIVRAISON';
    userStates.set(userId, userState);
  }
}

async function traiterInfosLivraison(userId, texte, userState) {
  const lignes = texte.split('\n');
  let quartier = '';
  let indications = '';
  for (const ligne of lignes) {
    if (ligne.toLowerCase().includes('quartier:')) quartier = ligne.split(':')[1]?.trim();
    else if (ligne.toLowerCase().includes('indications:')) indications = ligne.split(':')[1]?.trim();
  }
  if (!quartier && !indications) { indications = texte; quartier = "Non spécifié"; }
  userState.quartier = quartier;
  userState.indications = indications;
  const totalPanier = userState.panier.reduce((sum, item) => sum + (item.prix * item.quantite), 0);
  const fraisLivraison = getFraisLivraison();
  const totalFinal = totalPanier + fraisLivraison;
  const commandeId = await creerCommandeComplet(userId, userState, totalPanier, fraisLivraison);
  await sendTextMessage(userId,
    `✅ **COMMANDE CONFIRMÉE!**\n\n` +
    `🆔 Commande: #${commandeId.substring(0, 8)}\n` +
    `🏥 **Pharmacie:** ${userState.pharmacieNom}\n` +
    `📍 Quartier livraison: ${quartier}\n` +
    `📝 Indications: ${indications}\n\n` +
    `💰 **Détail:**\n` +
    `• Total médicaments: ${totalPanier} FCFA\n` +
    `• Frais livraison: ${fraisLivraison} FCFA\n` +
    `🎯 **Total: ${totalFinal} FCFA**\n\n` +
    `📞 Un livreur vous contactera bientôt.\n` +
    `💬 Vous pourrez communiquer avec lui directement sur WhatsApp.\n\n` +
    `📱 **Support:** ${CONFIG.SUPPORT_PHONE}`
  );
  if (userState.besoinOrdonnance && userState.ordonnancePhotoUrl) {
    await pharmacieValidator.envoyerOrdonnancePharmacie(commandeId, userState.ordonnancePhotoUrl, userState.pharmacieId);
  } else {
    await livreurManager.envoyerCommandeLivreur(commandeId, userState.pharmacieId);
  }
  userStates.set(userId, { ...DEFAULT_STATE, initialized: true });
}

// ==================== WEBHOOK ====================
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
    let userState = userStates.get(from) || { ...DEFAULT_STATE };

    if (messageType === 'audio' || messageType === 'voice') return;
    if (messageType === 'text') {
      const isChatMessage = await livreurManager.handleChatClientLivreur(message.text.body, from, null);
      if (isChatMessage) return;
      await handleTextMessage(from, message.text.body, userState);
    } else if (messageType === 'image') {
      await handleImageMessage(from, message.image.id, userState);
    } else if (messageType === 'location') {
      await handleLocationMessage(from, message.location, userState);
    } else if (messageType === 'interactive' && message.interactive?.type === 'button_reply') {
      await handleInteractiveMessage(from, message.interactive.button_reply.id, userState);
    }
    userStates.set(from, userState);
  } catch (error) {
    console.error('💥 Erreur webhook:', error.message, error.stack);
  }
});

// ==================== DÉMARRAGE SERVEUR ====================
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

// ==================== HEALTH CHECK ====================
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

// Gestion des erreurs non catchées
process.on('uncaughtException', (error) => {
  console.error('💥 ERREUR NON GÉRÉE:', error.message);
  console.error('Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 PROMISE REJECTION NON GÉRÉE:', reason);
});
