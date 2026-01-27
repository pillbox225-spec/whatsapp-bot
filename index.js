require('dotenv').config();
const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

// =================== CONFIGURATION ===================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

// =================== INITIALISATION FIREBASE ===================
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

    // Test connexion
    const testRef = db.collection('system_health').doc('connection_test');
    await testRef.set({
      timestamp: new Date().toISOString(),
      status: 'connected'
    });
    console.log('✅ Connexion Firestore établie');

    await verifierDonneesInitiales();

  } catch (error) {
    console.error('❌ ERREUR CRITIQUE Firebase:', error.message);
    process.exit(1);
  }
})();

// =================== CONFIGURATION GLOBALE ===================
const CONFIG = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  GROQ_MODEL: "llama-3.1-8b-instant",
  SUPPORT_PHONE: "+2250701406868",
  LIVRAISON_JOUR: 400,
  LIVRAISON_NUIT: 600,
  FRAIS_SERVICE: 0,
  MAX_QUANTITE: 10,
  ZONE_SERVICE: "San Pedro"
};

// =================== ÉTAT UTILISATEUR ===================
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
  nom: 'Client',
  whatsapp: null,
  aJoindre: null,
  resultatsRechercheMedicaments: null,
  listeMedicamentsAvecIndex: [],
  medecinSelectionne: null,
  cliniqueSelectionnee: null,
  dateRendezVous: null,
  attenteMedicament: false,
  attenteSpecialite: false,
  attenteMedicamentPrix: false,
  attenteCommande: false,
  attenteSelectionClinique: false,
  listeCliniques: [],
  listeMedicaments: [],
  historiqueMessages: [],
  modeMulti: false,
  dernierMedicamentAjoute: null,
  attenteSpecialiteRdv: false,
  attenteSelectionCliniqueRdv: false,
  attenteDateRdv: false,
  attenteHeureRdv: false,
  attenteNomRdv: false,
  attenteTelephoneRdv: false,
  specialiteRdv: null,
  listeCliniquesRdv: null,
  cliniqueSelectionneeRdv: null,
  dateRdv: null,
  heureRdv: null,
  nomRdv: null,
  attenteMedicamentImage: false,
  attenteNom: false,
  attenteQuartier: false,
  attenteWhatsApp: false,
  attenteIndications: false,
  apresCommande: false,
  apresRendezVous: false,
  derniereCommandeRef: null,
  dernierRdvRef: null,
  dernierLivreurNom: null,
  dernierLivreurTel: null,
  langue: 'fr',
  notificationsActivees: true,
  heureLivraisonPreferee: null,
  modePaiementPrefere: null,
  historiqueCommandes: [],
  historiqueRendezVous: [],
  preferences: {
    allergies: [],
    conditionsChroniques: [],
    medicamentsReguliers: []
  }
};

const userStates = new Map();
const processingLocks = new Map();
const messageCache = new Map();
const CACHE_DURATION = 2000;

// =================== UTILITAIRES ===================
function isDuplicateMessage(userId, message) {
  const cacheKey = `${userId}_${message.substring(0, 50)}`;
  const now = Date.now();
  const cached = messageCache.get(cacheKey);

  if (cached && (now - cached.timestamp < CACHE_DURATION)) {
    return true;
  }

  messageCache.set(cacheKey, { timestamp: now, message });
  
  setTimeout(() => {
    const cachedEntry = messageCache.get(cacheKey);
    if (cachedEntry && now - cachedEntry.timestamp > CACHE_DURATION) {
      messageCache.delete(cacheKey);
    }
  }, CACHE_DURATION + 1000);

  return false;
}

async function withUserLock(userId, callback) {
  if (processingLocks.has(userId)) {
    console.log(`⏳ ${userId} est déjà en traitement`);
    return null;
  }

  processingLocks.set(userId, true);

  try {
    return await callback();
  } finally {
    setTimeout(() => {
      if (processingLocks.has(userId)) {
        processingLocks.delete(userId);
      }
    }, 5000);
  }
}

function getFraisLivraison() {
  const maintenant = new Date();
  const heure = maintenant.getHours();
  return (heure >= 22 || heure < 6) ? CONFIG.LIVRAISON_NUIT : CONFIG.LIVRAISON_JOUR;
}

function getHeureLivraison() {
  const maintenant = new Date();
  const heure = maintenant.getHours();
  
  if (heure < 8) return "tôt le matin (7h-9h)";
  if (heure < 12) return "dans la matinée (9h-12h)";
  if (heure < 16) return "dans l'après-midi (13h-16h)";
  if (heure < 20) return "en fin d'après-midi (16h-19h)";
  return "en soirée (19h-21h)";
}

// =================== COMMUNICATION WHATSAPP ===================
async function sendWhatsAppMessage(to, text) {
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
    console.error('❌ Erreur envoi WhatsApp:', error.response?.data || error.message);
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
    console.error('❌ Erreur marquage message comme lu:', error.response?.data || error.message);
  }
}

// =================== GESTIONNAIRE DE CONTEXTE IA ===================
class GestionnaireContexte {
  constructor() {
    this.motsClesSymptomes = {
      douleur: ['douleur', 'souffre', 'mal', 'fait mal', 'douloureux'],
      fievre: ['fièvre', 'chaud', 'température', 'frissons'],
      toux: ['tousse', 'toux', 'toussant'],
      fatigue: ['fatigue', 'fatigué', 'épuisé'],
      nausee: ['nausée', 'vomir', 'vomissement'],
      diarrhee: ['diarrhée', 'selles', 'intestin'],
      mauxTete: ['mal de tête', 'céphalée', 'migraine'],
      allergie: ['allergie', 'allergique', 'réaction']
    };

    this.motsClesEmotionnels = {
      urgent: ['urgent', 'vite', 'immédiat'],
      stress: ['stress', 'nerveux', 'anxieux'],
      douleurForte: ['atroce', 'insupportable', 'violent'],
      satisfaction: ['merci', 'parfait', 'super'],
      confusion: ['quoi', 'comment', 'hein', 'pardon']
    };
  }

  async analyserMessage(userId, message) {
    const userState = userStates.get(userId) || { ...DEFAULT_STATE };
    const texte = message.toLowerCase();
    
    // Analyse symptomatique
    const symptomes = this.detecterSymptomes(texte);
    
    // Analyse émotionnelle
    const emotion = this.analyserEmotion(texte);
    
    // Extraire entités
    const entites = this.extraireEntites(texte);
    
    return {
      symptomes,
      emotion,
      entites,
      besoins: this.identifierBesoins(texte)
    };
  }

  detecterSymptomes(texte) {
    const symptomes = [];
    for (const [symptome, mots] of Object.entries(this.motsClesSymptomes)) {
      if (mots.some(mot => texte.includes(mot))) {
        symptomes.push(symptome);
      }
    }
    return symptomes;
  }

  analyserEmotion(texte) {
    let scoreUrgence = 0;
    let scoreStress = 0;
    
    // Urgence
    if (texte.includes('urgent') || texte.includes('vite') || texte.includes('immédiat')) {
      scoreUrgence = 3;
    } else if (texte.includes('maintenant') || texte.includes('rapide')) {
      scoreUrgence = 2;
    }
    
    // Stress
    if (texte.includes('stress') || texte.includes('panique') || texte.includes('angoissé')) {
      scoreStress = 3;
    } else if (texte.includes('inquiet') || texte.includes('nerveux')) {
      scoreStress = 2;
    }
    
    return {
      urgence: scoreUrgence,
      stress: scoreStress,
      ton: scoreUrgence > 0 ? 'pressé' : scoreStress > 0 ? 'stressé' : 'neutre'
    };
  }

