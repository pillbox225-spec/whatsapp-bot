require('dotenv').config();
const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

// Initialisation Express
const app = express();
app.use(express.json());

// Configuration pour Render.com
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

// Configuration Firebase
let db;
let FieldValue;

// Initialisation Firebase
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

    // Vérification des données initiales
    await verifierDonneesInitiales();
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
  SUPPORT_PHONE: "+2250701406868",
  LIVRAISON_JOUR: 400,
  LIVRAISON_NUIT: 600
};

// =================== GESTIONNAIRE DE CONTEXTE ===================
class GestionnaireContexte {
  constructor() {
    this.motsClesSymptomes = {
      douleur: ['douleur', 'souffre', 'mal', 'fait mal', 'douloureux', 'souffrance'],
      fievre: ['fièvre', 'chaud', 'température', 'frissons', 'brûlant'],
      toux: ['tousse', 'toux', 'toussant', 'tussif'],
      fatigue: ['fatigue', 'fatigué', 'épuisé', 'lassitude'],
      nausee: ['nausée', 'vomir', 'vomissement', 'mal au cœur'],
      diarrhee: ['diarrhée', 'selles', 'intestin', 'gastro'],
      mauxTete: ['mal de tête', 'céphalée', 'migraine', 'céphalalgie', 'mal a la tête', 'mal a tête'],
      allergie: ['allergie', 'allergique', 'réaction', 'urticaire']
    };

    this.motsClesEmotionnels = {
      urgent: ['urgent', 'vite', 'immédiat', 'dépêche', 'rapide', 'urgence'],
      stress: ['stress', 'nerveux', 'anxieux', 'inquiet', 'panique', 'angoissé'],
      douleurForte: ['atroce', 'insupportable', 'violent', 'fort', 'intense'],
      satisfaction: ['merci', 'parfait', 'super', 'génial', 'content', 'satisfait'],
      confusion: ['quoi', 'comment', 'hein', 'pardon', 'je comprends pas', 'ahok']
    };
  }

  async mettreAJourContexte(userId, message, role = 'user') {
    const userState = userStates.get(userId) || { ...DEFAULT_STATE };
    if (!userState.contexte) {
      userState.contexte = JSON.parse(JSON.stringify(DEFAULT_STATE.contexte));
    }
    userState.contexte.historiqueConversation.push({
      role,
      message,
      timestamp: new Date().toISOString()
    });
    if (userState.contexte.historiqueConversation.length > 50) {
      userState.contexte.historiqueConversation = userState.contexte.historiqueConversation.slice(-50);
    }
    if (role === 'user') {
      await this.analyserMessageUtilisateur(userId, message, userState);
    }
    this.mettreAJourReferences(userId, message, userState);
    userStates.set(userId, userState);
    return userState.contexte;
  }

  async analyserMessageUtilisateur(userId, message, userState) {
    const texte = message.toLowerCase();
    const symptomesDetectes = this.detecterSymptomes(texte);
    if (symptomesDetectes.length > 0) {
      symptomesDetectes.forEach(symptome => {
        if (!userState.contexte.medical.symptomesActuels.includes(symptome)) {
          userState.contexte.medical.symptomesActuels.push(symptome);
        }
      });
    }
    this.analyserEtatEmotionnel(userId, texte, userState);
    this.detecterReferencesImplicites(userId, texte, userState);
    this.extraireInformationsProfil(texte, userState);
    this.enregistrerMedicamentsMentionnes(texte, userState);
    this.detecterConfusion(texte, userState);
  }

  detecterSymptomes(texte) {
    const symptomes = [];
    for (const [symptome, motsCles] of Object.entries(this.motsClesSymptomes)) {
      for (const motCle of motsCles) {
        if (texte.includes(motCle)) {
          symptomes.push(symptome);
          break;
        }
      }
    }
    return [...new Set(symptomes)];
  }

  analyserEtatEmotionnel(userId, texte, userState) {
    let urgence = 0, stress = 0, douleurForte = 0, satisfaction = 0, confusion = 0;
    for (const [emotion, mots] of Object.entries(this.motsClesEmotionnels)) {
      for (const mot of mots) {
        if (texte.includes(mot)) {
          switch (emotion) {
            case 'urgent': urgence += 2; stress += 1; break;
            case 'stress': stress += 2; break;
            case 'douleurForte': douleurForte += 3; urgence += 1; break;
            case 'satisfaction': satisfaction += 2; break;
            case 'confusion': confusion += 2; break;
          }
        }
      }
    }
    const pointsExclamation = (texte.match(/!/g) || []).length;
    const pointsInterrogation = (texte.match(/\?/g) || []).length;
    const majuscules = (texte.match(/[A-Z]/g) || []).length;
    urgence += pointsExclamation * 0.5;
    stress += pointsInterrogation * 0.3;
    if (majuscules > texte.length * 0.2) { urgence += 1; stress += 1; }
    userState.contexte.emotionnel.urgenceNiveau = Math.min(10, Math.max(0, urgence));
    userState.contexte.emotionnel.frustrationNiveau = Math.min(10, Math.max(0, stress));
    userState.contexte.emotionnel.confusionNiveau = Math.min(10, Math.max(0, confusion));
    if (satisfaction > 2) userState.contexte.emotionnel.ton = 'satisfait';
    else if (urgence > 3) userState.contexte.emotionnel.ton = 'pressé';
    else if (stress > 3) userState.contexte.emotionnel.ton = 'stressé';
    else if (douleurForte > 2) userState.contexte.emotionnel.ton = 'douloureux';
    else if (confusion > 2) userState.contexte.emotionnel.ton = 'confus';
    else userState.contexte.emotionnel.ton = 'neutre';
    userState.contexte.emotionnel.derniereInteractionPositive = satisfaction > 1;
  }

  detecterConfusion(texte, userState) {
    const motsConfusion = ['quoi', 'comment', 'hein', 'pardon', 'je comprends pas', 'ahok'];
    const estConfus = motsConfusion.some(mot => texte.includes(mot));
    if (estConfus) {
      userState.contexte.emotionnel.confusionNiveau = Math.min(10, userState.contexte.emotionnel.confusionNiveau + 2);
      userState.contexte.emotionnel.ton = 'confus';
    }
  }

  detecterReferencesImplicites(userId, texte, userState) {
    const references = userState.contexte.references;
    const pronoms = ['celui', 'celle', 'ceux', 'celles', 'ce', 'cet', 'cette'];
    const mots = texte.split(/\s+/);
    for (const mot of mots) {
      if (pronoms.includes(mot.toLowerCase())) {
        references.dernierPronom = mot.toLowerCase();
        break;
      }
    }
    if (texte.includes("que tu as dit") || texte.includes("dont tu parlais") || texte.includes("mentionné") || texte.includes("précédent")) {
      references.derniereEntite = references.derniereEntite;
    }
    if (userState.contexte.historiqueConversation.length > 1) {
      const derniersMessages = userState.contexte.historiqueConversation.slice(-3).map(m => `${m.role}: ${m.message}`).join(' | ');
      references.contextePrecedent = derniersMessages;
    }
  }

