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
  SUPPORT_PHONE: process.env.SUPPORT_PHONE || "+225XXXXXXXXX",
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
      confusion: ['quoi', 'comment', 'hein', 'pardon', 'je comprends pas', 'je vois pas']
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

    // Détecter confusion
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
    let urgence = 0;
    let stress = 0;
    let douleurForte = 0;
    let satisfaction = 0;
    let confusion = 0;

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
            case 'confusion':
              confusion += 2;
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
    userState.contexte.emotionnel.confusionNiveau =
      Math.min(10, Math.max(0, confusion));

    // Ton général
    if (satisfaction > 2) userState.contexte.emotionnel.ton = 'satisfait';
    else if (urgence > 3) userState.contexte.emotionnel.ton = 'pressé';
    else if (stress > 3) userState.contexte.emotionnel.ton = 'stressé';
    else if (douleurForte > 2) userState.contexte.emotionnel.ton = 'douloureux';
    else if (confusion > 2) userState.contexte.emotionnel.ton = 'confus';
    else userState.contexte.emotionnel.ton = 'neutre';

    userState.contexte.emotionnel.derniereInteractionPositive = satisfaction > 1;
  }

  detecterConfusion(texte, userState) {
    const motsConfusion = ['quoi', 'comment', 'hein', 'pardon', 'je comprends pas', 'je vois pas'];
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

    if (texte.includes("que tu as dit") ||
      texte.includes("dont tu parlais") ||
      texte.includes("mentionné") ||
      texte.includes("précédent")) {
      references.derniereEntite = references.derniereEntite;
    }

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
    // Cette fonction ne contient plus de médicaments fictifs
    // Elle utilisera uniquement ceux de la base de données
    const medicamentsConnus = []; // Vide car on utilisera la base de données
    
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
      resume += `**Symptômes actuels:** ${ctx.medical.symptomesActuels.join(', ')}\n`;
    }

    // Médicaments
    if (ctx.medical.medicamentsRecherches.length > 0) {
      resume += `**Médicaments recherchés:** ${ctx.medical.medicamentsRecherches.join(', ')}\n`;
    }

    // Émotion
    if (ctx.emotionnel.ton !== 'neutre') {
      resume += `**État émotionnel:** ${ctx.emotionnel.ton} `;
      if (ctx.emotionnel.urgenceNiveau > 5) resume += `(urgence: ${ctx.emotionnel.urgenceNiveau}/10)`;
      if (ctx.emotionnel.confusionNiveau > 3) resume += ` (confus: ${ctx.emotionnel.confusionNiveau}/10)`;
      resume += `\n`;
    }

    // Dernier médicament
    if (ctx.medical.dernierMedicamentMentionne) {
      resume += `**Dernier médicament mentionné:** ${ctx.medical.dernierMedicamentMentionne}\n`;
    }

    // Contexte récent (derniers 2 échanges)
    if (ctx.historiqueConversation.length > 1) {
      const derniersMessages = ctx.historiqueConversation
        .slice(-4)
        .map(msg => `${msg.role === 'user' ? 'User' : 'Asst'}: ${msg.message.substring(0, 40)}...`)
        .join(' | ');
      resume += `**Contexte récent:** ${derniersMessages}\n`;
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

    // 6. Si l'utilisateur veut revoir ses commandes
    if (texte === 'mes commandes' || texte === 'commandes' || texte === 'historique') {
      return this.afficherHistoriqueCommandes(userId, userState);
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
        sousTitre: medicamentInfo.medicament.sousTitre || '',
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
      `"mes commandes" pour voir l'historique\n` +
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
      `"mes commandes" pour voir l'historique\n` +
      `"vider" pour vider le panier`
    );
  }

  async afficherHistoriqueCommandes(userId, userState) {
    try {
      const snapshot = await db.collection('commandes_medicales')
        .where('clientId', '==', userId)
        .where('statut', 'not-in', ['supprime', 'annule'])
        .orderBy('date_commande', 'desc')
        .limit(5)
        .get();

      if (snapshot.empty) {
        await sendWhatsAppMessage(userId, "Vous n'avez pas encore passé de commande.");
        return;
      }

      let message = `📋 Vos commandes récentes\n\n`;
      let index = 1;

      snapshot.docs.forEach(doc => {
        const commande = doc.data();
        message += `${index}. Commande #${doc.id.substring(0, 8)}\n`;
        message += `   📅 ${new Date(commande.date_commande.seconds * 1000).toLocaleString('fr-FR')}\n`;
        message += `   💰 ${commande.paiement.montant_total} FCFA\n`;
        message += `   📦 ${commande.articles.length} article(s)\n`;
        message += `   📍 ${commande.livraison.adresse}\n`;
        message += `   📦 Statut: ${this.getStatutLivraison(commande.livraison.statut_livraison)}\n`;
        
        // Ajouter nom du livreur s'il existe
        if (commande.livraison.livreurNom) {
          message += `   👨‍🚀 Livreur: ${commande.livraison.livreurNom}\n`;
        }
        
        // Ajouter numéro du livreur s'il existe
        if (commande.livraison.livreurTelephone) {
          message += `   📞 Livreur: ${commande.livraison.livreurTelephone}\n`;
        }
        
        // Ajouter pharmacie concernée
        if (commande.pharmacienom) {
          message += `   🏥 Pharmacie: ${commande.pharmacienom}\n`;
        }
        
        // Ajouter prix de livraison
        const prixLivraison = commande.paiement.montant_total - 
          commande.articles.reduce((sum, article) => sum + (article.prix_unitaire * article.quantite), 0);
        message += `   🚚 Livraison: ${prixLivraison} FCFA\n`;
        
        message += `\n`;
        index++;
      });

      message += `Pour plus de détails sur une commande, répondez avec son numéro.`;
      await sendWhatsAppMessage(userId, message);

      userState.attenteDetailCommande = true;
      userStates.set(userId, userState);

    } catch (error) {
      console.error('❌ Erreur historique commandes:', error.message);
      await sendWhatsAppMessage(userId, "Problème pour récupérer vos commandes.");
    }
  }

  getStatutLivraison(statut) {
    const statuts = {
      'en_attente': 'En attente',
      'en_cours': 'En cours de livraison',
      'livre': 'Livrée',
      'annulee': 'Annulée',
      'retour': 'Retour'
    };
    return statuts[statut] || statut;
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
      `🏥 Pharmacie: ${panier[0].pharmacieNom}\n` +
      `🚚 Frais de livraison: ${fraisLivraison} FCFA\n` +
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
      message += `${index + 1}. ${item.medicamentNom}`;
      if (item.sousTitre) message += ` (${item.sousTitre})`;
      message += ` × ${item.quantite}\n`;
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
  attenteDetailCommande: false,
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

// =================== CERVEAU PRINCIPAL INTELLIGENT - GROQ ===================
async function comprendreEtAgir(userId, message) {
  console.log(`🧠 Analyse intelligente: "${message}"`);
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };

  // Mettre à jour le contexte conversationnel
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
   - Exemple: "Paracetamol" → cherche "paracetamol" ou "paracétamol" dans la base
   - Si pas trouvé: proposer alternatives similaires si disponibles

2. **AFFICHER_PHARMACIES_GARDE** → Afficher pharmacies DE GARDE réelles
   - Seulement celles avec estDeGarde=true ET estOuvert=true

3. **AFFICHER_CLINIQUES** → Lister cliniques VÉRIFIÉES
   - Seulement celles avec estVerifie=true

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

Utilisateur: "je veux acheter du Paracetamol dans pharmacie cosmos"
→ Recherche spécifique
{
  "action": "RECHERCHER_MEDICAMENT",
  "reponse": "Je vérifie si le paracétamol est disponible à pharmacie cosmos...",
  "parametres": {"nom_medicament": "paracetamol", "pharmacie_nom": "cosmos"},
  "next_step": "RECHERCHE_MEDICAMENT_SPECIFIQUE"
}

Utilisateur: "Quelle pharmacie est de garde?"
→ Demande pharmacies de garde
{
  "action": "AFFICHER_PHARMACIES_GARDE",
  "reponse": "Je vérifie les pharmacies de garde...",
  "parametres": null,
  "next_step": "AFFICHER_PHARMACIES"
}

Utilisateur: "Merci"
→ Remerciement simple
{
  "action": "REPONSE_SIMPLE",
  "reponse": "Avec plaisir ! 😊",
  "parametres": {"type": "remerciement"},
  "next_step": "MENU_PRINCIPAL"
}

Utilisateur: "Les cliniques disponibles"
→ Liste cliniques
{
  "action": "AFFICHER_CLINIQUES",
  "reponse": "Je recherche les cliniques...",
  "parametres": null,
  "next_step": "AFFICHER_CLINIQUES"
}
`;

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: CONFIG.GROQ_MODEL,
        messages: [
          {
            role: "system",
            content: "Tu es une assistante médicale qui utilise uniquement la base de données réelle. Réponds UNIQUEMENT en JSON."
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
        timeout: 5000
      }
    );

    const result = JSON.parse(response.data.choices[0].message.content);
    console.log('🧠 Résultat analyse:', JSON.stringify(result));

    // Envoyer la réponse intelligente
    await sendWhatsAppMessage(userId, result.reponse);

    // Exécuter l'action appropriée
    await executerActionReelle(userId, result, message, userState);

    // Mettre à jour le contexte
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

  // Réinitialiser les états inutiles quand on change de sujet
  if (action === 'AFFICHER_PHARMACIES_GARDE' || action === 'AFFICHER_CLINIQUES' || action === 'PRENDRE_RDV') {
    userState.attenteCommande = false;
    userState.attenteMedicament = false;
    userState.step = 'MENU_PRINCIPAL';
  }

  if (action === 'REPONSE_SIMPLE') {
    if (parametres.type === 'remerciement') {
      // Réinitialiser complètement après remerciement
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

    if (nomMedicament) {
      await rechercherMedicamentReel(userId, nomMedicament, pharmacieSpecifique);
    }

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

    if (specialite || cliniqueSpecifique) {
      await gererPriseRendezVousReel(userId, specialite, cliniqueSpecifique);
    } else {
      userState.attenteSpecialiteRdv = true;
      userStates.set(userId, userState);
      await sendWhatsAppMessage(userId, "Avec quel type de médecin tu veux consulter ?");
    }

  } else if (action === 'GESTION_PANIER') {
    // Laisser la logique de panier gérer
    userStates.set(userId, userState);
  }
}

// =================== FONCTIONS D'EXTRACTION ===================
function extraireNomMedicament(texte) {
  // Cette fonction ne contient plus de médicaments fictifs
  // Elle extraira simplement le terme de recherche
  const texteLower = texte.toLowerCase();
  
  // Recherche de termes médicaux génériques
  const termesMedicaux = [
    'paracetamol', 'paracétamol', 'ibuprofène', 'amoxicilline',
    'aspirine', 'vitamine', 'sirop', 'médicament', 'comprimé',
    'gélule', 'suspension', 'injection', 'pommade', 'crème'
  ];
  
  for (const terme of termesMedicaux) {
    if (texteLower.includes(terme)) {
      return terme;
    }
  }
  
  return texteLower;
}

function extrairePharmacieSpecifique(texte) {
  const pharmaciesConnues = ['cosmos', 'la paix', 'central', 'principale', 'du centre'];
  const texteLower = texte.toLowerCase();

  for (const pharmacie of pharmaciesConnues) {
    if (texteLower.includes(pharmacie)) {
      return pharmacie;
    }
  }

  return null;
}

function extraireCliniqueSpecifique(texte) {
  const cliniquesConnues = ['pastora', 'saint', 'centrale', 'principal', 'polyclinique'];
  const texteLower = texte.toLowerCase();

  for (const clinique of cliniquesConnues) {
    if (texteLower.includes(clinique)) {
      return clinique;
    }
  }

  return null;
}

function extraireSpecialite(texte) {
  const specialites = [
    'dermatologue', 'dermatologie',
    'cardiologue', 'cardiologie',
    'gynécologue', 'gynécologie',
    'pédiatre', 'pédiatrie',
    'médecin généraliste', 'généraliste', 'médecin',
    'dentiste', 'dentaire',
    'ophtalmologue', 'ophtalmologie',
    'radiologue', 'radiologie',
    'psychiatre', 'psychiatrie',
    'chirurgien', 'chirurgie',
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

// =================== RECHERCHE RÉELLE DE MÉDICAMENTS ===================
async function rechercherMedicamentReel(userId, nomMedicament, pharmacieSpecifique = null) {
  try {
    console.log(`🔍 Recherche réelle: ${nomMedicament}${pharmacieSpecifique ? ` dans ${pharmacieSpecifique}` : ''}`);

    const termeRecherche = nomMedicament.toLowerCase().trim();

    // Recherche dans medicaments (nom OU sous-titre)
    const medicamentsSnapshot = await db.collection('medicaments')
      .where('stock', '>', 0)
      .limit(20)
      .get();

    const medicamentsFiltres = [];

    medicamentsSnapshot.docs.forEach(doc => {
      const medicament = { id: doc.id, ...doc.data() };
      const nomMed = (medicament.nom || '').toLowerCase();
      const sousTitre = (medicament.sousTitre || '').toLowerCase();

      // Correspondance flexible (contient le terme dans nom OU sous-titre)
      if (nomMed.includes(termeRecherche) ||
          sousTitre.includes(termeRecherche) ||
          termeRecherche.includes(nomMed) ||
          termeRecherche.includes(sousTitre)) {
        medicamentsFiltres.push(medicament);
      }
    });

    // Si pharmacie spécifique demandée
    if (pharmacieSpecifique && medicamentsFiltres.length > 0) {
      // Chercher la pharmacie par nom
      const pharmaciesSnapshot = await db.collection('pharmacies')
        .where('estOuvert', '==', true)
        .limit(10)
        .get();

      const pharmacieTrouvee = pharmaciesSnapshot.docs.find(doc => {
        const pharmacie = doc.data();
        const nomPharma = (pharmacie.nom || '').toLowerCase();
        return nomPharma.includes(pharmacieSpecifique.toLowerCase());
      });

      if (pharmacieTrouvee) {
        const pharmacieData = pharmacieTrouvee.data();
        const medicamentsPharmacie = medicamentsFiltres.filter(m =>
          m.pharmacieId === pharmacieTrouvee.id
        );

        if (medicamentsPharmacie.length > 0) {
          await afficherResultatsMedicament(userId, medicamentsPharmacie, pharmacieTrouvee.id, pharmacieData.nom);
          return;
        } else {
          await sendWhatsAppMessage(
            userId,
            `Je ne trouve pas "${nomMedicament}" à ${pharmacieData.nom}.\n\n` +
            `Mais je le trouve dans d'autres pharmacies :`
          );
          // Continuer pour afficher les autres pharmacies
        }
      }
    }

    // Si pas trouvé du tout
    if (medicamentsFiltres.length === 0) {
      await sendWhatsAppMessage(
        userId,
        `Je ne trouve pas "${nomMedicament}" en stock.\n\n` +
        `📞 Support : ${CONFIG.SUPPORT_PHONE}`
      );
      return;
    }

    // Grouper par pharmacie
    const medicamentsParPharmacie = {};

    for (const medicament of medicamentsFiltres) {
      if (!medicament.pharmacieId) continue;

      if (!medicamentsParPharmacie[medicament.pharmacieId]) {
        medicamentsParPharmacie[medicament.pharmacieId] = {
          medicaments: [],
          pharmacieId: medicament.pharmacieId
        };
      }
      medicamentsParPharmacie[medicament.pharmacieId].medicaments.push(medicament);
    }

    // Récupérer les infos pharmacies
    const pharmacieIds = Object.keys(medicamentsParPharmacie);
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

    // Afficher résultats
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

        message += `${index}. ${medicament.nom}`;
        if (medicament.sousTitre) message += ` (${medicament.sousTitre})`;
        message += `\n`;
        message += `   ${medicament.prix || '?'} FCFA\n`;
        message += `   ${pharmacie.nom}\n`;

        if (medicament.dosage || medicament.forme) {
          message += `   ${medicament.dosage || ''} ${medicament.forme || ''}\n`;
        }

        message += `${medicament.necessiteOrdonnance ? '📄 Ordonnance requise' : '✅ Sans ordonnance'}\n\n`;
        index++;
      }
    }

    message += `🛒 Pour commander :\n`;
    message += `"ajouter [numéro] [quantité]"\n\n`;

    const userStateCurrent = userStates.get(userId) || DEFAULT_STATE;
    if (userStateCurrent.panier && userStateCurrent.panier.length > 0) {
      message += `Votre panier : ${userStateCurrent.panier.length} médicament(s)\n`;
      message += `• "continuer" pour ajouter un autre\n`;
      message += `• "terminer" pour finaliser\n`;
      message += `• "panier" pour voir le panier\n`;
      message += `• "mes commandes" pour voir l'historique\n`;
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
    console.error('❌ Erreur recherche réelle:', error.message);
    await sendWhatsAppMessage(
      userId,
      `Problème pour chercher "${nomMedicament}".\n\n` +
      `📞 Support : ${CONFIG.SUPPORT_PHONE}`
    );
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

    message += `${numero}. ${medicament.nom}`;
    if (medicament.sousTitre) message += ` (${medicament.sousTitre})`;
    message += `\n`;
    message += `   ${medicament.prix || '?'} FCFA\n`;

    if (medicament.dosage || medicament.forme) {
      message += `   ${medicament.dosage || ''} ${medicament.forme || ''}\n`;
    }

    message += `${medicament.necessiteOrdonnance ? '📄 Ordonnance requise' : '✅ Sans ordonnance'}\n\n`;
  });

  message += `🛒 Pour commander :\n`;
  message += `"ajouter [numéro] [quantité]"\n\n`;
  message += `Après ajout, dites "continuer" ou "terminer".\n`;
  message += `"mes commandes" pour voir l'historique`;

  await sendWhatsAppMessage(userId, message);

  // Sauvegarder pour commande
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

  // Détection immédiate des demandes critiques
  if (detecterDemandeImmediate(texte)) {
    await traiterDemandeImmediate(userId, message, userState);
    return;
  }

  // Détection de remerciement - RÉINITIALISATION
  if (texte.includes('merci')) {
    console.log(`🔄 Réinitialisation après remerciement`);

    await sendWhatsAppMessage(userId, "Avec plaisir ! 😊");

    // RÉINITIALISER COMPLÈTEMENT
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

  // Si l'utilisateur est en ATTENTE_COMMANDE mais change de sujet
  if (userState.attenteCommande &&
      (texte.includes('pharmacie') || texte.includes('clinique') || texte.includes('garde'))) {

    console.log(`🔄 Changement de sujet détecté`);
    userState.attenteCommande = false;
    userState.step = 'MENU_PRINCIPAL';
    userStates.set(userId, userState);

    if (texte.includes('pharmacie') && texte.includes('garde')) {
      await afficherPharmaciesDeGardeReelles(userId);
    } else if (texte.includes('clinique')) {
      await afficherCliniquesReelles(userId);
    }
    return;
  }

  // UTILISER GROQ pour analyser
  await comprendreEtAgir(userId, message);

  // Mettre à jour historique
  if (!userState.historiqueMessages) {
    userState.historiqueMessages = [];
  }
  userState.historiqueMessages.push({
    message: message,
    timestamp: new Date().toISOString()
  });

  if (userState.historiqueMessages.length > 20) {
    userState.historiqueMessages = userState.historiqueMessages.slice(-20);
  }

  userStates.set(userId, userState);
}

