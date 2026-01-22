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
    
    // Vérification des données
    await verifierDonneesFirestore();
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

// Salutations à détecter
const SALUTATIONS = {
  bonjour: ["bonjour", "bonsoir", "salut", "coucou", "hello", "hi", "hey", "slt"],
  merci: ["merci", "thanks", "thank you", "merci beaucoup", "merci bien"],
  aurevoir: ["au revoir", "bye", "goodbye", "à plus", "à bientôt", "ciao", "adieu"]
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
  nom: 'Client Pillbox',
  telephone: null,
  whatsapp: null,
  aJoindre: null,
  listeMedicamentsRecherche: [],
  currentCategorie: null,
  medicamentIdentifie: null,
  nomMedicamentRecherche: null,
  listeMedicamentsAvecIndex: [],
  resultatsRechercheMedicaments: null,
  listeMedecins: [],
  medecinId: null,
  medecinNom: null,
  cliniqueId: null,
  cliniqueNom: null,
  dateRendezVous: null
};

// Client Google Vision pour OCR
const clientVision = new ImageAnnotatorClient({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
});

// Prompt système pour Groq
const SYSTEM_PROMPT = `
Tu es Mia, l'assistante médicale intelligente et empathique de Pillbox à San Pedro, Côte d'Ivoire.

🎯 **TON RÔLE :**
- Comprendre et répondre en français naturel, comme un humain
- Être empathique, chaleureuse et rassurante
- Guider l'utilisateur avec des phrases simples et claires

🏙️ **ZONE DE SERVICE :**
- EXCLUSIVEMENT San Pedro, Côte d'Ivoire
- Livraison uniquement dans San Pedro
- Pharmacies et cliniques partenaires locales

💊 **SERVICES DISPONIBLES :**
1. Achat de médicaments (avec/sans ordonnance)
2. Pharmacies de garde 24h/24 à San Pedro
3. Prise de rendez-vous médicaux
4. Conseils santé généraux (sans diagnostic)
5. Informations sur nos services

🚨 **RÈGLES STRICTES :**
1. ⛔ **NE JAMAIS FAIRE DE DIAGNOSTIC**
2. 🔄 Toujours orienter vers un professionnel de santé
3. 📍 Vérifier que l'utilisateur est à San Pedro
4. 💰 Frais livraison : 400 FCFA (8h-23h) / 600 FCFA (00h-8h)
5. 🛒 Panier unique par pharmacie (pas de mélange)
6. 📞 Support client : ${CONFIG.SUPPORT_PHONE}

💡 **EXEMPLES DE RÉPONSES NATURELLES :**
- "Bonjour ! Je suis Mia, comment puis-je vous aider aujourd'hui ?"
- "Je comprends que vous cherchez du paracétamol. Je vérifie dans nos pharmacies à San Pedro..."
- "Pour la fièvre, je vous conseille de bien vous hydrater. Buvez de l'eau régulièrement."
- "Je vois que vous êtes à San Pedro, parfait ! Notre livreur pourra vous livrer."
- "Désolé, je ne peux pas mélanger des médicaments de pharmacies différentes."

🎭 **TON TON :**
- Utilise des emojis pertinents mais pas excessifs
- Sois naturellement courtoise
- Montre de l'empathie
- Pose des questions pour clarifier
- Confirme les informations importantes

⚠️ **POUR LES URGENCES :**
Réponds toujours : "Pour toute urgence médicale, contactez immédiatement le SAMU ou rendez-vous aux urgences les plus proches."

📱 **RÉPONSES COURTES :**
Maximum 3-4 phrases par message pour rester lisible sur WhatsApp.
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

// Fonction pour détecter et répondre aux salutations
function detecterEtRepondreSalutations(message) {
  const texteLower = message.toLowerCase().trim();
  
  // Détection des salutations d'arrivée
  if (SALUTATIONS.bonjour.some(salut => texteLower.includes(salut))) {
    const reponses = [
      "Bonjour ! 👋 Je suis Mia, votre assistante Pillbox. Comment puis-je vous aider aujourd'hui ?",
      "Bonjour ! 🤗 Ravie de vous rencontrer. Je suis Mia, prête à vous aider avec vos besoins médicaux.",
      "Salut ! 😊 Bienvenue chez Pillbox San Pedro. Je suis Mia, votre assistante virtuelle.",
      "Bonsoir ! 🌙 Je suis Mia, toujours disponible pour vous aider avec vos médicaments et rendez-vous."
    ];
    return reponses[Math.floor(Math.random() * reponses.length)];
  }
  
  // Détection des remerciements
  if (SALUTATIONS.merci.some(merci => texteLower.includes(merci))) {
    const reponses = [
      "Je vous en prie ! 😊 N'hésitez pas si vous avez d'autres questions.",
      "Avec plaisir ! 🤗 N'hésitez pas à me recontacter si besoin.",
      "De rien ! C'est un plaisir de vous aider. 💖",
      "Tout le plaisir est pour moi ! À votre service. 👍"
    ];
    return reponses[Math.floor(Math.random() * reponses.length)];
  }
  
  // Détection des au revoir
  if (SALUTATIONS.aurevoir.some(aurevoir => texteLower.includes(aurevoir))) {
    const reponses = [
      "Au revoir ! Prenez soin de vous. 🌟",
      "À bientôt ! N'hésitez pas à revenir si besoin. 👋",
      "Bonne journée ! Portez-vous bien. 😊",
      "À la prochaine ! Santé à vous. 💊"
    ];
    return reponses[Math.floor(Math.random() * reponses.length)];
  }
  
  return null;
}

// Fonction pour détecter l'intention de l'utilisateur
function detecterIntentionUtilisateur(message, userState) {
  const texte = message.toLowerCase();
  
  // Intentions avec leurs poids et déclencheurs
  const intentions = [
    {
      nom: "SALUTATION",
      poids: 0,
      déclencheurs: [...SALUTATIONS.bonjour, ...SALUTATIONS.merci, ...SALUTATIONS.aurevoir],
      action: "repondre_salutation"
    },
    {
      nom: "ACHAT_MEDICAMENT",
      poids: 0,
      déclencheurs: [
        "acheter", "commander", "je veux", "j'ai besoin", "donne moi", 
        "achète", "commande", "obtenir", "trouve moi", "je cherche",
        "médicament", "médoc", "pilule", "comprimé", "sirop", "gélule",
        "ordonnance", "prescription", "pharmacie", "paracétamol", "ibuprofène",
        "antibiotique", "antidouleur", "vitamine", "médical", "doliprane",
        "amoxicilline", "aspirine", "cachet", "traitement"
      ],
      action: "rechercher_medicament"
    },
    {
      nom: "PHARMACIE_GARDE",
      poids: 0,
      déclencheurs: [
        "pharmacie de garde", "pharmacie ouverte", "pharmacie nuit",
        "pharmacie 24h", "ouverte maintenant", "urgent pharmacie",
        "où trouver pharmacie", "pharmacie maintenant", "fermé",
        "quelle pharmacie ouverte", "24/24", "weekend", "dimanche",
        "nuit", "urgence", "après 18h", "tard le soir"
      ],
      action: "afficher_pharmacies_garde"
    },
    {
      nom: "RENDEZ_VOUS",
      poids: 0,
      déclencheurs: [
        "rendez-vous", "rdv", "voir médecin", "consulter", "docteur",
        "médecin", "clinique", "hôpital", "consultation", "examen",
        "spécialiste", "dermatologue", "gynécologue", "pédiatre",
        "cardiologue", "prendre rdv", "prendre rendez-vous", "visite",
        "consultation médicale", "aller chez le médecin"
      ],
      action: "prise_rendez_vous"
    },
    {
      nom: "PRIX_DISPONIBILITE",
      poids: 0,
      déclencheurs: [
        "prix", "combien coûte", "disponible", "en stock", "avoir",
        "coût", "tarif", "est-ce que vous avez", "disponibilité",
        "coûte", "vendre", "vendu", "disponible chez", "cher",
        "pas cher", "abordable", "coûtent", "quelle est le prix"
      ],
      action: "verifier_prix_stock"
    },
    {
      nom: "CONSEIL_SANTE",
      poids: 0,
      déclencheurs: [
        "conseil", "conseils", "que faire", "comment", "symptôme",
        "malade", "fièvre", "toux", "mal de tête", "douleur",
        "fatigue", "stress", "anxiété", "insomnie", "digestion",
        "nausée", "vomissement", "diarrhée", "constipation",
        "allergie", "rhume", "grippe", "covid", "masque"
      ],
      action: "donner_conseil_sante"
    },
    {
      nom: "SAN_PEDRO",
      poids: 0,
      déclencheurs: [
        "san pedro", "san-pedro", "sanpedro", "ville", "localisation",
        "où êtes-vous", "zone de livraison", "vous êtes où", "localité",
        "livrez-vous à", "dans quelle ville", "quartier", "résidence",
        "port", "centre ville", "youpougon", "abidjan", "autre ville"
      ],
      action: "confirmer_san_pedro"
    },
    {
      nom: "SUPPORT",
      poids: 0,
      déclencheurs: [
        "support", "aide", "problème", "difficulté", "contact",
        "assistance", "service client", "plainte", "réclamation",
        "téléphone", "appeler", "joindre", "urgence", "urgence médicale",
        "samu", "ambulance", "urgences", "hôpital urgence"
      ],
      action: "orienter_support"
    },
    {
      nom: "PANIER",
      poids: 0,
      déclencheurs: [
        "panier", "mon panier", "commande", "mes achats", "valider",
        "payer", "paiement", "total", "frais", "livraison", "adresse",
        "modifier", "supprimer", "ajouter", "retirer", "vider"
      ],
      action: "gerer_panier"
    }
  ];

  // Calcul des poids
  intentions.forEach(intention => {
    intention.déclencheurs.forEach(déclencheur => {
      if (texte.includes(déclencheur)) {
        intention.poids += 2;
        
        // Bonus pour les mots exacts
        if (texte === déclencheur || texte.startsWith(déclencheur + ' ') || texte.endsWith(' ' + déclencheur)) {
          intention.poids += 3;
        }
      }
    });
  });

  // Ajouter du poids selon le contexte utilisateur
  if (userState.step) {
    if (userState.step.includes("MEDICAMENT")) {
      intentions.find(i => i.nom === "ACHAT_MEDICAMENT").poids += 5;
    }
    if (userState.step.includes("RENDEZ_VOUS")) {
      intentions.find(i => i.nom === "RENDEZ_VOUS").poids += 5;
    }
    if (userState.step.includes("PANIER")) {
      intentions.find(i => i.nom === "PANIER").poids += 5;
    }
  }

  // Trouver l'intention principale
  const intentionPrincipale = intentions.reduce((max, intention) => 
    intention.poids > max.poids ? intention : max
  );

  // Seuil minimum
  if (intentionPrincipale.poids >= 2) {
    return intentionPrincipale;
  }

  return {
    nom: "INCONNU",
    poids: 0,
    action: "demander_clarification"
  };
}

// Fonction pour extraire le nom du médicament
function extraireNomMedicament(message) {
  const texteLower = message.toLowerCase();
  
  // Nettoyer le message
  const motsNettoyes = texteLower
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ');
  
  // Expressions courantes à retirer
  const expressionsARetirer = [
    "je", "veux", "voudrais", "aimerais", "cherche", "recherche",
    "besoin", "de", "du", "des", "un", "une", "des", "le", "la",
    "les", "pour", "sur", "avec", "sans", "quel", "quelle",
    "est-ce", "que", "avez", "vous", "avez-vous", "disponible",
    "prix", "combien", "coûte", "coûtent", "acheter", "commander",
    "obtenir", "trouver", "avoir", "donner", "donnez", "donne",
    "montrer", "montrez", "médicament", "médicaments", "médoc"
  ];
  
  // Filtrer les mots significatifs
  const motsSignificatifs = motsNettoyes.filter(mot => 
    mot.length > 2 && 
    !expressionsARetirer.includes(mot) &&
    !/^\d+$/.test(mot)
  );
  
  // Liste des médicaments courants avec détection flexible
  const medicamentsConnus = {
    "paracétamol": ["paracétamol", "paracetamol", "doliprane", "dafalgan", "efferalgan", "acetaminophen"],
    "ibuprofène": ["ibuprofène", "ibuprofene", "ibu", "advil", "nurofen", "brufen"],
    "amoxicilline": ["amoxicilline", "amoxicillin", "clamoxyl", "augmentin", "amox"],
    "aspirine": ["aspirine", "aspirin", "kardégic", "aspegic", "aspro"],
    "vitamine c": ["vitamine c", "vit c", "acide ascorbique", "ascorbique"],
    "antibiotique": ["antibiotique", "antibio", "anti biotique"],
    "antidouleur": ["antidouleur", "antidouleurs", "analgésique", "douleur"],
    "antifièvre": ["antifièvre", "fièvre", "contre la fièvre"],
    "contraceptif": ["contraceptif", "pilule", "contraception"],
    "antihistaminique": ["antihistaminique", "allergie", "antiallergique"],
    "cortisone": ["cortisone", "corticostéroïde"],
    "insuline": ["insuline", "diabète"]
  };
  
  // Chercher d'abord des médicaments connus
  for (const [medicamentStandard, variations] of Object.entries(medicamentsConnus)) {
    for (const variation of variations) {
      if (texteLower.includes(variation)) {
        return medicamentStandard;
      }
    }
  }
  
  // Si pas trouvé, retourner le premier mot significatif
  if (motsSignificatifs.length > 0) {
    // Essayer de trouver des combinaisons
    const combinaisons = [];
    for (let i = 0; i < motsSignificatifs.length; i++) {
      for (let j = i + 1; j <= motsSignificatifs.length; j++) {
        const combinaison = motsSignificatifs.slice(i, j).join(' ');
        if (combinaison.length > 4) {
          combinaisons.push(combinaison);
        }
      }
    }
    
    // Retourner la plus longue combinaison significative
    if (combinaisons.length > 0) {
      return combinaisons.sort((a, b) => b.length - a.length)[0];
    }
    
    return motsSignificatifs[0];
  }
  
  return null;
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
    let message = "🏥 **Pharmacies de garde disponibles à San Pedro** :\n\n";
    pharmacies.forEach((p, i) => {
      message += `${i + 1}. **${p.nom}**\n`;
      message += `   📍 ${p.adresse || 'San Pedro'}\n`;
      message += `   ☎ ${p.telephone || 'Non disponible'}\n`;
      message += `   ⏰ ${p.horaires || '24h/24'}\n\n`;
    });
    message += `📞 **Support :** ${CONFIG.SUPPORT_PHONE}`;
    await sendTextMessage(userId, message);
  } else {
    await sendTextMessage(userId, "❌ Aucune pharmacie de garde disponible pour le moment à San Pedro.");
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
  const maintenant = new Date();
  const heure = maintenant.getHours();
  const jour = maintenant.getDay();
  
  let frais = CONFIG.LIVRAISON_JOUR;
  
  // Nuit (00h-8h)
  if (heure < 8) {
    frais = CONFIG.LIVRAISON_NUIT;
  }
  // Week-end jour (samedi et dimanche 8h-23h)
  else if (jour === 0 || jour === 6) {
    frais = CONFIG.LIVRAISON_JOUR + 100;
  }
  
  return frais;
}

async function expliquerFraisLivraison(userId) {
  const maintenant = new Date();
  const heure = maintenant.getHours();
  const frais = getFraisLivraison();
  
  let explication = `💰 **Frais de livraison : ${frais} FCFA**\n\n`;
  
  if (heure < 8) {
    explication += "🌙 **Tarif nuit** (00h-8h) : 600 FCFA\n";
  } else if (heure >= 8 && heure < 23) {
    explication += "☀️ **Tarif jour** (8h-23h) : 400 FCFA\n";
    if ([0, 6].includes(maintenant.getDay())) {
      explication += "🏖️ **Majoration week-end** : +100 FCFA\n";
    }
  }
  
  explication += `\n🚚 **Service exclusif San Pedro**`;
  
  await sendTextMessage(userId, explication);
}

// Recherche de médicaments
async function rechercherMedicamentDansPharmacies(nomMedicament) {
  try {
    console.log(`[DEBUG] Recherche de "${nomMedicament}" dans toutes les pharmacies...`);

    const medicamentsSnapshot = await db.collection('medicaments').get();
    
    console.log(`[DEBUG] Total médicaments trouvés: ${medicamentsSnapshot.size}`);

    // Filtrer en mémoire
    const nomLower = nomMedicament.toLowerCase();
    const medicamentsFiltres = medicamentsSnapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(m => {
        const nomMed = m.nom || m.name || m.titre || '';
        const stockVal = m.stock || m.quantity || m.quantite || 0;
        return nomMed.toLowerCase().includes(nomLower) && stockVal > 0;
      });

    console.log(`[DEBUG] Médicaments filtrés: ${medicamentsFiltres.length}`);

    // Grouper par pharmacie
    const medicamentsParPharmacie = {};
    
    for (const medicament of medicamentsFiltres) {
      const pharmacieId = medicament.pharmacieId || medicament.pharmacyId;
      if (!pharmacieId) continue;
      
      if (!medicamentsParPharmacie[pharmacieId]) {
        medicamentsParPharmacie[pharmacieId] = {
          pharmacie: null,
          medicaments: []
        };
      }
      medicamentsParPharmacie[pharmacieId].medicaments.push(medicament);
    }

    // Récupérer les informations des pharmacies
    for (const pharmacieId in medicamentsParPharmacie) {
      try {
        const pharmacieDoc = await db.collection('pharmacies').doc(pharmacieId).get();
        if (pharmacieDoc.exists) {
          medicamentsParPharmacie[pharmacieId].pharmacie = {
            id: pharmacieDoc.id,
            ...pharmacieDoc.data()
          };
        }
      } catch (error) {
        console.error(`[DEBUG] Erreur récupération pharmacie ${pharmacieId}:`, error.message);
      }
    }

    return medicamentsParPharmacie;
  } catch (error) {
    console.error("[DEBUG] Erreur recherche médicament:", error);
    return {};
  }
}

async function afficherMedicamentsFiltres(userId, nomMedicament) {
  console.log(`[DEBUG] Affichage des médicaments pour "${nomMedicament}"...`);
  
  if (!nomMedicament || nomMedicament.trim() === '') {
    await sendTextMessage(
      userId,
      "❌ Veuillez spécifier un nom de médicament.\n" +
      "Exemple : 'paracétamol', 'ibuprofène', 'amoxicilline'"
    );
    return;
  }

  const medicamentsParPharmacie = await rechercherMedicamentDansPharmacies(nomMedicament);

  if (Object.keys(medicamentsParPharmacie).length === 0) {
    const suggestions = [
      "paracétamol", "ibuprofène", "amoxicilline", "vitamine C", 
      "antidouleur", "antibiotique", "sirop contre la toux"
    ];
    
    const suggestionAleatoire = suggestions[Math.floor(Math.random() * suggestions.length)];
    
    await sendTextMessage(
      userId,
      `🔍 **Je n'ai pas trouvé "${nomMedicament}" dans nos pharmacies partenaires à San Pedro.**\n\n` +
      `🤔 **Cela peut être dû à :**\n` +
      `• Une orthographe différente\n` +
      `• Une rupture de stock temporaire\n` +
      `• Un médicament non disponible dans notre réseau\n\n` +
      `💡 **Essayez plutôt :**\n` +
      `• Un nom générique (ex: "antidouleur")\n` +
      `• Une autre orthographe\n` +
      `• Un médicament similaire comme "${suggestionAleatoire}"\n\n` +
      `🏥 **Ou contactez directement :**\n` +
      `• Une pharmacie de garde (je peux vous donner la liste)\n` +
      `• Notre support au ${CONFIG.SUPPORT_PHONE}\n\n` +
      `🔄 **Voulez-vous rechercher autre chose ?**`
    );
    
    // Proposer des alternatives
    const buttons = [
      { type: "reply", reply: { id: "pharmacie_garde", title: "🏥 Voir pharmacies de garde" } },
      { type: "reply", reply: { id: "autre_recherche", title: "🔍 Autre recherche" } },
      { type: "reply", reply: { id: "support", title: "📞 Contacter le support" } }
    ];
    
    await sendInteractiveMessage(userId, "Que souhaitez-vous faire ?", buttons);
    
    const userState = userStates.get(userId) || { ...DEFAULT_STATE };
    userState.step = "ATTENTE_CHOIX_APRES_ECHEC";
    userStates.set(userId, userState);
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
    if (!pharmacie || medicaments.length === 0) continue;

    message += `🏥 **${pharmacie.nom || 'Pharmacie sans nom'}**\n`;
    if (pharmacie.adresse) message += `📍 ${pharmacie.adresse}\n`;
    
    for (const medicament of medicaments) {
      // Ajouter l'image si disponible
      const imageUrl = medicament.imageUrls?.[0] || medicament.imageUrl || medicament.photo;
      if (imageUrl) {
        try {
          await sendImageMessage(
            userId,
            imageUrl,
            `${indexGlobal}. **${medicament.nom || medicament.name}**\n` +
            `💰 ${medicament.prix || medicament.price || 'Prix non disponible'} FCFA\n` +
            `📦 ${medicament.stock || medicament.quantity || 0} en stock\n` +
            `${medicament.necessiteOrdonnance || medicament.requiresPrescription ? '⚠️ Ordonnance requise' : '✅ Sans ordonnance'}`
          );
        } catch (error) {
          console.error('Erreur envoi image:', error.message);
        }
      }
      
      message += `${indexGlobal}. **${medicament.nom || medicament.name}**\n`;
      message += `   💰 ${medicament.prix || medicament.price || 'Prix non disponible'} FCFA\n`;
      message += `   📦 ${medicament.stock || medicament.quantity || 0} en stock\n`;
      message += `   ${medicament.necessiteOrdonnance || medicament.requiresPrescription ? '⚠️ Ordonnance requise' : '✅ Sans ordonnance'}\n\n`;
      
      medicamentsAvecIndex.push({
        index: indexGlobal,
        pharmacieId: pharmacie.id,
        pharmacieNom: pharmacie.nom || 'Pharmacie',
        medicament: medicament
      });
      
      indexGlobal++;
    }
    message += "\n";
  }

  message += `📝 **Pour commander** :\n`;
  message += `Répondez avec le format : *COMMANDER [numéro] [quantité]*\n`;
  message += `Exemple : *COMMANDER 1 2* pour commander 2 unités du médicament n°1\n\n`;
  message += `🔍 **Pour une nouvelle recherche** :\n`;
  message += `Tapez simplement le nom d'un autre médicament.`;

  await sendTextMessage(userId, message);

  userState.listeMedicamentsAvecIndex = medicamentsAvecIndex;
  userState.step = "ATTENTE_COMMANDE_MEDICAMENT_FILTRE";
  userStates.set(userId, userState);
}

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
        { type: "reply", reply: { id: `refuer_ordonnance_${commandeId}`, title: "❌ Refuser" } }
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
          `\n5. **Indications pour trouver l'emplacement**` +
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

