# Bot Lavaggio Strade v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ricerca per nome via + semantica "prossima finestra di lavaggio" (fuso Europe/Rome) + parsing dai campi strutturati del dataset (oggi il parser riconosce 0 vie su 1802).

**Architecture:** Invariata: build Node → JSON su KV (chiave `pulizia_strade`) → Worker Cloudflare puro. Si riscrivono i contenuti: estrazione campi strutturati in build (`src/parse-dataset.js`), motore `nextWindow` con fuso Europe/Rome (`src/schedule-core.js`), ricerca fuzzy (`src/search.js`), nuovi formati risposta (`src/reply.js`), flussi testo/bottoni nel Worker.

**Tech Stack:** Cloudflare Workers, Wrangler, Node ≥18 (runner `node --test`), zero dipendenze runtime.

**Spec:** `docs/superpowers/specs/2026-07-21-bot-lavaggio-strade-v2-design.md`

## Global Constraints

- I moduli `src/` importati dal Worker: **zero dipendenze npm**. Le librerie (adm-zip, @xmldom/xmldom, @tmcw/togeojson) restano confinate a `scripts/build-data.mjs`. Nessuna nuova dipendenza.
- Ogni calcolo di data/ora in **Europe/Rome** tramite gli helper di `schedule-core.js` (mai `new Date().getDay()` diretto: i Worker girano in UTC).
- Nomi italiani di giorni/mesi **hardcoded** (mai `toLocaleDateString('it-IT')`: ICU non garantito sui Workers).
- Testi utente in italiano; `parse_mode: 'HTML'` solo dove il testo è costruito con `esc()`; mai echo di input utente dentro messaggi HTML.
- Telegram: messaggi ≤ 4096 caratteri; `callback_data` ≤ 64 byte (si usa `codice_via` numerico).
- KV: blob unico, chiave `pulizia_strade`.
- Strategia di migrazione **additiva**: le vecchie funzioni (`parseProps`, `decide`, `buildReply`, `test/smoke.test.mjs`) restano finché l'ultimo consumatore non passa al nuovo codice (Task 7). `npm test` deve essere verde alla fine di ogni task.
- Commit su `main` a fine di ogni task (repo `spleenteo/lavaggio-strade-bot`, privato).
- Il formato dei campi del dataset è documentato nella spec (sezione "Fatti sul dataset"). Fixture di riferimento in Task 1.

---

### Task 1: Estrazione campi strutturati (`src/parse-dataset.js`)

**Files:**
- Create: `src/parse-dataset.js`
- Create: `test/parse.test.mjs`
- Modify: `package.json` (script `test` → `node --test test/`)

**Interfaces:**
- Consumes: niente (modulo puro).
- Produces:
  - `extractFields(props: object) → {[key: string]: string}` — campi `nome: valore` dal testo delle properties KML (tag HTML rimossi).
  - `parseSchedule(fields) → {weekday: number, weeks: number[], parity: 'even'|'odd'|null, start: string, end: string} | null` (0=dom…6=sab; weeks ⊆ 1–5; null se giorno/orari mancanti o `end ≤ start`).
  - `officialRaw(fields) → string` — solo i campi ufficiali, uno per riga, senza stili KML.

- [ ] **Step 1: Scrivi il test che fallisce**

```js
// test/parse.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import { extractFields, parseSchedule, officialRaw } from '../src/parse-dataset.js';

// Fixture modellata sul dataset reale (record BORGO ALLEGRI, vedi spec).
const PROPS = {
  name: 'pulizia_strade_iternet.670368',
  description:
    'pulizia_strade_iternet <br>\n' +
    ' comune : FIRENZE \n indirizzo : BORGO ALLEGRI \n' +
    ' data_caricamento : 2026-02-23 03:03:01.193133+01 \n' +
    ' codice_via : 400 \n prima_settimana : 1 \n seconda_settimana : 1 \n' +
    ' terza_settimana : 1 \n quarta_settimana : 1 \n quinta_settimana : 1 \n' +
    ' giorno_settimana : GI \n ora_inizio : 00:00 \n ora_fine : 06:00 \n' +
    ' tratto_strada : DA AGNOLO A PIETRAPIANA \n notturno : 1 \n settimanale : 0 \n' +
    ' pari : 1 \n dispari : 0 \n tipo_record : I \n cod_top : RT04801701829TO \n cod_via : 400 \n' +
    '\nstroke-opacity: 1\nstroke: #bb3754\nicon: http://icons.opengeo.org/x.png',
};

test('extractFields legge i campi chiave', () => {
  const f = extractFields(PROPS);
  assert.equal(f.indirizzo, 'BORGO ALLEGRI');
  assert.equal(f.codice_via, '400');
  assert.equal(f.giorno_settimana, 'GI');
  assert.equal(f.tratto_strada, 'DA AGNOLO A PIETRAPIANA');
  assert.equal(f.ora_inizio, '00:00');
  assert.equal(f.data_caricamento, '2026-02-23 03:03:01.193133+01'); // valore con ":" interni
});

test('parseSchedule costruisce lo schedule', () => {
  const s = parseSchedule(extractFields(PROPS));
  assert.deepEqual(s, { weekday: 4, weeks: [1, 2, 3, 4, 5], parity: 'even', start: '00:00', end: '06:00' });
});

test('parseSchedule → null senza giorno riconosciuto', () => {
  assert.equal(parseSchedule({ ora_inizio: '00:00', ora_fine: '06:00' }), null);
  assert.equal(parseSchedule({ giorno_settimana: 'XX', ora_inizio: '00:00', ora_fine: '06:00' }), null);
});

test('parseSchedule → null con finestra invertita o settimane vuote', () => {
  const base = { giorno_settimana: 'LU', prima_settimana: '1', ora_inizio: '13:00', ora_fine: '06:00' };
  assert.equal(parseSchedule(base), null); // end ≤ start
  assert.equal(parseSchedule({ giorno_settimana: 'LU', ora_inizio: '00:00', ora_fine: '06:00' }), null); // nessuna settimana
});

test('officialRaw esclude gli stili KML', () => {
  const raw = officialRaw(extractFields(PROPS));
  assert.ok(raw.includes('indirizzo: BORGO ALLEGRI'));
  assert.ok(raw.includes('giorno_settimana: GI'));
  assert.ok(!raw.includes('stroke'));
  assert.ok(!raw.includes('icon'));
});
```

