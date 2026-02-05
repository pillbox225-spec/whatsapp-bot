require('dotenv').config();
const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;

// Initialisation Express
const app = express();
app.use(express.json());

// Configuration pour Render.com
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

// Configuration Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  upload_preset: process.env.CLOUDINARY_UPLOAD_PRESET
});

// Initialisation Firebase
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
    }
    db = admin.firestore();
    FieldValue = admin.firestore.FieldValue;

    // Test de connexion à Firestore
    const testRef = db.collection('system_health').doc('connection_test');
    await testRef.set({
      timestamp: new Date().toISOString(),
      status: 'connected'
    });

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
  GROQ_MODEL: process.env.GROQ_MODEL || "mixtral-8x7b-32768",
  SUPPORT_PHONE: process.env.SUPPORT_PHONE,
  LIVRAISON_JOUR: parseInt(process.env.LIVRAISON_JOUR) || 400,
  LIVRAISON_NUIT: parseInt(process.env.LIVRAISON_NUIT) || 600,
  ZONE_SERVICE: process.env.ZONE_SERVICE || "San Pedro"
};

// =================== SYSTÈME DE LOGS OPTIMISÉ ===================
class Logger {
  static debug(...args) {
    console.debug('🔍', ...args);
  }
  
  static info(...args) {
    console.log('ℹ️', ...args);
  }
  
  static warn(...args) {
    console.warn('⚠️', ...args);
  }
  
  static error(...args) {
    console.error('❌', ...args);
  }
  