  extraireInformationsProfil(texte, userState) {
    const ageMatch = texte.match(/(\d+)\s*(ans?|âge)/i);
    if (ageMatch) userState.contexte.profil.age = parseInt(ageMatch[1]);
    if (texte.includes('je suis un homme') || texte.includes('monsieur')) userState.contexte.profil.sexe = 'M';
    else if (texte.includes('je suis une femme') || texte.includes('madame')) userState.contexte.profil.sexe = 'F';
    const allergieMatch = texte.match(/allerg(?:ie|ique)\s+(?:à|au)\s+([^\.\?]+)/i);
    if (allergieMatch) userState.contexte.profil.preferences.allergies.push(allergieMatch[1].trim());
    const conditions = ['diabète', 'hypertension', 'asthme', 'cardiaque', 'épilepsie'];
    conditions.forEach(condition => {
      if (texte.includes(condition)) userState.contexte.profil.preferences.conditionsChroniques.push(condition);
    });
  }

  enregistrerMedicamentsMentionnes(texte, userState) {
    const medicamentsConnus = ['paracétamol', 'paracetamol', 'doliprane', 'ibuprofène', 'advil', 'amoxicilline', 'vitamine c', 'aspirine', 'ventoline', 'insuline', 'sirop'];
    medicamentsConnus.forEach(medicament => {
      if (texte.includes(medicament)) {
        if (!userState.contexte.medical.medicamentsRecherches.includes(medicament)) {
          userState.contexte.medical.medicamentsRecherches.push(medicament);
        }
        userState.contexte.medical.dernierMedicamentMentionne = medicament;
      }
    });
  }

  mettreAJourReferences(userId, message, userState) {
    const references = userState.contexte.references;
    const entites = ['médicament', 'pharmacie', 'clinique', 'médecin', 'symptôme'];
    entites.forEach(entite => {
      if (message.toLowerCase().includes(entite)) references.derniereEntite = entite;
    });
    const actions = ['commander', 'acheter', 'rechercher', 'trouver', 'prendre rdv'];
    actions.forEach(action => {
      if (message.toLowerCase().includes(action)) references.derniereAction = action;
    });
  }

  obtenirResumeContexte(userId) {
    const userState = userStates.get(userId);
    if (!userState?.contexte) return '';
    const ctx = userState.contexte;
    let resume = '';
    if (ctx.profil.nom || ctx.profil.age) {
      resume += `**Profil:** `;
      if (ctx.profil.nom) resume += `Nom: ${ctx.profil.nom}, `;
      if (ctx.profil.age) resume += `Âge: ${ctx.profil.age}, `;
      if (ctx.profil.sexe) resume += `Sexe: ${ctx.profil.sexe}, `;
      if (ctx.profil.quartier) resume += `Quartier: ${ctx.profil.quartier}`;
      resume += `\n`;
    }
    if (ctx.medical.symptomesActuels.length > 0) resume += `**Symptômes actuels:** ${ctx.medical.symptomesActuels.join(', ')}\n`;
    if (ctx.medical.medicamentsRecherches.length > 0) resume += `**Médicaments recherchés:** ${ctx.medical.medicamentsRecherches.join(', ')}\n`;
    if (ctx.emotionnel.ton !== 'neutre') {
      resume += `**État émotionnel:** ${ctx.emotionnel.ton} `;
      if (ctx.emotionnel.urgenceNiveau > 5) resume += `(urgence: ${ctx.emotionnel.urgenceNiveau}/10)`;
      if (ctx.emotionnel.confusionNiveau > 3) resume += ` (confus: ${ctx.emotionnel.confusionNiveau}/10)`;
      resume += `\n`;
    }
    if (ctx.medical.dernierMedicamentMentionne) resume += `**Dernier médicament mentionné:** ${ctx.medical.dernierMedicamentMentionne}\n`;
    if (ctx.historiqueConversation.length > 1) {
      const derniersMessages = ctx.historiqueConversation.slice(-4).map(msg => `${msg.role === 'user' ? 'User' : 'Asst'}: ${msg.message.substring(0, 40)}...`).join(' | ');
      resume += `**Contexte récent:** ${derniersMessages}\n`;
    }
    return resume;
  }

  interpreterReference(userId, reference) {
    const userState = userStates.get(userId);
    if (!userState?.contexte) return null;
    const ctx = userState.contexte;
    if (reference.includes("celui") || reference.includes("ce médicament")) return ctx.medical.dernierMedicamentMentionne;
    if (reference.includes("ce symptôme") || reference.includes("cette douleur")) return ctx.medical.symptomesActuels[ctx.medical.symptomesActuels.length - 1];
    if (reference.includes("cette pharmacie")) return ctx.transactionnel.pharmaciesConsultees[ctx.transactionnel.pharmaciesConsultees.length - 1];
    return null;
  }
}

const gestionnaireContexte = new GestionnaireContexte();

