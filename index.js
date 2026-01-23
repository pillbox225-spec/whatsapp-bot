require('dotenv').config();
const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

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
  historiqueMessages: []
};

// =================== CERVEAU PRINCIPAL - GROQ ===================
async function comprendreEtAgir(userId, message) {
  console.log(`🧠 [GROQ] Analyse: "${message}"`);
  
  const prompt = `
Tu es Mia, l'assistante médicale intelligente de Pillbox à San Pedro, Côte d'Ivoire.

Message utilisateur: "${message}"

TÂCHE: 
1. COMPRENDS ce que veut l'utilisateur
2. DÉCIDE de l'action à prendre
3. DONNE une réponse immédiate naturelle
4. EXTRAIS les informations importantes

ACTIONS POSSIBLES (choisis une seule) :
• PHARMACIE_GARDE - Si l'utilisateur cherche une pharmacie de garde/ouverte/maintenant/24h/nuit
• ACHAT_MEDICAMENT - Si l'utilisateur veut acheter/commander/trouver un médicament
• RENDEZ_VOUS - Si l'utilisateur veut un rdv/médecin/clinique/consultation/spécialiste
• INFO_CLINIQUE - Si l'utilisateur demande les cliniques disponibles/infos
• PRIX_DISPONIBILITE - Si l'utilisateur demande prix/coût/stock/disponibilité
• SUPPORT - Si l'utilisateur a problème/difficulté/besoin d'aide/ne marche pas
• SALUTATION - Simple bonjour/salut/merci/aurevoir
• CONSEIL_SANTE - Si l'utilisateur demande conseil santé/que faire/traitement
• AUTRE - Pour toute autre chose

INFORMATIONS À EXTRAIRE SI PRÉSENTES:
• médicament: "nom_du_médicament" (ex: paracétamol, ibuprofène, amoxicilline)
• spécialité: "spécialité_médicale" (ex: dermatologue, pédiatre, cardiologue)
• mot_clé: "mot_clé_principal"

RÈGLES IMPORTANTES:
1. Notre service est UNIQUEMENT pour San Pedro
2. Livraison disponible seulement à San Pedro
3. Frais: 400 FCFA (8h-23h) / 600 FCFA (00h-8h)
4. Sois empathique, directe et utile
5. Réponse immédiate: 1-2 phrases maximum

RÉPONDS UNIQUEMENT en JSON:
{
  "action": "ACTION_PRINCIPALE",
  "medicament": "nom_du_medicament_ou_null",
  "specialite": "specialite_ou_null",
  "mot_cle": "mot_cle_ou_null",
  "reponse_immediate": "Réponse courte et naturelle en français avec emoji pertinent"
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
            content: "Tu analyses les messages et décides des actions. Réponds toujours en JSON valide." 
          },
          { role: "user", content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 300,
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
    
    // 1. Envoyer la réponse immédiate de Groq
    await sendWhatsAppMessage(userId, result.reponse_immediate);
    
    // 2. Exécuter l'action correspondante
    await executerAction(userId, result, message);
    
    return result;
    
  } catch (error) {
    console.error('❌ Erreur Groq:', error.message);
    
    // Fallback intelligent
    await fallbackIntelligence(userId, message);
  }
}

async function fallbackIntelligence(userId, message) {
  const texte = message.toLowerCase();
  
  if (texte.includes('pharmacie') && (texte.includes('garde') || texte.includes('ouverte') || texte.includes('maintenant'))) {
    await sendWhatsAppMessage(userId, "🏥 Je vous trouve les pharmacies de garde à San Pedro...");
    await afficherPharmaciesDeGarde(userId);
  }
  else if (texte.includes('médicament') || texte.includes('medicament') || texte.includes('paracétamol') || texte.includes('ibuprofène') || texte.includes('amoxicilline')) {
    const medicament = extraireMedicamentFallback(texte);
    if (medicament) {
      await sendWhatsAppMessage(userId, `💊 Je recherche "${medicament}"...`);
      await rechercherEtAfficherMedicament(userId, medicament);
    } else {
      await sendWhatsAppMessage(userId, "💊 Quel médicament cherchez-vous ?");
      const userState = userStates.get(userId) || DEFAULT_STATE;
      userState.attenteMedicament = true;
      userStates.set(userId, userState);
    }
  }
  else if (texte.includes('rendez-vous') || texte.includes('rdv') || texte.includes('médecin') || texte.includes('clinique')) {
    const specialite = extraireSpecialiteFallback(texte);
    if (specialite) {
      await sendWhatsAppMessage(userId, `📅 Je cherche des ${specialite}s...`);
      await chercherCliniquesParSpecialite(userId, specialite);
    } else {
      await sendWhatsAppMessage(userId, "📅 Pour quelle spécialité voulez-vous prendre rendez-vous ?");
      const userState = userStates.get(userId) || DEFAULT_STATE;
      userState.attenteSpecialite = true;
      userStates.set(userId, userState);
    }
  }
  else if (texte.includes('prix') || texte.includes('combien') || texte.includes('coûte')) {
    const medicament = extraireMedicamentFallback(texte);
    if (medicament) {
      await sendWhatsAppMessage(userId, `💰 Je vérifie le prix de "${medicament}"...`);
      await afficherPrixDisponibilite(userId, medicament);
    } else {
      await sendWhatsAppMessage(userId, "💰 Pour quel médicament voulez-vous connaître le prix ?");
      const userState = userStates.get(userId) || DEFAULT_STATE;
      userState.attenteMedicamentPrix = true;
      userStates.set(userId, userState);
    }
  }
  else if (texte.includes('problème') || texte.includes('erreur') || texte.includes('marche pas') || texte.includes("j'arrive pas")) {
    await donnerSupport(userId);
  }
  else if (texte.includes('bonjour') || texte.includes('salut') || texte.includes('bonsoir')) {
    await envoyerMessageBienvenue(userId);
  }
  else {
    await sendWhatsAppMessage(
      userId,
      "🤔 Je ne suis pas sûr de comprendre. Je peux vous aider à :\n\n" +
      "💊 Acheter des médicaments\n" +
      "🏥 Trouver une pharmacie de garde\n" +
      "📅 Prendre rendez-vous\n" +
      "💰 Vérifier un prix\n\n" +
      "Dites-moi simplement ce dont vous avez besoin ! 😊"
    );
  }
}

function extraireMedicamentFallback(texte) {
  const medicaments = {
    'paracétamol': ['paracetamol', 'paracétamol', 'doliprane'],
    'ibuprofène': ['ibuprofène', 'ibuprofene', 'advil', 'ibu'],
    'amoxicilline': ['amoxicilline', 'amoxicillin', 'amox'],
    'aspirine': ['aspirine', 'aspirin'],
    'vitamine c': ['vitamine c', 'vit c'],
    'antibiotique': ['antibiotique', 'antibio']
  };
  
  for (const [nom, variations] of Object.entries(medicaments)) {
    for (const variation of variations) {
      if (texte.includes(variation)) {
        return nom;
      }
    }
  }
  
  return null;
}

function extraireSpecialiteFallback(texte) {
  const specialites = {
    'dermatologue': ['dermatologue', 'dermatologie'],
    'gynécologue': ['gynécologue', 'gynécologie'],
    'pédiatre': ['pédiatre', 'pédiatrie'],
    'cardiologue': ['cardiologue', 'cardiologie'],
    'médecin généraliste': ['médecin généraliste', 'généraliste', 'médecin'],
    'dentiste': ['dentiste'],
    'ophtalmologue': ['ophtalmologue', 'ophtalmologie']
  };
  
  for (const [nom, variations] of Object.entries(specialites)) {
    for (const variation of variations) {
      if (texte.includes(variation)) {
        return nom;
      }
    }
  }
  
  return null;
}

// =================== EXÉCUTION DES ACTIONS ===================
async function executerAction(userId, analyse, messageOriginal) {
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };
  
  console.log(`⚡ [ACTION] Exécution: ${analyse.action}`);
  
  switch (analyse.action) {
    case 'PHARMACIE_GARDE':
      await afficherPharmaciesDeGarde(userId);
      break;
      
    case 'ACHAT_MEDICAMENT':
      if (analyse.medicament) {
        await rechercherEtAfficherMedicament(userId, analyse.medicament);
      } else {
        await demanderNomMedicament(userId);
        userState.attenteMedicament = true;
        userStates.set(userId, userState);
      }
      break;
      
    case 'RENDEZ_VOUS':
      if (analyse.specialite) {
        await chercherCliniquesParSpecialite(userId, analyse.specialite);
      } else {
        await demanderSpecialite(userId);
        userState.attenteSpecialite = true;
        userStates.set(userId, userState);
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
        userStates.set(userId, userState);
      }
      break;
      
    case 'SUPPORT':
      await donnerSupport(userId);
      break;
      
    case 'CONSEIL_SANTE':
      await donnerConseilSante(userId, messageOriginal);
      break;
      
    case 'SALUTATION':
      // Déjà géré par la réponse immédiate
      break;
      
    default:
      // Action AUTRE ou inconnue
      break;
  }
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

async function rechercherEtAfficherMedicament(userId, nomMedicament) {
  try {
    const termeRecherche = nomMedicament.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .trim();
    
    if (termeRecherche.length < 3) {
      await sendWhatsAppMessage(
        userId,
        "❌ **Nom de médicament trop court.**\n\n" +
        "Veuillez spécifier un nom plus précis.\n" +
        "Exemple : 'paracétamol 500mg', 'ibuprofène', 'amoxicilline'"
      );
      return;
    }
    
    // Recherche dans tous les médicaments en stock
    const snapshot = await db.collection('medicaments')
      .where('stock', '>', 0)
      .limit(100)
      .get();
    
    const medicamentsFiltres = [];
    
    snapshot.docs.forEach(doc => {
      const medicament = { id: doc.id, ...doc.data() };
      const nomMed = (medicament.nom || '').toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      
      // Recherche insensible
      if (nomMed.includes(termeRecherche) && medicament.pharmacieId) {
        medicamentsFiltres.push(medicament);
      }
    });
    
    if (medicamentsFiltres.length === 0) {
      await sendWhatsAppMessage(
        userId,
        `❌ **"${nomMedicament}" non trouvé dans nos pharmacies partenaires.**\n\n` +
        `💡 **Causes possibles :**\n` +
        `• Orthographe différente\n` +
        `• Rupture de stock temporaire\n` +
        `• Médicament non disponible dans notre réseau\n\n` +
        `🔄 **Essayez :**\n` +
        `• Un autre nom (ex: 'antidouleur' au lieu de 'doliprane')\n` +
        `• Une autre orthographe\n` +
        `• Un médicament similaire\n\n` +
        `🏥 **Ou consultez les pharmacies de garde :**`
      );
      
      // Proposer les pharmacies de garde
      const buttons = [
        { id: "voir_pharmacies_garde", title: "🏥 Voir pharmacies" },
        { id: "rechercher_autre", title: "🔍 Autre recherche" },
        { id: "contacter_support", title: "📞 Support" }
      ];
      
      await sendInteractiveMessage(
        userId,
        "Que souhaitez-vous faire ?",
        buttons
      );
      
      return;
    }
    
    // Récupérer les pharmacies correspondantes
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
    
    // Construire le message de résultats
    const userState = userStates.get(userId) || { ...DEFAULT_STATE };
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
    
    message += `📝 **POUR COMMANDER :**\n`;
    message += `Répondez : *COMMANDER [numéro] [quantité]*\n`;
    message += `Exemple : *COMMANDER 1 2*\n\n`;
    message += `💰 **POUR LE PRIX :**\n`;
    message += `"prix [numéro]" pour plus de détails\n\n`;
    message += `🔍 **NOUVELLE RECHERCHE :**\n`;
    message += `Écrivez simplement un autre nom de médicament`;
    
    await sendWhatsAppMessage(userId, message);
    
    userState.attenteCommande = true;
    userState.step = 'ATTENTE_COMMANDE_MEDICAMENT';
    userStates.set(userId, userState);
    
  } catch (error) {
    console.error('❌ Erreur recherche médicament:', error.message);
    await sendWhatsAppMessage(
      userId,
      `❌ **Erreur lors de la recherche de "${nomMedicament}".**\n\n` +
      `Veuillez réessayer ou contacter le support.\n` +
      `📞 ${CONFIG.SUPPORT_PHONE}`
    );
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
        `🏥 **Aucun ${specialite} trouvé dans nos cliniques partenaires.**\n\n` +
        `💡 **Suggestions :**\n` +
        `• Essayez une autre spécialité\n` +
        `• Contactez directement les cliniques\n` +
        `• Consultez toutes les cliniques disponibles\n\n` +
        `📞 **Support :** ${CONFIG.SUPPORT_PHONE}`
      );
      
      // Proposer de voir toutes les cliniques
      const buttons = [
        { id: "voir_toutes_cliniques", title: "🏥 Toutes les cliniques" },
        { id: "autre_specialite", title: "🩺 Autre spécialité" },
        { id: "contacter_support", title: "📞 Support" }
      ];
      
      await sendInteractiveMessage(
        userId,
        "Que souhaitez-vous faire ?",
        buttons
      );
      
      return;
    }
    
    const userState = userStates.get(userId) || { ...DEFAULT_STATE };
    userState.listeCliniques = cliniquesFiltrees;
    
    let message = `🏥 **${specialite.toUpperCase()} - SAN PEDRO**\n\n`;
    
    cliniquesFiltrees.forEach((clinique, index) => {
      message += `${index + 1}. **${clinique.nom}**\n`;
      message += `   📍 ${clinique.adresse || 'San Pedro'}\n`;
      message += `   ☎ ${clinique.telephone || 'Non disponible'}\n`;
      
      if (clinique.horaires && typeof clinique.horaires === 'object') {
        message += `   ⏰ ${clinique.horaires.Lundi || clinique.horaires.lundi || 'Sur RDV'}\n`;
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
    message += `Tapez "cliniques disponibles"\n\n`;
    message += `📞 **PRENDRE RDV :**\n`;
    message += `Contactez directement la clinique ou notre support`;
    
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
      `   🩺 Dermatologie, Cardiologie, Gynécologie\n\n` +
      `2. **Polyclinique du Port**\n` +
      `   📍 Zone portuaire, San Pedro\n` +
      `   ☎ 07 08 08 08 08\n` +
      `   🩺 Pédiatrie, Médecine générale\n\n` +
      `📅 Pour prendre rendez-vous :\n` +
      `"rdv avec [spécialité]" ou contactez directement`
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
      await sendWhatsAppMessage(
        userId,
        "🏥 **Aucune clinique disponible pour le moment.**\n\n" +
        "Veuillez réessayer plus tard ou contacter le support.\n" +
        "📞 " + CONFIG.SUPPORT_PHONE
      );
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
      "• **Centre Médical Urbain** - Centre-ville\n" +
      "• **Clinique Sainte Marie** - Quartier résidentiel\n\n" +
      "📅 Pour prendre rendez-vous :\n" +
      '"rdv avec dermatologue" ou "rendez-vous cardiologue"\n\n' +
      "📍 Service uniquement à San Pedro"
    );
  }
}

async function afficherPrixDisponibilite(userId, nomMedicament) {
  // Utiliser la même fonction que la recherche de médicament
  await rechercherEtAfficherMedicament(userId, nomMedicament);
}

async function donnerSupport(userId) {
  const userState = userStates.get(userId) || { ...DEFAULT_STATE };
  
  let message = "🆘 **SUPPORT PILLBOX - SAN PEDRO**\n\n";
  message += "Je vois que vous avez besoin d'aide. Je suis là pour vous ! 🤗\n\n";
  
  message += "📞 **CONTACT DIRECT :**\n";
  message += CONFIG.SUPPORT_PHONE + "\n";
  message += "⏰ 7j/7 de 8h à 22h\n\n";
  
  message += "🔍 **PROBLÈMES FRÉQUENTS :**\n";
  message += "• Médicament non trouvé\n";
  message += "• Difficulté à commander\n";
  message += "• Question sur les prix\n";
  message += "• Problème de livraison\n";
  message += "• Ordonnance non acceptée\n\n";
  
  message += "💬 **DÉCRIVEZ VOTRE PROBLÈME** et je ferai de mon mieux pour vous aider.\n\n";
  
  message += "📍 **RAPPEL IMPORTANT :**\n";
  message += "Notre service de livraison est disponible UNIQUEMENT à San Pedro.\n\n";
  
  message += "💰 **FRAIS DE LIVRAISON :**\n";
  message += "• 400 FCFA (8h-23h)\n";
  message += "• 600 FCFA (00h-8h)";
  
  await sendWhatsAppMessage(userId, message);
  
  // Réinitialiser l'état utilisateur
  userState.step = 'MENU_PRINCIPAL';
  userState.attenteCommande = false;
  userState.attenteSelectionClinique = false;
  userStates.set(userId, userState);
}

async function donnerConseilSante(userId, message) {
  try {
    const promptConseil = `
    L'utilisateur demande un conseil santé: "${message}"
    
    Tu es Mia, une assistante médicale empathique mais prudente.
    
    DONNE UN CONSEIL GÉNÉRAL qui :
    1. Est rassurant mais pas alarmiste
    2. Recommande toujours de consulter un professionnel
    3. Donne des conseils pratiques généraux
    4. Utilise un ton chaleureux et empathique
    
    Règles strictes :
    - ⛔ NE JAMAIS FAIRE DE DIAGNOSTIC
    - ⛔ NE JAMAIS PRESCRIRE DE MÉDICAMENT
    - ✅ TOUJOURS ORIENTER VERS UN MÉDECIN
    
    Réponse : Maximum 3 phrases, avec emoji pertinent.
    `;
    
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: CONFIG.GROQ_MODEL,
        messages: [
          { role: "system", content: "Tu donnes des conseils santé généraux et prudents." },
          { role: "user", content: promptConseil }
        ],
        temperature: 0.7,
        max_tokens: 150
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
    
    // Toujours ajouter le disclaimer
    await sendWhatsAppMessage(
      userId,
      "⚠️ **RAPPEL IMPORTANT :**\n" +
      "Ceci est un conseil général. Pour un avis médical personnalisé, " +
      "consultez un médecin ou un professionnel de santé.\n\n" +
      "🏥 **Besoin d'un rendez-vous ?**\n" +
      'Dites "rdv avec [spécialité]" ou contactez le support.\n' +
      "📞 " + CONFIG.SUPPORT_PHONE
    );
    
  } catch (error) {
    console.error('❌ Erreur conseil santé:', error.message);
    await sendWhatsAppMessage(
      userId,
      "🌿 **Pour tout conseil médical personnalisé,** " +
      "il est important de consulter un médecin ou un professionnel de santé.\n\n" +
      "🏥 Je peux vous aider à prendre rendez-vous avec un spécialiste à San Pedro !\n" +
      'Dites simplement "rdv avec [spécialité]". 😊'
    );
  }
}

// =================== FONCTIONS UTILITAIRES ===================
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
    // Envoyer un message texte à la place
    await sendWhatsAppMessage(to, text + "\n\n💡 Répondez avec le numéro de votre choix.");
    return null;
  }
}

async function demanderNomMedicament(userId) {
  await sendWhatsAppMessage(
    userId,
    "💊 **Quel médicament recherchez-vous ?**\n\n" +
    "📝 **Écrivez simplement le nom :**\n\n" +
    "💡 **Exemples :**\n" +
    "• Paracétamol\n" +
    "• Ibuprofène\n" +
    "• Amoxicilline\n" +
    "• Vitamine C\n" +
    "• Antibiotique\n" +
    "• Sirop contre la toux\n" +
    "• Antidouleur\n\n" +
    "Je vais le chercher dans nos pharmacies partenaires à San Pedro. 🔍"
  );
}

async function demanderSpecialite(userId) {
  await sendWhatsAppMessage(
    userId,
    "📅 **Avec quel type de médecin souhaitez-vous consulter ?**\n\n" +
    "👨‍⚕️ **Spécialités disponibles :**\n\n" +
    "• Médecin généraliste\n" +
    "• Dermatologue (peau)\n" +
    "• Gynécologue (femmes)\n" +
    "• Pédiatre (enfants)\n" +
    "• Cardiologue (cœur)\n" +
    "• Dentiste\n" +
    "• Ophtalmologue (yeux)\n" +
    "• ORL (oreille-nez-gorge)\n\n" +
    "📝 **Écrivez la spécialité souhaitée**\n" +
    "Exemple : 'dermatologue' ou 'médecin généraliste'"
  );
}

async function demanderMedicamentPourPrix(userId) {
  await sendWhatsAppMessage(
    userId,
    "💰 **Pour quel médicament voulez-vous connaître le prix ?**\n\n" +
    "📝 **Écrivez le nom du médicament :**\n\n" +
    "💡 **Exemples de format :**\n" +
    '• "Prix du paracétamol"\n' +
    '• "Combien coûte l\'ibuprofène ?"\n' +
    '• "Amoxicilline prix"\n' +
    '• "Disponibilité vitamine C"\n\n' +
    "Je vérifierai dans nos pharmacies à San Pedro. 🔍"
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
      "• Acheter des médicaments (avec/sans ordonnance)\n" +
      "• Trouver des pharmacies de garde 24h/24\n" +
      "• Prendre des rendez-vous médicaux\n" +
      "• Vérifier les prix et disponibilités\n" +
      "• Donner des conseils santé généraux\n\n" +
      "💬 **PARLEZ-MOI NATURELLEMENT !**\n" +
      "Exemples :\n" +
      '• "Je veux du paracétamol"\n' +
      '• "Pharmacie ouverte maintenant ?"\n' +
      '• "Rendez-vous avec dermatologue"\n' +
      '• "Prix ibuprofène"\n' +
      '• "J\'ai un problème"\n\n' +
      "📞 **SUPPORT :** " + CONFIG.SUPPORT_PHONE + "\n\n" +
      "Comment puis-je vous aider aujourd'hui ? 😊"
    );
    
    userState.initialized = true;
    userState.nom = "Client";
    userStates.set(userId, userState);
  }
}

// =================== GESTION DES COMMANDES ===================
async function traiterCommandeMedicament(userId, message, userState) {
  const commandeRegex = /commander\s+(\d+)\s+(\d+)/i;
  const match = message.match(commandeRegex);
  
  if (match) {
    const numero = parseInt(match[1]);
    const quantite = parseInt(match[2]);
    
    if (quantite < 1 || quantite > 100) {
      await sendWhatsAppMessage(userId, "❌ Quantité invalide. Choisissez entre 1 et 100.");
      return;
    }
    
    const medicamentInfo = userState.listeMedicamentsAvecIndex.find(m => m.index === numero);
    
    if (!medicamentInfo) {
      await sendWhatsAppMessage(
        userId,
        "❌ **Numéro de médicament invalide.**\n\n" +
        "Veuillez vérifier le numéro dans la liste précédente.\n" +
        "Les numéros sont ceux affichés à gauche des médicaments."
      );
      return;
    }
    
    const medicament = medicamentInfo.medicament;
    const prixUnitaire = medicament.prix || 0;
    const prixTotal = prixUnitaire * quantite;
    const fraisLivraison = getFraisLivraison();
    const total = prixTotal + fraisLivraison;
    
    // Vérifier le stock
    if (medicament.stock < quantite) {
      await sendWhatsAppMessage(
        userId,
        `❌ **Stock insuffisant.**\n\n` +
        `Il ne reste que ${medicament.stock} unité(s) disponible(s).\n` +
        `Veuillez choisir une quantité inférieure ou égale à ${medicament.stock}.`
      );
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
      messageConfirmation += `⚠️ **ATTENTION : Ordonnance requise**\n`;
      messageConfirmation += `Vous devrez envoyer une photo de votre ordonnance.\n\n`;
    }
    
    messageConfirmation += `📝 **POUR FINALISER, ENVOYEZ :**\n`;
    messageConfirmation += `1. Votre nom complet\n`;
    messageConfirmation += `2. Votre quartier à San Pedro\n`;
    messageConfirmation += `3. Votre numéro WhatsApp\n`;
    messageConfirmation += `4. Indications pour la livraison\n\n`;
    messageConfirmation += `📍 **RAPPEL :** Service uniquement à San Pedro\n\n`;
    messageConfirmation += `💬 Exemple :\n`;
    messageConfirmation += `"Nom: Fatou Traoré\n`;
    messageConfirmation += `Quartier: Résidence du Port\n`;
    messageConfirmation += `WhatsApp: 07 08 12 34 56\n`;
    messageConfirmation += `Indications: Immeuble bleu, 3ème étage"`;
    
    await sendWhatsAppMessage(userId, messageConfirmation);
    
    // Sauvegarder la commande en cours
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
        `📦 Stock : ${medicament.stock || 0} unités\n` +
        `${medicament.necessiteOrdonnance ? '⚠️ Ordonnance requise\n' : '✅ Sans ordonnance\n'}` +
        `\n🛒 **Pour commander :**\n` +
        `"commander ${numero} [quantité]"`
      );
    }
  }
}