// Fonctions de gestion des intentions
async function gererIntention(userId, message, intention, userState) {
  try {
    switch (intention.action) {
      case "repondre_salutation":
        const reponse = detecterEtRepondreSalutations(message);
        if (reponse) await sendTextMessage(userId, reponse);
        break;
        
      case "rechercher_medicament":
        await gererAchatMedicament(userId, message, userState);
        break;
        
      case "afficher_pharmacies_garde":
        await afficherPharmaciesDeGarde(userId);
        break;
        
      case "prise_rendez_vous":
        await gererRendezVous(userId, message, userState);
        break;
        
      case "verifier_prix_stock":
        await gererPrixDisponibilite(userId, message, userState);
        break;
        
      case "donner_conseil_sante":
        await donnerConseilSante(userId, message, userState);
        break;
        
      case "confirmer_san_pedro":
        await confirmerSanPedro(userId);
        break;
        
      case "orienter_support":
        await orienterSupport(userId, message);
        break;
        
      case "gerer_panier":
        await gererPanier(userId, message, userState);
        break;
        
      case "demander_clarification":
        await demanderClarification(userId, message, userState);
        break;
        
      default:
        await reponseParDefaut(userId, message);
    }
  } catch (error) {
    console.error(`Erreur dans gererIntention (${intention.nom}):`, error);
    await gererErreur(userId, error, userState);
  }
}

