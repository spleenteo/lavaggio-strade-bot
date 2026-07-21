// Test di fumo per la versione Cloudflare. Nessuna rete: dati sintetici,
// fetch verso Telegram intercettato. Esegui: node test/smoke.test.mjs
import assert from 'node:assert';
import { parseProps } from '../src/schedule-core.js';
import { nearest, bboxOfLines } from '../src/geo.js';
import { buildReply } from '../src/reply.js';
import worker from '../src/worker.js';

// --- 1. Parsing del calendario ---
const p1 = parseProps({ name: 'Via Roma', description: 'Spazzamento: 1° e 3° martedì del mese, dalle 00:00 alle 06:00' });
assert.deepEqual(p1.weekdays, [2], 'martedì = 2');
assert.deepEqual(p1.ordinals.weeks, [1, 3]);
assert.deepEqual(p1.times, ['00:00–06:00']);
console.log('✓ parseProps: martedì 1ª e 3ª, 00:00–06:00');

// --- 2. Costruzione feature compatte (come fa build-data) ---
function makeFeature(name, desc, lines) {
  const parsed = parseProps({ name, description: desc });
  return { name, lines, bbox: bboxOfLines(lines), ...parsed };
}
const features = [
  makeFeature('Via Roma', '1° e 3° martedì, 00:00-06:00', [[[11.2550, 43.7700], [11.2560, 43.7705]]]),
  makeFeature('Via Verdi', 'Ogni giovedì 0:00-6:00', [[[11.3000, 43.8000], [11.3010, 43.8005]]]),
];

// --- 3. Match geografico ---
const m = nearest(features, 11.2551, 43.7701);
assert.ok(m && m.feature.name === 'Via Roma', 'match Via Roma');
assert.ok(m.distanceMeters < 60, `distanza ${m.distanceMeters.toFixed(1)} m`);
console.log(`✓ nearest: Via Roma a ${m.distanceMeters.toFixed(1)} m`);

const far = nearest(features, 11.0000, 43.5000);
assert.ok(far.distanceMeters > 1000, 'punto lontano ha distanza grande');
console.log(`✓ nearest lontano: ${Math.round(far.distanceMeters)} m (oltre soglia)`);

// --- 4. Reply (HTML) per date diverse ---
const tue3 = new Date(2026, 6, 21); // martedì 3ª settimana
const rep = buildReply(m, 60, tue3);
assert.ok(rep.includes('SÌ'), 'martedì 21 → SÌ');
assert.ok(rep.includes('Via Roma'));
console.log('✓ reply martedì 21/07 contiene "SÌ"');

const wed = new Date(2026, 6, 22);
assert.ok(buildReply(m, 60, wed).includes('No'), 'mercoledì → No');
console.log('✓ reply mercoledì 22/07 contiene "No"');

// --- 5. Worker end-to-end (update simulato, fetch a Telegram intercettato) ---
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('api.telegram.org')) {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  return realFetch(url, init);
};

const env = {
  BOT_TOKEN: 'TESTTOKEN',
  WEBHOOK_SECRET: 's3cr3t',
  MATCH_THRESHOLD_M: '60',
  STREETS_KV: {
    get: async (_key, _type) => ({ generatedAt: '2026-07-20', features }),
  },
};

const waited = [];
const ctx = { waitUntil: (p) => waited.push(p) };

function makeReq(update) {
  return new Request('https://worker.example/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 's3cr3t' },
    body: JSON.stringify(update),
  });
}

// 5a. secret sbagliato → 403
const bad = new Request('https://worker.example/', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'wrong' }, body: '{}' });
assert.equal((await worker.fetch(bad, env, ctx)).status, 403);
console.log('✓ worker rifiuta secret errato (403)');

// 5b. posizione → invia un messaggio con la via
const resLoc = await worker.fetch(makeReq({ message: { chat: { id: 42 }, location: { latitude: 43.7701, longitude: 11.2551 } } }), env, ctx);
assert.equal(resLoc.status, 200);
await Promise.all(waited);
const last = sent[sent.length - 1];
assert.equal(last.body.chat_id, 42);
assert.ok(last.body.text.includes('Via Roma'), 'la risposta cita Via Roma');
assert.equal(last.body.parse_mode, 'HTML');
console.log('✓ worker: posizione → sendMessage con "Via Roma"');

// 5c. /start → guida
sent.length = 0;
await worker.fetch(makeReq({ message: { chat: { id: 7 }, text: '/start' } }), env, ctx);
await Promise.all(waited);
assert.ok(sent.some((s) => s.body.text.includes('Bot Lavaggio Strade')), '/start manda la guida');
console.log('✓ worker: /start → guida');

globalThis.fetch = realFetch;
console.log('\n✅ Tutti i test superati.');