// =================== GESTION DU PANIER MULTI-MÉDICAMENTS ===================
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
    if (!userState.panier) { userState.panier = []; userStates.set(userId, userState); }
    if (texte.includes('plusieurs') || texte.includes('multi') || texte.includes('différents') || texte.includes('plus d\'un')) return this.demarrerModeMulti(userId, userState);
    if (texte === 'continuer' || texte === 'oui' || texte === 'encore') {
      if (userState.panier.length > 0) return this.demanderAutreMedicament(userId, userState);
      else return this.demanderPremierMedicament(userId, userState);
    }
    if (texte === 'terminer' || texte === 'fini' || texte === 'finaliser') {
      if (userState.panier.length > 0) return this.finaliserPanier(userId, userState);
      else { await sendWhatsAppMessage(userId, "Votre panier est vide. Dites-moi un médicament."); return; }
    }
    if (texte === 'panier' || texte === 'voir panier' || texte === 'mon panier') return this.afficherPanier(userId, userState);
    if (texte === 'vider' || texte === 'vider panier' || texte === 'recommencer') return this.viderPanier(userId, userState);
    return null;
  }

  async demarrerModeMulti(userId, userState) {
    userState.modeMulti = true;
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "Mode multi-médicaments activé. Dites-moi le premier médicament.");
    userState.attenteMedicament = true;
    userStates.set(userId, userState);
  }

  async demanderPremierMedicament(userId, userState) {
    await sendWhatsAppMessage(userId, "Dites-moi le nom du médicament que vous souhaitez.");
    userState.attenteMedicament = true;
    userStates.set(userId, userState);
  }

  async demanderAutreMedicament(userId, userState) {
    await sendWhatsAppMessage(userId, "Dites-moi le nom du prochain médicament.");
    userState.attenteMedicament = true;
    userStates.set(userId, userState);
  }

  async ajouterAuPanier(userId, medicamentInfo, quantite = 1) {
    const userState = userStates.get(userId) || { ...DEFAULT_STATE };
    if (!userState.panier) userState.panier = [];
    const indexExistant = userState.panier.findIndex(item => item.medicamentId === medicamentInfo.medicamentId);
    if (indexExistant >= 0) userState.panier[indexExistant].quantite += quantite;
    else {
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
    await this.demanderContinuation(userId, userState);
  }

  async demanderContinuation(userId, userState) {
    const panier = userState.panier || [];
    await sendWhatsAppMessage(
      userId,
      `✅ Ajouté au panier.\n\n` +
      `Votre panier (${panier.length} médicament(s)) :\n\n` +
      this.formaterPanier(panier) + `\n` +
      `Que souhaitez-vous faire ?\n` +
      `"continuer" pour ajouter un autre médicament\n` +
      `"terminer" pour finaliser ma commande\n` +
      `"panier" pour afficher mon panier\n` +
      `"vider" pour vider et recommencer`
    );
  }

  async afficherPanier(userId, userState) {
    const panier = userState.panier || [];
    if (panier.length === 0) { await sendWhatsAppMessage(userId, "Votre panier est vide."); return; }
    const { sousTotal, fraisLivraison, total } = this.calculerTotal(panier);
    await sendWhatsAppMessage(
      userId,
      `🛒 Votre panier (${panier.length} médicament(s))\n\n` +
      this.formaterPanier(panier) + `\n` +
      `💰 Sous-total : ${sousTotal} FCFA\n` +
      `🚚 Livraison : ${fraisLivraison} FCFA\n` +
      `💵 TOTAL : ${total} FCFA\n\n` +
      `"continuer" pour ajouter un médicament\n` +
      `"terminer" pour finaliser\n` +
      `"vider" pour vider le panier`
    );
  }

  async viderPanier(userId, userState) {
    userState.panier = [];
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "🗑️ Panier vidé. Dites-moi un médicament pour commencer.");
    userState.attenteMedicament = true;
    userStates.set(userId, userState);
  }

  async finaliserPanier(userId, userState) {
    const panier = userState.panier || [];
    if (panier.length === 0) { await sendWhatsAppMessage(userId, "Votre panier est vide."); return; }
    const { sousTotal, fraisLivraison, total } = this.calculerTotal(panier);
    const ordonnanceRequise = panier.some(item => item.necessiteOrdonnance);
    await sendWhatsAppMessage(
      userId,
      `✅ Panier finalisé\n\n` +
      `Votre commande (${panier.length} médicament(s)) :\n\n` +
      this.formaterPanier(panier) + `\n` +
      `💵 TOTAL : ${total} FCFA\n\n` +
      (ordonnanceRequise ?
        `📄 Ordonnance requise. Envoyez la photo de votre ordonnance.` :
        `Pour finaliser, envoyez vos informations une par une :\n\n` +
        `1. **Nom complet**\n` +
        `2. **Quartier**\n` +
        `3. **Numéro WhatsApp**\n` +
        `4. **Indications pour la livraison**\n\n` +
        `Commencez par votre nom :`)
    );
    userState.commandeEnCours = {
      panier: panier,
      sousTotal: sousTotal,
      fraisLivraison: fraisLivraison,
      total: total,
      ordonnanceRequise: ordonnanceRequise,
      etapeLivraison: ordonnanceRequise ? 'ATTENTE_ORDONNANCE_MULTI' : 'ATTENTE_NOM'
    };
    userState.step = ordonnanceRequise ? 'ATTENTE_ORDONNANCE_MULTI' : 'ATTENTE_NOM_MULTI';
    userStates.set(userId, userState);
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
    const sousTotal = panier.reduce((total, item) => total + (item.prixUnitaire * item.quantite), 0);
    const fraisLivraison = getFraisLivraison();
    const total = sousTotal + fraisLivraison;
    return { sousTotal, fraisLivraison, total };
  }
}

const gestionPanier = new GestionPanier();

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
  initialized: false,
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
  contexte: {
    historiqueConversation: [],
    profil: {
      nom: null,
      age: null,
      sexe: null,
      quartier: null,
      preferences: {
        pharmaciePreferee: null,
        modePaiementPrefere: null,
        allergies: [],
        conditionsChroniques: [],
        medicamentsReguliers: []
      }
    },
    medical: {
      symptomesActuels: [],
      symptomesHistorique: [],
      medicamentsRecherches: [],
      dernierDiagnosticMentionne: null,
      dernierMedicamentMentionne: null,
      derniereSpecialiteMentionnee: null
    },
    transactionnel: {
      derniereCommande: null,
      dernierRendezVous: null,
      pharmaciesConsultees: [],
      cliniquesConsultees: []
    },
    emotionnel: {
      ton: 'neutre',
      urgenceNiveau: 0,
      frustrationNiveau: 0,
      confusionNiveau: 0,
      derniereInteractionPositive: false
    },
    references: {
      dernierPronom: null,
      derniereEntite: null,
      derniereAction: null,
      contextePrecedent: null
    }
  }
};

const userStates = new Map();
const processingLocks = new Map();
const messageCache = new Map();
const CACHE_DURATION = 2000;

// =================== FONCTIONS UTILITAIRES ===================
function isDuplicateMessage(userId, message) {
  const cacheKey = `${userId}_${message}`;
  const now = Date.now();
  const cached = messageCache.get(cacheKey);
  if (cached && (now - cached.timestamp < CACHE_DURATION)) return true;
  messageCache.set(cacheKey, { timestamp: now, message });
  for (const [key, value] of messageCache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) messageCache.delete(key);
  }
  return false;
}

async function withUserLock(userId, callback) {
  if (processingLocks.has(userId)) { console.log(`⏳ ${userId} est déjà en traitement`); return null; }
  processingLocks.set(userId, Date.now());
  try {
    return await callback();
  } finally {
    setTimeout(() => {
      if (processingLocks.get(userId) === Date.now() - processingLocks.get(userId) > 30000) processingLocks.delete(userId);
    }, 30000);
    processingLocks.delete(userId);
  }
}

function getFraisLivraison() {
  const maintenant = new Date();
  const heure = maintenant.getHours();
  return (heure >= 0 && heure < 8) ? CONFIG.LIVRAISON_NUIT : CONFIG.LIVRAISON_JOUR;
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
        timeout: 10000
      }
    );
  } catch (error) {
    console.error('❌ Erreur marquage message comme lu:', error.response?.data || error.message);
  }
}