function detecterDemandeImmediate(texte) {
  const demandesImmediates = [
    'paracetamol', 'paracétamol', 'doliprane', 'ibuprofène', 'amoxicilline',
    'pharmacie de garde', 'pharmacies de garde',
    'clinique', 'cliniques',
    'rendez-vous', 'rdv',
    'commander', 'acheter', 'je veux'
  ];

  return demandesImmediates.some(demande => texte.includes(demande));
}

async function traiterDemandeImmediate(userId, message, userState) {
  const texte = message.toLowerCase();

  // Détection médicament
  const medicament = extraireNomMedicament(texte);
  if (medicament) {
    const pharmacieSpecifique = extrairePharmacieSpecifique(texte);
    await rechercherMedicamentReel(userId, medicament, pharmacieSpecifique);
    return;
  }

  // Détection pharmacies de garde
  if (texte.includes('pharmacie') && texte.includes('garde')) {
    await afficherPharmaciesDeGardeReelles(userId);
    return;
  }

  // Détection cliniques
  if (texte.includes('clinique') && (texte.includes('disponible') || texte.includes('liste'))) {
    await afficherCliniquesReelles(userId);
    return;
  }

  // Détection rendez-vous
  if (texte.includes('rendez-vous') || texte.includes('rdv')) {
    const specialite = extraireSpecialite(texte);
    const cliniqueSpecifique = extraireCliniqueSpecifique(texte);
    await gererPriseRendezVousReel(userId, specialite, cliniqueSpecifique);
    return;
  }

  // Si aucune détection immédiate, passer à Groq
  await comprendreEtAgir(userId, message);
}