  extraireEntites(texte) {
    const entites = {
      medicaments: [],
      quantites: [],
      pharmacies: [],
      cliniques: [],
      specialites: []
    };
    
    // Médicaments
    const medicaments = ['paracetamol', 'paracétamol', 'doliprane', 'ibuprofène', 'amoxicilline', 'aspirine', 'vitamine c'];
    medicaments.forEach(med => {
      if (texte.includes(med)) entites.medicaments.push(med);
    });
    
    // Quantités
    const quantiteMatch = texte.match(/(\d+)\s*(boîtes?|comprimés?|pilules?|sachets?)/i);
    if (quantiteMatch) entites.quantites.push(parseInt(quantiteMatch[1]));
    
    return entites;
  }

  identifierBesoins(texte) {
    const besoins = [];
    
    if (texte.includes('acheter') || texte.includes('commander') || texte.includes('je veux')) {
      besoins.push('ACHAT');
    }
    
    if (texte.includes('pharmacie') && texte.includes('garde')) {
      besoins.push('PHARMACIE_GARDE');
    }
    
    if (texte.includes('clinique') || texte.includes('médecin') || texte.includes('rdv')) {
      besoins.push('RENDEZ_VOUS');
    }
    
    if (texte.includes('conseil') || texte.includes('symptôme') || texte.includes('maladie')) {
      besoins.push('CONSEIL');
    }
    
    if (texte.includes('prix') || texte.includes('combien coûte')) {
      besoins.push('PRIX');
    }
    
    if (texte.includes('disponible') || texte.includes('en stock')) {
      besoins.push('STOCK');
    }
    
    if (besoins.length === 0) besoins.push('INFORMATION');
    
    return besoins;
  }
}

const gestionnaireContexte = new GestionnaireContexte();

// =================== MOTEUR D'INTELLIGENCE GROQ ===================
async function comprendreEtAgir(userId, message) {
  console.log(`🧠 Analyse IA: "${message.substring(0, 50)}..."`);
  
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };
  
  try {
    const prompt = `
Tu es Mia, l'assistante médicale PillBox qui aide les clients à commander des médicaments via WhatsApp.

## MISSION :
1. Comprendre la demande du client (médicament, pharmacie, clinique)
2. Vérifier la disponibilité dans notre base de données
3. Guider le client dans l'achat ou la prise de rendez-vous
4. Gérer la livraison de jour comme de nuit

## RÈGLES ABSOLUES :
- NE JAMAIS inventer de données
- TOUT doit venir de la base de données réelle
- Service uniquement à ${CONFIG.ZONE_SERVICE}
- Support: ${CONFIG.SUPPORT_PHONE}

## SERVICES DISPONIBLES :
1. COMMANDER_MEDICAMENT - Achat direct via WhatsApp
2. PHARMACIES_GARDE - Liste des pharmacies ouvertes
3. CLINIQUES_DISPO - Liste des cliniques vérifiées
4. PRENDRE_RDV - Rendez-vous médical
5. CONSEIL_BASIQUE - Conseils santé non-médicaux
6. SUIVI_COMMANDE - Suivre une commande
7. ANNULER - Annuler une action

## MESSAGE UTILISATEUR :
"${message}"

## CONTEXTE UTILISATEUR :
État actuel: ${userState.step}
Panier: ${userState.panier?.length || 0} article(s)
En attente: ${userState.attenteMedicament ? 'médicament' : userState.attenteCommande ? 'commande' : 'rien'}

## ANALYSE :
1. Quel médicament est demandé ? (paracétamol, ibuprofène, etc.)
2. Quelle quantité ? (nombre, boîtes)
3. Veut-il une pharmacie spécifique ?
4. Veut-il une clinique/rendez-vous ?
5. A-t-il besoin de conseil ?
6. Est-ce une demande de suivi ?

## RÉPONSE (JSON uniquement) :
{
  "action": "ACTION_PRINCIPALE",
  "reponse": "Réponse courte et naturelle",
  "parametres": {
    "medicament": "nom_du_medicament" ou null,
    "quantite": nombre ou null,
    "pharmacie": "nom_pharmacie" ou null,
    "specialite": "nom_specialite" ou null,
    "urgence": true/false
  },
  "next_step": "étape_suivante"
}
`;

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: CONFIG.GROQ_MODEL,
        messages: [
          {
            role: "system",
            content: "Tu es une assistante médicale professionnelle. Réponds UNIQUEMENT en JSON."
          },
          { role: "user", content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 500,
        response_format: { type: "json_object" }
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );

    const result = JSON.parse(response.data.choices[0].message.content);
    console.log('🧠 Résultat IA:', JSON.stringify(result));

    // Envoyer réponse immédiate
    await sendWhatsAppMessage(userId, result.reponse);

    // Exécuter l'action
    await executerActionIA(userId, result, message, userState);
    
    return result;

  } catch (error) {
    console.error('❌ Erreur IA:', error.message);
    // Fallback simple
    await sendWhatsAppMessage(userId, "Je vais t'aider ! Que souhaites-tu faire ?\n\n• Commander un médicament 💊\n• Trouver une pharmacie de garde 🏥\n• Prendre rendez-vous 📅\n• Suivre une commande 📦");
  }
}

// =================== EXÉCUTION DES ACTIONS IA ===================
async function executerActionIA(userId, result, message, userState) {
  const action = result.action;
  const parametres = result.parametres || {};
  const texte = message.toLowerCase();

  console.log(`🤖 Action: ${action}`);

  switch(action) {
    case 'COMMANDER_MEDICAMENT':
      const medicament = parametres.medicament || extraireNomMedicament(texte);
      const quantite = parametres.quantite || extraireQuantite(texte);
      const pharmacie = parametres.pharmacie;
      
      if (medicament) {
        await rechercherEtCommanderMedicament(userId, medicament, quantite, pharmacie);
      } else {
        userState.attenteMedicament = true;
        userStates.set(userId, userState);
        await sendWhatsAppMessage(userId, "Quel médicament souhaites-tu commander ?");
      }
      break;

    case 'PHARMACIES_GARDE':
      await afficherPharmaciesDeGarde(userId);
      break;

    case 'CLINIQUES_DISPO':
      await afficherCliniquesDisponibles(userId);
      break;

    case 'PRENDRE_RDV':
      const specialite = parametres.specialite || extraireSpecialite(texte);
      if (specialite) {
        await gererPriseRendezVous(userId, specialite);
      } else {
        userState.attenteSpecialiteRdv = true;
        userStates.set(userId, userState);
        await sendWhatsAppMessage(userId, "Pour quel type de consultation ?\n\nExemples :\n• Médecin généraliste\n• Pédiatre\n• Gynécologue\n• Dentiste");
      }
      break;

    case 'CONSEIL_BASIQUE':
      await donnerConseilBasique(userId, texte);
      break;

    case 'SUIVI_COMMANDE':
      await gererSuiviCommande(userId);
      break;

    case 'ANNULER':
      await annulerAction(userId, userState);
      break;

    default:
      // Si action non reconnue, demander clarification
      await sendWhatsAppMessage(userId, "Que souhaites-tu faire exactement ?\n\n💊 Commander un médicament\n🏥 Pharmacie de garde\n📅 Prendre rendez-vous\n📦 Suivre une commande");
  }
}

// =================== FONCTIONS D'EXTRACTION ===================
function extraireNomMedicament(texte) {
  const medicaments = {
    'paracetamol': ['paracetamol', 'paracétamol', 'paracetemol'],
    'doliprane': ['doliprane', 'dolipran'],
    'ibuprofene': ['ibuprofène', 'ibuprofene', 'ibuprofen', 'advil'],
    'amoxicilline': ['amoxicilline', 'amoxiciline', 'clamoxyl'],
    'aspirine': ['aspirine', 'aspirin', 'aspegic'],
    'vitamine c': ['vitamine c', 'vitaminec', 'vit c'],
    'sirop': ['sirop', 'sirop contre la toux']
  };

  const texteLower = texte.toLowerCase();
  
  for (const [medicament, aliases] of Object.entries(medicaments)) {
    if (aliases.some(alias => texteLower.includes(alias))) {
      return medicament;
    }
  }
  
  return null;
}

