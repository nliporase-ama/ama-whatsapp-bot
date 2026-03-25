/**
 * AMA Pet WhatsApp Bot - Simulador Interativo
 *
 * DOIS MODOS:
 *   node simulator.js          → modo MOCK (respostas fake, sem APIs)
 *   node simulator.js --live   → modo LIVE (Groq real + FAQ real + DispatchTrack real, sem WhatsApp)
 *
 * O modo --live precisa de um arquivo .env com as chaves:
 *   GROQ_API_KEY=gsk_...
 *   DISPATCH_API_KEY=bd69...
 *   GOOGLE_SHEET_ID=1_W6...
 */

const readline = require("readline");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const {
  classifyIntent, cleanName, extractPhone, isPaused, pauseChat, pausedChats,
  HUMAN_KEYWORDS, TRACKING_KEYWORDS, FALLBACK_MSG, parseCSVLine,
} = require("./src/index.js");

// =====================================================
// MODE DETECTION
// =====================================================
const LIVE_MODE = process.argv.includes("--live");

// Load .env manually (no dotenv dependency)
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return {};
  const vars = {};
  fs.readFileSync(envPath, "utf8").split("\n").forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return;
    const key = trimmed.substring(0, eq).trim();
    const val = trimmed.substring(eq + 1).trim();
    vars[key] = val;
  });
  return vars;
}

const env = loadEnv();
const GROQ_API_KEY = process.env.GROQ_API_KEY || env.GROQ_API_KEY || "";
const DISPATCH_API_KEY = process.env.DISPATCH_API_KEY || env.DISPATCH_API_KEY || "";
const DISPATCH_URL = "https://logicold.dispatchtrack.com/api/external/v1/dispatches";
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || env.GOOGLE_SHEET_ID || "";
const NELLY_PHONE = process.env.NELLY_PHONE || env.NELLY_PHONE || "56996135264";

// =====================================================
// MOCK DATA (usado no modo mock)
// =====================================================
const MOCK_DISPATCHES = {
  "56912345678": [
    {
      identifier: "AMA-1001", status: "on_route",
      contact_address: "Av. Providencia 1234, Santiago",
      estimated_at: "14:00-16:00", arrived_at: null, substatus: null,
      items: [{ quantity: 2, name: "Sachet Pollo 500g" }, { quantity: 1, name: "Sachet Res 300g" }],
    },
    {
      identifier: "AMA-0998", status: "delivered",
      contact_address: "Av. Providencia 1234, Santiago",
      estimated_at: null, arrived_at: "2026-03-24 11:30", substatus: null,
      items: [{ quantity: 1, name: "Vidrio Res 200g" }],
    },
  ],
  "56998765432": [
    {
      identifier: "AMA-1005", status: "not_delivered",
      contact_address: "Los Leones 567, Providencia",
      estimated_at: null, arrived_at: null, substatus: "Cliente ausente",
      items: [{ quantity: 3, name: "Sachet Salmon 500g" }],
    },
  ],
  "56911112222": [],
};

const MOCK_FAQ = "P: Que productos tienen? R: Tenemos alimento 100% natural en formato sachet y vidrio para perros y gatos. " +
  "| P: Hacen envios a regiones? R: Si, hacemos envios a todo Chile a traves de Chilexpress y Starken. " +
  "| P: Cual es el horario de atencion? R: Nuestro horario de atencion es de lunes a viernes de 9:00 a 18:00 hrs. " +
  "| P: Los congelados estan disponibles? R: Los congelados fueron descontinuados en abril 2026. Actualmente solo ofrecemos sachet y vidrio. " +
  "| P: Como puedo hacer un pedido? R: Puedes hacer tu pedido en ama.pet o escribirnos al (+56) 9 7510 2052. " +
  "| P: Que ingredientes usan? R: Usamos ingredientes 100% naturales: proteina animal, verduras frescas, sin colorantes ni preservantes artificiales. " +
  "| P: Tienen productos para gatos? R: Si, tenemos linea completa para gatos en sachet y vidrio. " +
  "| P: Cual es el precio? R: Los precios varian segun el producto. Puedes ver el catalogo completo en ama.pet. " +
  "| P: Aceptan transferencia bancaria? R: Si, aceptamos transferencia, tarjeta de credito y debito. " +
  "| P: Cuanto demora el envio? R: En Santiago 1-2 dias habiles. Regiones 3-5 dias habiles.";

