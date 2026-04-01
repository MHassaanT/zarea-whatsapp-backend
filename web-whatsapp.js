// web-whatsapp.js
// Multi-User + Per-User Messages Version (v3, Production Ready)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Client, LocalAuth } = require("whatsapp-web.js");
const admin = require("firebase-admin");

const PORT = process.env.PORT || 4000;
const RAW_MESSAGES_COLLECTION = "raw_messages";
const clients = {}; // { userId: clientInstance }

let db;
let rawMessagesCollection;

async function initializeFirebase() {
  try {
    const base64Key = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!base64Key) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_BASE64 env variable.");

    let serviceAccount;
    try {
      const decoded = Buffer.from(base64Key, "base64").toString("utf-8");
      serviceAccount = JSON.parse(decoded);
    } catch (err) {
      throw new Error("Invalid Base64 Firebase key — failed to decode/parse JSON.");
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    console.log("🔥 Firebase Admin Initialized");
    db = admin.firestore();
    rawMessagesCollection = db.collection(RAW_MESSAGES_COLLECTION);
  } catch (error) {
    console.error("❌ Firebase Init Error:", error.message);
    process.exit(1);
  }
}

async function updateFirestoreStatus(userId, data) {
  try {
    if (!db) return console.error("⚠️ Firestore DB reference is null.");
    const docId = userId;
    const targetDoc = db.collection("whatsapp_sessions").doc(docId);
    await targetDoc.set({ ...data, userId }, { merge: true });
    console.log(`✅ Firestore Updated [${docId}] → Status=${data.status}`);
  } catch (err) {
    console.error("⚠️ Firestore Update Error:", err);
  }
}

// --- SAVE RAW MESSAGE (NOW WITH BUNDLING) ---
async function saveRawMessage(msg, userId) {
  try {
    const phoneNumber = msg.to?.split("@")[0] || "unknown";

    // --- Phase 4, Fix 1: Message Bundling (Debounce) ---
    // Look for a recent message from this exact sender
    const recentMessages = await rawMessagesCollection
        .where('userId', '==', userId)
        .where('from', '==', msg.from)
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();

    if (!recentMessages.empty) {
        const recentDoc = recentMessages.docs[0];
        const recentData = recentDoc.data();
        
        const now = admin.firestore.Timestamp.now().toMillis();
        const docTime = recentData.timestamp.toMillis();
        
        // If the last message is unprocessed and less than 8 seconds old, bundle it
        if (recentData.processed === false && (now - docTime < 8000)) { 
            const newBody = recentData.body + "\n" + msg.body;
            await recentDoc.ref.update({
                body: newBody,
                timestamp: admin.firestore.Timestamp.now() // Reset the timer
            });
            console.log(`📩 [${userId}] Bundled rapid message into existing doc ${recentDoc.id.substring(0, 8)}`);
            return recentDoc.ref;
        }
    }
    // --- End Bundling Logic ---

    // Fallback: Create a new document if no recent unbundled message exists
    const messageData = {
      timestamp: admin.firestore.Timestamp.now(),
      userId, 
      phoneNumber, 
      from: msg.from,
      to: msg.to,
      type: msg.type,
      body: msg.body || null,
      isGroup: !!msg.isGroup,
      wwebId: msg.id._serialized,
      processed: false,
      isLead: null,
      replyPending: false,
      autoReplyText: null,
    };

    const docRef = await rawMessagesCollection.add(messageData);
    console.log(
      `📩 [${userId}] Message saved (${docRef.id.substring(0, 8)}...) from ${msg.from.substring(0, 10)}...`
    );
    return docRef;
  } catch (error) {
    console.error(`⚠️ Error saving message for ${userId}:`, error);
  }
}

