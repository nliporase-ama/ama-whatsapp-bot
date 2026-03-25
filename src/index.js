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
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const DISPATCH_API_KEY = process.env.DISPATCH_API_KEY || "";
const DISPATCH_URL = "https://logicold.dispatchtrack.com/api/external/v1/dispatches";
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "https://nickliporase.app.n8n.cloud/webhook/51ca047d-30a2-412f-95ec-8bb42f427689";
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const NELLY_PHONE = process.env.NELLY_PHONE || "";
const API_SECRET = process.env.API_SECRET || "";
const AUTH_DIR = path.join(__dirname, "..", "auth_info");
const PAUSE_MS = 48 * 60 * 60 * 1000;

// =====================================================
// STARTUP VALIDATION
// =====================================================
if (!GROQ_API_KEY) console.warn("[WARN] GROQ_API_KEY not set - LLM responses will fail");
if (!DISPATCH_API_KEY) console.warn("[WARN] DISPATCH_API_KEY not set - tracking will fail");
if (!NELLY_PHONE) console.warn("[WARN] NELLY_PHONE not set - human handoff will fail");

// =====================================================
// STATE
// =====================================================
let sock = null;
let connectionStatus = "disconnected";
let currentQR = null;
const processedMessages = new Set();
const pausedChats = new Map();
let faqCache = null;
let faqCacheTime = 0;
const FAQ_CACHE_TTL = 300000;
const dispatchStore = new Map(); // phone -> [dispatches] recebidos via webhook

// =====================================================
// HELPERS
// =====================================================
function markProcessed(id) {
  processedMessages.add(id);
  setTimeout(() => processedMessages.delete(id), 120000);
}

function cleanName(pushName) {
  if (!pushName) return "Cliente";
  const name = pushName.trim();
  if (name.length < 2 || name.length > 40) return "Cliente";
  const bl = ["ama", "amapet", "ama pet", "bot", "whatsapp", "business", "empresa"];
  if (bl.includes(name.toLowerCase())) return "Cliente";
  return name;
}

function extractPhone(jid) {
  if (!jid) return null;
  if (jid.endsWith("@s.whatsapp.net")) return jid.replace("@s.whatsapp.net", "");
  return null;
}

function isPaused(jid) {
  const ts = pausedChats.get(jid);
  if (!ts) return false;
  if (Date.now() - ts < PAUSE_MS) return true;
  pausedChats.delete(jid);
  return false;
}

function pauseChat(jid) {
  pausedChats.set(jid, Date.now());
}

// =====================================================
// CSV PARSER (RFC 4180)
// =====================================================
function parseCSVLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

// =====================================================
// INTENT CLASSIFICATION
// =====================================================
const HUMAN_KEYWORDS = [
  "hablar con alguien", "persona real", "ejecutivo", "ejecutiva",
  "humano", "agente", "operador", "operadora", "asesora", "asesor",
  "quiero hablar", "necesito hablar", "transfiere", "transferir",
  "nelly", "reclamo", "queja", "supervisor", "supervisora",
  "no me sirve el bot", "no entiendes", "persona de verdad"
];

const TRACKING_KEYWORDS = [
  "pedido", "entrega", "despacho", "envio", "envío",
  "donde esta", "dónde está", "donde quedo", "dónde quedó",
  "cuando llega", "cuándo llega", "ya viene", "en camino",
  "ruta", "tracking", "rastreo", "rastrear", "seguimiento",
  "no ha llegado", "no llego", "no llegó", "demora",
  "orden", "paquete"
];

function classifyIntent(text) {
  const lower = text.toLowerCase();
  if (HUMAN_KEYWORDS.some(kw => lower.includes(kw))) return "human";
  if (TRACKING_KEYWORDS.some(kw => lower.includes(kw))) return "tracking";
  return "general";
}