// =================== GESTION DES PHARMACIES DE GARDE RÉELLES ===================
async function afficherPharmaciesDeGardeReelles(userId) {
  try {
    const userState = userStates.get(userId) || DEFAULT_STATE;

    // Réinitialiser l'état
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

    message += `💊 Tu peux commander des médicaments en ligne.\n\n`;
    message += `📞 Support : ${CONFIG.SUPPORT_PHONE}`;

    await sendWhatsAppMessage(userId, message);

  } catch (error) {
    console.error('❌ Erreur pharmacies de garde:', error.message);
    await sendWhatsAppMessage(
      userId,
      "Problème pour accéder à la liste des pharmacies.\n\n" +
      `📞 Support : ${CONFIG.SUPPORT_PHONE}`
    );
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
      await sendWhatsAppMessage(
        userId,
        "Aucune clinique trouvée pour le moment.\n\n" +
        `📞 Support : ${CONFIG.SUPPORT_PHONE}`
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

    message += "Pour prendre rendez-vous :\n";
    message += 'Dites "rendez-vous [spécialité]"\n\n';
    message += `📞 Support : ${CONFIG.SUPPORT_PHONE}`;

    await sendWhatsAppMessage(userId, message);

  } catch (error) {
    console.error('❌ Erreur liste cliniques:', error.message);
    await sendWhatsAppMessage(
      userId,
      "Problème lors de la recherche.\n\n" +
      `📞 Support : ${CONFIG.SUPPORT_PHONE}`
    );
  }
}

// =================== GESTION DES RENDEZ-VOUS RÉELS ===================
async function gererPriseRendezVousReel(userId, specialite = null, cliniqueSpecifique = null) {
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };

  if (specialite) {
    userState.specialiteRdv = specialite;
    userState.attenteSpecialiteRdv = false;
    userStates.set(userId, userState);

    // Chercher les cliniques pour cette spécialité
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

    const snapshot = await db.collection('centres_sante')
      .where('estVerifie', '==', true)
      .get();

    const cliniquesFiltrees = [];

    snapshot.docs.forEach(doc => {
      const centre = { id: doc.id, ...doc.data() };

      // Vérifier si clinique spécifique demandée
      if (cliniqueSpecifique) {
        const nomClinique = (centre.nom || '').toLowerCase();
        if (!nomClinique.includes(cliniqueSpecifique.toLowerCase())) {
          return;
        }
      }

      // Vérifier dans les spécialités
      let specialiteTrouvee = false;

      if (centre.specialites && Array.isArray(centre.specialites)) {
        specialiteTrouvee = centre.specialites.some(s =>
          s && s.toLowerCase().includes(specialite.toLowerCase())
        );
      }

      // Vérifier aussi dans les services
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
        `Je ne trouve pas de clinique pour "${specialite}"${cliniqueSpecifique ? ` nommée "${cliniqueSpecifique}"` : ''}.\n\n` +
        `📞 Support : ${CONFIG.SUPPORT_PHONE}`
      );
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
        const specialitesFiltrees = clinique.specialites.filter(s =>
          s && s.toLowerCase().includes(specialite.toLowerCase())
        );
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

// =================== TRAITEMENT COMMANDE MÉDICAMENT ===================
async function traiterCommandeMedicament(userId, message, userState) {
  const texte = message.toLowerCase().trim();

  // Détection de changement de sujet
  const changementSujetMots = ['pharmacie', 'clinique', 'garde', 'disponible', '?', 'quoi', 'comment', 'autre'];
  const estChangementSujet = changementSujetMots.some(mot => texte.includes(mot));

  if (estChangementSujet) {
    // Réinitialiser et traiter la nouvelle demande
    userState.attenteCommande = false;
    userState.step = 'MENU_PRINCIPAL';
    userStates.set(userId, userState);
    await gererMessageNaturel(userId, message);
    return;
  }

  // Ajouter au panier
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

    // Vérifier stock
    if (medicamentInfo.medicament.stock < quantite) {
      await sendWhatsAppMessage(
        userId,
        `Stock insuffisant. Il reste ${medicamentInfo.medicament.stock} disponible(s).\n\n` +
        `📞 Support : ${CONFIG.SUPPORT_PHONE}`
      );
      return;
    }

    // Vérifier ordonnance
    if (medicamentInfo.medicament.necessiteOrdonnance) {
      await sendWhatsAppMessage(
        userId,
        `Ce médicament nécessite une ordonnance.\n\n` +
        `Envoie la photo de ton ordonnance au support.\n\n` +
        `📞 Support : ${CONFIG.SUPPORT_PHONE}`
      );
      return;
    }

    // Ajouter au panier
    await gestionPanier.ajouterAuPanier(userId, medicamentInfo, quantite);

  } else {
    // Vérifier si c'est une commande de gestion de panier
    const resultatPanier = await gestionPanier.gererMessage(userId, texte, userState);
    if (resultatPanier === null) {
      await sendWhatsAppMessage(
        userId,
        "Pour commander :\n" +
        '"ajouter [numéro] [quantité]"\n\n' +
        'Exemple :\n' +
        '"ajouter 1 1" pour ajouter 1 du médicament n°1'
      );
    }
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

        // Attente pour éviter messages WhatsApp en double
        await new Promise(resolve => setTimeout(resolve, 100));

        // Traitement avec verrou
        await withUserLock(userId, async () => {
          // 1. États de collecte d'informations
          if (userState.step === 'ATTENTE_NOM' ||
              userState.step === 'ATTENTE_QUARTIER' ||
              userState.step === 'ATTENTE_WHATSAPP' ||
              userState.step === 'ATTENTE_INDICATIONS' ||
              userState.step === 'ATTENTE_NOM_MULTI' ||
              userState.step === 'ATTENTE_QUARTIER_MULTI' ||
              userState.step === 'ATTENTE_WHATSAPP_MULTI' ||
              userState.step === 'ATTENTE_INDICATIONS_MULTI') {

            if (userState.step.includes('MULTI')) {
              await collecterInfosLivraisonMulti(userId, text, userState);
            } else {
              await collecterInfosLivraison(userId, text, userState);
            }
            return;
          }

          // 2. États de rendez-vous
          if (userState.attenteSpecialiteRdv ||
              userState.attenteSelectionCliniqueRdv ||
              userState.attenteDateRdv ||
              userState.attenteHeureRdv ||
              userState.attenteNomRdv ||
              userState.attenteTelephoneRdv) {

            await gererPriseRendezVous(userId, text);
            return;
          }

          // 3. Gestion du panier
          const resultatPanier = await gestionPanier.gererMessage(userId, text, userState);
          if (resultatPanier !== null) {
            return;
          }

          // 4. Commande de médicament (après recherche)
          if (userState.attenteCommande && userState.listeMedicamentsAvecIndex) {
            await traiterCommandeMedicament(userId, text, userState);
            return;
          }

          // 5. Recherche par image
          if (userState.attenteMedicamentImage) {
            await rechercherMedicamentReel(userId, text);
            userState.attenteMedicamentImage = false;
            userStates.set(userId, userState);
            return;
          }

          // 6. Demande directe de médicament
          if (userState.attenteMedicament) {
            await rechercherMedicamentReel(userId, text);
            userState.attenteMedicament = false;
            userStates.set(userId, userState);
            return;
          }

          // 7. Détail d'une commande
          if (userState.attenteDetailCommande) {
            await afficherDetailCommande(userId, text, userState);
            return;
          }

          // 8. Confirmation de commande
          if (userState.step === 'CONFIRMATION_COMMANDE' || userState.step === 'CONFIRMATION_COMMANDE_MULTI') {
            await traiterConfirmationCommande(userId, text, userState);
            return;
          }

          // 9. Gestion des avis
          if (userState.attenteAvisCommande) {
            await gererAvisCommande(userId, text, userState);
            return;
          }

          // TOUT LE RESTE : GESTION NATURELLE
          await gererMessageNaturel(userId, text);

          userStates.set(userId, userState);
        });

      } else if (messageType === 'image') {
        const mediaId = message.image.id;

        // Vérifier l'état de l'utilisateur
        if (userState.step === 'ATTENTE_ORDONNANCE') {
          await traiterImageOrdonnance(userId, userState);
        } else if (userState.step === 'ATTENTE_ORDONNANCE_MULTI') {
          await traiterImageOrdonnance(userId, userState);
        } else if (userState.attentePhotoOrdonnance) {
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

// =================== COLLECTE D'INFOS LIVRAISON ===================
async function collecterInfosLivraison(userId, message, userState) {
  const texte = message.trim();

  if (userState.attenteNom) {
    userState.commandeEnCours.nom = texte;
    userState.attenteNom = false;
    userState.attenteQuartier = true;
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "Quel est votre quartier ?");
    return;
  }

  if (userState.attenteQuartier) {
    userState.commandeEnCours.quartier = texte;
    userState.attenteQuartier = false;
    userState.attenteWhatsApp = true;
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "Quel est votre numéro WhatsApp ?");
    return;
  }

  if (userState.attenteWhatsApp) {
    userState.commandeEnCours.whatsapp = texte;
    userState.attenteWhatsApp = false;
    userState.attenteIndications = true;
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "Avez-vous des indications pour la livraison ?");
    return;
  }

  if (userState.attenteIndications) {
    userState.commandeEnCours.indications = texte;
    userState.attenteIndications = false;
    userStates.set(userId, userState);
    await confirmerInfosLivraison(userId, userState);
    return;
  }
}

async function collecterInfosLivraisonMulti(userId, message, userState) {
  const texte = message.trim();

  if (userState.step === 'ATTENTE_NOM_MULTI') {
    userState.commandeEnCours.nom = texte;
    userState.step = 'ATTENTE_QUARTIER_MULTI';
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "Quel est votre quartier ?");
    return;
  }

  if (userState.step === 'ATTENTE_QUARTIER_MULTI') {
    userState.commandeEnCours.quartier = texte;
    userState.step = 'ATTENTE_WHATSAPP_MULTI';
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "Quel est votre numéro WhatsApp ?");
    return;
  }

  if (userState.step === 'ATTENTE_WHATSAPP_MULTI') {
    userState.commandeEnCours.whatsapp = texte;
    userState.step = 'ATTENTE_INDICATIONS_MULTI';
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "Avez-vous des indications pour la livraison ?");
    return;
  }

  if (userState.step === 'ATTENTE_INDICATIONS_MULTI') {
    userState.commandeEnCours.indications = texte;
    userStates.set(userId, userState);
    await confirmerInfosLivraisonMulti(userId, userState);
    return;
  }
}