function extraireQuantite(texte) {
  const match = texte.match(/(\d+)\s*(boîtes?|comprimés?|pilules?|sachets?|fois)/i);
  return match ? parseInt(match[1]) : 1;
}

function extraireSpecialite(texte) {
  const specialites = [
    'généraliste', 'médecin généraliste',
    'pédiatre', 'pédiatrie',
    'gynécologue', 'gynécologie',
    'dentiste', 'dentaire',
    'dermatologue', 'dermatologie',
    'cardiologue', 'cardiologie',
    'ophtalmologue', 'ophtalmologie',
    'urgences', 'urgence'
  ];

  const texteLower = texte.toLowerCase();
  
  for (const specialite of specialites) {
    if (texteLower.includes(specialite)) {
      return specialite;
    }
  }
  
  return null;
}

// =================== GESTION DES COMMANDES ===================
async function rechercherEtCommanderMedicament(userId, nomMedicament, quantite = 1, pharmacieSpecifique = null) {
  try {
    console.log(`🔍 Recherche: ${nomMedicament} (x${quantite})`);
    
    await sendWhatsAppMessage(userId, `Je cherche "${nomMedicament}"...`);

    // Recherche dans la base
    const medicamentsSnapshot = await db.collection('medicaments')
      .where('stock', '>', 0)
      .limit(20)
      .get();

    const medicamentsTrouves = [];
    
    medicamentsSnapshot.docs.forEach(doc => {
      const medicament = { id: doc.id, ...doc.data() };
      const nomMed = (medicament.nom || '').toLowerCase();
      
      if (nomMed.includes(nomMedicament.toLowerCase()) || 
          nomMedicament.toLowerCase().includes(nomMed)) {
        medicamentsTrouves.push(medicament);
      }
    });

    if (medicamentsTrouves.length === 0) {
      await sendWhatsAppMessage(
        userId,
        `Je ne trouve pas "${nomMedicament}" en stock.\n\n` +
        `📞 Support : ${CONFIG.SUPPORT_PHONE}`
      );
      return;
    }

    // Grouper par pharmacie
    const medicamentsParPharmacie = {};
    
    for (const medicament of medicamentsTrouves) {
      if (!medicament.pharmacieId) continue;
      
      const pharmacieId = medicament.pharmacieId;
      
      if (!medicamentsParPharmacie[pharmacieId]) {
        medicamentsParPharmacie[pharmacieId] = {
          medicaments: [],
          pharmacieId: pharmacieId
        };
      }
      medicamentsParPharmacie[pharmacieId].medicaments.push(medicament);
    }

    // Obtenir infos pharmacies
    const pharmacieIds = Object.keys(medicamentsParPharmacie);
    const pharmacies = new Map();

    for (const pharmacieId of pharmacieIds) {
      try {
        const pharmacieDoc = await db.collection('pharmacies').doc(pharmacieId).get();
        if (pharmacieDoc.exists) {
          pharmacies.set(pharmacieId, { id: pharmacieDoc.id, ...pharmacieDoc.data() });
        }
      } catch (error) {
        console.error(`Erreur pharmacie ${pharmacieId}:`, error.message);
      }
    }

    // Afficher résultats
    const userState = userStates.get(userId) || DEFAULT_STATE;
    const listeMedicamentsAvecIndex = [];
    
    let message = `💊 ${nomMedicament.toUpperCase()}\n\n`;
    let index = 1;

    for (const [pharmacieId, data] of Object.entries(medicamentsParPharmacie)) {
      const pharmacie = pharmacies.get(pharmacieId);
      if (!pharmacie) continue;

      // Filtrer par pharmacie spécifique si demandé
      if (pharmacieSpecifique && 
          !pharmacie.nom.toLowerCase().includes(pharmacieSpecifique.toLowerCase())) {
        continue;
      }

      for (const medicament of data.medicaments) {
        listeMedicamentsAvecIndex.push({
          index: index,
          medicamentId: medicament.id,
          pharmacieId: pharmacieId,
          pharmacieNom: pharmacie.nom,
          medicament: medicament
        });

        message += `${index}. ${medicament.nom}\n`;
        message += `   💰 ${medicament.prix || '?'} FCFA\n`;
        message += `   🏥 ${pharmacie.nom}\n`;

        if (medicament.dosage || medicament.forme) {
          message += `   📏 ${medicament.dosage || ''} ${medicament.forme || ''}\n`;
        }

        message += `${medicament.necessiteOrdonnance ? '📄 Ordonnance requise' : '✅ Sans ordonnance'}\n\n`;
        index++;
      }
    }

    if (index === 1) {
      await sendWhatsAppMessage(
        userId,
        `Je ne trouve pas "${nomMedicament}"${pharmacieSpecifique ? ` à ${pharmacieSpecifique}` : ''}.\n\n` +
        `📞 Support : ${CONFIG.SUPPORT_PHONE}`
      );
      return;
    }

    const fraisLivraison = getFraisLivraison();
    const heureLivraison = getHeureLivraison();

    message += `📦 Livraison ${heureLivraison}\n`;
    message += `🚚 Frais : ${fraisLivraison} FCFA\n\n`;
    message += `🛒 Pour commander :\n`;
    message += '"ajouter [numéro] [quantité]"\n\n';
    message += `Exemple : "ajouter 1 ${quantite}"\n\n`;
    message += `💬 Ensuite dites "continuer" ou "terminer"`;

    await sendWhatsAppMessage(userId, message);

    // Sauvegarder pour commande
    userState.resultatsRechercheMedicaments = medicamentsTrouves;
    userState.listeMedicamentsAvecIndex = listeMedicamentsAvecIndex;
    userState.attenteCommande = true;
    userState.step = 'ATTENTE_COMMANDE_MEDICAMENT';
    userStates.set(userId, userState);

  } catch (error) {
    console.error('❌ Erreur recherche:', error.message);
    await sendWhatsAppMessage(
      userId,
      `Problème pour chercher "${nomMedicament}".\n\n` +
      `📞 Support : ${CONFIG.SUPPORT_PHONE}`
    );
  }
}

// =================== GESTION DU PANIER ===================
class GestionPanier {
  constructor() {
    this.etapes = {
      INITIAL: 'initial',
      RECHERCHE: 'recherche',
      SELECTION: 'selection',
      CONFIRMATION: 'confirmation',
      FINALISATION: 'finalisation'
    };
  }