  static message(userId, direction, text) {
    const prefix = direction === 'in' ? '📩' : '📤';
    console.log(`${prefix} ${userId}: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
  }
  
  static webhook(data) {
    console.log('🌐 Webhook:', JSON.stringify(data, null, 2).substring(0, 300));
  }
}

// =================== GESTIONNAIRE IA INTELLIGENT ===================
class AssistantMedicalIA {
  constructor() {
    this.historiques = new Map();
    this.maxHistorique = 10;
  }

  ajouterAuHistorique(userId, role, message) {
    if (!this.historiques.has(userId)) {
      this.historiques.set(userId, []);
    }
    
    const historique = this.historiques.get(userId);
    historique.push({
      role,
      message,
      timestamp: Date.now()
    });
    
    if (historique.length > this.maxHistorique) {
      this.historiques.set(userId, historique.slice(-this.maxHistorique));
    }
  }

  async comprendreEtRepondre(userId, message, userState) {
    try {
      // Récupérer les médicaments disponibles depuis Firebase
      const medicamentsDisponibles = await this.getMedicamentsDisponibles();
      const pharmaciesDisponibles = await this.getPharmaciesDisponibles();
      const cliniquesDisponibles = await this.getCliniquesDisponibles();
      
      // Construire l'historique de conversation
      const historique = this.historiques.get(userId) || [];
      const historiqueFormatte = historique.map(msg => `${msg.role}: ${msg.message}`).join('\n');
      
      // Informations sur l'état utilisateur
      const etatUtilisateur = userState ? `
## ÉTAT UTILISATEUR:
- Panier: ${userState.panier?.length || 0} médicament(s)
- En train de commander: ${userState.attenteCommande ? 'Oui' : 'Non'}
- En train de prendre RDV: ${userState.attenteSpecialiteRdv ? 'Oui' : 'Non'}
` : '';

      const prompt = `# ASSISTANT MÉDICAL MIA - URGENCES & PHARMACIE

## TON IDENTITÉ:
Tu es Mia, une assistante médicale IA créée par Yousself et Delphin, étudiants de l'Université Polytechnique de San Pedro. Tu travailles pour Pillbox, un service de livraison de médicaments et prise de rendez-vous médicaux à San Pedro, Côte d'Ivoire.

## TON RÔLE:
1. **Comprendre les symptômes** et suggérer des médicaments appropriés
2. **Corriger automatiquement** toutes les fautes d'orthographe
3. **Poser des questions pertinentes** pour affiner les recommandations
4. **Gérer les commandes** et les rendez-vous médicaux
5. **Donner des conseils médicaux** de base (sans remplacer un médecin)

## DONNÉES DISPONIBLES:

### MÉDICAMENTS EN STOCK:
${medicamentsDisponibles}

### PHARMACIES DISPONIBLES:
${pharmaciesDisponibles}

### CLINIQUES DISPONIBLES:
${cliniquesDisponibles}

## HISTORIQUE DE LA CONVERSATION:
${historiqueFormatte || "Premier message"}

${etatUtilisateur}

## MESSAGE DE L'UTILISATEUR:
"${message}"

## INSTRUCTIONS SPÉCIFIQUES:

### 1. COMPRÉHENSION MÉDICALE:
- Si l'utilisateur décrit des symptômes: identifier les médicaments appropriés
- Si l'utilisateur donne un nom de médicament: vérifier s'il est disponible
- **Corriger automatiquement TOUTES les fautes d'orthographe**
- Comprendre les formulations naturelles: "j'ai mal à la tête" → paracétamol

### 2. GESTION DES ORDONNANCES:
- Si un médicament nécessite une ordonnance: EXPLICITEMENT dire: "Ce médicament nécessite une ordonnance. Pour commander, envoyez une photo de votre ordonnance à notre support client au ${CONFIG.SUPPORT_PHONE}"
- Ne pas permettre la commande sans mentionner cette exigence

### 3. RECHERCHE INTELLIGENTE:
- Si le médicament exact n'existe pas: proposer des alternatives
- Si plusieurs options: présenter un tableau comparatif
- Toujours vérifier la disponibilité dans les données ci-dessus

### 4. PRIX ET LOGISTIQUE:
- Zone de service: ${CONFIG.ZONE_SERVICE} uniquement
- Frais de livraison: ${CONFIG.LIVRAISON_JOUR} FCFA (jour), ${CONFIG.LIVRAISON_NUIT} FCFA (nuit)
- Support client: ${CONFIG.SUPPORT_PHONE}

### 5. STRUCTURE DE RÉPONSE:
- Toujours commencer par une réponse naturelle et empathique
- Ensuite, proposer des options concrètes
- Terminer par une question pour avancer la conversation

### 6. ACTIONS DISPONIBLES:
Pour les actions spécifiques, utiliser ce format:
[ACTION:nom_action|parametres]

Actions disponibles:
- RECHERCHER_MEDICAMENT:nom_du_medicament
- AFFICHER_PHARMACIES_GARDE
- AFFICHER_CLINIQUES
- PRENDRE_RDV:specialite
- AJOUTER_PANIER:medicament_id:quantite
- VOIR_PANIER
- FINALISER_COMMANDE
- HISTORIQUE_COMMANDES
- VERIFIER_OUVERTURE:nom_pharmacie

## EXEMPLES DE RÉPONSES:

**Utilisateur:** "je touss beaucoup et jai de la fievr"
**Réponse:** "Je comprends que vous avez de la toux et de la fièvre. Ces symptômes pourraient indiquer une infection. Je vous recommande:
1. **Paracétamol 500mg** pour la fièvre - 1500 FCFA
2. **Sirop contre la toux** - 3200 FCFA

📌 Disponible à la pharmacie Cosmos
🚚 Livraison: ${CONFIG.LIVRAISON_JOUR} FCFA

⚠️ Si les symptômes persistent plus de 3 jours, consultez un médecin.

Voulez-vous commander un de ces médicaments ?"

**Utilisateur:** "metridonazole 500"
**Réponse:** "Je pense que vous voulez dire **Métronidazole 500mg**. C'est un antibiotique utilisé pour les infections.
📌 Disponible: Métronidazole 500mg - 25 comprimés - 2300 FCFA
📄 **NÉCESSITE ORDONNANCE** - Pour commander, envoyez une photo de votre ordonnance à notre support client au ${CONFIG.SUPPORT_PHONE}

[ACTION:RECHERCHER_MEDICAMENT|metronidazole]"

**Utilisateur:** "pharmacie ouverte maintenant"
**Réponse:** "Je vérifie les pharmacies de garde ouvertes actuellement...
🏥 **Pharmacies de garde ouvertes:**
1. Pharmacie Cosmos - 24h/24 - 📞 01 23 45 67 89
2. Pharmacie Madou - 24h/24 - 📞 01 98 76 54 32

[ACTION:AFFICHER_PHARMACIES_GARDE]"

**Utilisateur:** "je veux prendre rendez-vous chez le dermatologue"
**Réponse:** "Je recherche des dermatologues disponibles à ${CONFIG.ZONE_SERVICE}...
🏥 **Cliniques avec dermatologie:**
1. Clinique Pastora - 📞 07 07 07 07 07
2. Centre Médical du Lac - 📞 07 08 08 08 08

Pour prendre rendez-vous, dites "Je choisis la clinique 1" ou "Je choisis la clinique 2"

[ACTION:PRENDRE_RDV|dermatologie]"

**Utilisateur:** "quelle clinique pour cardiologie"
**Réponse:** "Je recherche des cardiologues disponibles...
❤️ **Cliniques avec cardiologie:**
1. Clinique du Cœur - Spécialisée en cardiologie - 📞 07 01 01 01 01
2. Polyclinique de San Pedro - Service cardiologie - 📞 07 02 02 02 02

[ACTION:AFFICHER_CLINIQUES]"

## MAINTENANT, RÉPONDS À L'UTILISATEUR:
1. Corrige automatiquement les fautes d'orthographe dans ta réponse
2. Sois empathique et professionnelle
3. Utilise les données disponibles pour des recommandations précises
4. Propose toujours l'étape suivante
5. Pour les médicaments avec ordonnance, MENTIONNE EXPLICITEMENT le support client`;

      // Appel à GROQ
      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: CONFIG.GROQ_MODEL,
          messages: [
            {
              role: "system",
              content: "Tu es Mia, une assistante médicale IA extrêmement compétente. Tu corriges automatiquement toutes les fautes d'orthographe. Tu es empathique, précise et utile. Tu travailles exclusivement pour la zone de San Pedro, Côte d'Ivoire."
            },
            { role: "user", content: prompt }
          ],
          temperature: 0.3,
          max_tokens: 1500,
          stream: false
        },
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      const reponseIA = response.data.choices[0].message.content;
      
      // Ajouter à l'historique
      this.ajouterAuHistorique(userId, 'user', message);
      this.ajouterAuHistorique(userId, 'assistant', reponseIA);
      
      return {
        reponse: reponseIA,
        actions: this.extraireActions(reponseIA)
      };

    } catch (error) {
      Logger.error('Erreur IA médicale:', error.message);
      
      // Réponse de secours intelligente
      const reponseSecours = `Je suis désolée, je rencontre un problème technique. 😔

En attendant, voici ce que je peux vous proposer:
• Pour les médicaments: Contactez directement notre support au ${CONFIG.SUPPORT_PHONE}
• Pour les pharmacies de garde: Pharmacie Cosmos (24h/24) - 📞 01 23 45 67 89
• Pour les urgences: Hôpital de San Pedro - 📞 07 07 07 07 07

Je reviens dès que possible !`;

      return {
        reponse: reponseSecours,
        actions: []
      };
    }
  }

  async getMedicamentsDisponibles() {
    try {
      const snapshot = await db.collection('medicaments')
        .where('stock', '>', 0)
        .limit(50)
        .get();
      
      if (snapshot.empty) {
        return "Aucun médicament en stock pour le moment.";
      }
      
      let liste = "Nom | Prix | Stock | Ordonnance | Pharmacie\n";
      liste += "--- | --- | --- | --- | ---\n";
      
      const medicaments = [];
      
      for (const doc of snapshot.docs) {
        const medicament = doc.data();
        const pharmacieDoc = await db.collection('pharmacies').doc(medicament.pharmacieId).get();
        const pharmacieNom = pharmacieDoc.exists ? pharmacieDoc.data().nom : 'Inconnue';
        
        medicaments.push({
          id: doc.id,
          nom: medicament.nom || 'Sans nom',
          prix: medicament.prix || 0,
          stock: medicament.stock || 0,
          ordonnance: medicament.necessiteOrdonnance ? 'OUI' : 'NON',
          pharmacie: pharmacieNom,
          sousTitre: medicament.sousTitre || '',
          dosage: medicament.dosage || '',
          forme: medicament.forme || ''
        });
      }
      
      // Limiter à 20 médicaments pour ne pas surcharger le prompt
      medicaments.slice(0, 20).forEach(med => {
        liste += `${med.nom} ${med.sousTitre} ${med.dosage}${med.forme ? ' ' + med.forme : ''} | ${med.prix} FCFA | ${med.stock} | ${med.ordonnance} | ${med.pharmacie}\n`;
      });
      
      if (medicaments.length > 20) {
        liste += `\n... et ${medicaments.length - 20} autres médicaments disponibles.`;
      }
      
      return liste;
    } catch (error) {
      Logger.error('Erreur récupération médicaments:', error.message);
      return "Base de données médicaments temporairement indisponible.";
    }
  }

  async getPharmaciesDisponibles() {
    try {
      const snapshot = await db.collection('pharmacies')
        .where('estOuvert', '==', true)
        .limit(20)
        .get();
      
      if (snapshot.empty) {
        return "Aucune pharmacie ouverte pour le moment.";
      }
      
      let liste = "Nom | Adresse | Téléphone | Garde | Horaires\n";
      liste += "--- | --- | --- | --- | ---\n";
      
      snapshot.docs.slice(0, 10).forEach(doc => {
        const pharmacie = doc.data();
        liste += `${pharmacie.nom || 'Pharmacie'} | ${pharmacie.adresse || CONFIG.ZONE_SERVICE} | ${pharmacie.telephone || 'Non disponible'} | ${pharmacie.estDeGarde ? '✅' : '❌'} | ${pharmacie.horaires || 'Non spécifié'}\n`;
      });
      
      return liste;
    } catch (error) {
      Logger.error('Erreur récupération pharmacies:', error.message);
      return "Base de données pharmacies temporairement indisponible.";
    }
  }

  async getCliniquesDisponibles() {
    try {
      const snapshot = await db.collection('centres_sante')
        .where('estVerifie', '==', true)
        .limit(20)
        .get();
      
      if (snapshot.empty) {
        return "Aucune clinique disponible pour le moment.";
      }
      
      let liste = "Nom | Adresse | Téléphone | Spécialités\n";
      liste += "--- | --- | --- | ---\n";
      
      snapshot.docs.slice(0, 10).forEach(doc => {
        const clinique = doc.data();
        const specialites = clinique.specialites && Array.isArray(clinique.specialites) 
          ? clinique.specialites.slice(0, 3).join(', ')
          : 'Non spécifié';
        
        liste += `${clinique.nom || 'Clinique'} | ${clinique.adresse || CONFIG.ZONE_SERVICE} | ${clinique.telephone || 'Non disponible'} | ${specialites}\n`;
      });
      
      return liste;
    } catch (error) {
      Logger.error('Erreur récupération cliniques:', error.message);
      return "Base de données cliniques temporairement indisponible.";
    }
  }

  extraireActions(reponseIA) {
    const actions = [];
    const regex = /\[ACTION:([^\|]+)\|?([^\]]*)\]/g;
    let match;
    
    while ((match = regex.exec(reponseIA)) !== null) {
      actions.push({
        type: match[1].trim(),
        parametres: match[2] ? match[2].trim() : null
      });
    }
    
    return actions;
  }

  nettoyerHistorique(userId) {
    this.historiques.delete(userId);
  }
}

// =================== GESTION PANIER INTELLIGENT ===================
class GestionPanierIntelligent {
  async ajouterAuPanier(userId, medicamentInfo, quantite = 1, userState) {
    if (!userState.panier) {
      userState.panier = [];
    }

    const indexExistant = userState.panier.findIndex(
      item => item.medicamentId === medicamentInfo.id
    );

    if (indexExistant >= 0) {
      userState.panier[indexExistant].quantite += quantite;
    } else {
      userState.panier.push({
        medicamentId: medicamentInfo.id,
        medicamentNom: medicamentInfo.nom,
        sousTitre: medicamentInfo.sousTitre || '',
        pharmacieId: medicamentInfo.pharmacieId,
        pharmacieNom: medicamentInfo.pharmacieNom,
        quantite: quantite,
        prixUnitaire: medicamentInfo.prix || 0,
        necessiteOrdonnance: medicamentInfo.necessiteOrdonnance || false,
        dosage: medicamentInfo.dosage,
        forme: medicamentInfo.forme
      });
    }

    return userState;
  }

  async verifierOrdonnanceRequise(userId, medicamentId) {
    try {
      const medicamentDoc = await db.collection('medicaments').doc(medicamentId).get();
      if (medicamentDoc.exists) {
        const medicament = medicamentDoc.data();
        return medicament.necessiteOrdonnance || false;
      }
      return false;
    } catch (error) {
      Logger.error('Erreur vérification ordonnance:', error.message);
      return false;
    }
  }

  async demanderOrdonnance(userId, medicamentNom) {
    const message = `📄 **ORDONNANCE REQUISE**

Le médicament "${medicamentNom}" nécessite une ordonnance médicale.

Pour commander ce médicament:
1. Prenez une photo claire de votre ordonnance
2. Envoyez-la à notre support client: ${CONFIG.SUPPORT_PHONE}
3. Notre équipe vérifiera votre ordonnance
4. Nous vous confirmerons la commande

⚠️ Sans ordonnance valide, nous ne pouvons pas fournir ce médicament.

Avez-vous d'autres besoins médicaux ?`;

    await sendWhatsAppMessage(userId, message);
  }

  async finaliserCommande(userId, userState) {
    try {
      const panier = userState.panier || [];
      
      if (panier.length === 0) {
        await sendWhatsAppMessage(userId, "Votre panier est vide. Dites-moi ce dont vous avez besoin !");
        return userState;
      }

      // Vérifier si des médicaments nécessitent une ordonnance
      const medicamentsOrdonnance = panier.filter(item => item.necessiteOrdonnance);
      
      if (medicamentsOrdonnance.length > 0) {
        let message = `⚠️ **ATTENTION - ORDONNANCE REQUISE**\n\n`;
        message += `Les médicaments suivants nécessitent une ordonnance:\n\n`;
        
        medicamentsOrdonnance.forEach(item => {
          message += `• ${item.medicamentNom} ${item.sousTitre || ''}\n`;
        });
        
        message += `\n📞 **Procédure:**\n`;
        message += `1. Envoyez une photo de votre ordonnance au ${CONFIG.SUPPORT_PHONE}\n`;
        message += `2. Notre équipe vérifiera l'ordonnance\n`;
        message += `3. Nous vous confirmerons la commande\n\n`;
        message += `Sans ordonnance valide, ces médicaments ne pourront pas être livrés.`;
        
        await sendWhatsAppMessage(userId, message);
        
        // Marquer l'état d'attente d'ordonnance
        userState.attentePhotoOrdonnance = true;
        userState.ordonnanceRequisePour = medicamentsOrdonnance.map(item => item.medicamentId);
        return userState;
      }

      // Si pas d'ordonnance requise, continuer normalement
      const fraisLivraison = getFraisLivraison();
      const sousTotal = panier.reduce((total, item) => total + (item.prixUnitaire * item.quantite), 0);
      const total = sousTotal + fraisLivraison;

      await sendWhatsAppMessage(
        userId,
        `✅ **PANIER PRÊT À COMMANDER**\n\n` +
        `${this.formaterPanier(panier)}\n` +
        `🏥 Pharmacie: ${panier[0].pharmacieNom}\n` +
        `🚚 Frais de livraison: ${fraisLivraison} FCFA\n` +
        `💵 **TOTAL: ${total} FCFA**\n\n` +
        `Pour finaliser, envoyez vos informations:\n\n` +
        `1. **Votre nom complet**\n` +
        `2. **Votre quartier**\n` +
        `3. **Votre numéro WhatsApp**\n` +
        `4. **Indications pour la livraison**\n\n` +
        `Commencez par votre nom:`
      );

      userState.commandeEnCours = {
        panier: panier,
        sousTotal: sousTotal,
        fraisLivraison: fraisLivraison,
        total: total,
        etape: 'ATTENTE_NOM'
      };

      userState.step = 'ATTENTE_NOM';
      return userState;

    } catch (error) {
      Logger.error('Erreur finalisation commande:', error.message);
      await sendWhatsAppMessage(userId, "Désolé, problème lors de la préparation de votre commande. Réessayez ou contactez le support.");
      return userState;
    }
  }

  formaterPanier(panier) {
    let message = '';
    panier.forEach((item, index) => {
      message += `${index + 1}. **${item.medicamentNom}**`;
      if (item.sousTitre) message += ` (${item.sousTitre})`;
      if (item.dosage || item.forme) message += ` - ${item.dosage || ''} ${item.forme || ''}`;
      message += `\n   × ${item.quantite} = ${item.prixUnitaire * item.quantite} FCFA\n`;
      if (item.necessiteOrdonnance) message += `   📄 **Ordonnance requise**\n`;
      message += `\n`;
    });
    return message;
  }
}

// =================== ÉTAT UTILISATEUR ===================
const DEFAULT_STATE = {
  step: 'IDLE',
  panier: [],
  commandeEnCours: null,
  attenteCommande: false,
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
  attentePhotoOrdonnance: false,
  ordonnanceRequisePour: [],
  ordonnancePhotoUrl: null,
  attenteAvisCommande: null,
  attenteAvisRdv: null,
  derniereInteraction: Date.now()
};

const userStates = new Map();
const processingLocks = new Map();
const assistantIA = new AssistantMedicalIA();
const gestionPanier = new GestionPanierIntelligent();

// =================== FONCTIONS UTILITAIRES ===================
function getFraisLivraison() {
  const maintenant = new Date();
  const heure = maintenant.getHours();
  return (heure >= 0 && heure < 8) ? CONFIG.LIVRAISON_NUIT : CONFIG.LIVRAISON_JOUR;
}

async function sendWhatsAppMessage(to, text) {
  try {
    Logger.message(to, 'out', text);

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

    Logger.info(`Message envoyé (ID: ${response.data.messages?.[0]?.id})`);
    return response.data.messages?.[0]?.id;
  } catch (error) {
    Logger.error('Erreur envoi WhatsApp:', error.response?.data?.error?.message || error.message);
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
    Logger.error('Erreur marquage message comme lu:', error.message);
  }
}

// =================== GESTION DES ACTIONS IA ===================
async function executerActions(userId, actions, userState) {
  for (const action of actions) {
    try {
      switch (action.type) {
        case 'RECHERCHER_MEDICAMENT':
          await rechercherMedicament(userId, action.parametres, userState);
          break;
          
        case 'AFFICHER_PHARMACIES_GARDE':
          await afficherPharmaciesGarde(userId);
          break;
          
        case 'AFFICHER_CLINIQUES':
          await afficherCliniques(userId);
          break;
          
        case 'PRENDRE_RDV':
          await initierPriseRendezVous(userId, action.parametres, userState);
          break;
          
        case 'AJOUTER_PANIER':
          if (action.parametres) {
            const [medicamentId, quantite] = action.parametres.split(':');
            await ajouterMedicamentPanier(userId, medicamentId, parseInt(quantite || 1), userState);
          }
          break;
          
        case 'VOIR_PANIER':
          await afficherPanier(userId, userState);
          break;
          
        case 'FINALISER_COMMANDE':
          await gestionPanier.finaliserCommande(userId, userState);
          break;
          
        case 'HISTORIQUE_COMMANDES':
          await afficherHistoriqueCommandes(userId);
          break;
          
        case 'VERIFIER_OUVERTURE':
          await verifierOuverturePharmacie(userId, action.parametres);
          break;
      }
    } catch (error) {
      Logger.error(`Erreur exécution action ${action.type}:`, error.message);
    }
  }
}

async function rechercherMedicament(userId, termeRecherche, userState) {
  try {
    const snapshot = await db.collection('medicaments')
      .where('stock', '>', 0)
      .limit(20)
      .get();
    
    if (snapshot.empty) {
      await sendWhatsAppMessage(userId, "Aucun médicament trouvé pour le moment.");
      return;
    }
    
    const medicamentsTrouves = [];
    const terme = termeRecherche.toLowerCase();
    
    for (const doc of snapshot.docs) {
      const medicament = { id: doc.id, ...doc.data() };
      const nomMed = (medicament.nom || '').toLowerCase();
      const sousTitre = (medicament.sousTitre || '').toLowerCase();
      
      if (nomMed.includes(terme) || sousTitre.includes(terme)) {
        const pharmacieDoc = await db.collection('pharmacies').doc(medicament.pharmacieId).get();
        const pharmacieNom = pharmacieDoc.exists ? pharmacieDoc.data().nom : 'Pharmacie';
        
        medicamentsTrouves.push({
          ...medicament,
          pharmacieNom: pharmacieNom
        });
      }
    }
    
    if (medicamentsTrouves.length === 0) {
      await sendWhatsAppMessage(userId, `Aucun médicament correspondant à "${termeRecherche}" trouvé en stock.`);
      return;
    }
    
    // Sauvegarder les résultats pour commande ultérieure
    userState.resultatsRecherche = medicamentsTrouves;
    userState.attenteCommande = true;
    userStates.set(userId, userState);
    
  } catch (error) {
    Logger.error('Erreur recherche médicament:', error.message);
    await sendWhatsAppMessage(userId, "Problème lors de la recherche. Réessayez plus tard.");
  }
}

async function ajouterMedicamentPanier(userId, medicamentId, quantite, userState) {
  try {
    const medicamentDoc = await db.collection('medicaments').doc(medicamentId).get();
    
    if (!medicamentDoc.exists) {
      await sendWhatsAppMessage(userId, "Ce médicament n'est plus disponible.");
      return;
    }
    
    const medicament = medicamentDoc.data();
    const pharmacieDoc = await db.collection('pharmacies').doc(medicament.pharmacieId).get();
    const pharmacieNom = pharmacieDoc.exists ? pharmacieDoc.data().nom : 'Pharmacie';
    
    // Vérifier si ordonnance requise
    if (medicament.necessiteOrdonnance) {
      await sendWhatsAppMessage(userId, `📄 **ORDONNANCE REQUISE**\n\nLe médicament "${medicament.nom}" nécessite une ordonnance.\n\nPour commander, envoyez une photo de votre ordonnance au ${CONFIG.SUPPORT_PHONE}`);
      
      userState.attentePhotoOrdonnance = true;
      userState.dernierMedicamentOrdonnance = {
        id: medicamentId,
        nom: medicament.nom,
        quantite: quantite
      };
      userStates.set(userId, userState);
      return;
    }
    
    // Vérifier stock
    if (medicament.stock < quantite) {
      await sendWhatsAppMessage(userId, `Stock insuffisant. Il reste ${medicament.stock} disponible(s).`);
      return;
    }
    
    // Ajouter au panier
    const medicamentInfo = {
      id: medicamentId,
      nom: medicament.nom,
      sousTitre: medicament.sousTitre || '',
      pharmacieId: medicament.pharmacieId,
      pharmacieNom: pharmacieNom,
      prix: medicament.prix || 0,
      necessiteOrdonnance: medicament.necessiteOrdonnance || false,
      dosage: medicament.dosage || '',
      forme: medicament.forme || ''
    };
    
    await gestionPanier.ajouterAuPanier(userId, medicamentInfo, quantite, userState);
    
    await sendWhatsAppMessage(userId, `✅ **Ajouté au panier**\n\n${medicament.nom} × ${quantite}\n\nQue souhaitez-vous faire ensuite ?`);
    
    userStates.set(userId, userState);
    
  } catch (error) {
    Logger.error('Erreur ajout panier:', error.message);
    await sendWhatsAppMessage(userId, "Problème lors de l'ajout au panier.");
  }
}

async function afficherPanier(userId, userState) {
  const panier = userState.panier || [];
  
  if (panier.length === 0) {
    await sendWhatsAppMessage(userId, "🛒 Votre panier est vide.\n\nDites-moi ce dont vous avez besoin !");
    return;
  }
  
  const fraisLivraison = getFraisLivraison();
  const sousTotal = panier.reduce((total, item) => total + (item.prixUnitaire * item.quantite), 0);
  const total = sousTotal + fraisLivraison;
  
  let message = `🛒 **VOTRE PANIER** (${panier.length} médicament(s))\n\n`;
  message += gestionPanier.formaterPanier(panier);
  message += `\n💰 Sous-total: ${sousTotal} FCFA\n`;
  message += `🚚 Livraison: ${fraisLivraison} FCFA\n`;
  message += `💵 **TOTAL: ${total} FCFA**\n\n`;
  message += `Que souhaitez-vous faire ?\n`;
  message += `• "Continuer" pour ajouter d'autres médicaments\n`;
  message += `• "Terminer" pour finaliser la commande\n`;
  message += `• "Vider" pour vider le panier`;
  
  await sendWhatsAppMessage(userId, message);
}

async function afficherPharmaciesGarde(userId) {
  try {
    const snapshot = await db.collection('pharmacies')
      .where('estDeGarde', '==', true)
      .where('estOuvert', '==', true)
      .limit(10)
      .get();
    
    if (snapshot.empty) {
      await sendWhatsAppMessage(userId, "Aucune pharmacie de garde trouvée pour le moment.");
      return;
    }
    
    const maintenant = new Date();
    const heure = maintenant.getHours();
    const estNuit = heure >= 22 || heure < 6;
    
    let message = `🏥 **PHARMACIES DE GARDE** - ${CONFIG.ZONE_SERVICE}\n`;
    if (estNuit) message += "🌙 Service de nuit\n\n";
    
    snapshot.docs.forEach((doc, index) => {
      const pharmacie = doc.data();
      message += `${index + 1}. **${pharmacie.nom}**\n`;
      message += `   📍 ${pharmacie.adresse || CONFIG.ZONE_SERVICE}\n`;
      message += `   📞 ${pharmacie.telephone || 'Non disponible'}\n`;
      message += `   ⏰ ${pharmacie.horaires || '24h/24'}\n`;
      message += `   ${pharmacie.estDeGarde ? '🚨 Pharmacie de garde' : ''}\n\n`;
    });
    
    message += `💊 **Commande en ligne disponible**\n`;
    message += `Dites-moi ce dont vous avez besoin !`;
    
    await sendWhatsAppMessage(userId, message);
    
  } catch (error) {
    Logger.error('Erreur pharmacies de garde:', error.message);
    await sendWhatsAppMessage(userId, "Problème pour récupérer les pharmacies de garde.");
  }
}

async function afficherCliniques(userId) {
  try {
    const snapshot = await db.collection('centres_sante')
      .where('estVerifie', '==', true)
      .limit(15)
      .get();
    
    if (snapshot.empty) {
      await sendWhatsAppMessage(userId, "Aucune clinique trouvée pour le moment.");
      return;
    }
    
    let message = `🏥 **CLINIQUES & CENTRES DE SANTÉ** - ${CONFIG.ZONE_SERVICE}\n\n`;
    
    snapshot.docs.forEach((doc, index) => {
      const clinique = doc.data();
      message += `${index + 1}. **${clinique.nom}**\n`;
      message += `   📍 ${clinique.adresse || CONFIG.ZONE_SERVICE}\n`;
      if (clinique.telephone) message += `   📞 ${clinique.telephone}\n`;
      
      if (clinique.specialites && Array.isArray(clinique.specialites)) {
        const specialites = clinique.specialites.filter(s => s && typeof s === 'string');
        if (specialites.length > 0) {
          message += `   🩺 ${specialites.slice(0, 3).join(', ')}\n`;
        }
      }
      
      if (clinique.horaires) {
        message += `   ⏰ ${clinique.horaires}\n`;
      }
      
      message += `\n`;
    });
    
    message += `📅 **Prendre rendez-vous**\n`;
    message += `Dites "Je veux prendre rendez-vous en [spécialité]"`;
    
    await sendWhatsAppMessage(userId, message);
    
  } catch (error) {
    Logger.error('Erreur affichage cliniques:', error.message);
    await sendWhatsAppMessage(userId, "Problème pour récupérer les cliniques.");
  }
}

async function initierPriseRendezVous(userId, specialite, userState) {
  userState.attenteSpecialiteRdv = true;
  userState.specialiteRdv = specialite;
  userStates.set(userId, userState);
  
  await sendWhatsAppMessage(userId, `Je recherche des ${specialite} disponibles...`);
  
  // La recherche sera faite dans le prochain message
}

async function verifierOuverturePharmacie(userId, nomPharmacie) {
  try {
    const snapshot = await db.collection('pharmacies')
      .limit(20)
      .get();
    
    let pharmacieTrouvee = null;
    
    for (const doc of snapshot.docs) {
      const pharmacie = { id: doc.id, ...doc.data() };
      const nom = (pharmacie.nom || '').toLowerCase();
      
      if (nom.includes(nomPharmacie.toLowerCase()) || nomPharmacie.toLowerCase().includes(nom.split(' ')[0])) {
        pharmacieTrouvee = pharmacie;
        break;
      }
    }
    
    if (!pharmacieTrouvee) {
      await sendWhatsAppMessage(userId, `Je ne trouve pas la pharmacie "${nomPharmacie}".`);
      return;
    }
    
    const maintenant = new Date();
    const heure = maintenant.getHours();
    
    let message = `🏥 **${pharmacieTrouvee.nom.toUpperCase()}**\n\n`;
    message += `📍 ${pharmacieTrouvee.adresse || 'Adresse non disponible'}\n`;
    message += `📞 ${pharmacieTrouvee.telephone || 'Téléphone non disponible'}\n\n`;
    
    if (pharmacieTrouvee.estOuvert) {
      message += `✅ **OUVERTE ACTUELLEMENT**\n`;
    } else {
      message += `❌ **FERMÉE ACTUELLEMENT**\n`;
    }
    
    if (pharmacieTrouvee.estDeGarde) {
      message += `🚨 **PHARMACIE DE GARDE**\n`;
      if (heure >= 22 || heure < 6) {
        message += `🌙 **Service de nuit**\n`;
      }
    }
    
    if (pharmacieTrouvee.horaires) {
      message += `\n⏰ **Horaires:**\n${pharmacieTrouvee.horaires}\n`;
    }
    
    if (pharmacieTrouvee.estOuvert) {
      message += `\n💊 **Commande en ligne disponible**\n`;
      message += `Dites-moi ce dont vous avez besoin !`;
    }
    
    await sendWhatsAppMessage(userId, message);
    
  } catch (error) {
    Logger.error('Erreur vérification ouverture:', error.message);
    await sendWhatsAppMessage(userId, "Problème pour vérifier l'ouverture de la pharmacie.");
  }
}

async function afficherHistoriqueCommandes(userId) {
  try {
    const snapshot = await db.collection('commandes_medicales')
      .where('clientId', '==', userId)
      .orderBy('date_commande', 'desc')
      .limit(5)
      .get();
    
    if (snapshot.empty) {
      await sendWhatsAppMessage(userId, "📭 Vous n'avez pas encore passé de commande.");
      return;
    }
    
    let message = `📋 **VOS DERNIÈRES COMMANDES**\n\n`;
    
    snapshot.docs.forEach((doc, index) => {
      const commande = doc.data();
      message += `${index + 1}. **Commande #${doc.id.substring(0, 8)}**\n`;
      message += `   📅 ${new Date(commande.date_commande.seconds * 1000).toLocaleDateString('fr-FR')}\n`;
      message += `   💰 ${commande.paiement?.montant_total || 0} FCFA\n`;
      message += `   📍 ${commande.livraison?.adresse || 'Non spécifié'}\n`;
      message += `   📦 ${commande.statut || 'En attente'}\n\n`;
    });
    
    await sendWhatsAppMessage(userId, message);
    
  } catch (error) {
    Logger.error('Erreur historique commandes:', error.message);
    await sendWhatsAppMessage(userId, "Problème pour récupérer votre historique.");
  }
}

// =================== GESTION RENDEZ-VOUS ===================
async function gererPriseRendezVous(userId, message, userState) {
  const texte = message.trim();
  
  if (userState.attenteSpecialiteRdv) {
    const specialite = userState.specialiteRdv || texte.toLowerCase();
    
    try {
      const snapshot = await db.collection('centres_sante')
        .where('estVerifie', '==', true)
        .where('specialites', 'array-contains', specialite)
        .limit(5)
        .get();
      
      if (snapshot.empty) {
        await sendWhatsAppMessage(userId, `Aucune clinique avec ${specialite} trouvée.\n\nEssayez une autre spécialité ou contactez le ${CONFIG.SUPPORT_PHONE}`);
        userState.attenteSpecialiteRdv = false;
        userStates.set(userId, userState);
        return;
      }
      
      let messageCliniques = `🏥 **CLINIQUES - ${specialite.toUpperCase()}**\n\n`;
      const listeCliniques = [];
      
      snapshot.docs.forEach((doc, index) => {
        const clinique = { id: doc.id, ...doc.data() };
        listeCliniques.push(clinique);
        
        messageCliniques += `${index + 1}. **${clinique.nom}**\n`;
        messageCliniques += `   📍 ${clinique.adresse || CONFIG.ZONE_SERVICE}\n`;
        if (clinique.telephone) messageCliniques += `   📞 ${clinique.telephone}\n`;
        messageCliniques += `\n`;
      });
      
      messageCliniques += `Répondez avec le numéro de la clinique (ex: "1")`;
      
      await sendWhatsAppMessage(userId, messageCliniques);
      
      userState.listeCliniquesRdv = listeCliniques;
      userState.attenteSpecialiteRdv = false;
      userState.attenteSelectionCliniqueRdv = true;
      userStates.set(userId, userState);
      
    } catch (error) {
      Logger.error('Erreur recherche cliniques RDV:', error.message);
      await sendWhatsAppMessage(userId, "Problème lors de la recherche. Réessayez.");
    }
    
  } else if (userState.attenteSelectionCliniqueRdv) {
    const numero = parseInt(texte);
    
    if (isNaN(numero) || numero < 1 || numero > userState.listeCliniquesRdv.length) {
      await sendWhatsAppMessage(userId, `Numéro invalide. Choisissez entre 1 et ${userState.listeCliniquesRdv.length}.`);
      return;
    }
    
    const clinique = userState.listeCliniquesRdv[numero - 1];
    userState.cliniqueSelectionneeRdv = clinique;
    userState.attenteSelectionCliniqueRdv = false;
    userState.attenteDateRdv = true;
    
    await sendWhatsAppMessage(userId, `✅ **${clinique.nom}** sélectionnée\n\nQuelle date souhaitez-vous ?\nEx: "demain", "2026-02-10"`);
    userStates.set(userId, userState);
    
  } else if (userState.attenteDateRdv) {
    userState.dateRdv = texte;
    userState.attenteDateRdv = false;
    userState.attenteHeureRdv = true;
    
    await sendWhatsAppMessage(userId, "Quelle heure ?\nEx: "14:30", "9:00"");
    userStates.set(userId, userState);
    
  } else if (userState.attenteHeureRdv) {
    userState.heureRdv = texte;
    userState.attenteHeureRdv = false;
    userState.attenteNomRdv = true;
    
    await sendWhatsAppMessage(userId, "Quel est votre nom complet ?");
    userStates.set(userId, userState);
    
  } else if (userState.attenteNomRdv) {
    userState.nomRdv = texte;
    userState.attenteNomRdv = false;
    userState.attenteTelephoneRdv = true;
    
    await sendWhatsAppMessage(userId, "Quel est votre numéro de téléphone ?");
    userStates.set(userId, userState);
    
  } else if (userState.attenteTelephoneRdv) {
    await creerRendezVousFirestore(userId, userState, texte);
  }
}

async function creerRendezVousFirestore(userId, userState, telephone) {
  try {
    const rdvRef = db.collection('rendez_vous').doc();
    const clinique = userState.cliniqueSelectionneeRdv;
    
    // Créer la date
    let dateComplete;
    try {
      if (userState.dateRdv === 'demain') {
        const demain = new Date();
        demain.setDate(demain.getDate() + 1);
        dateComplete = new Date(`${demain.toISOString().split('T')[0]}T${userState.heureRdv}:00`);
      } else {
        dateComplete = new Date(`${userState.dateRdv}T${userState.heureRdv}:00`);
      }
    } catch (error) {
      dateComplete = new Date();
      dateComplete.setHours(dateComplete.getHours() + 24); // Demain à la même heure
    }
    
    await rdvRef.set({
      centreSanteId: clinique.id,
      date: admin.firestore.Timestamp.fromDate(dateComplete),
      dateCreation: admin.firestore.Timestamp.now(),
      id: rdvRef.id,
      medecinId: null,
      medecinNom: null,
      notes: '',
      patientId: userId,
      patientNom: userState.nomRdv,
      patientTelephone: telephone,
      serviceId: null,
      serviceNom: userState.specialiteRdv,
      statut: 'confirme',
      typeConsultation: 'presentiel'
    });
    
    // Message de confirmation
    await sendWhatsAppMessage(
      userId,
      `✅ **RENDEZ-VOUS CONFIRMÉ !**\n\n` +
      `📅 **Date:** ${userState.dateRdv} à ${userState.heureRdv}\n` +
      `🏥 **Clinique:** ${clinique.nom}\n` +
      `🩺 **Spécialité:** ${userState.specialiteRdv}\n` +
      `👤 **Nom:** ${userState.nomRdv}\n` +
      `📞 **Téléphone:** ${telephone}\n\n` +
      `📋 **Informations:**\n` +
      `• Vous serez contacté pour confirmation\n` +
      `• Présentez-vous 15 minutes avant\n` +
      `• Apportez vos documents médicaux\n\n` +
      `📞 **Support:** ${CONFIG.SUPPORT_PHONE}`
    );
    
    // Notifier la clinique
    if (clinique.telephone) {
      await sendWhatsAppMessage(
        clinique.telephone,
        `📅 **NOUVEAU RENDEZ-VOUS**\n\n` +
        `👤 Patient: ${userState.nomRdv}\n` +
        `📞 Tél: ${telephone}\n` +
        `📅 Date: ${userState.dateRdv} à ${userState.heureRdv}\n` +
        `🩺 Spécialité: ${userState.specialiteRdv}\n` +
        `🏥 Clinique: ${clinique.nom}`
      );
    }
    
    // Notifier le support
    if (CONFIG.SUPPORT_PHONE) {
      await sendWhatsAppMessage(
        CONFIG.SUPPORT_PHONE,
        `📅 **NOUVEAU RDV #${rdvRef.id.substring(0, 8)}**\n\n` +
        `👤 ${userState.nomRdv}\n` +
        `📞 ${telephone}\n` +
        `📅 ${userState.dateRdv} à ${userState.heureRdv}\n` +
        `🩺 ${userState.specialiteRdv}\n` +
        `🏥 ${clinique.nom}`
      );
    }
    
    // Réinitialiser l'état
    userState.dernierRdvRef = rdvRef.id;
    userState.attenteTelephoneRdv = false;
    userState.step = 'IDLE';
    Object.keys(DEFAULT_STATE).forEach(key => {
      if (!['panier', 'dernierRdvRef'].includes(key)) {
        userState[key] = DEFAULT_STATE[key];
      }
    });
    userStates.set(userId, userState);
    
    // Demander avis
    setTimeout(async () => {
      await sendWhatsAppMessage(userId, `🌟 **Votre avis compte !**\n\nComment évaluez-vous la prise de rendez-vous ?\n\n"Excellent", "Bon", "Moyen", "À améliorer"`);
      userState.attenteAvisRdv = rdvRef.id;
      userStates.set(userId, userState);
    }, 5000);
    
  } catch (error) {
    Logger.error('Erreur création RDV:', error.message);
    await sendWhatsAppMessage(userId, "Problème lors de la création du rendez-vous. Contactez le support.");
  }
}

// =================== COLLECTE INFORMATIONS COMMANDE ===================
async function collecterInfosCommande(userId, message, userState) {
  const texte = message.trim();
  
  if (userState.step === 'ATTENTE_NOM') {
    userState.commandeEnCours.nom = texte;
    userState.step = 'ATTENTE_QUARTIER';
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "Quel est votre quartier ?");
    return;
  }
  
