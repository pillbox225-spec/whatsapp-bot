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
      mauxTete: ['mal de tête', 'céphalée', 'migraine', 'céphalalgie'],
      allergie: ['allergie', 'allergique', 'réaction', 'urticaire']
    };

    this.motsClesEmotionnels = {
      urgent: ['urgent', 'vite', 'immédiat', 'dépêche', 'rapide', 'urgence'],
      stress: ['stress', 'nerveux', 'anxieux', 'inquiet', 'panique', 'angoissé'],
      douleurForte: ['atroce', 'insupportable', 'violent', 'fort', 'intense'],
      satisfaction: ['merci', 'parfait', 'super', 'génial', 'content', 'satisfait']
    };
  }

  async mettreAJourContexte(userId, message, role = 'user') {
    const userState = userStates.get(userId) || { ...DEFAULT_STATE };

    if (!userState.contexte) {
      userState.contexte = JSON.parse(JSON.stringify(DEFAULT_STATE.contexte));
    }

    // 1. Ajouter à l'historique
    userState.contexte.historiqueConversation.push({
      role,
      message,
      timestamp: new Date().toISOString()
    });

    // Limiter l'historique
    if (userState.contexte.historiqueConversation.length > 50) {
      userState.contexte.historiqueConversation =
        userState.contexte.historiqueConversation.slice(-50);
    }

    // 2. Analyser le message
    if (role === 'user') {
      await this.analyserMessageUtilisateur(userId, message, userState);
    }

    // 3. Mettre à jour les références
    this.mettreAJourReferences(userId, message, userState);

    userStates.set(userId, userState);

    return userState.contexte;
  }

  async analyserMessageUtilisateur(userId, message, userState) {
    const texte = message.toLowerCase();

    // Détecter symptômes
    const symptomesDetectes = this.detecterSymptomes(texte);
    if (symptomesDetectes.length > 0) {
      symptomesDetectes.forEach(symptome => {
        if (!userState.contexte.medical.symptomesActuels.includes(symptome)) {
          userState.contexte.medical.symptomesActuels.push(symptome);
        }
      });
    }

    // Analyser émotion
    this.analyserEtatEmotionnel(userId, texte, userState);

    // Détecter références
    this.detecterReferencesImplicites(userId, texte, userState);

    // Extraire infos profil
    this.extraireInformationsProfil(texte, userState);

    // Enregistrer médicaments
    this.enregistrerMedicamentsMentionnes(texte, userState);
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
    let urgence = 0;
    let stress = 0;
    let douleurForte = 0;
    let satisfaction = 0;

    // Mots-clés émotionnels
    for (const [emotion, mots] of Object.entries(this.motsClesEmotionnels)) {
      for (const mot of mots) {
        if (texte.includes(mot)) {
          switch (emotion) {
            case 'urgent':
              urgence += 2;
              stress += 1;
              break;
            case 'stress':
              stress += 2;
              break;
            case 'douleurForte':
              douleurForte += 3;
              urgence += 1;
              break;
            case 'satisfaction':
              satisfaction += 2;
              break;
          }
        }
      }
    }

    // Ponctuation
    const pointsExclamation = (texte.match(/!/g) || []).length;
    const pointsInterrogation = (texte.match(/\?/g) || []).length;
    const majuscules = (texte.match(/[A-Z]/g) || []).length;

    urgence += pointsExclamation * 0.5;
    stress += pointsInterrogation * 0.3;

    if (majuscules > texte.length * 0.2) {
      urgence += 1;
      stress += 1;
    }

    // Mettre à jour
    userState.contexte.emotionnel.urgenceNiveau =
      Math.min(10, Math.max(0, urgence));
    userState.contexte.emotionnel.frustrationNiveau =
      Math.min(10, Math.max(0, stress));

    // Ton général
    if (satisfaction > 2) userState.contexte.emotionnel.ton = 'satisfait';
    else if (urgence > 3) userState.contexte.emotionnel.ton = 'pressé';
    else if (stress > 3) userState.contexte.emotionnel.ton = 'stressé';
    else if (douleurForte > 2) userState.contexte.emotionnel.ton = 'douloureux';
    else userState.contexte.emotionnel.ton = 'neutre';

    userState.contexte.emotionnel.derniereInteractionPositive = satisfaction > 1;
  }

  detecterReferencesImplicites(userId, texte, userState) {
    const references = userState.contexte.references;

    // Pronoms de référence
    const pronoms = ['celui', 'celle', 'ceux', 'celles', 'ce', 'cet', 'cette'];
    const mots = texte.split(/\s+/);

    for (const mot of mots) {
      if (pronoms.includes(mot.toLowerCase())) {
        references.dernierPronom = mot.toLowerCase();
        break;
      }
    }

    // Références contextuelles
    if (texte.includes("que tu as dit") ||
      texte.includes("dont tu parlais") ||
      texte.includes("mentionné") ||
      texte.includes("précédent")) {
      references.derniereEntite = references.derniereEntite;
    }

    // Sauvegarder contexte
    if (userState.contexte.historiqueConversation.length > 1) {
      const derniersMessages = userState.contexte.historiqueConversation
        .slice(-3)
        .map(m => `${m.role}: ${m.message}`)
        .join(' | ');
      references.contextePrecedent = derniersMessages;
    }
  }

  extraireInformationsProfil(texte, userState) {
    // Âge
    const ageMatch = texte.match(/(\d+)\s*(ans?|âge)/i);
    if (ageMatch) {
      userState.contexte.profil.age = parseInt(ageMatch[1]);
    }

    // Sexe
    if (texte.includes('je suis un homme') || texte.includes('monsieur')) {
      userState.contexte.profil.sexe = 'M';
    } else if (texte.includes('je suis une femme') || texte.includes('madame')) {
      userState.contexte.profil.sexe = 'F';
    }

    // Allergies
    const allergieMatch = texte.match(/allerg(?:ie|ique)\s+(?:à|au)\s+([^\.\?]+)/i);
    if (allergieMatch) {
      userState.contexte.profil.preferences.allergies.push(allergieMatch[1].trim());
    }

    // Conditions chroniques
    const conditions = ['diabète', 'hypertension', 'asthme', 'cardiaque', 'épilepsie'];
    conditions.forEach(condition => {
      if (texte.includes(condition)) {
        userState.contexte.profil.preferences.conditionsChroniques.push(condition);
      }
    });
  }

  enregistrerMedicamentsMentionnes(texte, userState) {
    const medicamentsConnus = [
      'paracétamol', 'doliprane', 'ibuprofène', 'advil', 'amoxicilline',
      'vitamine c', 'aspirine', 'ventoline', 'insuline', 'sirop'
    ];

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

    // Dernière entité
    const entites = ['médicament', 'pharmacie', 'clinique', 'médecin', 'symptôme'];
    entites.forEach(entite => {
      if (message.toLowerCase().includes(entite)) {
        references.derniereEntite = entite;
      }
    });

    // Dernière action
    const actions = ['commander', 'acheter', 'rechercher', 'trouver', 'prendre rdv'];
    actions.forEach(action => {
      if (message.toLowerCase().includes(action)) {
        references.derniereAction = action;
      }
    });
  }

  obtenirResumeContexte(userId) {
    const userState = userStates.get(userId);
    if (!userState?.contexte) return '';

    const ctx = userState.contexte;
    let resume = '';

    // Profil
    if (ctx.profil.nom || ctx.profil.age) {
      resume += `**Profil:** `;
      if (ctx.profil.nom) resume += `Nom: ${ctx.profil.nom}, `;
      if (ctx.profil.age) resume += `Âge: ${ctx.profil.age}, `;
      if (ctx.profil.sexe) resume += `Sexe: ${ctx.profil.sexe}, `;
      if (ctx.profil.quartier) resume += `Quartier: ${ctx.profil.quartier}`;
      resume += `\n`;
    }

    // Symptômes
    if (ctx.medical.symptomesActuels.length > 0) {
      resume += `**Symptômes:** ${ctx.medical.symptomesActuels.join(', ')}\n`;
    }

    // Médicaments
    if (ctx.medical.medicamentsRecherches.length > 0) {
      resume += `**Médicaments:** ${ctx.medical.medicamentsRecherches.join(', ')}\n`;
    }

    // Émotion
    if (ctx.emotionnel.ton !== 'neutre') {
      resume += `**État:** ${ctx.emotionnel.ton} `;
      if (ctx.emotionnel.urgenceNiveau > 5) resume += `(urgence)`;
      resume += `\n`;
    }

    // Dernier médicament
    if (ctx.medical.dernierMedicamentMentionne) {
      resume += `**Dernier médicament:** ${ctx.medical.dernierMedicamentMentionne}\n`;
    }

    // Contexte récent
    if (ctx.historiqueConversation.length > 1) {
      const derniersMessages = ctx.historiqueConversation
        .slice(-3)
        .map(msg => `${msg.role === 'user' ? 'User' : 'Asst'}: ${msg.message.substring(0, 50)}...`)
        .join(' | ');
      resume += `**Contexte:** ${derniersMessages}\n`;
    }

    return resume;
  }

  interpreterReference(userId, reference) {
    const userState = userStates.get(userId);
    if (!userState?.contexte) return null;

    const ctx = userState.contexte;

    if (reference.includes("celui") || reference.includes("ce médicament")) {
      return ctx.medical.dernierMedicamentMentionne;
    }

    if (reference.includes("ce symptôme") || reference.includes("cette douleur")) {
      return ctx.medical.symptomesActuels[ctx.medical.symptomesActuels.length - 1];
    }

    if (reference.includes("cette pharmacie")) {
      return ctx.transactionnel.pharmaciesConsultees[
        ctx.transactionnel.pharmaciesConsultees.length - 1
      ];
    }

    return null;
  }
}