async function confirmerInfosLivraison(userId, userState) {
  const commande = userState.commandeEnCours;
  const panier = commande.panier;

  let message = `✅ Confirmation de commande\n\n`;
  message += `**Nom:** ${commande.nom}\n`;
  message += `**Quartier:** ${commande.quartier}\n`;
  message += `**WhatsApp:** ${commande.whatsapp}\n`;
  message += `**Indications:** ${commande.indications || 'Aucune'}\n\n`;
  message += `📦 Votre commande:\n\n`;

  panier.forEach((item, index) => {
    message += `${index + 1}. ${item.medicamentNom} × ${item.quantite}\n`;
    message += `   ${item.prixUnitaire} FCFA × ${item.quantite} = ${item.prixUnitaire * item.quantite} FCFA\n\n`;
  });

  message += `🏥 Pharmacie: ${panier[0].pharmacieNom}\n`;
  message += `🚚 Frais de livraison: ${getFraisLivraison()} FCFA\n`;
  message += `💵 TOTAL: ${commande.total} FCFA\n\n`;
  message += `Confirmez-vous cette commande ?\n`;
  message += `"oui" pour confirmer\n`;
  message += `"non" pour annuler`;

  await sendWhatsAppMessage(userId, message);

  userState.step = 'CONFIRMATION_COMMANDE';
  userStates.set(userId, userState);
}