  if (userState.step === 'ATTENTE_QUARTIER') {
    userState.commandeEnCours.quartier = texte;
    userState.step = 'ATTENTE_WHATSAPP';
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "Quel est votre numéro WhatsApp ?");
    return;
  }
  
  if (userState.step === 'ATTENTE_WHATSAPP') {
    userState.commandeEnCours.whatsapp = texte;
    userState.step = 'ATTENTE_INDICATIONS';
    userStates.set(userId, userState);
    await sendWhatsAppMessage(userId, "Indications pour la livraison ?\n(ex: maison bleue, sonnez 2 fois)");
    return;
  }
  
  if (userState.step === 'ATTENTE_INDICATIONS') {
    userState.commandeEnCours.indications = texte;
    userStates.set(userId, userState);
    await confirmerCommande(userId, userState);
    return;
  }
}

async function confirmerCommande(userId, userState) {
  const commande = userState.commandeEnCours;
  const panier = commande.panier;
  
  let message = `✅ **CONFIRMATION DE COMMANDE**\n\n`;
  message += `**Nom:** ${commande.nom}\n`;
  message += `**Quartier:** ${commande.quartier}\n`;
  message += `**WhatsApp:** ${commande.whatsapp}\n`;
  message += `**Indications:** ${commande.indications || 'Aucune'}\n\n`;
  message += `📦 **VOTRE COMMANDE:**\n\n`;
  
  panier.forEach((item, index) => {
    message += `${index + 1}. ${item.medicamentNom}`;
    if (item.sousTitre) message += ` (${item.sousTitre})`;
    message += ` × ${item.quantite}\n`;
    message += `   ${item.prixUnitaire} FCFA × ${item.quantite} = ${item.prixUnitaire * item.quantite} FCFA\n\n`;
  });
  
  message += `🏥 **Pharmacie:** ${panier[0].pharmacieNom}\n`;
  message += `🚚 **Frais de livraison:** ${commande.fraisLivraison} FCFA\n`;
  message += `💵 **TOTAL: ${commande.total} FCFA**\n\n`;
  message += `**Confirmer la commande ?**\n`;
  message += `"Oui" pour confirmer\n`;
  message += `"Non" pour annuler`;
  
  await sendWhatsAppMessage(userId, message);
  
  userState.step = 'CONFIRMATION_COMMANDE';
  userStates.set(userId, userState);
}

