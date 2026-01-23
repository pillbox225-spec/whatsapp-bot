// =================== CONFIGURATION INITIALE ===================
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
  SUPPORT_PHONE: "+2250701406880",
  LIVRAISON_JOUR: 400,
  LIVRAISON_NUIT: 600,
  ZONE_SAN_PEDRO: {
    minLat: 4.6, maxLat: 5.0,
    minLng: -6.8, maxLng: -6.6
  }
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

// =================== ÉTAT UTILISATEUR ===================
const DEFAULT_STATE = {
  step: 'MENU_PRINCIPAL',
  panier: [],
  panierTemporaire: [],
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
  modeMultiMedicaments: false,
  dernierMedicamentAjoute: null,
  confirmationPanierAttendue: false,
  
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
const CACHE_DURATION = 5000;

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
  
  processingLocks.set(userId, true);
  try {
    return await callback();
  } finally {
    setTimeout(() => {
      processingLocks.delete(userId);
    }, 1000);
  }
}

function getFraisLivraison() {
  const maintenant = new Date();
  const heure = maintenant.getHours();
  return (heure >= 0 && heure < 8) ? CONFIG.LIVRAISON_NUIT : CONFIG.LIVRAISON_JOUR;
}

// =================== GESTION DU PANIER ===================
async function gererPanier(userId, action, medicamentInfo = null, quantite = 1) {
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };
  
  if (!userState.panier) userState.panier = [];
  if (!userState.panierTemporaire) userState.panierTemporaire = [];
  
  switch (action) {
    case 'AJOUTER':
      if (!medicamentInfo) return false;
      
      const indexExistant = userState.panierTemporaire.findIndex(
        item => item.medicamentId === medicamentInfo.medicamentId
      );
      
      if (indexExistant >= 0) {
        userState.panierTemporaire[indexExistant].quantite += quantite;
      } else {
        userState.panierTemporaire.push({
          medicamentId: medicamentInfo.medicamentId,
          medicamentNom: medicamentInfo.medicament.nom,
          pharmacieId: medicamentInfo.pharmacieId,
          pharmacieNom: medicamentInfo.pharmacieNom,
          quantite: quantite,
          prixUnitaire: medicamentInfo.medicament.prix || 0,
          necessiteOrdonnance: medicamentInfo.medicament.necessiteOrdonnance || false,
          dosage: medicamentInfo.medicament.dosage,
          forme: medicamentInfo.medicament.forme
        });
      }
      
      userState.dernierMedicamentAjoute = medicamentInfo;
      break;
      
    case 'AFFICHER':
      return await afficherPanier(userId);
      
    case 'VIDER':
      userState.panierTemporaire = [];
      userState.panier = [];
      await sendWhatsAppMessage(userId, "🛒 Votre panier a été vidé.");
      break;
      
    case 'CONFIRMER':
      userState.panier = [...userState.panierTemporaire];
      userState.modeMultiMedicaments = false;
      userState.confirmationPanierAttendue = false;
      break;
      
    case 'CALCULER_TOTAL':
      return calculerTotalPanier(userState.panierTemporaire);
  }
  
  userStates.set(userId, userState);
  return true;
}

async function afficherPanier(userId) {
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };
  const panier = userState.panierTemporaire || [];
  
  if (panier.length === 0) {
    await sendWhatsAppMessage(userId, "🛒 Votre panier est vide.");
    return false;
  }
  
  const { sousTotal, fraisLivraison, total } = calculerTotalPanier(panier);
  
  let message = "🛒 **VOTRE PANIER**\n\n";
  
  panier.forEach((item, index) => {
    message += `${index + 1}. **${item.medicamentNom}**\n`;
    message += `   💰 ${item.prixUnitaire} FCFA × ${item.quantite} = ${item.prixUnitaire * item.quantite} FCFA\n`;
    message += `   🏥 ${item.pharmacieNom}\n`;
    if (item.dosage || item.forme) {
      message += `   💊 ${item.dosage || ''} ${item.forme || ''}\n`;
    }
    if (item.necessiteOrdonnance) {
      message += `   ⚠️ Ordonnance requise\n`;
    }
    message += `\n`;
  });
  
  message += "📊 **RÉCAPITULATIF :**\n";
  message += `🧾 Sous-total : ${sousTotal} FCFA\n`;
  message += `🚚 Frais de livraison : ${fraisLivraison} FCFA\n`;
  message += `🎯 **TOTAL À PAYER : ${total} FCFA**\n\n`;
  
  message += "📝 **COMMANDES DISPONIBLES :**\n";
  message += "• *AJOUTER [numéro] [quantité]* - Ajouter un médicament\n";
  message += "• *RETIRER [numéro]* - Retirer du panier\n";
  message += "• *VIDER PANIER* - Vider tout le panier\n";
  message += "• *FINI* - Finaliser la commande\n";
  message += "• *CONTINUER* - Ajouter d'autres médicaments\n\n";
  
  message += "💡 **Exemple :** AJOUTER 1 2 (pour ajouter 2 du médicament n°1)";
  
  await sendWhatsAppMessage(userId, message);
  return true;
}

function calculerTotalPanier(panier) {
  const sousTotal = panier.reduce((total, item) => {
    return total + (item.prixUnitaire * item.quantite);
  }, 0);
  
  const fraisLivraison = getFraisLivraison();
  const total = sousTotal + fraisLivraison;
  
  return { sousTotal, fraisLivraison, total };
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

async function sendInteractiveMessage(to, text, buttons) {
  try {
    const buttonsValides = buttons.map(button => ({
      type: "reply",
      reply: {
        id: button.id.substring(0, 256),
        title: button.title.substring(0, 20)
      }
    }));

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
          action: { buttons: buttonsValides.slice(0, 3) }
        }
      },
      {
        headers: { 
          'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`, 
          'Content-Type': 'application/json' 
        }
      }
    );
    return response.data.messages?.[0]?.id;
  } catch (error) {
    console.error('❌ Erreur message interactif:', error.response?.data || error.message);
    await sendWhatsAppMessage(to, text + "\n\n💡 Répondez avec le numéro de votre choix.");
    return null;
  }
}