// =================== CERVEAU PRINCIPAL INTELLIGENT - GROQ ===================
async function comprendreEtAgir(userId, message) {
  console.log(`🧠 Analyse intelligente: "${message}"`);
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };
  const contexte = await gestionnaireContexte.mettreAJourContexte(userId, message, 'user');
  const resumeContexte = gestionnaireContexte.obtenirResumeContexte(userId);

  try {
    const prompt = `
Tu es Mia, assistante médicale à San Pedro. Tu utilises UNIQUEMENT les données réelles de la base.

## CONTEXTE DE LA CONVERSATION:
${resumeContexte}

## DERNIER MESSAGE UTILISATEUR:
"${message}"

## RÈGLES ABSOLUES :
1. NE JAMAIS inventer de pharmacies, cliniques ou médicaments
2. TOUTES les informations doivent venir de la base de données
3. Si une pharmacie/clinique n'existe pas dans la base, dire "Je ne trouve pas dans la base"
4. Service uniquement à San Pedro

## CE QUE JE PEUX FAIRE RÉELLEMENT (avec la base) :
1. **RECHERCHER_MEDICAMENT** → Chercher un médicament EXACT dans la base
2. **AFFICHER_PHARMACIES_GARDE** → Afficher pharmacies DE GARDE réelles
3. **AFFICHER_CLINIQUES** → Lister cliniques VÉRIFIÉES
4. **PRENDRE_RDV** → Organiser rendez-vous avec spécialité réelle
5. **GESTION_PANIER** → Gérer panier commande
6. **REPONSE_SIMPLE** → Réponses courtes et naturelles

## ANALYSE DU MESSAGE UTILISATEUR:
1. Médicament mentionné? (paracetamol/paracétamol/doliprane/ibuprofène/etc.)
2. Demande pharmacies de garde?
3. Demande cliniques?
4. Demande rendez-vous?
5. Remerciement?
6. Autre demande?

## RÉPONSE (JSON uniquement):
{
  "action": "ACTION_CORRECTE",
  "reponse": "réponse courte naturelle",
  "parametres": {} ou null,
  "next_step": "étape_suivante"
}

## EXEMPLES:
Utilisateur: "Paracetamol"
→ L'utilisateur veut ce médicament
{
  "action": "RECHERCHER_MEDICAMENT",
  "reponse": "Je cherche du paracétamol...",
  "parametres": {"nom_medicament": "paracetamol"},
  "next_step": "RECHERCHE_MEDICAMENT"
}
`;

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: CONFIG.GROQ_MODEL,
        messages: [
          { role: "system", content: "Tu es une assistante médicale qui utilise uniquement la base de données réelle. Réponds UNIQUEMENT en JSON." },
          { role: "user", content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 400,
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
    console.log('🧠 Résultat analyse:', JSON.stringify(result));
    await sendWhatsAppMessage(userId, result.reponse);
    await executerActionReelle(userId, result, message, userState);
    await gestionnaireContexte.mettreAJourContexte(userId, result.reponse, 'assistant');
    return result;
  } catch (error) {
    console.error('❌ Erreur analyse intelligente:', error.message);
    await sendWhatsAppMessage(userId, "Je rencontre un problème technique. Réessaye.");
  }
}

// =================== EXÉCUTION RÉELLE DES ACTIONS ===================
async function executerActionReelle(userId, result, messageOriginal, userState) {
  const action = result.action;
  const parametres = result.parametres || {};
  const texteOriginal = messageOriginal.toLowerCase();

  console.log(`🤖 Exécution action: ${action}`);

  if (action === 'AFFICHER_PHARMACIES_GARDE' || action === 'AFFICHER_CLINIQUES' || action === 'PRENDRE_RDV') {
    userState.attenteCommande = false;
    userState.attenteMedicament = false;
    userState.step = 'MENU_PRINCIPAL';
  }

  if (action === 'REPONSE_SIMPLE') {
    if (parametres.type === 'remerciement') {
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
      userState.apresCommande = false;
      userState.apresRendezVous = false;
    }
    userStates.set(userId, userState);

  } else if (action === 'RECHERCHER_MEDICAMENT') {
    const nomMedicament = parametres.nom_medicament || extraireNomMedicament(texteOriginal);
    const pharmacieSpecifique = parametres.pharmacie_nom || extrairePharmacieSpecifique(texteOriginal);
    if (nomMedicament) await rechercherMedicamentReel(userId, nomMedicament, pharmacieSpecifique);

  } else if (action === 'AFFICHER_PHARMACIES_GARDE') {
    userState.step = 'MENU_PRINCIPAL';
    userStates.set(userId, userState);
    await afficherPharmaciesDeGardeReelles(userId);

  } else if (action === 'AFFICHER_CLINIQUES') {
    userState.step = 'MENU_PRINCIPAL';
    userStates.set(userId, userState);
    await afficherCliniquesReelles(userId);

  } else if (action === 'PRENDRE_RDV') {
    const specialite = parametres.specialite || extraireSpecialite(texteOriginal);
    const cliniqueSpecifique = parametres.clinique_nom || extraireCliniqueSpecifique(texteOriginal);
    if (specialite || cliniqueSpecifique) await gererPriseRendezVousReel(userId, specialite, cliniqueSpecifique);
    else {
      userState.attenteSpecialiteRdv = true;
      userStates.set(userId, userState);
      await sendWhatsAppMessage(userId, "Avec quel type de médecin tu veux consulter ?");
    }

  } else if (action === 'GESTION_PANIER') {
    userStates.set(userId, userState);
  }
}

// =================== FONCTIONS D'EXTRACTION ===================
function extraireNomMedicament(texte) {
  const medicamentsAlias = {
    'paracetamol': ['paracetamol', 'paracétamol', 'paracetemol', 'paracetamol', 'paracetamol'],
    'doliprane': ['doliprane', 'dolipran', 'doliprene'],
    'ibuprofene': ['ibuprofène', 'ibuprofene', 'ibuprofen', 'advil'],
    'amoxicilline': ['amoxicilline', 'amoxiciline', 'amoxicilin', 'clamoxyl', 'augmentin'],
    'aspirine': ['aspirine', 'aspirin', 'aspegic'],
    'vitamine c': ['vitamine c', 'vitaminec', 'vit c'],
    'sirop': ['sirop', 'sirop contre la toux', 'toux']
  };
  const texteLower = texte.toLowerCase();
  for (const [medicamentBase, aliases] of Object.entries(medicamentsAlias)) {
    for (const alias of aliases) {
      if (texteLower.includes(alias)) return medicamentBase;
    }
  }
  return null;
}

function extrairePharmacieSpecifique(texte) {
  const pharmaciesConnues = ['cosmos', 'la paix', 'central', 'principale', 'du centre'];
  const texteLower = texte.toLowerCase();
  for (const pharmacie of pharmaciesConnues) {
    if (texteLower.includes(pharmacie)) return pharmacie;
  }
  return null;
}

function extraireCliniqueSpecifique(texte) {
  const cliniquesConnues = ['pastora', 'saint', 'centrale', 'principal', 'polyclinique'];
  const texteLower = texte.toLowerCase();
  for (const clinique of cliniquesConnues) {
    if (texteLower.includes(clinique)) return clinique;
  }
  return null;
}

function extraireSpecialite(texte) {
  const specialites = [
    'dermatologue', 'dermatologie', 'cardiologue', 'cardiologie', 'gynécologue', 'gynécologie',
    'pédiatre', 'pédiatrie', 'médecin généraliste', 'généraliste', 'médecin', 'dentiste', 'dentaire',
    'ophtalmologue', 'ophtalmologie', 'radiologue', 'radiologie', 'psychiatre', 'psychiatrie',
    'chirurgien', 'chirurgie', 'urgences', 'urgence'
  ];
  const texteLower = texte.toLowerCase();
  for (const specialite of specialites) {
    if (texteLower.includes(specialite)) return specialite;
  }
  return null;
}

// =================== RECHERCHE RÉELLE DE MÉDICAMENTS ===================
async function rechercherMedicamentReel(userId, nomMedicament, pharmacieSpecifique = null) {
  try {
    console.log(`🔍 Recherche réelle: ${nomMedicament}${pharmacieSpecifique ? ` dans ${pharmacieSpecifique}` : ''}`);
    const termeRecherche = nomMedicament.toLowerCase().trim();
    const medicamentsSnapshot = await db.collection('medicaments').where('stock', '>', 0).limit(20).get();
    const medicamentsFiltres = [];
    medicamentsSnapshot.docs.forEach(doc => {
      const medicament = { id: doc.id, ...doc.data() };
      const nomMed = (medicament.nom || '').toLowerCase();
      const sousTitre = (medicament.sousTitre || '').toLowerCase();
      if (nomMed.includes(termeRecherche) || sousTitre.includes(termeRecherche) || termeRecherche.includes(nomMed) || termeRecherche.includes(sousTitre)) {
        medicamentsFiltres.push(medicament);
      }
    });
    if (pharmacieSpecifique && medicamentsFiltres.length > 0) {
      const pharmaciesSnapshot = await db.collection('pharmacies').where('estOuvert', '==', true).limit(10).get();
      const pharmacieTrouvee = pharmaciesSnapshot.docs.find(doc => {
        const pharmacie = doc.data();
        const nomPharma = (pharmacie.nom || '').toLowerCase();
        return nomPharma.includes(pharmacieSpecifique.toLowerCase());
      });
      if (pharmacieTrouvee) {
        const pharmacieData = pharmacieTrouvee.data();
        const medicamentsPharmacie = medicamentsFiltres.filter(m => m.pharmacieId === pharmacieTrouvee.id);
        if (medicamentsPharmacie.length > 0) {
          await afficherResultatsMedicament(userId, medicamentsPharmacie, pharmacieTrouvee.id, pharmacieData.nom);
          return;
        }
      }
    }
    if (medicamentsFiltres.length === 0) {
      await sendWhatsAppMessage(userId, `Je ne trouve pas "${nomMedicament}" en stock.\n\n📞 Support : ${CONFIG.SUPPORT_PHONE}`);
      return;
    }
    const medicamentsParPharmacie = {};
    for (const medicament of medicamentsFiltres) {
      if (!medicament.pharmacieId) continue;
      if (!medicamentsParPharmacie[medicament.pharmacieId]) {
        medicamentsParPharmacie[medicament.pharmacieId] = { medicaments: [], pharmacieId: medicament.pharmacieId };
      }
      medicamentsParPharmacie[medicament.pharmacieId].medicaments.push(medicament);
    }
    const pharmacieIds = Object.keys(medicamentsParPharmacie);
    const pharmaciesMap = new Map();
    for (const pharmacieId of pharmacieIds) {
      try {
        const pharmacieDoc = await db.collection('pharmacies').doc(pharmacieId).get();
        if (pharmacieDoc.exists) pharmaciesMap.set(pharmacieId, { id: pharmacieDoc.id, ...pharmacieDoc.data() });
      } catch (error) {
        console.error(`Erreur pharmacie ${pharmacieId}:`, error.message);
      }
    }
    const userState = userStates.get(userId) || DEFAULT_STATE;
    const listeMedicamentsAvecIndex = [];
    let message = `💊 ${nomMedicament.toUpperCase()}\n\n`;
    let index = 1;
    for (const [pharmacieId, data] of Object.entries(medicamentsParPharmacie)) {
      const pharmacie = pharmaciesMap.get(pharmacieId);
      if (!pharmacie) continue;
      for (const medicament of data.medicaments) {
        listeMedicamentsAvecIndex.push({
          index: index,
          medicamentId: medicament.id,
          pharmacieId: pharmacieId,
          pharmacieNom: pharmacie.nom,
          medicament: medicament
        });
        message += `${index}. ${medicament.nom}\n`;
        message += `   ${medicament.prix || '?'} FCFA\n`;
        message += `   ${pharmacie.nom}\n`;
        if (medicament.dosage || medicament.forme) message += `   ${medicament.dosage || ''} ${medicament.forme || ''}\n`;
        message += `${medicament.necessiteOrdonnance ? '📄 Ordonnance requise' : '✅ Sans ordonnance'}\n\n`;
        index++;
      }
    }
    message += `🛒 Pour commander :\n"ajouter [numéro] [quantité]"\n\n`;
    const userStateCurrent = userStates.get(userId) || DEFAULT_STATE;
    if (userStateCurrent.panier && userStateCurrent.panier.length > 0) {
      message += `Votre panier : ${userStateCurrent.panier.length} médicament(s)\n• "continuer" pour ajouter un autre\n• "terminer" pour finaliser\n• "panier" pour voir le panier\n`;
    } else {
      message += `Après ajout, dites "continuer" ou "terminer".\n`;
    }
    await sendWhatsAppMessage(userId, message);
    userState.resultatsRechercheMedicaments = medicamentsFiltres;
    userState.listeMedicamentsAvecIndex = listeMedicamentsAvecIndex;
    userState.attenteCommande = true;
    userState.step = 'ATTENTE_COMMANDE_MEDICAMENT';
    userStates.set(userId, userState);
  } catch (error) {
    console.error('❌ Erreur recherche réelle:', error.message);
    await sendWhatsAppMessage(userId, `Problème pour chercher "${nomMedicament}".\n\n📞 Support : ${CONFIG.SUPPORT_PHONE}`);
  }
}

async function afficherResultatsMedicament(userId, medicaments, pharmacieId, pharmacieNom) {
  const userState = userStates.get(userId) || DEFAULT_STATE;
  const listeMedicamentsAvecIndex = [];
  let message = `💊 Résultats - ${pharmacieNom}\n\n`;
  medicaments.forEach((medicament, index) => {
    const numero = index + 1;
    listeMedicamentsAvecIndex.push({
      index: numero,
      medicamentId: medicament.id,
      pharmacieId: pharmacieId,
      pharmacieNom: pharmacieNom,
      medicament: medicament
    });
    message += `${numero}. ${medicament.nom}\n`;
    message += `   ${medicament.prix || '?'} FCFA\n`;
    if (medicament.dosage || medicament.forme) message += `   ${medicament.dosage || ''} ${medicament.forme || ''}\n`;
    message += `${medicament.necessiteOrdonnance ? '📄 Ordonnance requise' : '✅ Sans ordonnance'}\n\n`;
  });
  message += `🛒 Pour commander :\n"ajouter [numéro] [quantité]"\n\nAprès ajout, dites "continuer" ou "terminer".\n`;
  await sendWhatsAppMessage(userId, message);
  userState.resultatsRechercheMedicaments = medicaments;
  userState.listeMedicamentsAvecIndex = listeMedicamentsAvecIndex;
  userState.attenteCommande = true;
  userState.step = 'ATTENTE_COMMANDE_MEDICAMENT';
  userStates.set(userId, userState);
}

// =================== GESTION NATURELLE DES MESSAGES ===================
async function gererMessageNaturel(userId, message) {
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };
  const texte = message.toLowerCase().trim();
  console.log(`💬 Message: "${message}"`);
  if (detecterDemandeImmediate(texte)) {
    await traiterDemandeImmediate(userId, message, userState);
    return;
  }
  if (texte.includes('merci')) {
    console.log(`🔄 Réinitialisation après remerciement`);
    await sendWhatsAppMessage(userId, "Avec plaisir ! 😊");
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
    userState.apresCommande = false;
    userState.apresRendezVous = false;
    userStates.set(userId, userState);
    return;
  }
  if (texte.includes('mes commandes') || texte.includes('historique')) {
    await afficherHistoriqueCommandes(userId);
    return;
  }
  if (userState.attenteCommande && (texte.includes('pharmacie') || texte.includes('clinique') || texte.includes('garde'))) {
    console.log(`🔄 Changement de sujet détecté`);
    userState.attenteCommande = false;
    userState.step = 'MENU_PRINCIPAL';
    userStates.set(userId, userState);
    if (texte.includes('pharmacie') && texte.includes('garde')) await afficherPharmaciesDeGardeReelles(userId);
    else if (texte.includes('clinique')) await afficherCliniquesReelles(userId);
    return;
  }
  await comprendreEtAgir(userId, message);
  if (!userState.historiqueMessages) userState.historiqueMessages = [];
  userState.historiqueMessages.push({ message: message, timestamp: new Date().toISOString() });
  if (userState.historiqueMessages.length > 20) userState.historiqueMessages = userState.historiqueMessages.slice(-20);
  userStates.set(userId, userState);
}