// Initialisation
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

    // Initialiser le panier si besoin
    if (!userState.panier) {
      userState.panier = [];
      userStates.set(userId, userState);
    }

    // 1. Si l'utilisateur dit qu'il veut plusieurs médicaments
    if (texte.includes('plusieurs') || texte.includes('multi') ||
      texte.includes('différents') || texte.includes('plus d\'un')) {
      return this.demarrerModeMulti(userId, userState);
    }

    // 2. Si l'utilisateur dit "continuer" après un ajout
    if (texte === 'continuer' || texte === 'oui' || texte === 'encore') {
      if (userState.panier.length > 0) {
        return this.demanderAutreMedicament(userId, userState);
      } else {
        return this.demanderPremierMedicament(userId, userState);
      }
    }

    // 3. Si l'utilisateur dit "terminer" ou "fini"
    if (texte === 'terminer' || texte === 'fini' || texte === 'finaliser') {
      if (userState.panier.length > 0) {
        return this.finaliserPanier(userId, userState);
      } else {
        await sendWhatsAppMessage(userId, "Votre panier est vide. Dites-moi un médicament.");
        return;
      }
    }

    // 4. Si l'utilisateur veut voir son panier
    if (texte === 'panier' || texte === 'voir panier' || texte === 'mon panier') {
      return this.afficherPanier(userId, userState);
    }

    // 5. Si l'utilisateur veut vider son panier
    if (texte === 'vider' || texte === 'vider panier' || texte === 'recommencer') {
      return this.viderPanier(userId, userState);
    }

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

    // Demander si continuer ou terminer
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

    if (panier.length === 0) {
      await sendWhatsAppMessage(userId, "Votre panier est vide.");
      return;
    }

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

    if (panier.length === 0) {
      await sendWhatsAppMessage(userId, "Votre panier est vide.");
      return;
    }

    const { sousTotal, fraisLivraison, total } = this.calculerTotal(panier);

    // Vérifier si ordonnance requise
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

    // Sauvegarder la commande
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
    const sousTotal = panier.reduce((total, item) => {
      return total + (item.prixUnitaire * item.quantite);
    }, 0);

    const fraisLivraison = getFraisLivraison();
    const total = sousTotal + fraisLivraison;

    return { sousTotal, fraisLivraison, total };
  }
}

// Initialiser
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

  // Pour rendez-vous
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

  // Pour recherche par image
  attenteMedicamentImage: false,

  // Pour collecte d'informations
  attenteNom: false,
  attenteQuartier: false,
  attenteWhatsApp: false,
  attenteIndications: false,

  // États post-interaction
  apresCommande: false,
  apresRendezVous: false,
  derniereCommandeRef: null,
  dernierRdvRef: null,
  dernierLivreurNom: null,
  dernierLivreurTel: null,

  // Contexte
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

  if (cached && (now - cached.timestamp < CACHE_DURATION)) {
    return true;
  }

  messageCache.set(cacheKey, { timestamp: now, message });

  // Nettoyer le cache
  for (const [key, value] of messageCache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      messageCache.delete(key);
    }
  }

  return false;
}