// =====================================================
// GOOGLE SHEETS FAQ
// =====================================================
async function fetchFAQ() {
  if (faqCache && Date.now() - faqCacheTime < FAQ_CACHE_TTL) return faqCache;
  try {
    const url = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=FAQ`;
    const resp = await axios.get(url, { timeout: 10000 });
    const lines = resp.data.split("\n").filter(l => l.trim());
    let kb = "";
    for (let i = 1; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i]);
      if (fields.length >= 2 && fields[0] && fields[1]) {
        kb += "P: " + fields[0] + " R: " + fields[1] + " | ";
      }
    }
    faqCache = kb || "No se pudo cargar la base de conocimiento.";
    faqCacheTime = Date.now();
    console.log(`[FAQ] ${lines.length - 1} preguntas cargadas`);
    return faqCache;
  } catch (err) {
    console.error("[FAQ] Error:", err.message);
    return faqCache || "Base de conocimiento temporalmente no disponible.";
  }
}

// =====================================================
// DISPATCHTRACK (via n8n webhook ou API direta)
// =====================================================
function stripCountryCode(phone) {
  if (!phone) return phone;
  if (phone.startsWith("56") && phone.length > 9) return phone.substring(2);
  return phone;
}

function formatDispatches(dispatches) {
  const sm = {
    delivered: "Entregado", not_delivered: "No entregado",
    on_route: "En ruta", partial_delivery: "Entrega parcial", pending: "Pendiente",
  };
  return dispatches.slice(0, 3).map(d => {
    let info = "Pedido #" + d.identifier + ": " + (sm[d.status] || d.status || "Pendiente");
    if (d.contact_address) info += ". Dir: " + d.contact_address;
    if (d.estimated_at) info += ". ETA: " + d.estimated_at;
    if (d.arrived_at) info += ". Llegada: " + d.arrived_at;
    if (d.substatus) info += ". Detalle: " + d.substatus;
    if (d.items?.length > 0)
      info += ". Items: " + d.items.map(i => (i.quantity || 1) + "x " + (i.name || i.description || "Producto")).join(", ");
    return info;
  }).join(" | ");
}

async function fetchDeliveryInfo(phone) {
  if (!phone) {
    return "TELEFONO_NO_DISPONIBLE: No se pudo identificar el telefono del cliente automaticamente. Pidele amablemente su numero de telefono con codigo de pais (ej: +56912345678) para buscar su pedido. NUNCA pidas numero de pedido.";
  }
  const searchPhone = stripCountryCode(phone);
  console.log(`[DISPATCH] Buscando pedidos para ${searchPhone} (original: ${phone})`);

  // 1) Buscar no store local (dados recebidos via webhook do DispatchTrack)
  const stored = dispatchStore.get(searchPhone);
  if (stored && stored.length > 0) {
    console.log(`[DISPATCH] ${stored.length} despachos encontrados no store local`);
    return formatDispatches(stored);
  }
  // Tentar tambem com o telefone completo
  const storedFull = dispatchStore.get(phone);
  if (storedFull && storedFull.length > 0) {
    console.log(`[DISPATCH] ${storedFull.length} despachos encontrados no store (tel completo)`);
    return formatDispatches(storedFull);
  }

  // 2) Fallback: API directa de DispatchTrack
  if (DISPATCH_API_KEY) {
    try {
      const resp = await axios.get(DISPATCH_URL, {
        params: { i: searchPhone, rd: 30 },
        headers: { "X-AUTH-TOKEN": DISPATCH_API_KEY, "Content-Type": "application/json" },
        timeout: 15000,
      });
      const dispatches = Array.isArray(resp.data) ? resp.data : [];
      if (dispatches.length === 0) return "No se encontraron pedidos recientes para el telefono " + searchPhone + ".";
      return formatDispatches(dispatches);
    } catch (err) {
      console.error("[DISPATCH] API directa fallo:", err.message);
    }
  }

  return "No se encontraron pedidos recientes. Si tu pedido es reciente, por favor intenta mas tarde o escribe \"hablar con ejecutivo\".";
}

// =====================================================
// GROQ LLM
// =====================================================
async function callGroq(systemPrompt, userMessage) {
  try {
    const resp = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        max_tokens: 300,
        temperature: 0.3,
      },
      {
        headers: { Authorization: "Bearer " + GROQ_API_KEY, "Content-Type": "application/json" },
        timeout: 30000,
      }
    );
    return resp.data?.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error("[GROQ] Error:", err.message);
    return null;
  }
}

// =====================================================
// GROQ WHISPER
// =====================================================
async function transcribeAudio(audioBuffer) {
  if (!GROQ_API_KEY) return "[Audio - transcripcion no disponible]";
  try {
    const FormData = (await import("form-data")).default;
    const form = new FormData();
    form.append("file", audioBuffer, { filename: "audio.ogg", contentType: "audio/ogg" });
    form.append("model", "whisper-large-v3");
    form.append("language", "es");
    const resp = await axios.post(
      "https://api.groq.com/openai/v1/audio/transcriptions", form,
      { headers: { Authorization: "Bearer " + GROQ_API_KEY, ...form.getHeaders() }, maxBodyLength: Infinity }
    );
    return resp.data.text || "[Audio no transcrito]";
  } catch (err) {
    console.error("[WHISPER]", err.message);
    return "[Error transcribiendo audio]";
  }
}

// =====================================================
// FALLBACK MESSAGE
// =====================================================
const FALLBACK_MSG = 'Disculpa, tuvimos un problema tecnico. Puedes escribir "hablar con ejecutivo" para que te atienda una persona, o intentar de nuevo en unos minutos.';

// =====================================================
// INTENT HANDLERS
// =====================================================
async function handleHuman(jid, phone, name, message) {
  pauseChat(jid);

  const greeting = name !== "Cliente" ? name + ", entendido" : "Entendido";
  const clientMsg = greeting + " 🙌 Te estoy derivando con un ejecutivo de AMA Pet. " +
    "Nelly se comunicara contigo a la brevedad. " +
    "Nuestro horario de atencion es de lunes a viernes de 9:00 a 18:00 hrs.";
  await sock.sendMessage(jid, { text: clientMsg });

  const nellyMsg = "🔔 *SOLICITUD DE ATENCION HUMANA*\n\n" +
    "Cliente: " + name + "\n" +
    "Telefono: " + (phone || "No disponible (WhatsApp nuevo formato)") + "\n" +
    "Mensaje: " + message + "\n\n" +
    "El bot fue pausado 48h para este cliente.";
  try {
    await sock.sendMessage(NELLY_PHONE + "@s.whatsapp.net", { text: nellyMsg });
    console.log("[HUMAN] Nelly notificada");
  } catch (err) {
    console.error("[HUMAN] Error notificando Nelly:", err.message);
  }
}

async function handleTracking(jid, phone, message) {
  const deliveryInfo = await fetchDeliveryInfo(phone);
  const sysPrompt =
    "Eres Ama Bot, asistente de AMA Pet (alimento natural para mascotas, Chile). " +
    "Espanol chileno, amigable, profesional. Max 2-3 oraciones. Max 1 emoji. No inventes. " +
    "INFO DE ENTREGA: " + deliveryInfo + " " +
    "REGLAS: Si dice TELEFONO_NO_DISPONIBLE, pide su numero de telefono con codigo de pais (ej: +56912345678). " +
    "NUNCA pidas numero de pedido. En ruta = en camino. Entregado = confirma. No entregado = explica. " +
    'Siempre ofrece "hablar con ejecutivo" si no queda satisfecho.';

  const reply = await callGroq(sysPrompt, message);
  await sock.sendMessage(jid, { text: reply || FALLBACK_MSG });
}

async function handleGeneral(jid, message) {
  const kb = await fetchFAQ();
  const sysPrompt =
    "Eres Ama Bot, asistente de AMA Pet (alimento 100% natural para perros y gatos, Chile). " +
    "Espanol chileno, amigable, profesional. Max 2-3 oraciones. Max 1 emoji. No inventes. " +
    "No saludes por nombre a menos que el cliente diga su nombre. " +
    "Contacto: (+56) 9 7510 2052, ama.pet. Lunes a viernes 9-18h. " +
    "Congelados descontinuados abril 2026. Solo sachet y vidrio. " +
    "BASE DE CONOCIMIENTO: " + kb + " " +
    "REGLAS: 1) Solo info de la base. 2) Si no sabes, ofrece derivar con ejecutivo. " +
    "3) Pedidos/entregas: diles que escriban 'donde esta mi pedido'. 4) NUNCA pidas numero de pedido.";

  const reply = await callGroq(sysPrompt, message);
  await sock.sendMessage(jid, { text: reply || FALLBACK_MSG });
}

// =====================================================
// ORCHESTRATOR
// =====================================================
async function processMessage(jid, phone, name, text) {
  if (isPaused(jid)) {
    console.log(`[PAUSED] ${jid} ignorado`);
    return;
  }
  const intent = classifyIntent(text);
  console.log(`[INTENT] ${intent} | ${name} | ${text.substring(0, 60)}`);

  switch (intent) {
    case "human": await handleHuman(jid, phone, name, text); break;
    case "tracking": await handleTracking(jid, phone, text); break;
    default: await handleGeneral(jid, text); break;
  }
}

// =====================================================
// EXPRESS
// =====================================================
const app = express();
app.use(express.json({ limit: "50mb" }));

app.get("/", (req, res) => {
  res.json({
    status: connectionStatus, service: "AMA Pet WhatsApp Bot",
    timestamp: new Date().toISOString(),
    paused: pausedChats.size, faq: !!faqCache,
  });
});

app.get("/pair", async (req, res) => {
  if (connectionStatus === "connected") {
    return res.send(`<html><body style="font-family:Arial;text-align:center;padding:60px;background:#0a0a0a;color:#0f0">
      <h1>BOT CONECTADO</h1></body></html>`);
  }
  let qr = "";
  if (currentQR) { try { qr = await QRCode.toDataURL(currentQR, { width: 400, margin: 2 }); } catch (e) {} }
  res.send(`<html><head><meta http-equiv="refresh" content="5"><title>AMA Bot</title></head>
  <body style="font-family:Arial;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
    <h1>AMA Pet WhatsApp Bot</h1>
    <p>Estado: <b style="color:${connectionStatus === "connected" ? "#0f0" : "#f90"}">${connectionStatus}</b></p>
    ${qr ? `<div style="background:#fff;border-radius:16px;padding:20px;display:inline-block;margin:20px">
      <img src="${qr}" style="width:350px;height:350px"/></div>` : `<p style="color:#f90">Esperando QR...</p>`}
  </body></html>`);
});

app.post("/api/send-message", async (req, res) => {
  try {
    if (!API_SECRET || req.headers.authorization !== "Bearer " + API_SECRET) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const { jid, phone, message } = req.body;
    if (!message || (!jid && !phone)) return res.status(400).json({ error: "missing params" });
    const target = jid || (phone.includes("@") ? phone : phone + "@s.whatsapp.net");
    await sock.sendMessage(target, { text: message });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =====================================================
// WEBHOOK DISPATCHTRACK (recebe dados de despachos)
// =====================================================
app.post("/webhook/dispatch", (req, res) => {
  try {
    const data = req.body;
    console.log("[WEBHOOK] Dispatch recebido:", JSON.stringify(data).substring(0, 200));

    // DispatchTrack envia dispatch individual ou dentro de route
    const dispatches = [];
    if (data.dispatches) {
      dispatches.push(...(Array.isArray(data.dispatches) ? data.dispatches : [data.dispatches]));
    } else if (data.identifier && data.contact_phone) {
      dispatches.push(data);
    } else if (data.route?.dispatches) {
      dispatches.push(...data.route.dispatches);
    } else if (data.response?.dispatches) {
      dispatches.push(...data.response.dispatches);
    } else if (data.response?.route?.dispatches) {
      dispatches.push(...data.response.route.dispatches);
    }

    let stored = 0;
    for (const d of dispatches) {
      if (!d.contact_phone) continue;
      // Normalizar telefone (sem +, sem espacos)
      const phone = d.contact_phone.replace(/[^0-9]/g, "");
      const phoneShort = stripCountryCode(phone);

      // Guardar indexado por telefone (sem e com codigo de pais)
      for (const key of [phone, phoneShort]) {
        if (!dispatchStore.has(key)) dispatchStore.set(key, []);
        const list = dispatchStore.get(key);
        // Atualizar se ja existe com mesmo identifier, ou adicionar
        const idx = list.findIndex(x => x.identifier === d.identifier);
        if (idx >= 0) list[idx] = d;
        else list.push(d);
      }
      stored++;
    }

    console.log(`[WEBHOOK] ${stored} despachos armazenados. Total telefones: ${dispatchStore.size}`);
    res.json({ status: "ok", stored });
  } catch (err) {
    console.error("[WEBHOOK] Error:", err.message);
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.get("/webhook/dispatch/status", (req, res) => {
  const phones = [];
  for (const [phone, dispatches] of dispatchStore) {
    phones.push({ phone, count: dispatches.length });
  }
  res.json({ total_phones: dispatchStore.size, phones });
});

// API publica pra qualquer sistema consultar despachos por telefone
app.get("/api/dispatches", (req, res) => {
  const phone = (req.query.phone || "").replace(/[^0-9]/g, "");
  if (!phone) return res.status(400).json({ error: "parametro ?phone= obrigatorio" });
  const searchPhone = stripCountryCode(phone);
  const results = dispatchStore.get(searchPhone) || dispatchStore.get(phone) || [];
  res.json({ phone: searchPhone, count: results.length, dispatches: results });
});

// =====================================================
// BAILEYS
// =====================================================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version, auth: state, logger: pino({ level: "warn" }),
    printQRInTerminal: false, browser: ["AMA Pet Bot", "Chrome", "1.0.0"],
    connectTimeoutMs: 60000, defaultQueryTimeoutMs: 0, keepAliveIntervalMs: 30000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) { currentQR = qr; connectionStatus = "waiting_qr"; console.log("[QR] Escanea en /pair"); }
    if (connection === "close") {
      connectionStatus = "disconnected"; currentQR = null;
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
      }
      setTimeout(startBot, 5000);
    }
    if (connection === "open") {
      connectionStatus = "connected"; currentQR = null;
      console.log("\n=== BOT CONECTADO ===\n");
      fetchFAQ();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      let text = "";
      try {
        if (msg.key.fromMe || msg.key.remoteJid?.endsWith("@g.us")) continue;
        if (msg.key.remoteJid === "status@broadcast") continue;
        if (msg.key.remoteJid?.endsWith("@broadcast")) continue;
        if (msg.key.remoteJid?.endsWith("@newsletter")) continue;
        if (processedMessages.has(msg.key.id)) continue;
        markProcessed(msg.key.id);

        const jid = msg.key.remoteJid;
        const phone = extractPhone(jid);
        const name = cleanName(msg.pushName);

        if (msg.message?.conversation) text = msg.message.conversation;
        else if (msg.message?.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
        else if (msg.message?.audioMessage) {
          try {
            const buf = await downloadMediaMessage(msg, "buffer", {});
            text = await transcribeAudio(buf);
          } catch (e) { text = "[Audio no procesado]"; }
        } else if (msg.message?.imageMessage) {
          text = msg.message.imageMessage.caption || "[Imagen recibida]";
        } else continue;

        if (!text) continue;
        console.log(`[MSG] ${name} (ph:${phone || "LID"}): ${text.substring(0, 80)}`);
        await processMessage(jid, phone, name, text);
      } catch (err) {
        console.error("[ERROR]", err.message);
        if (text) {
          try { await sock.sendMessage(msg.key.remoteJid, { text: FALLBACK_MSG }); } catch (e) {}
        }
      }
    }
  });
}

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================
function gracefulShutdown(signal) {
  console.log(`[SHUTDOWN] ${signal} received, closing...`);
  if (sock) {
    try { sock.end(); } catch (e) {}
  }
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// =====================================================
// START
// =====================================================
if (require.main === module) {
  app.listen(PORT, () => { console.log(`[SERVER] Puerto ${PORT}`); startBot(); });
}

module.exports = {
  classifyIntent, cleanName, extractPhone, isPaused, pauseChat, pausedChats,
  HUMAN_KEYWORDS, TRACKING_KEYWORDS, FALLBACK_MSG, parseCSVLine,
  stripCountryCode, dispatchStore,
};