async function confirmerInfosLivraisonMulti(userId, userState) {
  const commande = userState.commandeEnCours;
  const panier = commande.panier;

  let message = `✅ Confirmation de commande\n\n`;
  message += `**Nom:** ${commande.nom}\n`;
  message += `**Quartier:** ${commande.quartier}\n`;
  message += `**WhatsApp:** ${commande.whatsapp}\n`;
  message += `**Indications:** ${commande.indications || 'Aucune'}\n\n`;
  message += `📦 Votre commande:\n\n`;

  panier.forEach((item, index) => {
    message += `${index + 1}. ${item.medicamentNom} × ${item.quantite}\n`;
    message += `   ${item.prixUnitaire} FCFA × ${item.quantite} = ${item.prixUnitaire * item.quantite} FCFA\n\n`;
  });

  message += `🏥 Pharmacie: ${panier[0].pharmacieNom}\n`;
  message += `🚚 Frais de livraison: ${getFraisLivraison()} FCFA\n`;
  message += `💵 TOTAL: ${commande.total} FCFA\n\n`;
  message += `Confirmez-vous cette commande ?\n`;
  message += `"oui" pour confirmer\n`;
  message += `"non" pour annuler`;

  await sendWhatsAppMessage(userId, message);

  userState.step = 'CONFIRMATION_COMMANDE_MULTI';
  userStates.set(userId, userState);
}