// =================== CERVEAU PRINCIPAL - GROQ ===================
async function comprendreEtAgir(userId, message) {
  console.log(`🧠 [GROQ] Analyse: "${message}"`);
  
  // Mettre à jour le contexte
  await gestionnaireContexte.mettreAJourContexte(userId, message, 'user');
  
  // Obtenir le résumé du contexte
  const resumeContexte = gestionnaireContexte.obtenirResumeContexte(userId);
  
  // Interpréter les références
  let messageAInterpreter = message;
  const referenceInterpretee = gestionnaireContexte.interpreterReference(userId, message);
  
  if (referenceInterpretee) {
    console.log(`🔗 Référence détectée: "${message}" -> "${referenceInterpretee}"`);
    messageAInterpreter = `${message} (en parlant de: ${referenceInterpretee})`;
  }
  
  const prompt = `
Tu es Mia, l'assistante médicale intelligente de Pillbox à San Pedro, Côte d'Ivoire.

## CONTEXTE DE LA CONVERSATION :
${resumeContexte}

## MESSAGE ACTUEL DE L'UTILISATEUR :
"${messageAInterpreter}"

## TÂCHE : 
1. ANALYSER le message en tenant compte du contexte
2. COMPRENDRE les références implicites
3. ADAPTER ton langage à l'état émotionnel
4. UTILISER les informations connues sur l'utilisateur
5. ÉVITER de répéter des informations déjà données
6. ANTICIPER les besoins basés sur l'historique

## EXEMPLES DE COMPRÉHENSION CONTEXTUELLE :
• "Je veux celui que tu as dit" → Référence au dernier médicament mentionné
• "Pour cette douleur aussi" → En plus des symptômes précédents
• "Et pour mon problème de [condition connue] ?" → Adapté à la condition
• "C'est urgent !" → Ton rassurant et direct

## ACTIONS POSSIBLES :
• PHARMACIE_GARDE - Recherche pharmacie de garde
• ACHAT_MEDICAMENT - Achat médicament simple
• ACHAT_MEDICAMENT_MULTI - Achat plusieurs médicaments
• RENDEZ_VOUS - Prise de rendez-vous médical
• INFO_CLINIQUE - Informations sur les cliniques
• PRIX_DISPONIBILITE - Vérification prix/disponibilité
• SUPPORT - Support/aide technique
• SALUTATION - Salutations simples
• CONSEIL_SANTE - Conseil santé contextuel
• AUTRE - Autres demandes

RÉPONDS UNIQUEMENT en JSON:
{
  "action": "ACTION_PRINCIPALE",
  "reponse_immediate": "Réponse personnalisée tenant compte du contexte",
  "medicament": "nom_du_medicament_ou_null",
  "specialite": "specialite_ou_null",
  "mot_cle": "mot_cle_ou_null",
  "contexte_utilise": true/false
}
`;

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: CONFIG.GROQ_MODEL,
        messages: [
          { 
            role: "system", 
            content: "Tu analyses les messages avec le contexte de la conversation. Réponds toujours en JSON valide." 
          },
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
        timeout: 8000
      }
    );

    const result = JSON.parse(response.data.choices[0].message.content);
    console.log('✅ [GROQ] Résultat:', JSON.stringify(result));
    
    // Mettre à jour le contexte avec la réponse
    await gestionnaireContexte.mettreAJourContexte(
      userId, 
      result.reponse_immediate, 
      'assistant'
    );
    
    // Envoyer la réponse
    await sendWhatsAppMessage(userId, result.reponse_immediate);
    
    // Exécuter l'action
    await executerActionContextuel(userId, result, message);
    
    return result;
    
  } catch (error) {
    console.error('❌ Erreur Groq:', error.message);
    await fallbackIntelligentAvecContexte(userId, message);
  }
}

// =================== EXÉCUTION DES ACTIONS ===================
async function executerActionContextuel(userId, analyse, messageOriginal) {
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };
  const contexte = userState.contexte || {};
  
  console.log(`⚡ [ACTION] Exécution: ${analyse.action}`);
  
  // Éviter ré-exécution rapide
  if (userState.currentAction === analyse.action && 
      Date.now() - (userState.actionTimestamp || 0) < 3000) {
    console.log(`⏭️ Action ${analyse.action} déjà en cours, ignorée`);
    return;
  }
  
  userState.currentAction = analyse.action;
  userState.actionTimestamp = Date.now();
  
  switch (analyse.action) {
    case 'PHARMACIE_GARDE':
      await afficherPharmaciesDeGarde(userId);
      break;
      
    case 'ACHAT_MEDICAMENT':
      // Gestion des références implicites
      if (messageOriginal.includes("celui") || messageOriginal.includes("ce médicament")) {
        const dernierMedicament = contexte.medical?.dernierMedicamentMentionne;
        if (dernierMedicament) {
          await sendWhatsAppMessage(userId, `💊 Je recherche "${dernierMedicament}"...`);
          await rechercherEtAfficherMedicament(userId, dernierMedicament, false);
          break;
        }
      }
      
      if (analyse.medicament) {
        await rechercherEtAfficherMedicament(userId, analyse.medicament, false);
      } else {
        // Suggestions basées sur symptômes
        if (contexte.medical?.symptomesActuels?.length > 0) {
          const symptomes = contexte.medical.symptomesActuels.join(', ');
          await sendWhatsAppMessage(
            userId,
            `🤔 Pour vos symptômes (${symptomes}), quel médicament cherchez-vous ?\n\n` +
            `💡 Suggestions :\n` +
            `• Paracétamol pour douleur/fièvre\n` +
            `• Sirop pour la toux\n` +
            `• Anti-inflammatoire`
          );
        } else {
          await demanderNomMedicament(userId);
        }
        userState.attenteMedicament = true;
      }
      break;
      
    case 'ACHAT_MEDICAMENT_MULTI':
      await sendWhatsAppMessage(
        userId,
        "🛒 **MODE MULTI-MÉDICAMENTS**\n\n" +
        "Parfait ! Vous pouvez ajouter plusieurs médicaments.\n\n" +
        "📝 **Dites-moi le premier médicament :**\n\n" +
        "💡 Exemples :\n" +
        "• Paracétamol\n" +
        "• Ibuprofène\n" +
        "• Vitamine C\n" +
        "• Sirop contre la toux"
      );
      
      userState.attenteMedicament = true;
      userState.modeMultiMedicaments = true;
      break;
      
    case 'RENDEZ_VOUS':
      // Suggestions basées sur symptômes
      if (contexte.medical?.symptomesActuels?.length > 0 && !analyse.specialite) {
        const symptomes = contexte.medical.symptomesActuels;
        let specialiteSuggeree = 'médecin généraliste';
        
        if (symptomes.includes('douleur') && symptomes.includes('tête')) {
          specialiteSuggeree = 'médecin généraliste';
        } else if (symptomes.includes('allergie')) {
          specialiteSuggeree = 'allergologue';
        }
        
        await sendWhatsAppMessage(
          userId,
          `📅 Pour vos symptômes, je suggère un ${specialiteSuggeree}.\n\n` +
          `Confirmez-vous ou voulez-vous une autre spécialité ?`
        );
        
        userState.attenteSpecialite = true;
        
      } else if (analyse.specialite) {
        await chercherCliniquesParSpecialite(userId, analyse.specialite);
      } else {
        await demanderSpecialite(userId);
        userState.attenteSpecialite = true;
      }
      break;
      
    case 'INFO_CLINIQUE':
      await afficherToutesCliniques(userId);
      break;
      
    case 'PRIX_DISPONIBILITE':
      if (analyse.medicament) {
        await afficherPrixDisponibilite(userId, analyse.medicament);
      } else {
        await demanderMedicamentPourPrix(userId);
        userState.attenteMedicamentPrix = true;
      }
      break;
      
    case 'SUPPORT':
      await donnerSupport(userId);
      break;
      
    case 'CONSEIL_SANTE':
      await donnerConseilSanteContextuel(userId, messageOriginal, contexte);
      break;
      
    case 'SALUTATION':
      // Déjà géré par réponse immédiate
      break;
      
    default:
      // Action AUTRE
      await sendWhatsAppMessage(
        userId,
        "🤔 Je peux vous aider à :\n\n" +
        "💊 Acheter des médicaments\n" +
        "🏥 Trouver une pharmacie de garde\n" +
        "📅 Prendre rendez-vous\n" +
        "💰 Vérifier un prix\n\n" +
        "Dites-moi simplement ce dont vous avez besoin ! 😊"
      );
  }
  
  userStates.set(userId, userState);
}

