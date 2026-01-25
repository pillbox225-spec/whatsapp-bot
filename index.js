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
    
    urgence += pointsExclamation * 0.5;
    stress += pointsInterrogation * 0.3;
    
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
    
    // VÉRIFIER SI MÉDICAMENT NÉCESSITE ORDONNANCE - NE PAS AJOUTER AU PANIER
    if (medicamentInfo.medicament.necessiteOrdonnance) {
      await sendWhatsAppMessage(
        userId,
        `⚠️ **MÉDICAMENT AVEC ORDONNANCE**\n\n` +
        `**${medicamentInfo.medicament.nom}** nécessite une ordonnance médicale.\n\n` +
        `📞 **Pour commander ce médicament :**\n` +
        `1. Contactez directement le support\n` +
        `2. Envoyez la photo de votre ordonnance\n` +
        `3. Un agent vous assistera\n\n` +
        `📸 **Envoyez l'ordonnance au :**\n` +
        `${CONFIG.SUPPORT_PHONE}\n\n` +
        `💊 **Vous pouvez continuer avec d'autres médicaments sans ordonnance.**`
      );
      return;
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
        imageUrl: medicamentInfo.medicament.imageUrls?.[0] || null
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
    
    // Vérifier si ordonnance requise (ne devrait pas arriver car bloqué à l'ajout)
    const ordonnanceRequise = panier.some(item => item.necessiteOrdonnance);
    
    if (ordonnanceRequise) {
      await sendWhatsAppMessage(
        userId,
        `⚠️ **PROBLÈME DE COMMANDE**\n\n` +
        `Votre panier contient un médicament nécessitant une ordonnance.\n\n` +
        `📞 **Pour les médicaments avec ordonnance :**\n` +
        `1. Contactez directement le support\n` +
        `2. Envoyez la photo de votre ordonnance\n` +
        `3. Un agent vous assistera\n\n` +
        `📸 **Envoyez l'ordonnance au :**\n` +
        `${CONFIG.SUPPORT_PHONE}\n\n` +
        `💊 **Vous pouvez continuer avec d'autres médicaments sans ordonnance.**`
      );
      return;
    }
    
    await sendWhatsAppMessage(
      userId,
      `✅ **PANIER FINALISÉ**\n\n` +
      `🛒 **VOTRE COMMANDE (${panier.length} médicament(s)) :**\n\n` +
      this.formaterPanier(panier) + `\n` +
      `📊 **TOTAL : ${total} FCFA**\n\n` +
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
      `Indications: Immeuble bleu, 3ème étage"`
    );
    
    // Sauvegarder la commande
    userState.commandeEnCours = {
      panier: panier,
      sousTotal: sousTotal,
      fraisLivraison: fraisLivraison,
      total: total,
      ordonnanceRequise: false // Toujours false car bloqué à l'ajout
    };
    
    userState.step = 'ATTENTE_INFOS_LIVRAISON_MULTI';
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
    // VÉRIFIER que le texte n'est pas vide
    if (!text || text.trim().length === 0) {
      console.error('❌ Tentative d\'envoi de message vide');
      return null;
    }
    
    // LIMITER la taille (WhatsApp limite à 4096 caractères)
    const messageTexte = text.substring(0, 4095);
    
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "text",
        text: { body: messageTexte }
      },
      {
        headers: { 
          'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`, 
          'Content-Type': 'application/json' 
        },
        timeout: 10000
      }
    );
    console.log(`✅ Message envoyé à ${to.substring(0, 10)}...`);
    return response.data.messages?.[0]?.id;
  } catch (error) {
    console.error('❌ Erreur envoi WhatsApp:', {
      status: error.response?.status,
      message: error.message
    });
    return null;
  }
}

