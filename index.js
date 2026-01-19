const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;

const app = express();
app.use(express.json());

// ==================== INITIALISATION FIREBASE POUR RENDER ====================
console.log('🔧 Début initialisation Firebase...');

let db;
let FieldValue;
let firebaseInitialized = false;

// Utiliser une fonction async auto-exécutée
(async () => {
  try {
    // Vérifier si Firebase est déjà initialisé
    if (admin.apps.length === 0) {
      console.log('📁 Configuration Firebase pour Render...');
      
      // Vérifier les variables d'environnement
      if (!process.env.FIREBASE_PROJECT_ID) {
        console.error('❌ FIREBASE_PROJECT_ID manquant');
        throw new Error('FIREBASE_PROJECT_ID manquant');
      }
      
      if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
        console.error('❌ FIREBASE_SERVICE_ACCOUNT_KEY manquant');
        throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY manquant');
      }
      
      console.log(`📊 Project ID: ${process.env.FIREBASE_PROJECT_ID}`);
      
      // Parser la clé de service
      let serviceAccount;
      try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
        console.log('✅ Clé de service JSON parsée avec succès');
      } catch (parseError) {
        console.error('❌ Erreur parsing JSON:', parseError.message);
        throw new Error('Format JSON invalide pour FIREBASE_SERVICE_ACCOUNT_KEY');
      }
      
      // Initialiser Firebase
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`,
        projectId: process.env.FIREBASE_PROJECT_ID
      });
      
      console.log('✅ Firebase Admin SDK initialisé');
    } else {
      console.log('✅ Firebase déjà initialisé');
    }
    
    // Obtenir les instances
    db = admin.firestore();
    FieldValue = admin.firestore.FieldValue;
    
    // Tester la connexion
    console.log('🔍 Test de connexion Firestore...');
    const testRef = db.collection('system_health').doc('connection_test');
    await testRef.set({
      timestamp: new Date().toISOString(),
      service: 'pillbox-whatsapp-bot',
      status: 'connected',
      environment: process.env.NODE_ENV || 'production'
    });
    
    console.log('✅ Connexion Firestore établie avec succès');
    firebaseInitialized = true;
    
  } catch (error) {
    console.error('❌ ERREUR CRITIQUE Firebase:', error.message);
    
    // Mode simulation détaillé pour éviter les crashes
    console.log('🔧 Activation du mode simulation Firestore...');
    
    db = {
      collection: (name) => {
        console.log(`📊 Mock collection: ${name}`);
        return {
          doc: (id) => ({
            get: async () => {
              console.log(`📊 Mock get: ${name}/${id}`);
              return {
                exists: false,
                data: () => null,
                id: id
              };
            },
            set: async (data) => {
              console.log(`📊 Mock set: ${name}/${id}`);
              return { id: id };
            },
            update: async (data) => {
              console.log(`📊 Mock update: ${name}/${id}`);
              return { id: id };
            }
          }),
          where: (field, op, value) => ({
            get: async () => {
              console.log(`📊 Mock query: ${name} where ${field} ${op} ${value}`);
              return {
                empty: true,
                docs: [],
                forEach: () => {}
              };
            },
            limit: (count) => ({
              get: async () => {
                console.log(`📊 Mock query with limit ${count}: ${name}`);
                return { empty: true, docs: [] };
              }
            })
          }),
          add: async (data) => {
            const mockId = 'mock-' + Date.now();
            console.log(`📊 Mock add to ${name}`);
            return { id: mockId };
          },
          get: async () => {
            console.log(`📊 Mock get all: ${name}`);
            return { empty: true, docs: [] };
          }
        };
      }
    };
    
    FieldValue = {
      increment: (value) => {
        console.log(`📊 Mock FieldValue.increment(${value})`);
        return value;
      },
      serverTimestamp: () => {
        console.log(`📊 Mock FieldValue.serverTimestamp()`);
        return new Date();
      }
    };
    
    console.log('⚠️ Mode simulation activé - Les données ne seront pas sauvegardées');
  }
})();

// ==================== CONFIGURATION ====================
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
  },
  CREATORS: {
    yousself: {
      nom: "Yousself Diabaté",
      role: "Développeur Full-Stack",
      universite: "Université Polytechnique de San Pedro",
      imagePath: path.join(__dirname, 'assets', 'yousself.jpg')
    },
    delphin: {
      nom: "Bossé Toh Delphin", 
      role: "Architecte Solution & Gestion de projet",
      universite: "Université Polytechnique de San Pedro",
      imagePath: path.join(__dirname, 'assets', 'delphin.jpg')
    }
  }
};

// ==================== ÉTATS UTILISATEUR ====================
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
  attenteVoirCreateur: null,
  nom: null,
  telephone: null,
  listeMedicamentsCategorie: [],
  listeMedicamentsRecherche: [],
  currentCategorie: null,
  medicamentIdentifie: null
};

// ==================== FONCTIONS WHATSAPP AVEC TYPING INDICATORS ====================
async function sendTypingIndicator(to, duration = 3000) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "typing",
        typing: {
          action: "typing_on",
          typing_duration: duration
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`✍️ Typing indicator sent to ${to}`);
  } catch (error) {
    console.error('❌ Erreur typing indicator:', error.message);
  }
}

async function sendTextMessageWithTyping(to, text) {
  try {
    // 1. Envoyer l'indicateur "en train d'écrire"
    await sendTypingIndicator(to, Math.min(text.length * 50, 5000));
    
    // 2. Attendre un peu pour simuler l'écriture
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // 3. Envoyer le message
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "text",
        text: { 
          preview_url: false,
          body: text.substring(0, 4096) 
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log(`✅ Message sent to ${to}, ID: ${response.data.messages?.[0]?.id}`);
    return response.data.messages?.[0]?.id;
    
  } catch (error) {
    console.error('❌ Erreur envoi texte:', error.message);
    return null;
  }
}

async function sendInteractiveMessageWithTyping(to, text, buttons) {
  try {
    // 1. Envoyer l'indicateur "en train d'écrire"
    await sendTypingIndicator(to, 2000);
    
    // 2. Attendre un peu
    await new Promise(resolve => setTimeout(resolve, 800));
    
    // 3. Envoyer le message interactif
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { 
            text: text.substring(0, 1024) 
          },
          action: {
            buttons: buttons.slice(0, 3)
          }
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log(`✅ Interactive message sent to ${to}`);
    return response.data.messages?.[0]?.id;
    
  } catch (error) {
    console.error('❌ Erreur envoi interactif:', error.response?.data || error.message);
    return null;
  }
}

// Alias pour compatibilité
async function sendTextMessage(to, text) {
  return await sendTextMessageWithTyping(to, text);
}

async function sendInteractiveMessage(to, text, buttons) {
  return await sendInteractiveMessageWithTyping(to, text, buttons);
}

// ==================== FONCTIONS UTILITAIRES ====================
async function getPharmacie(id) {
  try {
    const doc = await db.collection('pharmacies').doc(id).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  } catch (error) {
    console.error('Erreur getPharmacie:', error.message);
    return null;
  }
}

async function getMedicaments(pharmacieId = null, recherche = null, categorie = null) {
  try {
    let query = db.collection('medicaments').where('stock', '>', 0);
    
    if (pharmacieId) {
      query = query.where('pharmacieId', '==', pharmacieId);
    }
    
    if (recherche && recherche.length > 2) {
      const rechercheLower = recherche.toLowerCase();
      const snapshot = await query.get();
      return snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(m => 
          m.nom.toLowerCase().includes(rechercheLower) ||
          (m.sousTitre && m.sousTitre.toLowerCase().includes(rechercheLower))
        )
        .slice(0, 15);
    }
    
    if (categorie) {
      query = query.where('categorie', '==', categorie);
    }
    
    const snapshot = await query.limit(20).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('Erreur getMedicaments:', error.message);
    return [];
  }
}

async function getCategories() {
  try {
    const snapshot = await db.collection('medicaments')
      .select('categorie')
      .get();
    
    const categories = new Set();
    snapshot.docs.forEach(doc => {
      if (doc.data().categorie) {
        categories.add(doc.data().categorie);
      }
    });
    
    return Array.from(categories);
  } catch (error) {
    console.error('Erreur getCategories:', error.message);
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

async function updateStock(medicamentId, quantite) {
  try {
    const medicamentRef = db.collection('medicaments').doc(medicamentId);
    await medicamentRef.update({
      stock: FieldValue.increment(-quantite)
    });
  } catch (error) {
    console.error('Erreur updateStock:', error.message);
  }
}

// ==================== FONCTIONS DE CALCUL ====================
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))) * 1000;
}

function getFraisLivraison() {
  const heure = new Date().getHours();
  return (heure >= 8 && heure < 23) ? CONFIG.LIVRAISON_JOUR : CONFIG.LIVRAISON_NUIT;
}

function isInSanPedro(latitude, longitude) {
  return (
    latitude >= CONFIG.ZONE_SAN_PEDRO.minLat &&
    latitude <= CONFIG.ZONE_SAN_PEDRO.maxLat &&
    longitude >= CONFIG.ZONE_SAN_PEDRO.minLng &&
    longitude <= CONFIG.ZONE_SAN_PEDRO.maxLng
  );
}

// ==================== FONCTION ENVOI AU SUPPORT CLIENT ====================
async function envoyerCommandeAuSupport(commandeId) {
  try {
    const commandeDoc = await db.collection('commandes').doc(commandeId).get();
    if (!commandeDoc.exists) {
      console.error(`❌ Commande ${commandeId} introuvable pour le support`);
      return;
    }
    
    const commande = { id: commandeDoc.id, ...commandeDoc.data() };
    
    // Créer le message détaillé pour le support
    const message = `📦 **NOUVELLE COMMANDE PILLBOX - SUPPORT**\n\n` +
                   `🆔 Commande: #${commandeId.substring(0, 8)}\n` +
                   `📅 Date: ${new Date(commande.createdAt).toLocaleString('fr-FR')}\n` +
                   `📊 Statut: ${commande.statut}\n\n` +
                   `👤 **CLIENT**\n` +
                   `• Nom: ${commande.client.nom || 'Non spécifié'}\n` +
                   `• Tél: ${commande.client.telephone}\n` +
                   `• Quartier: ${commande.livraison.quartier}\n` +
                   `• Indications: ${commande.livraison.indications}\n\n` +
                   `🏥 **PHARMACIE**\n` +
                   `• Nom: ${commande.pharmacie.nom}\n` +
                   `• Tél: ${commande.pharmacie.telephone}\n` +
                   `• Adresse: ${commande.pharmacie.adresse || 'BP 225'}\n\n` +
                   `💊 **MÉDICAMENTS (${commande.medicaments.length})**\n`;
    
    // Ajouter les médicaments
    commande.medicaments.forEach((med, index) => {
      message += `${index + 1}. ${med.nom} × ${med.quantite} = ${med.sousTotal} FCFA\n`;
    });
    
    message += `\n💰 **FINANCIER**\n` +
               `• Médicaments: ${commande.montantTotal} FCFA\n` +
               `• Livraison: ${commande.fraisLivraison} FCFA\n` +
               `• Total: ${commande.totalFinal} FCFA\n\n` +
               `📍 **LIVRAISON**\n` +
               `• Quartier: ${commande.livraison.quartier}\n` +
                   (commande.livraison.latitude ? `• Latitude: ${commande.livraison.latitude}\n` : '') +
                   (commande.livraison.longitude ? `• Longitude: ${commande.livraison.longitude}\n` : '') +
               `• Indications: ${commande.livraison.indications}\n\n` +
               `📋 **ORDONNANCE**\n` +
               `• Nécessaire: ${commande.besoinOrdonnance ? 'OUI' : 'NON'}\n` +
               `• Validée: ${commande.ordonnanceValidee ? 'OUI' : 'NON'}\n` +
               (commande.ordonnancePhotoUrl ? `• Photo: ${commande.ordonnancePhotoUrl.substring(0, 50)}...\n` : '') +
               `\n────────────────\n` +
               `📱 **CONTACTS**\n` +
               `• Client: https://wa.me/${commande.client.telephone.replace('+', '')}\n` +
               `• Pharmacie: ${commande.pharmacie.telephone}\n` +
               (commande.livreurTelephone ? `• Livreur: ${commande.livreurTelephone}\n` : '') +
               `\n⚠️ **ACTION REQUISE**\n` +
               `Suivre cette commande et assister le client si nécessaire.`;
    
    // Envoyer au support client
    await sendTextMessage(CONFIG.SUPPORT_PHONE, message);
    
    console.log(`✅ Commande ${commandeId} envoyée au support client`);
    
    // Enregistrer l'envoi
    await db.collection('commandes').doc(commandeId).update({
      supportNotified: true,
      dateNotificationSupport: Date.now()
    });
    
  } catch (error) {
    console.error('❌ Erreur envoi commande au support:', error.message);
  }
}