  async gererMessage(userId, message, userState) {
    const texte = message.toLowerCase().trim();

    // Initialiser panier
    if (!userState.panier) {
      userState.panier = [];
      userStates.set(userId, userState);
    }

    // Commandes de panier
    if (texte === 'panier' || texte === 'mon panier' || texte === 'voir panier') {
      return this.afficherPanier(userId, userState);
    }

    if (texte === 'vider' || texte === 'vider panier' || texte === 'recommencer') {
      return this.viderPanier(userId, userState);
    }

    if (texte === 'terminer' || texte === 'finaliser' || texte === 'valider') {
      if (userState.panier.length > 0) {
        return this.finaliserPanier(userId, userState);
      } else {
        await sendWhatsAppMessage(userId, "Ton panier est vide. Dis-moi un médicament.");
        return 'VIDE';
      }
    }

    if (texte === 'continuer' || texte === 'encore' || texte === 'ajouter') {
      if (userState.panier.length > 0) {
        await sendWhatsAppMessage(userId, "Dis-moi le nom du prochain médicament.");
        userState.attenteMedicament = true;
        userStates.set(userId, userState);
      } else {
        await sendWhatsAppMessage(userId, "Dis-moi le nom du médicament.");
        userState.attenteMedicament = true;
        userStates.set(userId, userState);
      }
      return 'CONTINUER';
    }

    // Ajouter au panier avec numéro
    const ajouterRegex = /ajouter\s+(\d+)(?:\s+(\d+))?/i;
    const matchAjouter = texte.match(ajouterRegex);

    if (matchAjouter) {
      const numero = parseInt(matchAjouter[1]);
      const quantite = matchAjouter[2] ? parseInt(matchAjouter[2]) : 1;

      if (quantite < 1 || quantite > CONFIG.MAX_QUANTITE) {
        await sendWhatsAppMessage(userId, `Quantité invalide (1-${CONFIG.MAX_QUANTITE}).`);
        return 'ERREUR';
      }

      const medicamentInfo = userState.listeMedicamentsAvecIndex.find(m => m.index === numero);

      if (!medicamentInfo) {
        await sendWhatsAppMessage(userId, "Numéro invalide. Choisis un numéro de la liste.");
        return 'ERREUR';
      }

      // Vérifier stock
      if (medicamentInfo.medicament.stock < quantite) {
        await sendWhatsAppMessage(
          userId,
          `Stock insuffisant. Il reste ${medicamentInfo.medicament.stock} disponible(s).`
        );
        return 'ERREUR';
      }

      // Vérifier ordonnance
      if (medicamentInfo.medicament.necessiteOrdonnance) {
        await sendWhatsAppMessage(
          userId,
          `Ce médicament nécessite une ordonnance.\n\n` +
          `Envoie la photo de ton ordonnance au support.\n\n` +
          `📞 Support : ${CONFIG.SUPPORT_PHONE}`
        );
        return 'ORDONNANCE';
      }

      // Ajouter au panier
      await this.ajouterAuPanier(userId, medicamentInfo, quantite, userState);
      return 'AJOUTE';
    }

    return null;
  }

  async ajouterAuPanier(userId, medicamentInfo, quantite, userState) {
    if (!userState.panier) {
      userState.panier = [];
    }

    // Vérifier si déjà dans le panier
    const indexExistant = userState.panier.findIndex(
      item => item.medicamentId === medicamentInfo.medicamentId
    );

    if (indexExistant >= 0) {
      userState.panier[indexExistant].quantite += quantite;
    } else {
      userState.panier.push({
        medicamentId: medicamentInfo.medicamentId,
        medicamentNom: medicamentInfo.medicament.nom,
        pharmacieId: medicamentInfo.pharmacieId,
        pharmacieNom: medicamentInfo.pharmacieNom,
        quantite: quantite,
        prixUnitaire: medicamentInfo.medicament.prix || 0,
        necessiteOrdonnance: medicamentInfo.medicament.necessiteOrdonnance || false,
        dosage: medicamentInfo.medicament.dosage,
        forme: medicamentInfo.medicament.forme,
        imageUrls: medicamentInfo.medicament.imageUrls || []
      });
    }

    userState.dernierMedicamentAjoute = medicamentInfo;
    userStates.set(userId, userState);

    // Confirmer l'ajout
    const panier = userState.panier;
    const { sousTotal } = this.calculerTotal(panier);

    await sendWhatsAppMessage(
      userId,
      `✅ Ajouté au panier !\n\n` +
      `Votre panier (${panier.length} article(s)) :\n\n` +
      this.formaterPanier(panier) + `\n` +
      `💰 Sous-total : ${sousTotal} FCFA\n\n` +
      `Que veux-tu faire ?\n` +
      `• "continuer" pour ajouter un autre médicament\n` +
      `• "terminer" pour finaliser ma commande\n` +
      `• "panier" pour voir mon panier\n` +
      `• "vider" pour vider et recommencer`
    );
  }

  async afficherPanier(userId, userState) {
    const panier = userState.panier || [];

    if (panier.length === 0) {
      await sendWhatsAppMessage(userId, "Ton panier est vide. Dis-moi un médicament.");
      return;
    }

    const { sousTotal, fraisLivraison, total } = this.calculerTotal(panier);
    const heureLivraison = getHeureLivraison();

    await sendWhatsAppMessage(
      userId,
      `🛒 Ton panier (${panier.length} article(s))\n\n` +
      this.formaterPanier(panier) + `\n` +
      `📦 Livraison ${heureLivraison}\n` +
      `💰 Sous-total : ${sousTotal} FCFA\n` +
      `🚚 Frais livraison : ${fraisLivraison} FCFA\n` +
      `💵 TOTAL : ${total} FCFA\n\n` +
      `"terminer" pour commander\n` +
      `"continuer" pour ajouter\n` +
      `"vider" pour recommencer`
    );
  }

  async viderPanier(userId, userState) {
    userState.panier = [];
    userStates.set(userId, userState);

    await sendWhatsAppMessage(userId, "🗑️ Panier vidé. Dis-moi un médicament pour commencer.");

    userState.attenteMedicament = true;
    userStates.set(userId, userState);
  }

  async finaliserPanier(userId, userState) {
    const panier = userState.panier || [];

    if (panier.length === 0) {
      await sendWhatsAppMessage(userId, "Ton panier est vide.");
      return;
    }

    const { sousTotal, fraisLivraison, total } = this.calculerTotal(panier);
    const heureLivraison = getHeureLivraison();

    // Vérifier si ordonnance requise
    const ordonnanceRequise = panier.some(item => item.necessiteOrdonnance);

    // Initialiser commande
    userState.commandeEnCours = {
      panier: panier,
      sousTotal: sousTotal,
      fraisLivraison: fraisLivraison,
      total: total,
      ordonnanceRequise: ordonnanceRequise,
      nom: null,
      quartier: null,
      whatsapp: null,
      indications: null,
      dateCreation: new Date().toISOString()
    };

    userState.step = ordonnanceRequise ? 'ATTENTE_ORDONNANCE' : 'ATTENTE_NOM';
    userStates.set(userId, userState);

    await sendWhatsAppMessage(
      userId,
      `✅ Panier finalisé\n\n` +
      `Commande (${panier.length} article(s)) :\n\n` +
      this.formaterPanier(panier) + `\n` +
      `📦 Livraison ${heureLivraison}\n` +
      `💵 TOTAL : ${total} FCFA\n\n` +
      (ordonnanceRequise ?
        `📄 Ordonnance requise. Envoie la photo de ton ordonnance.\n\n` +
        `📞 Support : ${CONFIG.SUPPORT_PHONE}` :
        `Pour finaliser, envoie tes informations :\n\n` +
        `1. **Ton nom complet**\n` +
        `2. **Ton quartier à ${CONFIG.ZONE_SERVICE}**\n` +
        `3. **Ton numéro WhatsApp**\n` +
        `4. **Indications pour le livreur**\n\n` +
        `Commence par ton nom :`)
    );
  }

  formaterPanier(panier) {
    let message = '';
    panier.forEach((item, index) => {
      message += `${index + 1}. ${item.medicamentNom} × ${item.quantite}\n`;
      message += `   ${item.prixUnitaire} FCFA × ${item.quantite} = ${item.prixUnitaire * item.quantite} FCFA\n`;
      if (item.necessiteOrdonnance) message += `   📄 Ordonnance requise\n`;
      message += `\n`;
    });
    return message;
  }

  calculerTotal(panier) {
    const sousTotal = panier.reduce((total, item) => {
      return total + (item.prixUnitaire * item.quantite);
    }, 0);

    const fraisLivraison = getFraisLivraison();
    const total = sousTotal + fraisLivraison;

    return { sousTotal, fraisLivraison, total };
  }
}

const gestionPanier = new GestionPanier();

