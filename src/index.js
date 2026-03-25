const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const express = require("express");
const pino = require("pino");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

// =====================================================
// CONFIG
// =====================================================
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "https://nickliporase.app.n8n.cloud/webhook/ama-bot-incoming";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const AUTH_DIR = path.join(__dirname, "..", "auth_info");

// =====================================================
// EXPRESS SERVER
// =====================================================
const app = express();
app.use(express.json({ limit: "50mb" }));

let sock = null;
let connectionStatus = "disconnected";
let currentQR = null;

app.get("/", (req, res) => {
  res.json({
    status: connectionStatus,
    service: "AMA Pet WhatsApp Bot",
    timestamp: new Date().toISOString(),
  });
});

app.get("/pair", async (req, res) => {
  if (connectionStatus === "connected") {
    return res.send(`<html><body style="font-family:Arial;text-align:center;padding:60px;background:#0a0a0a;color:#0f0">
      <h1>BOT CONECTADO</h1><p>WhatsApp ya esta vinculado. Todo OK.</p></body></html>`);
  }
  let qrImage = "";
  if (currentQR) {
    try { qrImage = await QRCode.toDataURL(currentQR, { width: 400, margin: 2 }); } catch (e) {}
  }
  res.send(`<html>
  <head><meta http-equiv="refresh" content="5"><title>AMA Bot - Vincular</title></head>
  <body style="font-family:Arial;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
    <h1>AMA Pet WhatsApp Bot</h1>
    <p>Estado: <b style="color:${connectionStatus === 'connected' ? '#0f0' : '#f90'}">${connectionStatus}</b></p>
    ${qrImage ? `
      <div style="background:#fff;border-radius:16px;padding:20px;display:inline-block;margin:20px">
        <img src="${qrImage}" alt="QR" style="width:350px;height:350px"/>
      </div>
      <p style="color:#aaa">Escanea con WhatsApp > Dispositivos vinculados > Vincular</p>
    ` : `<p style="color:#f90">Esperando QR... se actualiza sola.</p>`}
  </body></html>`);
});

// === N8N ENVIA MENSAJES DE VUELTA ===
// Acepta "jid" (el JID completo tal cual) para responder
app.post("/api/send-message", async (req, res) => {
  try {
    const { jid, phone, message } = req.body;
    if (!message) return res.status(400).json({ error: "message required" });
    if (!jid && !phone) return res.status(400).json({ error: "jid or phone required" });

    const targetJid = jid || (phone.includes("@") ? phone : phone + "@s.whatsapp.net");
    await sock.sendMessage(targetJid, { text: message });
    console.log(`[SENT] To ${targetJid}: ${message.substring(0, 50)}...`);
    res.json({ success: true, to: targetJid });
  } catch (err) {
    console.error("Error sending message:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/send-image", async (req, res) => {
  try {
    const { jid, phone, imageUrl, caption } = req.body;
    if (!imageUrl) return res.status(400).json({ error: "imageUrl required" });
    const targetJid = jid || (phone.includes("@") ? phone : phone + "@s.whatsapp.net");
    await sock.sendMessage(targetJid, { image: { url: imageUrl }, caption: caption || "" });
    res.json({ success: true, to: targetJid });
  } catch (err) {
    console.error("Error sending image:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// GROQ WHISPER
// =====================================================
async function transcribeAudio(audioBuffer) {
  if (!GROQ_API_KEY) return "[Audio recibido - transcripcion no disponible]";
  try {
    const FormData = (await import("form-data")).default;
    const form = new FormData();
    form.append("file", audioBuffer, { filename: "audio.ogg", contentType: "audio/ogg" });
    form.append("model", "whisper-large-v3");
    form.append("language", "es");
    const response = await axios.post(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      form,
      { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, ...form.getHeaders() }, maxBodyLength: Infinity }
    );
    return response.data.text || "[Audio no pudo ser transcrito]";
  } catch (err) {
    console.error("Groq transcription error:", err.message);
    return "[Error al transcribir audio]";
  }
}

// =====================================================
// HELPERS
// =====================================================
function extractPhoneFromJid(jid) {
  if (!jid) return null;
  if (jid.endsWith("@s.whatsapp.net")) return jid.replace("@s.whatsapp.net", "");
  // LID format no tiene telefono real
  return null;
}

// =====================================================
// BAILEYS
// =====================================================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "warn" }),
    printQRInTerminal: false,
    browser: ["AMA Pet Bot", "Chrome", "1.0.0"],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 30000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      connectionStatus = "waiting_qr";
      console.log("[QR] Nuevo QR generado. Escanea en: https://ama-whatsapp-bot.onrender.com/pair");
    }
    if (connection === "close") {
      connectionStatus = "disconnected";
      currentQR = null;
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        console.log("Session logged out. Cleaning and restarting...");
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
        setTimeout(startBot, 5000);
      } else {
        console.log(`Connection closed (reason: ${reason}). Reconnecting in 5s...`);
        setTimeout(startBot, 5000);
      }
    }
    if (connection === "open") {
      connectionStatus = "connected";
      currentQR = null;
      console.log("\n========================================");
      console.log("  BOT CONECTADO AL WHATSAPP");
      console.log("========================================\n");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.endsWith("@g.us")) continue;

      const remoteJid = msg.key.remoteJid;
      const phone = extractPhoneFromJid(remoteJid);
      const senderName = msg.pushName || "Cliente";

      let messageText = "";
      let messageType = "text";

      if (msg.message?.conversation) {
        messageText = msg.message.conversation;
      } else if (msg.message?.extendedTextMessage?.text) {
        messageText = msg.message.extendedTextMessage.text;
      } else if (msg.message?.audioMessage) {
        messageType = "audio";
        try {
          console.log(`[AUDIO] Recibido de ${senderName}, transcribiendo...`);
          const audioBuffer = await downloadMediaMessage(msg, "buffer", {});
          messageText = await transcribeAudio(audioBuffer);
          console.log(`[AUDIO] Transcripcion: "${messageText}"`);
        } catch (err) {
          console.error("Error downloading audio:", err.message);
          messageText = "[Audio no pudo ser procesado]";
        }
      } else if (msg.message?.imageMessage) {
        messageType = "image";
        messageText = msg.message.imageMessage.caption || "[Imagen recibida sin texto]";
      } else {
        messageText = "[Mensaje no soportado]";
        messageType = "other";
      }

      if (!messageText) continue;

      console.log(`[MSG] ${senderName} (${remoteJid}): ${messageText}`);

      // Envia al n8n con JID completo + telefono si disponible
      try {
        await axios.post(N8N_WEBHOOK_URL, {
          jid: remoteJid,
          phone: phone || "",
          name: senderName,
          message: messageText,
          messageType: messageType,
          timestamp: new Date().toISOString(),
        });
        console.log(`[N8N] Enviado al webhook OK`);
      } catch (err) {
        console.error(`[N8N] Error: ${err.message}`);
        await sock.sendMessage(remoteJid, {
          text: "Disculpa, estamos experimentando problemas tecnicos. Por favor intenta nuevamente en unos minutos o contactanos al (+56) 9 7510 2052.",
        });
      }
    }
  });
}

app.listen(PORT, () => {
  console.log(`\n[SERVER] API corriendo en puerto ${PORT}`);
  console.log(`[SERVER] Vincular: https://ama-whatsapp-bot.onrender.com/pair`);
  startBot();
});