// =================== FONCTIONS D'ACTION ===================
async function afficherPharmaciesDeGarde(userId) {
  try {
    await sendWhatsAppMessage(userId, "🔍 Recherche des pharmacies de garde...");
    
    const snapshot = await db.collection('pharmacies')
      .where('estDeGarde', '==', true)
      .where('estOuvert', '==', true)
      .limit(10)
      .get();
    
    if (snapshot.empty) {
      await sendWhatsAppMessage(
        userId,
        "🏥 **Aucune pharmacie de garde trouvée pour le moment.**\n\n" +
        "💡 **Suggestions :**\n" +
        "• Réessayez dans quelques minutes\n" +
        "• Contactez le support au " + CONFIG.SUPPORT_PHONE + "\n" +
        "• Vérifiez auprès des pharmacies locales\n\n" +
        "📍 **Rappel :** Service uniquement à San Pedro"
      );
      return;
    }
    
    let message = "🏥 **PHARMACIES DE GARDE - SAN PEDRO**\n\n";
    
    snapshot.docs.forEach((doc, index) => {
      const pharmacie = doc.data();
      message += `${index + 1}. **${pharmacie.nom || 'Pharmacie'}**\n`;
      message += `   📍 ${pharmacie.adresse || 'San Pedro'}\n`;
      message += `   ☎ ${pharmacie.telephone || 'Non disponible'}\n`;
      message += `   ⏰ ${pharmacie.horaires || '24h/24'}\n\n`;
    });
    
    message += "💊 **Pour commander des médicaments :**\n";
    message += "Écrivez simplement le nom du médicament !\n\n";
    message += "📞 **Support :** " + CONFIG.SUPPORT_PHONE;
    
    await sendWhatsAppMessage(userId, message);
    
  } catch (error) {
    console.error('❌ Erreur pharmacies:', error.message);
    await sendWhatsAppMessage(
      userId,
      "🏥 **Pharmacies de garde à San Pedro :**\n\n" +
      "1. **Pharmacie Cosmos**\n" +
      "   📍 Centre-ville, San Pedro\n" +
      "   ☎ 07 07 07 07 07\n" +
      "   ⏰ 24h/24\n\n" +
      "2. **Pharmacie du Port**\n" +
      "   📍 Zone portuaire, San Pedro\n" +
      "   ☎ 07 08 08 08 08\n" +
      "   ⏰ 24h/24\n\n" +
      "💊 Écrivez un nom de médicament pour commander !"
    );
  }
}