async function traiterConfirmationCommande(userId, message, userState) {
  const texte = message.toLowerCase().trim();
  
  if (texte === 'oui') {
    await creerCommandeFirestore(userId, userState);
  } else if (texte === 'non') {
    userState.commandeEnCours = null;
    userState.step = 'IDLE';
    userStates.set(userId, userState);
    
    await sendWhatsAppMessage(userId, "Commande annulée. Dites-moi si vous avez besoin d'autre chose !");
  } else {
    await sendWhatsAppMessage(userId, "Répondez 'Oui' pour confirmer ou 'Non' pour annuler.");
  }
}

async function creerCommandeFirestore(userId, userState) {
  try {
    const commande = userState.commandeEnCours;
    const panier = commande.panier;
    
    const commandeRef = db.collection('commandes_medicales').doc();
    const codeSecurite = Math.floor(100000 + Math.random() * 900000).toString();
    
    const articles = panier.map(item => ({
      medicamentId: item.medicamentId,
      medicamentNom: item.medicamentNom,
      sousTitre: item.sousTitre || '',
      pharmacieId: item.pharmacieId,
      pharmacieNom: item.pharmacieNom,
      quantite: item.quantite,
      prix_unitaire: item.prixUnitaire,
      necessiteOrdonnance: item.necessiteOrdonnance
    }));
    
    // Assigner un livreur
    const livreurInfo = await assignerLivreur(commande.quartier);
    
    await commandeRef.set({
      clientId: userId,
      clientNom: commande.nom,
      date_commande: admin.firestore.Timestamp.now(),
      derniere_maj: admin.firestore.Timestamp.now(),
      statut: 'en_attente',
      articles: articles,
      paiement: {
        montant_total: commande.total,
        statut_paiement: 'en_attente',
        mode: 'cash_livraison'
      },
      livraison: {
        adresse: commande.quartier,
        indications: commande.indications || '',
        statut_livraison: 'en_attente',
        livreurId: livreurInfo ? livreurInfo.id : null,
        livreurNom: livreurInfo ? `${livreurInfo.nom} ${livreurInfo.prenom}` : null,
        livreurTelephone: livreurInfo ? livreurInfo.telephone : null
      },
      pharmacieId: panier[0].pharmacieId,
      pharmacienom: panier[0].pharmacieNom,
      code_securite: codeSecurite,
      ordonnanceUrl: userState.ordonnancePhotoUrl || null
    });
    
    // Envoyer notifications
    await envoyerNotificationsCommande(userId, commande, commandeRef.id, livreurInfo);
    
    // Message de confirmation
    await sendConfirmationCommande(userId, commande, commandeRef.id, livreurInfo, codeSecurite);
    
    // Réinitialiser l'état
    userState.derniereCommandeRef = commandeRef.id;
    userState.commandeEnCours = null;
    userState.panier = [];
    userState.step = 'IDLE';
    userStates.set(userId, userState);
    
    // Demander avis
    setTimeout(async () => {
      await sendWhatsAppMessage(userId, `🌟 **Merci pour votre commande !**\n\nComment évaluez-vous votre expérience ?\n\n"Excellent", "Bon", "Moyen", "À améliorer"`);
      userState.attenteAvisCommande = commandeRef.id;
      userStates.set(userId, userState);
    }, 3000);
    
  } catch (error) {
    Logger.error('Erreur création commande:', error.message);
    await sendWhatsAppMessage(userId, "Problème lors de la création de la commande. Contactez le support.");
  }
}