- [ ] **Step 2: Aggiorna lo script test in `package.json`**

```json
"test": "node --test test/"
```

- [ ] **Step 3: Esegui i test e verifica che falliscano**

Run: `npm test`
Expected: `test/parse.test.mjs` FAIL (`Cannot find module '../src/parse-dataset.js'`); `test/smoke.test.mjs` PASS (resta finché il vecchio codice è in uso).

- [ ] **Step 4: Implementa `src/parse-dataset.js`**

```js
// Estrazione dei campi strutturati dalle properties KML del dataset
// "pulizia strade" (Comune di Firenze / Alia). Modulo PURO: usato dallo
// script di build e dai test, mai dal Worker.

const GIORNI = { DO: 0, LU: 1, MA: 2, ME: 3, GI: 4, VE: 5, SA: 6 };

const WEEK_KEYS = ['prima_settimana', 'seconda_settimana', 'terza_settimana', 'quarta_settimana', 'quinta_settimana'];

// Campi ufficiali mostrati all'utente (in quest'ordine).
const RAW_KEYS = [
  'comune', 'indirizzo', 'tratto_strada', 'giorno_settimana',
  ...WEEK_KEYS, 'pari', 'dispari', 'ora_inizio', 'ora_fine',
];

/**
 * Concatena le properties stringa, rimuove i tag HTML e legge le righe
 * "chiave : valore". A parità di chiave vince la prima occorrenza.
 */
export function extractFields(props = {}) {
  const text = Object.values(props)
    .filter((v) => typeof v === 'string')
    .join('\n')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
  const fields = {};
  for (const m of text.matchAll(/^\s*([a-z_]+)\s*:\s*(.*?)\s*$/gm)) {
    if (!(m[1] in fields)) fields[m[1]] = m[2];
  }
  return fields;
}

const HM_RE = /^\d{1,2}:\d{2}$/;
const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

/** Costruisce lo schedule di un tratto; null se i campi non bastano. */
export function parseSchedule(fields) {
  const weekday = GIORNI[String(fields.giorno_settimana || '').trim().toUpperCase()];
  if (weekday === undefined) return null;
  const { ora_inizio: start, ora_fine: end } = fields;
  if (!HM_RE.test(start || '') || !HM_RE.test(end || '') || toMin(end) <= toMin(start)) return null;
  const weeks = WEEK_KEYS.map((k, i) => (fields[k] === '1' ? i + 1 : null)).filter((n) => n !== null);
  if (weeks.length === 0) return null;
  const parity = fields.pari === '1' ? 'even' : fields.dispari === '1' ? 'odd' : null;
  return { weekday, weeks, parity, start, end };
}

/** Testo ufficiale compatto da mostrare all'utente. */
export function officialRaw(fields) {
  return RAW_KEYS.filter((k) => fields[k] != null && fields[k] !== '')
    .map((k) => `${k}: ${fields[k]}`)
    .join('\n');
}
```

- [ ] **Step 5: Esegui i test e verifica che passino**

Run: `npm test`
Expected: tutti PASS (parse + smoke).

- [ ] **Step 6: Commit**

```bash
git add src/parse-dataset.js test/parse.test.mjs package.json
git commit -m "feat: estrazione campi strutturati dal dataset (parse-dataset)"
```

---

### Task 2: Utility di fuso orario Europe/Rome (`src/schedule-core.js`, additivo)

**Files:**
- Modify: `src/schedule-core.js` (AGGIUNGE funzioni; `parseProps`/`decide`/`collectText`/`weekdayNames` restano fino al Task 7)
- Create: `test/schedule.test.mjs`

**Interfaces:**
- Consumes: niente.
- Produces:
  - `romeParts(date: Date) → {y, m, d, hh, mm, weekday}` (m 1–12; weekday 0=dom…6=sab; ora locale Roma)
  - `romeDate(y, m, d, hh=0, mm=0) → Date` — istante assoluto dell'ora locale Roma indicata
  - `addDays({y,m,d}, n) → {y,m,d}` — aritmetica di calendario pura
  - `isoWeek({y,m,d}) → number` — numero settimana ISO 8601
  - `MONTHS: string[]` (12 nomi italiani; `WEEKDAY_LABEL` esiste già)

- [ ] **Step 1: Scrivi i test che falliscono**

```js
// test/schedule.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import { romeParts, romeDate, addDays, isoWeek } from '../src/schedule-core.js';

test('romeParts: 23:30 UTC d\'estate è già il giorno dopo a Roma', () => {
  const p = romeParts(new Date('2026-07-21T23:30:00Z'));
  assert.deepEqual(p, { y: 2026, m: 7, d: 22, hh: 1, mm: 30, weekday: 3 }); // mercoledì
});

test('romeDate: offset estivo +2 e invernale +1', () => {
  assert.equal(romeDate(2026, 7, 21, 15, 0).toISOString(), '2026-07-21T13:00:00.000Z');
  assert.equal(romeDate(2026, 12, 21, 15, 0).toISOString(), '2026-12-21T14:00:00.000Z');
});

test('romeDate: cambio ora legale 29 marzo 2026', () => {
  assert.equal(romeDate(2026, 3, 29, 0, 0).toISOString(), '2026-03-28T23:00:00.000Z'); // prima del salto, +1
  assert.equal(romeDate(2026, 3, 29, 6, 0).toISOString(), '2026-03-29T04:00:00.000Z'); // dopo il salto, +2
});

test('addDays: aritmetica di calendario', () => {
  assert.deepEqual(addDays({ y: 2026, m: 7, d: 31 }, 1), { y: 2026, m: 8, d: 1 });
  assert.deepEqual(addDays({ y: 2026, m: 12, d: 31 }, 1), { y: 2027, m: 1, d: 1 });
  assert.deepEqual(addDays({ y: 2026, m: 3, d: 28 }, 1), { y: 2026, m: 3, d: 29 }); // DST: nessun salto di giorno
});

test('isoWeek: valori noti', () => {
  assert.equal(isoWeek({ y: 2026, m: 1, d: 1 }), 1);   // 1 gen 2026 è giovedì → settimana 1
  assert.equal(isoWeek({ y: 2026, m: 1, d: 5 }), 2);   // lunedì successivo
  assert.equal(isoWeek({ y: 2025, m: 12, d: 29 }), 1); // lunedì della settimana 1 del 2026
});
```

