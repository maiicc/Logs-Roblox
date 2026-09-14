/*
  index.js — Relay opcional entre Roblox y Discord

  Por qué usar esto en vez de mandar el webhook directo desde Roblox:
  - Puedes ocultar el webhook real de Discord (Roblox solo conoce tu servidor).
  - Puedes filtrar/limitar mensajes (rate limiting), loguearlos en un archivo/DB,
    o mandar distintos eventos a distintos canales.
  - Si luego quieres crecer a comandos de Discord que controlen el juego
    (ej. /shutdown), ya tienes el bot corriendo y puedes usar Roblox Open Cloud
    para mandar mensajes de vuelta al juego con MessagingService.

  Requisitos:
    npm init -y
    npm install express discord.js dotenv

  Variables de entorno (archivo .env):
    DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/....
    RELAY_SECRET=una-clave-secreta-que-solo-tu-juego-conozca
    PORT=3000
*/

require("dotenv").config();
const express = require("express");
const { WebhookClient, EmbedBuilder } = require("discord.js");

const app = express();
app.use(express.json());

const webhookClient = new WebhookClient({ url: process.env.DISCORD_WEBHOOK_URL });
const RELAY_SECRET = process.env.RELAY_SECRET;

// Colores por tipo de evento
const COLORS = {
  server_start: 0x2ecc71, // verde
  server_close: 0xe74c3c, // rojo
  error: 0xe67e22, // naranja
  info: 0x3498db, // azul
};

// Simple protección: Roblox debe mandar el secreto en el header
function checkSecret(req, res, next) {
  const secret = req.header("x-relay-secret");
  if (!RELAY_SECRET || secret !== RELAY_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

/*
  Formato esperado del body que manda Roblox:
  {
    "type": "server_start" | "server_close" | "error" | "info",
    "title": "Servidor cerrado",
    "description": "Detalles del evento",
    "jobId": "abc-123",
    "placeId": 123456789,
    "fields": [{ "name": "Jugadores", "value": "12" }]
  }
*/
app.post("/roblox-event", checkSecret, async (req, res) => {
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
        embed.addFields({ name: f.name, value: String(f.value), inline: true });
      }
    }

    await webhookClient.send({ embeds: [embed] });

    // Aquí podrías también loguear el evento en un archivo o base de datos
    console.log(`[relay] Evento '${type}' reenviado a Discord (JobId: ${jobId})`);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[relay] Error procesando evento:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

app.get("/health", (_req, res) => res.status(200).send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Relay escuchando en el puerto ${PORT}`);
});
