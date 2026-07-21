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