async function withUserLock(userId, callback) {
  if (processingLocks.has(userId)) {
    console.log(`⏳ ${userId} est déjà en traitement`);
    return null;
  }

  processingLocks.set(userId, Date.now());

  try {
    return await callback();
  } finally {
    // Libérer le verrou après 30 secondes maximum
    setTimeout(() => {
      if (processingLocks.get(userId) === Date.now() - processingLocks.get(userId) > 30000) {
        processingLocks.delete(userId);
      }
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

// Fonction pour marquer un message comme lu
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

// =================== GESTION DES REMERCIEMENTS ET SUIVI ===================
async function gererRemerciementsEtSuivi(userId, message, userState) {
  const texte = message.toLowerCase().trim();
  
  // Détecter les remerciements
  const remerciements = ['merci', 'thanks', 'thank you', 'merci beaucoup', 'super', 'parfait', 'génial'];
  const estRemerciement = remerciements.some(mot => texte.includes(mot));
  
  // Détecter les demandes de suivi
  const suiviMots = ['suivi', 'suivre', 'statut', 'où en est', 'avancement', 'attends', 'attendre'];
  const estDemandeSuivi = suiviMots.some(mot => texte.includes(mot));
  
  // Détecter les nouvelles demandes
  const nouvelleDemandeMots = ['autre', 'encore', 'nouveau', 'différent', 'acheter', 'commander', 'médicament', 'pharmacie', 'rendez-vous', 'rdv'];
  const estNouvelleDemande = nouvelleDemandeMots.some(mot => texte.includes(mot));
  
  // Vérifier les demandes spécifiques de suivi RDV
  if (texte.includes('suivi rdv') || texte.includes('statut rendez-vous') || 
      texte.includes('où en est mon rdv') || texte.includes('mon rendez-vous')) {
    
    if (userState.dernierRdvRef) {
      await sendWhatsAppMessage(
        userId,
        `📅 **SUIVI RENDEZ-VOUS**\n\n` +
        `🔢 Référence : ${userState.dernierRdvRef}\n` +
        `📊 Statut : En attente de confirmation\n` +
        `🏥 Clinique : Vous contactera sous peu\n\n` +
        `La clinique vous appellera pour confirmer votre rendez-vous.\n\n` +
        `📞 Pour toute question : ${CONFIG.SUPPORT_PHONE}`
      );
    } else {
      await sendWhatsAppMessage(
        userId,
        `Je ne vois pas de rendez-vous récent dans votre historique.\n\n` +
        `Souhaitez-vous prendre un nouveau rendez-vous ?\n` +
        `Dites "rendez-vous" pour commencer.`
      );
    }
    return true;
  }
  
  // État "après commande"
  if (userState.apresCommande) {
    if (estRemerciement) {
      await sendWhatsAppMessage(
        userId,
        `🙏 Je vous en prie ! C'est un plaisir de vous aider.\n\n` +
        `Votre commande #${userState.derniereCommandeRef || ''} est en cours de traitement.\n\n` +
        `N'hésitez pas si vous avez d'autres questions ou besoins ! 😊`
      );
      
      // Réinitialiser l'état après commande
      userState.apresCommande = false;
      userStates.set(userId, userState);
      return true;
    }
    
    if (estDemandeSuivi) {
      await sendWhatsAppMessage(
        userId,
        `📊 **SUIVI DE COMMANDE**\n\n` +
        `🔢 Référence : ${userState.derniereCommandeRef || 'CMD...'}\n` +
        `⏰ Délai estimé : 45-60 minutes\n` +
        `📱 Livreur : ${userState.dernierLivreurNom || 'liv liv'}\n` +
        `☎️ Contact livreur : ${userState.dernierLivreurTel || '0709548980'}\n\n` +
        `**Étapes :**\n` +
        `✅ Commande confirmée\n` +
        `📦 Préparation en cours\n` +
        `🚴 Livreur assigné\n` +
        `🏠 Livraison à domicile\n\n` +
        `📞 Pour tout renseignement : ${CONFIG.SUPPORT_PHONE}`
      );
      return true;
    }
    
    if (estNouvelleDemande) {
      // Réinitialiser pour nouvelle demande
      userState.apresCommande = false;
      userStates.set(userId, userState);
      return false; // Laisser Groq traiter
    }
  }
  
  // État "après rendez-vous"
  if (userState.apresRendezVous) {
    if (estRemerciement) {
      await sendWhatsAppMessage(
        userId,
        `🙏 Avec plaisir ! Je suis contente d'avoir pu vous aider pour votre rendez-vous.\n\n` +
        `Votre rendez-vous ${userState.dernierRdvRef || ''} est en attente de confirmation.\n\n` +
        `Besoin d'autre chose ? Je suis à votre disposition ! 😊`
      );
      
      userState.apresRendezVous = false;
      userStates.set(userId, userState);
      return true;
    }
  }
  
  // Détection générale des remerciements
  if (estRemerciement && !userState.apresCommande && !userState.apresRendezVous) {
    await sendWhatsAppMessage(
      userId,
      `😊 Je vous en prie ! N'hésitez pas si vous avez besoin d'aide pour :\n\n` +
      `💊 Acheter des médicaments\n` +
      `🏥 Trouver une pharmacie de garde\n` +
      `📅 Prendre un rendez-vous médical\n` +
      `🏩 Localiser des cliniques\n\n` +
      `Comment puis-je vous aider aujourd'hui ?`
    );
    return true;
  }
  
  // Détection des confirmations d'attente
  if (texte.includes("j'attends") || texte.includes("j’attends") || 
      texte.includes("attends") || texte.includes("ok j'attends")) {
    await sendWhatsAppMessage(
      userId,
      `👌 Parfait ! Votre commande est bien prise en charge.\n\n` +
      `Je vous informerai dès qu'il y aura une mise à jour.\n\n` +
      `En attendant, puis-je vous aider pour autre chose ?`
    );
    return true;
  }
  
  return false;
}

// =================== CERVEAU PRINCIPAL - GROQ ===================
async function comprendreEtAgir(userId, message) {
  console.log(`🧠 Analyse: "${message}"`);
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };

  // Mettre à jour le contexte
  const contexte = await gestionnaireContexte.mettreAJourContexte(userId, message, 'user');
  const resumeContexte = gestionnaireContexte.obtenirResumeContexte(userId);

  // Détection directe des intentions courantes
  const messageLower = message.toLowerCase();
  if (messageLower.includes("acheter un médicament") ||
    messageLower.includes("acheter médicament") ||
    messageLower.includes("commander médicament")) {
    await sendWhatsAppMessage(userId, "Quel médicament souhaitez-vous acheter ? Veuillez préciser le nom exact.");
    userState.attenteMedicament = true;
    userStates.set(userId, userState);
    return {
      action: "DEMANDE_NOM_MEDICAMENT",
      reponse: "Quel médicament souhaitez-vous acheter ? Veuillez préciser le nom exact.",
      parametres: null
    };
  }

  try {
    const prompt = `
Tu es Mia, assistante médicale à San Pedro. Tu aides pour:
1. Commandes de médicaments
2. Pharmacies de garde
3. Rendez-vous médicaux
4. Conseils médicaux généraux
5. Information sur les cliniques

## CONTEXTE UTILISATEUR:
${resumeContexte}

## MESSAGE UTILISATEUR:
"${message}"

## RÈGLES STRICTES:
- NE PAS inventer de données (médicaments, pharmacies, cliniques, prix)
- Si tu ne sais pas, diriger vers le support
- Pour les médicaments: demander le nom exact
- Pour les pharmacies: consulter la base de données réelle
- Pour les rendez-vous: extraire la spécialité
- Pour les cliniques: consulter la base de données réelle
- Pour conseils médicals: donner des conseils généraux mais toujours recommander de consulter un médecin
- NE JAMAIS diagnostiquer

## ACTIONS DISPONIBLES:
- RECHERCHE_MEDICAMENT → si demande de médicament spécifique
- DEMANDE_NOM_MEDICAMENT → si l'utilisateur veut acheter un médicament mais ne précise pas lequel
- PHARMACIE_GARDE → si "pharmacie de garde" ou équivalent
- DEMANDE_RENDEZ_VOUS → si "rendez-vous" ou recherche de spécialiste
- LISTE_CLINIQUES → si demande de liste de cliniques
- CONSEIL_MEDICAL → si demande de conseil médical général
- SALUTATION → si simple salutation
- SUPPORT → si problème technique ou besoin d'aide humaine

## RÉPONSE:
- Répondre naturellement comme une assistante
- Si action directe, répondre brièvement et indiquer l'action
- Toujours préciser que le service est uniquement à San Pedro

## EXEMPLES:
Utilisateur: "Paracétamol" →
{
  "action": "RECHERCHE_MEDICAMENT",
  "reponse": "Je cherche du paracétamol pour vous...",
  "parametres": {"nom_medicament": "paracétamol"}
}

Utilisateur: "Je veux acheter un médicament" →
{
  "action": "DEMANDE_NOM_MEDICAMENT",
  "reponse": "Quel médicament souhaitez-vous acheter ? Veuillez préciser le nom exact.",
  "parametres": null
}

Utilisateur: "J'ai mal à la tête" →
{
  "action": "CONSEIL_MEDICAL",
  "reponse": "Pour les maux de tête, vous pouvez prendre du paracétamol. Mais si la douleur persiste, consultez un médecin.",
  "parametres": null
}

Utilisateur: "Pharmacie ouverte" →
{
  "action": "PHARMACIE_GARDE",
  "reponse": "Je cherche les pharmacies de garde à San Pedro...",
  "parametres": null
}

Utilisateur: "Je cherche un dermatologue" →
{
  "action": "DEMANDE_RENDEZ_VOUS",
  "reponse": "Je cherche des dermatologues à San Pedro...",
  "parametres": {"specialite": "dermatologue"}
}

Utilisateur: "Quelles cliniques à San Pedro ?" →
{
  "action": "LISTE_CLINIQUES",
  "reponse": "Je recherche les cliniques disponibles à San Pedro...",
  "parametres": null
}

Utilisateur: "Aide" →
{
  "action": "SUPPORT",
  "reponse": "Je peux vous aider pour: médicaments, pharmacies de garde, rendez-vous médicaux. Que souhaitez-vous faire ?",
  "parametres": null
}

JSON uniquement:
{
  "action": "ACTION",
  "reponse": "réponse à montrer à l'utilisateur",
  "parametres": {"cle": "valeur"} ou null
}
`;

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: CONFIG.GROQ_MODEL,
        messages: [
          {
            role: "system",
            content: "Tu es Mia, assistante médicale. Réponds UNIQUEMENT en JSON. Ne donne pas de données fictives."
          },
          { role: "user", content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 300,
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
    console.log('✅ Résultat Groq:', JSON.stringify(result));

    // Envoyer la réponse de Groq
    await sendWhatsAppMessage(userId, result.reponse);

    // Mettre à jour l'état utilisateur selon l'action
    if (result.action === 'DEMANDE_NOM_MEDICAMENT') {
      userState.attenteMedicament = true;
      userStates.set(userId, userState);
    }

    // Exécuter l'action correspondante
    await executerAction(userId, result, message);
    return result;

  } catch (error) {
    console.error('❌ Erreur Groq:', error.message);
    // Réponse de secours
    await sendWhatsAppMessage(
      userId,
      "Je rencontre un léger retard. Veuillez préciser le nom du médicament que vous souhaitez acheter."
    );
    userState.attenteMedicament = true;
    userStates.set(userId, userState);
  }
}

// =================== EXÉCUTION DES ACTIONS ===================
async function executerAction(userId, result, messageOriginal) {
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };

  switch (result.action) {
    case 'RECHERCHE_MEDICAMENT':
      const nomMedicament = result.parametres?.nom_medicament ||
        extraireNomMedicament(messageOriginal);
      if (nomMedicament) {
        await rechercherEtAfficherMedicament(userId, nomMedicament);
      } else {
        userState.attenteMedicament = true;
        userStates.set(userId, userState);
      }
      break;

    case 'DEMANDE_NOM_MEDICAMENT':
      await sendWhatsAppMessage(userId, "Quel médicament souhaitez-vous acheter ? Veuillez préciser le nom exact.");
      userState.attenteMedicament = true;
      userStates.set(userId, userState);
      break;

    case 'PHARMACIE_GARDE':
      await afficherPharmaciesDeGarde(userId);
      break;

    case 'DEMANDE_RENDEZ_VOUS':
      const specialite = result.parametres?.specialite ||
        extraireSpecialite(messageOriginal);
      if (specialite) {
        await chercherCliniquesParSpecialitePourRdv(userId, specialite);
      } else {
        userState.attenteSpecialiteRdv = true;
        userStates.set(userId, userState);
      }
      break;

    case 'LISTE_CLINIQUES':
      await afficherListeCliniquesReelles(userId);
      break;

    case 'CONSEIL_MEDICAL':
      // Groq a déjà donné la réponse, rien de plus à faire
      break;

    case 'SALUTATION':
      // Groq a déjà répondu
      break;

    case 'SUPPORT':
      // Groq a déjà donné des conseils
      break;

    default:
      // Ne rien faire, Groq a déjà répondu
      break;
  }
}

function extraireNomMedicament(message) {
  const medicamentsCourants = [
    'paracétamol', 'paracetamol', 'doliprane', 'dafalgan',
    'ibuprofène', 'ibuprofene', 'advil', 'nurofen',
    'amoxicilline', 'clamoxyl', 'augmentin',
    'aspirine', 'aspegic',
    'vitamine c', 'vitamine d', 'vitamine b',
    'sirop', 'sirop contre la toux', 'toux',
    'doliprane', 'efferalgan'
  ];

  const texte = message.toLowerCase();

  for (const medicament of medicamentsCourants) {
    if (texte.includes(medicament)) {
      return medicament;
    }
  }

  return null;
}

function extraireSpecialite(message) {
  const specialites = [
    'dermatologue', 'dermatologie',
    'cardiologue', 'cardiologie',
    'gynécologue', 'gynécologie',
    'pédiatre', 'pédiatrie',
    'médecin généraliste', 'généraliste',
    'dentiste', 'dentaire',
    'ophtalmologue', 'ophtalmologie',
    'radiologue', 'radiologie', 'scanner',
    'psychiatre', 'psychiatrie',
    'chirurgien', 'chirurgie',
    'urgences', 'urgence'
  ];

  const texte = message.toLowerCase();

  for (const specialite of specialites) {
    if (texte.includes(specialite)) {
      return specialite;
    }
  }

  return null;
}

// =================== GESTION DES MÉDICAMENTS ===================
async function rechercherEtAfficherMedicament(userId, nomMedicament) {
  try {
    await sendWhatsAppMessage(userId, `🔍 Recherche "${nomMedicament}"...`);

    const termeRecherche = nomMedicament.toLowerCase().trim();

    if (termeRecherche.length < 3) {
      await sendWhatsAppMessage(userId, "Nom trop court (min 3 lettres).");
      return;
    }

    // Recherche
    const snapshot = await db.collection('medicaments')
      .where('stock', '>', 0)
      .limit(10)
      .get();

    const medicamentsFiltres = [];

    snapshot.docs.forEach(doc => {
      const medicament = { id: doc.id, ...doc.data() };
      const nomMed = (medicament.nom || '').toLowerCase();

      if (nomMed.includes(termeRecherche) && medicament.pharmacieId) {
        medicamentsFiltres.push(medicament);
      }
    });

    // Si non trouvé
    if (medicamentsFiltres.length === 0) {
      await sendWhatsAppMessage(
        userId,
        `❌ "${nomMedicament}" non disponible.\n\n` +
        `📞 Contactez le support :\n` +
        `${CONFIG.SUPPORT_PHONE}`
      );
      return;
    }

    // Récupérer pharmacies
    const pharmacieIds = [...new Set(medicamentsFiltres.map(m => m.pharmacieId))];
    const pharmaciesMap = new Map();

    for (const pharmacieId of pharmacieIds) {
      try {
        const pharmacieDoc = await db.collection('pharmacies').doc(pharmacieId).get();
        if (pharmacieDoc.exists) {
          pharmaciesMap.set(pharmacieId, { id: pharmacieDoc.id, ...pharmacieDoc.data() });
        }
      } catch (error) {
        console.error(`Erreur pharmacie ${pharmacieId}:`, error.message);
      }
    }

    // Construire réponse
    const userState = userStates.get(userId) || DEFAULT_STATE;
    const listeMedicamentsAvecIndex = [];

    let message = `💊 ${nomMedicament.toUpperCase()}\n\n`;

    medicamentsFiltres.forEach((medicament, index) => {
      const pharmacie = pharmaciesMap.get(medicament.pharmacieId);
      if (!pharmacie) return;

      const numero = index + 1;
      listeMedicamentsAvecIndex.push({
        index: numero,
        medicamentId: medicament.id,
        pharmacieId: medicament.pharmacieId,
        pharmacieNom: pharmacie.nom,
        medicament: medicament
      });

      message += `${numero}. ${medicament.nom}\n`;
      message += `   ${medicament.prix || '?'} FCFA\n`;
      message += `   ${pharmacie.nom}\n`;

      if (medicament.dosage || medicament.forme) {
        message += `   ${medicament.dosage || ''} ${medicament.forme || ''}\n`;
      }

      message += `${medicament.necessiteOrdonnance ? '📄 Ordonnance requise' : '✅ Sans ordonnance'}\n\n`;
    });

    message += `🛒 Pour ajouter au panier :\n`;
    message += `"ajouter [numéro] [quantité]"\n\n`;

    const userStateCurrent = userStates.get(userId) || DEFAULT_STATE;
    if (userStateCurrent.panier && userStateCurrent.panier.length > 0) {
      message += `Votre panier contient ${userStateCurrent.panier.length} médicament(s).\n`;
      message += `• "continuer" pour ajouter un autre\n`;
      message += `• "terminer" pour finaliser\n`;
      message += `• "panier" pour voir votre panier\n`;
    } else {
      message += `Après ajout, dites "continuer" ou "terminer".\n`;
    }

    await sendWhatsAppMessage(userId, message);

    // Sauvegarder pour commande
    userState.resultatsRechercheMedicaments = medicamentsFiltres;
    userState.listeMedicamentsAvecIndex = listeMedicamentsAvecIndex;
    userState.attenteCommande = true;
    userState.step = 'ATTENTE_COMMANDE_MEDICAMENT';
    userStates.set(userId, userState);

  } catch (error) {
    console.error('❌ Erreur recherche:', error.message);
    await sendWhatsAppMessage(
      userId,
      `❌ Erreur recherche "${nomMedicament}".\n\n` +
      `📞 Contactez le support : ${CONFIG.SUPPORT_PHONE}`
    );
  }
}

async function traiterCommandeMedicament(userId, message, userState) {
  const texte = message.toLowerCase().trim();

  // Ajouter au panier
  const ajouterRegex = /ajouter\s+(\d+)(?:\s+(\d+))?/i;
  const matchAjouter = texte.match(ajouterRegex);

  if (matchAjouter) {
    // Ajouter au panier
    const numero = parseInt(matchAjouter[1]);
    const quantite = matchAjouter[2] ? parseInt(matchAjouter[2]) : 1;

    if (quantite < 1 || quantite > 10) {
      await sendWhatsAppMessage(userId, "Quantité invalide (1-10).");
      return;
    }

    const medicamentInfo = userState.listeMedicamentsAvecIndex.find(m => m.index === numero);

    if (!medicamentInfo) {
      await sendWhatsAppMessage(userId, "Numéro invalide. Choisissez un numéro de la liste.");
      return;
    }

    // Vérifier stock
    if (medicamentInfo.medicament.stock < quantite) {
      await sendWhatsAppMessage(
        userId,
        `❌ Stock insuffisant. Il ne reste que ${medicamentInfo.medicament.stock} disponible(s).\n\n` +
        `📞 Contactez le support : ${CONFIG.SUPPORT_PHONE}`
      );
      return;
    }

    // Vérifier ordonnance
    if (medicamentInfo.medicament.necessiteOrdonnance) {
      await sendWhatsAppMessage(
        userId,
        `📄 Ce médicament nécessite une ordonnance.\n\n` +
        `Envoyez la photo de votre ordonnance au support client via WhatsApp pour que votre commande soit prise en charge.\n\n` +
        `📞 Support : ${CONFIG.SUPPORT_PHONE}`
      );
      return;
    }

    // Ajouter au panier
    await gestionPanier.ajouterAuPanier(userId, medicamentInfo, quantite);

  } else if (texte.match(/^prix\s+(\d+)$/i)) {
    // Vérifier prix
    const matchPrix = texte.match(/^prix\s+(\d+)$/i);
    const numero = parseInt(matchPrix[1]);

    const medicamentInfo = userState.listeMedicamentsAvecIndex.find(m => m.index === numero);

    if (medicamentInfo) {
      const medicament = medicamentInfo.medicament;
      await sendWhatsAppMessage(
        userId,
        `💊 ${medicament.nom}\n\n` +
        `${medicamentInfo.pharmacieNom}\n` +
        `${medicament.dosage || ''} ${medicament.forme || ''}\n` +
        `${medicament.necessiteOrdonnance ? '📄 Ordonnance requise\n' : '✅ Sans ordonnance\n'}` +
        `🛒 Ajouter au panier :\n` +
        `"ajouter ${numero} [quantité]"`
      );
    }
  } else {
    // Vérifier si c'est une commande de gestion de panier
    const resultatPanier = await gestionPanier.gererMessage(userId, texte, userState);
    if (resultatPanier === null) {
      await sendWhatsAppMessage(
        userId,
        "🛒 Pour commander :\n" +
        'Écrivez "ajouter [numéro] [quantité]"\n\n' +
        "📝 Exemple :\n" +
        '"ajouter 1 1" pour ajouter 1 du médicament n°1'
      );
    }
  }
}

// =================== GESTION DES PHARMACIES ===================
async function afficherPharmaciesDeGarde(userId) {
  try {
    await sendWhatsAppMessage(userId, "🔍 Recherche des pharmacies de garde...");

    const snapshot = await db.collection('pharmacies')
      .where('estDeGarde', '==', true)
      .where('estOuvert', '==', true)
      .limit(5)
      .get();

    if (snapshot.empty) {
      await sendWhatsAppMessage(
        userId,
        "❌ Aucune pharmacie de garde trouvée pour le moment.\n\n" +
        "📞 Contactez le support au " + CONFIG.SUPPORT_PHONE + "\n\n" +
        "📍 Service uniquement à San Pedro"
      );
      return;
    }

    let message = "🏥 Pharmacies de garde - San Pedro\n\n";

    snapshot.docs.forEach((doc, index) => {
      const pharmacie = doc.data();
      message += `${index + 1}. ${pharmacie.nom || 'Pharmacie'}\n`;
      message += `   ${pharmacie.adresse || 'San Pedro'}\n`;
      message += `   📞 ${pharmacie.telephone || 'Non disponible'}\n`;
      message += `   ⏰ ${pharmacie.horaires || '24h/24'}\n\n`;
    });

    message += "💊 Pour commander des médicaments :\n";
    message += "Écrivez simplement le nom du médicament\n\n";
    message += "📞 Support : " + CONFIG.SUPPORT_PHONE;

    await sendWhatsAppMessage(userId, message);

  } catch (error) {
    console.error('❌ Erreur pharmacies:', error.message);
    await sendWhatsAppMessage(
      userId,
      "❌ Erreur recherche pharmacies.\n\n" +
      "📞 Contactez le support : " + CONFIG.SUPPORT_PHONE
    );
  }
}

// =================== GESTION DES RENDEZ-VOUS ===================
async function gererPriseRendezVous(userId, message) {
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };
  const texte = message.toLowerCase().trim();

  console.log(`📅 Traitement rendez-vous: "${message}"`);

  // Étape 1: Détection de la demande de rendez-vous
  if (texte.includes('rendez-vous') || texte.includes('rdv') || texte.includes('consultation')) {
    userState.attenteSpecialiteRdv = true;
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "Avec quel type de médecin souhaitez-vous consulter ?");
    return;
  }

  // Étape 2: Spécialité choisie
  if (userState.attenteSpecialiteRdv) {
    userState.specialiteRdv = texte;
    userState.attenteSpecialiteRdv = false;
    userStates.set(userId, userState);

    // Chercher les cliniques pour cette spécialité
    await chercherCliniquesParSpecialitePourRdv(userId, texte);
    return;
  }

  // Étape 3: Sélection de la clinique
  if (userState.attenteSelectionCliniqueRdv && texte.match(/^\d+$/)) {
    const numero = parseInt(texte);
    const cliniques = userState.listeCliniquesRdv || [];

    if (numero >= 1 && numero <= cliniques.length) {
      const clinique = cliniques[numero - 1];
      userState.cliniqueSelectionneeRdv = clinique;
      userState.attenteSelectionCliniqueRdv = false;
      userState.attenteDateRdv = true;
      userStates.set(userId, userState);

      await sendWhatsAppMessage(
        userId,
        `🏥 ${clinique.nom}\n\n` +
        `✅ Clinique sélectionnée\n\n` +
        `${clinique.adresse || 'San Pedro'}\n` +
        `${clinique.telephone || ''}\n\n` +
        `📅 Quelle date souhaitez-vous ?\n` +
        `Format : JJ/MM/AAAA`
      );
      return;
    }
  }

  // Étape 4: Date choisie
  if (userState.attenteDateRdv) {
    userState.dateRdv = texte;
    userState.attenteDateRdv = false;
    userState.attenteHeureRdv = true;
    userStates.set(userId, userState);

    await sendWhatsAppMessage(
      userId,
      `📅 Date : ${texte}\n\n` +
      "⏰ À quelle heure ?\n" +
      "Format : HH:MM"
    );
    return;
  }

  // Étape 5: Heure choisie
  if (userState.attenteHeureRdv) {
    userState.heureRdv = texte;
    userState.attenteHeureRdv = false;
    userState.attenteNomRdv = true;
    userStates.set(userId, userState);

    await sendWhatsAppMessage(
      userId,
      `⏰ Heure : ${texte}\n\n` +
      "👤 Quel est votre nom complet ?"
    );
    return;
  }

  // Étape 6: Nom choisi
  if (userState.attenteNomRdv) {
    userState.nomRdv = texte;
    userState.attenteNomRdv = false;
    userState.attenteTelephoneRdv = true;
    userStates.set(userId, userState);

    await sendWhatsAppMessage(
      userId,
      `👤 Nom : ${texte}\n\n` +
      "📱 Quel est votre numéro de téléphone ?\n" +
      "Format : 07XXXXXXXX"
    );
    return;
  }

  // Étape 7: Téléphone choisi - FINALISATION
  if (userState.attenteTelephoneRdv) {
    await finaliserRendezVous(userId, texte, userState);
    return;
  }
}

async function chercherCliniquesParSpecialitePourRdv(userId, specialite) {
  try {
    const userState = userStates.get(userId) || DEFAULT_STATE;

    await sendWhatsAppMessage(userId, `🔍 Recherche des cliniques pour "${specialite}"...`);

    const snapshot = await db.collection('centres_sante')
      .where('estVerifie', '==', true)
      .get();

    const cliniquesFiltrees = [];
    const motsCles = [specialite.toLowerCase()];

    snapshot.docs.forEach(doc => {
      const centre = { id: doc.id, ...doc.data() };

      // Vérifier dans les spécialités
      let specialiteTrouvee = false;

      if (centre.specialites && Array.isArray(centre.specialites)) {
        for (const motCle of motsCles) {
          const trouve = centre.specialites.some(s =>
            s && s.toLowerCase().includes(motCle.toLowerCase())
          );
          if (trouve) {
            specialiteTrouvee = true;
            break;
          }
        }
      }

      // Vérifier aussi dans les services
      if (!specialiteTrouvee && centre.services && Array.isArray(centre.services)) {
        for (const motCle of motsCles) {
          const trouve = centre.services.some(s =>
            s && s.toLowerCase().includes(motCle.toLowerCase())
          );
          if (trouve) {
            specialiteTrouvee = true;
            break;
          }
        }
      }

      if (specialiteTrouvee) {
        cliniquesFiltrees.push(centre);
      }
    });

    if (cliniquesFiltrees.length === 0) {
      // Obtenir les spécialités réelles
      const specialitesReelles = await obtenirSpecialitesReelles();

      let messageErreur = `🔍 Recherche : "${specialite}"\n\n`;
      messageErreur += `❌ Aucun médecin ou clinique trouvé pour cette spécialité.\n\n`;

      if (specialitesReelles) {
        messageErreur += `🏥 Spécialités disponibles :\n`;
        messageErreur += specialitesReelles + `\n\n`;
      }

      messageErreur += `📞 Contactez le support : ${CONFIG.SUPPORT_PHONE}`;

      await sendWhatsAppMessage(userId, messageErreur);

      userState.attenteSpecialiteRdv = true;
      userStates.set(userId, userState);
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

      // Afficher les spécialités pertinentes
      if (clinique.specialites && Array.isArray(clinique.specialites)) {
        const specialitesFiltrees = clinique.specialites.filter(s => {
          return s && motsCles.some(mot => s.toLowerCase().includes(mot.toLowerCase()));
        });
        if (specialitesFiltrees.length > 0) {
          message += `   🩺 ${specialitesFiltrees.join(', ')}\n`;
        }
      }

      // Afficher les horaires
      if (clinique.horaires) {
        const horaires = clinique.horaires;
        const lundi = horaires.Lundi || horaires.lundi;
        if (lundi) message += `   ⏰ ${lundi}\n`;
      }

      message += `\n`;
    });

    message += `✅ Pour choisir :\n`;
    message += `Répondez avec le numéro de la clinique\n\n`;
    message += `📝 Exemple : "1" pour la première clinique`;

    await sendWhatsAppMessage(userId, message);

  } catch (error) {
    console.error('❌ Erreur recherche cliniques:', error.message);
    await sendWhatsAppMessage(
      userId,
      `❌ Erreur lors de la recherche.\n\n` +
      `📞 Contactez le support : ${CONFIG.SUPPORT_PHONE}`
    );
  }
}

async function obtenirSpecialitesReelles() {
  try {
    const snapshot = await db.collection('centres_sante')
      .where('estVerifie', '==', true)
      .limit(5)
      .get();

    if (snapshot.empty) {
      return null;
    }

    const specialitesUniques = new Set();

    // Collecter toutes les spécialités de toutes les cliniques
    for (const doc of snapshot.docs) {
      const centre = doc.data();

      // Spécialités du centre
      if (centre.specialites && Array.isArray(centre.specialites)) {
        centre.specialites.forEach(spec => {
          if (spec && typeof spec === 'string' && spec.trim().length > 0) {
            specialitesUniques.add(spec.trim());
          }
        });
      }

      // Services du centre
      if (centre.services && Array.isArray(centre.services)) {
        centre.services.forEach(service => {
          if (service && typeof service === 'string' && service.trim().length > 0) {
            specialitesUniques.add(service.trim());
          }
        });
      }
    }

    const specialitesListe = Array.from(specialitesUniques);

    if (specialitesListe.length === 0) {
      return null;
    }

    // Limiter et formater
    return specialitesListe
      .slice(0, 10)
      .map(spec => `• ${spec}`)
      .join('\n');

  } catch (error) {
    console.error('Erreur récupération spécialités réelles:', error.message);
    return null;
  }
}

async function finaliserRendezVous(userId, telephone, userState) {
  try {
    const {
      specialiteRdv,
      cliniqueSelectionneeRdv,
      dateRdv,
      heureRdv,
      nomRdv
    } = userState;

    if (!cliniqueSelectionneeRdv) {
      await sendWhatsAppMessage(userId, "❌ Aucune clinique sélectionnée.");
      return;
    }

    // Créer l'objet rendez-vous
    const rendezVousData = {
      centreSanteId: cliniqueSelectionneeRdv.id,
      centreSanteNom: cliniqueSelectionneeRdv.nom,
      date: convertirDateTimestamp(dateRdv, heureRdv),
      dateCreation: new Date().toISOString(),
      medecinId: genererMedecinId(specialiteRdv),
      medecinNom: `Dr. ${specialiteRdv}`,
      patientId: userId,
      patientNom: nomRdv,
      patientTelephone: telephone,
      serviceId: genererServiceId(specialiteRdv),
      serviceNom: specialiteRdv,
      statut: "en_attente",
      typeConsultation: "presentiel",
      notes: `Rendez-vous via WhatsApp Pillbox - ${specialiteRdv} - Clinique: ${cliniqueSelectionneeRdv.nom}`
    };

    // Enregistrer dans Firestore
    const rdvRef = await db.collection('rendez_vous').add(rendezVousData);
    const rdvReference = `RDV-${rdvRef.id.substring(0, 8)}`;

    // Message de confirmation
    await sendWhatsAppMessage(
      userId,
      `✅ Rendez-vous pris\n\n` +
      `👤 Patient : ${nomRdv}\n` +
      `📱 Téléphone : ${telephone}\n` +
      `🏥 Clinique : ${cliniqueSelectionneeRdv.nom}\n` +
      `📍 Adresse : ${cliniqueSelectionneeRdv.adresse || 'San Pedro'}\n` +
      `🩺 Spécialité : ${specialiteRdv}\n` +
      `📅 Date : ${dateRdv}\n` +
      `⏰ Heure : ${heureRdv}\n` +
      `📊 Statut : En attente de confirmation\n\n` +
      `La clinique vous contactera pour confirmation.\n\n` +
      `📱 **Pour suivre votre rendez-vous :**\n` +
      `• Dites "suivi rdv" ou "statut rendez-vous"\n` +
      `• Dites "merci" pour confirmer\n` +
      `• Dites "autre" pour une nouvelle demande\n\n` +
      `🔢 **Référence :** ${rdvReference}\n` +
      `📞 Support : ${CONFIG.SUPPORT_PHONE}`
    );

    // Enregistrer l'état "après rendez-vous"
    userState.apresRendezVous = true;
    userState.dernierRdvRef = rdvReference;

    // Réinitialiser les autres états
    userState.attenteTelephoneRdv = false;
    userState.specialiteRdv = null;
    userState.cliniqueSelectionneeRdv = null;
    userState.listeCliniquesRdv = null;
    userState.dateRdv = null;
    userState.heureRdv = null;
    userState.nomRdv = null;
    userState.step = 'MENU_PRINCIPAL';
    userStates.set(userId, userState);

  } catch (error) {
    console.error('❌ Erreur rendez-vous:', error.message);
    await sendWhatsAppMessage(
      userId,
      "❌ Erreur lors de la prise de rendez-vous.\n" +
      "📞 Contactez le support : " + CONFIG.SUPPORT_PHONE
    );
  }
}

function convertirDateTimestamp(dateStr, heureStr) {
  try {
    // Convertir "demain", "lundi", etc.
    let date = new Date();

    if (dateStr.toLowerCase() === 'demain') {
      date.setDate(date.getDate() + 1);
    } else if (dateStr.toLowerCase().includes('lundi')) {
      const jours = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
      const jourDemande = dateStr.toLowerCase();
      const aujourdHui = date.getDay();
      const jourIndex = jours.findIndex(j => jourDemande.includes(j));

      if (jourIndex > aujourdHui) {
        date.setDate(date.getDate() + (jourIndex - aujourdHui));
      } else {
        date.setDate(date.getDate() + (7 - aujourdHui + jourIndex));
      }
    } else if (dateStr.includes('/')) {
      // Format JJ/MM/AAAA
      const [jour, mois, annee] = dateStr.split('/').map(Number);
      date = new Date(annee, mois - 1, jour);
    }

    // Ajouter l'heure
    if (heureStr && heureStr.includes(':')) {
      const [heures, minutes] = heureStr.split(':').map(Number);
      date.setHours(heures, minutes, 0, 0);
    }

    return admin.firestore.Timestamp.fromDate(date);
  } catch (error) {
    console.error('❌ Erreur conversion date:', error);
    return admin.firestore.Timestamp.fromDate(new Date());
  }
}

function genererMedecinId(specialite) {
  return Date.now().toString() + specialite.substring(0, 3);
}

function genererServiceId(specialite) {
  return Date.now().toString() + specialite.substring(0, 5);
}

// =================== LISTE DES CLINIQUES ===================
async function afficherListeCliniquesReelles(userId) {
  try {
    await sendWhatsAppMessage(userId, "🔍 Recherche des cliniques à San Pedro...");

    const snapshot = await db.collection('centres_sante')
      .where('estVerifie', '==', true)
      .limit(10)
      .get();

    if (snapshot.empty) {
      await sendWhatsAppMessage(
        userId,
        "❌ Aucune clinique trouvée pour le moment.\n\n" +
        "📞 Contactez le support : " + CONFIG.SUPPORT_PHONE + "\n\n" +
        "📍 Service uniquement à San Pedro"
      );
      return;
    }

    let message = "🏥 Cliniques à San Pedro\n\n";

    snapshot.docs.forEach((doc, index) => {
      const clinique = doc.data();
      message += `${index + 1}. ${clinique.nom || 'Clinique'}\n`;
      message += `   ${clinique.adresse || 'San Pedro'}\n`;
      if (clinique.telephone) message += `   📞 ${clinique.telephone}\n`;

      // Afficher les spécialités si disponibles
      if (clinique.specialites && Array.isArray(clinique.specialites)) {
        const specialitesAffichees = clinique.specialites
          .filter(s => s && typeof s === 'string')
          .slice(0, 3);
        if (specialitesAffichees.length > 0) {
          message += `   🩺 ${specialitesAffichees.join(', ')}\n`;
        }
      }

      // Afficher un horaire si disponible
      if (clinique.horaires) {
        const horaires = clinique.horaires;
        const lundi = horaires.Lundi || horaires.lundi;
        if (lundi) message += `   ⏰ ${lundi}\n`;
      }

      message += `\n`;
    });

    message += "📅 Pour prendre rendez-vous :\n";
    message += 'Dites "rendez-vous [spécialité]"\n\n';
    message += "📞 Support : " + CONFIG.SUPPORT_PHONE;

    await sendWhatsAppMessage(userId, message);

  } catch (error) {
    console.error('❌ Erreur liste cliniques:', error.message);
    await sendWhatsAppMessage(
      userId,
      "❌ Erreur lors de la recherche.\n\n" +
      "📞 Contactez le support : " + CONFIG.SUPPORT_PHONE + "\n\n" +
      "📍 Service uniquement à San Pedro"
    );
  }
}

// =================== RECHERCHE PAR IMAGE ===================
async function traiterRechercheParImage(userId, mediaId, userState) {
  try {
    await sendWhatsAppMessage(userId, "📸 Image reçue.");

    await sendWhatsAppMessage(
      userId,
      "🔍 Pour rechercher un médicament par photo :\n\n" +
      "Écrivez le nom du médicament que vous voyez sur l'image.\n\n" +
      "📝 Exemples :\n" +
      "• Paracétamol\n" +
      "• Doliprane 1000mg\n" +
      "• Ibuprofène\n" +
      "• Amoxicilline"
    );

    userState.attenteMedicamentImage = true;
    userStates.set(userId, userState);

  } catch (error) {
    console.error('❌ Erreur image:', error.message);
    await sendWhatsAppMessage(userId, "❌ Erreur d'analyse. Écrivez le nom du médicament.");
  }
}

async function traiterImageOrdonnance(userId, userState) {
  await sendWhatsAppMessage(
    userId,
    "📄 Ordonnance reçue\n\n" +
    "Votre ordonnance a été envoyée pour validation.\n\n" +
    "Pour finaliser :\n" +
    "Envoyez maintenant vos informations une par une :\n\n" +
    "1. **Nom complet**\n" +
    "2. **Quartier**\n" +
    "3. **Numéro WhatsApp**\n" +
    "4. **Indications pour la livraison**\n\n" +
    "Commencez par votre nom :"
  );

  userState.attentePhotoOrdonnance = false;
  userState.step = 'ATTENTE_NOM';
  userState.attenteNom = true;
  userStates.set(userId, userState);
}

// =================== TRAITEMENT INFORMATIONS DE LIVRAISON ===================
async function collecterInfosLivraison(userId, message, userState) {
  console.log(`📦 Collecte infos livraison: "${message}"`);

  // Étape 1: Collecte du nom
  if (userState.step === 'ATTENTE_NOM' || userState.attenteNom) {
    userState.nom = message.trim();
    userState.attenteNom = false;
    userState.attenteQuartier = true;
    userState.step = 'ATTENTE_QUARTIER';
    userStates.set(userId, userState);

    await sendWhatsAppMessage(
      userId,
      `👤 Nom : ${userState.nom}\n\n` +
      `Maintenant, quel est votre quartier à San Pedro ?`
    );
    return;
  }

  // Étape 2: Collecte du quartier
  if (userState.step === 'ATTENTE_QUARTIER' || userState.attenteQuartier) {
    userState.quartier = message.trim();
    userState.attenteQuartier = false;
    userState.attenteWhatsApp = true;
    userState.step = 'ATTENTE_WHATSAPP';
    userStates.set(userId, userState);

    await sendWhatsAppMessage(
      userId,
      `📍 Quartier : ${userState.quartier}\n\n` +
      `Maintenant, quel est votre numéro WhatsApp ?\n` +
      `Format : 07XXXXXXXX`
    );
    return;
  }

  // Étape 3: Collecte du WhatsApp
  if (userState.step === 'ATTENTE_WHATSAPP' || userState.attenteWhatsApp) {
    // Valider le numéro
    const numero = message.trim();
    const regexWhatsApp = /^(07|01|05)\d{8}$/;

    if (!regexWhatsApp.test(numero)) {
      await sendWhatsAppMessage(
        userId,
        `❌ Format de numéro invalide.\n\n` +
        `Veuillez entrer un numéro valide au format 07XXXXXXXX\n` +
        `Exemple : 0709548989`
      );
      return;
    }

    userState.whatsapp = numero;
    userState.attenteWhatsApp = false;
    userState.attenteIndications = true;
    userState.step = 'ATTENTE_INDICATIONS';
    userStates.set(userId, userState);

    await sendWhatsAppMessage(
      userId,
      `📱 WhatsApp : ${userState.whatsapp}\n\n` +
      `Enfin, des indications pour la livraison ?\n` +
      `(Exemple : "vers le marché", "près de l'église", "maison bleue", etc.)\n\n` +
      `Si aucune indication spéciale, répondez "aucune"`
    );
    return;
  }

  // Étape 4: Collecte des indications
  if (userState.step === 'ATTENTE_INDICATIONS' || userState.attenteIndications) {
    userState.indications = message.trim().toLowerCase() === 'aucune' ? '' : message.trim();
    userState.attenteIndications = false;
    userState.step = 'CONFIRMATION_LIVRAISON';
    userStates.set(userId, userState);

    // Confirmer les informations
    await confirmerInfosLivraison(userId, userState);
    return;
  }
}

async function collecterInfosLivraisonMulti(userId, message, userState) {
  console.log(`📦 Collecte infos livraison multi: "${message}"`);

  // Étape 1: Collecte du nom
  if (userState.step === 'ATTENTE_NOM_MULTI' || userState.attenteNom) {
    userState.nom = message.trim();
    userState.attenteNom = false;
    userState.attenteQuartier = true;
    userState.step = 'ATTENTE_QUARTIER_MULTI';
    userStates.set(userId, userState);

    await sendWhatsAppMessage(
      userId,
      `👤 Nom : ${userState.nom}\n\n` +
      `Maintenant, quel est votre quartier à San Pedro ?`
    );
    return;
  }

  // Étape 2: Collecte du quartier
  if (userState.step === 'ATTENTE_QUARTIER_MULTI' || userState.attenteQuartier) {
    userState.quartier = message.trim();
    userState.attenteQuartier = false;
    userState.attenteWhatsApp = true;
    userState.step = 'ATTENTE_WHATSAPP_MULTI';
    userStates.set(userId, userState);

    await sendWhatsAppMessage(
      userId,
      `📍 Quartier : ${userState.quartier}\n\n` +
      `Maintenant, quel est votre numéro WhatsApp ?\n` +
      `Format : 07XXXXXXXX`
    );
    return;
  }

  // Étape 3: Collecte du WhatsApp
  if (userState.step === 'ATTENTE_WHATSAPP_MULTI' || userState.attenteWhatsApp) {
    // Valider le numéro
    const numero = message.trim();
    const regexWhatsApp = /^(07|01|05)\d{8}$/;

    if (!regexWhatsApp.test(numero)) {
      await sendWhatsAppMessage(
        userId,
        `❌ Format de numéro invalide.\n\n` +
        `Veuillez entrer un numéro valide au format 07XXXXXXXX\n` +
        `Exemple : 0709548989`
      );
      return;
    }

    userState.whatsapp = numero;
    userState.attenteWhatsApp = false;
    userState.attenteIndications = true;
    userState.step = 'ATTENTE_INDICATIONS_MULTI';
    userStates.set(userId, userState);

    await sendWhatsAppMessage(
      userId,
      `📱 WhatsApp : ${userState.whatsapp}\n\n` +
      `Enfin, des indications pour la livraison ?\n` +
      `(Exemple : "vers le marché", "près de l'église", "maison bleue", etc.)\n\n` +
      `Si aucune indication spéciale, répondez "aucune"`
    );
    return;
  }

  // Étape 4: Collecte des indications
  if (userState.step === 'ATTENTE_INDICATIONS_MULTI' || userState.attenteIndications) {
    userState.indications = message.trim().toLowerCase() === 'aucune' ? '' : message.trim();
    userState.attenteIndications = false;
    userState.step = 'CONFIRMATION_LIVRAISON_MULTI';
    userStates.set(userId, userState);

    // Confirmer les informations
    await confirmerInfosLivraisonMulti(userId, userState);
    return;
  }
}

async function confirmerInfosLivraison(userId, userState) {
  const commande = userState.commandeEnCours;
  const numeroCommande = `CMD${Date.now().toString().slice(-6)}`;

  await sendWhatsAppMessage(
    userId,
    `✅ Informations confirmées\n\n` +
    `👤 **Nom :** ${userState.nom}\n` +
    `📍 **Quartier :** ${userState.quartier}\n` +
    `📱 **WhatsApp :** ${userState.whatsapp}\n` +
    (userState.indications ? `🗺️ **Indications :** ${userState.indications}\n\n` : `\n`) +
    `Votre commande est en cours de traitement...`
  );

  // Créer la commande dans Firestore
  await creerCommandeFirestore(userId, userState, commande, numeroCommande);

  // Assigner un livreur
  const livreurInfo = await assignerLivreur(userId, userState.quartier);

  // Envoyer confirmation finale avec infos livreur
  await sendConfirmationFinale(userId, userState, commande, numeroCommande, livreurInfo);

  // Réinitialiser l'état utilisateur
  reinitialiserEtatUtilisateur(userId, userState);
}

async function confirmerInfosLivraisonMulti(userId, userState) {
  const commande = userState.commandeEnCours;
  const panier = commande.panier || [];
  const numeroCommande = `CMD${Date.now().toString().slice(-6)}`;

  await sendWhatsAppMessage(
    userId,
    `✅ Informations confirmées\n\n` +
    `👤 **Nom :** ${userState.nom}\n` +
    `📍 **Quartier :** ${userState.quartier}\n` +
    `📱 **WhatsApp :** ${userState.whatsapp}\n` +
    (userState.indications ? `🗺️ **Indications :** ${userState.indications}\n\n` : `\n`) +
    `Votre commande multi-médicaments est en cours de traitement...`
  );

  // Créer la commande dans Firestore
  await creerCommandeMultiFirestore(userId, userState, commande, numeroCommande);

  // Assigner un livreur
  const livreurInfo = await assignerLivreur(userId, userState.quartier);

  // Envoyer confirmation finale avec infos livreur
  await sendConfirmationFinaleMulti(userId, userState, commande, numeroCommande, livreurInfo);

  // Réinitialiser l'état utilisateur
  reinitialiserEtatUtilisateur(userId, userState);
}

async function creerCommandeFirestore(userId, userState, commande, numeroCommande) {
  try {
    const commandeData = {
      clientId: userId,
      clientNom: userState.nom,
      clientTelephone: userState.whatsapp,
      quartier: userState.quartier,
      indications: userState.indications || '',
      date_commande: admin.firestore.FieldValue.serverTimestamp(),
      statut: 'en_preparation',
      numeroCommande: numeroCommande,
      articles: [{
        medicamentId: commande.medicamentId,
        medicamentNom: commande.medicamentNom,
        pharmacieId: commande.pharmacieId,
        pharmacienom: commande.pharmacieNom,
        quantite: commande.quantite,
        prix_unitaire: commande.prixUnitaire,
        prix_total: commande.prixTotal
      }],
      paiement: {
        mode: 'cash_livraison',
        montant_total: commande.total,
        statut_paiement: 'en_attente'
      },
      livraison: {
        frais: commande.fraisLivraison,
        statut_livraison: 'en_attente_livreur',
        livreurId: null,
        livreurNom: null
      }
    };

    await db.collection('commandes_medicales').add(commandeData);
    console.log(`✅ Commande créée dans Firestore: ${numeroCommande}`);
  } catch (error) {
    console.error('❌ Erreur création commande Firestore:', error.message);
  }
}

async function creerCommandeMultiFirestore(userId, userState, commande, numeroCommande) {
  try {
    const articles = commande.panier.map(item => ({
      medicamentId: item.medicamentId,
      medicamentNom: item.medicamentNom,
      pharmacieId: item.pharmacieId,
      pharmacienom: item.pharmacieNom,
      quantite: item.quantite,
      prix_unitaire: item.prixUnitaire,
      prix_total: item.prixUnitaire * item.quantite
    }));

    const commandeData = {
      clientId: userId,
      clientNom: userState.nom,
      clientTelephone: userState.whatsapp,
      quartier: userState.quartier,
      indications: userState.indications || '',
      date_commande: admin.firestore.FieldValue.serverTimestamp(),
      statut: 'en_preparation',
      numeroCommande: numeroCommande,
      articles: articles,
      paiement: {
        mode: 'cash_livraison',
        montant_total: commande.total,
        statut_paiement: 'en_attente'
      },
      livraison: {
        frais: commande.fraisLivraison,
        statut_livraison: 'en_attente_livreur',
        livreurId: null,
        livreurNom: null
      }
    };

    await db.collection('commandes_medicales').add(commandeData);
    console.log(`✅ Commande multi créée dans Firestore: ${numeroCommande}`);
  } catch (error) {
    console.error('❌ Erreur création commande multi Firestore:', error.message);
  }
}

async function assignerLivreur(userId, quartier) {
  try {
    // Chercher un livreur disponible
    const snapshot = await db.collection('livreurs')
      .where('estDisponible', '==', true)
      .where('estVerifie', '==', true)
      .limit(1)
      .get();

    if (snapshot.empty) {
      console.log('❌ Aucun livreur disponible');
      return null;
    }

    const livreurDoc = snapshot.docs[0];
    const livreur = livreurDoc.data();

    return {
      id: livreurDoc.id,
      nom: `${livreur.prenom} ${livreur.nom}`,
      telephone: livreur.telephone,
      photo: livreur.photoProfileUrl
    };
  } catch (error) {
    console.error('❌ Erreur assignation livreur:', error.message);
    return null;
  }
}

async function sendConfirmationFinale(userId, userState, commande, numeroCommande, livreurInfo) {
  let message = `✅ Commande confirmée #${numeroCommande}\n\n`;

  message += `👤 **Client :** ${userState.nom}\n`;
  message += `📍 **Quartier :** ${userState.quartier}\n`;
  message += `📱 **WhatsApp :** ${userState.whatsapp}\n`;
  if (userState.indications) message += `🗺️ **Indications :** ${userState.indications}\n\n`;

  message += `🛒 **Commande :**\n`;
  message += `${commande.medicamentNom} × ${commande.quantite}\n`;
  message += `🏥 **Pharmacie :** ${commande.pharmacieNom}\n`;
  message += `💰 **Total médicaments :** ${commande.prixTotal} FCFA\n`;
  message += `🚚 **Livraison :** ${commande.fraisLivraison} FCFA\n`;
  message += `💵 **TOTAL À PAYER :** ${commande.total} FCFA\n\n`;

  if (livreurInfo) {
    message += `🚴 **LIVREUR ASSIGNÉ :**\n`;
    message += `👤 ${livreurInfo.nom}\n`;
    message += `📱 ${livreurInfo.telephone}\n\n`;
    message += `📞 Votre livreur vous contactera pour confirmation.\n\n`;
  }

  message += `📋 **Processus :**\n`;
  message += `1. ✅ Commande envoyée à la pharmacie\n`;
  message += `2. 📦 Préparation en cours\n`;
  message += `3. 🚴 Livreur en route vers la pharmacie\n`;
  message += `4. 🏠 Livraison à votre adresse\n\n`;

  message += `⏰ **Délai estimé :** 45-60 minutes\n\n`;
  
  message += `📱 **Pour suivre votre commande :**\n`;
  message += `• Dites "suivi" ou "où en est ma commande ?"\n`;
  message += `• Dites "merci" pour confirmer\n`;
  message += `• Dites "autre" pour une nouvelle demande\n\n`;
  
  message += `📞 **Support & suivi :**\n`;
  message += `${CONFIG.SUPPORT_PHONE}\n`;
  message += `🔢 **Référence :** ${numeroCommande}`;

  await sendWhatsAppMessage(userId, message);
  
  // Enregistrer l'état "après commande"
  userState.apresCommande = true;
  userState.derniereCommandeRef = numeroCommande;
  if (livreurInfo) {
    userState.dernierLivreurNom = livreurInfo.nom;
    userState.dernierLivreurTel = livreurInfo.telephone;
  }
  userStates.set(userId, userState);
}

async function sendConfirmationFinaleMulti(userId, userState, commande, numeroCommande, livreurInfo) {
  const panier = commande.panier || [];

  let message = `✅ Commande confirmée #${numeroCommande}\n\n`;

  message += `👤 **Client :** ${userState.nom}\n`;
  message += `📍 **Quartier :** ${userState.quartier}\n`;
  message += `📱 **WhatsApp :** ${userState.whatsapp}\n`;
  if (userState.indications) message += `🗺️ **Indications :** ${userState.indications}\n\n`;

  message += `🛒 **Votre commande (${panier.length} médicament(s)) :**\n\n`;
  panier.forEach((item, index) => {
    message += `${index + 1}. ${item.medicamentNom} × ${item.quantite}\n`;
    const totalItem = item.prixUnitaire * item.quantite;
    message += `   ${item.prixUnitaire} FCFA × ${item.quantite} = ${totalItem} FCFA\n`;
    if (item.necessiteOrdonnance) message += `   📄 Ordonnance requise\n`;
    message += `\n`;
  });

  message += `💰 **Sous-total :** ${commande.sousTotal} FCFA\n`;
  message += `🚚 **Livraison :** ${commande.fraisLivraison} FCFA\n`;
  message += `💵 **TOTAL À PAYER :** ${commande.total} FCFA\n\n`;

  if (livreurInfo) {
    message += `🚴 **LIVREUR ASSIGNÉ :**\n`;
    message += `👤 ${livreurInfo.nom}\n`;
    message += `📱 ${livreurInfo.telephone}\n\n`;
    message += `📞 Votre livreur vous contactera pour confirmation.\n\n`;
  }

  message += `📋 **Processus :**\n`;
  message += `1. ✅ Commande envoyée aux pharmacies\n`;
  message += `2. 📦 Préparation en cours\n`;
  message += `3. 🚴 Livreur en route vers les pharmacies\n`;
  message += `4. 🏠 Livraison à votre adresse\n\n`;

  message += `⏰ **Délai estimé :** 45-60 minutes\n\n`;
  
  message += `📱 **Pour suivre votre commande :**\n`;
  message += `• Dites "suivi" ou "où en est ma commande ?"\n`;
  message += `• Dites "merci" pour confirmer\n`;
  message += `• Dites "autre" pour une nouvelle demande\n\n`;
  
  message += `📞 **Support & suivi :**\n`;
  message += `${CONFIG.SUPPORT_PHONE}\n`;
  message += `🔢 **Référence :** ${numeroCommande}`;

  await sendWhatsAppMessage(userId, message);
  
  // Enregistrer l'état "après commande"
  userState.apresCommande = true;
  userState.derniereCommandeRef = numeroCommande;
  if (livreurInfo) {
    userState.dernierLivreurNom = livreurInfo.nom;
    userState.dernierLivreurTel = livreurInfo.telephone;
  }
  userStates.set(userId, userState);
}

function reinitialiserEtatUtilisateur(userId, userState) {
  userState.commandeEnCours = null;
  userState.panier = [];
  userState.resultatsRechercheMedicaments = null;
  userState.listeMedicamentsAvecIndex = [];
  userState.nom = null;
  userState.quartier = null;
  userState.whatsapp = null;
  userState.indications = null;
  userState.attenteNom = false;
  userState.attenteQuartier = false;
  userState.attenteWhatsApp = false;
  userState.attenteIndications = false;
  userState.step = 'MENU_PRINCIPAL';
  // NE PAS réinitialiser les états post-interaction
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

  // Répondre immédiatement
  res.status(200).send('EVENT_RECEIVED');

  // Traiter le message en arrière-plan
  setImmediate(async () => {
    try {
      const entry = req.body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const message = value?.messages?.[0];

      if (!message) {
        console.log('📩 Message vide ou non texte');
        return;
      }

      // Marquer le message comme lu
      if (message.id) {
        await markMessageAsRead(message.id);
      }

      // Ignorer messages non supportés
      if (message.type === 'unsupported' || message.type === 'system') {
        console.log('📩 Message non supporté ignoré');
        return;
      }

      const userId = message.from;
      const messageType = message.type;

      // Récupérer état utilisateur
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
          console.log(`⚠️ Message dupliqué ignoré: "${text}"`);
          return;
        }

        // Traitement avec verrou
        await withUserLock(userId, async () => {
          // VÉRIFIER D'ABORD LES REMERCIEMENTS ET SUIVI
          const traiteRemerciement = await gererRemerciementsEtSuivi(userId, text, userState);
          if (traiteRemerciement) {
            return;
          }

          // États de collecte d'informations
          if (userState.step === 'ATTENTE_NOM' ||
              userState.step === 'ATTENTE_QUARTIER' ||
              userState.step === 'ATTENTE_WHATSAPP' ||
              userState.step === 'ATTENTE_INDICATIONS') {
            await collecterInfosLivraison(userId, text, userState);
            return;
          }

          if (userState.step === 'ATTENTE_NOM_MULTI' ||
              userState.step === 'ATTENTE_QUARTIER_MULTI' ||
              userState.step === 'ATTENTE_WHATSAPP_MULTI' ||
              userState.step === 'ATTENTE_INDICATIONS_MULTI') {
            await collecterInfosLivraisonMulti(userId, text, userState);
            return;
          }

          // Gestion du panier
          const resultatPanier = await gestionPanier.gererMessage(userId, text, userState);
          if (resultatPanier !== null) {
            return;
          }

          // Vérifier états spéciaux
          if (userState.attenteMedicamentImage) {
            await rechercherEtAfficherMedicament(userId, text);
            userState.attenteMedicamentImage = false;
            userStates.set(userId, userState);
            return;
          }

          if (userState.attenteMedicament) {
            await rechercherEtAfficherMedicament(userId, text);
            userState.attenteMedicament = false;
            userStates.set(userId, userState);
            return;
          }

          if (userState.attenteCommande && userState.listeMedicamentsAvecIndex) {
            await traiterCommandeMedicament(userId, text, userState);
            return;
          }

          // États de rendez-vous
          if (userState.attenteSpecialiteRdv ||
              userState.attenteSelectionCliniqueRdv ||
              userState.attenteDateRdv ||
              userState.attenteHeureRdv ||
              userState.attenteNomRdv ||
              userState.attenteTelephoneRdv) {

            await gererPriseRendezVous(userId, text);
            return;
          }

          // Utiliser Groq comme cerveau principal
          await comprendreEtAgir(userId, text);

          // Mettre à jour historique
          if (!userState.historiqueMessages) {
            userState.historiqueMessages = [];
          }
          userState.historiqueMessages.push({
            message: text,
            timestamp: new Date().toISOString()
          });

          // Limiter historique
          if (userState.historiqueMessages.length > 20) {
            userState.historiqueMessages = userState.historiqueMessages.slice(-20);
          }

          userStates.set(userId, userState);
        });

      } else if (messageType === 'image') {
        const mediaId = message.image.id;

        // Vérifier l'état de l'utilisateur
        if (userState.step === 'ATTENTE_ORDONNANCE') {
          // Ordonnance pour commande en cours
          await traiterImageOrdonnance(userId, userState);

        } else if (userState.step === 'ATTENTE_ORDONNANCE_MULTI') {
          // Ordonnance pour commande multi-médicaments
          await traiterImageOrdonnance(userId, userState);

        } else if (userState.attentePhotoOrdonnance) {
          // Ancien système
          await traiterImageOrdonnance(userId, userState);

        } else {
          // Recherche de médicament par image
          await traiterRechercheParImage(userId, mediaId, userState);
        }
      }

    } catch (error) {
      console.error('💥 ERREUR WEBHOOK:', error.message);
    }
  });
});