async function rechercherEtAfficherMedicament(userId, nomMedicament, modeMulti = false) {
  try {
    const termeRecherche = nomMedicament.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .trim();
    
    if (termeRecherche.length < 3) {
      await sendWhatsAppMessage(userId, "❌ Nom de médicament trop court.");
      return;
    }
    
    // Recherche
    const snapshot = await db.collection('medicaments')
      .where('stock', '>', 0)
      .limit(100)
      .get();
    
    const medicamentsFiltres = [];
    
    snapshot.docs.forEach(doc => {
      const medicament = { id: doc.id, ...doc.data() };
      const nomMed = (medicament.nom || '').toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      
      if (nomMed.includes(termeRecherche) && medicament.pharmacieId) {
        medicamentsFiltres.push(medicament);
      }
    });
    
    if (medicamentsFiltres.length === 0) {
      await sendWhatsAppMessage(
        userId,
        `❌ **"${nomMedicament}" non trouvé.**\n\n` +
        `🔄 **Essayez :**\n` +
        `• Un autre nom\n` +
        `• Une autre orthographe\n` +
        `• Un médicament similaire`
      );
      
      const buttons = [
        { id: "voir_pharmacies_garde", title: "🏥 Voir pharmacies" },
        { id: "rechercher_autre", title: "🔍 Autre recherche" }
      ];
      
      await sendInteractiveMessage(userId, "Que souhaitez-vous faire ?", buttons);
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
    
    // Grouper par pharmacie
    const medicamentsParPharmacie = {};
    const listeMedicamentsAvecIndex = [];
    
    medicamentsFiltres.forEach((medicament, index) => {
      const pharmacieId = medicament.pharmacieId;
      if (!pharmaciesMap.has(pharmacieId)) return;
      
      if (!medicamentsParPharmacie[pharmacieId]) {
        medicamentsParPharmacie[pharmacieId] = {
          pharmacie: pharmaciesMap.get(pharmacieId),
          medicaments: []
        };
      }
      
      const medicamentIndex = Object.keys(medicamentsParPharmacie).length > 0 
        ? Object.values(medicamentsParPharmacie).reduce((total, item) => total + item.medicaments.length, 0) + 1
        : index + 1;
      
      medicamentsParPharmacie[pharmacieId].medicaments.push(medicament);
      
      listeMedicamentsAvecIndex.push({
        index: medicamentIndex,
        medicamentId: medicament.id,
        pharmacieId: pharmacieId,
        pharmacieNom: pharmaciesMap.get(pharmacieId).nom,
        medicament: medicament
      });
    });
    
    // Construire message
    const userState = userStates.get(userId) || DEFAULT_STATE;
    userState.resultatsRechercheMedicaments = medicamentsParPharmacie;
    userState.listeMedicamentsAvecIndex = listeMedicamentsAvecIndex;
    
    let message = `💊 **${nomMedicament.toUpperCase()} - DISPONIBLE**\n\n`;
    
    for (const pharmacieId in medicamentsParPharmacie) {
      const { pharmacie, medicaments } = medicamentsParPharmacie[pharmacieId];
      
      message += `🏥 **${pharmacie.nom}**\n`;
      if (pharmacie.adresse) message += `📍 ${pharmacie.adresse}\n`;
      
      medicaments.forEach(medicament => {
        const medicamentIndex = listeMedicamentsAvecIndex.find(m => m.medicamentId === medicament.id)?.index;
        
        message += `${medicamentIndex}. **${medicament.nom}**\n`;
        message += `   💰 ${medicament.prix || '?'} FCFA\n`;
        message += `   📦 ${medicament.stock || 0} en stock\n`;
        message += `   ${medicament.necessiteOrdonnance ? '⚠️ Ordonnance requise' : '✅ Sans ordonnance'}\n`;
        
        if (medicament.dosage || medicament.forme) {
          message += `   💊 ${medicament.dosage || ''} ${medicament.forme || ''}\n`;
        }
        
        message += `\n`;
      });
      
      message += `\n`;
    }
    
    // Options
    message += `📝 **OPTIONS DE COMMANDE :**\n`;
    message += `• *COMMANDER [numéro] [quantité]* - Commander ce médicament\n`;
    
    if (modeMulti || userState.modeMultiMedicaments) {
      message += `• *AJOUTER [numéro] [quantité]* - Ajouter au panier\n`;
      message += `• *VOIR PANIER* - Afficher mon panier\n`;
      message += `• *TERMINER* - Finaliser avec plusieurs médicaments\n`;
    } else {
      message += `• *PLUSIEURS* - Ajouter plusieurs médicaments\n`;
    }
    
    message += `\n💰 **POUR LE PRIX :**\n`;
    message += `"prix [numéro]" pour plus de détails\n\n`;
    message += `🔍 **NOUVELLE RECHERCHE :**\n`;
    message += `Écrivez simplement un autre nom de médicament`;
    
    await sendWhatsAppMessage(userId, message);
    
    if (modeMulti) {
      userState.modeMultiMedicaments = true;
    }
    
    userState.attenteCommande = true;
    userState.step = 'ATTENTE_COMMANDE_MEDICAMENT';
    userStates.set(userId, userState);
    
  } catch (error) {
    console.error('❌ Erreur recherche médicament:', error.message);
    await sendWhatsAppMessage(userId, `❌ Erreur lors de la recherche.`);
  }
}

async function chercherCliniquesParSpecialite(userId, specialite) {
  try {
    const snapshot = await db.collection('centres_sante')
      .where('estVerifie', '==', true)
      .get();
    
    const cliniquesFiltrees = [];
    
    snapshot.docs.forEach(doc => {
      const centre = { id: doc.id, ...doc.data() };
      if (centre.specialites && Array.isArray(centre.specialites)) {
        const specialiteTrouvee = centre.specialites.some(s => 
          s.toLowerCase().includes(specialite.toLowerCase())
        );
        if (specialiteTrouvee) {
          cliniquesFiltrees.push(centre);
        }
      }
    });
    
    if (cliniquesFiltrees.length === 0) {
      await sendWhatsAppMessage(
        userId,
        `🏥 **Aucun ${specialite} trouvé.**\n\n` +
        `📞 **Support :** ${CONFIG.SUPPORT_PHONE}`
      );
      
      const buttons = [
        { id: "voir_toutes_cliniques", title: "🏥 Toutes les cliniques" },
        { id: "autre_specialite", title: "🩺 Autre spécialité" }
      ];
      
      await sendInteractiveMessage(userId, "Que souhaitez-vous faire ?", buttons);
      return;
    }
    
    const userState = userStates.get(userId) || DEFAULT_STATE;
    userState.listeCliniques = cliniquesFiltrees;
    
    let message = `🏥 **${specialite.toUpperCase()} - SAN PEDRO**\n\n`;
    
    cliniquesFiltrees.forEach((clinique, index) => {
      message += `${index + 1}. **${clinique.nom}**\n`;
      message += `   📍 ${clinique.adresse || 'San Pedro'}\n`;
      message += `   ☎ ${clinique.telephone || 'Non disponible'}\n`;
      
      if (clinique.horaires) {
        message += `   ⏰ ${typeof clinique.horaires === 'object' ? 
          (clinique.horaires.Lundi || clinique.horaires.lundi || 'Sur RDV') : 
          clinique.horaires}\n`;
      }
      
      if (clinique.specialites && clinique.specialites.length > 0) {
        message += `   🩺 ${clinique.specialites.slice(0, 3).join(', ')}\n`;
      }
      
      message += `\n`;
    });
    
    message += `📅 **POUR CHOISIR :**\n`;
    message += `Répondez avec le numéro de la clinique\n`;
    message += `Exemple : *1*\n\n`;
    message += `🔍 **VOIR TOUTES LES CLINIQUES :**\n`;
    message += `Tapez "cliniques disponibles"`;
    
    await sendWhatsAppMessage(userId, message);
    
    userState.attenteSelectionClinique = true;
    userState.step = 'ATTENTE_SELECTION_CLINIQUE';
    userStates.set(userId, userState);
    
  } catch (error) {
    console.error('❌ Erreur recherche cliniques:', error.message);
    await sendWhatsAppMessage(
      userId,
      `🏥 **Cliniques à San Pedro :**\n\n` +
      `1. **Clinique Pastora**\n` +
      `   📍 BP 225, San Pedro\n` +
      `   ☎ 07 07 07 07 07\n` +
      `   🩺 Dermatologie, Cardiologie\n\n` +
      `2. **Polyclinique du Port**\n` +
      `   📍 Zone portuaire\n` +
      `   ☎ 07 08 08 08 08\n` +
      `   🩺 Pédiatrie, Médecine générale`
    );
  }
}

async function afficherToutesCliniques(userId) {
  try {
    const snapshot = await db.collection('centres_sante')
      .where('estVerifie', '==', true)
      .limit(15)
      .get();
    
    if (snapshot.empty) {
      await sendWhatsAppMessage(userId, "🏥 **Aucune clinique disponible.**");
      return;
    }
    
    let message = "🏥 **CLINIQUES PARTENAIRES - SAN PEDRO**\n\n";
    
    snapshot.docs.forEach((doc, index) => {
      const centre = doc.data();
      message += `${index + 1}. **${centre.nom}**\n`;
      message += `   📍 ${centre.adresse || 'San Pedro'}\n`;
      message += `   ☎ ${centre.telephone || 'Non disponible'}\n`;
      
      if (centre.specialites && Array.isArray(centre.specialites) && centre.specialites.length > 0) {
        message += `   🩺 ${centre.specialites.slice(0, 3).join(', ')}`;
        if (centre.specialites.length > 3) message += `...`;
        message += `\n`;
      }
      
      message += `\n`;
    });
    
    message += "📅 **POUR PRENDRE RDV :**\n";
    message += '"rdv avec [spécialité]" ou répondez avec un numéro\n\n';
    message += "📍 **RAPPEL :** Service uniquement à San Pedro";
    
    await sendWhatsAppMessage(userId, message);
    
  } catch (error) {
    console.error('❌ Erreur toutes cliniques:', error.message);
    await sendWhatsAppMessage(
      userId,
      "🏥 **Cliniques disponibles à San Pedro :**\n\n" +
      "• **Clinique Pastora** - BP 225\n" +
      "• **Polyclinique du Port** - Zone portuaire\n" +
      "• **Centre Médical Urbain** - Centre-ville\n\n" +
      "📅 Pour prendre rendez-vous :\n" +
      '"rdv avec dermatologue" ou "rendez-vous cardiologue"'
    );
  }
}

async function afficherPrixDisponibilite(userId, nomMedicament) {
  await rechercherEtAfficherMedicament(userId, nomMedicament, false);
}

async function donnerSupport(userId) {
  const userState = userStates.get(userId) || DEFAULT_STATE;
  
  let message = "🆘 **SUPPORT PILLBOX - SAN PEDRO**\n\n";
  message += "Je vois que vous avez besoin d'aide. 🤗\n\n";
  
  message += "📞 **CONTACT DIRECT :**\n";
  message += CONFIG.SUPPORT_PHONE + "\n";
  message += "⏰ 7j/7 de 8h à 22h\n\n";
  
  message += "🔍 **PROBLÈMES FRÉQUENTS :**\n";
  message += "• Médicament non trouvé\n";
  message += "• Difficulté à commander\n";
  message += "• Question sur les prix\n";
  message += "• Problème de livraison\n";
  message += "• Ordonnance non acceptée\n\n";
  
  message += "💬 **DÉCRIVEZ VOTRE PROBLÈME** et je vous aiderai.\n\n";
  
  message += "📍 **RAPPEL :** Service uniquement à San Pedro\n\n";
  
  message += "💰 **FRAIS DE LIVRAISON :**\n";
  message += "• 400 FCFA (8h-23h)\n";
  message += "• 600 FCFA (00h-8h)";
  
  await sendWhatsAppMessage(userId, message);
  
  userState.step = 'MENU_PRINCIPAL';
  userState.attenteCommande = false;
  userState.attenteSelectionClinique = false;
  userStates.set(userId, userState);
}

async function donnerConseilSanteContextuel(userId, message, contexte) {
  try {
    const symptomes = contexte.medical?.symptomesActuels || [];
    const conditions = contexte.profil?.preferences?.conditionsChroniques || [];
    
    const promptConseil = `
    CONTEXTE MÉDICAL :
    ${symptomes.length > 0 ? `• Symptômes : ${symptomes.join(', ')}` : 'Aucun symptôme'}
    ${conditions.length > 0 ? `• Conditions : ${conditions.join(', ')}` : ''}
    
    DEMANDE : "${message}"
    
    ÉTAT ÉMOTIONNEL : ${contexte.emotionnel?.ton || 'neutre'}
    
    TU ES MIA, assistante médicale de Pillbox San Pedro.
    
    DONNE UN CONSEIL QUI :
    1. Tient compte du contexte
    2. S'adapte à l'état émotionnel
    3. Oriente vers un médecin
    4. Propose des solutions pratiques
    
    RÈGLES :
    - ⛔ JAMAIS DE DIAGNOSTIC
    - ⛔ JAMAIS DE PRESCRIPTION
    - ✅ TOUJOURS CONSEILLER UN MÉDECIN
    
    Réponse : 2-4 phrases, ton adapté.
    `;
    
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: CONFIG.GROQ_MODEL,
        messages: [
          { role: "system", content: "Tu donnes des conseils santé contextuels." },
          { role: "user", content: promptConseil }
        ],
        temperature: 0.6,
        max_tokens: 200
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );
    
    const conseil = response.data.choices[0].message.content.trim();
    
    await sendWhatsAppMessage(userId, conseil);
    
    let suivi = "⚠️ **RAPPEL :** Consultez un médecin pour un avis personnalisé.\n\n";
    
    if (symptomes.length > 0) {
      suivi += `🏥 **Pour vos symptômes,** je peux vous aider à :\n`;
      suivi += "• Trouver des médicaments 💊\n";
      suivi += "• Prendre rendez-vous 📅\n";
      suivi += 'Dites "médicament" ou "rdv"';
    }
    
    await sendWhatsAppMessage(userId, suivi);
    
  } catch (error) {
    console.error('❌ Erreur conseil:', error.message);
    await sendWhatsAppMessage(
      userId,
      "🌿 **Pour un conseil médical,** consultez un médecin.\n\n" +
      "🏥 Je peux vous aider à prendre rendez-vous !\n" +
      'Dites "rdv avec [spécialité]". 😊'
    );
  }
}