// ==================== FONCTION GROQ AI ====================
async function getGroqAIResponse(userMessage, userId) {
  try {
    // Détection des questions sur les créateurs
    const messageLower = userMessage.toLowerCase();
    const creatorKeywords = [
      'qui t\'as créé', 'qui ta créé', 'qui t\'a créé', 'qui ta créé',
      'créateur', 'createur', 'qui t\'as fait', 'qui ta fait',
      'développeur', 'developpeur', 'programmeur', 'concepteur',
      'yousself', 'diabaté', 'diabate', 'delphin', 'bosse', 'toh',
      'université polytechnique', 'san pedro', 'qui sont tes créateurs',
      'qui vous a créé', 'qui t\'as développé'
    ];
    
    const isAskingAboutCreators = creatorKeywords.some(keyword => 
      messageLower.includes(keyword)
    );
    
    if (isAskingAboutCreators) {
      // Mettre à jour l'état de l'utilisateur
      const userState = userStates.get(userId) || { ...DEFAULT_STATE };
      userState.attenteVoirCreateur = true;
      userStates.set(userId, userState);
      
      return `Je suis Mia, l'assistante de Pillbox ! 🤖\n\n` +
        `Je suis fière de vous annoncer que Pillbox a été créé par deux étudiants talentueux de l'**Université Polytechnique de San Pedro** en Côte d'Ivoire :\n\n` +
        `👨‍💻 **Yousself Diabaté** - Développeur Full-Stack\n` +
        `👨‍💼 **Bossé Toh Delphin** - Architecte Solution & Gestion de projet\n\n` +
        `Ils ont conçu ce service pour faciliter l'accès aux médicaments à San Pedro.\n\n` +
        `Voulez-vous voir leur photo ?`;
    }
    
    // Réponse IA normale
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: CONFIG.GROQ_MODEL,
        messages: [
          {
            role: "system",
            content: `Tu es Mia, assistante médicale de Pillbox à San Pedro.
Règles:
1. Réponses brèves (2-3 phrases max)
2. Pas de diagnostic médical - dire "Consultez un médecin"
3. Urgences: "Contactez immédiatement le 15 ou 112"
4. Pour médicaments: orienter vers recherche ou pharmacies
5. Présente-toi: "Bonjour, je suis Mia de Pillbox!"
6. Description brève des médicaments seulement
7. Si on te demande qui t'a créé: parle des créateurs Yousself Diabaté et Bossé Toh Delphin de l'Université Polytechnique de San Pedro`
          },
          { role: "user", content: userMessage }
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

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Erreur Groq:', error.message);
    return "Désolé, je ne peux pas répondre pour le moment. Comment puis-je vous aider avec Pillbox ?";
  }
}

// ==================== MODULE D'ENVOI AUX LIVREURS ====================
const livreurManager = {
  // Temps d'attente avant rappel (5 minutes)
  RAPPEL_LIVRAISON_MS: 5 * 60 * 1000,
  
  // Tente d'envoyer la commande à un livreur
  async envoyerCommandeLivreur(commandeId, pharmacieId) {
    try {
      // 1. Récupérer les livreurs disponibles (online et vérifiés)
      const livreurs = await this.getLivreursDisponibles();
      
      if (livreurs.length === 0) {
        console.log("❌ Aucun livreur disponible");
        return { success: false, message: "Aucun livreur disponible" };
      }
      
      // 2. Récupérer les infos complètes de la commande
      const commandeDoc = await db.collection('commandes').doc(commandeId).get();
      if (!commandeDoc.exists) {
        return { success: false, message: "Commande introuvable" };
      }
      
      const commande = { id: commandeDoc.id, ...commandeDoc.data() };
      
      // 3. Récupérer les infos complètes de la pharmacie
      const pharmacieDoc = await db.collection('pharmacies').doc(pharmacieId).get();
      if (!pharmacieDoc.exists) {
        return { success: false, message: "Pharmacie introuvable" };
      }
      
      const pharmacie = pharmacieDoc.data();
      
      // 4. Sélectionner un livreur (premier disponible)
      const livreur = livreurs[0];
      
      // 5. Créer le message détaillé pour le livreur
      const messageLivreur = this.creerMessageLivreurDetaille(commande, pharmacie, livreur);
      
      // 6. Envoyer le message WhatsApp au livreur avec boutons améliorés
      await this.envoyerMessageLivreurAmeliore(livreur.telephone, messageLivreur, commandeId, pharmacie);
      
      // 7. Mettre à jour le statut de la commande
      await db.collection('commandes').doc(commandeId).update({
        statut: 'en_attente_livreur',
        livreurId: livreur.telephone,
        livreurNom: `${livreur.prenom} ${livreur.nom}`,
        livreurTelephone: livreur.telephone,
        dateEnvoiLivreur: Date.now(),
        essaisLivreurs: [{ livreurId: livreur.telephone, date: Date.now(), statut: 'en_attente' }],
        // Sauvegarder les coordonnées pour les liens Google Maps
        pharmacieCoords: pharmacie.position,
        clientCoords: commande.livraison
      });
      
      console.log(`✅ Commande ${commandeId} envoyée au livreur ${livreur.telephone}`);
      
      return { 
        success: true, 
        livreur: livreur,
        commande: commande 
      };
      
    } catch (error) {
      console.error("❌ Erreur envoi livreur:", error);
      return { success: false, message: error.message };
    }
  },
  
  // Récupère les livreurs disponibles
  async getLivreursDisponibles() {
    try {
      const snapshot = await db.collection('users')
        .where('rôle', '==', 'livreur')
        .where('isVerified', '==', true)
        .limit(5)
        .get();
      
      return snapshot.docs.map(doc => ({ 
        id: doc.id, 
        ...doc.data(),
        telephone: doc.data().telephone.startsWith('+') ? 
                  doc.data().telephone : 
                  `+225${doc.data().telephone}`
      }));
    } catch (error) {
      console.error("Erreur récupération livreurs:", error);
      return [];
    }
  },
  
  // Crée le message détaillé pour le livreur
  creerMessageLivreurDetaille(commande, pharmacie, livreur) {
    const client = commande.client;
    const montantTotal = commande.montantTotal + commande.fraisLivraison;
    const positionPharmacie = pharmacie.position;
    const positionClient = commande.livraison;
    
    // Créer les liens Google Maps
    const lienGoogleMapsPharmacie = this.creerLienGoogleMaps(
      positionPharmacie.latitude, 
      positionPharmacie.longitude, 
      pharmacie.nom
    );
    
    const lienGoogleMapsClient = this.creerLienGoogleMaps(
      positionClient.latitude, 
      positionClient.longitude, 
      "Client"
    );
    
    const lienTrajetPharmacieClient = this.creerLienTrajetGoogleMaps(
      positionPharmacie.latitude, 
      positionPharmacie.longitude,
      positionClient.latitude, 
      positionClient.longitude
    );
    
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
           `• Tél: ${client.telephone}\n` +
           `• Quartier: ${commande.livraison.quartier}\n` +
           `• Indications: ${commande.livraison.indications}\n` +
           `📍 Localisation: ${lienGoogleMapsClient}\n\n` +
           `🛣️ **TRAJET COMPLET**\n` +
           `Votre position → Pharmacie → Client\n` +
           `📍 Voir le trajet: ${lienTrajetPharmacieClient}\n\n` +
           `💬 **COMMUNICATION**\n` +
           `• Pour contacter la pharmacie: ${pharmacie.telephone}\n` +
           `• Pour contacter le client: ${client.telephone}\n\n` +
           `⏰ **À livrer dans les plus brefs délais**`;
  },
  
  // Crée un lien Google Maps
  creerLienGoogleMaps(latitude, longitude, label) {
    return `https://www.google.com/maps?q=${latitude},${longitude}&ll=${latitude},${longitude}&z=16&t=m&hl=fr`;
  },
  
  // Crée un lien de trajet Google Maps
  creerLienTrajetGoogleMaps(lat1, lon1, lat2, lon2) {
    return `https://www.google.com/maps/dir/${lat1},${lon1}/${lat2},${lon2}/`;
  },
  
  // Envoie le message WhatsApp au livreur avec boutons améliorés
  async envoyerMessageLivreurAmeliore(telephoneLivreur, message, commandeId, pharmacie) {
    try {
      const buttons = [
        {
          type: "reply",
          reply: {
            id: `accepter_${commandeId}`,
            title: "✅ Accepter"
          }
        },
        {
          type: "reply",
          reply: {
            id: `refuser_${commandeId}`,
            title: "❌ Refuser"
          }
        }
      ];
      
      await sendInteractiveMessage(telephoneLivreur, message, buttons);
      
      // Programmer un rappel après 5 minutes si pas de réponse
      setTimeout(async () => {
        await this.verifierReponseLivreur(commandeId);
      }, this.RAPPEL_LIVRAISON_MS);
      
    } catch (error) {
      console.error("Erreur envoi message livreur:", error);
    }
  },
  
  // Vérifie si le livreur a répondu
  async verifierReponseLivreur(commandeId) {
    try {
      const commandeDoc = await db.collection('commandes').doc(commandeId).get();
      if (!commandeDoc.exists) return;
      
      const commande = commandeDoc.data();
      
      // Si toujours en attente, envoyer rappel
      if (commande.statut === 'en_attente_livreur') {
        const messageRappel = `⏰ **RAPPEL - Commande #${commandeId.substring(0, 8)}**\n\n` +
                             `Veuillez accepter ou refuser cette commande.`;
        
        await sendTextMessage(commande.livreurTelephone, messageRappel);
        
        // Mettre à jour le statut
        await db.collection('commandes').doc(commandeId).update({
          rappelEnvoye: true,
          dateRappel: Date.now()
        });
      }
    } catch (error) {
      console.error("Erreur vérification réponse livreur:", error);
    }
  },
  
  // Gère la réponse du livreur
  async handleReponseLivreur(telephoneLivreur, buttonId, commandeId, reponse) {
    try {
      const commandeDoc = await db.collection('commandes').doc(commandeId).get();
      if (!commandeDoc.exists) {
        await sendTextMessage(telephoneLivreur, "❌ Commande introuvable.");
        return;
      }
      
      const commande = { id: commandeDoc.id, ...commandeDoc.data() };
      
      if (reponse === 'accepter') {
        // Livreur accepte la commande
        await db.collection('commandes').doc(commandeId).update({
          statut: 'en_cours_livraison',
          livreurAccepte: true,
          dateAcceptation: Date.now(),
          'essaisLivreurs.0.statut': 'accepte'
        });
        
        // Notifier le client
        await this.notifierClientLivraisonEnCours(commande);
        
        // Envoyer les boutons d'action au livreur
        await this.envoyerBoutonsActionLivreur(telephoneLivreur, commande);
        
        // Programmer le suivi de livraison
        setTimeout(async () => {
          await this.suiviLivraison(commandeId);
        }, this.RAPPEL_LIVRAISON_MS);
        
      } else if (reponse === 'refuser') {
        // Livreur refuse la commande
        await db.collection('commandes').doc(commandeId).update({
          livreurAccepte: false,
          livreurRefuse: true,
          dateRefus: Date.now(),
          'essaisLivreurs.0.statut': 'refuse'
        });
        
        // Envoyer message de refus au livreur
        await sendTextMessage(telephoneLivreur,
          `❌ **Commande refusée.**\n\n` +
          `Nous allons contacter un autre livreur.`
        );
        
        // Trouver un autre livreur
        await this.trouverAutreLivreur(commandeId);
      }
      
    } catch (error) {
      console.error("Erreur gestion réponse livreur:", error);
      await sendTextMessage(telephoneLivreur, "❌ Erreur système.");
    }
  },
  
  // Envoie les boutons d'action après acceptation
  async envoyerBoutonsActionLivreur(telephoneLivreur, commande) {
    try {
      const message = `✅ **Commande acceptée!**\n\n` +
        `Commande #${commande.id.substring(0, 8)}\n\n` +
        `🎯 **ÉTAPES:**\n` +
        `1. Récupérer à la pharmacie\n` +
        `2. Livrer au client\n\n` +
        `Cliquez sur les boutons ci-dessous pour chaque étape:`;
      
      const buttons = [
        {
          type: "reply",
          reply: {
            id: `aller_recuperer_${commande.id}`,
            title: "🏥 Aller récupérer"
          }
        },
        {
          type: "reply",
          reply: {
            id: `deja_recupere_${commande.id}`,
            title: "✅ Déjà récupéré"
          }
        },
        {
          type: "reply",
          reply: {
            id: `contacter_pharmacie_${commande.id}`,
            title: "📞 Contacter pharmacie"
          }
        }
      ];
      
      await sendInteractiveMessage(telephoneLivreur, message, buttons);
      
    } catch (error) {
      console.error("Erreur envoi boutons action:", error);
    }
  },
  
  // Gestion du bouton "Aller récupérer"
  async handleAllerRecuperer(telephoneLivreur, commandeId) {
    try {
      const commandeDoc = await db.collection('commandes').doc(commandeId).get();
      if (!commandeDoc.exists) return;
      
      const commande = commandeDoc.data();
      
      // Récupérer les infos de la pharmacie
      const pharmacieDoc = await db.collection('pharmacies').doc(commande.pharmacieId).get();
      if (!pharmacieDoc.exists) return;
      
      const pharmacie = pharmacieDoc.data();
      
      // Créer le lien Google Maps avec itinéraire
      const lienGoogleMaps = this.creerLienGoogleMaps(
        pharmacie.position.latitude,
        pharmacie.position.longitude,
        pharmacie.nom
      );
      
      const message = `📍 **DIRECTION PHARMACIE**\n\n` +
        `🏥 ${pharmacie.nom}\n` +
        `📞 ${pharmacie.telephone}\n` +
        `🏠 ${pharmacie.adresse || 'BP 225'}\n\n` +
        `🗺️ **ITINÉRAIRE:**\n` +
        `Cliquez sur le lien ci-dessous pour ouvrir Google Maps avec l'itinéraire:\n\n` +
        `${lienGoogleMaps}\n\n` +
        `⚠️ **INSTRUCTIONS:**\n` +
        `1. Cliquez sur le lien ci-dessus\n` +
        `2. Google Maps s'ouvrira\n` +
        `3. Appuyez sur "Itinéraire"\n` +
        `4. Choisissez votre mode de transport\n` +
        `5. Suivez les indications\n\n` +
        `Une fois sur place, appuyez sur "Déjà récupéré"`;
      
      await sendTextMessage(telephoneLivreur, message);
      
      // Mettre à jour le statut
      await db.collection('commandes').doc(commandeId).update({
        livreurEnRoutePharmacie: true,
        dateDepartPharmacie: Date.now()
      });
      
    } catch (error) {
      console.error("Erreur gestion 'aller récupérer':", error);
    }
  },
  
  // Gestion du bouton "Déjà récupéré"
  async handleDejaRecupere(telephoneLivreur, commandeId) {
    try {
      const commandeDoc = await db.collection('commandes').doc(commandeId).get();
      if (!commandeDoc.exists) return;
      
      const commande = commandeDoc.data();
      
      // Envoyer les boutons pour la livraison au client
      const message = `✅ **Médicaments récupérés!**\n\n` +
        `Direction maintenant chez le client:\n\n` +
        `👤 ${commande.client.nom}\n` +
        `📍 ${commande.livraison.quartier}\n` +
        `📞 ${commande.client.telephone}\n\n` +
        `Que souhaitez-vous faire ?`;
      
      const buttons = [
        {
          type: "reply",
          reply: {
            id: `aller_livrer_${commandeId}`,
            title: "📍 Aller livrer"
          }
        },
        {
          type: "reply",
          reply: {
            id: `contacter_client_${commandeId}`,
            title: "📞 Contacter client"
          }
        },
        {
          type: "reply",
          reply: {
            id: `probleme_recuperation_${commandeId}`,
            title: "⚠️ Problème"
          }
        }
      ];
      
      await sendInteractiveMessage(telephoneLivreur, message, buttons);
      
      // Mettre à jour le statut
      await db.collection('commandes').doc(commandeId).update({
        medicamentsRecuperes: true,
        dateRecuperation: Date.now()
      });
      
    } catch (error) {
      console.error("Erreur gestion 'déjà récupéré':", error);
    }
  },
  
  // Gestion du bouton "Aller livrer"
  async handleAllerLivrer(telephoneLivreur, commandeId) {
    try {
      const commandeDoc = await db.collection('commandes').doc(commandeId).get();
      if (!commandeDoc.exists) return;
      
      const commande = commandeDoc.data();
      const pharmacieDoc = await db.collection('pharmacies').doc(commande.pharmacieId).get();
      const pharmacie = pharmacieDoc.data();
      
      // Créer le lien Google Maps avec itinéraire depuis la pharmacie
      const lienGoogleMaps = this.creerLienTrajetGoogleMaps(
        pharmacie.position.latitude,
        pharmacie.position.longitude,
        commande.livraison.latitude,
        commande.livraison.longitude
      );
      
      const message = `📍 **DIRECTION CLIENT**\n\n` +
        `👤 ${commande.client.nom}\n` +
        `📞 ${commande.client.telephone}\n` +
        `🏠 ${commande.livraison.quartier}\n` +
        `📝 ${commande.livraison.indications}\n\n` +
        `🗺️ **ITINÉRAIRE depuis la pharmacie:**\n` +
        `Cliquez sur le lien ci-dessous pour ouvrir Google Maps:\n\n` +
        `${lienGoogleMaps}\n\n` +
        `⚠️ **INSTRUCTIONS:**\n` +
        `1. Cliquez sur le lien ci-dessus\n` +
        `2. Google Maps s'ouvrira avec l'itinéraire\n` +
        `3. Appuyez sur "Démarrer"\n` +
        `4. Suivez les indications\n\n` +
        `Une fois sur place, appuyez sur "Déjà livré"`;
      
      await sendTextMessage(telephoneLivreur, message);
      
      // Mettre à jour le statut
      await db.collection('commandes').doc(commandeId).update({
        livreurEnRouteClient: true,
        dateDepartClient: Date.now()
      });
      
    } catch (error) {
      console.error("Erreur gestion 'aller livrer':", error);
    }
  },
  
  // Notifie le client que la livraison est en cours
  async notifierClientLivraisonEnCours(commande) {
    try {
      const message = `🚗 **LIVRAISON EN COURS!**\n\n` +
        `Votre commande #${commande.id.substring(0, 8)} a été acceptée par un livreur.\n\n` +
        `👤 **Votre livreur:**\n` +
        `• Nom: ${commande.livreurNom}\n` +
        `• Tél: ${commande.livreurTelephone}\n\n` +
        `🏥 **Pharmacie:** ${commande.pharmacieNom}\n\n` +
        `💬 **Vous pouvez communiquer avec votre livreur directement sur WhatsApp:**\n` +
        `Cliquez ici pour envoyer un message: https://wa.me/${commande.livreurTelephone.replace('+', '')}\n\n` +
        `📱 Ou répondez à ce message (il sera transféré au livreur).`;
      
      await sendTextMessage(commande.client.telephone, message);
      
      // Mettre à jour pour activer le chat
      await db.collection('commandes').doc(commande.id).update({
        chatActive: true,
        notifications: {
          clientNotified: true,
          dateNotification: Date.now()
        }
      });
    } catch (error) {
      console.error("Erreur notification client:", error);
    }
  },
  
  // Trouve un autre livreur si refus
  async trouverAutreLivreur(commandeId) {
    try {
      const commandeDoc = await db.collection('commandes').doc(commandeId).get();
      if (!commandeDoc.exists) return;
      
      const commande = commandeDoc.data();
      const essaisLivreurs = commande.essaisLivreurs || [];
      
      // Récupérer les livreurs déjà contactés
      const livreursContactes = essaisLivreurs.map(e => e.livreurId);
      
      // Trouver un nouveau livreur
      const tousLivreurs = await this.getLivreursDisponibles();
      const nouveauLivreur = tousLivreurs.find(l => 
        !livreursContactes.includes(l.telephone)
      );
      
      if (nouveauLivreur) {
        // Ajouter à la liste des essais
        const nouveauxEssais = [
          ...essaisLivreurs,
          { livreurId: nouveauLivreur.telephone, date: Date.now(), statut: 'en_attente' }
        ];
        
        await db.collection('commandes').doc(commandeId).update({
          livreurId: nouveauLivreur.telephone,
          livreurNom: `${nouveauLivreur.prenom} ${nouveauLivreur.nom}`,
          livreurTelephone: nouveauLivreur.telephone,
          essaisLivreurs: nouveauxEssais
        });
        
        // Renvoyer la commande au nouveau livreur
        await this.envoyerCommandeLivreur(commandeId, commande.pharmacieId);
        
      } else {
        // Aucun autre livreur disponible
        await db.collection('commandes').doc(commandeId).update({
          statut: 'annulee',
          raisonAnnulation: 'Aucun livreur disponible'
        });
        
        // Notifier la pharmacie et le client
        await notifierAnnulationCommande(commandeId, 'Aucun livreur disponible');
      }
      
    } catch (error) {
      console.error("Erreur recherche autre livreur:", error);
    }
  },
  
  // Suivi de la livraison
  async suiviLivraison(commandeId) {
    try {
      const commandeDoc = await db.collection('commandes').doc(commandeId).get();
      if (!commandeDoc.exists) return;
      
      const commande = commandeDoc.data();
      
      // Si toujours en cours de livraison, demander au livreur
      if (commande.statut === 'en_cours_livraison') {
        const buttons = [
          {
            type: "reply",
            reply: {
              id: `deja_livre_${commandeId}`,
              title: "✅ Déjà livré"
            }
          },
          {
            type: "reply",
            reply: {
              id: `en_route_${commandeId}`,
              title: "🚗 En route"
            }
          }
        ];
        
        await sendInteractiveMessage(commande.livreurTelephone,
          `⏰ **SUIVI LIVRAISON**\n\n` +
          `Commande #${commandeId.substring(0, 8)}\n` +
          `Avez-vous déjà livré cette commande ?`,
          buttons
        );
      }
    } catch (error) {
      console.error("Erreur suivi livraison:", error);
    }
  },
  
  // Gestion livraison confirmée
  async handleLivraisonConfirmee(commandeId, telephoneLivreur) {
    try {
      // Mettre à jour le statut
      await db.collection('commandes').doc(commandeId).update({
        statut: 'livree',
        dateLivraison: Date.now(),
        livreurConfirmeLivraison: true
      });
      
      // Notifier le client
      await notifierClientLivraisonTerminee(commandeId);
      
      // Envoyer au support client
      await envoyerCommandeAuSupport(commandeId);
      
      // Demander au client de noter le service
      await demanderNotationService(commandeId);
      
      // Message au livreur
      await sendTextMessage(telephoneLivreur,
        `✅ **Livraison confirmée!**\n\n` +
        `Merci pour votre service. La commande #${commandeId.substring(0, 8)} est marquée comme livrée.\n\n` +
        `Le client sera invité à noter le service.`
      );
      
    } catch (error) {
      console.error("Erreur confirmation livraison:", error);
    }
  },
  
  // Gestion du bouton "Contacter pharmacie"
  async handleContacterPharmacie(telephoneLivreur, commandeId) {
    try {
      const commandeDoc = await db.collection('commandes').doc(commandeId).get();
      if (!commandeDoc.exists) return;
      
      const commande = commandeDoc.data();
      const pharmacieDoc = await db.collection('pharmacies').doc(commande.pharmacieId).get();
      const pharmacie = pharmacieDoc.data();
      
      const message = `📞 **CONTACTER LA PHARMACIE**\n\n` +
        `🏥 ${pharmacie.nom}\n` +
        `📞 ${pharmacie.telephone}\n\n` +
        `💬 **Pour contacter la pharmacie:**\n` +
        `1. Cliquez sur ce lien: https://wa.me/${pharmacie.telephone.replace('+', '')}\n` +
        `2. Ou composez: ${pharmacie.telephone}\n\n` +
        `**Informations à donner:**\n` +
        `• Votre nom: ${commande.livreurNom}\n` +
        `• Numéro commande: #${commandeId.substring(0, 8)}\n` +
        `• Vous êtes le livreur Pillbox`;
      
      await sendTextMessage(telephoneLivreur, message);
      
    } catch (error) {
      console.error("Erreur gestion 'contacter pharmacie':", error);
    }
  },
  
  // Gestion du bouton "Contacter client"
  async handleContacterClient(telephoneLivreur, commandeId) {
    try {
      const commandeDoc = await db.collection('commandes').doc(commandeId).get();
      if (!commandeDoc.exists) return;
      
      const commande = commandeDoc.data();
      
      const message = `📞 **CONTACTER LE CLIENT**\n\n` +
        `👤 ${commande.client.nom}\n` +
        `📞 ${commande.client.telephone}\n\n` +
        `💬 **Pour contacter le client:**\n` +
        `1. Cliquez sur ce lien: https://wa.me/${commande.client.telephone.replace('+', '')}\n` +
        `2. Ou composez: ${commande.client.telephone}\n\n` +
        `**Informations à donner:**\n` +
        `• Votre nom: ${commande.livreurNom}\n` +
        `• Vous êtes le livreur Pillbox\n` +
        `• Numéro commande: #${commandeId.substring(0, 8)}\n` +
        `• ETA: [Indiquez votre heure d'arrivée estimée]`;
      
      await sendTextMessage(telephoneLivreur, message);
      
    } catch (error) {
      console.error("Erreur gestion 'contacter client':", error);
    }
  },
  
  // Gestion du chat entre client et livreur
  async handleChatClientLivreur(message, from, to) {
    try {
      // Vérifier si c'est une conversation liée à une commande
      const commandesSnapshot = await db.collection('commandes')
        .where('chatActive', '==', true)
        .get();
      
      for (const doc of commandesSnapshot.docs) {
        const commande = doc.data();
        
        // Vérifier si l'expéditeur est le client ou le livreur
        const isClient = from === commande.client.telephone;
        const isLivreur = from === commande.livreurTelephone;
        
        if (isClient || isLivreur) {
          // Déterminer le destinataire
          const destinataire = isClient ? commande.livreurTelephone : commande.client.telephone;
          const expediteurNom = isClient ? commande.client.nom : commande.livreurNom;
          
          // Enregistrer le message dans l'historique
          await db.collection('chats').add({
            commandeId: doc.id,
            expediteur: from,
            destinataire: destinataire,
            expediteurNom: expediteurNom,
            message: message,
            timestamp: Date.now(),
            type: 'text'
          });
          
          // Transférer le message avec typing indicator
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

// ==================== MODULE DE VALIDATION PHARMACIE ====================
const pharmacieValidator = {
  // Envoie l'ordonnance à la pharmacie pour validation
  async envoyerOrdonnancePharmacie(commandeId, photoUrl, pharmacieId) {
    try {
      // Récupérer la pharmacie
      const pharmacieDoc = await db.collection('pharmacies').doc(pharmacieId).get();
      if (!pharmacieDoc.exists) {
        return { success: false, message: "Pharmacie introuvable" };
      }
      
      const pharmacie = pharmacieDoc.data();
      
      // Créer le message pour la pharmacie
      const message = this.creerMessageValidation(commandeId, photoUrl);
      
      // Envoyer le message avec photo et boutons
      await this.envoyerMessagePharmacie(pharmacie.telephone, message, photoUrl, commandeId);
      
      // Mettre à jour la commande
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
  
  // Crée le message de validation
  creerMessageValidation(commandeId, photoUrl) {
    return `🏥 **VALIDATION D'ORDONNANCE**\n\n` +
           `Une nouvelle ordonnance nécessite votre validation.\n\n` +
           `🆔 Commande: #${commandeId.substring(0, 8)}\n\n` +
           `Veuillez vérifier l'ordonnance ci-jointe et valider ou refuser la commande.`;
  },
  
  // Envoie le message à la pharmacie
  async envoyerMessagePharmacie(telephonePharmacie, message, photoUrl, commandeId) {
    try {
      // D'abord envoyer la photo
      await axios.post(
        `https://graph.facebook.com/v19.0/${CONFIG.PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: telephonePharmacie,
          type: "image",
          image: { 
            link: photoUrl,
            caption: "📋 Ordonnance du client"
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      // Ensuite envoyer les boutons de validation
      const buttons = [
        {
          type: "reply",
          reply: {
            id: `valider_ordonnance_${commandeId}`,
            title: "✅ Valider"
          }
        },
        {
          type: "reply",
          reply: {
            id: `refuser_ordonnance_${commandeId}`,
            title: "❌ Refuser"
          }
        }
      ];
      
      await sendInteractiveMessage(telephonePharmacie, message, buttons);
      
    } catch (error) {
      console.error("Erreur envoi message pharmacie:", error);
    }
  },
  
  // Gère la réponse de la pharmacie
  async handleReponsePharmacie(telephonePharmacie, buttonId, commandeId, reponse) {
    try {
      const commandeDoc = await db.collection('commandes').doc(commandeId).get();
      if (!commandeDoc.exists) {
        await sendTextMessage(telephonePharmacie, "❌ Commande introuvable.");
        return;
      }
      
      const commande = { id: commandeDoc.id, ...commandeDoc.data() };
      
      if (reponse === 'valider') {
        // Pharmacie valide l'ordonnance
        await db.collection('commandes').doc(commandeId).update({
          statut: 'ordonnance_validee',
          ordonnanceValidee: true,
          pharmacieValidee: true,
          dateValidation: Date.now()
        });
        
        // Notifier le client
        await notifierClientValidationOrdonnance(commandeId, true);
        
        // Envoyer au support client
        await envoyerCommandeAuSupport(commandeId);
        
        // Envoyer à un livreur
        await livreurManager.envoyerCommandeLivreur(commandeId, commande.pharmacieId);
        
        // Confirmation à la pharmacie
        await sendTextMessage(telephonePharmacie,
          `✅ **Ordonnance validée!**\n\n` +
          `La commande #${commandeId.substring(0, 8)} a été validée.\n` +
          `Un livreur va venir récupérer les médicaments.\n\n` +
          `Merci pour votre validation.`
        );
        
      } else if (reponse === 'refuser') {
        // Pharmacie refuse l'ordonnance
        await db.collection('commandes').doc(commandeId).update({
          statut: 'ordonnance_refusee',
          ordonnanceValidee: false,
          pharmacieValidee: false,
          dateRefus: Date.now()
        });
        
        // Notifier le client
        await notifierClientValidationOrdonnance(commandeId, false);
        
        // Trouver une autre pharmacie de garde
        await this.trouverAutrePharmacie(commandeId);
        
        // Message à la pharmacie
        await sendTextMessage(telephonePharmacie,
          `❌ **Ordonnance refusée.**\n\n` +
          `La commande a été transférée à une autre pharmacie.\n` +
          `Merci pour votre vérification.`
        );
      }
      
    } catch (error) {
      console.error("Erreur gestion réponse pharmacie:", error);
    }
  },
  
  // Trouve une autre pharmacie si refus
  async trouverAutrePharmacie(commandeId) {
    try {
      const commandeDoc = await db.collection('commandes').doc(commandeId).get();
      if (!commandeDoc.exists) return;
      
      const commande = commandeDoc.data();
      
      // Trouver d'autres pharmacies de garde
      const autresPharmacies = await getPharmaciesDeGarde();
      const autresPharmaciesDispo = autresPharmacies.filter(p => p.id !== commande.pharmacieId);
      
      if (autresPharmaciesDispo.length > 0) {
        const nouvellePharmacie = autresPharmaciesDispo[0];
        
        // Mettre à jour la commande avec la nouvelle pharmacie
        await db.collection('commandes').doc(commandeId).update({
          pharmacieId: nouvellePharmacie.id,
          pharmacieNom: nouvellePharmacie.nom,
          statut: 'en_validation_pharmacie',
          pharmaciePrecedente: commande.pharmacieId
        });
        
        // Renvoyer l'ordonnance à la nouvelle pharmacie
        await this.envoyerOrdonnancePharmacie(
          commandeId, 
          commande.ordonnancePhotoUrl, 
          nouvellePharmacie.id
        );
        
        // Notifier le client du transfert
        await sendTextMessage(commande.client.telephone,
          `🔄 **Transfert à une autre pharmacie**\n\n` +
          `La pharmacie précédente a refusé l'ordonnance.\n` +
          `Nous avons transféré votre commande à une autre pharmacie de garde.\n\n` +
          `Nouvelle pharmacie: ${nouvellePharmacie.nom}\n` +
          `Tél: ${nouvellePharmacie.telephone}\n\n` +
          `Attente de validation...`
        );
        
      } else {
        // Aucune autre pharmacie disponible
        await db.collection('commandes').doc(commandeId).update({
          statut: 'annulee',
          raisonAnnulation: 'Aucune pharmacie disponible'
        });
        
        await sendTextMessage(commande.client.telephone,
          `❌ **Commande annulée**\n\n` +
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

// ==================== MODULE GESTION PANIER ====================
const panierManager = {
  // Vérifie si le panier peut accepter un médicament d'une autre pharmacie
  async peutAjouterMedicament(userId, medicamentId) {
    try {
      const medicamentDoc = await db.collection('medicaments').doc(medicamentId).get();
      if (!medicamentDoc.exists) {
        return { allowed: false, message: "Médicament introuvable" };
      }
      
      const medicament = { id: medicamentDoc.id, ...medicamentDoc.data() };
      const userState = userStates.get(userId) || { ...DEFAULT_STATE };
      
      // 1. Vérifier si le médicament nécessite une ordonnance
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
      
      // 2. Vérifier la compatibilité pharmacie
      if (userState.panier.length > 0) {
        // Vérifier si c'est de la même pharmacie
        if (userState.pharmacieId && userState.pharmacieId !== medicament.pharmacieId) {
          return { 
            allowed: false, 
            message: `❌ **Pharmacie différente**\n\n` +
                    `Votre panier contient déjà des médicaments de la pharmacie "${userState.pharmacieNom}".\n\n` +
                    `Veuillez d'abord vider votre panier ou finaliser votre commande avant de commander dans une autre pharmacie.`
          };
        }
      }
      
      // 3. Vérifier le stock
      if (medicament.stock < 1) {
        return { 
          allowed: false, 
          message: `❌ **Stock insuffisant**\n\n` +
                  `Il ne reste plus de stock pour "${medicament.nom}".\n\n` +
                  `Stock disponible: ${medicament.stock} unité(s)`
        };
      }
      
      return { allowed: true, medicament: medicament };
      
    } catch (error) {
      console.error("Erreur vérification médicament:", error);
      return { allowed: false, message: "Erreur système lors de la vérification" };
    }
  },
  
  // Ajoute un médicament au panier avec vérification
  async ajouterAuPanier(userId, medicamentId, quantite = 1) {
    try {
      // Vérifier d'abord si le médicament peut être ajouté
      const verification = await this.peutAjouterMedicament(userId, medicamentId);
      
      if (!verification.allowed) {
        return { success: false, message: verification.message };
      }
      
      const medicament = verification.medicament;
      const userState = userStates.get(userId) || { ...DEFAULT_STATE };
      
      // Vérifier le stock pour la quantité demandée
      if (medicament.stock < quantite) {
        return { 
          success: false, 
          message: `❌ **Stock insuffisant**\n\n` +
                  `Vous demandez ${quantite} unité(s) mais il ne reste que ${medicament.stock} unité(s) disponible(s).` 
        };
      }
      
      // Mettre à jour l'état utilisateur
      if (userState.panier.length === 0) {
        // Premier médicament, définir la pharmacie
        userState.pharmacieId = medicament.pharmacieId;
        
        // Récupérer le nom de la pharmacie
        const pharmacieDoc = await db.collection('pharmacies').doc(medicament.pharmacieId).get();
        if (pharmacieDoc.exists) {
          userState.pharmacieNom = pharmacieDoc.data().nom;
        }
      }
      
      // Vérifier si le médicament est déjà dans le panier
      const indexExist = userState.panier.findIndex(item => item.id === medicamentId);
      
      if (indexExist !== -1) {
        // Mettre à jour la quantité
        userState.panier[indexExist].quantite += quantite;
      } else {
        // Ajouter le nouveau médicament
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
      
      // Mettre à jour le besoin d'ordonnance
      if (medicament.necessiteOrdonnance) {
        userState.besoinOrdonnance = true;
      }
      
      userStates.set(userId, userState);
      
      return { 
        success: true, 
        message: `✅ **${medicament.nom} ajouté au panier**\n\n` +
                `Quantité: ${quantite}\n` +
                `Pharmacie: ${userState.pharmacieNom}\n` +
                `Prix unitaire: ${medicament.prix} FCFA\n` +
                `Sous-total: ${medicament.prix * quantite} FCFA\n\n` +
                (medicament.necessiteOrdonnance ? 
                  `⚠️ **Ordonnance requise**\nVous devrez envoyer une photo de votre ordonnance lors du paiement.\n\n` : ''),
        panier: userState.panier,
        pharmacie: { id: userState.pharmacieId, nom: userState.pharmacieNom }
      };
      
    } catch (error) {
      console.error("Erreur ajout panier:", error);
      return { success: false, message: "❌ Erreur système lors de l'ajout au panier" };
    }
  },
  
  // Nouvelle fonction pour gérer l'envoi d'ordonnance
  async demanderOrdonnance(userId) {
    try {
      const userState = userStates.get(userId) || { ...DEFAULT_STATE };
      
      // Vérifier si le panier contient des médicaments nécessitant une ordonnance
      const medicamentsAvecOrdonnance = userState.panier.filter(item => item.necessiteOrdonnance);
      
      if (medicamentsAvecOrdonnance.length === 0) {
        return { 
          success: false, 
          message: "Aucun médicament nécessitant une ordonnance dans votre panier." 
        };
      }
      
      // Créer la liste des médicaments nécessitant une ordonnance
      let listeMedicaments = "📋 **Médicaments nécessitant une ordonnance:**\n\n";
      medicamentsAvecOrdonnance.forEach((med, index) => {
        listeMedicaments += `${index + 1}. **${med.nom}**\n`;
        if (med.dosage) listeMedicaments += `   💊 Dosage: ${med.dosage}\n`;
        if (med.forme) listeMedicaments += `   📦 Forme: ${med.forme}\n`;
        listeMedicaments += `   📦 Quantité: ${med.quantite}\n\n`;
      });
      
      // Demander l'ordonnance
      return {
        success: true,
        message: listeMedicaments +
                "📸 **Envoyez maintenant une photo de votre ordonnance**\n\n" +
                "**Instructions:**\n" +
                "1. Cliquez sur 📎 (attache)\n" +
                "2. Sélectionnez 'Galerie' ou 'Appareil photo'\n" +
                "3. Prenez une photo NETTE de votre ordonnance\n\n" +
                "⚠️ **Assurez-vous que:**\n" +
                "• La photo est bien nette\n" +
                "• Toutes les informations sont visibles\n" +
                "• Le nom du médecin est lisible\n" +
                "• La date est visible\n" +
                "• Votre nom est visible"
      };
      
    } catch (error) {
      console.error("Erreur demande ordonnance:", error);
      return { success: false, message: "Erreur système" };
    }
  },
  
  // Affiche le panier avec toutes les infos
  async afficherPanier(userId) {
    const userState = userStates.get(userId) || { ...DEFAULT_STATE };
    
    if (userState.panier.length === 0) {
      return "🛒 Votre panier est vide.";
    }
    
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
    
    // Ajouter les frais de livraison estimés
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

// ==================== FONCTIONS DE NOTIFICATION ====================
async function notifierClientLivraisonTerminee(commandeId) {
  try {
    const commandeDoc = await db.collection('commandes').doc(commandeId).get();
    if (!commandeDoc.exists) return;
    
    const commande = commandeDoc.data();
    
    await sendTextMessage(commande.client.telephone,
      `✅ **Livraison effectuée!**\n\n` +
      `Votre commande #${commandeId.substring(0, 8)} a été livrée avec succès.\n\n` +
      `Merci d'avoir utilisé Pillbox! 💊`
    );
  } catch (error) {
    console.error("Erreur notification livraison terminée:", error);
  }
}

async function notifierClientValidationOrdonnance(commandeId, validee) {
  try {
    const commandeDoc = await db.collection('commandes').doc(commandeId).get();
    if (!commandeDoc.exists) return;
    
    const commande = commandeDoc.data();
    
    if (validee) {
      await sendTextMessage(commande.client.telephone,
        `✅ **Ordonnance validée!**\n\n` +
        `Votre ordonnance a été validée par la pharmacie ${commande.pharmacieNom}.\n\n` +
        `Un livreur va être assigné à votre commande.\n\n` +
        `Merci pour votre patience.`
      );
    } else {
      await sendTextMessage(commande.client.telephone,
        `❌ **Ordonnance refusée**\n\n` +
        `La pharmacie a refusé votre ordonnance.\n\n` +
        `Nous transférons votre commande à une autre pharmacie de garde.\n\n` +
        `Nous vous recontacterons sous peu.`
      );
    }
  } catch (error) {
    console.error("Erreur notification validation ordonnance:", error);
  }
}

async function notifierAnnulationCommande(commandeId, raison) {
  try {
    const commandeDoc = await db.collection('commandes').doc(commandeId).get();
    if (!commandeDoc.exists) return;
    
    const commande = commandeDoc.data();
    
    await sendTextMessage(commande.client.telephone,
      `❌ **Commande annulée**\n\n` +
      `Votre commande #${commandeId.substring(0, 8)} a été annulée.\n\n` +
      `Raison: ${raison}\n\n` +
      `Nous sommes désolés pour ce désagrément.\n` +
      `📞 Contactez-nous: ${CONFIG.SUPPORT_PHONE}`
    );
  } catch (error) {
    console.error("Erreur notification annulation:", error);
  }
}

async function demanderNotationService(commandeId) {
  try {
    const commandeDoc = await db.collection('commandes').doc(commandeId).get();
    if (!commandeDoc.exists) return;
    
    const commande = commandeDoc.data();
    
    const buttons = [
      { type: "reply", reply: { id: `note_5_${commandeId}`, title: "⭐ 5/5" } },
      { type: "reply", reply: { id: `note_4_${commandeId}`, title: "⭐ 4/5" } },
      { type: "reply", reply: { id: `note_3_${commandeId}`, title: "⭐ 3/5" } },
      { type: "reply", reply: { id: `note_2_${commandeId}`, title: "⭐ 2/5" } },
      { type: "reply", reply: { id: `note_1_${commandeId}`, title: "⭐ 1/5" } }
    ];
    
    await sendInteractiveMessage(commande.client.telephone,
      `⭐ **NOTER LE SERVICE**\n\n` +
      `Comment évaluez-vous la livraison de votre commande ?\n\n` +
      `Votre avis nous aide à améliorer Pillbox!`,
      buttons
    );
  } catch (error) {
    console.error("Erreur demande notation:", error);
  }
}

async function enregistrerNote(commandeId, note, telephoneClient) {
  try {
    await db.collection('commandes').doc(commandeId).update({
      noteClient: note,
      dateNotation: Date.now(),
      noteEnregistree: true
    });
    
    // Enregistrer la note dans la collection des avis
    await db.collection('avis').add({
      commandeId: commandeId,
      telephoneClient: telephoneClient,
      note: note,
      date: Date.now(),
      type: 'livraison'
    });
    
    await sendTextMessage(telephoneClient,
      `⭐ **Merci pour votre note de ${note}/5!**\n\n` +
      `Votre avis nous aide à améliorer notre service.\n\n` +
      `À bientôt sur Pillbox! 💊`
    );
    
    // Retour au menu principal
    const userState = userStates.get(telephoneClient) || { ...DEFAULT_STATE };
    await handleMenuPrincipal(telephoneClient, userState);
    
  } catch (error) {
    console.error("Erreur enregistrement note:", error);
  }
}

// ==================== FONCTION CRÉATION COMMANDE ====================
async function creerCommandeComplet(userId, userState, totalPanier, fraisLivraison) {
  const commandeId = uuidv4();
  const timestamp = Date.now();
  
  // Récupérer les infos du médicament pour la pharmacie
  const medicamentsDetails = await Promise.all(
    userState.panier.map(async (item) => {
      const medicamentDoc = await db.collection('medicaments').doc(item.id).get();
      const medicament = medicamentDoc.data();
      return {
        id: item.id,
        nom: item.nom,
        prix: item.prix,
        quantite: item.quantite,
        sousTotal: item.prix * item.quantite,
        necessiteOrdonnance: medicament?.necessiteOrdonnance || false,
        dosage: medicament?.dosage,
        forme: medicament?.forme
      };
    })
  );
  
  // Récupérer les infos COMPLÈTES de la pharmacie
  const pharmacieDoc = await db.collection('pharmacies').doc(userState.pharmacieId).get();
  const pharmacie = pharmacieDoc.data();
  
  const commandeData = {
    id: commandeId,
    client: {
      telephone: userId,
      nom: userState.nom || 'Client WhatsApp',
      quartier: userState.quartier
    },
    pharmacie: {
      id: userState.pharmacieId,
      nom: userState.pharmacieNom || pharmacie?.nom,
      telephone: pharmacie?.telephone,
      adresse: pharmacie?.adresse || 'BP 225',
      position: pharmacie?.position || { latitude: 0, longitude: 0 },
      horaires: pharmacie?.horaires || '24h/24'
    },
    medicaments: medicamentsDetails,
    montantTotal: totalPanier,
    fraisLivraison: fraisLivraison,
    totalFinal: totalPanier + fraisLivraison,
    livraison: {
      quartier: userState.quartier,
      indications: userState.indications,
      latitude: userState.location?.latitude,
      longitude: userState.location?.longitude
    },
    besoinOrdonnance: userState.besoinOrdonnance,
    ordonnancePhotoUrl: userState.ordonnancePhotoUrl,
    ordonnanceValidee: userState.ordonnanceValidee,
    statut: userState.besoinOrdonnance ? 'en_validation_pharmacie' : 'en_attente_livreur',
    createdAt: timestamp,
    updatedAt: timestamp,
    etapesLivraison: {
      acceptee: false,
      enRoutePharmacie: false,
      medicamentsRecuperes: false,
      enRouteClient: false,
      livree: false
    },
    chatActive: false,
    notifications: {
      clientNotified: false,
      livreurNotified: false,
      supportNotified: false
    }
  };
  
  await db.collection('commandes').doc(commandeId).set(commandeData);
  
  // Mettre à jour les stocks
  for (const item of userState.panier) {
    await updateStock(item.id, item.quantite);
  }
  
  // ENVOYER LA COMMANDE AU SUPPORT CLIENT IMMÉDIATEMENT
  await envoyerCommandeAuSupport(commandeId);
  
  return commandeId;
}

// ==================== GESTION DES MESSAGES ====================
async function handleTextMessage(from, text, userState) {
  // Vérifier si c'est la première interaction
  if (!userState.initialized) {
    // Envoyer le message de bienvenue avec typing indicator
    await sendTypingIndicator(from, 1500);
    
    // Message de présentation de Mia avec bouton support
    const welcomeButtons = [
      {
        type: "reply",
        reply: {
          id: "ouvrir_support",
          title: "📞 Contacter le support"
        }
      },
      {
        type: "reply",
        reply: {
          id: "commencer_commande",
          title: "💊 Commander maintenant"
        }
      }
    ];
    
    await sendInteractiveMessage(from,
      "💊 **Bonjour, je suis Mia de Pillbox!** 🤖\n\n" +
      "Votre assistante médicale pour commander des médicaments à San Pedro.\n\n" +
      "✨ **Services disponibles:**\n" +
      "• Commandes avec/sans ordonnance\n" +
      "• Pharmacies de garde 24h/24\n" +
      "• Livraison rapide à domicile\n" +
      "• Identification de médicaments par photo\n\n" +
      "⚠️ **Important:**\n" +
      "• Ce service ne remplace pas une consultation médicale\n" +
      "• En cas d'urgence: composez le 15 (SAMU) ou 112 IMMÉDIATEMENT\n\n" +
      "Choisissez une option pour commencer :",
      welcomeButtons
    );
    
    userState.initialized = true;
    userStates.set(from, userState);
    return;
  }
  
  // Vérifier si c'est un message de chat client-livreur
  const isChatMessage = await livreurManager.handleChatClientLivreur(text, from, null);
  if (isChatMessage) {
    return;
  }
  
  // Vérifier si l'utilisateur veut voir les créateurs
  if (userState.attenteVoirCreateur) {
    const responseLower = text.toLowerCase();
    if (responseLower.includes('oui') || responseLower.includes('ok') || 
        responseLower.includes('d\'accord') || responseLower.includes('yes')) {
      await showCreatorsOptions(from);
    } else {
      await sendTextMessage(from, "D'accord, à votre service ! 💊");
      await handleMenuPrincipal(from, userState);
    }
    userState.attenteVoirCreateur = false;
    return;
  }
  
  // Gestion des sélections numériques pour les listes
  if (userState.step === 'SELECTION_MEDICAMENT_CATEGORIE' || 
      userState.step === 'SELECTION_MEDICAMENT_RECHERCHE') {
    
    const num = parseInt(text.trim());
    
    if (isNaN(num) || num < 1) {
      await sendTextMessage(from, "❌ Veuillez saisir un numéro valide.");
      return;
    }
    
    const listeMedicaments = userState.step === 'SELECTION_MEDICAMENT_CATEGORIE' 
      ? userState.listeMedicamentsCategorie 
      : userState.listeMedicamentsRecherche;
    
    if (num > listeMedicaments.length) {
      await sendTextMessage(from, `❌ Veuillez choisir un numéro entre 1 et ${listeMedicaments.length}.`);
      return;
    }
    
    const medicamentId = listeMedicaments[num - 1];
    await showDetailMedicament(from, medicamentId, userState);
    
    // Réinitialiser l'état
    userState.step = 'MENU_PRINCIPAL';
    userStates.set(from, userState);
    return;
  }
  
  // Gestion selon l'étape en cours
  switch (userState.step) {
    case 'RECHERCHE_NOM':
      await handleRechercheNom(from, text, userState);
      break;
      
    case 'QUANTITE_MEDICAMENT':
      await confirmerAjoutPanier(from, text, userState);
      break;
      
    case 'ATTENTE_INFOS_LIVRAISON':
      await traiterInfosLivraison(from, text, userState);
      break;
      
    case 'ATTENTE_PHOTO_ORDONNANCE':
      await sendTextMessage(from,
        "❌ **Photo requise**\n\n" +
        "Veuillez envoyer une PHOTO de votre ordonnance.\n\n" +
        "Cliquez sur 📎 (attache) → Galerie → Sélectionnez la photo"
      );
      break;
      
    case 'CONFIRMATION_SANS_ORDONNANCE':
      if (text.toLowerCase().includes('oui') || text.toLowerCase().includes('ok')) {
        userState.ordonnanceValidee = true;
        if (!userState.location) {
          await sendTextMessage(from, "📍 **Localisation requise**\n\nVeuillez partager votre localisation.");
          userState.step = 'ATTENTE_LOCALISATION_LIVRAISON';
        } else {
          await sendTextMessage(from, "🏠 **Informations de livraison**\n\nVeuillez préciser quartier et indications.");
          userState.step = 'ATTENTE_INFOS_LIVRAISON';
        }
      } else {
        await sendTextMessage(from, "❌ Commande annulée.");
        await handleMenuPrincipal(from, userState);
      }
      break;
      
    default:
      // Pour les messages non gérés, utiliser l'IA avec typing indicator
      await sendTypingIndicator(from, 2000);
      const response = await getGroqAIResponse(text, from);
      if (response) {
        await sendTextMessage(from, response);
      }
      await handleMenuPrincipal(from, userState);
  }
}

async function handleImageMessage(from, imageId, userState) {
  // Récupérer l'URL de l'image
  const imageUrl = await getWhatsAppMediaUrl(imageId);
  
  if (userState.step === 'ATTENTE_PHOTO_MEDICAMENT') {
    await analyserImageMedicament(from, imageUrl, userState);
  } else if (userState.attentePhoto) {
    // Cas 1: Image d'ordonnance
    userState.ordonnancePhotoUrl = imageUrl;
    userState.attentePhoto = false;
    
    await sendTextMessage(from,
      "✅ **Ordonnance reçue**\n\n" +
      "Votre ordonnance a été envoyée à la pharmacie pour validation.\n" +
      "Vous recevrez une confirmation sous peu.\n\n" +
      "⏳ **En attente de validation...**"
    );
    
    await processCheckout(from, userState);
  } else {
    // Cas par défaut: Image d'un médicament pour identification
    await analyserImageMedicament(from, imageUrl, userState);
  }
}

async function analyserImageMedicament(from, imageUrl, userState) {
  try {
    await sendTextMessage(from, "🔍 **Analyse de l'image en cours...**\n\nPatientez quelques secondes.");
    
    // Simuler le typing pendant l'analyse
    await sendTypingIndicator(from, 4000);
    
    const aiResponse = "📸 **Médicament identifié:**\nParacétamol 500mg\n\n💊 **Catégorie:** Douleurs-Fièvre\n📋 **Ordonnance:** Non requise\n⚠️ **Conseil:** 1 comprimé toutes les 6 heures\n\nQue souhaitez-vous faire ?";
    
    const buttons = [
      { type: "reply", reply: { id: "rechercher_medicament", title: "🔍 Rechercher ce médicament" } },
      { type: "reply", reply: { id: "commander_sans_ordonnance", title: "💊 Commander (sans ordonnance)" } },
      { type: "reply", reply: { id: "retour_menu", title: "🔙 Retour menu" } }
    ];
    
    await sendInteractiveMessage(from,
      aiResponse,
      buttons
    );
    
  } catch (error) {
    console.error('Erreur analyse image:', error);
    await sendTextMessage(from,
      "❌ **Impossible d'analyser l'image**\n\n" +
      "Veuillez essayer avec une photo plus nette ou utilisez la recherche par nom."
    );
    await handleMenuPrincipal(from, userState);
  }
}

async function handleLocationMessage(from, location, userState) {
  const { latitude, longitude } = location;
  
  if (!isInSanPedro(latitude, longitude)) {
    await sendTextMessage(from,
      "❌ **Hors zone de livraison**\n\n" +
      "Désolé, notre service est limité à San Pedro uniquement.\n\n" +
      "Veuillez contacter une pharmacie locale."
    );
    return;
  }
  
  userState.location = { latitude, longitude };
  
  if (userState.step === 'ATTENTE_LOCALISATION_PHARMACIES') {
    await handlePharmaciesProches(from, userState);
  } else if (userState.step === 'ATTENTE_LOCALISATION_LIVRAISON') {
    await processCheckout(from, userState);
  } else {
    await sendTextMessage(from, "📍 **Localisation enregistrée**\n\nVous pouvez continuer votre commande.");
  }
}

// ==================== GESTION INTERACTIVE ====================
async function handleInteractiveMessage(from, buttonId, userState) {
  console.log(`Bouton cliqué: ${buttonId} par ${from}`);
  
  // Gestion du bouton ouvrir support
  if (buttonId === 'ouvrir_support') {
    await sendTextMessage(from,
      `📞 **Support Client Pillbox**\n\n` +
      `Notre équipe support est disponible pour vous aider:\n\n` +
      `📱 **WhatsApp:** ${CONFIG.SUPPORT_PHONE}\n` +
      `💬 **Lien direct:** https://wa.me/${CONFIG.SUPPORT_PHONE.replace('+', '')}\n\n` +
      `✨ **Services support:**\n` +
      `• Assistance commandes\n` +
      `• Questions médicaments\n` +
      `• Réclamations\n` +
      `• Assistance technique\n\n` +
      `N'hésitez pas à nous contacter!`
    );
    await handleMenuPrincipal(from, userState);
    return;
  }
  
  if (buttonId === 'commencer_commande') {
    await handleMenuPrincipal(from, userState);
    return;
  }
  
  // Gestion des boutons livreur - RÉCUPÉRATION
  if (buttonId.startsWith('aller_recuperer_')) {
    const commandeId = buttonId.replace('aller_recuperer_', '');
    await livreurManager.handleAllerRecuperer(from, commandeId);
    return;
  }
  
  if (buttonId.startsWith('deja_recupere_')) {
    const commandeId = buttonId.replace('deja_recupere_', '');
    await livreurManager.handleDejaRecupere(from, commandeId);
    return;
  }
  
  // Gestion des boutons livreur - LIVRAISON
  if (buttonId.startsWith('aller_livrer_')) {
    const commandeId = buttonId.replace('aller_livrer_', '');
    await livreurManager.handleAllerLivrer(from, commandeId);
    return;
  }
  
  if (buttonId.startsWith('deja_livre_')) {
    const commandeId = buttonId.replace('deja_livre_', '');
    await livreurManager.handleLivraisonConfirmee(commandeId, from);
    return;
  }
  
  // Gestion des boutons de communication
  if (buttonId.startsWith('contacter_pharmacie_')) {
    const commandeId = buttonId.replace('contacter_pharmacie_', '');
    await livreurManager.handleContacterPharmacie(from, commandeId);
    return;
  }
  
  if (buttonId.startsWith('contacter_client_')) {
    const commandeId = buttonId.replace('contacter_client_', '');
    await livreurManager.handleContacterClient(from, commandeId);
    return;
  }
  
  // Gestion des réponses livreur
  if (buttonId.startsWith('accepter_')) {
    const commandeId = buttonId.replace('accepter_', '');
    await livreurManager.handleReponseLivreur(from, buttonId, commandeId, 'accepter');
    return;
  }
  
  if (buttonId.startsWith('refuser_')) {
    const commandeId = buttonId.replace('refuser_', '');
    await livreurManager.handleReponseLivreur(from, buttonId, commandeId, 'refuser');
    return;
  }
  
  if (buttonId.startsWith('en_route_')) {
    const commandeId = buttonId.replace('en_route_', '');
    await sendTextMessage(from, "🚗 **En route noté.** Continuez la livraison!");
    return;
  }
  
  // Gestion des réponses pharmacie
  if (buttonId.startsWith('valider_ordonnance_')) {
    const commandeId = buttonId.replace('valider_ordonnance_', '');
    await pharmacieValidator.handleReponsePharmacie(from, buttonId, commandeId, 'valider');
    return;
  }
  
  if (buttonId.startsWith('refuser_ordonnance_')) {
    const commandeId = buttonId.replace('refuser_ordonnance_', '');
    await pharmacieValidator.handleReponsePharmacie(from, buttonId, commandeId, 'refuser');
    return;
  }
  
  // Gestion des notes
  if (buttonId.startsWith('note_')) {
    const parts = buttonId.split('_');
    const note = parts[1];
    const commandeId = parts[2];
    await enregistrerNote(commandeId, parseInt(note), from);
    return;
  }
  
  // Navigation principale
  if (buttonId === 'retour_menu' || buttonId === 'back') {
    await handleMenuPrincipal(from, userState);
    return;
  }
  
  if (buttonId === 'pharmacies_garde') {
    await handlePharmaciesDeGarde(from);
    return;
  }
  
  if (buttonId === 'chercher_medicament') {
    await handleChercherMedicament(from, userState);
    return;
  }
  
  if (buttonId === 'pharmacies_proches') {
    await handlePharmaciesProches(from, userState);
    return;
  }
  
  if (buttonId === 'mon_panier') {
    await handlePanier(from, userState);
    return;
  }
  
  if (buttonId === 'suivi_commandes') {
    await handleSuiviCommande(from, userState);
    return;
  }
  
  if (buttonId === 'support') {
    await sendTextMessage(from,
      `📞 **Support Pillbox**\n\n` +
      `Pour toute assistance:\n` +
      `Téléphone: ${CONFIG.SUPPORT_PHONE}\n` +
      `Lien WhatsApp: https://wa.me/${CONFIG.SUPPORT_PHONE.replace('+', '')}\n\n` +
      `Disponible pour:\n` +
      `• Problèmes de commande\n` +
      `• Questions sur les médicaments\n` +
      `• Réclamations\n` +
      `• Assistance technique`
    );
    await handleMenuPrincipal(from, userState);
    return;
  }
  
  if (buttonId === 'apropos') {
    await sendTextMessage(from,
      `ℹ️ **À propos de Pillbox**\n\n` +
      `💊 **Pillbox** - Service WhatsApp de commande de médicaments\n\n` +
      `📍 **Zone:** San Pedro uniquement\n` +
      `🏥 **Pharmacies:** De garde uniquement\n` +
      `🤖 **IA Assistante:** Mia\n` +
      `🚚 **Livraison:** 24h/24 avec frais variables\n\n` +
      `👨‍💻 **Créateurs:**\n` +
      `• Yousself Diabaté\n` +
      `• Bossé Toh Delphin\n` +
      `🏛️ Université Polytechnique de San Pedro, Côte d'Ivoire\n\n` +
      `📞 Support: ${CONFIG.SUPPORT_PHONE}`
    );
    await handleMenuPrincipal(from, userState);
    return;
  }
  
  // Gestion des créateurs
  if (buttonId === 'voir_yousself') {
    await showCreatorImage(from, 'yousself');
    return;
  }
  
  if (buttonId === 'voir_delphin') {
    await showCreatorImage(from, 'delphin');
    return;
  }
  
  if (buttonId.startsWith('suivi_')) {
    const commandeId = buttonId.replace('suivi_', '');
    const commandeDoc = await db.collection('commandes').doc(commandeId).get();
    if (commandeDoc.exists) {
      const commande = { id: commandeDoc.id, ...commandeDoc.data() };
      await afficherDetailCommande(from, commande, userState);
    }
    return;
  }
  
  if (buttonId.startsWith('contacter_livreur_')) {
    const commandeId = buttonId.replace('contacter_livreur_', '');
    await handleContacterLivreur(from, commandeId);
    return;
  }
  
  if (buttonId === 'voir_details_medicaments') {
    if (userState.commandeEnCours) {
      await afficherMedicamentsCommande(from, userState.commandeEnCours);
    }
    return;
  }
  
  // Sélection pharmacie
  if (buttonId.startsWith('pharmacie_')) {
    const pharmacieId = buttonId.replace('pharmacie_', '');
    await handleSelectionPharmacie(from, pharmacieId, userState);
    return;
  }
  
  // Recherche médicaments
  if (buttonId === 'recherche_nom') {
    await sendTextMessage(from, "🔍 **Recherche par nom**\n\nVeuillez saisir le nom du médicament:");
    userState.step = 'RECHERCHE_NOM';
    return;
  }
  
  if (buttonId === 'recherche_categorie') {
    await handleRechercheParCategorie(from, userState);
    return;
  }
  
  if (buttonId === 'envoyer_photo_medicament') {
    await sendTextMessage(from,
      "📸 **Identification par photo**\n\n" +
      "Prenez une photo NETTE de votre médicament et je l'identifierai pour vous !\n\n" +
      "**Instructions :**\n" +
      "1. Placez le médicament sur une surface plane\n" +
      "2. Assurez-vous que l'étiquette est bien visible\n" +
      "3. Prenez la photo avec un bon éclairage\n" +
      "4. Envoyez-moi la photo\n\n" +
      "Je vous donnerai ensuite toutes les informations sur ce médicament !\n\n" +
      "📸 **Cliquez sur 📎 pour envoyer votre photo maintenant :**"
    );
    
    userState.step = 'ATTENTE_PHOTO_MEDICAMENT';
    userStates.set(from, userState);
    return;
  }
  
  if (buttonId.startsWith('categorie_')) {
    const categorie = buttonId.replace('categorie_', '').replace(/_/g, ' ');
    await handleSelectionCategorie(from, categorie, userState);
    return;
  }
  
  if (buttonId.startsWith('med_')) {
    const medicamentId = buttonId.replace('med_', '');
    await showDetailMedicament(from, medicamentId, userState);
    return;
  }
  
  if (buttonId.startsWith('demander_ordonnance_')) {
    const medicamentId = buttonId.replace('demander_ordonnance_', '');
    
    // Vérifier d'abord si le médicament existe
    const medicamentDoc = await db.collection('medicaments').doc(medicamentId).get();
    if (!medicamentDoc.exists) {
      await sendTextMessage(from, "❌ Médicament introuvable.");
      return;
    }
    
    const medicament = medicamentDoc.data();
    
    await sendTextMessage(from,
      `📋 **Ordonnance requise pour ${medicament.nom}**\n\n` +
      `Ce médicament nécessite une ordonnance valide.\n\n` +
      `📸 **Pour commander:**\n` +
      `1. Envoyez d'abord une photo de votre ordonnance\n` +
      `2. Attendez la validation par une pharmacie\n` +
      `3. Vous pourrez ensuite ajouter le médicament au panier\n\n` +
      `⚠️ **Important:**\n` +
      `• Seules les ordonnances valides seront acceptées\n` +
      `• La photo doit être nette et lisible\n` +
      `• Toutes les informations doivent être visibles\n\n` +
      `Cliquez sur 📎 pour envoyer votre ordonnance maintenant.`
    );
    
    userState.attentePhoto = true;
    userState.step = 'ATTENTE_PHOTO_ORDONNANCE';
    userState.currentMedicamentId = medicamentId; // Stocker l'ID du médicament pour plus tard
    userStates.set(from, userState);
    return;
  }
  
  if (buttonId.startsWith('ajouter_')) {
    const medicamentId = buttonId.replace('ajouter_', '');
    const result = await panierManager.ajouterAuPanier(from, medicamentId, 1);
    
    if (result.success) {
      await sendTextMessage(from, result.message);
      
      const buttons = [
        { type: "reply", reply: { id: "continuer_achats", title: "🛒 Continuer" } },
        { type: "reply", reply: { id: "valider_panier", title: "✅ Valider panier" } }
      ];
      
      await sendInteractiveMessage(from, "Que souhaitez-vous faire ?", buttons);
    } else {
      await sendTextMessage(from, result.message);
    }
    return;
  }
  
  if (buttonId === 'ajouter_apres_photo') {
    // Ajouter le médicament identifié
    if (userState.medicamentIdentifie) {
      const result = await panierManager.ajouterAuPanier(from, userState.medicamentIdentifie, 1);
      if (result.success) {
        await sendTextMessage(from, result.message);
      } else {
        await sendTextMessage(from, result.message);
      }
    } else {
      await sendTextMessage(from, "❌ Impossible d'ajouter le médicament. Veuillez réessayer.");
    }
    userState.medicamentIdentifie = null;
    await handleMenuPrincipal(from, userState);
    return;
  }
  
  if (buttonId === 'rechercher_similaires') {
    await sendTextMessage(from, "🔍 **Recherche des médicaments similaires...**");
    // Ici vous pouvez implémenter la recherche de médicaments similaires
    await handleMenuPrincipal(from, userState);
    return;
  }
  
  // Gestion panier
  if (buttonId === 'valider_panier') {
    await processCheckout(from, userState);
    return;
  }
  
  if (buttonId === 'vider_panier') {
    userState.panier = [];
    userState.pharmacieId = null;
    userState.pharmacieNom = null;
    userState.besoinOrdonnance = false;
    await sendTextMessage(from, "✅ Panier vidé avec succès.");
    await handleMenuPrincipal(from, userState);
    return;
  }
  
  if (buttonId === 'continuer_achats') {
    await handleMenuPrincipal(from, userState);
    return;
  }
  
  if (buttonId === 'envoyer_ordonnance') {
    await sendTextMessage(from,
      "📸 **Envoyez votre ordonnance**\n\n" +
      "Veuillez prendre une photo NETTE de votre ordonnance et l'envoyer.\n\n" +
      "Cliquez sur 📎 (attache) → Galerie → Sélectionnez la photo\n\n" +
      "⚠️ Assurez-vous que:\n" +
      "• La photo est bien nette\n" +
      "• Toutes les informations sont visibles\n" +
      "• Le nom du médecin est lisible\n" +
      "• La date est visible"
    );
    userState.attentePhoto = true;
    userState.step = 'ATTENTE_PHOTO_ORDONNANCE';
    userStates.set(from, userState);
    return;
  }
  
  if (buttonId === 'commander_sans_ordonnance') {
    const buttons = [
      { type: "reply", reply: { id: "confirmer_sans_ordonnance", title: "✅ Oui, continuer" } },
      { type: "reply", reply: { id: "annuler_commande", title: "❌ Non, annuler" } }
    ];
    
    await sendInteractiveMessage(from,
      "⚠️ **ATTENTION - Médicaments sous ordonnance**\n\n" +
      "Vous essayez de commander des médicaments qui nécessitent normalement une ordonnance.\n\n" +
      "Sans ordonnance:\n" +
      "• La pharmacie peut refuser votre commande\n" +
      "• Certains médicaments ne seront pas disponibles\n" +
      "• Des alternatives pourront vous être proposées\n\n" +
      "Confirmez-vous vouloir continuer SANS ordonnance ?",
      buttons
    );
    return;
  }
  
  if (buttonId === 'confirmer_sans_ordonnance') {
    userState.ordonnanceValidee = true;
    if (!userState.location) {
      await sendTextMessage(from, "📍 **Localisation requise**\n\nVeuillez partager votre localisation.");
      userState.step = 'ATTENTE_LOCALISATION_LIVRAISON';
    } else {
      await sendTextMessage(from, "🏠 **Informations de livraison**\n\nVeuillez préciser quartier et indications.");
      userState.step = 'ATTENTE_INFOS_LIVRAISON';
    }
    return;
  }
  
  if (buttonId === 'annuler_commande') {
    await sendTextMessage(from, "❌ Commande annulée.");
    await handleMenuPrincipal(from, userState);
    return;
  }
  
  if (buttonId === 'rechercher_medicament') {
    await sendTextMessage(from, "🔍 **Recherche du médicament**\n\nVeuillez saisir le nom:");
    userState.step = 'RECHERCHE_NOM';
    return;
  }
  
  if (buttonId === 'commander_avec_ordonnance') {
    await sendTextMessage(from,
      "📋 **Commander avec ordonnance**\n\n" +
      "Pour commander des médicaments nécessitant une ordonnance :\n\n" +
      "**ÉTAPE 1** - Envoyer votre ordonnance 📸\n" +
      "Cliquez sur 📎 (attache) → Galerie → Sélectionnez la photo de votre ordonnance\n\n" +
      "**ÉTAPE 2** - Validation par une pharmacie ✅\n" +
      "Une pharmacie de garde validera votre ordonnance sous peu\n\n" +
      "**ÉTAPE 3** - Ajouter vos médicaments 💊\n" +
      "Une fois validée, vous pourrez ajouter vos médicaments au panier\n\n" +
      "**ÉTAPE 4** - Finaliser la commande 🚚\n" +
      "Donnez votre localisation et finalisez votre commande\n\n" +
      "📸 **Envoyez maintenant une photo de votre ordonnance :**"
    );
    
    userState.attentePhoto = true;
    userState.step = 'ATTENTE_PHOTO_ORDONNANCE';
    userStates.set(from, userState);
    return;
  }
  
  if (buttonId === 'commander_sans_ordonnance_menu') {
    await handleChercherMedicament(from, userState);
    return;
  }
  
  // Par défaut
  await handleMenuPrincipal(from, userState);
}

// ==================== FONCTIONS WHATSAPP UTILITAIRES ====================
async function getWhatsAppMediaUrl(mediaId) {
  try {
    const response = await axios.get(
      `https://graph.facebook.com/v19.0/${mediaId}`,
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.WHATSAPP_TOKEN}`
        }
      }
    );
    return response.data.url;
  } catch (error) {
    console.error('Erreur récupération média:', error.message);
    return null;
  }
}

// ==================== MENUS PRINCIPAUX ====================
async function handleMenuPrincipal(userId, userState) {
  const panierCount = userState.panier.length;
  
  const buttons = [
    { type: "reply", reply: { id: "commander_sans_ordonnance_menu", title: "💊 Commander sans ordonnance" } },
    { type: "reply", reply: { id: "commander_avec_ordonnance", title: "📋 Commander avec ordonnance" } },
    { type: "reply", reply: { id: "chercher_medicament", title: "🔍 Chercher médicament" } },
    { type: "reply", reply: { id: "pharmacies_garde", title: "🏥 Pharmacies de garde" } },
    { type: "reply", reply: { id: "mon_panier", title: `🛒 Panier (${panierCount})` } },
    { type: "reply", reply: { id: "suivi_commandes", title: "📦 Suivi commandes" } }
  ];
  
  await sendInteractiveMessage(userId, 
    "**💊 Menu Principal - Pillbox**\n\n" +
    "Sélectionnez l'option qui correspond à votre besoin :", 
    buttons
  );
  
  userState.step = 'MENU_PRINCIPAL';
  userStates.set(userId, userState);
}

// ==================== FONCTIONS MANQUANTES SIMPLIFIÉES ====================
async function handlePharmaciesDeGarde(userId) {
  await sendTypingIndicator(userId, 1500);
  const pharmacies = await getPharmaciesDeGarde();
  if (pharmacies.length === 0) {
    await sendTextMessage(userId, "❌ Aucune pharmacie de garde disponible actuellement.");
    return;
  }
  
  let message = `🏥 **Pharmacies de Garde - 24h/24**\n\n`;
  
  pharmacies.forEach((pharmacie, index) => {
    message += `${index + 1}. **${pharmacie.nom}**\n`;
    message += `   📞 ${pharmacie.telephone}\n`;
    message += `   📍 ${pharmacie.adresse || 'BP 225'}\n`;
    if (pharmacie.horaires) {
      message += `   ⏰ ${pharmacie.horaires}\n`;
    }
    message += '\n';
  });
  
  message += "⚠️ **Important:**\n";
  message += "• Ces pharmacies sont ouvertes 24h/24\n";
  message += "• Présentez votre ordonnance si nécessaire\n";
  message += "• Service de livraison disponible via Pillbox\n\n";
  
  const buttons = [
    { type: "reply", reply: { id: "chercher_medicament", title: "🔍 Chercher médicament" } },
    { type: "reply", reply: { id: "commander_avec_ordonnance", title: "📋 Commander maintenant" } },
    { type: "reply", reply: { id: "retour_menu", title: "🔙 Retour" } }
  ];
  
  await sendInteractiveMessage(userId, message, buttons);
}

async function handleChercherMedicament(userId, userState) {
  const buttons = [
    { type: "reply", reply: { id: "recherche_nom", title: "🔍 Rechercher par nom" } },
    { type: "reply", reply: { id: "recherche_categorie", title: "🏷️ Par catégorie" } },
    { type: "reply", reply: { id: "envoyer_photo_medicament", title: "📸 Photo médicament" } },
    { type: "reply", reply: { id: "pharmacies_garde", title: "🏥 Pharmacies disponibles" } },
    { type: "reply", reply: { id: "retour_menu", title: "🔙 Retour" } }
  ];
  
  await sendInteractiveMessage(userId,
    "🔍 **Recherche de médicament**\n\n" +
    "Comment souhaitez-vous rechercher vos médicaments ?\n\n" +
    "Choisissez une option :",
    buttons.slice(0, 3) // WhatsApp limite à 3 boutons
  );
  
  userState.step = 'RECHERCHE_MENU';
  userStates.set(userId, userState);
}

async function handleRechercheParCategorie(userId, userState) {
  try {
    const categories = await getCategories();
    
    if (categories.length === 0) {
      await sendTextMessage(userId, "❌ Aucune catégorie disponible pour le moment.");
      return;
    }
    
    let message = "🏷️ **Catégories de médicaments disponibles**\n\n";
    
    // Limiter à 10 catégories maximum pour WhatsApp
    const categoriesLimitees = categories.slice(0, 10);
    
    // Créer les boutons pour les catégories
    const buttons = categoriesLimitees.map((categorie, index) => ({
      type: "reply",
      reply: {
        id: `categorie_${categorie.replace(/\s+/g, '_')}`,
        title: `${index + 1}. ${categorie}`
      }
    }));
    
    // Ajouter le bouton retour
    buttons.push({
      type: "reply",
      reply: {
        id: "retour_menu",
        title: "🔙 Retour"
      }
    });
    
    // Envoyer la liste des catégories
    categoriesLimitees.forEach((categorie, index) => {
      message += `${index + 1}. ${categorie}\n`;
    });
    
    if (categories.length > 10) {
      message += `\n... et ${categories.length - 10} autres catégories`;
    }
    
    message += "\n\nChoisissez une catégorie :";
    
    await sendInteractiveMessage(userId, message, buttons.slice(0, 3)); // WhatsApp limite à 3 boutons
    
  } catch (error) {
    console.error("Erreur affichage catégories:", error);
    await sendTextMessage(userId, "❌ Erreur lors du chargement des catégories.");
  }
}

async function handleSelectionCategorie(userId, categorie, userState) {
  try {
    await sendTextMessage(userId, `🔍 **Recherche dans : ${categorie}**\n\nRecherche des médicaments disponibles...`);
    
    // Simuler un chargement
    await sendTypingIndicator(userId, 2000);
    
    const medicaments = await getMedicaments(null, null, categorie);
    
    if (medicaments.length === 0) {
      await sendTextMessage(userId, `❌ Aucun médicament disponible dans la catégorie "${categorie}".`);
      await handleRechercheParCategorie(userId, userState);
      return;
    }
    
    let message = `💊 **Médicaments - ${categorie}**\n\n`;
    
    // Afficher les premiers médicaments
    medicaments.slice(0, 5).forEach((med, index) => {
      message += `${index + 1}. **${med.nom}**\n`;
      if (med.sousTitre) message += `   📝 ${med.sousTitre}\n`;
      message += `   💰 ${med.prix} FCFA\n`;
      message += `   📦 Stock: ${med.stock}\n`;
      message += med.necessiteOrdonnance ? `   ⚠️ Ordonnance requise\n` : `   ✅ Sans ordonnance\n`;
      message += '\n';
    });
    
    if (medicaments.length > 5) {
      message += `... et ${medicaments.length - 5} autres médicaments\n\n`;
    }
    
    message += "Pour voir les détails d'un médicament, tapez son numéro.";
    
    await sendTextMessage(userId, message);
    
    // Stocker la liste pour référence
    userState.listeMedicamentsCategorie = medicaments.map(m => m.id);
    userState.currentCategorie = categorie;
    userState.step = 'SELECTION_MEDICAMENT_CATEGORIE';
    userStates.set(userId, userState);
    
  } catch (error) {
    console.error("Erreur sélection catégorie:", error);
    await sendTextMessage(userId, "❌ Erreur lors de la recherche.");
  }
}

async function handleRechercheNom(userId, recherche, userState) {
  if (recherche.length < 2) {
    await sendTextMessage(userId, "❌ Veuillez saisir au moins 2 caractères pour la recherche.");
    return;
  }
  
  await sendTextMessage(userId, `🔍 **Recherche : "${recherche}"**\n\nRecherche en cours...`);
  
  // Simuler un chargement
  await sendTypingIndicator(userId, 1500);
  
  const medicaments = await getMedicaments(null, recherche, null);
  
  if (medicaments.length === 0) {
    await sendTextMessage(userId,
      `❌ **Aucun médicament trouvé pour "${recherche}"**\n\n` +
      `Suggestions :\n` +
      `• Vérifiez l'orthographe\n` +
      `• Essayez avec un terme plus général\n` +
      `• Utilisez la recherche par catégorie\n` +
      `• Prenez une photo du médicament\n\n` +
      `Ou retournez au menu principal :`
    );
    
    const buttons = [
      { type: "reply", reply: { id: "recherche_categorie", title: "🏷️ Recherche par catégorie" } },
      { type: "reply", reply: { id: "envoyer_photo_medicament", title: "📸 Photo médicament" } },
      { type: "reply", reply: { id: "retour_menu", title: "🔙 Retour" } }
    ];
    
    await sendInteractiveMessage(userId, "Que souhaitez-vous faire ?", buttons);
    return;
  }
  
  let message = `✅ **${medicaments.length} médicament(s) trouvé(s)**\n\n`;
  
  // Afficher les résultats
  medicaments.slice(0, 5).forEach((med, index) => {
    message += `${index + 1}. **${med.nom}**\n`;
    if (med.sousTitre) message += `   📝 ${med.sousTitre}\n`;
    message += `   💰 ${med.prix} FCFA\n`;
    message += `   📦 Stock: ${med.stock}\n`;
    message += med.necessiteOrdonnance ? `   ⚠️ Ordonnance requise\n` : `   ✅ Sans ordonnance\n`;
    message += '\n';
  });
  
  if (medicaments.length > 5) {
    message += `... et ${medicaments.length - 5} autres résultat(s)\n\n`;
  }
  
  message += "Pour voir les détails d'un médicament, tapez son numéro.\n";
  message += "Pour une nouvelle recherche, tapez un autre nom.";
  
  await sendTextMessage(userId, message);
  
  // Stocker la liste pour référence
  userState.listeMedicamentsRecherche = medicaments.map(m => m.id);
  userState.step = 'SELECTION_MEDICAMENT_RECHERCHE';
  userStates.set(userId, userState);
}

async function handlePharmaciesProches(userId, userState) {
  if (!userState.location) {
    await sendTextMessage(userId, "📍 **Partagez votre localisation d'abord.**");
    userState.step = 'ATTENTE_LOCALISATION_PHARMACIES';
    userStates.set(userId, userState);
    return;
  }
  await sendTextMessage(userId, "📍 **Recherche des pharmacies proches...**");
}

async function handlePanier(userId, userState) {
  if (userState.panier.length === 0) {
    await sendTextMessage(userId, "🛒 Votre panier est vide.");
    await handleMenuPrincipal(userId, userState);
    return;
  }
  const message = await panierManager.afficherPanier(userId);
  
  const buttons = [
    { type: "reply", reply: { id: "valider_panier", title: "✅ Valider panier" } },
    { type: "reply", reply: { id: "vider_panier", title: "🗑️ Vider panier" } },
    { type: "reply", reply: { id: "retour_menu", title: "🔙 Retour" } }
  ];
  
  await sendInteractiveMessage(userId, message, buttons);
}

async function showDetailMedicament(userId, medicamentId, userState) {
  try {
    const medicamentDoc = await db.collection('medicaments').doc(medicamentId).get();
    
    if (!medicamentDoc.exists) {
      await sendTextMessage(userId, "❌ Médicament introuvable.");
      return;
    }
    
    const medicament = { id: medicamentDoc.id, ...medicamentDoc.data() };
    
    let message = `💊 **${medicament.nom}**\n\n`;
    
    if (medicament.sousTitre) {
      message += `📝 ${medicament.sousTitre}\n\n`;
    }
    
    message += `💰 **Prix:** ${medicament.prix} FCFA\n`;
    message += `📦 **Stock:** ${medicament.stock} disponible(s)\n`;
    
    if (medicament.dosage) {
      message += `💊 **Dosage:** ${medicament.dosage}\n`;
    }
    
    if (medicament.forme) {
      message += `📦 **Forme:** ${medicament.forme}\n`;
    }
    
    if (medicament.categorie) {
      message += `🏷️ **Catégorie:** ${medicament.categorie}\n`;
    }
    
    message += `\n`;
    
    if (medicament.necessiteOrdonnance) {
      message += `⚠️ **MÉDICAMENT SOUS ORDONNANCE**\n\n`;
      message += `Pour commander ce médicament:\n`;
      message += `1. Vous devez avoir une ordonnance valide\n`;
      message += `2. Envoyez une photo de votre ordonnance d'abord\n`;
      message += `3. Attendez la validation par une pharmacie\n`;
      message += `4. Vous pourrez ensuite l'ajouter au panier\n\n`;
    } else {
      message += `✅ **Sans ordonnance**\n`;
      message += `Vous pouvez commander ce médicament directement.\n\n`;
    }
    
    // Récupérer le nom de la pharmacie
    let pharmacieNom = "Pharmacie";
    if (medicament.pharmacieId) {
      const pharmacieDoc = await db.collection('pharmacies').doc(medicament.pharmacieId).get();
      if (pharmacieDoc.exists) {
        pharmacieNom = pharmacieDoc.data().nom;
      }
    }
    
    message += `🏥 **Disponible chez:** ${pharmacieNom}\n\n`;
    
    // Préparer les boutons en fonction du type de médicament
    const buttons = [];
    
    if (medicament.necessiteOrdonnance) {
      if (userState.ordonnanceValidee) {
        // Ordonnance déjà validée, on peut ajouter au panier
        buttons.push({
          type: "reply",
          reply: {
            id: `ajouter_${medicamentId}`,
            title: "🛒 Ajouter au panier"
          }
        });
      } else {
        // Demander l'ordonnance d'abord
        buttons.push({
          type: "reply",
          reply: {
            id: `demander_ordonnance_${medicamentId}`,
            title: "📸 Envoyer ordonnance"
          }
        });
      }
    } else {
      // Médicament sans ordonnance
      buttons.push({
        type: "reply",
        reply: {
          id: `ajouter_${medicamentId}`,
          title: "🛒 Ajouter au panier"
        }
      });
    }
    
    buttons.push(
      {
        type: "reply",
        reply: {
          id: "retour_menu",
          title: "🔙 Retour"
        }
      }
    );
    
    await sendInteractiveMessage(userId, message, buttons);
    
  } catch (error) {
    console.error("Erreur affichage détail médicament:", error);
    await sendTextMessage(userId, "❌ Erreur lors de l'affichage du médicament.");
  }
}

async function confirmerAjoutPanier(userId, quantite, userState) {
  await sendTextMessage(userId, `✅ ${quantite} article(s) ajouté(s).`);
  await handleMenuPrincipal(userId, userState);
}

async function processCheckout(userId, userState) {
  const medicamentsAvecOrdonnance = userState.panier.filter(item => item.necessiteOrdonnance);
  
  if (medicamentsAvecOrdonnance.length > 0 && !userState.ordonnanceValidee) {
    await sendTextMessage(userId, "📋 **Ordonnance requise**\n\nVeuillez envoyer une photo.");
    userState.attentePhoto = true;
    userState.step = 'ATTENTE_PHOTO_ORDONNANCE';
    userStates.set(userId, userState);
  } else {
    await sendTextMessage(userId, "✅ **Commande confirmée**\n\nLocalisation?");
    userState.step = 'ATTENTE_LOCALISATION_LIVRAISON';
    userStates.set(userId, userState);
  }
}

async function traiterInfosLivraison(userId, texte, userState) {
  const lignes = texte.split('\n');
  let quartier = '';
  let indications = '';
  
  for (const ligne of lignes) {
    if (ligne.toLowerCase().includes('quartier:')) {
      quartier = ligne.split(':')[1]?.trim();
    } else if (ligne.toLowerCase().includes('indications:')) {
      indications = ligne.split(':')[1]?.trim();
    }
  }
  
  if (!quartier && !indications) {
    indications = texte;
    quartier = "Non spécifié";
  }
  
  userState.quartier = quartier;
  userState.indications = indications;
  
  const totalPanier = userState.panier.reduce((sum, item) => sum + (item.prix * item.quantite), 0);
  const fraisLivraison = getFraisLivraison();
  const totalFinal = totalPanier + fraisLivraison;
  
  const commandeId = await creerCommandeComplet(userId, userState, totalPanier, fraisLivraison);
  
  await sendTextMessage(userId,
    `✅ **COMMANDE CONFIRMÉE!**\n\n` +
    `🆔 Commande: #${commandeId.substring(0, 8)}\n` +
    `🏥 **Pharmacie:** ${userState.pharmacieNom}\n` +
    `📍 Quartier livraison: ${quartier}\n` +
    `📝 Indications: ${indications}\n\n` +
    `💰 **Détail:**\n` +
    `• Total médicaments: ${totalPanier} FCFA\n` +
    `• Frais livraison: ${fraisLivraison} FCFA\n` +
    `🎯 **Total: ${totalFinal} FCFA**\n\n` +
    `📞 Un livreur vous contactera bientôt.\n` +
    `💬 Vous pourrez communiquer avec lui directement sur WhatsApp.\n\n` +
    `📱 **Support:** ${CONFIG.SUPPORT_PHONE}`
  );
  
  if (userState.besoinOrdonnance && userState.ordonnancePhotoUrl) {
    await pharmacieValidator.envoyerOrdonnancePharmacie(
      commandeId, 
      userState.ordonnancePhotoUrl, 
      userState.pharmacieId
    );
  } else {
    await livreurManager.envoyerCommandeLivreur(commandeId, userState.pharmacieId);
  }
  
  userStates.set(userId, { ...DEFAULT_STATE, initialized: true });
}

async function handleSelectionPharmacie(userId, pharmacieId, userState) {
  const pharmacie = await getPharmacie(pharmacieId);
  if (pharmacie) {
    userState.pharmacieId = pharmacieId;
    userState.pharmacieNom = pharmacie.nom;
    await sendTextMessage(userId, `🏥 **${pharmacie.nom} sélectionnée**`);
    userStates.set(userId, userState);
  }
}

// ==================== SUIVI COMMANDE ====================
async function handleSuiviCommande(userId, userState) {
  try {
    const commandesSnapshot = await db.collection('commandes')
      .where('client.telephone', '==', userId)
      .where('statut', 'in', ['en_attente_livreur', 'en_cours_livraison', 'en_validation_pharmacie', 'ordonnance_validee'])
      .orderBy('createdAt', 'desc')
      .limit(5)
      .get();
    
    if (commandesSnapshot.empty) {
      await sendTextMessage(userId, "📭 **Aucune commande en cours**\n\nVous n'avez pas de commande active.");
      await handleMenuPrincipal(userId, userState);
      return;
    }
    
    const commandes = commandesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    
    if (commandes.length === 1) {
      const commande = commandes[0];
      await afficherDetailCommande(userId, commande, userState);
    } else {
      let message = `📋 **VOS COMMANDES EN COURS**\n\n`;
      
      commandes.forEach((commande, index) => {
        const statusIcons = {
          'en_validation_pharmacie': '📋',
          'ordonnance_validee': '✅',
          'en_attente_livreur': '⏳',
          'en_cours_livraison': '🚗',
          'livree': '✅'
        };
        
        message += `${index + 1}. ${statusIcons[commande.statut] || '📦'} ` +
          `Commande #${commande.id.substring(0, 8)}\n` +
          `   🏥 ${commande.pharmacie.nom}\n` +
          `   💰 ${commande.totalFinal} FCFA\n` +
          `   📍 ${commande.livraison.quartier}\n\n`;
      });
      
      const buttons = commandes.map((commande, index) => ({
        type: "reply",
        reply: {
          id: `suivi_${commande.id}`,
          title: `#${commande.id.substring(0, 8)}`
        }
      }));
      
      buttons.push({ type: "reply", reply: { id: "retour_menu", title: "🔙 Retour" } });
      
      await sendInteractiveMessage(userId, message, buttons.slice(0, 3));
      
    }
    
  } catch (error) {
    console.error("Erreur suivi commande:", error);
    await sendTextMessage(userId, "❌ Erreur lors du suivi de commande.");
  }
}

async function afficherDetailCommande(userId, commande, userState) {
  const statusMessages = {
    'en_validation_pharmacie': '📋 En attente de validation par la pharmacie',
    'ordonnance_validee': '✅ Ordonnance validée - En attente de livreur',
    'en_attente_livreur': '⏳ En attente d\'un livreur',
    'en_cours_livraison': '🚗 Livraison en cours',
    'livree': '✅ Commande livrée'
  };
  
  let message = `📦 **SUIVI COMMANDE**\n\n` +
    `🆔 #${commande.id.substring(0, 8)}\n` +
    `📅 ${new Date(commande.createdAt).toLocaleString('fr-FR')}\n` +
    `📊 Statut: ${statusMessages[commande.statut] || commande.statut}\n\n` +
    `🏥 **Pharmacie:**\n` +
    `• ${commande.pharmacie.nom}\n` +
    `• 📞 ${commande.pharmacie.telephone}\n` +
    `• 🏠 ${commande.pharmacie.adresse || 'BP 225'}\n\n`;
  
  if (commande.livreurNom) {
    message += `🚗 **Votre livreur:**\n` +
      `• ${commande.livreurNom}\n` +
      `• 📞 ${commande.livreurTelephone}\n\n`;
  }
  
  message += `📍 **Livraison:**\n` +
    `• Quartier: ${commande.livraison.quartier}\n` +
    `• Indications: ${commande.livraison.indications}\n\n` +
    `💰 **Montant:** ${commande.totalFinal} FCFA`;
  
  const buttons = [];
  
  if (commande.livreurTelephone && commande.statut === 'en_cours_livraison') {
    buttons.push({
      type: "reply",
      reply: {
        id: `contacter_livreur_${commande.id}`,
        title: "📞 Contacter livreur"
      }
    });
  }
  
  buttons.push(
    {
      type: "reply",
      reply: {
        id: "voir_details_medicaments",
        title: "💊 Voir médicaments"
      }
    },
    {
      type: "reply",
      reply: {
        id: "retour_menu",
        title: "🔙 Retour"
      }
    }
  );
  
  await sendInteractiveMessage(userId, message, buttons);
  
  userState.commandeEnCours = commande.id;
  userStates.set(userId, userState);
}

async function handleContacterLivreur(userId, commandeId) {
  try {
    const commandeDoc = await db.collection('commandes').doc(commandeId).get();
    if (!commandeDoc.exists) {
      await sendTextMessage(userId, "❌ Commande introuvable.");
      return;
    }
    
    const commande = commandeDoc.data();
    
    if (!commande.livreurTelephone) {
      await sendTextMessage(userId, "❌ Aucun livreur assigné pour le moment.");
      return;
    }
    
    const message = `📞 **CONTACTER VOTRE LIVREUR**\n\n` +
      `👤 ${commande.livreurNom}\n` +
      `📞 ${commande.livreurTelephone}\n\n` +
      `💬 **Pour contacter votre livreur:**\n` +
      `1. Cliquez sur ce lien: https://wa.me/${commande.livreurTelephone.replace('+', '')}\n` +
      `2. Ou composez: ${commande.livreurTelephone}\n\n` +
      `**Informations à donner:**\n` +
      `• Votre nom: ${commande.client.nom}\n` +
      `• Numéro commande: #${commandeId.substring(0, 8)}\n` +
      `• Vous êtes le client Pillbox\n\n` +
      `Vous pouvez aussi répondre à ce message (il sera transféré au livreur).`;
    
    await sendTextMessage(userId, message);
    
    await db.collection('commandes').doc(commandeId).update({
      chatActive: true
    });
    
  } catch (error) {
    console.error("Erreur contact livreur:", error);
  }
}

async function afficherMedicamentsCommande(userId, commandeId) {
  try {
    const commandeDoc = await db.collection('commandes').doc(commandeId).get();
    if (!commandeDoc.exists) return;
    
    const commande = commandeDoc.data();
    
    let message = `💊 **MÉDICAMENTS DE LA COMMANDE**\n\n`;
    message += `Commande #${commandeId.substring(0, 8)}\n\n`;
    
    commande.medicaments.forEach((med, index) => {
      message += `${index + 1}. **${med.nom}**\n`;
      message += `   💰 ${med.prix} FCFA × ${med.quantite} = ${med.sousTotal} FCFA\n`;
      if (med.dosage || med.forme) {
        message += `   💊 ${med.dosage || ''} ${med.forme || ''}\n`;
      }
      if (med.necessiteOrdonnance) {
        message += `   ⚠️ Ordonnance requise\n`;
      }
      message += '\n';
    });
    
    message += `🎯 **Total: ${commande.montantTotal} FCFA**`;
    
    await sendTextMessage(userId, message);
    
  } catch (error) {
    console.error("Erreur affichage médicaments:", error);
  }
}

// ==================== GESTION DES CRÉATEURS ====================
async function showCreatorsOptions(userId) {
  const buttons = [
    { type: "reply", reply: { id: "voir_yousself", title: "👨‍💻 Voir Yousself" } },
    { type: "reply", reply: { id: "voir_delphin", title: "👨‍💼 Voir Delphin" } },
    { type: "reply", reply: { id: "retour_menu", title: "🔙 Retour menu" } }
  ];
  
  await sendInteractiveMessage(userId,
    "✨ **Les créateurs de Pillbox**\n\n" +
    "Choisissez un créateur pour voir sa photo:",
    buttons
  );
}

async function showCreatorImage(userId, creatorName) {
  const creator = CONFIG.CREATORS[creatorName];
  
  if (!creator) {
    await sendTextMessage(userId, "Créateur non trouvé.");
    return;
  }
  
  try {
    await fs.access(creator.imagePath);
    
    // Pour WhatsApp, on envoie juste l'info
    await sendTextMessage(userId,
      `📸 **${creator.nom}**\n\n` +
      `🎓 ${creator.role}\n` +
      `🏛️ ${creator.universite}\n\n` +
      `Merci de votre intérêt pour Pillbox ! 💊`
    );
    
    const userState = userStates.get(userId) || { ...DEFAULT_STATE };
    userState.attenteVoirCreateur = false;
    userStates.set(userId, userState);
    
    const otherCreator = creatorName === 'yousself' ? 'delphin' : 'yousself';
    const otherCreatorInfo = CONFIG.CREATORS[otherCreator];
    
    const buttons = [
      { type: "reply", reply: { id: `voir_${otherCreator}`, title: `👀 Voir ${otherCreatorInfo.nom.split(' ')[0]}` } },
      { type: "reply", reply: { id: "retour_menu", title: "🔙 Retour menu" } }
    ];
    
    await sendInteractiveMessage(userId,
      `Voulez-vous voir ${otherCreatorInfo.nom.split(' ')[0]} ?`,
      buttons
    );
    
  } catch (error) {
    console.error('Erreur chargement image créateur:', error);
    
    await sendTextMessage(userId,
      `📸 **${creator.nom}**\n\n` +
      `🎓 ${creator.role}\n` +
      `🏛️ ${creator.universite}\n\n` +
      `(Image temporairement indisponible)\n\n` +
      `Merci de votre intérêt pour Pillbox ! 💊`
    );
    
    const userState = userStates.get(userId) || { ...DEFAULT_STATE };
    userState.attenteVoirCreateur = false;
    userStates.set(userId, userState);
    
    await handleMenuPrincipal(userId, userState);
  }
}

// ==================== WEBHOOK ====================
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
    
    if (!message) {
      console.log('⚠️ Pas de message dans le webhook');
      return;
    }
    
    const from = message.from;
    const messageType = message.type;
    
    let userState = userStates.get(from) || { ...DEFAULT_STATE };
    
    // IGNORER les messages audio/voice
    if (messageType === 'audio' || messageType === 'voice') {
      console.log(`🔇 Message audio ignoré de ${from}`);
      return;
    }
    
    if (messageType === 'text') {
      // D'abord essayer de traiter comme chat client-livreur
      const isChatMessage = await livreurManager.handleChatClientLivreur(
        message.text.body, 
        from, 
        null
      );
      
      if (isChatMessage) {
        return;
      }
      
      await handleTextMessage(from, message.text.body, userState);
    } else if (messageType === 'image') {
      await handleImageMessage(from, message.image.id, userState);
    } else if (messageType === 'location') {
      await handleLocationMessage(from, message.location, userState);
    } else if (messageType === 'interactive' && message.interactive?.type === 'button_reply') {
      await handleInteractiveMessage(from, message.interactive.button_reply.id, userState);
    } else if (messageType === 'interactive' && message.interactive?.type === 'list_reply') {
      await handleInteractiveMessage(from, message.interactive.list_reply.id, userState);
    } else {
      console.log(`⚠️ Type de message non géré: ${messageType} de ${from}`);
    }
    
    userStates.set(from, userState);
    
  } catch (error) {
    console.error('💥 Erreur webhook:', error.message, error.stack);
  }
});

// ==================== DÉMARRAGE SERVEUR ====================
const PORT = process.env.PORT || 10000;

// Variables requises
const requiredVars = [
  'VERIFY_TOKEN', 'PHONE_NUMBER_ID', 'WHATSAPP_TOKEN', 
  'GROQ_API_KEY', 'FIREBASE_PROJECT_ID'
];

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`
=======================================
🚀 Pillbox WhatsApp Bot PRODUCTION
📍 Port: ${PORT}
💊 Service: Commandes médicaments San Pedro
🤖 IA: Mia (Groq ${CONFIG.GROQ_MODEL})
👨‍💻 Créateurs: Yousself Diabaté & Bossé Toh Delphin
🏛️ Université Polytechnique de San Pedro, Côte d'Ivoire
📞 Support: ${CONFIG.SUPPORT_PHONE}
=======================================
Variables requises:
${requiredVars.map(varName => 
  `  ${process.env[varName] ? '✅' : '❌'} ${varName}: ${process.env[varName] ? 'Défini' : 'MANQUANT'}`
).join('\n')}
=======================================
Statut Firebase: ${firebaseInitialized ? '✅ Connecté' : '⚠️ Mode simulation'}
=======================================
  `);
});

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'Pillbox WhatsApp Bot PRODUCTION',
    version: '1.0.0',
    users_actifs: userStates.size,
    firebase_connected: firebaseInitialized,
    creators: ['Yousself Diabaté', 'Bossé Toh Delphin'],
    support_phone: CONFIG.SUPPORT_PHONE
  });
});

app.get('/admin', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Pillbox Admin</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; }
          .container { max-width: 800px; margin: 0 auto; }
          .card { background: white; border-radius: 10px; padding: 20px; margin: 20px 0; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          .status { display: inline-block; padding: 5px 10px; border-radius: 5px; font-weight: bold; }
          .status-ok { background: #4CAF50; color: white; }
          .status-warning { background: #FF9800; color: white; }
          .status-error { background: #F44336; color: white; }
          h1 { color: #333; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>💊 Pillbox Administration</h1>
          
          <div class="card">
            <h2>📊 Statistiques</h2>
            <p>Utilisateurs actifs: ${userStates.size}</p>
            <p>Firebase: <span class="status ${firebaseInitialized ? 'status-ok' : 'status-warning'}">${firebaseInitialized ? 'CONNECTÉ' : 'MODE SIMULATION'}</span></p>
          </div>
          
          <div class="card">
            <h2>👨‍💻 Créateurs</h2>
            <p><strong>Yousself Diabaté</strong> - Développeur Full-Stack</p>
            <p><strong>Bossé Toh Delphin</strong> - Architecte Solution & Gestion de projet</p>
            <p>Université Polytechnique de San Pedro, Côte d'Ivoire</p>
          </div>
          
          <div class="card">
            <h2>📞 Support Client</h2>
            <p><strong>Téléphone:</strong> ${CONFIG.SUPPORT_PHONE}</p>
            <p><strong>Fonction:</strong> Réception de toutes les commandes créées</p>
            <p><strong>Zone:</strong> San Pedro uniquement</p>
          </div>
          
          <div class="card">
            <h2>🔧 Endpoints API</h2>
            <p><strong>Health Check:</strong> <code>/health</code></p>
            <p><strong>Webhook WhatsApp:</strong> <code>/api/webhook</code></p>
            <p><strong>Admin:</strong> <code>/admin</code></p>
          </div>
        </div>
      </body>
    </html>
  `);
});

// Gestion des erreurs non catchées
process.on('uncaughtException', (error) => {
  console.error('💥 ERREUR NON GÉRÉE:', error.message);
  console.error('Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 PROMISE REJECTION NON GÉRÉE:', reason);
});