function detecterDemandeImmediate(texte) {
  const demandesImmediates = [
    'paracetamol', 'paracétamol', 'doliprane', 'ibuprofène', 'amoxicilline',
    'pharmacie de garde', 'pharmacies de garde', 'clinique', 'cliniques',
    'rendez-vous', 'rdv', 'commander', 'acheter', 'je veux'
  ];
  return demandesImmediates.some(demande => texte.includes(demande));
}

async function traiterDemandeImmediate(userId, message, userState) {
  const texte = message.toLowerCase();
  const medicament = extraireNomMedicament(texte);
  if (medicament) {
    const pharmacieSpecifique = extrairePharmacieSpecifique(texte);
    await rechercherMedicamentReel(userId, medicament, pharmacieSpecifique);
    return;
  }
  if (texte.includes('pharmacie') && texte.includes('garde')) {
    await afficherPharmaciesDeGardeReelles(userId);
    return;
  }
  if (texte.includes('clinique') && (texte.includes('disponible') || texte.includes('liste'))) {
    await afficherCliniquesReelles(userId);
    return;
  }
  if (texte.includes('rendez-vous') || texte.includes('rdv')) {
    const specialite = extraireSpecialite(texte);
    const cliniqueSpecifique = extraireCliniqueSpecifique(texte);
    await gererPriseRendezVousReel(userId, specialite, cliniqueSpecifique);
    return;
  }
  await comprendreEtAgir(userId, message);
}