- [ ] **Step 2: Esegui e verifica il fallimento**

Run: `npm test`
Expected: `test/schedule.test.mjs` FAIL (funzioni non esportate).

- [ ] **Step 3: Aggiungi le funzioni a `src/schedule-core.js`** (in coda al file, senza toccare l'esistente)

```js
// ── v2: utilità di fuso orario Europe/Rome (i Worker girano in UTC) ────────

export const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

const ROME_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Rome',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});
const WD_CODE = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Componenti di data/ora locali a Roma per un istante assoluto. */
export function romeParts(date) {
  const p = {};
  for (const part of ROME_FMT.formatToParts(date)) p[part.type] = part.value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, weekday: WD_CODE[p.weekday] };
}

/** Istante assoluto (Date) dell'ora locale Roma indicata. */
export function romeDate(y, m, d, hh = 0, mm = 0) {
  // Interpreta l'ora locale come UTC, poi corregge con l'offset reale.
  // Due iterazioni convergono anche a cavallo dei cambi d'ora.
  let ts = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const p = romeParts(new Date(ts));
    ts -= Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - Date.UTC(y, m - 1, d, hh, mm);
  }
  return new Date(ts);
}

/** Somma n giorni a una data di calendario pura (senza DST: si lavora in UTC). */
export function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n, 12));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Numero di settimana ISO 8601 di una data di calendario. */
export function isoWeek({ y, m, d }) {
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3); // giovedì della settimana
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
  return 1 + Math.round((t - firstThu) / (7 * 86400000));
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npm test`
Expected: tutti PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schedule-core.js test/schedule.test.mjs
git commit -m "feat: utilità di fuso Europe/Rome in schedule-core"
```

---

### Task 3: Motore `nextWindow` (`src/schedule-core.js`, additivo)

**Files:**
- Modify: `src/schedule-core.js`
- Modify: `test/schedule.test.mjs`

**Interfaces:**
- Consumes: `romeParts`, `romeDate`, `addDays`, `isoWeek` (Task 2); schedule dal Task 1.
- Produces: `nextWindow(schedule, now: Date, horizonDays=90) → {start: Date, end: Date, ongoing: boolean} | null`.

- [ ] **Step 1: Aggiungi i test (in coda a `test/schedule.test.mjs`)**

```js
import { nextWindow } from '../src/schedule-core.js';

const ALL = [1, 2, 3, 4, 5];

test('nextWindow: scenario utente — martedì pomeriggio, calendario mar 1ª/3ª notturno', () => {
  // 21/7/2026 è il 3° martedì; la finestra 00–06 di stamattina è passata → 1° martedì di agosto.
  const s = { weekday: 2, weeks: [1, 3], parity: null, start: '00:00', end: '06:00' };
  const w = nextWindow(s, romeDate(2026, 7, 21, 15, 0));
  assert.equal(w.start.toISOString(), romeDate(2026, 8, 4, 0, 0).toISOString());
  assert.equal(w.ongoing, false);
});

test('nextWindow: notturna imminente ("stanotte")', () => {
  const s = { weekday: 3, weeks: ALL, parity: null, start: '00:00', end: '06:00' };
  const w = nextWindow(s, romeDate(2026, 7, 21, 15, 0)); // mar pomeriggio → mer 00:00
  assert.equal(w.start.toISOString(), romeDate(2026, 7, 22, 0, 0).toISOString());
});

test('nextWindow: finestra in corso alle 01:30 (23:30 UTC)', () => {
  const s = { weekday: 3, weeks: ALL, parity: null, start: '00:00', end: '06:00' };
  const w = nextWindow(s, new Date('2026-07-21T23:30:00Z')); // = mer 22/7 01:30 a Roma
  assert.equal(w.ongoing, true);
  assert.equal(w.end.toISOString(), romeDate(2026, 7, 22, 6, 0).toISOString());
});

test('nextWindow: fascia diurna', () => {
  const s = { weekday: 2, weeks: ALL, parity: null, start: '13:00', end: '18:00' };
  const inCorso = nextWindow(s, romeDate(2026, 7, 21, 14, 0));
  assert.equal(inCorso.ongoing, true);
  const dopo = nextWindow(s, romeDate(2026, 7, 21, 19, 0)); // stasera è finita → martedì prossimo
  assert.equal(dopo.start.toISOString(), romeDate(2026, 7, 28, 13, 0).toISOString());
});

test('nextWindow: 5ª settimana del mese', () => {
  const s = { weekday: 5, weeks: [5], parity: null, start: '00:00', end: '06:00' };
  const w = nextWindow(s, romeDate(2026, 7, 21, 12, 0)); // 5° venerdì di luglio 2026 = 31/7
  assert.equal(w.start.toISOString(), romeDate(2026, 7, 31, 0, 0).toISOString());
});

test('nextWindow: parità → occorrenze ogni 14 giorni, even e odd alternate', () => {
  const even = { weekday: 4, weeks: ALL, parity: 'even', start: '00:00', end: '06:00' };
  const odd = { weekday: 4, weeks: ALL, parity: 'odd', start: '00:00', end: '06:00' };
  const now = romeDate(2026, 7, 21, 12, 0);
  const e1 = nextWindow(even, now);
  const e2 = nextWindow(even, e1.end);
  assert.equal(e2.start - e1.start, 14 * 86400000);
  const o1 = nextWindow(odd, now);
  assert.equal(Math.abs(o1.start - e1.start), 7 * 86400000); // giovedì adiacente
});

test('nextWindow: attraversa il cambio d\'ora (29/3/2026, finestra reale di 5 ore)', () => {
  const s = { weekday: 0, weeks: ALL, parity: null, start: '00:00', end: '06:00' };
  const w = nextWindow(s, romeDate(2026, 3, 28, 12, 0));
  assert.equal(w.start.toISOString(), '2026-03-28T23:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-03-29T04:00:00.000Z');
});

test('nextWindow: null oltre l\'orizzonte', () => {
  const s = { weekday: 1, weeks: ALL, parity: null, start: '00:00', end: '06:00' };
  assert.equal(nextWindow(s, romeDate(2026, 7, 21, 12, 0), 0), null);
});
```

- [ ] **Step 2: Esegui e verifica il fallimento**

Run: `npm test`
Expected: FAIL (`nextWindow` non esportata).

- [ ] **Step 3: Implementa `nextWindow` (in coda a `src/schedule-core.js`)**

```js
const parseHM = (s) => s.split(':').map(Number);

function dayMatches(schedule, day) {
  const wd = new Date(Date.UTC(day.y, day.m - 1, day.d, 12)).getUTCDay();
  if (wd !== schedule.weekday) return false;
  if (!schedule.weeks.includes(Math.ceil(day.d / 7))) return false; // n-esima occorrenza del giorno nel mese
  if (schedule.parity) {
    const even = isoWeek(day) % 2 === 0;
    if ((schedule.parity === 'even') !== even) return false;
  }
  return true;
}

/**
 * Prossima finestra di lavaggio del tratto, in ora locale Europe/Rome.
 * @returns {{start: Date, end: Date, ongoing: boolean}|null}
 */
export function nextWindow(schedule, now, horizonDays = 90) {
  const p = romeParts(now);
  let day = { y: p.y, m: p.m, d: p.d };
  for (let i = 0; i < horizonDays; i++) {
    if (dayMatches(schedule, day)) {
      const [sh, sm] = parseHM(schedule.start);
      const [eh, em] = parseHM(schedule.end);
      const start = romeDate(day.y, day.m, day.d, sh, sm);
      const end = romeDate(day.y, day.m, day.d, eh, em);
      if (end > now) return { start, end, ongoing: start <= now };
    }
    day = addDays(day, 1);
  }
  return null;
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npm test`
Expected: tutti PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schedule-core.js test/schedule.test.mjs
git commit -m "feat: motore nextWindow con settimane del mese e parità ISO"
```

---

### Task 4: Ricerca vie (`src/search.js`)

**Files:**
- Create: `src/search.js`
- Create: `test/search.test.mjs`

**Interfaces:**
- Consumes: feature v2 `{via, viaId, searchName, …}` (prodotte dal Task 5; nei test si usano oggetti sintetici).
- Produces:
  - `normalizeName(s) → string` (minuscole, senza accenti, solo [a-z0-9 ], spazi collassati)
  - `buildIndex(features) → Street[]` con `Street = {viaId, via, searchName, tratti: number[]}` (indici in `features`)
  - `searchStreets(streets, query, limit=6) → Street[]` (esatto > prefisso > sottostringa > fuzzy ≤2)
  - `closestStreets(streets, query, limit=3) → Street[]` (distanza minima, senza soglia)

- [ ] **Step 1: Scrivi i test che falliscono**

```js
// test/search.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import { normalizeName, buildIndex, searchStreets, closestStreets } from '../src/search.js';

test('normalizeName', () => {
  assert.equal(normalizeName("Vìa  Sant'Ambrogio"), 'via sant ambrogio');
  assert.equal(normalizeName('VIA MASACCIO'), 'via masaccio');
});

const FEATURES = [
  { via: 'VIA MASACCIO', viaId: 9800, searchName: 'via masaccio' },
  { via: 'VIA MASO FINIGUERRA', viaId: 9900, searchName: 'via maso finiguerra' },
  { via: 'BORGO ALLEGRI', viaId: 400, searchName: 'borgo allegri' },
  { via: 'BORGO ALLEGRI', viaId: 400, searchName: 'borgo allegri' }, // secondo tratto
  { via: 'BORGO STELLA', viaId: 17000, searchName: 'borgo stella' },
];

test('buildIndex raggruppa i tratti per via', () => {
  const streets = buildIndex(FEATURES);
  assert.equal(streets.length, 4);
  assert.deepEqual(streets.find((s) => s.viaId === 400).tratti, [2, 3]);
});

const STREETS = buildIndex(FEATURES);

test('searchStreets: match esatto batte tutto', () => {
  const r = searchStreets(STREETS, 'Via Masaccio');
  assert.equal(r[0].viaId, 9800);
});

test('searchStreets: sottostringa', () => {
  const r = searchStreets(STREETS, 'masaccio');
  assert.equal(r.length, 1);
  assert.equal(r[0].viaId, 9800);
});

test('searchStreets: prefisso multiplo (caso bottoni)', () => {
  const r = searchStreets(STREETS, 'borgo');
  assert.equal(r.length, 2);
});

test('searchStreets: fuzzy con typo', () => {
  const r = searchStreets(STREETS, 'via msaaccio');
  assert.equal(r[0].viaId, 9800);
});

test('searchStreets: nessun risultato oltre soglia fuzzy', () => {
  assert.deepEqual(searchStreets(STREETS, 'lungarno vespucci'), []);
});

test('closestStreets: suggerimenti senza soglia', () => {
  const r = closestStreets(STREETS, 'borgo alegri');
  assert.equal(r[0].viaId, 400);
  assert.equal(r.length, 3);
});
```

- [ ] **Step 2: Esegui e verifica il fallimento**

Run: `npm test`
Expected: `test/search.test.mjs` FAIL (modulo mancante).

- [ ] **Step 3: Implementa `src/search.js`**

```js
// Ricerca vie per nome. Modulo PURO, zero dipendenze: gira nel Worker.
// La scala è piccola (~1500 vie): scansione lineare con scoring.

/** Normalizza per il confronto: minuscole, niente accenti, solo [a-z0-9 ]. */
export function normalizeName(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Raggruppa le feature (tratti) per via. `tratti` sono indici in `features`. */
export function buildIndex(features) {
  const byId = new Map();
  features.forEach((f, i) => {
    let s = byId.get(f.viaId);
    if (!s) byId.set(f.viaId, (s = { viaId: f.viaId, via: f.via, searchName: f.searchName, tratti: [] }));
    s.tratti.push(i);
  });
  return [...byId.values()];
}

/** Distanza di Levenshtein, con uscita rapida su lunghezze troppo diverse. */
function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 4) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Somma, per ogni token della query, della distanza dal token più simile del nome. */
function tokenDistance(name, query) {
  const nTokens = name.split(' ');
  let total = 0;
  for (const qt of query.split(' ')) {
    let best = 99;
    for (const nt of nTokens) best = Math.min(best, levenshtein(qt, nt));
    total += best;
  }
  return total;
}

/** Vie ordinate per pertinenza: esatto > prefisso > sottostringa > fuzzy (≤2). */
export function searchStreets(streets, query, limit = 6) {
  const q = normalizeName(query);
  if (!q) return [];
  const scored = [];
  for (const s of streets) {
    let score = null;
    if (s.searchName === q) score = 0;
    else if (s.searchName.startsWith(q)) score = 1;
    else if (s.searchName.includes(q)) score = 2;
    else {
      const d = tokenDistance(s.searchName, q);
      if (d <= 2) score = 3 + d;
    }
    if (score !== null) scored.push({ s, score });
  }
  scored.sort((a, b) => a.score - b.score || a.s.searchName.localeCompare(b.s.searchName));
  return scored.slice(0, limit).map((x) => x.s);
}

/** I nomi più vicini in assoluto (per "Forse intendevi…"). */
export function closestStreets(streets, query, limit = 3) {
  const q = normalizeName(query);
  return streets
    .map((s) => ({ s, d: tokenDistance(s.searchName, q) }))
    .sort((a, b) => a.d - b.d || a.s.searchName.localeCompare(b.s.searchName))
    .slice(0, limit)
    .map((x) => x.s);
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npm test`
Expected: tutti PASS.

- [ ] **Step 5: Commit**

```bash
git add src/search.js test/search.test.mjs
git commit -m "feat: ricerca vie per nome con fuzzy matching"
```

---

### Task 5: Build dei dati v2 (`scripts/build-data.mjs`)

**Files:**
- Modify: `scripts/build-data.mjs` (sostituisce il ciclo di parsing; `geometryToLines`, download e gestione KMZ restano identici)

**Interfaces:**
- Consumes: `extractFields`, `parseSchedule`, `officialRaw` (Task 1); `normalizeName` (Task 4); `bboxOfLines` (esistente).
- Produces: blob KV `{generatedAt, source, license, count, features: FeatureV2[]}` con `FeatureV2 = {via, viaId, searchName, tratto, schedule, lines, bbox, raw}` (schedule come da Task 1).

- [ ] **Step 1: Sostituisci import e ciclo di parsing in `scripts/build-data.mjs`**

Rimuovi `import { parseProps } from '../src/schedule-core.js';` e aggiungi:

```js
import { extractFields, parseSchedule, officialRaw } from '../src/parse-dataset.js';
import { normalizeName } from '../src/search.js';
```

Sostituisci il blocco `const features = []; for (const f of geojson.features) { … }` con:

```js
  // Un record per (via, tratto, calendario): le feature duplicate si fondono.
  const byKey = new Map();
  let total = 0;
  let ok = 0;
  for (const f of geojson.features) {
    const lines = geometryToLines(f.geometry);
    if (!lines.length) continue;
    total++;
    const fields = extractFields(f.properties || {});
    const schedule = parseSchedule(fields);
    if (!schedule || !fields.indirizzo || !fields.codice_via) continue;
    ok++;
    const via = fields.indirizzo.trim();
    const tratto = (fields.tratto_strada || '').trim();
    const key = `${fields.codice_via}|${tratto}|${JSON.stringify(schedule)}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        via,
        viaId: Number(fields.codice_via),
        searchName: normalizeName(via),
        tratto,
        schedule,
        lines: [],
        bbox: null,
        raw: officialRaw(fields),
      });
    }
    byKey.get(key).lines.push(...lines);
  }
  const features = [...byKey.values()];
  for (const f of features) f.bbox = bboxOfLines(f.lines);

  // Validazione: se il formato upstream cambia, la build DEVE fallire.
  const vieUniche = new Set(features.map((f) => f.viaId)).size;
  const coverage = total ? ok / total : 0;
  console.log(`Parsing: ${ok}/${total} record (${(coverage * 100).toFixed(1)}%) → ${features.length} tratti, ${vieUniche} vie.`);
  if (vieUniche < 500) throw new Error(`Solo ${vieUniche} vie (< 500): formato upstream cambiato?`);
  if (coverage < 0.9) throw new Error(`Copertura parsing ${(coverage * 100).toFixed(1)}% (< 90%): formato upstream cambiato?`);
