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
const AUTH_DIR = path.join(__dirname, "..", "auth_info");

// =====================================================
// EXPRESS SERVER (API para n8n enviar mensagens)
// =====================================================
const app = express();
app.use(express.json({ limit: "50mb" }));

let sock = null;
let connectionStatus = "disconnected";

// Health check
app.get("/", (req, res) => {
  res.json({
    status: connectionStatus,
    service: "AMA Pet WhatsApp Bot",
    timestamp: new Date().toISOString(),
  });
});

// Endpoint para n8n enviar mensagens de volta ao cliente
app.post("/api/send-message", async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ error: "phone and message required" });
    }

    // Formata o numero pro formato WhatsApp
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
// GROQ WHISPER - Transcricao de audio
// =====================================================
async function transcribeAudio(audioBuffer) {
  if (!GROQ_API_KEY) {
    console.warn("GROQ_API_KEY not set, skipping transcription");
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
  // Remove tudo que nao for numero
  let clean = phone.replace(/\D/g, "");
  // Se nao tem codigo de pais, assume Chile (+56)
  if (!clean.startsWith("56") && clean.length <= 9) {
    clean = "56" + clean;
  }
  return clean + "@s.whatsapp.net";
}

function extractPhoneFromJid(jid) {
  return jid.replace("@s.whatsapp.net", "").replace("@g.us", "");
}

// =====================================================
// BAILEYS - Conexao WhatsApp
// =====================================================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "warn" }),
    printQRInTerminal: true,
    browser: ["AMA Pet Bot", "Chrome", "1.0.0"],
    // Reconexao automatica
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 30000,
  });

  // Salva credenciais quando atualizar
  sock.ev.on("creds.update", saveCreds);

  // Gerencia conexao
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\n========================================");
      console.log("  ESCANEA ESTE QR CON WHATSAPP");
      console.log("========================================\n");
      connectionStatus = "waiting_qr";
    }

    if (connection === "close") {
      connectionStatus = "disconnected";
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

      if (reason === DisconnectReason.loggedOut) {
        console.log("Session logged out. Delete auth_info and restart.");
        // Limpa auth e reconecta
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
      console.log("\n========================================");
      console.log("  BOT CONECTADO AL WHATSAPP DE AMA PET");
      console.log("========================================\n");
    }
  });

  // =====================================================
  // PROCESSA MENSAGENS RECEBIDAS
  // =====================================================
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      // Ignora mensagens proprias e de grupos
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.endsWith("@g.us")) continue;

      const senderPhone = extractPhoneFromJid(msg.key.remoteJid);
      const senderName =
        msg.pushName || msg.key.participant || "Cliente";

      let messageText = "";
      let messageType = "text";

      // Texto normal
      if (msg.message?.conversation) {
        messageText = msg.message.conversation;
      } else if (msg.message?.extendedTextMessage?.text) {
        messageText = msg.message.extendedTextMessage.text;
      }
      // Audio / voice note
      else if (msg.message?.audioMessage) {
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
      }
      // Imagen con caption
      else if (msg.message?.imageMessage) {
        messageType = "image";
        messageText =
          msg.message.imageMessage.caption || "[Imagen recibida sin texto]";
      }
      // Otro tipo de mensaje
      else {
        messageText = "[Mensaje no soportado]";
        messageType = "other";
      }

      // Ignora mensagens vazias
      if (!messageText) continue;

      console.log(`[MSG] ${senderName} (${senderPhone}): ${messageText}`);

      // Envia pro n8n via webhook
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

        // Fallback: responde que ta com problemas
        await sock.sendMessage(msg.key.remoteJid, {
          text: "Disculpa, estamos experimentando problemas tecnicos. Por favor intenta nuevamente en unos minutos o contactanos al (+56) 9 7510 2052.",
        });
      }
    }
  });
}

// =====================================================
// INICIA TUDO
// =====================================================
app.listen(PORT, () => {
  console.log(`\n[SERVER] API corriendo en puerto ${PORT}`);
  console.log(`[SERVER] Webhook n8n: ${N8N_WEBHOOK_URL}`);
  console.log(`[SERVER] Groq API: ${GROQ_API_KEY ? "Configurada" : "NO CONFIGURADA"}`);
  startBot();
});