async function gererAchatMedicament(userId, message, userState) {
  // Extraire le nom du médicament
  const medicamentTrouve = extraireNomMedicament(message);
  
  if (medicamentTrouve) {
    // Vérifier si l'utilisateur est à San Pedro
    await sendTextMessage(
      userId,
      `💊 **Je vais vérifier "${medicamentTrouve}" dans les pharmacies de San Pedro...**\n\n` +
      `📍 **Rappel :** Notre service de livraison est exclusivement pour San Pedro.`
    );
    
    await afficherMedicamentsFiltres(userId, medicamentTrouve);
    userState.step = "ATTENTE_COMMANDE_MEDICAMENT_FILTRE";
  } else {
    // Demander plus d'informations
    await sendTextMessage(
      userId,
      `🛒 **Je comprends que vous voulez acheter un médicament !**\n\n` +
      `Pour vous aider, j'ai besoin de savoir :\n\n` +
      `1. **Quel médicament** recherchez-vous ?\n` +
      `   Ex: "paracétamol 500mg", "ibuprofène", "amoxicilline"\n\n` +
      `2. **Avez-vous une ordonnance ?**\n` +
      `   ⚠️ Certains médicaments nécessitent une ordonnance\n\n` +
      `3. **Êtes-vous à San Pedro ?**\n` +
      `   🚚 Notre livraison est disponible uniquement à San Pedro\n\n` +
      `📝 **Répondez avec le nom du médicament ou envoyez une photo de l'ordonnance.**`
    );
    userState.step = "ATTENTE_NOM_MEDICAMENT";
  }
  
  userStates.set(userId, userState);
}