```

Nell'oggetto `out` aggiungi la copertura parsing (la mostra `/info`):

```js
  const out = {
    generatedAt: new Date().toISOString(),
    source: DATA_URL,
    license: 'CC-BY-NC-SA 4.0 - Comune di Firenze (fonte Alia)',
    count: features.length,
    parseOk: ok,
    parseTotal: total,
    features,
  };
```

Aggiorna le due righe finali di log (il conteggio `withDays` non esiste più):

```js
  console.log(`✓ Scritte ${features.length} voci (${vieUniche} vie) in ${OUT}.`);
  console.log(`  Dimensione: ${(JSON.stringify(out).length / 1024 / 1024).toFixed(2)} MB`);
```

- [ ] **Step 2: Esegui la build reale e verifica i numeri**

Run: `npm run build:data`
Expected: copertura ≥ 90% (attesa ~100%: i campi sono strutturati), ~1500 vie, dimensione < 3,23 MB (il `raw` non contiene più gli stili KML). Se la copertura è bassa, ispeziona un record con `node -e "…console.log(JSON.stringify(require('./data/pulizia_strade.json').features[0]))"` e correggi `extractFields` PRIMA di proseguire.

- [ ] **Step 3: Verifica che i test restino verdi**

Run: `npm test`
Expected: tutti PASS (il vecchio smoke test usa ancora `parseProps`, non toccato).

- [ ] **Step 4: Commit**

```bash
git add scripts/build-data.mjs
git commit -m "feat: build dati v2 dai campi strutturati, con merge e validazione"
```

---

### Task 6: Formati risposta (`src/reply.js`, additivo)

**Files:**
- Modify: `src/reply.js` (AGGIUNGE `windowLabel`, `buildTrattoReply`, `buildStreetReply`; `buildReply` v1 resta fino al Task 7)
- Create: `test/reply.test.mjs`

**Interfaces:**
- Consumes: `nextWindow`, `romeParts`, `romeDate`, `addDays`, `WEEKDAY_LABEL`, `MONTHS` (schedule-core); FeatureV2 (Task 5).
- Produces:
  - `windowLabel(win, now) → string` (es. `⚠️ IN CORSO ORA (notte mar→mer, fino alle 06:00)`, `STANOTTE (notte mar→mer, 00:00–06:00)`, `OGGI 13:00–18:00`, `domani 13:00–18:00`, `martedì 4 agosto (notte lun→mar, 00:00–06:00)`)
  - `buildTrattoReply(match, thresholdM, now, hasOtherSchedules) → string` — HTML, flusso posizione
  - `buildStreetReply(street, features, now) → string` — HTML, flusso ricerca, tratti accorpati per calendario

- [ ] **Step 1: Scrivi i test che falliscono**

```js
// test/reply.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import { romeDate } from '../src/schedule-core.js';
import { windowLabel, buildTrattoReply, buildStreetReply } from '../src/reply.js';