// =================== GESTION DES MÉDICAMENTS ===================
async function rechercherEtAfficherMedicament(userId, nomMedicament) {
  try {
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
    
    // Construire réponse avec images
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
      
      // AFFICHER L'IMAGE SI ELLE EXISTE (petite)
      if (medicament.imageUrls && medicament.imageUrls.length > 0) {
        // WhatsApp ne supporte pas le markdown pour les images dans le texte
        // On mentionne juste qu'il y a une image
        message += `   📸 Image disponible\n`;
      }
      
      message += `💰 ${medicament.prix || '?'} FCFA\n`;
      message += `🏥 ${pharmacie.nom}\n`;
      message += `📦 ${medicament.stock || 0} disponible(s)\n`;
      
      if (medicament.dosage || medicament.forme) {
        message += `💊 ${medicament.dosage || ''} ${medicament.forme || ''}\n`;
      }
      
      // IMPORTANT: MESSAGE SPÉCIAL POUR MÉDICAMENT AVEC ORDONNANCE
      if (medicament.necessiteOrdonnance) {
        message += `⚠️ **ORDONNANCE REQUISE**\n`;
        message += `   📞 Contactez le support : ${CONFIG.SUPPORT_PHONE}\n`;
        message += `   📸 Envoyez votre ordonnance par WhatsApp\n\n`;
      } else {
        message += `✅ Sans ordonnance\n\n`;
      }
    });
    
    // DIFFÉRENTS MESSAGES SELON SI ORDONNANCE REQUISE OU NON
    const aOrdonnance = medicamentsFiltres.some(m => m.necessiteOrdonnance);
    
    if (aOrdonnance) {
      message += `📝 **POUR LES MÉDICAMENTS AVEC ORDONNANCE :**\n`;
      message += `Contactez directement le support au ${CONFIG.SUPPORT_PHONE}\n`;
      message += `Envoyez la photo de votre ordonnance par WhatsApp\n\n`;
      
      message += `📝 **POUR LES MÉDICAMENTS SANS ORDONNANCE :**\n`;
      message += `"ajouter [numéro] [quantité]"\n\n`;
    } else {
      message += `📝 **POUR AJOUTER AU PANIER :**\n`;
      message += `"ajouter [numéro] [quantité]"\n\n`;
    }
    
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
  
  console.log(`🛒 Traitement commande: "${message}"`, {
    panier: userState.panier?.length || 0,
    listeMedicamentsAvecIndex: userState.listeMedicamentsAvecIndex?.length || 0,
    attenteCommande: userState.attenteCommande
  });
  
  // Ajouter au panier
  const ajouterRegex = /ajouter\s+(\d+)(?:\s+(\d+))?/i;
  const matchAjouter = texte.match(ajouterRegex);
  
  if (matchAjouter) {
    const numero = parseInt(matchAjouter[1]);
    const quantite = matchAjouter[2] ? parseInt(matchAjouter[2]) : 1;
    
    if (quantite < 1 || quantite > 10) {
      await sendWhatsAppMessage(userId, "❌ Quantité invalide (1-10).");
      return;
    }
    
    // VÉRIFIER si la liste des médicaments existe
    if (!userState.listeMedicamentsAvecIndex || userState.listeMedicamentsAvecIndex.length === 0) {
      console.error('❌ Liste médicaments vide!');
      await sendWhatsAppMessage(userId, "❌ Aucun médicament sélectionné. Cherchez d'abord un médicament.");
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
    
    // Ajouter au panier (la fonction gère déjà l'ordonnance)
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
        `${medicament.necessiteOrdonnance ? 
          `⚠️ **ORDONNANCE REQUISE**\n` +
          `📞 Contactez le support : ${CONFIG.SUPPORT_PHONE}\n` : 
          '✅ Sans ordonnance\n'}` +
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
        "⚠️ **Médicaments avec ordonnance :**\n" +
        `   → Contactez le support : ${CONFIG.SUPPORT_PHONE}\n` +
        "   → Envoyez la photo de l'ordonnance\n\n" +
        "💡 **Exemple complet :**\n" +
        '"paracétamol" → "ajouter 1 1" → "continuer" → "ibuprofène" → "ajouter 1 2" → "terminer"'
      );
    }
  }
}

