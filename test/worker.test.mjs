import test from 'node:test';
import assert from 'node:assert';
import worker from '../src/worker.js';

const ALL = [1, 2, 3, 4, 5];
function feat(via, viaId, tratto, schedule, lines) {
  return { via, viaId, searchName: via.toLowerCase(), tratto, schedule, lines, bbox: [lines[0][0][0], lines[0][0][1], lines[0][0][0] + 0.001, lines[0][0][1] + 0.001], raw: 'indirizzo: ' + via };
}
const FEATURES = [
  feat('VIA ROMA', 100, 'DA A A B', { weekday: 2, weeks: ALL, parity: null, start: '00:00', end: '06:00' }, [[[11.255, 43.77], [11.256, 43.7705]]]),
  feat('VIA PISANA', 200, 'DA C A D', { weekday: 3, weeks: ALL, parity: null, start: '00:00', end: '06:00' }, [[[11.3, 43.8], [11.301, 43.8005]]]),
  feat('VIA PISANA', 200, 'DA D A E', { weekday: 5, weeks: [1], parity: null, start: '13:00', end: '18:00' }, [[[11.302, 43.801], [11.303, 43.8015]]]),
];

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
  STREETS_KV: { get: async () => ({ generatedAt: '2026-07-21', features: FEATURES }) },
};
const waited = [];
const ctx = { waitUntil: (p) => waited.push(p) };

function req(update) {
  return new Request('https://w.example/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 's3cr3t' },
    body: JSON.stringify(update),
  });
}
async function drain() { await Promise.all(waited.splice(0)); }

test('secret errato → 403', async () => {
  const bad = new Request('https://w.example/', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'wrong' }, body: '{}' });
  assert.equal((await worker.fetch(bad, env, ctx)).status, 403);
});

test('blob v1 in KV (feature senza schedule) → messaggio "formato vecchio"', async () => {
  sent.length = 0;
  const oldEnv = {
    ...env,
    STREETS_KV: { get: async () => ({ generatedAt: '2025-01-01', features: [{ via: 'VIA ROMA', viaId: 100 }] }) },
  };
  await worker.fetch(req({ message: { chat: { id: 9 }, text: '/info' } }), oldEnv, ctx);
  await drain();
  assert.ok(sent.at(-1).body.text.includes('formato vecchio'));
});

test('posizione → dettaglio tratto', async () => {
  sent.length = 0;
  await worker.fetch(req({ message: { chat: { id: 1 }, location: { latitude: 43.7701, longitude: 11.2551 } } }), env, ctx);
  await drain();
  const b = sent.at(-1).body;
  assert.ok(b.text.includes('VIA ROMA'));
  assert.ok(b.text.includes('da a a b'));
  assert.equal(b.parse_mode, 'HTML');
});

test('posizione su via multi-calendario → hint altri tratti', async () => {
  sent.length = 0;
  await worker.fetch(req({ message: { chat: { id: 1 }, location: { latitude: 43.8001, longitude: 11.3001 } } }), env, ctx);
  await drain();
  assert.ok(sent.at(-1).body.text.includes('Altri tratti'));
});

test('testo con match unico → vista via', async () => {
  sent.length = 0;
  await worker.fetch(req({ message: { chat: { id: 2 }, text: 'via roma' } }), env, ctx);
  await drain();
  assert.ok(sent.at(-1).body.text.includes('VIA ROMA'));
});

test('testo ambiguo → bottoni inline', async () => {
  sent.length = 0;
  await worker.fetch(req({ message: { chat: { id: 3 }, text: 'via' } }), env, ctx);
  await drain();
  const kb = sent.at(-1).body.reply_markup.inline_keyboard;
  assert.equal(kb.length, 2); // VIA ROMA, VIA PISANA
  assert.ok(kb.every((row) => row[0].callback_data));
});

test('testo senza match → suggerimenti', async () => {
  sent.length = 0;
  await worker.fetch(req({ message: { chat: { id: 3 }, text: 'lungarno vespucci' } }), env, ctx);
  await drain();
  const b = sent.at(-1).body;
  assert.ok(b.text.includes('Forse intendevi'));
  assert.ok(b.reply_markup.inline_keyboard.length >= 1);
});

test('callback_query → answerCallbackQuery + vista via', async () => {
  sent.length = 0;
  await worker.fetch(req({ callback_query: { id: 'cb1', data: '200', message: { chat: { id: 4 } } } }), env, ctx);
  await drain();
  assert.ok(sent.some((s) => s.url.includes('answerCallbackQuery')));
  assert.ok(sent.at(-1).body.text.includes('VIA PISANA'));
  assert.ok(sent.at(-1).body.text.includes('2 calendari'));
});

test('/start → guida; /info → statistiche', async () => {
  sent.length = 0;
  await worker.fetch(req({ message: { chat: { id: 5 }, text: '/start' } }), env, ctx);
  await drain();
  assert.ok(sent.at(-1).body.text.includes('nome della via'));
  await worker.fetch(req({ message: { chat: { id: 5 }, text: '/info' } }), env, ctx);
  await drain();
  assert.ok(sent.at(-1).body.text.includes('Vie:'));
});

test.after(() => { globalThis.fetch = realFetch; });
