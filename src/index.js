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

// =====================================================
// CONFIG
// =====================================================
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "https://nickliporase.app.n8n.cloud/webhook/ama-bot-incoming";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const PHONE_NUMBER = process.env.PHONE_NUMBER || "";
const AUTH_DIR = path.join(__dirname, "..", "auth_info");

// =====================================================
// EXPRESS SERVER
// =====================================================
const app = express();
app.use(express.json({ limit: "50mb" }));

let sock = null;
let connectionStatus = "disconnected";
let currentPairingCode = null;
let codeGeneratedAt = null;

// Health check
app.get("/", (req, res) => {
  res.json({
    status: connectionStatus,
    service: "AMA Pet WhatsApp Bot",
    timestamp: new Date().toISOString(),
  });
});

// === PAGINA PARA VER EL CODIGO DE VINCULACION ===
app.get("/pair", (req, res) => {
  if (connectionStatus === "connected") {
    return res.send("<html><body style='font-family:Arial;text-align:center;padding:60px;background:#0a0a0a;color:#0f0'><h1>BOT YA CONECTADO</h1><p>El WhatsApp ya esta vinculado. No necesitas codigo.</p></body></html>");
  }
  
  const html = `
  <html>
  <head><meta http-equiv="refresh" content="5"><title>AMA Bot - Vincular</title></head>
  <body style="font-family:Arial;text-align:center;padding:60px;background:#0a0a0a;color:#fff">
    <h1>AMA Pet WhatsApp Bot</h1>
    <p>Estado: <b style="color:${connectionStatus === 'connected' ? '#0f0' : '#f90'}">${connectionStatus}</b></p>
    ${currentPairingCode ? `
      <div style="background:#111;border:2px solid #0f0;border-radius:16px;padding:40px;display:inline-block;margin:20px">
        <p style="color:#aaa;margin:0">CODIGO DE VINCULACION:</p>
        <h1 style="font-size:64px;letter-spacing:12px;color:#0f0;margin:10px 0">${currentPairingCode}</h1>
        <p style="color:#888;font-size:14px">Generado: ${codeGeneratedAt ? new Date(codeGeneratedAt).toLocaleTimeString() : 'N/A'}</p>
      </div>
      <p style="color:#aaa">1. Abre WhatsApp en tu celular</p>
      <p style="color:#aaa">2. Dispositivos vinculados > Vincular dispositivo</p>
      <p style="color:#aaa">3. Toca "Vincular con numero de telefono"</p>
      <p style="color:#aaa">4. Ingresa el codigo de arriba RAPIDO</p>
    ` : `
      <p style="color:#f90">Esperando codigo... esta pagina se actualiza sola cada 5 segundos.</p>
    `}
    <p style="color:#555;font-size:12px">Esta pagina se refresca automaticamente.</p>
  </body>
  </html>`;
  res.send(html);
});

// Endpoint para n8n enviar mensagens
app.post("/api/send-message", async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ error: "phone and message required" });
    }

    const jid = formatPhoneToJid(phone);
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true, to: jid });
  } catch (err) {
    console.error("Error sending message:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para n8n enviar imagens
app.post("/api/send-image", async (req, res) => {
  try {
    const { phone, imageUrl, caption } = req.body;
    if (!phone || !imageUrl) {
      return res.status(400).json({ error: "phone and imageUrl required" });
    }

    const jid = formatPhoneToJid(phone);
    await sock.sendMessage(jid, {
      image: { url: imageUrl },
      caption: caption || "",
    });
    res.json({ success: true, to: jid });
  } catch (err) {
    console.error("Error sending image:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// GROQ WHISPER
// =====================================================
async function transcribeAudio(audioBuffer) {
  if (!GROQ_API_KEY) {
    return "[Audio recibido - transcripcion no disponible]";
  }

  try {
    const FormData = (await import("form-data")).default;
    const form = new FormData();
    form.append("file", audioBuffer, {
      filename: "audio.ogg",
      contentType: "audio/ogg",
    });
    form.append("model", "whisper-large-v3");
    form.append("language", "es");

    const response = await axios.post(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      form,
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          ...form.getHeaders(),
        },
        maxBodyLength: Infinity,
      }
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
function formatPhoneToJid(phone) {
  let clean = phone.replace(/\D/g, "");
  if (!clean.startsWith("56") && clean.length <= 9) {
    clean = "56" + clean;
  }
  return clean + "@s.whatsapp.net";
}

function extractPhoneFromJid(jid) {
  return jid.replace("@s.whatsapp.net", "").replace("@g.us", "");
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
    browser: ["Chrome (Linux)", "", ""],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 30000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      if (PHONE_NUMBER && !sock.authState.creds.registered) {
        try {
          const code = await sock.requestPairingCode(PHONE_NUMBER);
          currentPairingCode = code;
          codeGeneratedAt = Date.now();
          console.log("\n========================================");
          console.log("  CODIGO: " + code);
          console.log("  Ve a: https://ama-whatsapp-bot.onrender.com/pair");
          console.log("========================================\n");
        } catch (err) {
          console.error("Error requesting pairing code:", err.message);
        }
      } else {
        console.log("Configura PHONE_NUMBER en variables de entorno");
      }
      connectionStatus = "waiting_qr";
    }

    if (connection === "close") {
      connectionStatus = "disconnected";
      currentPairingCode = null;
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

      if (reason === DisconnectReason.loggedOut) {
        console.log("Session logged out. Cleaning and restarting...");
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true });
        }
        setTimeout(startBot, 5000);
      } else {
        console.log(`Connection closed (reason: ${reason}). Reconnecting in 5s...`);
        setTimeout(startBot, 5000);
      }
    }

    if (connection === "open") {
      connectionStatus = "connected";
      currentPairingCode = null;
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

      const senderPhone = extractPhoneFromJid(msg.key.remoteJid);
      const senderName = msg.pushName || msg.key.participant || "Cliente";

      let messageText = "";
      let messageType = "text";

      if (msg.message?.conversation) {
        messageText = msg.message.conversation;
      } else if (msg.message?.extendedTextMessage?.text) {
        messageText = msg.message.extendedTextMessage.text;
      } else if (msg.message?.audioMessage) {
        messageType = "audio";
        try {
          console.log(`[AUDIO] Recibido de ${senderPhone}, transcribiendo...`);
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

      console.log(`[MSG] ${senderName} (${senderPhone}): ${messageText}`);

      try {
        await axios.post(N8N_WEBHOOK_URL, {
          phone: senderPhone,
          name: senderName,
          message: messageText,
          messageType: messageType,
          timestamp: new Date().toISOString(),
        });
        console.log(`[N8N] Mensaje enviado al webhook`);
      } catch (err) {
        console.error(`[N8N] Error enviando al webhook: ${err.message}`);

        await sock.sendMessage(msg.key.remoteJid, {
          text: "Disculpa, estamos experimentando problemas tecnicos. Por favor intenta nuevamente en unos minutos o contactanos al (+56) 9 7510 2052.",
        });
      }
    }
  });
}

app.listen(PORT, () => {
  console.log(`\n[SERVER] API corriendo en puerto ${PORT}`);
  console.log(`[SERVER] Webhook n8n: ${N8N_WEBHOOK_URL}`);
  console.log(`[SERVER] Groq API: ${GROQ_API_KEY ? "OK" : "NO"}`);
  console.log(`[SERVER] Phone: ${PHONE_NUMBER || "NO CONFIGURADO"}`);
  console.log(`[SERVER] Para vincular: https://ama-whatsapp-bot.onrender.com/pair`);
  startBot();
});