// =================== COLLECTE D'INFORMATIONS LIVRAISON ===================
async function collecterInfosLivraison(userId, message, userState) {
  console.log(`📦 Collecte infos: "${message}"`);
  
  if (!userState.commandeEnCours) {
    console.error('❌ Pas de commande en cours');
    userState.step = 'MENU_PRINCIPAL';
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "Désolé, une erreur est survenue. Recommence s'il te plaît.");
    return;
  }

  // Étape 1: Nom
  if (userState.step === 'ATTENTE_NOM') {
    userState.commandeEnCours.nom = message.trim();
    userState.step = 'ATTENTE_QUARTIER';
    userStates.set(userId, userState);
    
    await sendWhatsAppMessage(
      userId,
      `Parfait, ${message.trim()} !\n\n` +
      `2. Quel est ton quartier à ${CONFIG.ZONE_SERVICE} ?\n` +
      `Exemple : "Centre-ville", "Bardo", "Williamsville", etc.`
    );
    
  // Étape 2: Quartier
  } else if (userState.step === 'ATTENTE_QUARTIER') {
    userState.commandeEnCours.quartier = message.trim();
    userState.step = 'ATTENTE_WHATSAPP';
    userStates.set(userId, userState);
    
    await sendWhatsAppMessage(
      userId,
      `3. Quel est ton numéro WhatsApp ?\n` +
      `(celui sur lequel je dois te contacter pour la livraison)`
    );
    
  // Étape 3: WhatsApp
  } else if (userState.step === 'ATTENTE_WHATSAPP') {
    // Valider et formater le numéro
    const numero = message.trim().replace(/\s+/g, '');
    let numeroValide = numero;
    
    if (!numero.startsWith('+225') && !numero.startsWith('225')) {
      if (numero.startsWith('0') || numero.startsWith('7')) {
        numeroValide = '+225' + numero.replace(/^0/, '');
      } else {
        numeroValide = '+225' + numero;
      }
    } else if (numero.startsWith('225')) {
      numeroValide = '+' + numero;
    }
    
    userState.commandeEnCours.whatsapp = numeroValide;
    userState.step = 'ATTENTE_INDICATIONS';
    userStates.set(userId, userState);
    
    await sendWhatsAppMessage(
      userId,
      `4. Dernière étape !\n\n` +
      `Donne-moi des indications pour le livreur :\n` +
      `• Rue, avenue\n` +
      `• Numéro de maison\n` +
      `• Référence (près de...)\n` +
      `• Code portail si nécessaire\n\n` +
      `Exemple : "Rue du Commerce N°15, près du marché Bardo, code porte 1234"`
    );
    
  // Étape 4: Indications
  } else if (userState.step === 'ATTENTE_INDICATIONS') {
    userState.commandeEnCours.indications = message.trim();
    
    // Confirmer la commande
    await confirmerCommande(userId, userState);
  }
}

async function confirmerCommande(userId, userState) {
  const commande = userState.commandeEnCours;
  const panier = commande.panier;
  
  const { sousTotal, fraisLivraison, total } = gestionPanier.calculerTotal(panier);
  const heureLivraison = getHeureLivraison();
  const numeroCommande = 'CMD-' + Date.now().toString().slice(-6);
  
  let message = `✅ COMMANDE CONFIRMÉE\n\n`;
  message += `📋 Numéro : ${numeroCommande}\n`;
  message += `👤 Nom : ${commande.nom}\n`;
  message += `📍 Quartier : ${commande.quartier}\n`;
  message += `📞 WhatsApp : ${commande.whatsapp}\n\n`;
  
  message += `📦 Commande :\n\n`;
  message += gestionPanier.formaterPanier(panier);
  
  message += `\n📦 Livraison ${heureLivraison}\n`;
  message += `💰 Sous-total : ${sousTotal} FCFA\n`;
  message += `🚚 Frais livraison : ${fraisLivraison} FCFA\n`;
  message += `💵 TOTAL : ${total} FCFA\n\n`;
  
  message += `📍 Indications : ${commande.indications}\n\n`;
  message += `⏳ Ton commande est en préparation...\n`;
  message += `📱 Tu recevras un message quand le livreur partira.\n\n`;
  message += `📞 Support : ${CONFIG.SUPPORT_PHONE}`;
  
  await sendWhatsAppMessage(userId, message);
  
  // Créer la commande dans Firestore
  await creerCommandeFirestore(userId, userState, commande, numeroCommande);
  
  // Réinitialiser l'état
  reinitialiserEtatUtilisateur(userId, userState);
}

// =================== PHARMACIES DE GARDE ===================
async function afficherPharmaciesDeGarde(userId) {
  try {
    await sendWhatsAppMessage(userId, "Je cherche les pharmacies de garde...");

    const maintenant = new Date();
    const heure = maintenant.getHours();
    const estNuit = heure >= 22 || heure < 6;
    
    const snapshot = await db.collection('pharmacies')
      .where('estDeGarde', '==', true)
      .where('estOuvert', '==', true)
      .limit(10)
      .get();

    if (snapshot.empty) {
      await sendWhatsAppMessage(
        userId,
        `Aucune pharmacie de garde trouvée${estNuit ? ' à cette heure' : ''}.\n\n` +
        `📞 Support : ${CONFIG.SUPPORT_PHONE}`
      );
      return;
    }

    let message = `🏥 PHARMACIES DE GARDE - ${CONFIG.ZONE_SERVICE}\n`;
    if (estNuit) message += "🌙 Service de nuit\n\n";

    snapshot.docs.forEach((doc, index) => {
      const pharmacie = doc.data();
      message += `${index + 1}. ${pharmacie.nom || 'Pharmacie'}\n`;
      message += `   📍 ${pharmacie.adresse || CONFIG.ZONE_SERVICE}\n`;
      message += `   📞 ${pharmacie.telephone || CONFIG.SUPPORT_PHONE}\n`;
      message += `   ⏰ ${pharmacie.horaires || '24h/24'}\n\n`;
    });

    message += `💊 Commande en ligne disponible 24h/24\n`;
    message += `📦 Livraison rapide\n\n`;
    message += `📞 Support : ${CONFIG.SUPPORT_PHONE}`;

    await sendWhatsAppMessage(userId, message);

  } catch (error) {
    console.error('❌ Erreur pharmacies de garde:', error.message);
    await sendWhatsAppMessage(
      userId,
      "Problème d'accès aux pharmacies.\n\n" +
      `📞 Support : ${CONFIG.SUPPORT_PHONE}`
    );
  }
}

// =================== CLINIQUES DISPONIBLES ===================
async function afficherCliniquesDisponibles(userId) {
  try {
    await sendWhatsAppMessage(userId, "Je recherche les cliniques...");

    const snapshot = await db.collection('centres_sante')
      .where('estVerifie', '==', true)
      .limit(15)
      .get();

    if (snapshot.empty) {
      await sendWhatsAppMessage(
        userId,
        "Aucune clinique trouvée pour le moment.\n\n" +
        `📞 Support : ${CONFIG.SUPPORT_PHONE}`
      );
      return;
    }

    let message = `🏥 CLINIQUES - ${CONFIG.ZONE_SERVICE}\n\n`;

    snapshot.docs.forEach((doc, index) => {
      const clinique = doc.data();
      message += `${index + 1}. ${clinique.nom || 'Clinique'}\n`;
      message += `   📍 ${clinique.adresse || CONFIG.ZONE_SERVICE}\n`;
      if (clinique.telephone) message += `   📞 ${clinique.telephone}\n`;

      // Spécialités
      if (clinique.specialites && Array.isArray(clinique.specialites)) {
        const specialites = clinique.specialites
          .filter(s => s && typeof s === 'string')
          .slice(0, 3);
        if (specialites.length > 0) {
          message += `   🩺 ${specialites.join(', ')}\n`;
        }
      }

      // Horaires
      if (clinique.horaires) {
        const horaires = clinique.horaires;
        const lundi = horaires.Lundi || horaires.lundi;
        if (lundi) message += `   ⏰ ${lundi}\n`;
      }

      message += `\n`;
    });

    message += "Pour prendre rendez-vous :\n";
    message += 'Dites "rendez-vous [spécialité]"\n\n';
    message += `📞 Support : ${CONFIG.SUPPORT_PHONE}`;

    await sendWhatsAppMessage(userId, message);

  } catch (error) {
    console.error('❌ Erreur cliniques:', error.message);
    await sendWhatsAppMessage(
      userId,
      "Problème lors de la recherche.\n\n" +
      `📞 Support : ${CONFIG.SUPPORT_PHONE}`
    );
  }
}