// =====================================================
// STATE
// =====================================================
const sentMessages = [];
let liveFaqCache = null;

// =====================================================
// MOCK SOCK (captura mensagens)
// =====================================================
const mockSock = {
  sendMessage: async (jid, content) => {
    const entry = { jid, text: content.text, timestamp: new Date().toISOString() };
    sentMessages.push(entry);
    const target = jid === NELLY_PHONE + "@s.whatsapp.net" ? "NELLY" : jid;
    console.log(`\n  \x1b[36m[BOT -> ${target}]\x1b[0m ${content.text}\n`);
  },
};

// =====================================================
// LIVE FUNCTIONS (APIs reais)
// =====================================================
async function liveCallGroq(systemPrompt, userMessage) {
  try {
    console.log("  \x1b[90m[GROQ] Chamando API...\x1b[0m");
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
    console.error("  \x1b[31m[GROQ] Error:\x1b[0m", err.response?.data?.error?.message || err.message);
    return null;
  }
}

async function liveFetchFAQ() {
  if (liveFaqCache) return liveFaqCache;
  try {
    console.log("  \x1b[90m[FAQ] Carregando Google Sheets...\x1b[0m");
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
    liveFaqCache = kb || "No se pudo cargar la base de conocimiento.";
    console.log(`  \x1b[90m[FAQ] ${lines.length - 1} preguntas cargadas\x1b[0m`);
    return liveFaqCache;
  } catch (err) {
    console.error("  \x1b[31m[FAQ] Error:\x1b[0m", err.message);
    return "Base de conocimiento temporalmente no disponible.";
  }
}

async function liveFetchDeliveryInfo(phone) {
  if (!phone) {
    return "TELEFONO_NO_DISPONIBLE: No se pudo identificar el telefono del cliente automaticamente. Pidele amablemente su numero de telefono con codigo de pais (ej: +56912345678) para buscar su pedido. NUNCA pidas numero de pedido.";
  }
  try {
    console.log(`  \x1b[90m[DISPATCH] Consultando pedidos para ${phone}...\x1b[0m`);
    const resp = await axios.get(DISPATCH_URL, {
      params: { i: phone, rd: 30 },
      headers: { "X-AUTH-TOKEN": DISPATCH_API_KEY, "Content-Type": "application/json" },
      timeout: 15000,
    });
    const dispatches = Array.isArray(resp.data) ? resp.data : [];
    if (dispatches.length === 0) return "No se encontraron pedidos recientes para el telefono " + phone + ".";

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
  } catch (err) {
    console.error("  \x1b[31m[DISPATCH] Error:\x1b[0m", err.message);
    return "Error consultando entregas.";
  }
}