// =================== GESTION DES PHARMACIES DE GARDE RÉELLES ===================
async function afficherPharmaciesDeGardeReelles(userId) {
  try {
    const userState = userStates.get(userId) || DEFAULT_STATE;
    userState.step = 'MENU_PRINCIPAL';
    userState.attenteMedicament = false;
    userState.attenteCommande = false;
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "Je vérifie les pharmacies de garde...");
    const maintenant = new Date();
    const heure = maintenant.getHours();
    const estNuit = heure >= 22 || heure < 6;
    const snapshot = await db.collection('pharmacies')
      .where('estDeGarde', '==', true)
      .where('estOuvert', '==', true)
      .limit(5)
      .get();
    if (snapshot.empty) {
      await sendWhatsAppMessage(
        userId,
        "Aucune pharmacie de garde trouvée pour le moment.\n\n" +
        (estNuit ? "Il est tard, les pharmacies de nuit sont limitées.\n\n" : "") +
        `📞 Support : ${CONFIG.SUPPORT_PHONE}`
      );
      return;
    }
    let message = `🏥 Pharmacies de garde - San Pedro\n`;
    if (estNuit) message += "🌙 Service de nuit\n\n";
    snapshot.docs.forEach((doc, index) => {
      const pharmacie = doc.data();
      message += `${index + 1}. ${pharmacie.nom || 'Pharmacie'}\n`;
      message += `   📍 ${pharmacie.adresse || 'San Pedro'}\n`;
      message += `   📞 ${pharmacie.telephone || 'Non disponible'}\n`;
      message += `   ⏰ ${pharmacie.horaires || '24h/24'}\n\n`;
    });
    message += `💊 Tu peux commander des médicaments en ligne.\n\n📞 Support : ${CONFIG.SUPPORT_PHONE}`;
    await sendWhatsAppMessage(userId, message);
  } catch (error) {
    console.error('❌ Erreur pharmacies de garde:', error.message);
    await sendWhatsAppMessage(userId, "Problème pour accéder à la liste des pharmacies.\n\n📞 Support : " + CONFIG.SUPPORT_PHONE);
  }
}

// =================== GESTION DES CLINIQUES RÉELLES ===================
async function afficherCliniquesReelles(userId) {
  try {
    await sendWhatsAppMessage(userId, "Je recherche les cliniques...");
    const snapshot = await db.collection('centres_sante')
      .where('estVerifie', '==', true)
      .limit(10)
      .get();
    if (snapshot.empty) {
      await sendWhatsAppMessage(userId, "Aucune clinique trouvée pour le moment.\n\n📞 Support : " + CONFIG.SUPPORT_PHONE);
      return;
    }
    let message = "🏥 Cliniques à San Pedro\n\n";
    snapshot.docs.forEach((doc, index) => {
      const clinique = doc.data();
      message += `${index + 1}. ${clinique.nom || 'Clinique'}\n`;
      message += `   ${clinique.adresse || 'San Pedro'}\n`;
      if (clinique.telephone) message += `   📞 ${clinique.telephone}\n`;
      if (clinique.specialites && Array.isArray(clinique.specialites)) {
        const specialitesAffichees = clinique.specialites.filter(s => s && typeof s === 'string').slice(0, 3);
        if (specialitesAffichees.length > 0) message += `   🩺 ${specialitesAffichees.join(', ')}\n`;
      }
      if (clinique.horaires) {
        const horaires = clinique.horaires;
        const lundi = horaires.Lundi || horaires.lundi;
        if (lundi) message += `   ⏰ ${lundi}\n`;
      }
      message += `\n`;
    });
    message += "Pour prendre rendez-vous :\nDites \"rendez-vous [spécialité]\"\n\n📞 Support : " + CONFIG.SUPPORT_PHONE;
    await sendWhatsAppMessage(userId, message);
  } catch (error) {
    console.error('❌ Erreur liste cliniques:', error.message);
    await sendWhatsAppMessage(userId, "Problème lors de la recherche.\n\n📞 Support : " + CONFIG.SUPPORT_PHONE);
  }
}

// =================== GESTION DES RENDEZ-VOUS RÉELS ===================
async function gererPriseRendezVousReel(userId, specialite = null, cliniqueSpecifique = null) {
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };
  if (specialite) {
    userState.specialiteRdv = specialite;
    userState.attenteSpecialiteRdv = false;
    userStates.set(userId, userState);
    await chercherCliniquesParSpecialitePourRdvReel(userId, specialite, cliniqueSpecifique);
  } else {
    userState.attenteSpecialiteRdv = true;
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "Avec quel type de médecin tu veux consulter ?");
  }
}

