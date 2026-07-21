// Logica di calendario, PURA (nessuna dipendenza): usabile sia dal Worker
// Cloudflare sia dallo script di build in Node.
//
// Utilità di fuso orario Europe/Rome e nextWindow(): dato uno schedule
// strutturato {weekday, weeks, parity, start, end}, calcola la prossima
// finestra di lavaggio.

export const WEEKDAY_LABEL = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

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

const parseHM = (s) => s.split(':').map(Number);

function dayMatches(schedule, day) {
  const wd = new Date(Date.UTC(day.y, day.m - 1, day.d, 12)).getUTCDay();
  if (wd !== schedule.weekday) return false;
  if (!schedule.weeks.includes(Math.ceil(day.d / 7))) return false; // n-esima occorrenza del giorno nel mese
  if (schedule.parity) {
    // "pari"/"dispari" = parità della DATA del mese (semantica dei cartelli Alia:
    // es. "giovedì pari" = i giovedì che cadono il 2, 16, 30…), NON la settimana
    // ISO dell'anno. Verificato 56/56 sul lookup ufficiale Alia il 2026-07-21
    // (vedi spec, sezione Rischi), incluso il caso discriminante del cambio mese:
    // due occorrenze consecutive dello stesso giorno della settimana possono
    // risultare entrambe "pari" (es. giovedì 30/7 e 6/8/2026).
    const even = day.d % 2 === 0;
    if ((schedule.parity === 'even') !== even) return false;
  }
  return true;
}

/**
 * Prossima finestra di lavaggio del tratto, in ora locale Europe/Rome.
 * Match del giorno: weekday + n-esima occorrenza nel mese + parità della data
 * del mese (se presente) — vedi `dayMatches`.
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