const NOW = romeDate(2026, 7, 21, 15, 0); // martedì pomeriggio
const ALL = [1, 2, 3, 4, 5];
const notturnoMer = { weekday: 3, weeks: ALL, parity: null, start: '00:00', end: '06:00' };

function feat(via, viaId, tratto, schedule) {
  return { via, viaId, searchName: via.toLowerCase(), tratto, schedule, lines: [[[11.25, 43.77]]], bbox: [11.25, 43.77, 11.25, 43.77], raw: 'indirizzo: ' + via };
}

test('windowLabel: stanotte / in corso / oggi / data futura', () => {
  const win = { start: romeDate(2026, 7, 22, 0, 0), end: romeDate(2026, 7, 22, 6, 0), ongoing: false };
  assert.equal(windowLabel(win, NOW), 'STANOTTE (notte mar→mer, 00:00–06:00)');
  assert.equal(windowLabel({ ...win, ongoing: true }, NOW), '⚠️ IN CORSO ORA (notte mar→mer, fino alle 06:00)');
  const oggi = { start: romeDate(2026, 7, 21, 16, 0), end: romeDate(2026, 7, 21, 18, 0), ongoing: false };
  assert.equal(windowLabel(oggi, NOW), 'OGGI 16:00–18:00');
  const futura = { start: romeDate(2026, 8, 4, 0, 0), end: romeDate(2026, 8, 4, 6, 0), ongoing: false };
  assert.equal(windowLabel(futura, NOW), 'martedì 4 agosto (notte lun→mar, 00:00–06:00)');
});