// =================== GESTION DES COMMANDES ===================
async function traiterCommandeMultiMedicaments(userId, message, userState) {
  const texte = message.toLowerCase().trim();
  
  // Commandes spéciales
  if (texte === 'panier' || texte === 'voir panier' || texte === 'mon panier') {
    await afficherPanier(userId);
    return;
  }
  
  if (texte === 'vider panier' || texte === 'vider') {
    await gererPanier(userId, 'VIDER');
    return;
  }
  
  if (texte === 'terminer' || texte === 'fini' || texte === 'finaliser') {
    if (!userState.panierTemporaire || userState.panierTemporaire.length === 0) {
      await sendWhatsAppMessage(userId, "🛒 Votre panier est vide.");
      return;
    }
    
    await gererPanier(userId, 'CONFIRMER');
    await afficherPanier(userId);
    
    await sendWhatsAppMessage(
      userId,
      "🎯 **PANIER CONFIRMÉ !**\n\n" +
      "📝 **POUR FINALISER, ENVOYEZ :**\n" +
      "1. Votre nom complet\n" +
      "2. Votre quartier à San Pedro\n" +
      "3. Votre numéro WhatsApp\n" +
      "4. Indications pour la livraison\n\n" +
      "💬 Exemple :\n" +
      "\"Nom: Fatou Traoré\n" +
      "Quartier: Résidence du Port\n" +
      "WhatsApp: 07 08 12 34 56\n" +
      "Indications: Immeuble bleu, 3ème étage\""
    );
    
    userState.step = 'ATTENTE_INFOS_LIVRAISON_MULTI';
    userStates.set(userId, userState);
    return;
  }
  
  if (texte === 'continuer' || texte === 'ajouter encore') {
    await sendWhatsAppMessage(
      userId,
      "🛒 **AJOUTER UN AUTRE MÉDICAMENT**\n\n" +
      "Écrivez le nom d'un médicament à ajouter."
    );
    
    userState.attenteMedicament = true;
    userStates.set(userId, userState);
    return;
  }
  
  if (texte === 'plusieurs') {
    userState.modeMultiMedicaments = true;
    userStates.set(userId, userState);
    
    await sendWhatsAppMessage(
      userId,
      "🛒 **MODE MULTI-MÉDICAMENTS ACTIVÉ**\n\n" +
      "📝 **UTILISEZ :**\n" +
      "• *AJOUTER [numéro] [quantité]* - Ajouter au panier\n" +
      "• *VOIR PANIER* - Afficher votre panier\n" +
      "• *TERMINER* - Finaliser la commande\n\n" +
      "🔍 **Pour chercher un médicament :**\n" +
      "Écrivez simplement son nom !"
    );
    return;
  }
  
  // Ajouter au panier
  const ajouterRegex = /ajouter\s+(\d+)(?:\s+(\d+))?/i;
  const matchAjouter = texte.match(ajouterRegex);
  
  if (matchAjouter) {
    const numero = parseInt(matchAjouter[1]);
    const quantite = matchAjouter[2] ? parseInt(matchAjouter[2]) : 1;
    
    if (quantite < 1 || quantite > 100) {
      await sendWhatsAppMessage(userId, "❌ Quantité invalide (1-100).");
      return;
    }
    
    const medicamentInfo = userState.listeMedicamentsAvecIndex.find(m => m.index === numero);
    
    if (!medicamentInfo) {
      await sendWhatsAppMessage(userId, "❌ Numéro invalide.");
      return;
    }
    
    // Vérifier stock
    if (medicamentInfo.medicament.stock < quantite) {
      await sendWhatsAppMessage(userId, `❌ Stock insuffisant (${medicamentInfo.medicament.stock} disponible).`);
      return;
    }
    
    await gererPanier(userId, 'AJOUTER', medicamentInfo, quantite);
    
    await sendWhatsAppMessage(
      userId,
      `✅ **AJOUTÉ AU PANIER :**\n\n` +
      `💊 ${medicamentInfo.medicament.nom} × ${quantite}\n` +
      `💰 ${medicamentInfo.medicament.prix || 0} FCFA × ${quantite} = ${(medicamentInfo.medicament.prix || 0) * quantite} FCFA\n\n` +
      `🛒 Panier : ${(userState.panierTemporaire || []).length} médicament(s)\n\n` +
      `📝 **Commandes :**\n` +
      `• *VOIR PANIER* - Afficher\n` +
      `• *TERMINER* - Finaliser\n` +
      `• *CONTINUER* - Ajouter`
    );
    
    return;
  }
  
  // Retirer du panier
  const retirerRegex = /retirer\s+(\d+)/i;
  const matchRetirer = texte.match(retirerRegex);
  
  if (matchRetirer) {
    const numeroPanier = parseInt(matchRetirer[1]) - 1;
    
    if (!userState.panierTemporaire || userState.panierTemporaire.length === 0) {
      await sendWhatsAppMessage(userId, "❌ Panier vide.");
      return;
    }
    
    if (numeroPanier < 0 || numeroPanier >= userState.panierTemporaire.length) {
      await sendWhatsAppMessage(userId, "❌ Numéro invalide.");
      return;
    }
    
    const medicamentRetire = userState.panierTemporaire[numeroPanier];
    userState.panierTemporaire.splice(numeroPanier, 1);
    userStates.set(userId, userState);
    
    await sendWhatsAppMessage(
      userId,
      `✅ **RETIRÉ DU PANIER :**\n\n` +
      `💊 ${medicamentRetire.medicamentNom}\n` +
      `📦 Quantité : ${medicamentRetire.quantite}\n\n` +
      `🛒 Panier : ${userState.panierTemporaire.length} médicament(s)`
    );
    
    return;
  }
  
  // Commander normalement
  const commandeRegex = /commander\s+(\d+)\s+(\d+)/i;
  const matchCommande = texte.match(commandeRegex);
  
  if (matchCommande) {
    await traiterCommandeMedicament(userId, message, userState);
    return;
  }
  
  // Aide
  await sendWhatsAppMessage(
    userId,
    "❓ **COMMANDES :**\n" +
    "• *AJOUTER [numéro] [quantité]* - Ajouter au panier\n" +
    "• *COMMANDER [numéro] [quantité]* - Commander un seul\n" +
    "• *VOIR PANIER* - Afficher votre panier\n" +
    "• *TERMINER* - Finaliser\n" +
    "• *PLUSIEURS* - Mode multi-médicaments\n" +
    "• *PRIX [numéro]* - Détails\n\n" +
    "🔍 **Chercher un médicament :**\n" +
    "Écrivez son nom !"
  );
}