// =====================================================
// MOCK FUNCTIONS (respostas fake)
// =====================================================
function mockFetchDeliveryInfo(phone) {
  if (!phone) {
    return "TELEFONO_NO_DISPONIBLE: No se pudo identificar el telefono del cliente automaticamente. Pidele amablemente su numero de telefono con codigo de pais (ej: +56912345678) para buscar su pedido. NUNCA pidas numero de pedido.";
  }
  const dispatches = MOCK_DISPATCHES[phone];
  if (!dispatches || dispatches.length === 0) {
    return "No se encontraron pedidos recientes para el telefono " + phone + ".";
  }
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

function mockCallGroq(systemPrompt, userMessage) {
  const lower = userMessage.toLowerCase();
  const deliveryMatch = systemPrompt.match(/INFO DE ENTREGA: (.+?) REGLAS:/);
  const deliveryInfo = deliveryMatch ? deliveryMatch[1] : "";

  if (deliveryInfo.includes("TELEFONO_NO_DISPONIBLE")) {
    return "Para poder revisar el estado de tu pedido, necesito tu numero de telefono con codigo de pais (ej: +56912345678) 📦";
  }
  if (deliveryInfo.includes("No se encontraron pedidos")) {
    return 'No encontramos pedidos recientes con ese numero. Puedes verificar el telefono o escribir "hablar con ejecutivo" para mas ayuda 🤔';
  }
  if (deliveryInfo.includes("Pedido #")) {
    if (deliveryInfo.includes("No entregado")) {
      const match = deliveryInfo.match(/Pedido #(\S+):/);
      const id = match ? match[1] : "tu pedido";
      const detail = deliveryInfo.match(/Detalle: ([^.]+)/);
      return `Tu pedido ${id} no pudo ser entregado${detail ? " (" + detail[1] + ")" : ""}. Coordinaremos una nueva entrega. Escribe "hablar con ejecutivo" si necesitas ayuda 📦`;
    }
    if (deliveryInfo.includes("En ruta")) {
      const match = deliveryInfo.match(/Pedido #(\S+):/);
      const id = match ? match[1] : "tu pedido";
      const eta = deliveryInfo.match(/ETA: ([^.]+)/);
      return `Tu pedido ${id} esta en camino! ${eta ? "Llegaria entre las " + eta[1] + "." : ""} Te avisaremos cuando llegue 🚚`;
    }
    if (deliveryInfo.includes("Entregado")) {
      const match = deliveryInfo.match(/Pedido #(\S+):/);
      const id = match ? match[1] : "tu pedido";
      return `Tu pedido ${id} ya fue entregado. Si tienes algun problema con la entrega, escribe "hablar con ejecutivo" ✅`;
    }
    return 'Encontre informacion de tu pedido. Para mas detalles, escribe "hablar con ejecutivo" 📦';
  }
  if (systemPrompt.includes("BASE DE CONOCIMIENTO")) {
    if (lower.includes("producto") || lower.includes("que venden") || lower.includes("que tienen")) {
      return "Tenemos alimento 100% natural en formato sachet y vidrio para perros y gatos. Puedes ver todo en ama.pet 🐾";
    }
    if (lower.includes("envio") || lower.includes("despacho") || lower.includes("region")) {
      return "Hacemos envios a todo Chile. Santiago 1-2 dias, regiones 3-5 dias habiles 📦";
    }
    if (lower.includes("horario")) {
      return "Nuestro horario de atencion es de lunes a viernes de 9:00 a 18:00 hrs 🕐";
    }
    if (lower.includes("congelado")) {
      return "Los congelados fueron descontinuados en abril 2026. Actualmente solo tenemos sachet y vidrio 🐾";
    }
    if (lower.includes("precio") || lower.includes("costo") || lower.includes("valor")) {
      return "Los precios varian segun el producto. Puedes ver el catalogo completo en ama.pet 🐾";
    }
    if (lower.includes("ingrediente") || lower.includes("natural")) {
      return "Usamos ingredientes 100% naturales: proteina animal, verduras frescas, sin colorantes ni preservantes artificiales 🌿";
    }
    if (lower.includes("gato")) {
      return "Si, tenemos linea completa para gatos en sachet y vidrio. Revisa ama.pet para ver las opciones 🐱";
    }
    if (lower.includes("pago") || lower.includes("transferencia") || lower.includes("tarjeta")) {
      return "Aceptamos transferencia bancaria, tarjeta de credito y debito 💳";
    }
    if (lower.includes("pedido") || lower.includes("donde esta") || lower.includes("entrega")) {
      return 'Para consultar el estado de tu pedido, escribe "donde esta mi pedido" y te ayudo a rastrearlo 📦';
    }
    if (lower.includes("hola") || lower.includes("buenas") || lower.includes("buenos")) {
      return "Hola! Soy el asistente de AMA Pet. En que puedo ayudarte? 🐾";
    }
    return 'No tengo esa informacion especifica, pero puedo derivarte con un ejecutivo. Escribe "hablar con ejecutivo" si lo necesitas 🐾';
  }
  return FALLBACK_MSG;
}

// =====================================================
// UNIFIED HANDLERS (usam mock ou live dependendo do modo)
// =====================================================
async function handleHuman(jid, phone, name, message) {
  pauseChat(jid);
  const greeting = name !== "Cliente" ? name + ", entendido" : "Entendido";
  const clientMsg = greeting + " 🙌 Te estoy derivando con un ejecutivo de AMA Pet. " +
    "Nelly se comunicara contigo a la brevedad. " +
    "Nuestro horario de atencion es de lunes a viernes de 9:00 a 18:00 hrs.";
  await mockSock.sendMessage(jid, { text: clientMsg });

  const nellyMsg = "🔔 *SOLICITUD DE ATENCION HUMANA*\n\n" +
    "Cliente: " + name + "\n" +
    "Telefono: " + (phone || "No disponible (WhatsApp nuevo formato)") + "\n" +
    "Mensaje: " + message + "\n\n" +
    "El bot fue pausado 48h para este cliente.";
  await mockSock.sendMessage(NELLY_PHONE + "@s.whatsapp.net", { text: nellyMsg });
}

async function handleTracking(jid, phone, message) {
  const deliveryInfo = LIVE_MODE
    ? await liveFetchDeliveryInfo(phone)
    : mockFetchDeliveryInfo(phone);

  const sysPrompt =
    "Eres Ama Bot, asistente de AMA Pet (alimento natural para mascotas, Chile). " +
    "Espanol chileno, amigable, profesional. Max 2-3 oraciones. Max 1 emoji. No inventes. " +
    "INFO DE ENTREGA: " + deliveryInfo + " " +
    "REGLAS: Si dice TELEFONO_NO_DISPONIBLE, pide su numero de telefono con codigo de pais (ej: +56912345678). " +
    "NUNCA pidas numero de pedido. En ruta = en camino. Entregado = confirma. No entregado = explica. " +
    'Siempre ofrece "hablar con ejecutivo" si no queda satisfecho.';

  const reply = LIVE_MODE
    ? await liveCallGroq(sysPrompt, message)
    : mockCallGroq(sysPrompt, message);
  await mockSock.sendMessage(jid, { text: reply || FALLBACK_MSG });
}

async function handleGeneral(jid, message) {
  const kb = LIVE_MODE ? await liveFetchFAQ() : MOCK_FAQ;

  const sysPrompt =
    "Eres Ama Bot, asistente de AMA Pet (alimento 100% natural para perros y gatos, Chile). " +
    "Espanol chileno, amigable, profesional. Max 2-3 oraciones. Max 1 emoji. No inventes. " +
    "No saludes por nombre a menos que el cliente diga su nombre. " +
    "Contacto: (+56) 9 7510 2052, ama.pet. Lunes a viernes 9-18h. " +
    "Congelados descontinuados abril 2026. Solo sachet y vidrio. " +
    "BASE DE CONOCIMIENTO: " + kb + " " +
    "REGLAS: 1) Solo info de la base. 2) Si no sabes, ofrece derivar con ejecutivo. " +
    "3) Pedidos/entregas: diles que escriban 'donde esta mi pedido'. 4) NUNCA pidas numero de pedido.";

  const reply = LIVE_MODE
    ? await liveCallGroq(sysPrompt, message)
    : mockCallGroq(sysPrompt, message);
  await mockSock.sendMessage(jid, { text: reply || FALLBACK_MSG });
}

// =====================================================
// SIMULATOR ENGINE
// =====================================================
let currentPhone = "56912345678";
let currentName = "Maria";
let currentJid = currentPhone + "@s.whatsapp.net";
let isLid = false;

function updateJid() {
  if (isLid) {
    currentJid = Math.random().toString(36).substring(2, 15) + "@lid";
  } else {
    currentJid = currentPhone + "@s.whatsapp.net";
  }
}

async function simulateMessage(text) {
  const phone = isLid ? null : extractPhone(currentJid);
  const name = cleanName(currentName);

  console.log(`  \x1b[33m[MSG] ${name} (ph:${phone || "LID"}): ${text}\x1b[0m`);

  if (isPaused(currentJid)) {
    console.log("  \x1b[31m[PAUSED] Chat pausado, mensaje ignorado\x1b[0m\n");
    return;
  }

  const intent = classifyIntent(text);
  console.log(`  \x1b[35m[INTENT] ${intent}\x1b[0m`);

  switch (intent) {
    case "human": await handleHuman(currentJid, phone, name, text); break;
    case "tracking": await handleTracking(currentJid, phone, text); break;
    default: await handleGeneral(currentJid, text); break;
  }
}

// =====================================================
// CLI COMMANDS
// =====================================================
function showHelp() {
  console.log(`
\x1b[1m=== COMANDOS ===\x1b[0m
  /client <phone>   Cambiar a cliente con este telefono (ej: /client 56912345678)
  /lid              Cambiar a cliente LID (sin telefono disponible)
  /name <nombre>    Cambiar nombre del cliente (ej: /name Carlos)
  /status           Mostrar estado del bot
  /unpause          Despausar el cliente actual
  /history          Mostrar historial de mensajes enviados
  /phones           Mostrar telefonos mock disponibles con pedidos
  /keywords         Mostrar keywords de clasificacion
  /faq              ${LIVE_MODE ? "Recargar FAQ do Google Sheets" : "Mostrar FAQ mock"}
  /csv <line>       Testar o parser CSV com uma linha
  /help             Mostrar esta ayuda
  /quit             Salir

\x1b[1m=== CENARIOS DE TESTE ===\x1b[0m
  1. "hola" -> intent general (FAQ)
  2. "donde esta mi pedido" -> intent tracking (com telefone)
  3. /lid + "donde esta mi pedido" -> pede telefone
  4. "hablar con ejecutivo" -> intent human (pausa + notifica Nelly)
  5. Mensagem apos pausa -> ignorado
  6. /unpause + mensagem -> funciona de novo
  7. "que productos tienen" -> FAQ
  8. "cuanto demora el envio" -> FAQ
`);
}

function showStatus() {
  console.log(`
\x1b[1m=== STATUS ===\x1b[0m
  Modo:           ${LIVE_MODE ? "\x1b[32mLIVE (APIs reais)\x1b[0m" : "\x1b[33mMOCK (respostas fake)\x1b[0m"}
  Groq API:       ${GROQ_API_KEY ? "\x1b[32mconfigurada\x1b[0m" : "\x1b[31mnao configurada\x1b[0m"}
  DispatchTrack:  ${DISPATCH_API_KEY ? "\x1b[32mconfigurada\x1b[0m" : "\x1b[31mnao configurada\x1b[0m"}
  Google Sheet:   ${GOOGLE_SHEET_ID ? "\x1b[32mconfigurado\x1b[0m" : "\x1b[31mnao configurado\x1b[0m"}
  FAQ cache:      ${liveFaqCache ? "carregada" : "nao carregada"}
  Cliente atual:  ${currentName}
  Telefone:       ${isLid ? "LID (nao disponivel)" : currentPhone}
  JID:            ${currentJid}
  Pausado:        ${isPaused(currentJid) ? "SIM" : "NAO"}
  Chats pausados: ${pausedChats.size}
  Msgs enviadas:  ${sentMessages.length}
`);
}

function showHistory() {
  if (sentMessages.length === 0) {
    console.log("\n  Nenhuma mensagem enviada ainda.\n");
    return;
  }
  console.log(`\n\x1b[1m=== HISTORICO (${sentMessages.length} msgs) ===\x1b[0m`);
  sentMessages.forEach((m, i) => {
    const target = m.jid === NELLY_PHONE + "@s.whatsapp.net" ? "NELLY" : m.jid;
    console.log(`  ${i + 1}. [${m.timestamp}] -> ${target}`);
    console.log(`     ${m.text.substring(0, 120)}${m.text.length > 120 ? "..." : ""}`);
  });
  console.log("");
}

function showPhones() {
  if (LIVE_MODE) {
    console.log(`
\x1b[1m=== MODO LIVE ===\x1b[0m
  No modo --live, qualquer telefone sera consultado na API real do DispatchTrack.
  Use /client <telefone_real> com um telefone de cliente real.
`);
  } else {
    console.log(`
\x1b[1m=== TELEFONOS MOCK ===\x1b[0m
  56912345678  -> 2 pedidos: AMA-1001 (en ruta), AMA-0998 (entregado)
  56998765432  -> 1 pedido:  AMA-1005 (no entregado - cliente ausente)
  56911112222  -> 0 pedidos  (telefone sem pedidos)
  (outro)      -> "no se encontraron pedidos"
`);
  }
}

function showKeywords() {
  console.log(`
\x1b[1m=== HUMAN KEYWORDS ===\x1b[0m
  ${HUMAN_KEYWORDS.join(", ")}

\x1b[1m=== TRACKING KEYWORDS ===\x1b[0m
  ${TRACKING_KEYWORDS.join(", ")}

\x1b[1m=== GENERAL ===\x1b[0m
  Qualquer mensagem que nao contenha keywords acima.
`);
}

// =====================================================
// MAIN
// =====================================================
console.log(`
\x1b[1m╔══════════════════════════════════════════════════╗
║       AMA Pet WhatsApp Bot - SIMULADOR           ║
╚══════════════════════════════════════════════════╝\x1b[0m

  Modo:    ${LIVE_MODE ? "\x1b[32m● LIVE (Groq + FAQ + DispatchTrack reais)\x1b[0m" : "\x1b[33m● MOCK (respostas fake, sem APIs)\x1b[0m"}
  Cliente: ${currentName} (${currentPhone})
  ${LIVE_MODE ? `Groq: ${GROQ_API_KEY ? "OK" : "FALTA!"} | Sheet: ${GOOGLE_SHEET_ID ? "OK" : "FALTA!"} | Dispatch: ${DISPATCH_API_KEY ? "OK" : "FALTA!"}` : "Para testar com IA real: node simulator.js --live"}

  Digite mensagens como se fosse o cliente.
  Use /help para ver comandos disponiveis.
`);

if (LIVE_MODE && !GROQ_API_KEY) {
  console.log("  \x1b[31m⚠ GROQ_API_KEY nao encontrada! Crie um arquivo .env com a chave.\x1b[0m\n");
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: LIVE_MODE ? "\x1b[32m[LIVE]> \x1b[0m" : "\x1b[33m[MOCK]> \x1b[0m",
});

rl.prompt();

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) { rl.prompt(); return; }

  if (trimmed.startsWith("/")) {
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(" ");

    switch (cmd) {
      case "/client":
        if (!arg) { console.log("  Uso: /client <phone> (ex: /client 56912345678)"); break; }
        currentPhone = arg.replace(/[^0-9]/g, "");
        isLid = false;
        updateJid();
        console.log(`  Cliente trocado para: ${currentName} (${currentPhone})\n`);
        break;
      case "/lid":
        isLid = true;
        updateJid();
        console.log(`  Modo LID ativado. Telefone nao disponivel. JID: ${currentJid}\n`);
        break;
      case "/name":
        if (!arg) { console.log("  Uso: /name <nombre> (ex: /name Carlos)"); break; }
        currentName = arg;
        console.log(`  Nome trocado para: ${currentName}\n`);
        break;
      case "/status":
        showStatus();
        break;
      case "/unpause":
        pausedChats.delete(currentJid);
        console.log(`  Chat despausado para ${currentJid}\n`);
        break;
      case "/history":
        showHistory();
        break;
      case "/phones":
        showPhones();
        break;
      case "/keywords":
        showKeywords();
        break;
      case "/faq":
        if (LIVE_MODE) {
          liveFaqCache = null;
          console.log("  Cache limpo. O FAQ sera recarregado na proxima mensagem.\n");
        } else {
          console.log(`  \x1b[90m${MOCK_FAQ}\x1b[0m\n`);
        }
        break;
      case "/csv":
        if (!arg) { console.log('  Uso: /csv "campo1","campo 2, com virgula","campo3"'); break; }
        console.log("  Resultado:", JSON.stringify(parseCSVLine(arg)));
        console.log("");
        break;
      case "/help":
        showHelp();
        break;
      case "/quit":
      case "/exit":
        console.log("\n  Ate logo! 🐾\n");
        process.exit(0);
      default:
        console.log(`  Comando desconhecido: ${cmd}. Use /help.\n`);
    }
  } else {
    await simulateMessage(trimmed);
  }

  rl.prompt();
});

rl.on("close", () => {
  console.log("\n  Ate logo! 🐾\n");
  process.exit(0);
});