test('buildTrattoReply: dettaglio con tratto, raw e prossime finestre', () => {
  const match = { feature: feat('VIA MASACCIO', 9800, 'DA MIRANDOLA A LA FARINA', notturnoMer), distanceMeters: 12 };
  const txt = buildTrattoReply(match, 60, NOW, false);
  assert.ok(txt.includes('VIA MASACCIO'));
  assert.ok(txt.includes('da mirandola a la farina'));
  assert.ok(txt.includes('STANOTTE'));
  assert.ok(txt.includes('Poi:'));
  assert.ok(txt.includes('indirizzo: VIA MASACCIO')); // raw ufficiale
});

test('buildTrattoReply: hint altri tratti + fuori soglia', () => {
  const match = { feature: feat('VIA PISANA', 5000, 'DA X A Y', notturnoMer), distanceMeters: 12 };
  assert.ok(buildTrattoReply(match, 60, NOW, true).includes('Altri tratti'));
  assert.ok(buildTrattoReply({ ...match, distanceMeters: 300 }, 60, NOW, false).includes('Non ho trovato'));
  assert.ok(buildTrattoReply(null, 60, NOW, false).includes('Non ho trovato'));
});

test('buildStreetReply: accorpa i tratti per calendario e ordina per urgenza', () => {
  const lontano = { weekday: 2, weeks: [1], parity: null, start: '00:00', end: '06:00' }; // 1° martedì → 4/8
  const features = [
    feat('VIA PISANA', 5000, 'DA A A B', lontano),
    feat('VIA PISANA', 5000, 'DA B A C', notturnoMer),
    feat('VIA PISANA', 5000, 'DA C A D', notturnoMer),
  ];
  const street = { viaId: 5000, via: 'VIA PISANA', searchName: 'via pisana', tratti: [0, 1, 2] };
  const txt = buildStreetReply(street, features, NOW);
  assert.ok(txt.includes('3 tratti, 2 calendari'));
  assert.ok(txt.indexOf('STANOTTE') < txt.indexOf('4 agosto')); // urgente prima
  assert.ok(txt.includes('da b a c'));
  assert.ok(!txt.includes('indirizzo:')); // niente raw nella vista via
});
```

- [ ] **Step 2: Esegui e verifica il fallimento**

Run: `npm test`
Expected: `test/reply.test.mjs` FAIL (funzioni non esportate).

- [ ] **Step 3: Aggiungi le funzioni a `src/reply.js`** (in coda; aggiorna solo la riga di import)

```js
import { decide, weekdayNames, WEEKDAY_LABEL, MONTHS, nextWindow, romeParts, addDays } from './schedule-core.js';
```

```js
// ── v2: risposte basate su nextWindow ──────────────────────────────────────