async function traiterCommandeMedicament(userId, message, userState) {
  const commandeRegex = /commander\s+(\d+)\s+(\d+)/i;
  const match = message.match(commandeRegex);
  
  if (match) {
    const numero = parseInt(match[1]);
    const quantite = parseInt(match[2]);
    
    if (quantite < 1 || quantite > 100) {
      await sendWhatsAppMessage(userId, "❌ Quantité invalide (1-100).");
      return;
    }
    
    const medicamentInfo = userState.listeMedicamentsAvecIndex.find(m => m.index === numero);
    
    if (!medicamentInfo) {
      await sendWhatsAppMessage(userId, "❌ Numéro invalide.");
      return;
    }
    
    const medicament = medicamentInfo.medicament;
    const prixUnitaire = medicament.prix || 0;
    const prixTotal = prixUnitaire * quantite;
    const fraisLivraison = getFraisLivraison();
    const total = prixTotal + fraisLivraison;
    
    // Vérifier stock
    if (medicament.stock < quantite) {
      await sendWhatsAppMessage(userId, `❌ Stock insuffisant (${medicament.stock} disponible).`);
      return;
    }
    
    let messageConfirmation = `✅ **COMMANDE PRÉPARÉE**\n\n`;
    messageConfirmation += `💊 **${medicament.nom}**\n`;
    messageConfirmation += `🏥 Pharmacie : ${medicamentInfo.pharmacieNom}\n`;
    messageConfirmation += `📦 Quantité : ${quantite}\n`;
    messageConfirmation += `💰 Prix unitaire : ${prixUnitaire} FCFA\n`;
    messageConfirmation += `🧾 Sous-total : ${prixTotal} FCFA\n`;
    messageConfirmation += `🚚 Livraison : ${fraisLivraison} FCFA\n`;
    messageConfirmation += `🎯 **TOTAL À PAYER : ${total} FCFA**\n\n`;
    
    if (medicament.necessiteOrdonnance) {
      messageConfirmation += `⚠️ **Ordonnance requise**\n`;
    }
    
    messageConfirmation += `📝 **POUR FINALISER, ENVOYEZ :**\n`;
    messageConfirmation += `1. Votre nom complet\n`;
    messageConfirmation += `2. Votre quartier à San Pedro\n`;
    messageConfirmation += `3. Votre numéro WhatsApp\n`;
    messageConfirmation += `4. Indications pour la livraison\n\n`;
    messageConfirmation += `📍 **Service uniquement à San Pedro**`;
    
    await sendWhatsAppMessage(userId, messageConfirmation);
    
    // Sauvegarder commande
    userState.commandeEnCours = {
      medicamentId: medicament.id,
      medicamentNom: medicament.nom,
      pharmacieId: medicamentInfo.pharmacieId,
      pharmacieNom: medicamentInfo.pharmacieNom,
      quantite: quantite,
      prixUnitaire: prixUnitaire,
      prixTotal: prixTotal,
      fraisLivraison: fraisLivraison,
      total: total,
      necessiteOrdonnance: medicament.necessiteOrdonnance
    };
    
    userState.attenteCommande = false;
    userState.step = 'ATTENTE_INFOS_LIVRAISON';
    userStates.set(userId, userState);
    
  } else if (message.match(/^prix\s+(\d+)$/i)) {
    const matchPrix = message.match(/^prix\s+(\d+)$/i);
    const numero = parseInt(matchPrix[1]);
    
    const medicamentInfo = userState.listeMedicamentsAvecIndex.find(m => m.index === numero);
    
    if (medicamentInfo) {
      const medicament = medicamentInfo.medicament;
      await sendWhatsAppMessage(
        userId,
        `💰 **${medicament.nom}**\n\n` +
        `🏥 ${medicamentInfo.pharmacieNom}\n` +
        `💊 ${medicament.dosage || ''} ${medicament.forme || ''}\n` +
        `📦 Stock : ${medicament.stock || 0}\n` +
        `${medicament.necessiteOrdonnance ? '⚠️ Ordonnance requise\n' : '✅ Sans ordonnance\n'}` +
        `\n🛒 **Commander :**\n` +
        `"commander ${numero} [quantité]"`
      );
    }
  }
}

// =================== TRAITEMENT INFORMATIONS ===================
async function traiterInfosLivraison(userId, message, userState) {
  const lines = message.split('\n');
  const infos = {};
  
  lines.forEach(line => {
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (match) {
      const cle = match[1].trim().toLowerCase().replace(/[^a-z]/g, '');
      const valeur = match[2].trim();
      infos[cle] = valeur;
    }
  });
  
  // Vérifier champs
  const champsRequis = ['nom', 'quartier', 'whatsapp'];
  const champsManquants = champsRequis.filter(champ => !infos[champ]);
  
  if (champsManquants.length > 0) {
    await sendWhatsAppMessage(userId, `❌ Informations manquantes : ${champsManquants.join(', ')}`);
    return;
  }
  
  // Vérifier San Pedro
  if (!infos.quartier.toLowerCase().includes('san pedro') && 
      !infos.quartier.toLowerCase().includes('san-pedro')) {
    await sendWhatsAppMessage(userId, "❌ Service uniquement à San Pedro.");
    return;
  }
  
  const commande = userState.commandeEnCours;
  const numeroCommande = `CMD${Date.now().toString().slice(-8)}`;
  
  await sendWhatsAppMessage(
    userId,
    `🎉 **COMMANDE CONFIRMÉE #${numeroCommande}**\n\n` +
    `👤 **Client :** ${infos.nom}\n` +
    `📱 WhatsApp : ${infos.whatsapp}\n` +
    `📍 Quartier : ${infos.quartier}\n` +
    (infos.indications ? `🗺️ Indications : ${infos.indications}\n\n` : `\n`) +
    `💊 **Commande :**\n` +
    `${commande.medicamentNom} × ${commande.quantite}\n` +
    `🏥 Pharmacie : ${commande.pharmacieNom}\n` +
    `💰 Total médicaments : ${commande.prixTotal} FCFA\n` +
    `🚚 Frais livraison : ${commande.fraisLivraison} FCFA\n` +
    `🎯 **TOTAL À PAYER : ${commande.total} FCFA**\n\n` +
    `⏳ **PROCHAINES ÉTAPES :**\n` +
    `1. Validation par la pharmacie\n` +
    `2. Attribution d'un livreur\n` +
    `3. Notification de suivi\n` +
    (commande.necessiteOrdonnance ? `4. Envoi de l'ordonnance requise\n` : ``) +
    `\n📞 **SUPPORT :**\n` +
    CONFIG.SUPPORT_PHONE + `\n` +
    `(Référence : ${numeroCommande})`
  );
  
  if (commande.necessiteOrdonnance) {
    await sendWhatsAppMessage(
      userId,
      `⚠️ **ORDONNANCE REQUISE**\n\n` +
      `Veuillez envoyer une photo de votre ordonnance.\n\n` +
      `📸 **Comment envoyer :**\n` +
      `1. Cliquez sur 📎 (attache)\n` +
      `2. Sélectionnez "Galerie" ou "Appareil photo"\n` +
      `3. Choisissez la photo\n\n` +
      `⏱️ **Votre commande sera traitée après validation.**`
    );
    
    userState.attentePhotoOrdonnance = true;
  }
  
  // Réinitialiser
  userState.commandeEnCours = null;
  userState.resultatsRechercheMedicaments = null;
  userState.listeMedicamentsAvecIndex = [];
  userState.step = 'MENU_PRINCIPAL';
  userStates.set(userId, userState);
}