// =================== GESTION RENDEZ-VOUS ===================
async function gererPriseRendezVous(userId, specialite = null) {
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };
  
  if (specialite) {
    userState.specialiteRdv = specialite;
    userState.attenteSpecialiteRdv = false;
    userStates.set(userId, userState);

    // Chercher cliniques
    await chercherCliniquesPourRdv(userId, specialite);
  } else {
    userState.attenteSpecialiteRdv = true;
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "Pour quel type de consultation ?\n\nExemples :\n• Médecin généraliste\n• Pédiatre\n• Gynécologue\n• Dentiste");
  }
}

async function chercherCliniquesPourRdv(userId, specialite) {
  try {
    await sendWhatsAppMessage(userId, `Je cherche des cliniques pour "${specialite}"...`);

    const snapshot = await db.collection('centres_sante')
      .where('estVerifie', '==', true)
      .get();

    const cliniquesFiltrees = [];

    snapshot.docs.forEach(doc => {
      const centre = { id: doc.id, ...doc.data() };

      let specialiteTrouvee = false;

      // Vérifier spécialités
      if (centre.specialites && Array.isArray(centre.specialites)) {
        specialiteTrouvee = centre.specialites.some(s =>
          s && s.toLowerCase().includes(specialite.toLowerCase())
        );
      }

      // Vérifier services
      if (!specialiteTrouvee && centre.services && Array.isArray(centre.services)) {
        specialiteTrouvee = centre.services.some(s =>
          s && s.toLowerCase().includes(specialite.toLowerCase())
        );
      }

      if (specialiteTrouvee) {
        cliniquesFiltrees.push(centre);
      }
    });

    if (cliniquesFiltrees.length === 0) {
      await sendWhatsAppMessage(
        userId,
        `Je ne trouve pas de clinique pour "${specialite}".\n\n` +
        `📞 Support : ${CONFIG.SUPPORT_PHONE}`
      );
      return;
    }

    const userState = userStates.get(userId) || DEFAULT_STATE;
    userState.listeCliniquesRdv = cliniquesFiltrees;
    userState.attenteSelectionCliniqueRdv = true;
    userStates.set(userId, userState);

    let message = `🏥 CLINIQUES - ${specialite.toUpperCase()}\n\n`;

    cliniquesFiltrees.forEach((clinique, index) => {
      message += `${index + 1}. ${clinique.nom || 'Clinique'}\n`;
      message += `   📍 ${clinique.adresse || CONFIG.ZONE_SERVICE}\n`;
      if (clinique.telephone) message += `   📞 ${clinique.telephone}\n`;

      // Spécialités correspondantes
      if (clinique.specialites && Array.isArray(clinique.specialites)) {
        const specialitesFiltrees = clinique.specialites.filter(s => 
          s && s.toLowerCase().includes(specialite.toLowerCase())
        );
        if (specialitesFiltrees.length > 0) {
          message += `   🩺 ${specialitesFiltrees.join(', ')}\n`;
        }
      }

      message += `\n`;
    });

    message += `Pour choisir :\n`;
    message += `Réponds avec le numéro de la clinique\n`;
    message += `Exemple : "1" pour la première`;

    await sendWhatsAppMessage(userId, message);

  } catch (error) {
    console.error('❌ Erreur recherche cliniques:', error.message);
    await sendWhatsAppMessage(
      userId,
      `Problème lors de la recherche.\n\n` +
      `📞 Support : ${CONFIG.SUPPORT_PHONE}`
    );
  }
}

// =================== CONSEILS BASIQUES ===================
async function donnerConseilBasique(userId, symptome) {
  const conseils = {
    'fièvre': "Pour la fièvre :\n• Prendre du paracétamol\n• Boire beaucoup d'eau\n• Se reposer\n• Consulter si fièvre > 39°C ou durée > 3 jours",
    'toux': "Pour la toux :\n• Boire des boissons chaudes\n• Éviter l'air froid\n• Se reposer\n• Consulter si toux sanglante ou essoufflement",
    'maux de tête': "Pour les maux de tête :\n• Se reposer dans un endroit calme\n• Boire de l'eau\n• Prendre du paracétamol\n• Consulter si maux violents ou répétés",
    'diarrhée': "Pour la diarrhée :\n• Boire beaucoup d'eau\n• Éviter lait et gras\n• Manger riz, banane\n• Consulter si déshydratation ou sang"
  };

  let conseil = "Je ne peux pas donner de diagnostic médical. Pour des symptômes sérieux, consulte un médecin.\n\n";

  for (const [sympt, conseilText] of Object.entries(conseils)) {
    if (symptome.includes(sympt)) {
      conseil = conseilText + "\n\n📞 Support : " + CONFIG.SUPPORT_PHONE;
      break;
    }
  }

  await sendWhatsAppMessage(userId, conseil);
}

// =================== SUIVI DE COMMANDE ===================
async function gererSuiviCommande(userId) {
  const userState = userStates.get(userId) || DEFAULT_STATE;
  
  if (userState.derniereCommandeRef) {
    // Chercher la commande dans Firestore
    try {
      const commandeDoc = await db.collection('commandes').doc(userState.derniereCommandeRef).get();
      if (commandeDoc.exists) {
        const commande = commandeDoc.data();
        let statut = "⏳ En préparation";
        
        if (commande.statut === 'livree') statut = "✅ Livrée";
        else if (commande.statut === 'en_cours') statut = "🚚 En livraison";
        
        await sendWhatsAppMessage(
          userId,
          `📦 SUIVI COMMANDE\n\n` +
          `Numéro : ${commande.numeroCommande}\n` +
          `Statut : ${statut}\n` +
          `Date : ${new Date(commande.dateCreation).toLocaleDateString()}\n` +
          `Total : ${commande.total} FCFA\n\n` +
          `📞 Support : ${CONFIG.SUPPORT_PHONE}`
        );
        return;
      }
    } catch (error) {
      console.error('Erreur suivi commande:', error);
    }
  }
  
  await sendWhatsAppMessage(
    userId,
    "Je ne trouve pas de commande récente.\n\n" +
    "Tu peux nous contacter pour plus d'informations :\n" +
    `📞 Support : ${CONFIG.SUPPORT_PHONE}`
  );
}

// =================== ANNULATION ===================
async function annulerAction(userId, userState) {
  userState.step = 'MENU_PRINCIPAL';
  userState.attenteMedicament = false;
  userState.attenteCommande = false;
  userState.attenteNom = false;
  userState.attenteQuartier = false;
  userState.attenteWhatsApp = false;
  userState.attenteIndications = false;
  userState.resultatsRechercheMedicaments = null;
  userState.listeMedicamentsAvecIndex = [];
  userState.panier = [];
  userState.commandeEnCours = null;
  
  userStates.set(userId, userState);
  
  await sendWhatsAppMessage(
    userId,
    "Action annulée. Que souhaites-tu faire ?\n\n" +
    "💊 Commander un médicament\n" +
    "🏥 Pharmacie de garde\n" +
    "📅 Prendre rendez-vous\n" +
    "📦 Suivre une commande"
  );
}