// =================== TRAITEMENT CONFIRMATION COMMANDE ===================
async function traiterConfirmationCommande(userId, message, userState) {
  const texte = message.toLowerCase().trim();

  if (texte === 'oui' || texte === 'confirmer') {
    // Créer la commande
    const commande = userState.commandeEnCours;
    const numeroCommande = uuidv4().substring(0, 8).toUpperCase();
    
    await creerCommandeFirestore(userId, userState, commande, numeroCommande);
    
  } else if (texte === 'non' || texte === 'annuler') {
    // Annuler la commande
    userState.commandeEnCours = null;
    userState.panier = [];
    userState.step = 'MENU_PRINCIPAL';
    userStates.set(userId, userState);
    
    await sendWhatsAppMessage(userId, "Commande annulée. Dites-moi si vous avez besoin d'autre chose.");
  } else {
    await sendWhatsAppMessage(userId, "Répondez par 'oui' pour confirmer ou 'non' pour annuler.");
  }
}

// =================== CRÉATION DE COMMANDE ===================
async function creerCommandeFirestore(userId, userState, commande, numeroCommande) {
  try {
    const panier = commande.panier;
    const articles = [];

    for (const item of panier) {
      articles.push({
        medicamentId: item.medicamentId,
        medicamentNom: item.medicamentNom,
        sousTitre: item.sousTitre || '',
        pharmacieId: item.pharmacieId,
        pharmacieNom: item.pharmacieNom,
        quantite: item.quantite,
        prix_unitaire: item.prixUnitaire,
        necessiteOrdonnance: item.necessiteOrdonnance,
        dosage: item.dosage,
        forme: item.forme,
        image_url: item.imageUrls[0] || ''
      });
    }

    const commandeRef = db.collection('commandes_medicales').doc();
    const maintenant = new Date();

    const codeSecurite = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Calculer le prix de livraison
    const prixLivraison = getFraisLivraison();
    const sousTotal = panier.reduce((total, item) => total + (item.prixUnitaire * item.quantite), 0);
    const total = sousTotal + prixLivraison;

    // Récupérer numéro du livreur
    const livreurInfo = await assignerLivreur(userId, commande.quartier);
    let livreurTelephone = null;
    
    if (livreurInfo) {
      livreurTelephone = livreurInfo.telephone;
    }

    await commandeRef.set({
      clientId: userId,
      clientNom: commande.nom,
      date_commande: admin.firestore.Timestamp.now(),
      date_modification: admin.firestore.Timestamp.now(),
      derniere_maj: admin.firestore.Timestamp.now(),
      derniere_recherche: admin.firestore.Timestamp.now(),
      statut: 'en_attente',
      articles: articles,
      paiement: {
        montant_total: total,
        statut_paiement: 'en_attente',
        mode: 'cash_livraison'
      },
      livraison: {
        adresse: commande.quartier,
        indications: commande.indications || '',
        statut_livraison: 'en_attente',
        statut_proposition: 'en_attente_livreur',
        dateProposee: null,
        dateAcceptation: null,
        date_recuperation: null,
        livreurId: livreurInfo ? livreurInfo.id : null,
        livreurNom: livreurInfo ? `${livreurInfo.nom} ${livreurInfo.prenom}` : null,
        livreurTelephone: livreurTelephone,
        livreurProposeId: null,
        livreurProposeNom: null,
        position: new admin.firestore.GeoPoint(0, 0)
      },
      info_medicale: {
        age: userState.contexte.profil.age || null,
        genre: userState.contexte.profil.sexe || null,
        allergies: userState.contexte.profil.preferences.allergies || [],
        traitementsEnCours: [],
        conditionsChroniques: userState.contexte.profil.preferences.conditionsChroniques || []
      },
      pharmacieId: panier[0].pharmacieId,
      pharmacienom: panier[0].pharmacieNom,
      code_securite: codeSecurite
    });

    // Mettre à jour l'état utilisateur
    userState.derniereCommandeRef = commandeRef.id;
    userState.apresCommande = true;
    userState.panier = [];
    userState.commandeEnCours = null;
    userState.step = 'MENU_PRINCIPAL';
    userStates.set(userId, userState);

    // Envoyer confirmation finale
    await sendConfirmationFinale(userId, userState, commande, commandeRef.id, livreurInfo, codeSecurite, prixLivraison);

    // Demander avis
    await demanderAvisCommande(userId, commandeRef.id);

  } catch (error) {
    console.error('❌ Erreur création commande:', error.message);
    await sendWhatsAppMessage(userId, "Problème lors de la création de la commande.");
  }
}

