// Logica di calendario, PURA (nessuna dipendenza): usabile sia dal Worker
// Cloudflare sia dallo script di build in Node.
//
// - Le funzioni di parsing (parseProps) girano in fase di BUILD e producono
//   {weekdays, ordinals, times, raw} salvati in KV.
// - decide() gira nel Worker e, data la data odierna, dice se c'è servizio.

export const WEEKDAY_LABEL = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

const WEEKDAYS = [
  { idx: 0, names: ['domenica'] },
  { idx: 1, names: ['lunedi', 'lunedì', 'lun'] },
  { idx: 2, names: ['martedi', 'martedì', 'mar'] },
  { idx: 3, names: ['mercoledi', 'mercoledì', 'mer'] },
  { idx: 4, names: ['giovedi', 'giovedì', 'gio'] },
  { idx: 5, names: ['venerdi', 'venerdì', 'ven'] },
  { idx: 6, names: ['sabato', 'sab'] },
];

/** Concatena tutte le stringhe utili delle proprietà di un placemark. */
export function collectText(props = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (typeof v === 'string' || typeof v === 'number') parts.push(`${k}: ${v}`);
  }
  return parts
    .join('\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function extractWeekdays(text) {
  const lower = text.toLowerCase();
  const found = new Set();
  for (const wd of WEEKDAYS) {
    for (const n of wd.names) {
      // Confini "unicode-aware": \b non gestisce le lettere accentate.
      const re = new RegExp(`(?<!\\p{L})${n}(?!\\p{L})`, 'iu');
      if (re.test(lower)) {
        found.add(wd.idx);
        break;
      }
    }
  }
  return [...found].sort((a, b) => a - b);
}

function extractOrdinals(text) {
  const lower = text.toLowerCase();
  if (/\b(ogni|tutti i|tutte le|settimanale)\b/.test(lower)) {
    return { everyWeek: true, weeks: [1, 2, 3, 4, 5] };
  }
  const weeks = new Set();
  const wordMap = { primo: 1, prima: 1, secondo: 2, seconda: 2, terzo: 3, terza: 3, quarto: 4, quarta: 4, quinto: 5, quinta: 5 };
  for (const [w, n] of Object.entries(wordMap)) {
    if (new RegExp(`(?<!\\p{L})${w}(?!\\p{L})`, 'u').test(lower)) weeks.add(n);
  }
  const re = /(\d)\s*[°ª]/g;
  let m;
  while ((m = re.exec(lower)) !== null) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 5) weeks.add(n);
  }
  return { everyWeek: false, weeks: [...weeks].sort() };
}

function extractTimeRanges(text) {
  const re = /(\d{1,2})[:.](\d{2})\s*[-–—alle ]+\s*(\d{1,2})[:.](\d{2})/gi;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(`${m[1].padStart(2, '0')}:${m[2]}–${m[3].padStart(2, '0')}:${m[4]}`);
  }
  return [...new Set(out)];
}

/** Analizza le proprietà di un placemark (usato in fase di build). */
export function parseProps(props) {
  const raw = collectText(props);
  return {
    weekdays: extractWeekdays(raw),
    ordinals: extractOrdinals(raw),
    times: extractTimeRanges(raw),
    raw,
  };
}

function weekOfMonth(date) {
  return Math.ceil(date.getDate() / 7);
}

/**
 * Dato un oggetto già parsato {weekdays, ordinals, times} e una data, decide.
 * @returns {{status:'yes'|'no'|'unknown', reason:string}}
 */
export function decide(parsed, date) {
  const weekdays = parsed.weekdays || [];
  const ordinals = parsed.ordinals || { everyWeek: false, weeks: [] };
  if (weekdays.length === 0) {
    return { status: 'unknown', reason: 'Nessun giorno riconosciuto nel testo del calendario.' };
  }
  const targetWd = date.getDay();
  const targetWeek = weekOfMonth(date);

  if (!weekdays.includes(targetWd)) {
    return { status: 'no', reason: `Oggi è ${WEEKDAY_LABEL[targetWd]}, non tra i giorni di servizio.` };
  }
  if (ordinals.everyWeek || !ordinals.weeks || ordinals.weeks.length === 0) {
    return { status: 'yes', reason: 'Il giorno della settimana coincide (nessuna restrizione di settimana rilevata).' };
  }
  if (ordinals.weeks.includes(targetWeek)) {
    return { status: 'yes', reason: `Coincidono giorno (${WEEKDAY_LABEL[targetWd]}) e settimana del mese (${targetWeek}ª).` };
  }
  return {
    status: 'no',
    reason: `Giusto giorno (${WEEKDAY_LABEL[targetWd]}) ma settimana non prevista (oggi ${targetWeek}ª, previste: ${ordinals.weeks.join('ª, ')}ª).`,
  };
}

export function weekdayNames(indices = []) {
  return indices.map((i) => WEEKDAY_LABEL[i]);
}