// =================== FONCTIONS FIRESTORE ===================
async function creerCommandeFirestore(userId, userState, commande, numeroCommande) {
  try {
    const commandeData = {
      userId: userId,
      numeroCommande: numeroCommande,
      nom: commande.nom,
      quartier: commande.quartier,
      whatsapp: commande.whatsapp,
      indications: commande.indications,
      panier: commande.panier,
      sousTotal: commande.sousTotal,
      fraisLivraison: commande.fraisLivraison,
      total: commande.total,
      statut: 'en_preparation',
      dateCreation: new Date().toISOString(),
      dateMaj: new Date().toISOString(),
      zone: CONFIG.ZONE_SERVICE,
      supportPhone: CONFIG.SUPPORT_PHONE
    };

    const commandeRef = await db.collection('commandes').add(commandeData);
    
    // Mettre à jour l'état utilisateur
    userState.derniereCommandeRef = commandeRef.id;
    userState.historiqueCommandes = userState.historiqueCommandes || [];
    userState.historiqueCommandes.push({
      numero: numeroCommande,
      date: new Date().toISOString(),
      total: commande.total
    });
    
    userStates.set(userId, userState);
    
    console.log(`✅ Commande créée: ${numeroCommande} (${commandeRef.id})`);
    
    // Log pour administration
    await db.collection('logs_commandes').add({
      commandeId: commandeRef.id,
      numeroCommande: numeroCommande,
      userId: userId,
      total: commande.total,
      date: new Date().toISOString(),
      type: 'creation'
    });
    
    return commandeRef.id;
    
  } catch (error) {
    console.error('❌ Erreur création commande:', error.message);
    throw error;
  }
}

function reinitialiserEtatUtilisateur(userId, userState) {
  userState.step = 'MENU_PRINCIPAL';
  userState.panier = [];
  userState.pharmacieId = null;
  userState.pharmacieNom = null;
  userState.besoinOrdonnance = false;
  userState.attentePhoto = false;
  userState.commandeEnCours = null;
  userState.location = null;
  userState.quartier = null;
  userState.indications = null;
  userState.ordonnanceValidee = false;
  userState.ordonnancePhotoUrl = null;
  userState.resultatsRechercheMedicaments = null;
  userState.listeMedicamentsAvecIndex = [];
  userState.attenteMedicament = false;
  userState.attenteCommande = false;
  userState.attenteNom = false;
  userState.attenteQuartier = false;
  userState.attenteWhatsApp = false;
  userState.attenteIndications = false;
  userState.modeMulti = false;
  userState.dernierMedicamentAjoute = null;
  userState.apresCommande = true;
  
  userStates.set(userId, userState);
}

async function verifierDonneesInitiales() {
  try {
    console.log('🔍 Vérification des données initiales...');
    const collections = ['medicaments', 'pharmacies', 'centres_sante'];
    const stats = {};
    for (const collection of collections) {
      const snapshot = await db.collection(collection).limit(1).get();
      stats[collection] = !snapshot.empty;
    }
    console.log('✅ Données initiales vérifiées:', stats);
    return stats;
  } catch (error) {
    console.error('⚠️ Erreur vérification données:', error.message);
    return { error: error.message };
  }
}

// =================== WEBHOOK WHATSAPP ===================
app.get('/api/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === CONFIG.VERIFY_TOKEN) {
    console.log('✅ Webhook vérifié');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Échec vérification');
    res.status(403).send('Token invalide');
  }
});

app.post('/api/webhook', async (req, res) => {
  console.log('📩 Webhook POST reçu');
  
  // Répondre immédiatement à WhatsApp
  res.status(200).send('EVENT_RECEIVED');
  
  // Traitement asynchrone
  setTimeout(async () => {
    try {
      const entry = req.body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const message = value?.messages?.[0];
      
      if (!message) {
        console.log('📩 Message vide');
        return;
      }
      
      // Marquer comme lu
      if (message.id) {
        await markMessageAsRead(message.id);
      }
      
      // Ignorer messages non supportés
      if (message.type === 'unsupported' || message.type === 'system') {
        return;
      }
      
      const userId = message.from;
      const messageType = message.type;
      
      // État utilisateur
      let userState = userStates.get(userId);
      if (!userState) {
        userState = { ...DEFAULT_STATE };
        userStates.set(userId, userState);
      }
      
      if (messageType === 'text') {
        const text = message.text.body.trim();
        
        console.log(`💬 ${userId}: "${text}"`);
        
        // Vérifier doublons
        if (isDuplicateMessage(userId, text)) {
          console.log(`⚠️ Dupliqué ignoré: "${text}"`);
          return;
        }
        
        // Attente pour éviter conflits
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Traitement avec verrou
        await withUserLock(userId, async () => {
          // États de collecte d'informations
          if (userState.step === 'ATTENTE_NOM' ||
              userState.step === 'ATTENTE_QUARTIER' ||
              userState.step === 'ATTENTE_WHATSAPP' ||
              userState.step === 'ATTENTE_INDICATIONS') {
            
            await collecterInfosLivraison(userId, text, userState);
            return;
          }
          
          // États rendez-vous
          if (userState.attenteSpecialiteRdv ||
              userState.attenteSelectionCliniqueRdv ||
              userState.attenteDateRdv ||
              userState.attenteHeureRdv ||
              userState.attenteNomRdv ||
              userState.attenteTelephoneRdv) {
            
            await gererRendezVous(userId, text, userState);
            return;
          }
          
          // Gestion panier
          const resultatPanier = await gestionPanier.gererMessage(userId, text, userState);
          if (resultatPanier !== null) {
            return;
          }
          
          // Commande après recherche
          if (userState.attenteCommande && userState.listeMedicamentsAvecIndex) {
            await traiterSelectionMedicament(userId, text, userState);
            return;
          }
          
          // Recherche médicament
          if (userState.attenteMedicament) {
            await rechercherEtCommanderMedicament(userId, text);
            userState.attenteMedicament = false;
            userStates.set(userId, userState);
            return;
          }
          
          // Recherche par image
          if (userState.attenteMedicamentImage) {
            await rechercherEtCommanderMedicament(userId, text);
            userState.attenteMedicamentImage = false;
            userStates.set(userId, userState);
            return;
          }
          
          // Par défaut : intelligence IA
          await comprendreEtAgir(userId, text);
          
          userStates.set(userId, userState);
        });
        
      } else if (messageType === 'image') {
        // Traitement images (ordonnances, médicaments)
        if (userState.step === 'ATTENTE_ORDONNANCE') {
          await sendWhatsAppMessage(userId, "Ordonnance reçue. Maintenant envoie tes infos :\n\n1. Ton nom\n2. Ton quartier\n3. Ton WhatsApp\n4. Indications livraison\n\nCommence par ton nom :");
          userState.step = 'ATTENTE_NOM';
        } else {
          await sendWhatsAppMessage(userId, "Photo reçue. Écris le nom du médicament sur la photo.");
          userState.attenteMedicamentImage = true;
          userStates.set(userId, userState);
        }
      }
      
    } catch (error) {
      console.error('💥 ERREUR WEBHOOK:', error.message);
    }
  }, 200);
});

async function traiterSelectionMedicament(userId, text, userState) {
  const texte = text.toLowerCase().trim();
  
  // Ajouter avec numéro
  const ajouterRegex = /ajouter\s+(\d+)(?:\s+(\d+))?/i;
  const matchAjouter = texte.match(ajouterRegex);
  
  if (matchAjouter) {
    const numero = parseInt(matchAjouter[1]);
    const quantite = matchAjouter[2] ? parseInt(matchAjouter[2]) : 1;
    
    if (quantite < 1 || quantite > CONFIG.MAX_QUANTITE) {
      await sendWhatsAppMessage(userId, `Quantité invalide (1-${CONFIG.MAX_QUANTITE}).`);
      return;
    }
    
    const medicamentInfo = userState.listeMedicamentsAvecIndex.find(m => m.index === numero);
    
    if (!medicamentInfo) {
      await sendWhatsAppMessage(userId, "Numéro invalide.");
      return;
    }
    
    // Vérifier stock
    if (medicamentInfo.medicament.stock < quantite) {
      await sendWhatsAppMessage(userId, `Stock insuffisant. Il reste ${medicamentInfo.medicament.stock} disponible(s).`);
      return;
    }
    
    // Vérifier ordonnance
    if (medicamentInfo.medicament.necessiteOrdonnance) {
      await sendWhatsAppMessage(userId, `Ordonnance requise. Envoie la photo au support.\n\n📞 ${CONFIG.SUPPORT_PHONE}`);
      return;
    }
    
    // Ajouter au panier
    await gestionPanier.ajouterAuPanier(userId, medicamentInfo, quantite, userState);
  } else {
    // Vérifier commandes de panier
    const resultatPanier = await gestionPanier.gererMessage(userId, texte, userState);
    if (resultatPanier === null) {
      await sendWhatsAppMessage(
        userId,
        "Pour commander :\n" +
        '"ajouter [numéro] [quantité]"\n\n' +
        'Exemple :\n' +
        '"ajouter 1 2" pour 2 du médicament n°1'
      );
    }
  }
}