async function traiterInfosLivraisonMulti(userId, message, userState) {
  const panier = userState.panier || [];
  if (panier.length === 0) {
    await sendWhatsAppMessage(userId, "❌ Panier vide.");
    userState.step = 'MENU_PRINCIPAL';
    userStates.set(userId, userState);
    return;
  }
  
  // Extraire informations
  const lines = message.split('\n');
  const infos = {};
  
  lines.forEach(line => {
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (match) {
      const cle = match[1].trim().toLowerCase().replace(/[^a-z]/g, '');
      const valeur = match[2].trim();
      infos[cle] = valeur;
    }
  });
  
  // Vérifications
  const champsRequis = ['nom', 'quartier', 'whatsapp'];
  const champsManquants = champsRequis.filter(champ => !infos[champ]);
  
  if (champsManquants.length > 0) {
    await sendWhatsAppMessage(userId, `❌ Informations manquantes : ${champsManquants.join(', ')}`);
    return;
  }
  
  if (!infos.quartier.toLowerCase().includes('san pedro') && 
      !infos.quartier.toLowerCase().includes('san-pedro')) {
    await sendWhatsAppMessage(userId, "❌ Service uniquement à San Pedro.");
    return;
  }
  
  // Calculer total
  const { sousTotal, fraisLivraison, total } = calculerTotalPanier(panier);
  const numeroCommande = `CMD${Date.now().toString().slice(-8)}`;
  
  // Message confirmation
  let messageConfirmation = `🎉 **COMMANDE CONFIRMÉE #${numeroCommande}**\n\n`;
  messageConfirmation += `👤 **Client :** ${infos.nom}\n`;
  messageConfirmation += `📱 WhatsApp : ${infos.whatsapp}\n`;
  messageConfirmation += `📍 Quartier : ${infos.quartier}\n`;
  if (infos.indications) messageConfirmation += `🗺️ Indications : ${infos.indications}\n`;
  messageConfirmation += `\n`;
  
  messageConfirmation += `🛒 **VOTRE COMMANDE :**\n`;
  panier.forEach((item, index) => {
    messageConfirmation += `${index + 1}. **${item.medicamentNom}** × ${item.quantite}\n`;
    messageConfirmation += `   💰 ${item.prixUnitaire} FCFA × ${item.quantite} = ${item.prixUnitaire * item.quantite} FCFA\n`;
    if (item.necessiteOrdonnance) messageConfirmation += `   ⚠️ Ordonnance requise\n`;
    messageConfirmation += `\n`;
  });
  
  messageConfirmation += `📊 **RÉCAPITULATIF :**\n`;
  messageConfirmation += `🧾 Sous-total : ${sousTotal} FCFA\n`;
  messageConfirmation += `🚚 Frais livraison : ${fraisLivraison} FCFA\n`;
  messageConfirmation += `🎯 **TOTAL À PAYER : ${total} FCFA**\n\n`;
  
  messageConfirmation += `⏳ **PROCHAINES ÉTAPES :**\n`;
  messageConfirmation += `1. Validation par les pharmacies\n`;
  messageConfirmation += `2. Attribution d'un livreur\n`;
  messageConfirmation += `3. Notification de suivi\n`;
  
  // Vérifier ordonnances
  const ordonnanceRequise = panier.some(item => item.necessiteOrdonnance);
  if (ordonnanceRequise) {
    messageConfirmation += `4. **ENVOYER LES ORDONNANCES**\n`;
  }
  
  messageConfirmation += `\n📞 **SUPPORT :**\n`;
  messageConfirmation += CONFIG.SUPPORT_PHONE + `\n`;
  messageConfirmation += `(Référence : ${numeroCommande})`;
  
  await sendWhatsAppMessage(userId, messageConfirmation);
  
  // Demander ordonnances si nécessaire
  if (ordonnanceRequise) {
    await sendWhatsAppMessage(
      userId,
      `⚠️ **ORDONNANCE(S) REQUISE(S)**\n\n` +
      `Un ou plusieurs médicaments nécessitent une ordonnance.\n\n` +
      `📸 **Veuillez envoyer une photo claire de votre/vos ordonnance(s).**`
    );
    
    userState.attentePhotoOrdonnance = true;
  }
  
  // Réinitialiser
  userState.panier = [];
  userState.panierTemporaire = [];
  userState.modeMultiMedicaments = false;
  userState.commandeEnCours = null;
  userState.resultatsRechercheMedicaments = null;
  userState.listeMedicamentsAvecIndex = [];
  userState.step = 'MENU_PRINCIPAL';
  userStates.set(userId, userState);
}

// =================== FONCTIONS UTILITAIRES ===================
async function demanderNomMedicament(userId) {
  await sendWhatsAppMessage(
    userId,
    "💊 **Quel médicament recherchez-vous ?**\n\n" +
    "📝 **Écrivez simplement le nom :**\n\n" +
    "💡 **Exemples :**\n" +
    "• Paracétamol\n" +
    "• Ibuprofène\n" +
    "• Amoxicilline\n" +
    "• Vitamine C\n\n" +
    "Je vais le chercher dans nos pharmacies. 🔍"
  );
}

async function demanderSpecialite(userId) {
  await sendWhatsAppMessage(
    userId,
    "📅 **Avec quel type de médecin souhaitez-vous consulter ?**\n\n" +
    "👨‍⚕️ **Spécialités :**\n\n" +
    "• Médecin généraliste\n" +
    "• Dermatologue (peau)\n" +
    "• Gynécologue (femmes)\n" +
    "• Pédiatre (enfants)\n" +
    "• Cardiologue (cœur)\n" +
    "• Dentiste\n\n" +
    "📝 **Écrivez la spécialité souhaitée**"
  );
}

async function demanderMedicamentPourPrix(userId) {
  await sendWhatsAppMessage(
    userId,
    "💰 **Pour quel médicament voulez-vous connaître le prix ?**\n\n" +
    "📝 **Écrivez le nom du médicament :**\n\n" +
    "💡 **Exemples :**\n" +
    '• "Prix du paracétamol"\n' +
    '• "Combien coûte l\'ibuprofène ?"\n' +
    '• "Amoxicilline prix"'
  );
}

