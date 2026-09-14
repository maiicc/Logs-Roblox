/*
  index.js — Relay entre Roblox y Discord (solo Render, sin dependencias externas)

  Incluye:
    - Rate limiting del endpoint (evita que alguien lo sature)
    - Cola con reintentos para el envío a Discord (evita perder mensajes
      si Discord responde 429 "too many requests")
    - Historial en memoria (últimos N eventos) consultable vía /history

  IMPORTANTE sobre el historial: vive solo en la memoria del proceso.
  Si Render reinicia el servicio (redeploy, o se duerme por inactividad
  en el plan free y luego despierta), el historial se pierde. Es un
  historial de "corto plazo", no un registro permanente.

  Requisitos:
    npm install express discord.js dotenv express-rate-limit

  Variables de entorno (.env):
    DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/....
    RELAY_SECRET=una-clave-secreta-que-solo-tu-juego-conozca
    PORT=3000
    HISTORY_MAX_EVENTS=200   (opcional, default 200)
*/

require("dotenv").config();
const express = require("express");
const rateLimit = require("express-rate-limit");
const { WebhookClient, EmbedBuilder } = require("discord.js");

const app = express();
app.use(express.json());

const webhookClient = new WebhookClient({ url: process.env.DISCORD_WEBHOOK_URL });
const RELAY_SECRET = process.env.RELAY_SECRET;
const HISTORY_MAX_EVENTS = parseInt(process.env.HISTORY_MAX_EVENTS) || 200;

const COLORS = {
  server_start: 0x2ecc71,
  server_close: 0xe74c3c,
  error: 0xe67e22,
  info: 0x3498db,
  datastore_error: 0x992d22, // rojo oscuro — es grave
  exploit_alert: 0xf1c40f, // amarillo
  ping_alert: 0x9b59b6, // morado
};

// ── Historial en memoria ──────────────────────────────────────────────
// Array simple, más reciente al final. Se recorta a HISTORY_MAX_EVENTS.
const history = [];

function addToHistory(event) {
  history.push({ ...event, receivedAt: new Date().toISOString() });
  if (history.length > HISTORY_MAX_EVENTS) {
    history.shift(); // descarta el más antiguo
  }
}

// ── Rate limiting del endpoint ───────────────────────────────────────
const eventLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // hasta 120 eventos/minuto en total
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", detail: "Demasiadas peticiones, intenta más lento." },
});

app.use("/roblox-event", eventLimiter);

function checkSecret(req, res, next) {
  const secret = req.header("x-relay-secret");
  if (!RELAY_SECRET || secret !== RELAY_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// ── Cola de envío a Discord con reintentos ───────────────────────────
// Discord limita los webhooks a ~5 mensajes cada 2 segundos. Encolamos y
// procesamos uno por uno con un pequeño delay entre cada envío.
const sendQueue = [];
let processingQueue = false;
const QUEUE_INTERVAL_MS = 700; // ~1.4 mensajes/seg, seguro bajo el límite de Discord

function enqueueEmbed(embed) {
  sendQueue.push({ embed, attempts: 0 });
  processQueue();
}

async function processQueue() {
  if (processingQueue) return;
  processingQueue = true;

  while (sendQueue.length > 0) {
    const item = sendQueue.shift();
    try {
      await webhookClient.send({ embeds: [item.embed] });
    } catch (err) {
      item.attempts += 1;
      const retryAfterMs = err?.retry_after ? err.retry_after * 1000 : 2000;

      if (item.attempts <= 3) {
        console.warn(`[relay] Reintentando envío (intento ${item.attempts}) en ${retryAfterMs}ms`);
        setTimeout(() => {
          sendQueue.unshift(item);
          processQueue();
        }, retryAfterMs);
        break;
      } else {
        console.error("[relay] Se descartó un mensaje tras 3 intentos fallidos:", err.message);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, QUEUE_INTERVAL_MS));
  }

  processingQueue = false;
}

// ── Endpoint principal ─────────────────────────────────────────────────
app.post("/roblox-event", checkSecret, (req, res) => {
  try {
    const { type, title, description, jobId, placeId, fields } = req.body;

    const embed = new EmbedBuilder()
      .setTitle(title || "Evento de Roblox")
      .setDescription(description || "")
      .setColor(COLORS[type] || COLORS.info)
      .setTimestamp()
      .setFooter({ text: `JobId: ${jobId || "N/A"} | PlaceId: ${placeId || "N/A"}` });

    if (Array.isArray(fields)) {
      for (const f of fields) {
        embed.addFields({ name: f.name, value: String(f.value), inline: f.inline ?? true });
      }
    }

    enqueueEmbed(embed);
    addToHistory(req.body);

    console.log(`[relay] Evento '${type}' encolado (JobId: ${jobId})`);
    res.status(200).json({ ok: true, queued: true });
  } catch (err) {
    console.error("[relay] Error procesando evento:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Endpoint de historial (en memoria, se pierde en cada reinicio) ───
app.get("/history", checkSecret, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, HISTORY_MAX_EVENTS);
  const eventType = req.query.type; // opcional: filtrar por tipo de evento

  let results = history;
  if (eventType) {
    results = results.filter((e) => e.type === eventType);
  }

  // Más recientes primero
  results = results.slice(-limit).reverse();

  res.status(200).json({ count: results.length, events: results });
});

app.get("/health", (_req, res) => res.status(200).send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Relay escuchando en el puerto ${PORT}`);
});
