// Costruzione del messaggio Telegram in HTML (robusto ai caratteri speciali).
import { WEEKDAY_LABEL, MONTHS, nextWindow, romeParts, addDays } from './schedule-core.js';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