async function assignerLivreur(quartier) {
  try {
    const snapshot = await db.collection('users')
      .where('estDisponible', '==', true)
      .where('estVerifie', '==', true)
      .limit(3)
      .get();
    
    if (snapshot.empty) {
      return null;
    }
    
    const livreurs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return livreurs[0];
  } catch (error) {
    Logger.error('Erreur assignation livreur:', error.message);
    return null;
  }
}

async function envoyerNotificationsCommande(userId, commande, commandeId, livreurInfo) {
  try {
    // Notifier la pharmacie
    const pharmacieDoc = await db.collection('pharmacies').doc(commande.panier[0].pharmacieId).get();
    if (pharmacieDoc.exists) {
      const pharmacie = pharmacieDoc.data();
      if (pharmacie.telephone || pharmacie.whatsapp) {
        const contact = pharmacie.telephone || pharmacie.whatsapp;
        let message = `📦 **NOUVELLE COMMANDE #${commandeId.substring(0, 8)}**\n\n`;
        commande.panier.forEach(item => {
          message += `• ${item.medicamentNom} × ${item.quantite}\n`;
        });
        message += `\n📍 ${commande.quartier}\n`;
        message += `📞 ${commande.whatsapp}\n`;
        message += `👤 ${commande.nom}`;
        
        await sendWhatsAppMessage(contact, message);
      }
    }
    
    // Notifier le livreur
    if (livreurInfo && livreurInfo.telephone) {
      let message = `🚚 **NOUVELLE LIVRAISON #${commandeId.substring(0, 8)}**\n\n`;
      message += `📍 ${commande.quartier}\n`;
      if (commande.indications) message += `📝 ${commande.indications}\n`;
      message += `📞 Client: ${commande.whatsapp}\n`;
      message += `👤 ${commande.nom}\n`;
      message += `🔒 Code: ${Math.floor(100000 + Math.random() * 900000)}`;
      
      await sendWhatsAppMessage(livreurInfo.telephone, message);
    }
    
    // Notifier le support
    if (CONFIG.SUPPORT_PHONE) {
      let message = `📋 **NOUVELLE COMMANDE #${commandeId.substring(0, 8)}**\n\n`;
      commande.panier.forEach(item => {
        message += `• ${item.medicamentNom} × ${item.quantite}\n`;
      });
      message += `\n📍 ${commande.quartier}\n`;
      message += `📞 ${commande.whatsapp}\n`;
      message += `👤 ${commande.nom}\n`;
      message += `🏥 ${commande.panier[0].pharmacieNom}`;
      if (livreurInfo) message += `\n👨‍🚀 ${livreurInfo.telephone}`;
      
      await sendWhatsAppMessage(CONFIG.SUPPORT_PHONE, message);
    }
    
  } catch (error) {
    Logger.error('Erreur notifications commande:', error.message);
  }
}

