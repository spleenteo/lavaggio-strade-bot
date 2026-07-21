// Worker Cloudflare: bot Telegram via webhook.
//
// Flusso:
//   Telegram --POST update--> questo Worker --sendMessage--> Telegram
//
// I dati delle vie sono in KV (chiave "pulizia_strade"), già "digeriti" dallo
// script scripts/build-data.mjs. Vengono messi in cache nell'isolate globale
// per non rileggerli da KV a ogni richiesta.
//
// Variabili/secret attesi (vedi README):
//   BOT_TOKEN        (secret)  token di @BotFather
//   WEBHOOK_SECRET   (secret)  stringa segreta per validare le chiamate Telegram
//   MATCH_THRESHOLD_M (var, opzionale, default 60)
//   STREETS_KV       (binding KV)

import { nearest } from './geo.js';
import { buildReply } from './reply.js';

const DATA_KEY = 'pulizia_strade';

let DATA_CACHE = null; // { features: [...] } in memoria per l'isolate

async function loadData(env) {
  if (DATA_CACHE) return DATA_CACHE;
  const data = await env.STREETS_KV.get(DATA_KEY, 'json');
  if (!data || !Array.isArray(data.features)) {
    throw new Error('Dati non presenti in KV. Esegui build+push dei dati (vedi README).');
  }
  DATA_CACHE = data;
  return data;
}

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

const HELP =
  '👋 <b>Bot Lavaggio Strade</b>\n\n' +
  'Condividi la tua <b>posizione</b> (📎 → Posizione) e ti dico se in quella via, oggi, ' +
  'è previsto il lavaggio/spazzamento strade.\n\n' +
  'Comandi: /start (guida), /info (stato dati).\n\n' +
  'Puoi anche trascinare il segnaposto su un punto qualsiasi della mappa.';

async function handleUpdate(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const thresholdM = Number(env.MATCH_THRESHOLD_M || 60);

  // Posizione condivisa
  if (msg.location) {
    const { latitude, longitude } = msg.location;
    try {
      const data = await loadData(env);
      const match = nearest(data.features, longitude, latitude);
      const text = buildReply(match, thresholdM, new Date());
      await tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
    } catch (e) {
      await tg(env, 'sendMessage', { chat_id: chatId, text: `😓 Errore: ${e.message}` });
    }
    return;
  }

  const text = (msg.text || '').trim();
  if (text.startsWith('/start') || text.startsWith('/help')) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: HELP, parse_mode: 'HTML' });
    return;
  }
  if (text.startsWith('/info')) {
    try {
      const data = await loadData(env);
      const info =
        `📊 Vie caricate: <b>${data.features.length}</b>\n` +
        `Dati generati: ${data.generatedAt || 'n/d'}\n` +
        `Soglia di ricerca: ${thresholdM} m`;
      await tg(env, 'sendMessage', { chat_id: chatId, text: info, parse_mode: 'HTML' });
    } catch (e) {
      await tg(env, 'sendMessage', { chat_id: chatId, text: `Errore: ${e.message}` });
    }
    return;
  }

  if (text) {
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: 'Per controllare, condividi la <b>posizione</b> (📎 → Posizione). /start per la guida.',
      parse_mode: 'HTML',
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    // Healthcheck / pagina d'aiuto per GET.
    if (request.method === 'GET') {
      return new Response('Bot Lavaggio Strade attivo. Il webhook risponde su POST.', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Verifica che la chiamata arrivi davvero da Telegram (secret token).
    if (env.WEBHOOK_SECRET) {
      const got = request.headers.get('x-telegram-bot-api-secret-token');
      if (got !== env.WEBHOOK_SECRET) return new Response('Forbidden', { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // Rispondiamo subito 200 e processiamo in background: Telegram non ritenta.
    ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error('handleUpdate:', e)));
    return new Response('OK');
  },
};