function startAiReplyExecutor() {
  if (!db) return;
  const q = db.collection(RAW_MESSAGES_COLLECTION).where("replyPending", "==", true);
  console.log(`\n🤖 AI Reply Executor Started`);

  q.onSnapshot(async (snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (!["added", "modified"].includes(change.type)) return;

      const doc = change.doc;
      const message = doc.data();
      const docId = doc.id;

      if (!message.autoReplyText || !message.from || !message.userId) return;

      const targetClient = clients[message.userId];
      if (!targetClient) return console.log(`⚠️ No client found for ${message.userId}`);

      try {
        await targetClient.sendMessage(message.from, message.autoReplyText);
        await db.collection(RAW_MESSAGES_COLLECTION).doc(docId).update({
          replyPending: false,
          replySentAt: admin.firestore.Timestamp.now(),
        });
        console.log(`✅ [${message.userId}] AI replied for ${docId}`);
      } catch (err) {
        console.error(`❌ AI Reply Error (${docId}):`, err.message);
      }
    });
  });
}

function setupClientListeners(client, userId) {
  client.on("qr", (qr) => {
    console.log(`🤖 [${userId}] QR generated`);
    updateFirestoreStatus(userId, { qr, connected: false, status: "awaiting_scan", phoneNumber: null });
  });

  client.on("ready", () => {
    const phone = client.info.wid.user;
    console.log(`🎉 [${userId}] WhatsApp Ready (${phone})`);
    updateFirestoreStatus(userId, { qr: null, connected: true, status: "active", phoneNumber: phone });
  });

  client.on("message", async (msg) => {
        if (msg.isGroup) {
            console.log(`💬 [${userId}] Ignoring Group/Community message from ${msg.from.substring(0, 10)}...`);
            return;
        }
        if (!msg.fromMe && msg.body && msg.body.trim() !== "") {
            await saveRawMessage(msg, userId); 
        }
    });

  client.on("disconnected", async (reason) => {
    console.log(`🛑 [${userId}] Disconnected: ${reason}`);
    updateFirestoreStatus(userId, { qr: null, connected: false, status: "disconnected" });
    delete clients[userId];
  });

  client.on("auth_failure", (msg) => {
    console.error(`⚠️ [${userId}] Auth failure:`, msg);
    updateFirestoreStatus(userId, { qr: null, connected: false, status: "error" });
  });
}

async function createClient(userId) {
  if (clients[userId]) {
    console.log(`⚠️ Client for ${userId} already exists.`);
    return clients[userId];
  }

  const fs = require("fs");
  const AUTH_PATH = process.env.WWEBJS_AUTH_DIR || "/app/data/.wwebjs_auth";

  try {
    if (!fs.existsSync(AUTH_PATH)) {
      fs.mkdirSync(AUTH_PATH, { recursive: true });
      console.log("📁 Created persistent auth directory:", AUTH_PATH);
    }
    fs.chmodSync(AUTH_PATH, 0o777);
  } catch (err) {
    console.error("⚠️ Failed to prepare auth directory:", err);
  }

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: userId,
      dataPath: AUTH_PATH,
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", 
        "--disable-accelerated-2d-canvas", "--no-first-run", "--no-zygote", 
        "--single-process", "--disable-gpu"
      ],
    },
  });

  setupClientListeners(client, userId);

  try {
    await client.initialize();
    console.log(`🚀 Initialized WhatsApp client for ${userId}`);
  } catch (err) {
    console.error(`❌ Error initializing client for ${userId}:`, err);
    updateFirestoreStatus(userId, { status: "initialization_failed", connected: false, qr: null, phoneNumber: null });
  }

  clients[userId] = client;
  return client;
}

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL || '*', 
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

app.post("/start-whatsapp", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "Missing userId" });
  try {
    await createClient(userId);
    res.status(200).json({ message: `Client started for ${userId}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/disconnect", async (req, res) => {
  const { userId } = req.body;
  if (!userId || !clients[userId]) return res.status(400).json({ error: "Invalid or inactive userId" });
  try {
    await clients[userId].logout();
    delete clients[userId];
    res.status(200).json({ message: `Client ${userId} disconnected.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => {
  res.json({ 
    status: "✅ ZareaAI WhatsApp Backend Running",
    activeClients: Object.keys(clients).length,
    timestamp: new Date().toISOString()
  });
});

(async () => {
  await initializeFirebase();
  startAiReplyExecutor();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🌍 WhatsApp Backend Server Running`);
    console.log(`📍 Port: ${PORT}`);
  });
})();