async function gererRendezVous(userId, text, userState) {
  const texte = text.toLowerCase().trim();
  
  if (userState.attenteSpecialiteRdv) {
    await gererPriseRendezVous(userId, texte);
    
  } else if (userState.attenteSelectionCliniqueRdv) {
    const numero = parseInt(texte);
    if (isNaN(numero) || numero < 1 || numero > userState.listeCliniquesRdv.length) {
      await sendWhatsAppMessage(userId, "Numéro invalide. Choisis un numéro de la liste.");
      return;
    }
    
    const clinique = userState.listeCliniquesRdv[numero - 1];
    userState.cliniqueSelectionneeRdv = clinique;
    userState.attenteSelectionCliniqueRdv = false;
    userState.attenteDateRdv = true;
    userStates.set(userId, userState);
    
    await sendWhatsAppMessage(
      userId,
      `Parfait ! ${clinique.nom}\n\n` +
      `Quelle date souhaites-tu ?\n` +
      `Exemple : "demain", "lundi", "15 février"`
    );
    
  } else if (userState.attenteDateRdv) {
    userState.dateRdv = texte;
    userState.attenteDateRdv = false;
    userState.attenteHeureRdv = true;
    userStates.set(userId, userState);
    
    await sendWhatsAppMessage(
      userId,
      `Quelle heure ?\n` +
      `Exemple : "9h", "14h30", "dans l'après-midi"`
    );
    
  } else if (userState.attenteHeureRdv) {
    userState.heureRdv = texte;
    userState.attenteHeureRdv = false;
    userState.attenteNomRdv = true;
    userStates.set(userId, userState);
    
    await sendWhatsAppMessage(
      userId,
      `Ton nom complet ?`
    );
    
  } else if (userState.attenteNomRdv) {
    userState.nomRdv = texte;
    userState.attenteNomRdv = false;
    userState.attenteTelephoneRdv = true;
    userStates.set(userId, userState);
    
    await sendWhatsAppMessage(
      userId,
      `Ton numéro WhatsApp ?`
    );
    
  } else if (userState.attenteTelephoneRdv) {
    const numero = texte.trim().replace(/\s+/g, '');
    let numeroValide = numero;
    
    if (!numero.startsWith('+225') && !numero.startsWith('225')) {
      if (numero.startsWith('0') || numero.startsWith('7')) {
        numeroValide = '+225' + numero.replace(/^0/, '');
      } else {
        numeroValide = '+225' + numero;
      }
    } else if (numero.startsWith('225')) {
      numeroValide = '+' + numero;
    }
    
    // Confirmer le rendez-vous
    const clinique = userState.cliniqueSelectionneeRdv;
    
    await sendWhatsAppMessage(
      userId,
      `✅ RENDEZ-VOUS PRIS\n\n` +
      `Clinique : ${clinique.nom}\n` +
      `Spécialité : ${userState.specialiteRdv}\n` +
      `Date : ${userState.dateRdv}\n` +
      `Heure : ${userState.heureRdv}\n` +
      `Nom : ${userState.nomRdv}\n` +
      `Téléphone : ${numeroValide}\n\n` +
      `La clinique te contactera pour confirmation.\n\n` +
      `📞 Support : ${CONFIG.SUPPORT_PHONE}`
    );
    
    // Réinitialiser
    userState.attenteTelephoneRdv = false;
    userState.specialiteRdv = null;
    userState.listeCliniquesRdv = null;
    userState.cliniqueSelectionneeRdv = null;
    userState.dateRdv = null;
    userState.heureRdv = null;
    userState.nomRdv = null;
    userState.apresRendezVous = true;
    userStates.set(userId, userState);
  }
}

// =================== ENDPOINTS ADMIN ===================
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'PILLBOX WhatsApp Bot PRODUCTION',
    version: '1.0.0',
    users_actifs: userStates.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    zone_service: CONFIG.ZONE_SERVICE,
    support_phone: CONFIG.SUPPORT_PHONE
  });
});

app.get('/api/stats', (req, res) => {
  const stats = {
    users_actifs: userStates.size,
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    uptime: process.uptime(),
    port: PORT
  };
  res.json(stats);
});

app.get('/api/test', async (req, res) => {
  try {
    const medicamentsCount = (await db.collection('medicaments').where('stock', '>', 0).limit(1).get()).size;
    const pharmaciesCount = (await db.collection('pharmacies').where('estDeGarde', '==', true).limit(1).get()).size;
    const cliniquesCount = (await db.collection('centres_sante').where('estVerifie', '==', true).limit(1).get()).size;

    res.json({
      status: 'OK',
      firebase: {
        medicaments: medicamentsCount > 0,
        pharmacies: pharmaciesCount > 0,
        cliniques: cliniquesCount > 0
      },
      whatsapp: CONFIG.PHONE_NUMBER_ID ? 'Configured' : 'Not configured',
      groq: CONFIG.GROQ_API_KEY ? 'Configured' : 'Not configured',
      service: CONFIG.ZONE_SERVICE,
      support: CONFIG.SUPPORT_PHONE
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =================== DÉMARRAGE SERVEUR ===================
app.listen(PORT, HOST, () => {
  console.log(`
=======================================================
🚀 PILLBOX - SOLUTION WHATSAPP PRODUCTION
=======================================================
📍 Port: ${PORT}
🏙️ Zone: ${CONFIG.ZONE_SERVICE}
🤖 Intelligence: IA Conversationnelle
💊 Services: Commandes, Pharmacies, Cliniques, Rendez-vous
📦 Livraison: Jour & Nuit
📞 Support: ${CONFIG.SUPPORT_PHONE}
=======================================================
✅ PRÊT À RECEVOIR DES MESSAGES !
✅ Base de données réelle
✅ Gestion intelligente des conversations
✅ Commandes WhatsApp directes
✅ Notifications en temps réel
✅ Support 24h/24
=======================================================
  `);
});

// Nettoyage périodique
setInterval(() => {
  const now = Date.now();
  const deuxHeures = 2 * 60 * 60 * 1000;
  
  for (const [userId, state] of userStates.entries()) {
    const lastMessage = state.historiqueMessages?.[state.historiqueMessages?.length - 1];
    if (lastMessage) {
      const lastActive = new Date(lastMessage.timestamp).getTime();
      if (now - lastActive > deuxHeures) {
        console.log(`🧹 Nettoyage: ${userId}`);
        userStates.delete(userId);
      }
    }
  }
  
  for (const [userId, lockTime] of processingLocks.entries()) {
    if (now - lockTime > 30000) {
      processingLocks.delete(userId);
    }
  }
  
  for (const [key, value] of messageCache.entries()) {
    if (now - value.timestamp > CACHE_DURATION * 10) {
      messageCache.delete(key);
    }
  }
}, 10 * 60 * 1000);

// Gestion erreurs
process.on('uncaughtException', (error) => {
  console.error('💥 ERREUR NON GÉRÉE:', error.message);
  console.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 PROMISE REJECTION:', reason);
});