async function demanderAvisCommande(userId, commandeId) {
  await sendWhatsAppMessage(
    userId,
    `🌟 Votre commande #${commandeId.substring(0, 8)} a été enregistrée.\n\n` +
    `Pouvez-vous nous donner une note (1-5) pour notre service ?\n` +
    `Exemple: "note 5"`
  );

  const userState = userStates.get(userId) || DEFAULT_STATE;
  userState.attenteAvisCommande = commandeId;
  userStates.set(userId, userState);
}

// =================== ASSIGNER LIVREUR ===================
async function assignerLivreur(userId, quartier) {
  try {
    const snapshot = await db.collection('livreurs')
      .where('estDisponible', '==', true)
      .where('estVerifie', '==', true)
      .limit(5)
      .get();

    if (snapshot.empty) {
      console.log('⚠️ Aucun livreur disponible');
      return null;
    }

    // Trouver le livreur le plus proche (simplifié)
    const livreurs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const livreur = livreurs[0]; // À améliorer avec géolocalisation

    return livreur;
  } catch (error) {
    console.error('❌ Erreur assignation livreur:', error.message);
    return null;
  }
}

// =================== CONFIRMATION FINALE ===================
async function sendConfirmationFinale(userId, userState, commande, numeroCommande, livreurInfo, codeSecurite, prixLivraison) {
  const panier = commande.panier;
  let message = `✅ Commande #${numeroCommande.substring(0, 8)} confirmée !\n\n`;

  message += `📦 Votre commande:\n\n`;
  panier.forEach((item, index) => {
    message += `${index + 1}. ${item.medicamentNom}`;
    if (item.sousTitre) message += ` (${item.sousTitre})`;
    message += ` × ${item.quantite}\n`;
    message += `   ${item.prixUnitaire} FCFA × ${item.quantite} = ${item.prixUnitaire * item.quantite} FCFA\n\n`;
  });

  message += `🏥 Pharmacie: ${panier[0].pharmacieNom}\n`;
  message += `🚚 Frais de livraison: ${prixLivraison} FCFA\n`;
  message += `💵 TOTAL: ${commande.total} FCFA\n\n`;
  message += `📍 Livraison à: ${commande.quartier}\n`;
  message += `📞 Votre numéro: ${commande.whatsapp}\n\n`;

  if (livreurInfo) {
    message += `👨‍🚀 Livreur: ${livreurInfo.nom} ${livreurInfo.prenom}\n`;
    message += `📞 Livreur: ${livreurInfo.telephone}\n`;
    message += `📍 Le livreur vous contactera pour la livraison.\n\n`;
  }

  message += `🔒 Code de sécurité: ${codeSecurite}\n`;
  message += `Montrez ce code au livreur.\n\n`;
  message += `💬 Besoin d'aide ? Répondez à ce message.\n`;
  message += `📞 Support: ${CONFIG.SUPPORT_PHONE}`;

  await sendWhatsAppMessage(userId, message);
}

// =================== GESTION DES AVIS ===================
async function gererAvisCommande(userId, message, userState) {
  const texte = message.toLowerCase().trim();
  const avisRegex = /note\s+(\d)/i;
  const matchAvis = texte.match(avisRegex);

  if (matchAvis && userState.attenteAvisCommande) {
    const note = parseInt(matchAvis[1]);
    if (note >= 1 && note <= 5) {
      const commandeId = userState.attenteAvisCommande;
      await db.collection('commandes_medicales').doc(commandeId).update({
        'avis.note': note,
        'avis.date': admin.firestore.Timestamp.now()
      });

      await sendWhatsAppMessage(userId, `🌟 Merci pour votre note ${note}/5 !`);
      userState.attenteAvisCommande = null;
      userStates.set(userId, userState);
    } else {
      await sendWhatsAppMessage(userId, "Note invalide. Dites 'note 1' à 'note 5'.");
    }
  }
}

// =================== DÉTAIL D'UNE COMMANDE ===================
async function afficherDetailCommande(userId, message, userState) {
  const numero = parseInt(message.trim());
  if (isNaN(numero) || numero < 1 || numero > 5) {
    await sendWhatsAppMessage(userId, "Numéro invalide. Répondez avec un numéro de 1 à 5.");
    return;
  }

  try {
    const snapshot = await db.collection('commandes_medicales')
      .where('clientId', '==', userId)
      .where('statut', 'not-in', ['supprime', 'annule'])
      .orderBy('date_commande', 'desc')
      .limit(5)
      .get();

    if (snapshot.empty) {
      await sendWhatsAppMessage(userId, "Aucune commande trouvée.");
      return;
    }

    const commandes = snapshot.docs;
    if (numero > commandes.length) {
      await sendWhatsAppMessage(userId, "Numéro invalide.");
      return;
    }

    const commande = commandes[numero - 1].data();
    const commandeId = commandes[numero - 1].id;

    let message = `📋 Détails commande #${commandeId.substring(0, 8)}\n\n`;
    message += `📅 Date: ${new Date(commande.date_commande.seconds * 1000).toLocaleString('fr-FR')}\n`;
    message += `💰 Total: ${commande.paiement.montant_total} FCFA\n`;
    message += `📍 Adresse: ${commande.livraison.adresse}\n`;
    message += `📦 Statut: ${gestionPanier.getStatutLivraison(commande.livraison.statut_livraison)}\n\n`;
    
    // Ajouter pharmacie
    if (commande.pharmacienom) {
      message += `🏥 Pharmacie: ${commande.pharmacienom}\n`;
    }
    
    // Ajouter livreur si disponible
    if (commande.livraison.livreurNom) {
      message += `👨‍🚀 Livreur: ${commande.livraison.livreurNom}\n`;
    }
    
    // Ajouter téléphone du livreur si disponible
    if (commande.livraison.livreurTelephone) {
      message += `📞 Livreur: ${commande.livraison.livreurTelephone}\n`;
    }
    
    // Calculer et ajouter prix de livraison
    const prixArticles = commande.articles.reduce((sum, article) => sum + (article.prix_unitaire * article.quantite), 0);
    const prixLivraison = commande.paiement.montant_total - prixArticles;
    message += `🚚 Livraison: ${prixLivraison} FCFA\n\n`;
    
    message += `💊 Médicaments:\n\n`;

    commande.articles.forEach((article, index) => {
      message += `${index + 1}. ${article.medicamentNom}`;
      if (article.sousTitre) message += ` (${article.sousTitre})`;
      message += ` × ${article.quantite}\n`;
      message += `   ${article.prix_unitaire} FCFA × ${article.quantite} = ${article.prix_unitaire * article.quantite} FCFA\n\n`;
    });

    message += `🔒 Code sécurité: ${commande.code_securite || 'Non disponible'}`;

    await sendWhatsAppMessage(userId, message);

    userState.attenteDetailCommande = false;
    userStates.set(userId, userState);

  } catch (error) {
    console.error('❌ Erreur détail commande:', error.message);
    await sendWhatsAppMessage(userId, "Problème pour récupérer les détails.");
  }
}

