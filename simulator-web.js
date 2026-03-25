/**
 * AMA Pet WhatsApp Bot - Simulador Web
 *
 * Uso:
 *   node simulator-web.js          → modo MOCK
 *   node simulator-web.js --live   → modo LIVE (Groq + FAQ + DispatchTrack reais)
 *
 * Acesse: http://localhost:3001
 */

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const {
  classifyIntent, cleanName, extractPhone, isPaused, pauseChat, pausedChats,
  HUMAN_KEYWORDS, TRACKING_KEYWORDS, FALLBACK_MSG, parseCSVLine,
} = require("./src/index.js");

const LIVE_MODE = process.argv.includes("--live");
const PORT = 4000;

// Load .env
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return {};
  const vars = {};
  fs.readFileSync(envPath, "utf8").split("\n").forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return;
    vars[trimmed.substring(0, eq).trim()] = trimmed.substring(eq + 1).trim();
  });
  return vars;
}

const env = loadEnv();
const GROQ_API_KEY = process.env.GROQ_API_KEY || env.GROQ_API_KEY || "";
const DISPATCH_API_KEY = process.env.DISPATCH_API_KEY || env.DISPATCH_API_KEY || "";
const DISPATCH_URL = process.env.DISPATCH_URL || env.DISPATCH_URL || "https://logicold.dispatchtrack.com/api/external/v1/dispatches";
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || env.N8N_WEBHOOK_URL || "";
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || env.GOOGLE_SHEET_ID || "";
const NELLY_PHONE = process.env.NELLY_PHONE || env.NELLY_PHONE || "56996135264";

function stripCountryCode(phone) {
  if (!phone) return phone;
  if (phone.startsWith("56") && phone.length > 9) return phone.substring(2);
  return phone;
}

// =====================================================
// STATE
// =====================================================
let liveFaqCache = null;
const logs = [];

function log(tag, msg) {
  const entry = { tag, msg, ts: new Date().toISOString() };
  logs.push(entry);
  if (logs.length > 200) logs.shift();
  console.log(`[${tag}] ${msg}`);
}

// =====================================================
// MOCK DATA
// =====================================================
const MOCK_DISPATCHES = {
  "56912345678": [
    { identifier: "AMA-1001", status: "on_route", contact_address: "Av. Providencia 1234, Santiago", estimated_at: "14:00-16:00", arrived_at: null, substatus: null, items: [{ quantity: 2, name: "Sachet Pollo 500g" }, { quantity: 1, name: "Sachet Res 300g" }] },
    { identifier: "AMA-0998", status: "delivered", contact_address: "Av. Providencia 1234, Santiago", estimated_at: null, arrived_at: "2026-03-24 11:30", substatus: null, items: [{ quantity: 1, name: "Vidrio Res 200g" }] },
  ],
  "56998765432": [
    { identifier: "AMA-1005", status: "not_delivered", contact_address: "Los Leones 567, Providencia", estimated_at: null, arrived_at: null, substatus: "Cliente ausente", items: [{ quantity: 3, name: "Sachet Salmon 500g" }] },
  ],
  "56911112222": [],
};

const MOCK_FAQ = "P: Que productos tienen? R: Tenemos alimento 100% natural en formato sachet y vidrio para perros y gatos. | P: Hacen envios a regiones? R: Si, hacemos envios a todo Chile. | P: Cual es el horario de atencion? R: Lunes a viernes de 9:00 a 18:00 hrs. | P: Los congelados estan disponibles? R: Descontinuados abril 2026. Solo sachet y vidrio. | P: Como puedo hacer un pedido? R: En ama.pet o al (+56) 9 7510 2052. | P: Que ingredientes usan? R: 100% naturales, proteina animal, verduras frescas, sin preservantes. | P: Tienen productos para gatos? R: Si, linea completa en sachet y vidrio. | P: Cual es el precio? R: Varia segun producto, ver ama.pet. | P: Aceptan transferencia? R: Si, transferencia, credito y debito. | P: Cuanto demora el envio? R: Santiago 1-2 dias, regiones 3-5 dias.";

