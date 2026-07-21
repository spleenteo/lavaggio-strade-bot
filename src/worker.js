// Worker Cloudflare: bot Telegram via webhook.
// Flussi: posizione → dettaglio tratto; testo → ricerca via (con bottoni di
// disambiguazione via callback_query); /start, /info.
// Dati v2 in KV (chiave "pulizia_strade"), cache per-isolate con indice vie.

import { nearest } from './geo.js';
import { buildIndex, searchStreets, closestStreets } from './search.js';
import { buildTrattoReply, buildStreetReply } from './reply.js';

const DATA_KEY = 'pulizia_strade';

let CACHE = null; // { data, streets } per l'isolate

async function loadData(env) {
  if (CACHE) return CACHE;
  const data = await env.STREETS_KV.get(DATA_KEY, 'json');
  if (!data || !Array.isArray(data.features)) {
    throw new Error('Dati non presenti in KV. Esegui build+push dei dati (vedi README).');
  }
  if (data.features.length > 0 && !data.features[0].schedule) {
    throw new Error('Dati KV in formato vecchio: esegui npm run build:data && npm run push:data');
  }
  CACHE = { data, streets: buildIndex(data.features) };
  return CACHE;
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
  '👋 <b>Bot Lavaggio Strade</b> (Firenze città)\n\n' +
  'Dimmi dove hai parcheggiato e ti dico quando è previsto il lavaggio strade:\n' +
  '• condividi la <b>posizione</b> (📎 → Posizione), oppure\n' +
  '• scrivimi il <b>nome della via</b> (es. <i>via masaccio</i>).\n\n' +
  'Comandi: /start (guida), /info (stato dati).';

const sameSchedule = (a, b) => JSON.stringify(a.schedule) === JSON.stringify(b.schedule);

function streetFeatures(cache, street) {
  return street.tratti.map((i) => cache.data.features[i]);
}

async function sendStreetReply(env, chatId, cache, street) {
  const text = buildStreetReply(street, streetFeatures(cache, street), new Date());
  await tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}

async function handleUpdate(update, env) {
  // Tap su un bottone di disambiguazione.
  if (update.callback_query) {
    const cb = update.callback_query;
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
    const chatId = cb.message?.chat.id;
    if (chatId == null) return;
    try {
      const cache = await loadData(env);
      const street = cache.streets.find((s) => String(s.viaId) === cb.data);
      if (street) await sendStreetReply(env, chatId, cache, street);
      else await tg(env, 'sendMessage', { chat_id: chatId, text: 'Via non più presente nei dati: riprova la ricerca.' });
    } catch (e) {
      await tg(env, 'sendMessage', { chat_id: chatId, text: `😓 Errore: ${e.message}` });
    }
    return;
  }

  const msg = update.message || update.edited_message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const thresholdM = Number(env.MATCH_THRESHOLD_M || 60);

  // Posizione condivisa → tratto più vicino.
  if (msg.location) {
    const { latitude, longitude } = msg.location;
    try {
      const cache = await loadData(env);
      const match = nearest(cache.data.features, longitude, latitude);
      let hasOther = false;
      if (match && match.distanceMeters <= thresholdM) {
        const street = cache.streets.find((s) => s.viaId === match.feature.viaId);
        hasOther = !!street && streetFeatures(cache, street).some((f) => !sameSchedule(f, match.feature));
      }
      const text = buildTrattoReply(match, thresholdM, new Date(), hasOther);
      await tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
    } catch (e) {
      await tg(env, 'sendMessage', { chat_id: chatId, text: `😓 Errore: ${e.message}` });
    }
    return;
  }

  const text = (msg.text || '').trim();
  if (!text) return;

  if (text.startsWith('/start') || text.startsWith('/help')) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: HELP, parse_mode: 'HTML' });
    return;
  }
  if (text.startsWith('/info')) {
    try {
      const cache = await loadData(env);
      const d = cache.data;
      const cov = d.parseTotal ? ` (parsing ${((d.parseOk / d.parseTotal) * 100).toFixed(1)}% dei record)` : '';
      const info =
        `📊 Vie: <b>${cache.streets.length}</b> — tratti: <b>${d.features.length}</b>${cov}\n` +
        `Dati generati: ${d.generatedAt || 'n/d'}\n` +
        `Soglia di ricerca posizione: ${thresholdM} m`;
      await tg(env, 'sendMessage', { chat_id: chatId, text: info, parse_mode: 'HTML' });
    } catch (e) {
      await tg(env, 'sendMessage', { chat_id: chatId, text: `Errore: ${e.message}` });
    }
    return;
  }
  if (text.startsWith('/')) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: HELP, parse_mode: 'HTML' });
    return;
  }

  // Testo libero → ricerca per nome via.
  try {
    const cache = await loadData(env);
    const matches = searchStreets(cache.streets, text);
    if (matches.length === 1) {
      await sendStreetReply(env, chatId, cache, matches[0]);
    } else if (matches.length > 1) {
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: matches.length >= 6 ? 'Ho trovato molte vie: le più simili qui sotto. Se manca la tua, affina la ricerca.' : 'Quale via intendi?',
        reply_markup: { inline_keyboard: matches.map((s) => [{ text: s.via, callback_data: String(s.viaId) }]) },
      });
    } else {
      const near = closestStreets(cache.streets, text);
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: '🤔 Nessuna via trovata con quel nome. Forse intendevi:', // niente echo dell'input
        reply_markup: { inline_keyboard: near.map((s) => [{ text: s.via, callback_data: String(s.viaId) }]) },
      });
    }
  } catch (e) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: `😓 Errore: ${e.message}` });
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') {
      return new Response('Bot Lavaggio Strade attivo. Il webhook risponde su POST.', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
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
    ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error('handleUpdate:', e)));
    return new Response('OK');
  },
};