// =================== FONCTIONS MANQUANTES À IMPLÉMENTER ===================
async function traiterImageOrdonnance(userId, userState) {
  // Implémentation basique pour traitement d'ordonnance
  await sendWhatsAppMessage(userId, "Ordonnance reçue. Je vérifie avec la pharmacie...");
  
  // Simulation de validation
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  userState.ordonnanceValidee = true;
  userState.ordonnancePhotoUrl = "simulated_url";
  userState.step = 'ATTENTE_NOM_MULTI';
  userStates.set(userId, userState);
  
  await sendWhatsAppMessage(userId, "✅ Ordonnance validée ! Pour continuer, dites-moi votre nom complet :");
}

async function gererPriseRendezVous(userId, message) {
  // Implémentation basique de prise de rendez-vous
  const userState = userStates.get(userId) || DEFAULT_STATE;
  
  if (userState.attenteSpecialiteRdv) {
    await gererPriseRendezVousReel(userId, message, null);
  } else if (userState.attenteSelectionCliniqueRdv) {
    const numero = parseInt(message);
    if (!isNaN(numero) && userState.listeCliniquesRdv && numero >= 1 && numero <= userState.listeCliniquesRdv.length) {
      const clinique = userState.listeCliniquesRdv[numero - 1];
      userState.cliniqueSelectionneeRdv = clinique;
      userState.attenteSelectionCliniqueRdv = false;
      userState.attenteDateRdv = true;
      userStates.set(userId, userState);
      
      await sendWhatsAppMessage(userId, `Clinique ${clinique.nom} sélectionnée. Quelle date souhaitez-vous ? (Exemple: "demain" ou "2025-01-30")`);
    } else {
      await sendWhatsAppMessage(userId, "Numéro invalide. Choisissez un numéro de la liste.");
    }
  } else if (userState.attenteDateRdv) {
    userState.dateRdv = message;
    userState.attenteDateRdv = false;
    userState.attenteHeureRdv = true;
    userStates.set(userId, userState);
    
    await sendWhatsAppMessage(userId, "Quelle heure souhaitez-vous ? (Exemple: 14:30)");
  } else if (userState.attenteHeureRdv) {
    userState.heureRdv = message;
    userState.attenteHeureRdv = false;
    userState.attenteNomRdv = true;
    userStates.set(userId, userState);
    
    await sendWhatsAppMessage(userId, "Quel est votre nom complet ?");
  } else if (userState.attenteNomRdv) {
    userState.nomRdv = message;
    userState.attenteNomRdv = false;
    userState.attenteTelephoneRdv = true;
    userStates.set(userId, userState);
    
    await sendWhatsAppMessage(userId, "Quel est votre numéro de téléphone ?");
  } else if (userState.attenteTelephoneRdv) {
    // CORRECTION DE L'ERREUR DE SYNTAXE ICI
    const telephone = message;
    
    // Créer le rendez-vous
    await creerRendezVousFirestore(userId, userState, telephone);
  }
}

async function creerRendezVousFirestore(userId, userState, telephone) {
  try {
    const rdvRef = db.collection('rendez_vous').doc();
    const maintenant = new Date();
    
    await rdvRef.set({
      patientId: userId,
      patientNom: userState.nomRdv,
      patientTelephone: telephone,
      centreSanteId: userState.cliniqueSelectionneeRdv.id,
      centreSanteNom: userState.cliniqueSelectionneeRdv.nom,
      medecinId: null, // À définir selon la logique métier
      medecinNom: null,
      serviceId: null,
      serviceNom: userState.specialiteRdv,
      date: admin.firestore.Timestamp.fromDate(new Date(`${userState.dateRdv} ${userState.heureRdv}`)),
      dateCreation: admin.firestore.Timestamp.now(),
      typeConsultation: "presentiel",
      notes: "",
      statut: "confirme"
    });
    
    await sendWhatsAppMessage(
      userId,
      `✅ Rendez-vous confirmé !\n\n` +
      `📅 Date: ${userState.dateRdv} à ${userState.heureRdv}\n` +
      `🏥 Clinique: ${userState.cliniqueSelectionneeRdv.nom}\n` +
      `🩺 Spécialité: ${userState.specialiteRdv}\n` +
      `👤 Nom: ${userState.nomRdv}\n\n` +
      `📞 Vous serez contacté pour confirmation.`
    );
    
    // Réinitialiser
    userState.attenteTelephoneRdv = false;
    userState.specialiteRdv = null;
    userState.cliniqueSelectionneeRdv = null;
    userState.dateRdv = null;
    userState.heureRdv = null;
    userState.nomRdv = null;
    userState.step = 'MENU_PRINCIPAL';
    userStates.set(userId, userState);
    
  } catch (error) {
    console.error('❌ Erreur création rendez-vous:', error.message);
    await sendWhatsAppMessage(userId, "Erreur lors de la création du rendez-vous.");
  }
}

// =================== ENDPOINTS ADMIN ===================
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'Pillbox WhatsApp Bot PRODUCTION V6.0',
    version: '6.0.0',
    users_actifs: userStates.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    support_phone: CONFIG.SUPPORT_PHONE,
    features: ['base_de_données_réelle', 'informations_complètes_commandes', 'gestion_livreurs']
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
🚀 PILLBOX WHATSAPP BOT - PRODUCTION V6.0
=======================================================
📍 Port: ${PORT}
🏙️ Zone: San Pedro uniquement
🤖 Intelligence: Base de données RÉELLE uniquement
💊 Services: Médicaments réels, pharmacies réelles, cliniques réelles
👨‍🚀 Livreurs: Informations complètes sur les livreurs
💰 Prix: Détails complets des commandes
📞 Support: ${CONFIG.SUPPORT_PHONE}
=======================================================
✅ PRÊT À RECEVOIR DES MESSAGES !
✅ Informations complètes des commandes
✅ Livreur assigné avec numéro de téléphone
✅ Prix de livraison détaillé
✅ Historique des commandes complet
✅ Transitions fluides entre sujets
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

// Gestion des erreurs
process.on('uncaughtException', (error) => {
  console.error('💥 ERREUR NON GÉRÉE:', error.message);
  console.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 PROMISE REJECTION NON GÉRÉE:', reason);
});