async function sendConfirmationCommande(userId, commande, commandeId, livreurInfo, codeSecurite) {
  let message = `✅ **COMMANDE #${commandeId.substring(0, 8)} CONFIRMÉE !**\n\n`;
  
  commande.panier.forEach((item, index) => {
    message += `${index + 1}. ${item.medicamentNom} × ${item.quantite}\n`;
  });
  
  message += `\n💰 **Total: ${commande.total} FCFA**\n`;
  message += `📍 **Livraison à:** ${commande.quartier}\n`;
  message += `📞 **Votre numéro:** ${commande.whatsapp}\n`;
  
  if (livreurInfo) {
    message += `\n👨‍🚀 **Livreur:** ${livreurInfo.nom || ''}\n`;
    message += `📞 **Contact livreur:** ${livreurInfo.telephone || 'À venir'}\n`;
    message += `📍 Il vous contactera pour la livraison\n`;
  }
  
  message += `\n🔒 **Code de sécurité:** ${codeSecurite}\n`;
  message += `_Montrez ce code au livreur_\n\n`;
  message += `📞 **Support:** ${CONFIG.SUPPORT_PHONE}`;
  
  await sendWhatsAppMessage(userId, message);
}

// =================== WEBHOOK WHATSAPP ===================
app.get('/api/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (mode && token === CONFIG.VERIFY_TOKEN) {
    Logger.info('Webhook vérifié avec succès');
    res.status(200).send(challenge);
  } else {
    Logger.error('Échec vérification webhook');
    res.status(403).send('Token invalide');
  }
});