// =================== ENDPOINTS ADMIN ===================
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'Pillbox WhatsApp Bot PRODUCTION',
    version: '3.2.0',
    users_actifs: userStates.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    support_phone: CONFIG.SUPPORT_PHONE
  });
});

app.get('/api/stats', (req, res) => {
  const stats = {
    users_actifs: userStates.size,
    users_details: Array.from(userStates.entries()).map(([id, state]) => ({
      id: id,
      step: state.step,
      initialized: state.initialized
    })),
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
      groq: CONFIG.GROQ_API_KEY ? 'Configured' : 'Not configured'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =================== INITIALISATION ===================
async function verifierDonneesInitiales() {
  try {
    console.log('🔍 Vérification des données initiales...');

    const collections = ['medicaments', 'pharmacies', 'centres_sante'];
    const stats = {};

    for (const collection of collections) {
      const snapshot = await db.collection(collection).limit(1).get();
      stats[collection] = !snapshot.empty;
    }

    // Compter médicaments en stock
    const medicamentsSnapshot = await db.collection('medicaments').where('stock', '>', 0).limit(10).get();
    stats.medicaments_en_stock = medicamentsSnapshot.size;

    // Compter pharmacies de garde
    const pharmaciesSnapshot = await db.collection('pharmacies')
      .where('estDeGarde', '==', true)
      .where('estOuvert', '==', true)
      .limit(10)
      .get();
    stats.pharmacies_de_garde = pharmaciesSnapshot.size;

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
🚀 PILLBOX WHATSAPP BOT - PRODUCTION V3.2
=======================================================
📍 Port: ${PORT}
🏙️ Zone: San Pedro uniquement
🤖 Intelligence: Groq avec contexte
💊 Services: Multi-médicaments, RDV, Conseils
📞 Support: ${CONFIG.SUPPORT_PHONE}
=======================================================
✅ PRÊT À RECEVOIR DES MESSAGES !
✅ Gestion intelligente du contexte
✅ Achats multi-médicaments
✅ Processus de livraison optimisé
✅ Informations collectées une par une
✅ Gestion des remerciements et suivi
=======================================================
  `);
});

// Nettoyage périodique
setInterval(() => {
  const now = Date.now();
  const uneHeure = 60 * 60 * 1000;

  // Nettoyer états inactifs
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

  // Nettoyer verrous
  for (const [userId, lockTime] of processingLocks.entries()) {
    if (now - lockTime > 30000) {
      processingLocks.delete(userId);
    }
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