async function chercherCliniquesParSpecialitePourRdvReel(userId, specialite, cliniqueSpecifique = null) {
  try {
    const userState = userStates.get(userId) || DEFAULT_STATE;
    await sendWhatsAppMessage(userId, `Je cherche des cliniques pour "${specialite}"...`);
    const snapshot = await db.collection('centres_sante').where('estVerifie', '==', true).get();
    const cliniquesFiltrees = [];
    snapshot.docs.forEach(doc => {
      const centre = { id: doc.id, ...doc.data() };
      if (cliniqueSpecifique) {
        const nomClinique = (centre.nom || '').toLowerCase();
        if (!nomClinique.includes(cliniqueSpecifique.toLowerCase())) return;
      }
      let specialiteTrouvee = false;
      if (centre.specialites && Array.isArray(centre.specialites)) {
        specialiteTrouvee = centre.specialites.some(s => s && s.toLowerCase().includes(specialite.toLowerCase()));
      }
      if (!specialiteTrouvee && centre.services && Array.isArray(centre.services)) {
        specialiteTrouvee = centre.services.some(s => s && s.toLowerCase().includes(specialite.toLowerCase()));
      }
      if (specialiteTrouvee) cliniquesFiltrees.push(centre);
    });
    if (cliniquesFiltrees.length === 0) {
      await sendWhatsAppMessage(userId, `Je ne trouve pas de clinique pour "${specialite}"${cliniqueSpecifique ? ` nommée "${cliniqueSpecifique}"` : ''}.\n\n📞 Support : ${CONFIG.SUPPORT_PHONE}`);
      return;
    }
    userState.listeCliniquesRdv = cliniquesFiltrees;
    userState.attenteSelectionCliniqueRdv = true;
    userStates.set(userId, userState);
    let message = `🏥 Cliniques - ${specialite.toUpperCase()}\n\n`;
    cliniquesFiltrees.forEach((clinique, index) => {
      message += `${index + 1}. ${clinique.nom || 'Clinique'}\n`;
      message += `   ${clinique.adresse || 'San Pedro'}\n`;
      if (clinique.telephone) message += `   📞 ${clinique.telephone}\n`;
      if (clinique.specialites && Array.isArray(clinique.specialites)) {
        const specialitesFiltrees = clinique.specialites.filter(s => s && s.toLowerCase().includes(specialite.toLowerCase()));
        if (specialitesFiltrees.length > 0) message += `   🩺 ${specialitesFiltrees.join(', ')}\n`;
      }
      if (clinique.horaires) {
        const horaires = clinique.horaires;
        const lundi = horaires.Lundi || horaires.lundi;
        if (lundi) message += `   ⏰ ${lundi}\n`;
      }
      message += `\n`;
    });
    message += `Pour choisir :\nRéponds avec le numéro de la clinique\nExemple : "1" pour la première`;
    await sendWhatsAppMessage(userId, message);
  } catch (error) {
    console.error('❌ Erreur recherche cliniques:', error.message);
    await sendWhatsAppMessage(userId, `Problème lors de la recherche.\n\n📞 Support : ${CONFIG.SUPPORT_PHONE}`);
  }
}

// =================== TRAITEMENT COMMANDE MÉDICAMENT ===================
async function traiterCommandeMedicament(userId, message, userState) {
  const texte = message.toLowerCase().trim();
  const changementSujetMots = ['pharmacie', 'clinique', 'garde', 'disponible', '?', 'quoi', 'comment', 'autre'];
  const estChangementSujet = changementSujetMots.some(mot => texte.includes(mot));
  if (estChangementSujet) {
    userState.attenteCommande = false;
    userState.step = 'MENU_PRINCIPAL';
    userStates.set(userId, userState);
    await gererMessageNaturel(userId, message);
    return;
  }
  const ajouterRegex = /ajouter\s+(\d+)(?:\s+(\d+))?/i;
  const matchAjouter = texte.match(ajouterRegex);
  if (matchAjouter) {
    const numero = parseInt(matchAjouter[1]);
    const quantite = matchAjouter[2] ? parseInt(matchAjouter[2]) : 1;
    if (quantite < 1 || quantite > 10) {
      await sendWhatsAppMessage(userId, "Quantité invalide (1-10).");
      return;
    }
    const medicamentInfo = userState.listeMedicamentsAvecIndex.find(m => m.index === numero);
    if (!medicamentInfo) {
      await sendWhatsAppMessage(userId, "Numéro invalide. Choisis un numéro de la liste.");
      return;
    }
    if (medicamentInfo.medicament.stock < quantite) {
      await sendWhatsAppMessage(userId, `Stock insuffisant. Il reste ${medicamentInfo.medicament.stock} disponible(s).\n\n📞 Support : ${CONFIG.SUPPORT_PHONE}`);
      return;
    }
    if (medicamentInfo.medicament.necessiteOrdonnance) {
      await sendWhatsAppMessage(userId, `Ce médicament nécessite une ordonnance.\n\nEnvoie la photo de ton ordonnance au support.\n\n📞 Support : ${CONFIG.SUPPORT_PHONE}`);
      return;
    }
    await gestionPanier.ajouterAuPanier(userId, medicamentInfo, quantite);
  } else {
    const resultatPanier = await gestionPanier.gererMessage(userId, texte, userState);
    if (resultatPanier === null) {
      await sendWhatsAppMessage(
        userId,
        "Pour commander :\n\"ajouter [numéro] [quantité]\"\n\nExemple :\n\"ajouter 1 1\" pour ajouter 1 du médicament n°1"
      );
    }
  }
}

// =================== HISTORIQUE DES COMMANDES ===================
async function afficherHistoriqueCommandes(userId) {
  const userState = userStates.get(userId) || DEFAULT_STATE;
  const commandesSnapshot = await db.collection('commandes_medicales')
    .where('clientId', '==', userId)
    .orderBy('date_commande', 'desc')
    .limit(5)
    .get();
  if (commandesSnapshot.empty) {
    await sendWhatsAppMessage(userId, "Vous n’avez pas encore passé de commande.");
    return;
  }
  let message = `📦 Vos commandes récentes :\n\n`;
  commandesSnapshot.docs.forEach((doc, index) => {
    const commande = doc.data();
    message += `${index + 1}. Commande #${doc.id}\n`;
    message += `   📅 Date : ${new Date(commande.date_commande).toLocaleString()}\n`;
    message += `   💰 Total : ${commande.paiement.montant_total} FCFA\n`;
    message += `   📦 Statut : ${commande.statut}\n\n`;
  });
  message += `Pour plus de détails, répondez avec le numéro de la commande.`;
  await sendWhatsAppMessage(userId, message);
  userState.attenteSelectionCommande = true;
  userState.listeCommandes = commandesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  userStates.set(userId, userState);
}

// =================== WEBHOOK WHATSAPP ===================
app.get('/api/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token === CONFIG.VERIFY_TOKEN) {
    console.log('✅ Webhook vérifié avec succès');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Échec vérification webhook');
    res.status(403).send('Token invalide');
  }
});