async function gererRendezVous(userId, message, userState) {
  // Détecter la spécialité si mentionnée
  const specialites = [
    "dermatologue", "gynécologue", "pédiatre", "cardiologue",
    "médecin généraliste", "ophtalmologue", "dentiste",
    "psychologue", "nutritionniste", "kinésithérapeute"
  ];
  
  let specialiteTrouvee = null;
  for (const specialite of specialites) {
    if (message.toLowerCase().includes(specialite)) {
      specialiteTrouvee = specialite;
      break;
    }
  }
  
  if (specialiteTrouvee) {
    await sendTextMessage(
      userId,
      `👨⚕️ **Je cherche un ${specialiteTrouvee} à San Pedro...**\n\n` +
      `Un instant pendant que je consulte nos cliniques partenaires.`
    );
    
    const medecins = await rechercherMedecinsParSpecialite(specialiteTrouvee);
    if (medecins.length > 0) {
      // Afficher les médecins disponibles
      let messageMedecins = `✅ **${specialiteTrouvee}s disponibles à San Pedro :**\n\n`;
      userState.listeMedecins = medecins;
      
      for (const [index, medecin] of medecins.entries()) {
        messageMedecins += `${index + 1}. **${medecin.nomComplet || 'Docteur'}**\n`;
        messageMedecins += `   🏥 ${medecin.centreSanteNom || 'Clinique'}\n`;
        if (medecin.specialite) {
          messageMedecins += `   🩺 ${medecin.specialite}\n`;
        }
        messageMedecins += `\n`;
      }
      
      messageMedecins += `Pour choisir un médecin, répondez avec son numéro.\nExemple : *1*`;
      
      await sendTextMessage(userId, messageMedecins);
      userState.step = "ATTENTE_SELECTION_MEDECIN";
    } else {
      await sendTextMessage(
        userId,
        `❌ **Aucun ${specialiteTrouvee} disponible pour le moment à San Pedro.**\n\n` +
        `💡 **Suggestions :**\n` +
        `• Essayez une autre spécialité\n` +
        `• Contactez une clinique directement\n` +
        `• Réessayez plus tard`
      );
    }
  } else {
    // Demander la spécialité
    await sendTextMessage(
      userId,
      `📅 **Je peux vous aider à prendre rendez-vous à San Pedro !**\n\n` +
      `Avec quel type de **médecin** souhaitez-vous consulter ?\n\n` +
      `👨⚕️ **Exemples de spécialités :**\n` +
      `• Médecin généraliste\n` +
      `• Dermatologue\n` +
      `• Gynécologue\n` +
      `• Pédiatre\n` +
      `• Cardiologue\n` +
      `• Dentiste\n\n` +
      `📝 **Répondez avec la spécialité souhaitée.**`
    );
    userState.step = "ATTENTE_SPECIALITE_RDV";
  }
  
  userStates.set(userId, userState);
}