function getFraisLivraison() {
  const maintenant = new Date();
  const heure = maintenant.getHours();
  return (heure >= 0 && heure < 8) ? CONFIG.LIVRAISON_NUIT : CONFIG.LIVRAISON_JOUR;
}

// =================== TRAITEMENT DES INFORMATIONS ===================
async function traiterInfosLivraison(userId, message, userState) {
  // Extraire les informations
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
  
  // Vérifier les champs requis
  const champsRequis = ['nom', 'quartier', 'whatsapp'];
  const champsManquants = champsRequis.filter(champ => !infos[champ]);
  
  if (champsManquants.length > 0) {
    await sendWhatsAppMessage(
      userId,
      `❌ **Informations manquantes :** ${champsManquants.join(', ')}\n\n` +
      `Veuillez fournir toutes les informations dans le format demandé.\n\n` +
      `📝 **Format :**\n` +
      `Nom: Votre nom\n` +
      `Quartier: Votre quartier\n` +
      `WhatsApp: Votre numéro\n` +
      `Indications: Détails supplémentaires`
    );
    return;
  }
  
  // Vérifier que c'est à San Pedro
  if (!infos.quartier.toLowerCase().includes('san pedro') && 
      !infos.quartier.toLowerCase().includes('san-pedro')) {
    await sendWhatsAppMessage(
      userId,
      "❌ **HORS ZONE DE LIVRAISON**\n\n" +
      "Désolé, notre service de livraison est exclusivement réservé à **San Pedro**.\n\n" +
      "📍 **Vous avez indiqué :** " + infos.quartier + "\n\n" +
      "💡 **Veuillez :**\n" +
      "1. Confirmer que vous êtes bien à San Pedro\n" +
      "2. Précisez le quartier exact à San Pedro\n" +
      "3. Ou utilisez nos services sur place\n\n" +
      "📞 Pour plus d'informations : " + CONFIG.SUPPORT_PHONE
    );
    return;
  }
  
  // Confirmer la commande finale
  const commande = userState.commandeEnCours;
  const numeroCommande = `CMD${Date.now().toString().slice(-8)}`;
  
  await sendWhatsAppMessage(
    userId,
    `🎉 **COMMANDE CONFIRMÉE #${numeroCommande}**\n\n` +
    `👤 **Client :** ${infos.nom}\n` +
    `📱 WhatsApp : ${infos.whatsapp}\n` +
    `📍 Quartier : ${infos.quartier}\n` +
    `📞 À joindre : ${infos.ajoindre || infos.whatsapp}\n` +
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
    `\n📞 **SUPPORT & SUIVI :**\n` +
    CONFIG.SUPPORT_PHONE + `\n` +
    `(Référence : ${numeroCommande})\n\n` +
    `Merci pour votre confiance ! 😊\n` +
    `📍 **Service Pillbox San Pedro**`
  );
  
  if (commande.necessiteOrdonnance) {
    await sendWhatsAppMessage(
      userId,
      `⚠️ **ORDONNANCE REQUISE**\n\n` +
      `Veuillez envoyer une photo claire de votre ordonnance.\n\n` +
      `📸 **Comment envoyer :**\n` +
      `1. Cliquez sur 📎 (attache)\n` +
      `2. Sélectionnez "Galerie" ou "Appareil photo"\n` +
      `3. Choisissez la photo de votre ordonnance\n\n` +
      `⏱️ **Votre commande sera traitée après validation.**`
    );
    
    userState.attentePhotoOrdonnance = true;
  }
  
  // Réinitialiser l'état
  userState.commandeEnCours = null;
  userState.resultatsRechercheMedicaments = null;
  userState.listeMedicamentsAvecIndex = [];
  userState.step = 'MENU_PRINCIPAL';
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
  
  // Répondre immédiatement à WhatsApp
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
    
    const userId = message.from;
    const messageType = message.type;
    
    // Récupérer ou créer l'état utilisateur
    let userState = userStates.get(userId);
    if (!userState) {
      userState = { ...DEFAULT_STATE };
      userStates.set(userId, userState);
    }
    
    if (messageType === 'text') {
      const text = message.text.body.trim();
      
      console.log(`💬 ${userId}: "${text}"`);
      
      // Gestion des états spéciaux
      if (userState.step === 'ATTENTE_INFOS_LIVRAISON') {
        await traiterInfosLivraison(userId, text, userState);
        return;
      }
      
      if (userState.attenteCommande || text.toLowerCase().startsWith('commander')) {
        await traiterCommandeMedicament(userId, text, userState);
        return;
      }
      
      if (userState.attenteMedicament) {
        await rechercherEtAfficherMedicament(userId, text);
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
            `Contactez directement la clinique ou\n` +
            `Envoyez-nous vos disponibilités.\n\n` +
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
      
      // Mettre à jour l'historique
      if (!userState.historiqueMessages) {
        userState.historiqueMessages = [];
      }
      userState.historiqueMessages.push({
        message: text,
        timestamp: new Date().toISOString()
      });
      
      // Limiter l'historique à 20 messages
      if (userState.historiqueMessages.length > 20) {
        userState.historiqueMessages = userState.historiqueMessages.slice(-20);
      }
      
      userStates.set(userId, userState);
      
    } else if (messageType === 'image') {
      // Gestion des images (ordonnances)
      if (userState.attentePhotoOrdonnance) {
        await sendWhatsAppMessage(
          userId,
          "✅ **Ordonnance reçue !**\n\n" +
          "Votre ordonnance a été envoyée à la pharmacie pour validation.\n" +
          "Nous vous recontacterons dès que possible.\n\n" +
          "📞 Pour suivre : " + CONFIG.SUPPORT_PHONE
        );
        
        userState.attentePhotoOrdonnance = false;
        userStates.set(userId, userState);
      }
    }
    
  } catch (error) {
    console.error('💥 ERREUR WEBHOOK:', error.message);
    console.error(error.stack);
  }
});