const SHORT_WD = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const DISCLAIMER = '<i>Dati: open data Comune di Firenze (fonte Alia). Fa sempre fede il cartello in strada.</i>';

function hm(date) {
  const p = romeParts(date);
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}

/** Etichetta della finestra relativa a `now` (vedi test per il formato). */
export function windowLabel(win, now) {
  const s = romeParts(win.start);
  const n = romeParts(now);
  const isNight = s.hh < 6;
  const night = isNight ? `notte ${SHORT_WD[(s.weekday + 6) % 7]}→${SHORT_WD[s.weekday]}, ` : '';
  const range = `${hm(win.start)}–${hm(win.end)}`;
  if (win.ongoing) return `⚠️ IN CORSO ORA (${night}fino alle ${hm(win.end)})`;
  const sameDay = s.y === n.y && s.m === n.m && s.d === n.d;
  const tom = addDays(n, 1);
  const isTomorrow = s.y === tom.y && s.m === tom.m && s.d === tom.d;
  if (isNight && (sameDay || isTomorrow)) return `STANOTTE (${night}${range})`;
  if (sameDay) return `OGGI ${range}`;
  if (isTomorrow) return `domani ${range}`;
  return `${WEEKDAY_LABEL[s.weekday]} ${s.d} ${MONTHS[s.m - 1]} (${night}${range})`;
}

function windowLines(schedule, now) {
  const win = nextWindow(schedule, now);
  if (!win) return ['✅ Nessun lavaggio previsto nei prossimi 90 giorni.'];
  const lines = [`🧹 Prossimo lavaggio: <b>${windowLabel(win, now)}</b>`];
  const after = nextWindow(schedule, win.end);
  if (after) lines.push(`📅 Poi: ${windowLabel(after, now)}`);
  return lines;
}

/** Dettaglio di un singolo tratto (flusso posizione). */
export function buildTrattoReply(match, thresholdM, now, hasOtherSchedules = false) {
  if (!match || match.distanceMeters > thresholdM) {
    const dist = match ? ` (la via più vicina è a ${Math.round(match.distanceMeters)} m)` : '';
    return (
      `🤔 Non ho trovato una via abbastanza vicina alla posizione${dist}.\n\n` +
      `Può darsi che tu sia fuori dal Comune di Firenze (i dati coprono solo Firenze città). ` +
      `Puoi anche scrivermi il nome della via (es. <i>via masaccio</i>).`
    );
  }
  const f = match.feature;
  const lines = [`📍 <b>${esc(f.via)}</b>`];
  if (f.tratto) lines.push(`<i>tratto ${esc(f.tratto.toLowerCase())} — a ~${Math.round(match.distanceMeters)} m da te</i>`);
  lines.push('', ...windowLines(f.schedule, now));
  if (hasOtherSchedules) {
    lines.push('', `ℹ️ Altri tratti di questa via hanno orari diversi — scrivi «${esc(f.via.toLowerCase())}» per vederli tutti.`);
  }
  if (f.raw) lines.push('', '📄 Dal calendario ufficiale:', `<code>${esc(f.raw)}</code>`);
  lines.push('', DISCLAIMER);
  return lines.join('\n');
}