app.post('/api/webhook', async (req, res) => {
  console.log('📩 Webhook POST reçu');
  res.status(200).send('EVENT_RECEIVED');
  setImmediate(async () => {
    try {
      const entry = req.body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const message = value?.messages?.[0];
      if (!message) { console.log('📩 Message vide ou non texte'); return; }
      if (message.id) await markMessageAsRead(message.id);
      if (message.type === 'unsupported' || message.type === 'system') { console.log('📩 Message non supporté ignoré'); return; }
      const userId = message.from;
      const messageType = message.type;
      let userState = userStates.get(userId);
      if (!userState) { userState = { ...DEFAULT_STATE }; userStates.set(userId, userState); }
      if (messageType === 'text') {
        const text = message.text.body.trim();
        console.log(`💬 ${userId}: "${text}"`);
        if (isDuplicateMessage(userId, text)) { console.log(`⚠️ Message dupliqué ignoré: "${text}"`); return; }
        await new Promise(resolve => setTimeout(resolve, 100));
        await withUserLock(userId, async () => {
          if (userState.step === 'ATTENTE_NOM' || userState.step === 'ATTENTE_QUARTIER' || userState.step === 'ATTENTE_WHATSAPP' || userState.step === 'ATTENTE_INDICATIONS' || userState.step === 'ATTENTE_NOM_MULTI' || userState.step === 'ATTENTE_QUARTIER_MULTI' || userState.step === 'ATTENTE_WHATSAPP_MULTI' || userState.step === 'ATTENTE_INDICATIONS_MULTI') {
            if (userState.step.includes('MULTI')) await collecterInfosLivraisonMulti(userId, text, userState);
            else await collecterInfosLivraison(userId, text, userState);
            return;
          }
          if (userState.attenteSpecialiteRdv || userState.attenteSelectionCliniqueRdv || userState.attenteDateRdv || userState.attenteHeureRdv || userState.attenteNomRdv || userState.attenteTelephoneRdv) {
            await gererPriseRendezVous(userId, text);
            return;
          }
          const resultatPanier = await gestionPanier.gererMessage(userId, text, userState);
          if (resultatPanier !== null) return;
          if (userState.attenteCommande && userState.listeMedicamentsAvecIndex) {
            await traiterCommandeMedicament(userId, text, userState);
            return;
          }
          if (userState.attenteMedicament) {
            await rechercherMedicamentReel(userId, text);
            userState.attenteMedicament = false;
            userStates.set(userId, userState);
            return;
          }
          if (userState.attenteMedicamentImage) {
            await rechercherMedicamentReel(userId, text);
            userState.attenteMedicamentImage = false;
            userStates.set(userId, userState);
            return;
          }
          await gererMessageNaturel(userId, text);
          userStates.set(userId, userState);
        });
      } else if (messageType === 'image') {
        const mediaId = message.image.id;
        if (userState.step === 'ATTENTE_ORDONNANCE' || userState.step === 'ATTENTE_ORDONNANCE_MULTI' || userState.attentePhotoOrdonnance) {
          await traiterImageOrdonnance(userId, userState);
        } else {
          await sendWhatsAppMessage(userId, "Photo reçue. Écris le nom du médicament sur la photo.");
          userState.attenteMedicamentImage = true;
          userStates.set(userId, userState);
        }
      }
    } catch (error) {
      console.error('💥 ERREUR WEBHOOK:', error.message);
    }
  });
});

// =================== FONCTIONS EXISTANTES (non modifiées) ===================
async function traiterRechercheParImage(userId, mediaId, userState) {
  try {
    await sendWhatsAppMessage(userId, "Photo reçue.");
    await sendWhatsAppMessage(userId, "Écris le nom du médicament sur la photo.");
    userState.attenteMedicamentImage = true;
    userStates.set(userId, userState);
  } catch (error) {
    console.error('❌ Erreur image:', error.message);
    await sendWhatsAppMessage(userId, "Problème d'analyse. Écris le nom du médicament.");
  }
}

async function traiterImageOrdonnance(userId, userState) {
  await sendWhatsAppMessage(userId, "Ordonnance reçue. Maintenant envoie tes infos :\n\n1. Ton nom\n2. Ton quartier\n3. Ton WhatsApp\n4. Indications livraison\n\nCommence par ton nom :");
  userState.attentePhotoOrdonnance = false;
  userState.step = 'ATTENTE_NOM';
  userState.attenteNom = true;
  userStates.set(userId, userState);
}

async function collecterInfosLivraison(userId, message, userState) {
  console.log(`📦 Collecte infos: "${message}"`);
  // ... (code existant)
}

async function collecterInfosLivraisonMulti(userId, message, userState) {
  console.log(`📦 Collecte infos multi: "${message}"`);
  // ... (code existant)
}

async function confirmerInfosLivraison(userId, userState) {
  // ... (code existant)
}

async function confirmerInfosLivraisonMulti(userId, userState) {
  // ... (code existant)
}

async function creerCommandeFirestore(userId, userState, commande, numeroCommande) {
  // ... (code existant)
}

async function creerCommandeMultiFirestore(userId, userState, commande, numeroCommande) {
  // ... (code existant)
}

async function assignerLivreur(userId, quartier) {
  // ... (code existant)
}

async function sendConfirmationFinale(userId, userState, commande, numeroCommande, livreurInfo) {
  // ... (code existant)
}

async function sendConfirmationFinaleMulti(userId, userState, commande, numeroCommande, livreurInfo) {
  // ... (code existant)
}

function reinitialiserEtatUtilisateur(userId, userState) {
  // ... (code existant)
}

// =================== ENDPOINTS ADMIN ===================
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'Pillbox WhatsApp Bot PRODUCTION V5.0',
    version: '5.0.0',
    users_actifs: userStates.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    support_phone: CONFIG.SUPPORT_PHONE,
    features: ['base_de_données_réelle', 'pas_de_données_fictives', 'transitions_naturelles']
  });
});

app.get('/api/stats', (req, res) => {
  const stats = {
    users_actifs: userStates.size,
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    uptime: process.uptime()
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
      intelligence: 'Base de données réelle uniquement'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

// =================== DÉMARRAGE SERVEUR ===================
app.listen(PORT, HOST, () => {
  console.log(`
=======================================================
🚀 PILLBOX WHATSAPP BOT - PRODUCTION V5.0
=======================================================
📍 Port: ${PORT}
🏙️ Zone: San Pedro uniquement
🤖 Intelligence: Base de données RÉELLE uniquement
💊 Services: Médicaments réels, pharmacies réelles, cliniques réelles
🧠 Features: Pas de données fictives, transitions naturelles
📞 Support: ${CONFIG.SUPPORT_PHONE}
=======================================================
✅ PRÊT À RECEVOIR DES MESSAGES !
✅ Utilise UNIQUEMENT la base de données réelle
✅ Ignore les fautes d'orthographe (paracetamol/paracétamol)
✅ Gère les demandes spécifiques (pharmacie cosmos, clinique X)
✅ Transitions fluides entre sujets
✅ Réinitialisation après remerciements
=======================================================
  `);
});

// Nettoyage périodique
setInterval(() => {
  const now = Date.now();
  const uneHeure = 60 * 60 * 1000;
  for (const [userId, state] of userStates.entries()) {
    const lastMessage = state.historiqueMessages?.[state.historiqueMessages?.length - 1];
    if (lastMessage) {
      const lastActive = new Date(lastMessage.timestamp).getTime();
      if (now - lastActive > uneHeure) {
        console.log(`🧹 Nettoyage état inactif: ${userId}`);
        userStates.delete(userId);
      }
    }
  }
  for (const [userId, lockTime] of processingLocks.entries()) {
    if (now - lockTime > 30000) processingLocks.delete(userId);
  }
  for (const [key, value] of messageCache.entries()) {
    if (now - value.timestamp > CACHE_DURATION * 10) messageCache.delete(key);
  }
}, 10 * 60 * 1000);

// Gestion des erreurs
process.on('uncaughtException', (error) => {
  console.error('💥 ERREUR NON GÉRÉE:', error.message);
  console.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 PROMISE REJECTION NON GÉRÉE:', reason);
});