app.post('/api/webhook', async (req, res) => {
  Logger.webhook(req.body);
  
  res.status(200).send('EVENT_RECEIVED');
  
  setImmediate(async () => {
    try {
      const entry = req.body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const message = value?.messages?.[0];
      
      if (!message) {
        return;
      }
      
      if (message.id) {
        await markMessageAsRead(message.id);
      }
      
      if (message.type === 'unsupported' || message.type === 'system') {
        return;
      }
      
      const userId = message.from;
      const messageType = message.type;
      
      let userState = userStates.get(userId);
      if (!userState) {
        userState = { ...DEFAULT_STATE };
        userStates.set(userId, userState);
      }
      
      // Mettre à jour la dernière interaction
      userState.derniereInteraction = Date.now();
      
      if (messageType === 'text') {
        const text = message.text.body.trim();
        Logger.message(userId, 'in', text);
        
        // Vérifier si l'utilisateur est déjà en traitement
        if (processingLocks.has(userId)) {
          return;
        }
        
        processingLocks.set(userId, true);
        
        try {
          // État: collecte informations commande
          if (userState.step === 'ATTENTE_NOM' || 
              userState.step === 'ATTENTE_QUARTIER' || 
              userState.step === 'ATTENTE_WHATSAPP' || 
              userState.step === 'ATTENTE_INDICATIONS') {
            
            await collecterInfosCommande(userId, text, userState);
            
          } 
          // État: confirmation commande
          else if (userState.step === 'CONFIRMATION_COMMANDE') {
            
            await traiterConfirmationCommande(userId, text, userState);
            
          } 
          // État: prise de rendez-vous
          else if (userState.attenteSpecialiteRdv || 
                   userState.attenteSelectionCliniqueRdv || 
                   userState.attenteDateRdv || 
                   userState.attenteHeureRdv || 
                   userState.attenteNomRdv || 
                   userState.attenteTelephoneRdv) {
            
            await gererPriseRendezVous(userId, text, userState);
            
          } 
          // État: avis
          else if (userState.attenteAvisCommande || userState.attenteAvisRdv) {
            
            await gererAvis(userId, text, userState);
            
          } 
          // État: ordonnance requise
          else if (userState.attentePhotoOrdonnance) {
            
            await sendWhatsAppMessage(userId, `📞 **Envoyez votre ordonnance au support:** ${CONFIG.SUPPORT_PHONE}\n\nNotre équipe vérifiera votre ordonnance et vous confirmera la commande.`);
            
          } 
          // État normal: IA intelligente
          else {
            
            // Obtenir la réponse de l'IA
            const result = await assistantIA.comprendreEtRepondre(userId, text, userState);
            
            // Envoyer la réponse
            await sendWhatsAppMessage(userId, result.reponse);
            
            // Exécuter les actions demandées par l'IA
            if (result.actions && result.actions.length > 0) {
              await executerActions(userId, result.actions, userState);
            }
          }
          
        } finally {
          processingLocks.delete(userId);
        }
        
      } else if (messageType === 'image') {
        
        if (userState.attentePhotoOrdonnance) {
          await sendWhatsAppMessage(userId, `✅ **Ordonnance reçue !**\n\nNotre équipe va vérifier votre ordonnance et vous confirmera la commande sous peu.\n\n📞 Support: ${CONFIG.SUPPORT_PHONE}`);
          
          // Notifier le support
          if (CONFIG.SUPPORT_PHONE) {
            await sendWhatsAppMessage(
              CONFIG.SUPPORT_PHONE,
              `📄 **NOUVELLE ORDONNANCE**\n\n` +
              `👤 Client: ${userId}\n` +
              `💊 Médicament(s) demandé(s): ${userState.ordonnanceRequisePour.map(id => `#${id}`).join(', ')}\n` +
              `⚠️ Vérification requise`
            );
          }
          
          userState.attentePhotoOrdonnance = false;
          userState.ordonnancePhotoUrl = "uploaded"; // À remplacer par l'URL Cloudinary réelle
          userStates.set(userId, userState);
        } else {
          await sendWhatsAppMessage(userId, `📸 **Photo reçue**\n\nDécrivez-moi ce dont vous avez besoin ou envoyez le nom du médicament.`);
        }
      }
      
    } catch (error) {
      Logger.error('ERREUR WEBHOOK:', error.message);
    }
  });
});