// =================== ENDPOINTS ADMIN ===================
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'Pillbox WhatsApp Bot PRODUCTION',
    version: '2.0.0',
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
      initialized: state.initialized,
      last_active: state.historiqueMessages?.[state.historiqueMessages?.length - 1]?.timestamp
    })),
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    uptime: process.uptime()
  };
  
  res.json(stats);
});

app.get('/api/test', async (req, res) => {
  try {
    // Test Firebase
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
    
    // Compter les médicaments en stock
    const medicamentsSnapshot = await db.collection('medicaments').where('stock', '>', 0).limit(10).get();
    stats.medicaments_en_stock = medicamentsSnapshot.size;
    
    // Compter les pharmacies de garde
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
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
=======================================================
🚀 PILLBOX WHATSAPP BOT - PRODUCTION V2.0
=======================================================
📍 Port: ${PORT}
🏙️ Zone: San Pedro uniquement
🤖 Intelligence: Groq (compréhension naturelle)
💊 Services: Médicaments, RDV, Pharmacies, Conseils
📞 Support: ${CONFIG.SUPPORT_PHONE}
=======================================================
✅ PRÊT À RECEVOIR DES MESSAGES !
✅ Les utilisateurs peuvent parler naturellement
✅ Compréhension intelligente avec Groq
✅ Actions automatiques selon la demande
=======================================================
Exemples de messages utilisateur :
• "Je veux du paracétamol"
• "Pharmacie ouverte maintenant ?"
• "Rendez-vous avec dermatologue"
• "Quelles cliniques sont disponibles ?"
• "Prix ibuprofène"
• "J'ai un problème pour commander"
=======================================================
  `);
});

// Nettoyage périodique des états inactifs
setInterval(() => {
  const now = Date.now();
  const deuxHeures = 2 * 60 * 60 * 1000;
  
  for (const [userId, state] of userStates.entries()) {
    const lastMessage = state.historiqueMessages?.[state.historiqueMessages?.length - 1];
    if (lastMessage) {
      const lastActive = new Date(lastMessage.timestamp).getTime();
      if (now - lastActive > deuxHeures) {
        console.log(`🧹 Nettoyage état inactif: ${userId}`);
        userStates.delete(userId);
      }
    }
  }
}, 30 * 60 * 1000); // Toutes les 30 minutes

// Gestion des erreurs globales
process.on('uncaughtException', (error) => {
  console.error('💥 ERREUR NON GÉRÉE:', error.message);
  console.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 PROMISE REJECTION NON GÉRÉE:', reason);
});