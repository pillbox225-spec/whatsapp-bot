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
        await sendWhatsAppMessage(userId, "🛒 Votre panier est vide. Dites-moi un médicament !");
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
    
    await sendWhatsAppMessage(
      userId,
      "🛒 **MODE MULTI-MÉDICAMENTS ACTIVÉ**\n\n" +
      "Parfait ! Vous pouvez ajouter plusieurs médicaments.\n\n" +
      "📝 **Dites-moi le premier médicament :**\n\n" +
      "💡 **Exemples :**\n" +
      '• "paracétamol"\n' +
      '• "ibuprofène"\n' +
      '• "vitamine c"\n' +
      '• "sirop contre la toux"\n\n' +
      "🔍 **Nom du premier médicament :**"
    );
    
    userState.attenteMedicament = true;
    userStates.set(userId, userState);
  }
  
  async demanderPremierMedicament(userId, userState) {
    await sendWhatsAppMessage(
      userId,
      "💊 **COMMANDE DE MÉDICAMENT(S)**\n\n" +
      "Dites-moi le nom du médicament que vous souhaitez.\n\n" +
      "💡 **Vous pourrez :**\n" +
      "• Ajouter plusieurs médicaments (dites \"continuer\")\n" +
      "• Finaliser quand vous avez fini (dites \"terminer\")\n\n" +
      "🔍 **Nom du médicament :**"
    );
    
    userState.attenteMedicament = true;
    userStates.set(userId, userState);
  }
  
  async demanderAutreMedicament(userId, userState) {
    await sendWhatsAppMessage(
      userId,
      "🛒 **AJOUTER UN AUTRE MÉDICAMENT**\n\n" +
      "Parfait ! Dites-moi le **nom du prochain médicament**.\n\n" +
      "💡 **Exemples :**\n" +
      '• "ibuprofène"\n' +
      '• "vitamine c"\n' +
      '• "sirop"\n\n' +
      "📝 **Nom du médicament :**"
    );
    
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
        forme: medicamentInfo.medicament.forme
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
      `✅ **AJOUTÉ AU PANIER**\n\n` +
      `🛒 **VOTRE PANIER (${panier.length} médicament(s)) :**\n\n` +
      this.formaterPanier(panier) + `\n` +
      `📝 **QUE SOUHAITEZ-VOUS FAIRE ?**\n\n` +
      `➡️ **CONTINUER** - Ajouter un autre médicament\n` +
      `✅ **TERMINER** - Finaliser ma commande\n` +
      `👁️ **VOIR PANIER** - Afficher mon panier\n` +
      `🗑️ **VIDER** - Vider et recommencer\n\n` +
      `💬 **Répondez simplement :**\n` +
      `"continuer" ou "terminer"`
    );
  }
  
  async afficherPanier(userId, userState) {
    const panier = userState.panier || [];
    
    if (panier.length === 0) {
      await sendWhatsAppMessage(userId, "🛒 Votre panier est vide.");
      return;
    }
    
    const { sousTotal, fraisLivraison, total } = this.calculerTotal(panier);
    
    await sendWhatsAppMessage(
      userId,
      `🛒 **VOTRE PANIER (${panier.length} médicament(s))**\n\n` +
      this.formaterPanier(panier) + `\n` +
      `📊 **RÉCAPITULATIF :**\n` +
      `🧾 Sous-total : ${sousTotal} FCFA\n` +
      `🚚 Livraison : ${fraisLivraison} FCFA\n` +
      `🎯 **TOTAL : ${total} FCFA**\n\n` +
      `📝 **COMMANDES :**\n` +
      `• "continuer" - Ajouter un médicament\n` +
      `• "terminer" - Finaliser\n` +
      `• "vider" - Vider le panier`
    );
  }
  
  async viderPanier(userId, userState) {
    userState.panier = [];
    userStates.set(userId, userState);
    
    await sendWhatsAppMessage(
      userId,
      "🗑️ **PANIER VIDÉ**\n\n" +
      "Votre panier a été vidé.\n\n" +
      "💊 **Dites-moi un médicament pour commencer :**"
    );
    
    userState.attenteMedicament = true;
    userStates.set(userId, userState);
  }
  
  async finaliserPanier(userId, userState) {
    const panier = userState.panier || [];
    
    if (panier.length === 0) {
      await sendWhatsAppMessage(userId, "🛒 Votre panier est vide.");
      return;
    }
    
    const { sousTotal, fraisLivraison, total } = this.calculerTotal(panier);
    
    // Vérifier si ordonnance requise
    const ordonnanceRequise = panier.some(item => item.necessiteOrdonnance);
    
    await sendWhatsAppMessage(
      userId,
      `✅ **PANIER FINALISÉ**\n\n` +
      `🛒 **VOTRE COMMANDE (${panier.length} médicament(s)) :**\n\n` +
      this.formaterPanier(panier) + `\n` +
      `📊 **TOTAL : ${total} FCFA**\n\n` +
      (ordonnanceRequise ? 
        `⚠️ **ORDONNANCE REQUISE**\n` +
        `📸 **ENVOYEZ LA PHOTO DE VOTRE ORDONNANCE**\n\n` +
        `📱 **Comment envoyer :**\n` +
        `1. Cliquez sur 📎\n` +
        `2. Choisissez "📷 Appareil photo" ou "🖼️ Galerie"\n` +
        `3. Prenez/choisissez la photo\n\n` +
        `⏳ **Après l'envoi, donnez vos informations.**` :
        `📝 **POUR FINALISER :**\n` +
        `Envoyez :\n` +
        `"Nom: [Votre nom]\n` +
        `Quartier: [Votre quartier]\n` +
        `WhatsApp: [Votre numéro]\n` +
        `Indications: [Repère pour livraison]"\n\n` +
        `💬 **Exemple :**\n` +
        `"Nom: Fatou Traoré\n` +
        `Quartier: Résidence du Port\n` +
        `WhatsApp: 0701406880\n` +
        `Indications: Immeuble bleu, 3ème étage"`)
    );
    
    // Sauvegarder la commande
    userState.commandeEnCours = {
      panier: panier,
      sousTotal: sousTotal,
      fraisLivraison: fraisLivraison,
      total: total,
      ordonnanceRequise: ordonnanceRequise
    };
    
    userState.step = ordonnanceRequise ? 'ATTENTE_ORDONNANCE_MULTI' : 'ATTENTE_INFOS_LIVRAISON_MULTI';
    userStates.set(userId, userState);
  }
  
  formaterPanier(panier) {
    let message = '';
    panier.forEach((item, index) => {
      message += `${index + 1}. **${item.medicamentNom}** × ${item.quantite}\n`;
      message += `   💰 ${item.prixUnitaire} FCFA × ${item.quantite} = ${item.prixUnitaire * item.quantite} FCFA\n`;
      if (item.necessiteOrdonnance) message += `   ⚠️ Ordonnance requise\n`;
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

// =================== GESTION DES MÉDICAMENTS ===================
async function rechercherEtAfficherMedicament(userId, nomMedicament) {
  try {
    await sendWhatsAppMessage(userId, `🔍 Recherche "${nomMedicament}"...`);
    
    const termeRecherche = nomMedicament.toLowerCase().trim();
    
    if (termeRecherche.length < 3) {
      await sendWhatsAppMessage(userId, "❌ Nom trop court (min 3 lettres).");
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
        `❌ **"${nomMedicament}" NON DISPONIBLE**\n\n` +
        `📞 **Contactez le support :**\n` +
        `${CONFIG.SUPPORT_PHONE}\n\n` +
        `💡 **Alternatives :**\n` +
        `• Vérifier l'orthographe\n` +
        `• Essayer un nom générique\n` +
        `• Consulter une pharmacie directement\n` +
        `• Envoyer une photo du médicament 📸`
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
    
    let message = `💊 **${nomMedicament.toUpperCase()}**\n\n`;
    
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
      
      message += `${numero}. **${medicament.nom}**\n`;
      message += `💰 ${medicament.prix || '?'} FCFA\n`;
      message += `🏥 ${pharmacie.nom}\n`;
      message += `📦 ${medicament.stock || 0} disponible(s)\n`;
      
      if (medicament.dosage || medicament.forme) {
        message += `💊 ${medicament.dosage || ''} ${medicament.forme || ''}\n`;
      }
      
      message += `${medicament.necessiteOrdonnance ? '⚠️ Ordonnance requise' : '✅ Sans ordonnance'}\n\n`;
    });
    
    message += `📝 **POUR AJOUTER AU PANIER :**\n`;
    message += `"ajouter [numéro] [quantité]"\n\n`;
    message += `💬 **Exemples :**\n`;
    message += `• "ajouter 1 1" → Ajouter 1 du médicament n°1\n`;
    message += `• "ajouter 2 3" → Ajouter 3 du médicament n°2\n\n`;
    
    const userStateCurrent = userStates.get(userId) || DEFAULT_STATE;
    if (userStateCurrent.panier && userStateCurrent.panier.length > 0) {
      message += `🛒 **Votre panier contient ${userStateCurrent.panier.length} médicament(s).**\n`;
      message += `• "continuer" pour ajouter un autre\n`;
      message += `• "terminer" pour finaliser\n`;
      message += `• "panier" pour voir votre panier\n`;
    } else {
      message += `🛒 **Après ajout, dites "continuer" ou "terminer".**\n`;
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
  
  // Commander avec numéro
  const commandeRegex = /commander\s+(\d+)(?:\s+(\d+))?/i;
  const match = texte.match(commandeRegex);
  
  // Ajouter au panier
  const ajouterRegex = /ajouter\s+(\d+)(?:\s+(\d+))?/i;
  const matchAjouter = texte.match(ajouterRegex);
  
  if (match) {
    // Commande unique (ancien système)
    await traiterCommandeUnique(userId, match, userState);
    
  } else if (matchAjouter) {
    // Ajouter au panier
    const numero = parseInt(matchAjouter[1]);
    const quantite = matchAjouter[2] ? parseInt(matchAjouter[2]) : 1;
    
    if (quantite < 1 || quantite > 10) {
      await sendWhatsAppMessage(userId, "❌ Quantité invalide (1-10).");
      return;
    }
    
    const medicamentInfo = userState.listeMedicamentsAvecIndex.find(m => m.index === numero);
    
    if (!medicamentInfo) {
      await sendWhatsAppMessage(userId, "❌ Numéro invalide. Choisissez un numéro de la liste.");
      return;
    }
    
    // Vérifier stock
    if (medicamentInfo.medicament.stock < quantite) {
      await sendWhatsAppMessage(
        userId,
        `❌ **STOCK INSUFFISANT**\n\n` +
        `Il ne reste que **${medicamentInfo.medicament.stock}** disponible(s).\n\n` +
        `📞 **Contactez le support :**\n` +
        `${CONFIG.SUPPORT_PHONE}`
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
        `💰 **${medicament.nom}**\n\n` +
        `🏥 ${medicamentInfo.pharmacieNom}\n` +
        `💊 ${medicament.dosage || ''} ${medicament.forme || ''}\n` +
        `📦 Stock : ${medicament.stock || 0}\n` +
        `${medicament.necessiteOrdonnance ? '⚠️ Ordonnance requise\n' : '✅ Sans ordonnance\n'}` +
        `\n🛒 **Ajouter au panier :**\n` +
        `"ajouter ${numero} [quantité]"`
      );
    }
  } else {
    // Vérifier si c'est une commande de gestion de panier
    const resultatPanier = await gestionPanier.gererMessage(userId, texte, userState);
    if (resultatPanier === null) {
      // Aide
      await sendWhatsAppMessage(
        userId,
        "💊 **COMMENT COMMANDER :**\n\n" +
        "1️⃣ **Trouver un médicament :**\n" +
        '   → Écrivez "paracétamol"\n\n' +
        "2️⃣ **Ajouter au panier :**\n" +
        '   → Dites "ajouter 1 2"\n' +
        '   → (pour 2 du médicament n°1)\n\n' +
        "3️⃣ **Continuer ou terminer :**\n" +
        '   → "continuer" pour ajouter un autre\n' +
        '   → "terminer" pour finaliser\n' +
        '   → "panier" pour voir votre panier\n\n' +
        "💡 **Exemple complet :**\n" +
        '"paracétamol" → "ajouter 1 1" → "continuer" → "ibuprofène" → "ajouter 1 2" → "terminer"'
      );
    }
  }
}

async function traiterCommandeUnique(userId, match, userState) {
  const numero = parseInt(match[1]);
  const quantite = match[2] ? parseInt(match[2]) : 1;
  
  // Validation
  if (quantite < 1 || quantite > 10) {
    await sendWhatsAppMessage(userId, "❌ Quantité invalide (1-10).");
    return;
  }
  
  const medicamentInfo = userState.listeMedicamentsAvecIndex.find(m => m.index === numero);
  
  if (!medicamentInfo) {
    await sendWhatsAppMessage(userId, "❌ Numéro invalide. Choisissez un numéro de la liste.");
    return;
  }
  
  const medicament = medicamentInfo.medicament;
  
  // Vérifier stock
  if (medicament.stock < quantite) {
    await sendWhatsAppMessage(
      userId,
      `❌ **STOCK INSUFFISANT**\n\n` +
      `Il ne reste que **${medicament.stock}** disponible(s).\n\n` +
      `📞 **Contactez le support :**\n` +
      `${CONFIG.SUPPORT_PHONE}\n\n` +
      `💡 **Alternatives :**\n` +
      `• Réduire la quantité\n` +
      `• Choisir un autre médicament\n` +
      `• Contacter directement une pharmacie`
    );
    return;
  }
  
  // Calculer prix
  const prixUnitaire = medicament.prix || 0;
  const prixTotal = prixUnitaire * quantite;
  const fraisLivraison = getFraisLivraison();
  const total = prixTotal + fraisLivraison;
  
  // Message de confirmation
  let messageConfirmation = `✅ **COMMANDE PRÉPARÉE**\n\n`;
  messageConfirmation += `💊 **${medicament.nom}**\n`;
  messageConfirmation += `📦 Quantité : ${quantite}\n`;
  messageConfirmation += `💰 Prix unitaire : ${prixUnitaire} FCFA\n`;
  messageConfirmation += `🧾 Sous-total : ${prixTotal} FCFA\n`;
  messageConfirmation += `🚚 Livraison : ${fraisLivraison} FCFA\n`;
  messageConfirmation += `🎯 **TOTAL : ${total} FCFA**\n\n`;
  
  if (medicament.necessiteOrdonnance) {
    messageConfirmation += `⚠️ **ORDONNANCE REQUISE**\n`;
    messageConfirmation += `📸 **ENVOYEZ LA PHOTO DE VOTRE ORDONNANCE**\n\n`;
    messageConfirmation += `📱 **Comment envoyer :**\n`;
    messageConfirmation += `1. Cliquez sur l'icône 📎\n`;
    messageConfirmation += `2. Sélectionnez "📷 Appareil photo" ou "🖼️ Galerie"\n`;
    messageConfirmation += `3. Prenez/choisissez la photo de l'ordonnance\n\n`;
    messageConfirmation += `⏳ **Votre commande sera traitée après validation.**`;
  } else {
    messageConfirmation += `📝 **POUR FINALISER :**\n`;
    messageConfirmation += `Envoyez :\n`;
    messageConfirmation += `"Nom: [Votre nom]\n`;
    messageConfirmation += `Quartier: [Votre quartier à San Pedro]\n`;
    messageConfirmation += `WhatsApp: [Votre numéro]\n`;
    messageConfirmation += `Indications: [Repère pour livraison]"\n\n`;
    messageConfirmation += `💬 **Exemple :**\n`;
    messageConfirmation += `"Nom: Fatou Traoré\n`;
    messageConfirmation += `Quartier: Résidence du Port\n`;
    messageConfirmation += `WhatsApp: 0701406880\n`;
    messageConfirmation += `Indications: Immeuble bleu, 3ème étage, porte 302"`;
  }
  
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
  userState.step = medicament.necessiteOrdonnance ? 'ATTENTE_ORDONNANCE' : 'ATTENTE_INFOS_LIVRAISON';
  userStates.set(userId, userState);
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

// =================== GESTION DES RENDEZ-VOUS AVEC CLINIQUE ===================
async function gererPriseRendezVous(userId, message) {
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };
  const texte = message.toLowerCase().trim();
  
  console.log(`📅 Traitement rendez-vous: "${message}"`);
  
  // Étape 1: Détection de la demande de rendez-vous
  if (texte.includes('rendez-vous') || texte.includes('rdv') || texte.includes('consultation')) {
    await demanderSpecialiteRendezVous(userId);
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
        `🏥 **${clinique.nom}**\n\n` +
        `✅ **Clinique sélectionnée !**\n\n` +
        `📍 ${clinique.adresse || 'San Pedro'}\n` +
        `📞 ${clinique.telephone || ''}\n\n` +
        `📅 **Quelle date souhaitez-vous ?**\n\n` +
        `📝 **Format :** JJ/MM/AAAA\n\n` +
        `💡 **Exemples :**\n` +
        `• 25/01/2025\n` +
        `• 15/02/2025\n` +
        `• demain\n\n` +
        `📅 **Votre date :**`
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
      `📅 **Date : ${texte}**\n\n` +
      "À quelle **heure** ?\n\n" +
      "⏰ **Format :** HH:MM\n\n" +
      "💡 **Exemples :**\n" +
      "• 09:00\n" +
      "• 14:30\n" +
      "• 16:15\n\n" +
      "⏰ **Votre heure :**"
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
      `⏰ **Heure : ${texte}**\n\n` +
      "Quel est votre **nom complet** ?\n\n" +
      "📝 **Exemple :** Fatou Traoré"
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
      `👤 **Nom : ${texte}**\n\n` +
      "Quel est votre **numéro de téléphone** ?\n\n" +
      "📱 **Format :** 07XXXXXXXX\n" +
      "💡 **Exemple :** 0701406880"
    );
    return;
  }
  
  // Étape 7: Téléphone choisi - FINALISATION
  if (userState.attenteTelephoneRdv) {
    await finaliserRendezVous(userId, texte, userState);
    return;
  }
}

async function demanderSpecialiteRendezVous(userId) {
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };
  
  userState.attenteSpecialiteRdv = true;
  userStates.set(userId, userState);
  
  await sendWhatsAppMessage(
    userId,
    "📅 **PRISE DE RENDEZ-VOUS**\n\n" +
    "Avec quel **spécialiste** ?\n\n" +
    "👨‍⚕️ **Exemples :**\n" +
    "• dermatologue\n" +
    "• médecin généraliste\n" +
    "• dentiste\n" +
    "• gynécologue\n" +
    "• pédiatre\n" +
    "• cardiologue\n\n" +
    "💬 **Répondez avec la spécialité :**\n" +
    '"dermatologue" ou "médecin généraliste"'
  );
}

async function chercherCliniquesParSpecialitePourRdv(userId, specialite) {
  try {
    const userState = userStates.get(userId) || DEFAULT_STATE;
    
    await sendWhatsAppMessage(userId, `🔍 Recherche des cliniques pour "${specialite}"...`);
    
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
        `❌ **Aucune clinique trouvée pour "${specialite}"**\n\n` +
        `💡 **Essayez :**\n` +
        `• Une autre spécialité\n` +
        `• "médecin généraliste"\n` +
        `• Contactez le support\n\n` +
        `📞 **Support :** ${CONFIG.SUPPORT_PHONE}`
      );
      
      userState.attenteSpecialiteRdv = true;
      userStates.set(userId, userState);
      return;
    }
    
    userState.listeCliniquesRdv = cliniquesFiltrees;
    userState.attenteSelectionCliniqueRdv = true;
    userStates.set(userId, userState);
    
    let message = `🏥 **CLINIQUES - ${specialite.toUpperCase()}**\n\n`;
    
    cliniquesFiltrees.forEach((clinique, index) => {
      message += `${index + 1}. **${clinique.nom}**\n`;
      message += `   📍 ${clinique.adresse || 'San Pedro'}\n`;
      if (clinique.telephone) message += `   📞 ${clinique.telephone}\n`;
      
      if (clinique.horaires) {
        message += `   ⏰ ${typeof clinique.horaires === 'object' ? 
          (clinique.horaires.Lundi || clinique.horaires.lundi || 'Sur RDV') : 
          clinique.horaires}\n`;
      }
      
      message += `\n`;
    });
    
    message += `📝 **POUR CHOISIR :**\n`;
    message += `Répondez avec le **numéro** de la clinique\n\n`;
    message += `💬 **Exemple :** "1" pour la première clinique`;
    
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
    
    // Message de confirmation
    await sendWhatsAppMessage(
      userId,
      `✅ **RENDEZ-VOUS PRIS !**\n\n` +
      `📅 **Détails :**\n` +
      `👤 Patient : ${nomRdv}\n` +
      `📱 Téléphone : ${telephone}\n` +
      `🏥 Clinique : ${cliniqueSelectionneeRdv.nom}\n` +
      `📍 Adresse : ${cliniqueSelectionneeRdv.adresse || 'San Pedro'}\n` +
      `👨‍⚕️ Spécialité : ${specialiteRdv}\n` +
      `📅 Date : ${dateRdv}\n` +
      `⏰ Heure : ${heureRdv}\n` +
      `📋 Statut : En attente de confirmation\n\n` +
      `📞 **La clinique vous contactera pour confirmation.**\n\n` +
      `🔔 **Référence :** RDV-${rdvRef.id.substring(0, 8)}\n` +
      `📞 **Support :** ${CONFIG.SUPPORT_PHONE}`
    );
    
    // Réinitialiser
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
  // Générer un ID basé sur la spécialité
  return Date.now().toString() + specialite.substring(0, 3);
}

function genererServiceId(specialite) {
  // Générer un ID de service
  return Date.now().toString() + specialite.substring(0, 5);
}

// =================== RECHERCHE PAR IMAGE ===================
async function traiterRechercheParImage(userId, mediaId, userState) {
  try {
    await sendWhatsAppMessage(userId, "📸 **Image reçue !**");
    
    await sendWhatsAppMessage(
      userId,
      "🖼️ **Pour rechercher un médicament par photo :**\n\n" +
      "📝 **Écrivez le nom du médicament** que vous voyez sur l'image.\n\n" +
      "💡 **Exemples :**\n" +
      "• Paracétamol\n" +
      "• Doliprane 1000mg\n" +
      "• Ibuprofène\n" +
      "• Amoxicilline\n\n" +
      "🔍 **Nom du médicament :**"
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
    "📸 **Ordonnance reçue !**\n\n" +
    "✅ Votre ordonnance a été envoyée pour validation.\n\n" +
    "📝 **POUR FINALISER :**\n" +
    "Envoyez maintenant vos informations :\n\n" +
    "💬 **Format :**\n" +
    '"Nom: [Votre nom]\n' +
    'Quartier: [Votre quartier à San Pedro]\n' +
    'WhatsApp: [Votre numéro]\n' +
    'Indications: [Repère pour livraison]"\n\n' +
    '📋 **Exemple :**\n' +
    '"Nom: Fatou Traoré\n' +
    'Quartier: Résidence du Port\n' +
    'WhatsApp: 0701406880\n' +
    'Indications: Immeuble bleu, 3ème étage, porte 302"\n\n' +
    "📍 **Rappel :** Service uniquement à San Pedro"
  );
  
  userState.attentePhotoOrdonnance = false;
  userState.step = 'ATTENTE_INFOS_LIVRAISON';
  userStates.set(userId, userState);
}

// =================== TRAITEMENT INFORMATIONS DE LIVRAISON ===================
async function traiterInfosLivraison(userId, message, userState) {
  // Instructions claires
  if (message.toLowerCase().includes('exemple') || message.toLowerCase().includes('comment')) {
    await sendWhatsAppMessage(
      userId,
      "📝 **FORMAT REQUIS :**\n\n" +
      "💬 **Copiez-collez et complétez :**\n\n" +
      "Nom: [Votre nom complet]\n" +
      "Quartier: [Votre quartier à San Pedro]\n" +
      "WhatsApp: [Votre numéro WhatsApp]\n" +
      "Indications: [Repère pour livraison]\n\n" +
      "📍 **Exemple complet :**\n" +
      '"Nom: Fatou Traoré\n' +
      'Quartier: Résidence du Port\n' +
      'WhatsApp: 0701406880\n' +
      'Indications: Immeuble bleu, 3ème étage, porte 302"\n\n' +
      "📱 **Envoyez vos informations dans ce format.**"
    );
    return;
  }
  
  // Extraire informations
  const lines = message.split('\n');
  const infos = {};
  
  lines.forEach(line => {
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (match) {
      const cle = match[1].trim().toLowerCase().replace(/[^a-zéèêàâôûîïëüö]/g, '');
      const valeur = match[2].trim();
      infos[cle] = valeur;
    }
  });
  
  // Vérifier champs
  const champsRequis = ['nom', 'quartier', 'whatsapp'];
  const champsManquants = champsRequis.filter(champ => !infos[champ]);
  
  if (champsManquants.length > 0) {
    await sendWhatsAppMessage(
      userId,
      `❌ **INFORMATIONS MANQUANTES :**\n\n` +
      `Ces champs sont requis :\n` +
      champsManquants.map(champ => {
        switch(champ) {
          case 'nom': return "• Nom: [Votre nom complet]";
          case 'quartier': return "• Quartier: [Votre quartier à San Pedro]";
          case 'whatsapp': return "• WhatsApp: [Votre numéro]";
          default: return `• ${champ}`;
        }
      }).join('\n') + `\n\n` +
      `💡 **Utilisez le format :**\n` +
      `"Nom: ...\nQuartier: ...\nWhatsApp: ..."`
    );
    return;
  }
  
  // Vérifier San Pedro
  if (!infos.quartier.toLowerCase().includes('san pedro') && 
      !infos.quartier.toLowerCase().includes('san-pedro')) {
    await sendWhatsAppMessage(
      userId,
      "❌ **SERVICE UNIQUEMENT À SAN PEDRO**\n\n" +
      "Votre quartier doit être à San Pedro.\n\n" +
      "📍 **Exemples de quartiers :**\n" +
      "• Résidence du Port\n" +
      "• Quartier des Pêcheurs\n" +
      "• Centre-ville San Pedro\n" +
      "• Zone portuaire\n\n" +
      "📝 **Corrigez votre quartier :**\n" +
      `"Quartier: [quartier à San Pedro]"`
    );
    return;
  }
  
  // Confirmation de commande
  const commande = userState.commandeEnCours;
  const numeroCommande = `CMD${Date.now().toString().slice(-6)}`;
  
  await sendWhatsAppMessage(
    userId,
    `✅ **COMMANDE CONFIRMÉE #${numeroCommande}**\n\n` +
    `👤 **Client :** ${infos.nom}\n` +
    `📱 WhatsApp : ${infos.whatsapp}\n` +
    `📍 Quartier : ${infos.quartier}\n` +
    (infos.indications ? `🗺️ Indications : ${infos.indications}\n\n` : `\n`) +
    `💊 **Commande :**\n` +
    `${commande.medicamentNom} × ${commande.quantite}\n` +
    `🏥 Pharmacie : ${commande.pharmacieNom}\n` +
    `💰 Total médicaments : ${commande.prixTotal} FCFA\n` +
    `🚚 Livraison : ${commande.fraisLivraison} FCFA\n` +
    `🎯 **TOTAL À PAYER : ${commande.total} FCFA**\n\n` +
    `⏳ **PROCHAINES ÉTAPES :**\n` +
    `1. Validation par la pharmacie\n` +
    `2. Appel de confirmation\n` +
    `3. Livraison à domicile\n\n` +
    `📞 **SUPPORT & SUIVI :**\n` +
    `${CONFIG.SUPPORT_PHONE}\n` +
    `(Référence : ${numeroCommande})`
  );
  
  // Réinitialiser
  userState.commandeEnCours = null;
  userState.resultatsRechercheMedicaments = null;
  userState.listeMedicamentsAvecIndex = [];
  userState.step = 'MENU_PRINCIPAL';
  userStates.set(userId, userState);
}

async function traiterInfosLivraisonMulti(userId, message, userState) {
  // Instructions claires
  if (message.toLowerCase().includes('exemple') || message.toLowerCase().includes('comment')) {
    await sendWhatsAppMessage(
      userId,
      "📝 **FORMAT REQUIS POUR PLUSIEURS MÉDICAMENTS :**\n\n" +
      "💬 **Copiez-collez et complétez :**\n\n" +
      "Nom: [Votre nom complet]\n" +
      "Quartier: [Votre quartier à San Pedro]\n" +
      "WhatsApp: [Votre numéro WhatsApp]\n" +
      "Indications: [Repère pour livraison]\n\n" +
      "📍 **Exemple complet :**\n" +
      '"Nom: Fatou Traoré\n' +
      'Quartier: Résidence du Port\n' +
      'WhatsApp: 0701406880\n' +
      'Indications: Immeuble bleu, 3ème étage, porte 302"\n\n' +
      "📱 **Envoyez vos informations dans ce format.**"
    );
    return;
  }
  
  // Extraire informations
  const lines = message.split('\n');
  const infos = {};
  
  lines.forEach(line => {
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (match) {
      const cle = match[1].trim().toLowerCase().replace(/[^a-zéèêàâôûîïëüö]/g, '');
      const valeur = match[2].trim();
      infos[cle] = valeur;
    }
  });
  
  // Vérifier champs
  const champsRequis = ['nom', 'quartier', 'whatsapp'];
  const champsManquants = champsRequis.filter(champ => !infos[champ]);
  
  if (champsManquants.length > 0) {
    await sendWhatsAppMessage(
      userId,
      `❌ **INFORMATIONS MANQUANTES :**\n\n` +
      `Ces champs sont requis :\n` +
      champsManquants.map(champ => {
        switch(champ) {
          case 'nom': return "• Nom: [Votre nom complet]";
          case 'quartier': return "• Quartier: [Votre quartier à San Pedro]";
          case 'whatsapp': return "• WhatsApp: [Votre numéro]";
          default: return `• ${champ}`;
        }
      }).join('\n') + `\n\n` +
      `💡 **Utilisez le format :**\n` +
      `"Nom: ...\nQuartier: ...\nWhatsApp: ..."`
    );
    return;
  }
  
  // Vérifier San Pedro
  if (!infos.quartier.toLowerCase().includes('san pedro') && 
      !infos.quartier.toLowerCase().includes('san-pedro')) {
    await sendWhatsAppMessage(
      userId,
      "❌ **SERVICE UNIQUEMENT À SAN PEDRO**\n\n" +
      "Votre quartier doit être à San Pedro.\n\n" +
      "📍 **Exemples de quartiers :**\n" +
      "• Résidence du Port\n" +
      "• Quartier des Pêcheurs\n" +
      "• Centre-ville San Pedro\n" +
      "• Zone portuaire\n\n" +
      "📝 **Corrigez votre quartier :**\n" +
      `"Quartier: [quartier à San Pedro]"`
    );
    return;
  }
  
  // Confirmation de commande
  const commande = userState.commandeEnCours;
  const panier = commande.panier || [];
  const numeroCommande = `CMD${Date.now().toString().slice(-6)}`;
  
  let messageConfirmation = `✅ **COMMANDE CONFIRMÉE #${numeroCommande}**\n\n`;
  messageConfirmation += `👤 **Client :** ${infos.nom}\n`;
  messageConfirmation += `📱 WhatsApp : ${infos.whatsapp}\n`;
  messageConfirmation += `📍 Quartier : ${infos.quartier}\n`;
  if (infos.indications) messageConfirmation += `🗺️ Indications : ${infos.indications}\n\n`;
  
  messageConfirmation += `🛒 **VOTRE COMMANDE (${panier.length} médicament(s)) :**\n\n`;
  panier.forEach((item, index) => {
    messageConfirmation += `${index + 1}. **${item.medicamentNom}** × ${item.quantite}\n`;
    messageConfirmation += `   💰 ${item.prixUnitaire} FCFA × ${item.quantite} = ${item.prixUnitaire * item.quantite} FCFA\n`;
    if (item.necessiteOrdonnance) messageConfirmation += `   ⚠️ Ordonnance requise\n`;
    messageConfirmation += `\n`;
  });
  
  messageConfirmation += `📊 **RÉCAPITULATIF :**\n`;
  messageConfirmation += `🧾 Sous-total : ${commande.sousTotal} FCFA\n`;
  messageConfirmation += `🚚 Livraison : ${commande.fraisLivraison} FCFA\n`;
  messageConfirmation += `🎯 **TOTAL À PAYER : ${commande.total} FCFA**\n\n`;
  
  messageConfirmation += `⏳ **PROCHAINES ÉTAPES :**\n`;
  messageConfirmation += `1. Validation par les pharmacies\n`;
  messageConfirmation += `2. Appel de confirmation\n`;
  messageConfirmation += `3. Livraison à domicile\n\n`;
  
  messageConfirmation += `📞 **SUPPORT & SUIVI :**\n`;
  messageConfirmation += `${CONFIG.SUPPORT_PHONE}\n`;
  messageConfirmation += `(Référence : ${numeroCommande})`;
  
  await sendWhatsAppMessage(userId, messageConfirmation);
  
  // Réinitialiser
  userState.commandeEnCours = null;
  userState.panier = [];
  userState.resultatsRechercheMedicaments = null;
  userState.listeMedicamentsAvecIndex = [];
  userState.step = 'MENU_PRINCIPAL';
  userStates.set(userId, userState);
}

// =================== CERVEAU PRINCIPAL - GROQ ===================
async function comprendreEtAgir(userId, message) {
  console.log(`🧠 Analyse: "${message}"`);
  
  // Mettre à jour le contexte
  await gestionnaireContexte.mettreAJourContexte(userId, message, 'user');
  
  const texte = message.toLowerCase().trim();
  
  // Détection directe (bypass Groq pour les cas simples)
  if (texte.match(/^salut|bonjour|coucou|hello$/i)) {
    await sendWhatsAppMessage(userId, "👋 Bonjour ! Comment puis-je vous aider ?");
    return { action: 'SALUTATION' };
  }
  
  if (texte.includes('pharmacie') && texte.includes('garde')) {
    await afficherPharmaciesDeGarde(userId);
    return { action: 'PHARMACIE_GARDE' };
  }
  
  if (texte.includes('paracétamol') || texte.includes('paracetamol') || texte.includes('doliprane')) {
    await rechercherEtAfficherMedicament(userId, 'paracétamol');
    return { action: 'MÉDICAMENT', medicament: 'paracétamol' };
  }
  
  if (texte.includes('ibuprofène') || texte.includes('ibuprofene') || texte.includes('advil')) {
    await rechercherEtAfficherMedicament(userId, 'ibuprofène');
    return { action: 'MÉDICAMENT', medicament: 'ibuprofène' };
  }
  
  if (texte.includes('amoxicilline')) {
    await rechercherEtAfficherMedicament(userId, 'amoxicilline');
    return { action: 'MÉDICAMENT', medicament: 'amoxicilline' };
  }
  
  // Si c'est clairement un médicament
  const mots = texte.split(/\s+/);
  if (mots.length === 1 && mots[0].length > 3) {
    // C'est probablement un nom de médicament
    await rechercherEtAfficherMedicament(userId, texte);
    return { action: 'MÉDICAMENT', medicament: texte };
  }
  
  // Utiliser Groq pour les cas complexes
  try {
    const prompt = `
Tu es Mia, assistante médicale DIRECTE. Pas de phrases inutiles.

## UTILISATEUR : "${message}"

## ACTIONS DIRECTES (choisis une) :
- MÉDICAMENT → si nom de médicament mentionné
- PHARMACIE_GARDE → si "pharmacie de garde" ou "pharmacie ouverte"
- RENDEZ_VOUS → si "rendez-vous" ou "rdv" ou "consultation"
- SALUTATION → si salutation simple
- SUPPORT → si problème/erreur

## RÉPONSE :
- MAX 1 phrase si nécessaire
- NULL si action directe

## EXEMPLES :
Utilisateur: "Paracétamol" → {"action":"MÉDICAMENT","reponse_immediate":null,"medicament":"paracétamol"}
Utilisateur: "Pharmacie de garde" → {"action":"PHARMACIE_GARDE","reponse_immediate":null}
Utilisateur: "Salut" → {"action":"SALUTATION","reponse_immediate":"Bonjour !"}
Utilisateur: "Je veux du doliprane" → {"action":"MÉDICAMENT","reponse_immediate":null,"medicament":"doliprane"}
Utilisateur: "Rdv dermatologue" → {"action":"RENDEZ_VOUS","reponse_immediate":null,"specialite":"dermatologie"}

JSON:
{
  "action": "ACTION",
  "reponse_immediate": "réponse ou null",
  "medicament": "nom ou null",
  "specialite": "spécialité ou null"
}
`;

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: CONFIG.GROQ_MODEL,
        messages: [
          { 
            role: "system", 
            content: "Réponds UNIQUEMENT en JSON. Sois direct. Pas de phrases inutiles." 
          },
          { role: "user", content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 100,
        response_format: { type: "json_object" }
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 3000
      }
    );

    const result = JSON.parse(response.data.choices[0].message.content);
    console.log('✅ Résultat:', JSON.stringify(result));
    
    // Envoyer réponse si nécessaire
    if (result.reponse_immediate && result.reponse_immediate !== "null") {
      await sendWhatsAppMessage(userId, result.reponse_immediate);
    }
    
    // Exécuter action
    if (result.action === 'RENDEZ_VOUS') {
      await demanderSpecialiteRendezVous(userId);
    } else if (result.action === 'MÉDICAMENT' && result.medicament) {
      await rechercherEtAfficherMedicament(userId, result.medicament);
    } else if (result.action === 'PHARMACIE_GARDE') {
      await afficherPharmaciesDeGarde(userId);
    }
    
    return result;
    
  } catch (error) {
    console.error('❌ Erreur:', error.message);
    // Fallback direct
    await sendWhatsAppMessage(
      userId,
      "💊 Médicament ? 🏥 Pharmacie ? 📅 Rendez-vous ?\nDites-moi simplement."
    );
  }
}

// =================== FONCTIONS UTILITAIRES ===================
async function envoyerMessageBienvenue(userId) {
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };
  
  if (!userState.initialized) {
    await sendWhatsAppMessage(
      userId,
      "👋 **BIENVENUE CHEZ PILLBOX SAN PEDRO !**\n\n" +
      "Je suis Mia, votre assistante médicale.\n\n" +
      "💊 **POUR COMMANDER DES MÉDICAMENTS :**\n" +
      "1. Écrivez le nom d'un médicament\n" +
      '   → Ex: "paracétamol"\n' +
      "2. Ajoutez-le à votre panier\n" +
      '   → Ex: "ajouter 1 1"\n' +
      "3. Continuez ou terminez\n" +
      '   → "continuer" pour ajouter un autre\n' +
      '   → "terminer" pour finaliser\n\n' +
      "📅 **POUR UN RENDEZ-VOUS :**\n" +
      '→ Dites "rendez-vous"\n' +
      '→ Choisissez la spécialité\n' +
      '→ Choisissez la clinique\n' +
      '→ Donnez la date et l\'heure\n\n' +
      "🏥 **PHARMACIE DE GARDE :**\n" +
      '→ Dites "pharmacie de garde"\n\n' +
      "📸 **ENVOYER UNE PHOTO :**\n" +
      "• Pour rechercher un médicament\n" +
      "• Pour envoyer une ordonnance\n\n" +
      "📞 **SUPPORT :** " + CONFIG.SUPPORT_PHONE + "\n\n" +
      "📍 **Service uniquement à San Pedro**\n\n" +
      "Comment puis-je vous aider ? 😊"
    );
    
    userState.initialized = true;
    userState.nom = "Client";
    userStates.set(userId, userState);
  }
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
        // Vérifier si c'est pour un rendez-vous
        if (text.toLowerCase().includes('rendez-vous') || 
            text.toLowerCase().includes('rdv') ||
            userState.attenteSpecialiteRdv ||
            userState.attenteSelectionCliniqueRdv ||
            userState.attenteDateRdv ||
            userState.attenteHeureRdv ||
            userState.attenteNomRdv ||
            userState.attenteTelephoneRdv) {
          
          await gererPriseRendezVous(userId, text);
          return;
        }
        
        // Vérifier si c'est pour la gestion du panier
        const resultatPanier = await gestionPanier.gererMessage(userId, text, userState);
        if (resultatPanier !== null) {
          return;
        }
        
        // Vérifier si recherche par image était en attente
        if (userState.attenteMedicamentImage) {
          await rechercherEtAfficherMedicament(userId, text);
          userState.attenteMedicamentImage = false;
          userStates.set(userId, userState);
          return;
        }
        
        // Vérifier si attente de médicament
        if (userState.attenteMedicament) {
          await rechercherEtAfficherMedicament(userId, text);
          userState.attenteMedicament = false;
          userStates.set(userId, userState);
          return;
        }
        
        // Vérifier si attente de commande
        if (userState.attenteCommande && userState.listeMedicamentsAvecIndex) {
          await traiterCommandeMedicament(userId, text, userState);
          return;
        }
        
        // Vérifier si attente d'informations de livraison (commande unique)
        if (userState.step === 'ATTENTE_INFOS_LIVRAISON') {
          await traiterInfosLivraison(userId, text, userState);
          return;
        }
        
        // Vérifier si attente d'informations de livraison (multi-médicaments)
        if (userState.step === 'ATTENTE_INFOS_LIVRAISON_MULTI') {
          await traiterInfosLivraisonMulti(userId, text, userState);
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
      const mediaId = message.image.id;
      
      // Vérifier l'état de l'utilisateur
      if (userState.step === 'ATTENTE_ORDONNANCE') {
        // Ordonnance pour commande en cours
        await traiterImageOrdonnance(userId, userState);
        
      } else if (userState.step === 'ATTENTE_ORDONNANCE_MULTI') {
        // Ordonnance pour commande multi-médicaments
        await traiterImageOrdonnance(userId, userState);
        
      } else if (userState.attentePhotoOrdonnance) {
        // Ancien système (à garder pour compatibilité)
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