/** Vista di una via intera: tratti accorpati per calendario, urgenti prima. */
export function buildStreetReply(street, features, now) {
  const groups = new Map();
  for (const f of features) {
    const key = JSON.stringify(f.schedule);
    if (!groups.has(key)) groups.set(key, { schedule: f.schedule, tratti: [] });
    groups.get(key).tratti.push(f.tratto);
  }
  const items = [...groups.values()].map((g) => ({ ...g, win: nextWindow(g.schedule, now) }));
  items.sort((a, b) => (a.win ? a.win.start.getTime() : Infinity) - (b.win ? b.win.start.getTime() : Infinity));

  const multi = features.length > 1;
  const lines = [`📍 <b>${esc(street.via)}</b>` + (multi ? ` — ${features.length} tratti, ${items.length} calendari` : '')];
  for (const it of items) {
    lines.push('');
    lines.push(it.win ? `🧹 <b>${windowLabel(it.win, now)}</b>` : '✅ Nessun lavaggio previsto nei prossimi 90 giorni.');
    if (multi) for (const t of it.tratti) lines.push(` • ${esc((t || 'tratto non specificato').toLowerCase())}`);
    if (it.win) {
      const after = nextWindow(it.schedule, it.win.end);
      if (after) lines.push(`   <i>poi: ${windowLabel(after, now)}</i>`);
    }
  }
  lines.push('', DISCLAIMER);
  return lines.join('\n');
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npm test`
Expected: tutti PASS (incluso il vecchio smoke).

- [ ] **Step 5: Commit**

```bash
git add src/reply.js test/reply.test.mjs
git commit -m "feat: formati risposta v2 (dettaglio tratto e vista via)"
```

---

### Task 7: Worker v2 + webhook + pulizia del codice v1

**Files:**
- Modify: `src/worker.js` (riscrittura di `loadData`/`handleUpdate`; `fetch` handler invariato)
- Modify: `scripts/set-webhook.mjs` (`allowed_updates`)
- Modify: `src/schedule-core.js` (RIMUOVE `collectText`, `parseProps`, `decide`, `weekdayNames` e i relativi helper privati `extractWeekdays`, `extractOrdinals`, `extractTimeRanges`, `weekOfMonth`, `WEEKDAYS`)
- Modify: `src/reply.js` (RIMUOVE `buildReply` v1, `fmtDate` e la costante `STATUS`, `MONTHS` locale; `esc` resta)
- Delete: `test/smoke.test.mjs`
- Create: `test/worker.test.mjs`

**Interfaces:**
- Consumes: `nearest` (geo), `buildIndex`/`searchStreets`/`closestStreets` (search), `buildTrattoReply`/`buildStreetReply` (reply).
- Produces: Worker con update `message`, `edited_message`, `callback_query`; cache per-isolate `{data, streets}`.

- [ ] **Step 1: Scrivi i test che falliscono**

```js
// test/worker.test.mjs
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
```

- [ ] **Step 2: Esegui e verifica il fallimento**

Run: `npm test`
Expected: `test/worker.test.mjs` FAIL (il worker v1 non gestisce testo libero né callback).

- [ ] **Step 3: Riscrivi `src/worker.js`**

Sostituisci l'intero file con (l'header di commento, `tg`, e l'`export default { fetch }` restano come in v1):

```js
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
```

- [ ] **Step 4: Aggiorna `scripts/set-webhook.mjs`**

```js
    allowed_updates: ['message', 'edited_message', 'callback_query'],
```

- [ ] **Step 5: Rimuovi il codice v1**

- `src/schedule-core.js`: elimina `collectText`, `parseProps`, `decide`, `weekdayNames`, `extractWeekdays`, `extractOrdinals`, `extractTimeRanges`, `weekOfMonth`, `WEEKDAYS`. Restano: `WEEKDAY_LABEL`, `MONTHS`, le utility Rome e `nextWindow`.
- `src/reply.js`: elimina `buildReply`, `fmtDate`, `STATUS` e la costante locale `MONTHS`; aggiorna l'import a `import { WEEKDAY_LABEL, MONTHS, nextWindow, romeParts, addDays } from './schedule-core.js';`.
- Elimina `test/smoke.test.mjs`: `git rm test/smoke.test.mjs`.

- [ ] **Step 6: Esegui i test e verifica che passino tutti**

Run: `npm test`
Expected: PASS (parse, schedule, search, reply, worker). Nessun riferimento residuo: `grep -rn "parseProps\|decide(\|buildReply" src/ scripts/ test/` → nessun risultato.

- [ ] **Step 7: Verifica che il Worker compili**

Run: `npx wrangler deploy --dry-run`
Expected: build ok, nessun errore di import.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: worker v2 — ricerca per via, bottoni inline, semantica prossima finestra"
```

---

### Task 8: Verifica ipotesi parità + documentazione

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-07-21-bot-lavaggio-strade-v2-design.md` (esito verifica parità)

- [ ] **Step 1: Verifica l'ipotesi pari/dispari contro una fonte ufficiale**

Trova 2 vie con `parity` nei dati (`node -e "const d=require('./data/pulizia_strade.json'); console.log(d.features.filter(f=>f.schedule.parity).slice(0,5).map(f=>f.via+' '+f.tratto+' '+f.schedule.parity+' wd:'+f.schedule.weekday).join('\n'))"`). Cerca le stesse vie sul servizio di lookup di Alia (https://www.aliaserviziambientali.it, sezione lavaggio strade) o sul sito del Comune di Firenze e confronta le prossime date pubblicate con l'output di `nextWindow`:
- **Se coincidono con le settimane ISO** → ipotesi confermata, annota l'esito nella spec (sezione Rischi).
- **Se coincidono invece con le settimane pari/dispari del MESE** → cambia `dayMatches` in `schedule-core.js`: sostituisci `isoWeek(day) % 2 === 0` con `Math.ceil(day.d / 7) % 2 === 0`, aggiorna il test di parità di conseguenza e annota l'esito.
- **Se il lookup non è consultabile** → mantieni l'ipotesi ISO, annota "non verificabile online" nella spec: la mitigazione (raw sempre visibile + disclaimer cartello) resta.

- [ ] **Step 2: Aggiorna `README.md`**

Sezioni da riscrivere: la descrizione in testa (posizione **o nome via**; semantica "prossima finestra", notturna o diurna, fuso Europe/Rome), il diagramma resta valido, aggiungi sotto "Come funziona" il paragrafo:

```markdown
### Cosa risponde

- **Posizione** → il tratto di via più vicino (entro 60 m), con la prossima
  finestra di lavaggio ("STANOTTE 00:00–06:00", "OGGI 13:00–18:00", o la data
  futura) e quella successiva.
- **Nome della via** (es. `via masaccio`) → tutti i tratti della via,
  accorpati per calendario; se più vie corrispondono compaiono dei bottoni.
- Il lavaggio può essere **notturno (00:00–06:00) o diurno**: il bot considera
  entrambi. Le settimane "pari/dispari" del calendario sono interpretate come
  settimane ISO dell'anno (ipotesi documentata nella spec; fa sempre fede il
  cartello in strada).
```

Nella sezione "Note" sostituisci il punto "Precisione del calendario" con: il parser legge i **campi strutturati** del dataset e la build **fallisce** se il formato upstream cambia (copertura < 90%).

- [ ] **Step 3: Aggiorna `CLAUDE.md`**

Aggiorna: elenco `src/` (nuovi `parse-dataset.js`, `search.js`), vincolo "separazione parse/decide" → "parse in build (`parse-dataset.js`), `nextWindow` a runtime (`schedule-core.js`)", nota sul fuso Europe/Rome via `Intl` (mai date locali dirette), `npm test` = `node --test test/`, rimuovi la nota "0 con giorni riconosciuti"/parser best-effort e la voce "data/ vuota" se non più vera. La sezione "Note sullo stato del repo" va aggiornata: il repo ora è git (`spleenteo/lavaggio-strade-bot`).

- [ ] **Step 4: Test finali e commit**

Run: `npm test && npx wrangler deploy --dry-run`
Expected: tutto PASS.

```bash
git add -A
git commit -m "docs: README e CLAUDE.md per la v2; esito verifica parità"
git push
```

---

## Fuori dal piano (fasi successive già concordate)

Code review (`/code-review`) e scelta della modalità di pubblicazione/deploy: si fanno dopo l'esecuzione di questo piano, come da percorso concordato col committente.