async function gererAvis(userId, message, userState) {
  const texte = message.toLowerCase().trim();
  let note = null;
  
  if (texte.includes('excellent') || texte.includes('parfait') || texte.includes('super')) {
    note = 5;
  } else if (texte.includes('bon') || texte.includes('bien')) {
    note = 4;
  } else if (texte.includes('moyen') || texte.includes('correct')) {
    note = 3;
  } else if (texte.includes('améliorer') || texte.includes('mauvais') || texte.includes('pas bien')) {
    note = 2;
  }
  
  if (userState.attenteAvisCommande) {
    const commandeId = userState.attenteAvisCommande;
    
    try {
      await db.collection('commandes_medicales').doc(commandeId).update({
        'avis.note': note,
        'avis.commentaire': texte,
        'avis.date': admin.firestore.Timestamp.now()
      });
      
      await sendWhatsAppMessage(userId, note ? `🌟 **Merci pour votre avis ${note}/5 !**` : "🌟 **Merci pour votre retour !**");
      
    } catch (error) {
      Logger.error('Erreur sauvegarde avis commande:', error.message);
    }
    
    userState.attenteAvisCommande = null;
    
  } else if (userState.attenteAvisRdv) {
    const rdvId = userState.attenteAvisRdv;
    
    try {
      await db.collection('rendez_vous').doc(rdvId).update({
        'avis.note': note,
        'avis.commentaire': texte,
        'avis.date': admin.firestore.Timestamp.now()
      });
      
      await sendWhatsAppMessage(userId, note ? `🌟 **Merci pour votre avis ${note}/5 !**` : "🌟 **Merci pour votre retour !**");
      
    } catch (error) {
      Logger.error('Erreur sauvegarde avis RDV:', error.message);
    }
    
    userState.attenteAvisRdv = null;
  }
  
  userStates.set(userId, userState);
}

// =================== ENDPOINTS ADMIN ===================
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'Pillbox WhatsApp Bot IA - VERSION INTELLIGENTE',
    version: '3.0.0',
    users_actifs: userStates.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    support_phone: CONFIG.SUPPORT_PHONE,
    zone: CONFIG.ZONE_SERVICE,
    createurs: 'Yousself et Delphin - Université Polytechnique de San Pedro',
    model_ia: CONFIG.GROQ_MODEL,
    features: [
      'IA médicale intelligente',
      'Correction automatique complète',
      'Compréhension des symptômes',
      'Gestion des ordonnances',
      'Notifications multi-canaux',
      'Feedback utilisateur'
    ]
  });
});

app.get('/api/stats', (req, res) => {
  const stats = {
    users_actifs: userStates.size,
    conversations_actives: assistantIA.historiques.size,
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    uptime: process.uptime(),
    paniers_actifs: Array.from(userStates.values()).filter(state => state.panier && state.panier.length > 0).length
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
      zone: CONFIG.ZONE_SERVICE,
      createurs: 'Yousself et Delphin',
      model: CONFIG.GROQ_MODEL,
      intelligence_level: 'HAUTE - Compréhension médicale complète'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function verifierDonneesInitiales() {
  try {
    Logger.info('Vérification des données initiales...');
    const collections = ['medicaments', 'pharmacies', 'centres_sante'];
    const stats = {};
    for (const collection of collections) {
      const snapshot = await db.collection(collection).limit(1).get();
      stats[collection] = !snapshot.empty;
    }
    Logger.info('Données initiales vérifiées:', stats);
    return stats;
  } catch (error) {
    Logger.error('Erreur vérification données:', error.message);
    return { error: error.message };
  }
}

// =================== DÉMARRAGE SERVEUR ===================
app.listen(PORT, HOST, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║  🚀 PILLBOX WHATSAPP BOT IA - VERSION INTELLIGENTE       ║
║  🔥 UTILISATION GROQ À 100% - MIATRONAL-8x7b-32768       ║
╚═══════════════════════════════════════════════════════════╝

✅ **FONCTIONNALITÉS PRINCIPALES:**

🧠 **INTELLIGENCE MÉDICALE COMPLÈTE**
   • Comprend les symptômes: "j'ai mal à la tête" → Paracétamol
   • Corrige TOUTES les fautes d'orthographe automatiquement
   • Propose des alternatives intelligentes
   • Pose des questions pertinentes

💊 **GESTION DES ORDONNANCES**
   • Détecte automatiquement les médicaments nécessitant ordonnance
   • Rappelle EXPLICITEMENT d'envoyer l'ordonnance au support
   • Processus de vérification intégré
   • Support client: ${CONFIG.SUPPORT_PHONE}

🏥 **SERVICES COMPLETS**
   • Recherche intelligente de médicaments
   • Pharmacies de garde en temps réel
   • Prise de rendez-vous médicaux
   • Livraison avec notifications

📊 **DONNÉES EN TEMPS RÉEL**
   • Médicaments disponibles avec prix et stock
   • Pharmacies ouvertes avec horaires
   • Cliniques vérifiées avec spécialités
   • Zone: ${CONFIG.ZONE_SERVICE}

🔧 **TECHNOLOGIE**
   • Model IA: ${CONFIG.GROQ_MODEL}
   • Base de données: Firebase Firestore
   • Messagerie: WhatsApp Business API
   • Hébergement: Render.com/Railway

📞 **SUPPORT**
   • Téléphone support: ${CONFIG.SUPPORT_PHONE}
   • Zone de service: ${CONFIG.ZONE_SERVICE}
   • Livraison: ${CONFIG.LIVRAISON_JOUR} FCFA (jour)
   • Livraison: ${CONFIG.LIVRAISON_NUIT} FCFA (nuit)

👥 **CRÉATEURS**
   • Yousself & Delphin
   • Université Polytechnique de San Pedro
   • Côte d'Ivoire

🌐 **SERVEUR PRÊT**
   • Port: ${PORT}
   • Host: ${HOST}
   • Démarrage: ${new Date().toLocaleString()}

╔═══════════════════════════════════════════════════════════╗
║  ✅ PRÊT À RECEVOIR DES MESSAGES WHATSAPP !              ║
║  🤖 L'ASSISTANT MÉDICAL INTELLIGENT EST ACTIF !          ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

// Nettoyage périodique des sessions inactives
setInterval(() => {
  const now = Date.now();
  const deuxHeures = 2 * 60 * 60 * 1000;
  
  for (const [userId, state] of userStates.entries()) {
    if (now - state.derniereInteraction > deuxHeures) {
      Logger.info(`Nettoyage session inactive: ${userId}`);
      userStates.delete(userId);
      assistantIA.nettoyerHistorique(userId);
    }
  }
  
  for (const [userId] of processingLocks.entries()) {
    if (now - userStates.get(userId)?.derniereInteraction > 30000) {
      processingLocks.delete(userId);
    }
  }
}, 30 * 60 * 1000); // Toutes les 30 minutes

// Gestion des erreurs
process.on('uncaughtException', (error) => {
  Logger.error('ERREUR NON GÉRÉE:', error.message, error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  Logger.error('PROMISE REJECTION NON GÉRÉE:', reason);
});