// =====================================================
// LIVE FUNCTIONS
// =====================================================
async function liveCallGroq(systemPrompt, userMessage) {
  log("GROQ", "Chamando API...");
  try {
    const resp = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
      max_tokens: 300, temperature: 0.3,
    }, {
      headers: { Authorization: "Bearer " + GROQ_API_KEY, "Content-Type": "application/json" },
      timeout: 30000,
    });
    const reply = resp.data?.choices?.[0]?.message?.content || null;
    log("GROQ", "Resposta: " + (reply || "null").substring(0, 80));
    return reply;
  } catch (err) {
    log("GROQ", "ERROR: " + (err.response?.data?.error?.message || err.message));
    return null;
  }
}

async function liveFetchFAQ() {
  if (liveFaqCache) return liveFaqCache;
  log("FAQ", "Carregando Google Sheets...");
  try {
    const url = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=FAQ`;
    const resp = await axios.get(url, { timeout: 10000 });
    const lines = resp.data.split("\n").filter(l => l.trim());
    let kb = "";
    for (let i = 1; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i]);
      if (fields.length >= 2 && fields[0] && fields[1]) kb += "P: " + fields[0] + " R: " + fields[1] + " | ";
    }
    liveFaqCache = kb || "No se pudo cargar la base de conocimiento.";
    log("FAQ", `${lines.length - 1} preguntas cargadas`);
    return liveFaqCache;
  } catch (err) {
    log("FAQ", "ERROR: " + err.message);
    return "Base de conocimiento temporalmente no disponible.";
  }
}

async function liveFetchDeliveryInfo(phone) {
  if (!phone) return "TELEFONO_NO_DISPONIBLE: No se pudo identificar el telefono del cliente automaticamente. Pidele amablemente su numero de telefono con codigo de pais (ej: +56912345678) para buscar su pedido. NUNCA pidas numero de pedido.";
  const searchPhone = stripCountryCode(phone);
  log("DISPATCH", "Buscando pedidos para " + searchPhone + " (original: " + phone + ")");

  const sm = { delivered: "Entregado", not_delivered: "No entregado", on_route: "En ruta", partial_delivery: "Entrega parcial", pending: "Pendiente" };
  const fmtDispatches = (dispatches) => dispatches.slice(0, 3).map(d => {
    let info = "Pedido #" + d.identifier + ": " + (sm[d.status] || d.status || "Pendiente");
    if (d.contact_address) info += ". Dir: " + d.contact_address;
    if (d.estimated_at) info += ". ETA: " + d.estimated_at;
    if (d.arrived_at) info += ". Llegada: " + d.arrived_at;
    if (d.substatus) info += ". Detalle: " + d.substatus;
    if (d.items?.length > 0) info += ". Items: " + d.items.map(i => (i.quantity || 1) + "x " + (i.name || i.description || "Producto")).join(", ");
    return info;
    }).join(" | ");
    log("DISPATCH", dispatches.length + " pedidos encontrados");
    return result;
  } catch (err) {
    log("DISPATCH", "ERROR: " + err.message);
    return "Error consultando entregas.";
  }
}

// =====================================================
// MOCK FUNCTIONS
// =====================================================
function mockFetchDeliveryInfo(phone) {
  if (!phone) return "TELEFONO_NO_DISPONIBLE: No se pudo identificar el telefono del cliente automaticamente. Pidele amablemente su numero de telefono con codigo de pais (ej: +56912345678) para buscar su pedido. NUNCA pidas numero de pedido.";
  const dispatches = MOCK_DISPATCHES[phone];
  if (!dispatches || dispatches.length === 0) return "No se encontraron pedidos recientes para el telefono " + phone + ".";
  const sm = { delivered: "Entregado", not_delivered: "No entregado", on_route: "En ruta", partial_delivery: "Entrega parcial", pending: "Pendiente" };
  return dispatches.slice(0, 3).map(d => {
    let info = "Pedido #" + d.identifier + ": " + (sm[d.status] || d.status || "Pendiente");
    if (d.contact_address) info += ". Dir: " + d.contact_address;
    if (d.estimated_at) info += ". ETA: " + d.estimated_at;
    if (d.arrived_at) info += ". Llegada: " + d.arrived_at;
    if (d.substatus) info += ". Detalle: " + d.substatus;
    if (d.items?.length > 0) info += ". Items: " + d.items.map(i => (i.quantity || 1) + "x " + (i.name || i.description || "Producto")).join(", ");
    return info;
  }).join(" | ");
}

function mockCallGroq(systemPrompt, userMessage) {
  const lower = userMessage.toLowerCase();
  const deliveryMatch = systemPrompt.match(/INFO DE ENTREGA: (.+?) REGLAS:/);
  const deliveryInfo = deliveryMatch ? deliveryMatch[1] : "";
  if (deliveryInfo.includes("TELEFONO_NO_DISPONIBLE")) return "Para poder revisar el estado de tu pedido, necesito tu numero de telefono con codigo de pais (ej: +56912345678) 📦";
  if (deliveryInfo.includes("No se encontraron pedidos")) return 'No encontramos pedidos recientes con ese numero. Puedes verificar el telefono o escribir "hablar con ejecutivo" para mas ayuda 🤔';
  if (deliveryInfo.includes("Pedido #")) {
    if (deliveryInfo.includes("No entregado")) { const m = deliveryInfo.match(/Pedido #(\S+):/); const d = deliveryInfo.match(/Detalle: ([^.]+)/); return `Tu pedido ${m?m[1]:"?"} no pudo ser entregado${d?" ("+d[1]+")":""}. Escribe "hablar con ejecutivo" si necesitas ayuda 📦`; }
    if (deliveryInfo.includes("En ruta")) { const m = deliveryInfo.match(/Pedido #(\S+):/); const e = deliveryInfo.match(/ETA: ([^.]+)/); return `Tu pedido ${m?m[1]:"?"} esta en camino!${e?" Llegaria entre las "+e[1]+".":""} 🚚`; }
    if (deliveryInfo.includes("Entregado")) { const m = deliveryInfo.match(/Pedido #(\S+):/); return `Tu pedido ${m?m[1]:"?"} ya fue entregado ✅`; }
    return 'Encontre info de tu pedido. Escribe "hablar con ejecutivo" para detalles 📦';
  }
  if (systemPrompt.includes("BASE DE CONOCIMIENTO")) {
    if (lower.includes("producto") || lower.includes("que venden") || lower.includes("que tienen")) return "Tenemos alimento 100% natural en formato sachet y vidrio para perros y gatos 🐾";
    if (lower.includes("envio") || lower.includes("despacho") || lower.includes("region")) return "Hacemos envios a todo Chile. Santiago 1-2 dias, regiones 3-5 dias habiles 📦";
    if (lower.includes("horario")) return "Lunes a viernes de 9:00 a 18:00 hrs 🕐";
    if (lower.includes("congelado")) return "Descontinuados en abril 2026. Solo sachet y vidrio 🐾";
    if (lower.includes("precio") || lower.includes("costo") || lower.includes("valor")) return "Los precios varian, puedes ver el catalogo en ama.pet 🐾";
    if (lower.includes("ingrediente") || lower.includes("natural")) return "100% naturales: proteina animal, verduras frescas, sin preservantes artificiales 🌿";
    if (lower.includes("gato")) return "Si, tenemos linea completa para gatos en sachet y vidrio 🐱";
    if (lower.includes("pago") || lower.includes("transferencia") || lower.includes("tarjeta")) return "Aceptamos transferencia, credito y debito 💳";
    if (lower.includes("hola") || lower.includes("buenas") || lower.includes("buenos")) return "Hola! Soy el asistente de AMA Pet. En que puedo ayudarte? 🐾";
    return 'No tengo esa info, pero puedo derivarte con un ejecutivo. Escribe "hablar con ejecutivo" 🐾';
  }
  return FALLBACK_MSG;
}

// =====================================================
// MESSAGE HANDLER
// =====================================================
async function handleMessage(text, phone, name, jid, isLid) {
  const msgLogs = [];
  const addLog = (tag, msg) => { msgLogs.push({ tag, msg, ts: new Date().toISOString() }); log(tag, msg); };
  const botMessages = [];

  const fakeSock = {
    sendMessage: async (targetJid, content) => {
      const isNelly = targetJid === NELLY_PHONE + "@s.whatsapp.net";
      botMessages.push({ jid: targetJid, text: content.text, isNelly });
      addLog("SEND", (isNelly ? "-> NELLY: " : "-> Cliente: ") + content.text.substring(0, 100));
    },
  };

  const cleanedName = cleanName(name);
  addLog("MSG", `${cleanedName} (ph:${phone || "LID"}): ${text}`);

  if (isPaused(jid)) {
    addLog("PAUSED", "Chat pausado, mensaje ignorado");
    return { botMessages, logs: msgLogs, intent: "paused", paused: true };
  }

  const intent = classifyIntent(text);
  addLog("INTENT", intent);

  if (intent === "human") {
    pauseChat(jid);
    const greeting = cleanedName !== "Cliente" ? cleanedName + ", entendido" : "Entendido";
    await fakeSock.sendMessage(jid, { text: greeting + " 🙌 Te estoy derivando con un ejecutivo de AMA Pet. Nelly se comunicara contigo a la brevedad. Nuestro horario de atencion es de lunes a viernes de 9:00 a 18:00 hrs." });
    const nellyMsg = "🔔 *SOLICITUD DE ATENCION HUMANA*\n\nCliente: " + cleanedName + "\nTelefono: " + (phone || "No disponible (WhatsApp nuevo formato)") + "\nMensaje: " + text + "\n\nEl bot fue pausado 48h para este cliente.";
    await fakeSock.sendMessage(NELLY_PHONE + "@s.whatsapp.net", { text: nellyMsg });
  } else if (intent === "tracking") {
    const deliveryInfo = LIVE_MODE ? await liveFetchDeliveryInfo(phone) : mockFetchDeliveryInfo(phone);
    addLog("DELIVERY", deliveryInfo.substring(0, 120));
    const sysPrompt = "Eres Ama Bot, asistente de AMA Pet (alimento natural para mascotas, Chile). Espanol chileno, amigable, profesional. Max 2-3 oraciones. Max 1 emoji. No inventes. INFO DE ENTREGA: " + deliveryInfo + " REGLAS: Si dice TELEFONO_NO_DISPONIBLE, pide su numero de telefono con codigo de pais (ej: +56912345678). NUNCA pidas numero de pedido. En ruta = en camino. Entregado = confirma. No entregado = explica. Siempre ofrece \"hablar con ejecutivo\" si no queda satisfecho.";
    const reply = LIVE_MODE ? await liveCallGroq(sysPrompt, text) : mockCallGroq(sysPrompt, text);
    await fakeSock.sendMessage(jid, { text: reply || FALLBACK_MSG });
  } else {
    const kb = LIVE_MODE ? await liveFetchFAQ() : MOCK_FAQ;
    const sysPrompt = "Eres Ama Bot, asistente de AMA Pet (alimento 100% natural para perros y gatos, Chile). Espanol chileno, amigable, profesional. Max 2-3 oraciones. Max 1 emoji. No inventes. No saludes por nombre a menos que el cliente diga su nombre. Contacto: (+56) 9 7510 2052, ama.pet. Lunes a viernes 9-18h. Congelados descontinuados abril 2026. Solo sachet y vidrio. BASE DE CONOCIMIENTO: " + kb + " REGLAS: 1) Solo info de la base. 2) Si no sabes, ofrece derivar con ejecutivo. 3) Pedidos/entregas: diles que escriban 'donde esta mi pedido'. 4) NUNCA pidas numero de pedido.";
    const reply = LIVE_MODE ? await liveCallGroq(sysPrompt, text) : mockCallGroq(sysPrompt, text);
    await fakeSock.sendMessage(jid, { text: reply || FALLBACK_MSG });
  }

  return { botMessages, logs: msgLogs, intent, paused: false };
}

// =====================================================
// EXPRESS + HTML
// =====================================================
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AMA Bot Simulator</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0b141a; color: #e9edef; height: 100vh; display: flex; flex-direction: column; }

  /* HEADER */
  .header { background: #202c33; padding: 10px 20px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #2a3942; }
  .header .avatar { width: 40px; height: 40px; border-radius: 50%; background: #00a884; display: flex; align-items: center; justify-content: center; font-size: 20px; }
  .header .info h2 { font-size: 16px; font-weight: 500; }
  .header .info span { font-size: 12px; color: #8696a0; }
  .mode-badge { margin-left: auto; padding: 4px 12px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .mode-live { background: #00a884; color: #111; }
  .mode-mock { background: #e9a820; color: #111; }

  /* MAIN LAYOUT */
  .main { flex: 1; display: flex; overflow: hidden; }

  /* CHAT */
  .chat-panel { flex: 1; display: flex; flex-direction: column; background: #0b141a; }
  .messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 4px; }
  .msg { max-width: 75%; padding: 8px 12px; border-radius: 8px; font-size: 14px; line-height: 1.4; word-wrap: break-word; white-space: pre-wrap; position: relative; }
  .msg-user { align-self: flex-end; background: #005c4b; border-radius: 8px 0 8px 8px; }
  .msg-bot { align-self: flex-start; background: #202c33; border-radius: 0 8px 8px 8px; }
  .msg-nelly { align-self: flex-start; background: #2a1a2e; border-left: 3px solid #a855f7; border-radius: 0 8px 8px 8px; }
  .msg-system { align-self: center; background: #182229; padding: 4px 12px; border-radius: 6px; font-size: 12px; color: #8696a0; }
  .msg .label { font-size: 11px; font-weight: 600; margin-bottom: 2px; display: block; }
  .msg-bot .label { color: #00a884; }
  .msg-nelly .label { color: #a855f7; }
  .msg .time { font-size: 10px; color: #8696a0; text-align: right; margin-top: 2px; }
  .msg .intent-tag { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; margin-left: 6px; }
  .intent-general { background: #1a3a4a; color: #54b8db; }
  .intent-tracking { background: #1a3a2a; color: #54db8a; }
  .intent-human { background: #3a2a1a; color: #dba854; }
  .intent-paused { background: #3a1a1a; color: #db5454; }

  /* INPUT */
  .input-area { background: #202c33; padding: 10px 16px; display: flex; gap: 10px; align-items: center; }
  .input-area input { flex: 1; background: #2a3942; border: none; border-radius: 8px; padding: 10px 14px; color: #e9edef; font-size: 14px; outline: none; }
  .input-area input::placeholder { color: #8696a0; }
  .input-area button { background: #00a884; border: none; border-radius: 50%; width: 40px; height: 40px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .input-area button:hover { background: #02906f; }
  .input-area button svg { fill: #111; }

  /* LOGS */
  .logs-panel { width: 360px; background: #111b21; border-left: 1px solid #2a3942; display: flex; flex-direction: column; }
  .logs-header { padding: 12px 16px; background: #202c33; font-size: 13px; font-weight: 600; color: #8696a0; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #2a3942; }
  .logs-header button { background: none; border: 1px solid #2a3942; color: #8696a0; padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }
  .logs-header button:hover { color: #e9edef; border-color: #8696a0; }
  .logs-body { flex: 1; overflow-y: auto; padding: 8px; font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: 11px; line-height: 1.6; }
  .log-entry { padding: 2px 6px; border-radius: 3px; margin-bottom: 1px; }
  .log-entry:hover { background: #1a2530; }
  .log-tag { font-weight: 700; margin-right: 6px; }
  .log-ts { color: #4a5568; margin-right: 6px; }
  .tag-MSG { color: #e9a820; } .tag-INTENT { color: #a855f7; } .tag-GROQ { color: #54b8db; }
  .tag-FAQ { color: #54db8a; } .tag-DISPATCH { color: #f97316; } .tag-SEND { color: #00a884; }
  .tag-PAUSED { color: #db5454; } .tag-DELIVERY { color: #f97316; }

  /* SETTINGS BAR */
  .settings { background: #202c33; padding: 8px 16px; display: flex; gap: 12px; align-items: center; font-size: 12px; border-top: 1px solid #2a3942; }
  .settings label { color: #8696a0; }
  .settings input, .settings select { background: #2a3942; border: 1px solid #3a4a52; border-radius: 4px; padding: 4px 8px; color: #e9edef; font-size: 12px; outline: none; }
  .settings input:focus, .settings select:focus { border-color: #00a884; }
  .settings .sep { width: 1px; height: 20px; background: #2a3942; }

  /* SCROLLBAR */
  ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: #374045; border-radius: 3px; }

  @media (max-width: 800px) { .logs-panel { display: none; } }
</style>
</head>
<body>

<div class="header">
  <div class="avatar">🐾</div>
  <div class="info">
    <h2>AMA Pet Bot Simulator</h2>
    <span id="header-status">Conectado</span>
  </div>
  <div class="mode-badge ${LIVE_MODE ? "mode-live" : "mode-mock"}">${LIVE_MODE ? "LIVE" : "MOCK"}</div>
</div>

<div class="settings">
  <label>Telefone:</label>
  <input type="text" id="phone" value="56912345678" style="width:130px" />
  <label>Nome:</label>
  <input type="text" id="name" value="Maria" style="width:100px" />
  <div class="sep"></div>
  <label>
    <input type="checkbox" id="lid-mode" /> LID (sem telefone)
  </label>
  <div class="sep"></div>
  <button onclick="doUnpause()" style="background:#2a3942;border:1px solid #3a4a52;color:#8696a0;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px">Despausar</button>
</div>

<div class="main">
  <div class="chat-panel">
    <div class="messages" id="messages"></div>
    <div class="input-area">
      <input type="text" id="msg-input" placeholder="Escribe un mensaje..." autocomplete="off" />
      <button onclick="sendMsg()">
        <svg width="20" height="20" viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
      </button>
    </div>
  </div>
  <div class="logs-panel">
    <div class="logs-header">
      <span>Logs</span>
      <button onclick="clearLogs()">Limpar</button>
    </div>
    <div class="logs-body" id="logs"></div>
  </div>
</div>

<script>
const messagesEl = document.getElementById('messages');
const logsEl = document.getElementById('logs');
const input = document.getElementById('msg-input');
const phoneInput = document.getElementById('phone');
const nameInput = document.getElementById('name');
const lidCheck = document.getElementById('lid-mode');
let sending = false;

input.addEventListener('keydown', e => { if (e.key === 'Enter' && !sending) sendMsg(); });

function time() { return new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }); }

function addMsg(text, type, extra) {
  const div = document.createElement('div');
  div.className = 'msg msg-' + type;
  let html = '';
  if (type === 'bot') html += '<span class="label">AMA Bot</span>';
  if (type === 'nelly') html += '<span class="label">-> Nelly (notificacion)</span>';
  if (extra?.intent) html += '<span class="intent-tag intent-' + extra.intent + '">' + extra.intent + '</span>';
  html += '<div>' + escapeHtml(text) + '</div>';
  html += '<div class="time">' + time() + '</div>';
  div.innerHTML = html;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg msg-system';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addLog(tag, msg, ts) {
  const div = document.createElement('div');
  div.className = 'log-entry';
  const t = new Date(ts).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  div.innerHTML = '<span class="log-ts">' + t + '</span><span class="log-tag tag-' + tag + '">[' + tag + ']</span>' + escapeHtml(msg);
  logsEl.appendChild(div);
  logsEl.scrollTop = logsEl.scrollHeight;
}

function clearLogs() { logsEl.innerHTML = ''; }

function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function sendMsg() {
  const text = input.value.trim();
  if (!text || sending) return;
  input.value = '';
  sending = true;
  input.placeholder = '${LIVE_MODE ? "Esperando IA..." : "Procesando..."}';

  addMsg(text, 'user');

  try {
    const resp = await fetch('/api/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        phone: lidCheck.checked ? null : phoneInput.value,
        name: nameInput.value,
        isLid: lidCheck.checked,
      }),
    });
    const data = await resp.json();

    data.logs.forEach(l => addLog(l.tag, l.msg, l.ts));

    if (data.paused) {
      addSystemMsg('Chat pausado - mensaje ignorado');
    } else {
      data.botMessages.forEach(m => {
        addMsg(m.text, m.isNelly ? 'nelly' : 'bot', { intent: data.intent });
      });
    }
  } catch (err) {
    addSystemMsg('Error: ' + err.message);
  }

  sending = false;
  input.placeholder = 'Escribe un mensaje...';
  input.focus();
}

async function doUnpause() {
  const phone = phoneInput.value;
  const isLid = lidCheck.checked;
  try {
    await fetch('/api/unpause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, isLid }),
    });
    addSystemMsg('Chat despausado');
  } catch (e) {}
}

// Sugestoes rapidas
const suggestions = ['hola', 'que productos tienen', 'donde esta mi pedido', 'cuanto demora el envio', 'hablar con ejecutivo', 'tienen para gatos?'];
const sugDiv = document.createElement('div');
sugDiv.style.cssText = 'padding:8px 16px;display:flex;gap:6px;flex-wrap:wrap;';
suggestions.forEach(s => {
  const btn = document.createElement('button');
  btn.textContent = s;
  btn.style.cssText = 'background:#2a3942;border:1px solid #3a4a52;color:#8696a0;padding:4px 10px;border-radius:12px;cursor:pointer;font-size:11px;';
  btn.onmouseover = () => btn.style.borderColor = '#00a884';
  btn.onmouseout = () => btn.style.borderColor = '#3a4a52';
  btn.onclick = () => { input.value = s; sendMsg(); };
  sugDiv.appendChild(btn);
});
messagesEl.appendChild(sugDiv);

input.focus();
</script>
</body>
</html>`);
});

// API endpoints
app.post("/api/simulate", async (req, res) => {
  const { text, phone, name, isLid } = req.body;
  if (!text) return res.status(400).json({ error: "missing text" });

  const jid = isLid
    ? Math.random().toString(36).substring(2, 15) + "@lid"
    : (phone || "0") + "@s.whatsapp.net";
  const actualPhone = isLid ? null : phone;

  const result = await handleMessage(text, actualPhone, name || "Cliente", jid, isLid);
  res.json(result);
});

app.post("/api/unpause", (req, res) => {
  const { phone, isLid } = req.body;
  if (isLid) {
    // Can't unpause LID without knowing the jid, clear all
    pausedChats.clear();
  } else {
    pausedChats.delete((phone || "0") + "@s.whatsapp.net");
  }
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n  AMA Bot Simulator Web - ${LIVE_MODE ? "LIVE" : "MOCK"} mode`);
  console.log(`  Abra no navegador: http://localhost:${PORT}\n`);
});