async function rechercherMedecinsParSpecialite(specialite) {
  try {
    const centresSante = await getCentresSante();
    const medecins = [];
    for (const centre of centresSante) {
      const medecinsCentre = await getMedecinsParClinique(centre.id);
      medecins.push(...medecinsCentre.filter(m => m.specialite && m.specialite.toLowerCase().includes(specialite.toLowerCase())));
    }
    return medecins;
  } catch (error) {
    console.error("Erreur recherche médecins par spécialité:", error);
    return [];
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

async function gererPrixDisponibilite(userId, message, userState) {
  // Essayer d'extraire un nom de médicament
  const nomMedicament = extraireNomMedicament(message);
  
  if (nomMedicament) {
    await sendTextMessage(
      userId,
      `💰 **Je vérifie le prix et la disponibilité de "${nomMedicament}" à San Pedro...**`
    );
    
    const medicamentsParPharmacie = await rechercherMedicamentDansPharmacies(nomMedicament);
    
    if (Object.keys(medicamentsParPharmacie).length > 0) {
      let messagePrix = `📊 **Prix et disponibilité pour "${nomMedicament}" :**\n\n`;
      
      for (const pharmacieId in medicamentsParPharmacie) {
        const { pharmacie, medicaments } = medicamentsParPharmacie[pharmacieId];
        if (!pharmacie || medicaments.length === 0) continue;
        
        messagePrix += `🏥 **${pharmacie.nom}**\n`;
        
        for (const medicament of medicaments) {
          messagePrix += `   💊 ${medicament.nom || medicament.name}\n`;
          messagePrix += `   💰 Prix : ${medicament.prix || medicament.price || '?'} FCFA\n`;
          messagePrix += `   📦 Stock : ${medicament.stock || medicament.quantity || 0} unités\n`;
          messagePrix += `   ${medicament.necessiteOrdonnance ? '⚠️ Ordonnance requise' : '✅ Sans ordonnance'}\n\n`;
        }
      }
      
      messagePrix += `🛒 **Pour commander :**\n`;
      messagePrix += `Répondez : *COMMANDER [numéro-pharmacie] [quantité]*\n`;
      messagePrix += `Exemple : *COMMANDER 1 2*`;
      
      await sendTextMessage(userId, messagePrix);
    } else {
      await sendTextMessage(
        userId,
        `❌ **"${nomMedicament}" n'est pas disponible pour le moment dans nos pharmacies partenaires à San Pedro.**\n\n` +
        `💡 **Suggestions :**\n` +
        `• Vérifiez l'orthographe\n` +
        `• Essayez un médicament similaire\n` +
        `• Contactez une pharmacie de garde`
      );
    }
  } else {
    await sendTextMessage(
      userId,
      `💰 **Je peux vérifier le prix et la disponibilité d'un médicament !**\n\n` +
      `Pour quel **médicament** souhaitez-vous connaître le prix ?\n\n` +
      `💡 **Exemples :**\n` +
      `• "Quel est le prix du paracétamol ?"\n` +
      `• "Est-ce que vous avez de l'ibuprofène en stock ?"\n` +
      `• "Disponibilité amoxicilline 500mg"\n\n` +
      `📝 **Mentionnez le nom du médicament.**`
    );
  }
}

async function confirmerSanPedro(userId) {
  await sendTextMessage(
    userId,
    `📍 **Pillbox - Service exclusif San Pedro**\n\n` +
    `✅ **Oui, nous sommes à San Pedro, Côte d'Ivoire !**\n\n` +
    `🏙️ **Zone de service :**\n` +
    `• Livraison : Uniquement San Pedro\n` +
    `• Pharmacies : Partenaires locaux\n` +
    `• Cliniques : Partenaires locaux\n\n` +
    `🚚 **Livraison disponible dans :**\n` +
    `• Tous les quartiers de San Pedro\n` +
    `• 7j/7 jusqu'à 22h\n` +
    `• Frais selon la distance\n\n` +
    `💡 **Pour utiliser nos services :**\n` +
    `1. Confirmez que vous êtes à San Pedro\n` +
    `2. Dites-nous ce dont vous avez besoin\n` +
    `3. Nous organisons le reste !`
  );
}

async function donnerConseilSante(userId, message, userState) {
  // Utiliser Groq pour des conseils santé généraux
  const promptConseil = `
  L'utilisateur demande des conseils santé pour: "${message}"
  
  Donne un conseil général et empathique, mais rappelle toujours de consulter un professionnel.
  Sois rassurant mais pas alarmiste.
  Maximum 3 phrases.
  Ajoute un emoji pertinent.
  `;
  
  const conseil = await getGroqAIResponse(promptConseil);
  await sendTextMessage(userId, conseil);
  
  // Ajouter un rappel pour consulter un médecin
  await sendTextMessage(
    userId,
    "⚠️ **Rappel important :**\n" +
    "Ces conseils sont généraux. Pour un avis médical personnalisé, " +
    "consultez un médecin ou un professionnel de santé.\n\n" +
    "🏥 **Besoin d'un rendez-vous ?** Je peux vous aider à en prendre un."
  );
}

async function orienterSupport(userId, message) {
  if (message.toLowerCase().includes("urgence médicale") || 
      message.toLowerCase().includes("samu") ||
      message.toLowerCase().includes("ambulance")) {
    
    await sendTextMessage(
      userId,
      "🚨 **URGENCE MÉDICALE DÉTECTÉE** 🚨\n\n" +
      "Pour toute urgence médicale immédiate :\n\n" +
      "📞 **SAMU :** 185\n" +
      "🚑 **Ambulance :** 144\n" +
      "🏥 **Urgences les plus proches :** Hôpital Général de San Pedro\n\n" +
      "⚠️ **Ne perdez pas de temps** et contactez les services d'urgence immédiatement !"
    );
    
  } else {
    await sendTextMessage(
      userId,
      "📞 **Support client Pillbox**\n\n" +
      "Pour toute question, problème ou assistance :\n\n" +
      "👤 **Contact direct :**\n" +
      `📱 WhatsApp: ${CONFIG.SUPPORT_PHONE}\n` +
      "⏰ **Disponibilité :** 7j/7, 8h-22h\n\n" +
      "💬 **Vous pouvez aussi :**\n" +
      "• Décrire votre problème ici\n" +
      "• Envoyer une capture d'écran\n" +
      "• Donner plus de détails\n\n" +
      "Nous vous répondrons dans les plus brefs délais ! 😊"
    );
  }
}

async function gererPanier(userId, message, userState) {
  const texteLower = message.toLowerCase();
  
  if (texteLower.includes("panier") || texteLower.includes("mon panier") || texteLower.includes("voir panier")) {
    const contenuPanier = await panierManager.afficherPanier(userId);
    await sendTextMessage(userId, contenuPanier);
    
    if (userState.panier && userState.panier.length > 0) {
      const buttons = [
        { type: "reply", reply: { id: "valider_panier", title: "✅ Valider la commande" } },
        { type: "reply", reply: { id: "vider_panier", title: "🗑️ Vider le panier" } },
        { type: "reply", reply: { id: "continuer_achats", title: "🛍️ Continuer mes achats" } }
      ];
      
      await sendInteractiveMessage(
        userId,
        "Que souhaitez-vous faire avec votre panier ?",
        buttons
      );
    }
  }
  else if (texteLower.includes("vider") || texteLower.includes("supprimer")) {
    userState.panier = [];
    userState.pharmacieId = null;
    userState.pharmacieNom = null;
    userState.besoinOrdonnance = false;
    userStates.set(userId, userState);
    
    await sendTextMessage(
      userId,
      "🗑️ **Votre panier a été vidé.**\n\n" +
      "Vous pouvez maintenant ajouter des médicaments d'une nouvelle pharmacie."
    );
  }
  else if (texteLower.includes("valider") || texteLower.includes("commander") || texteLower.includes("payer")) {
    await finaliserCommande(userId, userState);
  }
}

async function demanderClarification(userId, message, userState) {
  await sendTextMessage(
    userId,
    "💬 **Pour mieux vous aider, pourriez-vous préciser ?**\n\n" +
    "Je peux vous assister pour :\n\n" +
    "💊 **Médicaments :**\n" +
    "\"Je cherche du paracétamol\"\n" +
    "\"J'ai besoin d'un antibiotique\"\n\n" +
    "🏥 **Pharmacies :**\n" +
    "\"Pharmacie de garde ouverte maintenant\"\n" +
    "\"Où trouver une pharmacie ?\"\n\n" +
    "📅 **Rendez-vous :**\n" +
    "\"Je veux voir un médecin\"\n" +
    "\"Prendre rendez-vous avec un spécialiste\"\n\n" +
    "🌿 **Conseils :**\n" +
    "\"Que faire pour la fièvre ?\"\n" +
    "\"Conseils pour le stress\"\n\n" +
    "Dites-moi simplement ce dont vous avez besoin ! 😊"
  );
}

async function reponseParDefaut(userId, message) {
  const reponsesParDefaut = [
    "Je ne suis pas sûr de comprendre. Pouvez-vous reformuler ? 🤔",
    "Désolé, je n'ai pas saisi votre demande. Pourriez-vous être plus précis ? 🧐",
    "Je suis principalement là pour vous aider avec :\n• Les médicaments 💊\n• Les pharmacies 🏥\n• Les rendez-vous 📅\n• Les conseils santé 🌿",
    "Pouvez-vous me dire si vous cherchez un médicament, une pharmacie ou un rendez-vous ? 😊"
  ];
  
  const reponseAleatoire = reponsesParDefaut[Math.floor(Math.random() * reponsesParDefaut.length)];
  
  // Essayons aussi avec Groq
  try {
    const groqResponse = await getGroqAIResponse(
      `L'utilisateur a dit: "${message}" mais je n'ai pas compris. ` +
      `Réponds de manière naturelle pour lui demander de clarifier sa demande. ` +
      `Propose des exemples de ce que je peux faire.`
    );
    
    await sendTextMessage(userId, `${reponseAleatoire}\n\n${groqResponse}`);
  } catch (error) {
    // Fallback simple
    await sendTextMessage(userId, reponseAleatoire);
  }
}

async function continuerConversation(userId, message, userState) {
  // Analyser la réponse de Groq
  const groqResponse = await getGroqAIResponse(message);
  await sendTextMessage(userId, groqResponse);
  
  // Mettre à jour l'état selon le contexte
  if (userState.step && userState.step.includes("ATTENTE")) {
    userStates.set(userId, userState);
  }
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

  // Vérifier si c'est un message de chat livreur/client
  const isChatMessage = await livreurManager.handleChatClientLivreur(text, from, null);
  if (isChatMessage) return;

  // Détecter les salutations
  const reponseSalutation = detecterEtRepondreSalutations(text);
  if (reponseSalutation) {
    await sendTextMessage(from, reponseSalutation);
    return;
  }

  // Détecter l'intention de l'utilisateur
  const intention = detecterIntentionUtilisateur(text, userState);
  console.log(`[INTENTION] ${userState.nom}: "${text}" → ${intention.nom}`);

  try {
    // Gérer selon l'intention détectée
    await gererIntention(from, text, intention, userState);
  } catch (error) {
    console.error('💥 Erreur dans handleTextMessage:', error);
    await gererErreur(from, error, userState);
  }
}

async function handleCommandeMedicamentFiltre(userId, message, userState) {
  const commandeRegex = /commander\s+(\d+)\s+(\d+)/i;
  const match = message.match(commandeRegex);
  
  if (match) {
    const numero = parseInt(match[1]);
    const quantite = parseInt(match[2]);
    
    const medicamentInfo = userState.listeMedicamentsAvecIndex.find(m => m.index === numero);
    
    if (medicamentInfo && medicamentInfo.medicament) {
      const result = await panierManager.ajouterAuPanier(userId, medicamentInfo.medicament.id, quantite);
      
      if (result.success) {
        await sendTextMessage(userId, result.message);
        
        // Demander si l'utilisateur veut continuer ou valider
        const buttons = [
          { type: "reply", reply: { id: "voir_panier", title: "🛒 Voir mon panier" } },
          { type: "reply", reply: { id: "continuer_achats", title: "💊 Continuer les achats" } },
          { type: "reply", reply: { id: "valider_commande", title: "✅ Valider la commande" } }
        ];
        
        await sendInteractiveMessage(
          userId,
          "Que souhaitez-vous faire maintenant ?",
          buttons
        );
        
        userState.step = "MENU_PRINCIPAL";
        userStates.set(userId, userState);
      } else {
        await sendTextMessage(userId, result.message);
      }
    } else {
      await sendTextMessage(userId, "❌ Numéro de médicament invalide. Veuillez réessayer.");
    }
  } else {
    await sendTextMessage(
      userId,
      "❌ **Format incorrect.**\n\n" +
      "Pour commander, utilisez le format :\n" +
      "*COMMANDER [numéro] [quantité]*\n\n" +
      "Exemple : *COMMANDER 1 2*"
    );
  }
}

async function finaliserCommande(userId, userState) {
  if (!userState.panier || userState.panier.length === 0) {
    await sendTextMessage(userId, "❌ Votre panier est vide. Ajoutez d'abord des médicaments.");
    return;
  }

  // Créer la commande dans Firestore
  const commandeId = uuidv4();
  const fraisLivraison = getFraisLivraison();
  let total = 0;
  
  const items = userState.panier.map(item => {
    const sousTotal = item.prix * item.quantite;
    total += sousTotal;
    return {
      medicamentId: item.id,
      nom: item.nom,
      quantite: item.quantite,
      prix: item.prix,
      sousTotal: sousTotal,
      pharmacieId: item.pharmacieId,
      necessiteOrdonnance: item.necessiteOrdonnance
    };
  });

  const commandeData = {
    id: commandeId,
    client: {
      nom: userState.nom,
      whatsapp: userState.whatsapp || userId,
      aJoindre: userState.aJoindre || userId,
      quartier: userState.quartier,
      indications: userState.indications
    },
    items: items,
    montantTotal: total,
    fraisLivraison: fraisLivraison,
    total: total + fraisLivraison,
    pharmacieId: userState.pharmacieId,
    pharmacieNom: userState.pharmacieNom,
    statut: 'en_attente_validation',
    dateCreation: admin.firestore.FieldValue.serverTimestamp(),
    besoinOrdonnance: userState.besoinOrdonnance,
    ordonnanceValidee: userState.ordonnanceValidee,
    ordonnancePhotoUrl: userState.ordonnancePhotoUrl,
    livraison: {
      quartier: userState.quartier,
      indications: userState.indications,
      latitude: userState.location?.latitude,
      longitude: userState.location?.longitude
    },
    chatActive: true
  };

  try {
    await db.collection('commandes').doc(commandeId).set(commandeData);
    
    // Mettre à jour le stock
    for (const item of userState.panier) {
      await updateStock(item.id, item.quantite);
    }
    
    // Envoyer confirmation
    await sendTextMessage(
      userId,
      `🎉 **COMMANDE CONFIRMÉE !**\n\n` +
      `🆔 **N° Commande :** #${commandeId.substring(0, 8)}\n` +
      `💰 **Total :** ${total + fraisLivraison} FCFA\n` +
      `🏥 **Pharmacie :** ${userState.pharmacieNom}\n` +
      `📍 **Livraison :** ${userState.quartier || 'San Pedro'}\n\n` +
      `⏳ **Prochaines étapes :**\n` +
      `1. Validation par la pharmacie\n` +
      `2. Attribution d'un livreur\n` +
      `3. Notification de suivi\n\n` +
      `📞 **Support :** ${CONFIG.SUPPORT_PHONE}\n\n` +
      `Merci pour votre confiance ! 😊`
    );
    
    // Réinitialiser le panier
    userState.panier = [];
    userState.commandeEnCours = commandeId;
    userState.step = "MENU_PRINCIPAL";
    userStates.set(userId, userState);
    
    // Si besoin d'ordonnance, envoyer à la pharmacie
    if (userState.besoinOrdonnance && userState.ordonnancePhotoUrl) {
      await pharmacieValidator.envoyerOrdonnancePharmacie(commandeId, userState.ordonnancePhotoUrl, userState.pharmacieId);
    } else {
      // Sinon, envoyer directement au livreur
      await livreurManager.envoyerCommandeLivreur(commandeId, userState.pharmacieId);
    }
    
  } catch (error) {
    console.error('Erreur création commande:', error);
    await sendTextMessage(userId, "❌ Erreur lors de la création de votre commande. Veuillez réessayer.");
  }
}

async function envoyerMessageBienvenue(userId, userState) {
  const messagesBienvenue = [
    `💊 **Bonjour ${userState.nom || 'cher client'} !** Je suis Mia, votre assistante Pillbox à San Pedro. 🤗\n\n`,
    `👋 **Salut ${userState.nom || 'là'} !** Mia à votre service, votre assistant médical à San Pedro. 😊\n\n`,
    `🏥 **Bienvenue ${userState.nom || ''} !** Je suis Mia, je vous aide avec vos besoins santé à San Pedro. 🌟\n\n`
  ];
  
  const messageAleatoire = messagesBienvenue[Math.floor(Math.random() * messagesBienvenue.length)];
  
  await sendTextMessage(
    userId,
    messageAleatoire +
    `Je suis là pour vous aider à :\n\n` +
    `💊 **Commander des médicaments** (avec/sans ordonnance)\n` +
    `🏥 **Trouver des pharmacies de garde** 24h/24\n` +
    `📅 **Prendre des rendez-vous** médicaux\n` +
    `🌿 **Donner des conseils santé** généraux\n` +
    `🚚 **Organiser la livraison** à domicile\n\n` +
    `📍 **Zone de service :** UNIQUEMENT San Pedro\n` +
    `💰 **Frais livraison :** 400 FCFA (jour) / 600 FCFA (nuit)\n` +
    `📞 **Support :** ${CONFIG.SUPPORT_PHONE}\n\n` +
    `💬 **Parlez-moi naturellement,** comme à un ami !\n` +
    `Exemple : "Je veux du paracétamol" ou "Pharmacie ouverte ?"\n\n` +
    `Comment puis-je vous aider aujourd'hui ? 😊`
  );
  
  userState.initialized = true;
  userStates.set(userId, userState);
}

async function gererErreur(userId, error, userState) {
  console.error('🔴 ERREUR GÉRÉE:', error.message);
  
  const messagesErreur = [
    "Désolé, une petite erreur s'est produite. Pouvez-vous reformuler votre demande ? 🤔",
    "Oups ! J'ai rencontré un problème technique. Essayez à nouveau s'il vous plaît. 🔄",
    "Je rencontre une difficulté momentanée. Pourriez-vous répéter votre demande ? 🙏",
    "Pardon pour ce contretemps. Je suis à nouveau opérationnelle, que souhaitez-vous ? 😊"
  ];
  
  const messageAleatoire = messagesErreur[Math.floor(Math.random() * messagesErreur.length)];
  
  // Réponse de secours avec Groq
  try {
    const groqResponse = await getGroqAIResponse("L'utilisateur a rencontré une erreur, rassure-le et propose de l'aider à nouveau.");
    await sendTextMessage(userId, `${messageAleatoire}\n\n${groqResponse}`);
  } catch (groqError) {
    await sendTextMessage(userId, messageAleatoire);
  }
  
  // Réinitialiser l'état si nécessaire
  if (userState.step && userState.step.includes("ATTENTE")) {
    userState.step = "MENU_PRINCIPAL";
    userStates.set(userId, userState);
  }
}

async function handleLocationMessage(from, location, userState) {
  const { latitude, longitude } = location;
  
  // Vérifier si dans San Pedro
  const isInZone = isInSanPedro(latitude, longitude);
  
  if (!isInZone) {
    await sendTextMessage(
      from,
      `❌ **Hors zone de livraison**\n\n` +
      `Désolé, notre service de livraison est exclusivement réservé à **San Pedro**.\n\n` +
      `📍 **Vous semblez être en dehors de notre zone de couverture.**\n\n` +
      `💡 **Solutions :**\n` +
      `1. Vérifiez que vous êtes bien à San Pedro\n` +
      `2. Contactez une pharmacie locale\n` +
      `3. Utilisez nos services sur place`
    );
    return;
  }
  
  // Enregistrer la localisation
  userState.location = { latitude, longitude };
  
  await sendTextMessage(
    from,
    `📍 **Localisation confirmée !**\n\n` +
    `Vous êtes bien dans la zone de livraison San Pedro.\n\n` +
    `Maintenant, donnez-moi vos informations :\n\n` +
    `📝 **Format attendu :**\n` +
    `Nom: Votre nom complet\n` +
    `Quartier: Votre quartier\n` +
    `WhatsApp: Votre numéro WhatsApp\n` +
    `À joindre: Numéro pour le livreur\n` +
    `Indications: Détails pour trouver l'adresse\n\n` +
    `Exemple :\n` +
    `Nom: Fatou Traoré\n` +
    `Quartier: Résidence du Port\n` +
    `WhatsApp: +2250708123456\n` +
    `À joindre: +2250708123456\n` +
    `Indications: Immeuble bleu, interphone 15`
  );
  
  userState.step = "ATTENTE_INFOS_LIVRAISON";
  userStates.set(from, userState);
}

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
  else if (buttonId.startsWith('refuer_ordonnance_')) {
    const commandeId = buttonId.replace('refuer_ordonnance_', '');
    await pharmacieValidator.handleReponsePharmacie(from, buttonId, commandeId, 'refuser');
  }
  else if (buttonId === "pharmacie_garde") {
    await afficherPharmaciesDeGarde(from);
  }
  else if (buttonId === "autre_recherche") {
    await sendTextMessage(
      from,
      "🔍 **Nouvelle recherche**\n\n" +
      "Quel médicament recherchez-vous ?\n" +
      "Exemple : paracétamol, ibuprofène, amoxicilline"
    );
    userState.step = "ATTENTE_RECHERCHE_MEDICAMENT";
    userStates.set(from, userState);
  }
  else if (buttonId === "support") {
    await orienterSupport(from, "besoin d'aide");
  }
  else if (buttonId === "valider_panier" || buttonId === "valider_commande") {
    await finaliserCommande(from, userState);
  }
  else if (buttonId === "vider_panier") {
    userState.panier = [];
    userState.pharmacieId = null;
    userState.pharmacieNom = null;
    userState.besoinOrdonnance = false;
    userStates.set(from, userState);
    await sendTextMessage(from, "🗑️ **Panier vidé avec succès !**");
  }
  else if (buttonId === "continuer_achats" || buttonId === "voir_panier") {
    const contenuPanier = await panierManager.afficherPanier(from);
    await sendTextMessage(from, contenuPanier);
  }
  else {
    await sendTextMessage(
      from,
      "⚠️ **Option non reconnue.**\n\n" +
      "Dites-moi simplement ce dont vous avez besoin, je vous guiderai ! 😊"
    );
  }
}

async function verifierDonneesFirestore() {
  try {
    console.log('🔍 Vérification des données Firestore...');
    
    // Vérifier les collections
    const collections = ['medicaments', 'pharmacies', 'centres_sante'];
    const stats = {};
    
    for (const collection of collections) {
      const snapshot = await db.collection(collection).limit(1).get();
      stats[collection] = {
        existe: !snapshot.empty,
        count: snapshot.empty ? 0 : 'chargement...'
      };
    }
    
    // Compter les médicaments avec stock
    const medicamentsSnapshot = await db.collection('medicaments').where('stock', '>', 0).get();
    stats.medicaments.count = medicamentsSnapshot.size;
    
    // Compter les pharmacies de garde
    const pharmaciesSnapshot = await db.collection('pharmacies')
      .where('estDeGarde', '==', true)
      .where('estOuvert', '==', true)
      .get();
    stats.pharmacies.deGarde = pharmaciesSnapshot.size;
    
    console.log('✅ Données Firestore vérifiées:', stats);
    
    return {
      success: true,
      stats: stats,
      message: `Données disponibles: ${medicamentsSnapshot.size} médicaments, ${pharmaciesSnapshot.size} pharmacies de garde`
    };
    
  } catch (error) {
    console.error('❌ Erreur vérification données:', error);
    return {
      success: false,
      error: error.message
    };
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
    let userState = userStates.get(from) || { ...DEFAULT_STATE, nom: "Client Pillbox" };

    // Ignorer les messages audio
    if (messageType === 'audio' || messageType === 'voice') return;

    if (messageType === 'text') {
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

// Diagnostic endpoint
app.get('/api/diagnostic', async (req, res) => {
  try {
    const [firebaseCheck] = await Promise.all([
      verifierDonneesFirestore(),
      db.collection('system_health').doc('diagnostic').set({
        timestamp: new Date().toISOString(),
        status: 'checking'
      })
    ]);
    
    const diagnostic = {
      timestamp: new Date().toISOString(),
      server: 'online',
      firebase: firebaseCheck.success ? 'connected' : 'error',
      data: firebaseCheck.stats,
      users_actifs: userStates.size,
      memory_usage: process.memoryUsage(),
      uptime: process.uptime()
    };
    
    res.status(200).json(diagnostic);
    
  } catch (error) {
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Test endpoint
app.get('/api/test-medicaments', async (req, res) => {
  try {
    const recherche = req.query.search || 'paracétamol';
    const result = await rechercherMedicamentDansPharmacies(recherche);
    
    res.json({
      success: true,
      recherche: recherche,
      result: result,
      count: Object.keys(result).length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

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

// Gestion des erreurs globales
process.on('uncaughtException', (error) => {
  console.error('💥 ERREUR NON GÉRÉE:', error.message);
  console.error('Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 PROMISE REJECTION NON GÉRÉE:', reason);
});