async function envoyerMessageBienvenue(userId) {
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };
  
  if (!userState.initialized) {
    await sendWhatsAppMessage(
      userId,
      "👋 **BIENVENUE CHEZ PILLBOX SAN PEDRO !** 🤗\n\n" +
      "Je suis Mia, votre assistante médicale intelligente.\n\n" +
      "🏙️ **NOTRE SERVICE :**\n" +
      "📍 Exclusivement pour San Pedro\n" +
      "🚚 Livraison à domicile disponible\n" +
      "💰 400 FCFA (8h-23h) / 600 FCFA (00h-8h)\n\n" +
      "💊 **JE PEUX VOUS AIDER À :**\n" +
      "• Acheter des médicaments\n" +
      "• Trouver des pharmacies de garde\n" +
      "• Prendre des rendez-vous\n" +
      "• Vérifier les prix\n" +
      "• Donner des conseils santé\n\n" +
      "💬 **PARLEZ-MOI NATURELLEMENT !**\n" +
      "Exemples :\n" +
      '• "Je veux du paracétamol"\n' +
      '• "Pharmacie ouverte maintenant ?"\n' +
      '• "Rendez-vous avec dermatologue"\n' +
      '• "Prix ibuprofène"\n\n' +
      "📞 **SUPPORT :** " + CONFIG.SUPPORT_PHONE + "\n\n" +
      "Comment puis-je vous aider ? 😊"
    );
    
    userState.initialized = true;
    userState.nom = "Client";
    userStates.set(userId, userState);
  }
}

async function fallbackIntelligentAvecContexte(userId, message) {
  const texte = message.toLowerCase();
  const userState = userStates.get(userId);
  const contexte = userState?.contexte || {};
  
  // Vérifier références
  const referenceInterpretee = gestionnaireContexte.interpreterReference(userId, message);
  if (referenceInterpretee) {
    await sendWhatsAppMessage(userId, `🤔 Vous parlez de "${referenceInterpretee}" ?`);
    return;
  }
  
  // Vérifier si réponse à question
  const historique = contexte.historiqueConversation || [];
  if (historique.length > 0) {
    const dernierMessage = historique[historique.length - 2];
    if (dernierMessage?.role === 'assistant') {
      if (dernierMessage.message.includes("quel médicament")) {
        if (texte.includes('paracétamol') || texte.includes('doliprane')) {
          await rechercherEtAfficherMedicament(userId, 'paracétamol', false);
          return;
        }
      }
    }
  }
  
  // Fallback général
  let ton = "🤔 ";
  if (contexte.emotionnel?.ton === 'pressé') ton = "🚀 ";
  if (contexte.emotionnel?.ton === 'stressé') ton = "🆘 ";
  
  await sendWhatsAppMessage(
    userId,
    ton + "Je peux vous aider à :\n\n" +
    "💊 **Acheter des médicaments** (dites le nom)\n" +
    "🏥 **Trouver une pharmacie de garde**\n" +
    "📅 **Prendre un rendez-vous médical**\n" +
    "💰 **Vérifier un prix**\n\n" +
    "Ou dites-moi simplement ce qui ne va pas. 😊"
  );
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
  
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];
    
    if (!message) {
      console.log('📩 Message vide ou non texte');
      return;
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
        // Gestion multi-médicaments
        if (userState.modeMultiMedicaments || 
            userState.step === 'ATTENTE_COMMANDE_MEDICAMENT' ||
            text.toLowerCase().includes('ajouter') ||
            text.toLowerCase().includes('panier') ||
            text.toLowerCase().includes('terminer')) {
          
          await traiterCommandeMultiMedicaments(userId, text, userState);
          return;
        }
        
        // États spéciaux
        if (userState.step === 'ATTENTE_INFOS_LIVRAISON') {
          await traiterInfosLivraison(userId, text, userState);
          return;
        }
        
        if (userState.step === 'ATTENTE_INFOS_LIVRAISON_MULTI') {
          await traiterInfosLivraisonMulti(userId, text, userState);
          return;
        }
        
        if (userState.attenteMedicament) {
          await rechercherEtAfficherMedicament(userId, text, userState.modeMultiMedicaments);
          userState.attenteMedicament = false;
          userStates.set(userId, userState);
          return;
        }
        
        if (userState.attenteSpecialite) {
          await chercherCliniquesParSpecialite(userId, text);
          userState.attenteSpecialite = false;
          userStates.set(userId, userState);
          return;
        }
        
        if (userState.attenteMedicamentPrix) {
          await afficherPrixDisponibilite(userId, text);
          userState.attenteMedicamentPrix = false;
          userStates.set(userId, userState);
          return;
        }
        
        if (userState.attenteSelectionClinique && text.match(/^\d+$/)) {
          const numero = parseInt(text);
          const cliniques = userState.listeCliniques || [];
          
          if (numero >= 1 && numero <= cliniques.length) {
            const clinique = cliniques[numero - 1];
            await sendWhatsAppMessage(
              userId,
              `🏥 **${clinique.nom}**\n\n` +
              `📍 ${clinique.adresse || 'San Pedro'}\n` +
              `☎ ${clinique.telephone || 'Non disponible'}\n\n` +
              `📅 **Pour prendre rendez-vous :**\n` +
              `Contactez directement la clinique.\n` +
              `📞 **Notre support peut vous aider :**\n` +
              CONFIG.SUPPORT_PHONE
            );
            
            userState.attenteSelectionClinique = false;
            userState.listeCliniques = [];
            userStates.set(userId, userState);
            return;
          }
        }
        
        // Messages interactifs
        if (messageType === 'interactive' && message.interactive?.type === 'button_reply') {
          const buttonId = message.interactive.button_reply.id;
          
          switch (buttonId) {
            case 'voir_pharmacies_garde':
              await afficherPharmaciesDeGarde(userId);
              break;
            case 'rechercher_autre':
              await demanderNomMedicament(userId);
              userState.attenteMedicament = true;
              break;
            case 'contacter_support':
              await donnerSupport(userId);
              break;
            case 'voir_toutes_cliniques':
              await afficherToutesCliniques(userId);
              break;
            case 'autre_specialite':
              await demanderSpecialite(userId);
              userState.attenteSpecialite = true;
              break;
          }
          
          userStates.set(userId, userState);
          return;
        }
        
        // Traitement normal avec Groq
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
      // Gestion des images (ordonnances)
      if (userState.attentePhotoOrdonnance) {
        await sendWhatsAppMessage(
          userId,
          "✅ **Ordonnance reçue !**\n\n" +
          "Votre ordonnance a été envoyée pour validation.\n" +
          "Nous vous recontacterons dès que possible.\n\n" +
          "📞 Pour suivre : " + CONFIG.SUPPORT_PHONE
        );
        
        userState.attentePhotoOrdonnance = false;
        userStates.set(userId, userState);
      }
    }
    
  } catch (error) {
    console.error('💥 ERREUR WEBHOOK:', error.message);
  }
});

// =================== ENDPOINTS ADMIN ===================
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'Pillbox WhatsApp Bot PRODUCTION',
    version: '3.0.0',
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
🚀 PILLBOX WHATSAPP BOT - PRODUCTION V3.0
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
✅ Compréhension des références
=======================================================
Exemples de messages utilisateur :
• "Je veux du paracétamol"
• "Pharmacie de garde aujourd'hui ?"
• "Rendez-vous avec dermatologue"
• "Quelles cliniques sont disponibles ?"
• "Prix ibuprofène"
• "J'ai un problème pour commander"
• "Je veux plusieurs médicaments"
• "Celui que tu as dit tout à l'heure"
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