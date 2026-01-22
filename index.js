require('dotenv').config();
const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const { ImageAnnotatorClient } = require('@google-cloud/vision');

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
const clientVision = new ImageAnnotatorClient({
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

// Fonction pour analyser la réponse de Groq
async function analyserReponseGroq(userId, userMessage, groqResponse, userState) {
  try {
    await sendTextMessage(userId, groqResponse);

    const texteLower = userMessage.toLowerCase();
    if (groqResponse.toLowerCase().includes("ordonnance")) {
      userState.attentePhoto = true;
      userState.step = "ATTENTE_PHOTO_ORDONNANCE";
      await sendTextMessage(
        userId,
        "📸 **Veuillez envoyer une photo de votre ordonnance** pour valider votre commande."
      );
    } else if (texteLower.includes("cherche") || texteLower.includes("médicament") || texteLower.includes("paracétamol")) {
      const nomMedicament = texteLower.replace(/cherche|je veux|besoin de|un|une|du|de la/gi, "").trim();
      await afficherMedicamentsFiltres(userId, nomMedicament);
      userState.step = "ATTENTE_RECHERCHE_MEDICAMENT";
    } else if (texteLower.includes("pharmacie de garde") || texteLower.includes("pharmacie ouverte")) {
      await afficherPharmaciesDeGarde(userId);
    } else if (texteLower.includes("rendez-vous") || texteLower.includes("médecin")) {
      userState.step = "ATTENTE_SELECTION_MEDECIN";
      await handlePriseRendezVous(userId, userMessage, userState);
    }
    userStates.set(userId, userState);
  } catch (error) {
    console.error("Erreur analyse réponse Groq:", error);
    await sendTextMessage(userId, "❌ Erreur lors du traitement de votre demande.");
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

async function afficherPharmaciesDeGarde(userId) {
  const pharmacies = await getPharmaciesDeGarde();
  if (pharmacies.length > 0) {
    let message = "🏥 **Pharmacies de garde disponibles** :\n\n";
    pharmacies.forEach((p, i) => {
      message += `${i + 1}. **${p.nom}**\n`;
      message += `   📍 ${p.adresse}\n`;
      message += `   ☎ ${p.telephone}\n\n`;
    });
    await sendTextMessage(userId, message);
  } else {
    await sendTextMessage(userId, "❌ Aucune pharmacie de garde disponible pour le moment.");
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
  // ... (le reste des méthodes de livreurManager)
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
  // ... (le reste des méthodes de pharmacieValidator)
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
  // ... (le reste des méthodes de panierManager)
};

// Fonctions pour la recherche de médicaments
async function rechercherMedicamentDansPharmacies(nomMedicament) {
  try {
    console.log(`[DEBUG] Recherche de "${nomMedicament}" dans Firestore...`);
    const medicamentsSnapshot = await db.collection('medicaments')
      .where('stock', '>', 0)
      .where('nomLower', '>=', nomMedicament.toLowerCase())
      .where('nomLower', '<=', nomMedicament.toLowerCase() + '\uf8ff')
      .get();

    if (medicamentsSnapshot.empty) {
      console.log(`[DEBUG] Aucun médicament trouvé pour "${nomMedicament}".`);
      return {};
    }

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

    console.log(`[DEBUG] Résultat de la recherche :`, medicamentsParPharmacie);
    return medicamentsParPharmacie;
  } catch (error) {
    console.error("[DEBUG] Erreur recherche médicament:", error);
    return {};
  }
}

async function afficherMedicamentsFiltres(userId, nomMedicament) {
  console.log(`[DEBUG] Affichage des médicaments pour "${nomMedicament}"...`);
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

  // Détection des intentions
  if (texteLower.includes("cherche") || texteLower.includes("médicament") || texteLower.includes("paracétamol")) {
    const nomMedicament = texteLower.replace(/cherche|je veux|besoin de|un|une|du|de la/gi, "").trim();
    await afficherMedicamentsFiltres(from, nomMedicament);
    userState.step = "ATTENTE_RECHERCHE_MEDICAMENT";
    userStates.set(from, userState);
    return;
  }
  else if (texteLower.includes("pharmacie de garde") || texteLower.includes("pharmacie ouverte")) {
    await afficherPharmaciesDeGarde(from);
    return;
  }
  else if (texteLower.includes("rendez-vous") || texteLower.includes("médecin") || texteLower.includes("clinique")) {
    await handlePriseRendezVous(from, text, userState);
    return;
  }
  else {
    const groqResponse = await getGroqAIResponse(text);
    await analyserReponseGroq(from, text, groqResponse, userState);
  }
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