// =================== GESTION DES PHARMACIES ===================
async function afficherPharmaciesDeGarde(userId) {
  try {
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
      
      // AFFICHER L'IMAGE SI ELLE EXISTE
      if (pharmacie.imageUrl) {
        message += `   📸 Photo disponible\n`;
      }
      
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
        // AFFICHER L'IMAGE SI ELLE EXISTE
        (clinique.imageUrl ? `📸 Photo disponible\n` : '') +
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
    
    // Mapping des spécialités
    const mappingSpecialites = {
      'dermatologue': 'dermatologie',
      'dermatologiste': 'dermatologie',
      'derma': 'dermatologie',
      'scanner': 'radiologie',
      'irm': 'radiologie',
      'radio': 'radiologie',
      'cardiologue': 'cardiologie',
      'cardio': 'cardiologie',
      'gynécologue': 'gynécologie',
      'gynéco': 'gynécologie',
      'pédiatre': 'pédiatrie',
      'généraliste': 'médecin généraliste',
      'médecin général': 'médecin généraliste'
    };
    
    let specialiteRecherchee = specialite.toLowerCase();
    if (mappingSpecialites[specialiteRecherchee]) {
      specialiteRecherchee = mappingSpecialites[specialiteRecherchee];
    }
    
    const snapshot = await db.collection('centres_sante')
      .where('estVerifie', '==', true)
      .get();
    
    const cliniquesFiltrees = [];
    
    snapshot.docs.forEach(doc => {
      const centre = { id: doc.id, ...doc.data() };
      if (centre.specialites && Array.isArray(centre.specialites)) {
        const specialiteTrouvee = centre.specialites.some(s => {
          const specialiteCentre = s.toLowerCase().trim();
          return specialiteCentre.includes(specialiteRecherchee) || 
                 specialiteRecherchee.includes(specialiteCentre);
        });
        if (specialiteTrouvee) {
          cliniquesFiltrees.push(centre);
        }
      }
    });
    
    if (cliniquesFiltrees.length === 0) {
      // Récupérer toutes les spécialités disponibles
      const toutesSpecialites = new Set();
      snapshot.docs.forEach(doc => {
        const centre = doc.data();
        if (centre.specialites) {
          centre.specialites.forEach(s => toutesSpecialites.add(s));
        }
      });
      
      let message = `🔍 **Aucune clinique spécialisée en "${specialite}" trouvée.**\n\n`;
      
      if (toutesSpecialites.size > 0) {
        message += `💡 **Spécialités disponibles :**\n`;
        message += Array.from(toutesSpecialites).map(s => `• ${s}`).join('\n') + '\n\n';
      }
      
      message += `📝 **Pour prendre rendez-vous :**\n`;
      message += `"rendez-vous [spécialité]"\n\n`;
      message += `📞 **Support :** ${CONFIG.SUPPORT_PHONE}`;
      
      await sendWhatsAppMessage(userId, message);
      
      userState.attenteSpecialiteRdv = true;
      userStates.set(userId, userState);
      return;
    }
    
    userState.listeCliniquesRdv = cliniquesFiltrees;
    userState.attenteSelectionCliniqueRdv = true;
    userStates.set(userId, userState);
    
    let message = `🏥 **CLINIQUES - ${specialiteRecherchee.toUpperCase()}**\n\n`;
    
    cliniquesFiltrees.forEach((clinique, index) => {
      message += `${index + 1}. **${clinique.nom}**\n`;
      
      // AFFICHER L'IMAGE SI ELLE EXISTE
      if (clinique.imageUrl) {
        message += `   📸 Photo disponible\n`;
      }
      
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
      notes: `Rendez-vous via WhatsApp Pillbox - ${specialiteRdv}`,
      source: "whatsapp_bot",
      notifieClinique: false,
      notifiePatient: true
    };

    // 1️⃣ ENREGISTRER dans Firestore
    const rdvRef = await db.collection('rendez_vous').add(rendezVousData);
    const rdvId = rdvRef.id;
    
    console.log(`✅ Rendez-vous ${rdvId} enregistré`);

    // 2️⃣ NOTIFIER LA CLINIQUE (sous-collection)
    await notifierCliniqueRendezVous(
      cliniqueSelectionneeRdv.id, 
      rdvId, 
      rendezVousData
    );

    // 3️⃣ NOTIFIER LE SUPPORT
    await notifierSupportRendezVous(rdvId, rendezVousData);

    // 4️⃣ CONFIRMER AU PATIENT
    const messagePatient = `✅ **RENDEZ-VOUS PRIS !**\n\n` +
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
      `🔔 **Référence :** RDV-${rdvId.substring(0, 8)}\n` +
      `📞 **Support :** ${CONFIG.SUPPORT_PHONE}`;

    await sendWhatsAppMessage(userId, messagePatient);

    // 5️⃣ RÉINITIALISER l'état utilisateur
    userState.attenteTelephoneRdv = false;
    userState.specialiteRdv = null;
    userState.cliniqueSelectionneeRdv = null;
    userState.listeCliniquesRdv = null;
    userState.dateRdv = null;
    userState.heureRdv = null;
    userState.nomRdv = null;
    userState.step = 'MENU_PRINCIPAL';
    userStates.set(userId, userState);

    console.log(`✅ Rendez-vous ${rdvId} traité avec succès`);

  } catch (error) {
    console.error('❌ Erreur rendez-vous:', error);
    await sendWhatsAppMessage(
      userId,
      "❌ Erreur lors de la prise de rendez-vous.\n" +
      "📞 Contactez le support : " + CONFIG.SUPPORT_PHONE
    );
  }
}

// NOTIFIER LA CLINIQUE du rendez-vous
async function notifierCliniqueRendezVous(cliniqueId, rdvId, rdvData) {
  try {
    const notificationClinique = {
      rdvId: rdvId,
      patientNom: rdvData.patientNom,
      patientTelephone: rdvData.patientTelephone,
      specialite: rdvData.serviceNom,
      date: rdvData.date,
      dateCreation: new Date().toISOString(),
      statut: "nouveau",
      source: "whatsapp_bot"
    };

    // Sauvegarder dans sous-collection de la clinique
    await db.collection('centres_sante')
      .doc(cliniqueId)
      .collection('rendez_vous_pending')
      .doc(rdvId)
      .set(notificationClinique);

    console.log(`📋 Rendez-vous ${rdvId} notifié à clinique ${cliniqueId}`);

  } catch (error) {
    console.error('❌ Erreur notification clinique:', error);
  }
}

// NOTIFIER LE SUPPORT du rendez-vous
async function notifierSupportRendezVous(rdvId, rdvData) {
  try {
    const notificationSupport = {
      type: "nouveau_rendez_vous",
      rdvId: rdvId,
      patientId: rdvData.patientId,
      patientNom: rdvData.patientNom,
      patientTelephone: rdvData.patientTelephone,
      cliniqueId: rdvData.centreSanteId,
      cliniqueNom: rdvData.centreSanteNom,
      specialite: rdvData.serviceNom,
      dateRdv: rdvData.date,
      statut: rdvData.statut,
      dateCreation: new Date().toISOString()
    };

    await db.collection('support_notifications')
      .doc(`rdv_${rdvId}`)
      .set(notificationSupport);

    console.log(`📞 Rendez-vous ${rdvId} notifié au support`);

  } catch (error) {
    console.error('❌ Erreur notification support:', error);
  }
}

function convertirDateTimestamp(dateStr, heureStr) {
  try {
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
      const [jour, mois, annee] = dateStr.split('/').map(Number);
      date = new Date(annee, mois - 1, jour);
    }
    
    // Ajouter l'heure
    if (heureStr && heureStr.includes(':')) {
      const [heures, minutes] = heureStr.split(':').map(Number);
      date.setHours(heures, minutes, 0, 0);
    } else if (heureStr && heureStr.includes('h')) {
      const [heures, minutes] = heureStr.split('h').map(Number);
      date.setHours(heures, minutes || 0, 0, 0);
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

// =================== RECHERCHE PAR IMAGE ===================
async function traiterRechercheParImage(userId, mediaId, userState) {
  try {
    await sendWhatsAppMessage(
      userId,
      "📸 **Image reçue !**\n\n" +
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

// =================== TRAITEMENT INFORMATIONS DE LIVRAISON ===================
async function traiterInfosLivraisonMulti(userId, message, userState) {
  try {
    console.log(`📝 Traitement infos livraison multi-médicaments...`);
    
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
    
    // ✅ NOUVEAU WORKFLOW : Commande sans ordonnance (toujours car bloqué à l'ajout)
    const commande = userState.commandeEnCours;
    const panier = commande.panier || [];
    const numeroCommande = `CMD${Date.now().toString().slice(-8)}`;
    const timestamp = new Date().toISOString();
    
    // 1️⃣ CRÉER LA COMMANDE DANS FIRESTORE
    const commandeData = {
      id: numeroCommande,
      clientId: userId,
      clientNom: infos.nom,
      clientTelephone: infos.whatsapp,
      clientQuartier: infos.quartier,
      clientIndications: infos.indications || '',
      articles: panier.map(item => ({
        medicamentId: item.medicamentId,
        medicamentNom: item.medicamentNom,
        pharmacieId: item.pharmacieId,
        pharmacieNom: item.pharmacieNom,
        quantite: item.quantite,
        prixUnitaire: item.prixUnitaire,
        necessiteOrdonnance: false, // Toujours false
        dosage: item.dosage,
        forme: item.forme
      })),
      statut: "en_preparation",
      statut_livraison: "en_attente_livreur",
      statut_paiement: "en_attente",
      sousTotal: commande.sousTotal,
      fraisLivraison: commande.fraisLivraison,
      total: commande.total,
      date_commande: timestamp,
      mode_paiement: "cash_livraison",
      notes: `Commande WhatsApp Pillbox - Sans ordonnance - ${timestamp}`,
      historique: [{
        statut: "en_preparation",
        timestamp: timestamp,
        acteur: "system",
        message: "Commande créée et envoyée à la pharmacie"
      }]
    };
    
    // Sauvegarder dans Firestore
    await db.collection('commandes_medicales').doc(numeroCommande).set(commandeData);
    console.log(`✅ Commande ${numeroCommande} sauvegardée dans Firestore`);
    
    // 2️⃣ ENVOYER À LA PHARMACIE (notification)
    await notifierPharmacie(numeroCommande, commandeData);
    
    // 3️⃣ CHERCHER UN LIVREUR DISPONIBLE
    const livreurId = await trouverLivreurDisponible(infos.quartier);
    
    if (livreurId) {
      await assignerLivreur(numeroCommande, livreurId, commandeData);
    } else {
      console.log(`⚠️ Aucun livreur disponible, mise en attente`);
    }
    
    // 4️⃣ NOTIFIER LE SUPPORT CLIENT
    await notifierSupport(numeroCommande, commandeData);
    
    // 5️⃣ CONFIRMER AU CLIENT
    let messageConfirmation = `✅ **COMMANDE CONFIRMÉE #${numeroCommande}**\n\n`;
    messageConfirmation += `👤 **Client :** ${infos.nom}\n`;
    messageConfirmation += `📱 WhatsApp : ${infos.whatsapp}\n`;
    messageConfirmation += `📍 Quartier : ${infos.quartier}\n`;
    if (infos.indications) messageConfirmation += `🗺️ Indications : ${infos.indications}\n\n`;
    
    messageConfirmation += `🛒 **VOTRE COMMANDE (${panier.length} médicament(s)) :**\n\n`;
    panier.forEach((item, index) => {
      messageConfirmation += `${index + 1}. **${item.medicamentNom}** × ${item.quantite}\n`;
      messageConfirmation += `   💰 ${item.prixUnitaire} FCFA × ${item.quantite} = ${item.prixUnitaire * item.quantite} FCFA\n`;
      messageConfirmation += `   🏥 ${item.pharmacieNom}\n\n`;
    });
    
    messageConfirmation += `📊 **RÉCAPITULATIF :**\n`;
    messageConfirmation += `🧾 Sous-total : ${commande.sousTotal} FCFA\n`;
    messageConfirmation += `🚚 Livraison : ${commande.fraisLivraison} FCFA\n`;
    messageConfirmation += `🎯 **TOTAL À PAYER : ${commande.total} FCFA**\n\n`;
    
    messageConfirmation += `⏳ **PROCHAINES ÉTAPES :**\n`;
    messageConfirmation += `1. ✅ Commande envoyée à la pharmacie\n`;
    messageConfirmation += `2. 📦 Préparation en cours\n`;
    messageConfirmation += `3. 🛵 Livreur assigné bientôt\n`;
    messageConfirmation += `4. 📞 Appel de confirmation sous 15min\n\n`;
    
    messageConfirmation += `📞 **SUIVI & SUPPORT :**\n`;
    messageConfirmation += `${CONFIG.SUPPORT_PHONE}\n`;
    messageConfirmation += `(Référence : ${numeroCommande})`;
    
    await sendWhatsAppMessage(userId, messageConfirmation);
    
    // 6️⃣ RÉINITIALISER L'ÉTAT UTILISATEUR
    userState.commandeEnCours = null;
    userState.panier = [];
    userState.resultatsRechercheMedicaments = null;
    userState.listeMedicamentsAvecIndex = [];
    userState.step = 'MENU_PRINCIPAL';
    userStates.set(userId, userState);
    
    console.log(`✅ Commande ${numeroCommande} traitée avec succès`);
    
  } catch (error) {
    console.error('❌ Erreur finalisation commande:', error);
    await sendWhatsAppMessage(userId,
      "❌ **Erreur lors de la finalisation**\n\n" +
      "Votre commande n'a pas pu être traitée.\n\n" +
      "📞 **Contactez le support immédiatement :**\n" +
      `${CONFIG.SUPPORT_PHONE}\n\n` +
      "Nous allons vous aider manuellement."
    );
  }
}

// 1. NOTIFIER LA PHARMACIE
async function notifierPharmacie(numeroCommande, commandeData) {
  try {
    // Pour chaque pharmacie dans les articles
    const pharmacies = {};
    commandeData.articles.forEach(article => {
      if (!pharmacies[article.pharmacieId]) {
        pharmacies[article.pharmacieId] = {
          nom: article.pharmacieNom,
          articles: []
        };
      }
      pharmacies[article.pharmacieId].articles.push(article);
    });
    
    // Créer une notification pour chaque pharmacie
    for (const [pharmacieId, data] of Object.entries(pharmacies)) {
      const notification = {
        type: "nouvelle_commande",
        commandeId: numeroCommande,
        clientNom: commandeData.clientNom,
        clientTelephone: commandeData.clientTelephone,
        articles: data.articles,
        total: commandeData.total,
        date_commande: commandeData.date_commande,
        statut: "en_preparation",
        timestamp: new Date().toISOString()
      };
      
      // Sauvegarder dans sous-collection pharmacie/notifications
      await db.collection('pharmacies')
        .doc(pharmacieId)
        .collection('notifications_commandes')
        .doc(numeroCommande)
        .set(notification);
      
      console.log(`📦 Notification envoyée à pharmacie ${pharmacieId}`);
    }
    
  } catch (error) {
    console.error('❌ Erreur notification pharmacie:', error);
  }
}

// 2. TROUVER LIVREUR DISPONIBLE
async function trouverLivreurDisponible(quartier) {
  try {
    const snapshot = await db.collection('livreurs')
      .where('estDisponible', '==', true)
      .where('estVerifie', '==', true)
      .limit(5)
      .get();
    
    if (snapshot.empty) {
      return null;
    }
    
    // Prendre le premier disponible
    return snapshot.docs[0].id;
    
  } catch (error) {
    console.error('❌ Erreur recherche livreur:', error);
    return null;
  }
}

// 3. ASSIGNER LE LIVREUR (SANS DÉTAILS DES MÉDICAMENTS)
async function assignerLivreur(numeroCommande, livreurId, commandeData) {
  try {
    // IMPORTANT: NE PAS ENVOYER LES DÉTAILS DES MÉDICAMENTS AU LIVREUR
    const assignment = {
      commandeId: numeroCommande,
      livreurId: livreurId,
      clientNom: commandeData.clientNom,
      clientTelephone: commandeData.clientTelephone,
      clientQuartier: commandeData.clientQuartier,
      clientIndications: commandeData.clientIndications,
      total: commandeData.total,
      statut: "en_attente",
      date_assignation: new Date().toISOString(),
      // NE PAS INCLURE LES ARTICLES - confidentialité
      note: "Commande de médicaments - Détails confidentiels"
    };
    
    // Sauvegarder dans livreurs/commandes_assignees
    await db.collection('livreurs')
      .doc(livreurId)
      .collection('commandes_assignees')
      .doc(numeroCommande)
      .set(assignment);
    
    // Mettre à jour la commande principale
    await db.collection('commandes_medicales')
      .doc(numeroCommande)
      .update({
        livreurId: livreurId,
        statut_livraison: "attente_recuperation",
        'livraison.livreurId': livreurId,
        'livraison.statut_proposition': "accepte"
      });
    
    console.log(`🛵 Livreur ${livreurId} assigné à commande ${numeroCommande}`);
    
  } catch (error) {
    console.error('❌ Erreur assignation livreur:', error);
  }
}

// 4. NOTIFIER LE SUPPORT
async function notifierSupport(numeroCommande, commandeData) {
  try {
    const notificationSupport = {
      type: "nouvelle_commande",
      commandeId: numeroCommande,
      clientId: commandeData.clientId,
      clientNom: commandeData.clientNom,
      clientTelephone: commandeData.clientTelephone,
      total: commandeData.total,
      statut: commandeData.statut,
      date_commande: commandeData.date_commande,
      articles_count: commandeData.articles.length,
      sans_ordonnance: true,
      timestamp: new Date().toISOString()
    };
    
    // Sauvegarder dans collection dédiée support
    await db.collection('support_notifications')
      .doc(numeroCommande)
      .set(notificationSupport);
    
    console.log(`📞 Notification envoyée au support pour ${numeroCommande}`);
    
  } catch (error) {
    console.error('❌ Erreur notification support:', error);
  }
}

// =================== CERVEAU PRINCIPAL - GROQ ===================
async function comprendreEtAgir(userId, message) {
  console.log(`🧠 Analyse: "${message}"`);
  
  // Mettre à jour le contexte
  await gestionnaireContexte.mettreAJourContexte(userId, message, 'user');
  
  const texte = message.toLowerCase().trim();
  
  // Utiliser Groq pour tous les cas
  try {
    const prompt = `
Tu es Mia, assistante médicale pour San Pedro. Sois PRÉCISE et UTILE.

## CONTEXTE :
${gestionnaireContexte.obtenirResumeContexte(userId)}

## UTILISATEUR : "${message}"

## TON RÔLE :
• Assistant médical (pas de diagnostic)
• Conseiller sur les services disponibles
• Orienter vers les spécialistes appropriés
• Donner des conseils généraux de santé

## ACTIONS DISPONIBLES :
- RECHERCHE_MEDICAMENT → si nom de médicament
- PHARMACIE_GARDE → si "pharmacie de garde"
- DEMANDE_RENDEZ_VOUS → si demande de RDV ou spécialiste
- LISTE_CLINIQUES → si "cliniques disponibles"
- CONSEIL_MEDICAL → si symptôme ou question santé
- REMERCIEMENT → si "merci", "parfait"
- SUPPORT → si problème technique
- SALUTATION → si salutation

## IMPORTANT :
• Pas de données fictives
• Pas de diagnostic médical
• Pour médicaments avec ordonnance : diriger vers support
• Pour urgences : conseiller d'aller à l'hôpital

## RÉPONSE JSON :
{
  "action": "ACTION",
  "reponse": "réponse utile ou null",
  "parametres": {"nom_medicament": "nom", "specialite": "spécialité"}
}

## EXEMPLES :
Utilisateur: "Je cherche un dermatologue" → {"action":"DEMANDE_RENDEZ_VOUS","reponse":null,"parametres":{"specialite":"dermatologie"}}
Utilisateur: "Paracétamol" → {"action":"RECHERCHE_MEDICAMENT","reponse":null,"parametres":{"nom_medicament":"paracétamol"}}
Utilisateur: "J'ai mal à la tête" → {"action":"CONSEIL_MEDICAL","reponse":"Pour un mal de tête persistant, consultez un médecin. En attendant, vous pouvez demander du paracétamol.","parametres":{}}
Utilisateur: "Merci" → {"action":"REMERCIEMENT","reponse":"Je vous en prie ! N'hésitez pas si vous avez besoin d'autre chose.","parametres":{}}
Utilisateur: "Pharmacie de garde" → {"action":"PHARMACIE_GARDE","reponse":null,"parametres":{}}
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
        max_tokens: 150,
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
    
    // NE PAS envoyer la réponse Groq si c'est juste un message d'attente
    const messagesAttente = ["je cherche", "je recherche", "patientez", "veuillez"];
    const doitEnvoyerReponseGroq = !messagesAttente.some(msg => 
      result.reponse && result.reponse.toLowerCase().includes(msg)
    );
    
    if (doitEnvoyerReponseGroq && result.reponse && result.reponse !== "null") {
      await sendWhatsAppMessage(userId, result.reponse);
    }
    
    // Exécuter action
    if (result.action === 'DEMANDE_RENDEZ_VOUS' && result.parametres?.specialite) {
      await demanderSpecialiteRendezVous(userId);
    } else if (result.action === 'RECHERCHE_MEDICAMENT' && result.parametres?.nom_medicament) {
      await rechercherEtAfficherMedicament(userId, result.parametres.nom_medicament);
    } else if (result.action === 'PHARMACIE_GARDE') {
      await afficherPharmaciesDeGarde(userId);
    } else if (result.action === 'LISTE_CLINIQUES') {
      await listerToutesLesCliniques(userId);
    } else if (result.action === 'CONSEIL_MEDICAL') {
      // La réponse a déjà été envoyée par Groq
    } else if (result.action === 'REMERCIEMENT') {
      // La réponse a déjà été envoyée par Groq
    } else if (result.action === 'SALUTATION') {
      // La réponse a déjà été envoyée par Groq
    } else if (result.action === 'SUPPORT') {
      await sendWhatsAppMessage(userId, `📞 **Support :** ${CONFIG.SUPPORT_PHONE}`);
    }
    
    return result;
    
  } catch (error) {
    console.error('❌ Erreur Groq:', error.message);
    
    // Fallback direct
    const texte = message.toLowerCase();
    if (texte.includes('pharmacie') && texte.includes('garde')) {
      await afficherPharmaciesDeGarde(userId);
      return { action: 'PHARMACIE_GARDE' };
    } else if (texte.includes('rendez-vous') || texte.includes('rdv')) {
      await demanderSpecialiteRendezVous(userId);
      return { action: 'DEMANDE_RENDEZ_VOUS' };
    } else if (texte.includes('clinique') && texte.includes('disponible')) {
      await listerToutesLesCliniques(userId);
      return { action: 'LISTE_CLINIQUES' };
    } else if (texte.match(/^salut|bonjour|coucou|hello$/i)) {
      await sendWhatsAppMessage(userId, "👋 Bonjour ! Je suis Mia, votre assistante médicale à San Pedro. Comment puis-je vous aider ?");
      return { action: 'SALUTATION' };
    } else if (texte.match(/^merci|parfait|super$/i)) {
      await sendWhatsAppMessage(userId, "Je vous en prie ! 😊 N'hésitez pas si vous avez besoin d'autre chose.");
      return { action: 'REMERCIEMENT' };
    } else {
      // Supposons que c'est un médicament
      await rechercherEtAfficherMedicament(userId, message);
      return { action: 'RECHERCHE_MEDICAMENT' };
    }
  }
}

// =================== LISTE TOUTES LES CLINIQUES ===================
async function listerToutesLesCliniques(userId) {
  try {
    const snapshot = await db.collection('centres_sante')
      .where('estVerifie', '==', true)
      .limit(5)
      .get();
    
    if (snapshot.empty) {
      await sendWhatsAppMessage(
        userId,
        "🏥 **Aucune clinique vérifiée n'est actuellement enregistrée.**\n\n" +
        "📞 **Pour des soins à San Pedro :**\n" +
        "• Contactez le support : " + CONFIG.SUPPORT_PHONE + "\n" +
        "• Rendez-vous à l'hôpital local\n" +
        "• Consultez en pharmacie pour conseils"
      );
      return;
    }
    
    let message = "🏥 **CLINIQUES VÉRIFIÉES - SAN PEDRO**\n\n";
    
    snapshot.docs.forEach((doc, index) => {
      const centre = doc.data();
      message += `${index + 1}. **${centre.nom || 'Clinique'}**\n`;
      
      // AFFICHER L'IMAGE SI ELLE EXISTE
      if (centre.imageUrl) {
        message += `   📸 Photo disponible\n`;
      }
      
      message += `   📍 ${centre.adresse || 'San Pedro'}\n`;
      if (centre.telephone) message += `   ☎ ${centre.telephone}\n`;
      
      if (centre.specialites && centre.specialites.length > 0) {
        message += `   🩺 ${centre.specialites.join(', ')}\n`;
      }
      
      if (centre.horaires && centre.horaires.Lundi) {
        message += `   ⏰ ${centre.horaires.Lundi}\n`;
      }
      message += `\n`;
    });
    
    message += `📝 **POUR PRENDRE RENDEZ-VOUS :**\n`;
    message += `Écrivez "rendez-vous [spécialité]"\n\n`;
    message += `💬 **Exemples :**\n`;
    message += `• "rendez-vous dermatologie"\n`;
    message += `• "rendez-vous radiologie"\n`;
    message += `• "rendez-vous cardiologie"\n\n`;
    message += `📞 **Réservations directes :** ${CONFIG.SUPPORT_PHONE}`;
    
    await sendWhatsAppMessage(userId, message);
    
  } catch (error) {
    console.error('❌ Erreur liste cliniques:', error);
    await sendWhatsAppMessage(
      userId,
      "⚠️ **Service temporairement indisponible**\n\n" +
      "📞 **Pour trouver une clinique à San Pedro :**\n" +
      "1. Contactez directement : ☎ 07 07 07 07 07\n" +
      "2. Rendez-vous à l'hôpital\n" +
      "3. Consultez en pharmacie pour orientation"
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
      "⚠️ **MÉDICAMENTS AVEC ORDONNANCE :**\n" +
      `   → Contactez le support : ${CONFIG.SUPPORT_PHONE}\n` +
      "   → Envoyez la photo de l'ordonnance\n\n" +
      "📅 **POUR UN RENDEZ-VOUS :**\n" +
      '→ Dites "rendez-vous"\n' +
      '→ Choisissez la spécialité\n' +
      '→ Choisissez la clinique\n' +
      '→ Donnez la date et l\'heure\n\n' +
      "🏥 **PHARMACIE DE GARDE :**\n" +
      '→ Dites "pharmacie de garde"\n\n' +
      "🏥 **CLINIQUES DISPONIBLES :**\n" +
      '→ Dites "cliniques disponibles"\n\n' +
      "📸 **ENVOYER UNE PHOTO :**\n" +
      "• Pour rechercher un médicament\n\n" +
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
    
    // Message de bienvenue si premier contact
    if (!userState.initialized) {
      await envoyerMessageBienvenue(userId);
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
        // LOG pour débogage
        console.log(`🔍 État avant traitement:`, {
          step: userState.step,
          panier: userState.panier?.length || 0,
          attenteSpecialiteRdv: userState.attenteSpecialiteRdv,
          attenteSelectionCliniqueRdv: userState.attenteSelectionCliniqueRdv,
          attenteDateRdv: userState.attenteDateRdv,
          attenteHeureRdv: userState.attenteHeureRdv,
          attenteNomRdv: userState.attenteNomRdv,
          attenteTelephoneRdv: userState.attenteTelephoneRdv,
          attenteCommande: userState.attenteCommande,
          attenteMedicament: userState.attenteMedicament,
          commandeEnCours: !!userState.commandeEnCours
        });
        
        // Vérifier si l'utilisateur est déjà engagé dans un processus de RDV
        const estDansProcessusRdv = userState.attenteSpecialiteRdv ||
                                   userState.attenteSelectionCliniqueRdv ||
                                   userState.attenteDateRdv ||
                                   userState.attenteHeureRdv ||
                                   userState.attenteNomRdv ||
                                   userState.attenteTelephoneRdv;
        
        if (estDansProcessusRdv) {
          // L'utilisateur est déjà en train de prendre RDV, continuer le flux
          await gererPriseRendezVous(userId, text);
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
        
        // Vérifier si attente d'informations de livraison (multi-médicaments)
        if (userState.step === 'ATTENTE_INFOS_LIVRAISON_MULTI') {
          await traiterInfosLivraisonMulti(userId, text, userState);
          return;
        }
        
        // Vérifier si c'est pour la gestion du panier
        const resultatPanier = await gestionPanier.gererMessage(userId, text, userState);
        if (resultatPanier !== null) {
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
      // L'utilisateur envoie une image
      await sendWhatsAppMessage(
        userId,
        "📸 **Image reçue !**\n\n" +
        "🖼️ **Utilisations possibles :**\n\n" +
        "1. **Recherche médicament**\n" +
        "   → Écrivez le nom du médicament sur l'image\n\n" +
        "2. **Ordonnance médicale**\n" +
        `   → Contactez le support : ${CONFIG.SUPPORT_PHONE}\n` +
        "   → Envoyez l'image directement au support\n\n" +
        "💡 **Pour rechercher un médicament :**\n" +
        "Écrivez simplement son nom."
      );
      
      userState.attenteMedicamentImage = true;
      userStates.set(userId, userState);
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
✅ Achats multi-médicaments (sans ordonnance)
✅ Compréhension des références
✅ Rendez-vous avec notification clinique
=======================================================
Exemples de messages utilisateur :
• "Je veux du paracétamol"
• "Pharmacie de garde aujourd'hui ?"
• "Rendez-vous avec dermatologue"
• "Quelles cliniques sont disponibles ?"
• "J'ai mal à la tête"
• "Je veux plusieurs médicaments"
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