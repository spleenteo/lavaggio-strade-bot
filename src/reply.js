// Costruzione del messaggio Telegram in HTML (robusto ai caratteri speciali).
import { decide, weekdayNames, WEEKDAY_LABEL } from './schedule-core.js';

const STATUS = { yes: '⚠️ SÌ', no: '✅ No', unknown: '❓ Non certo' };
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Formattazione italiana "fatta a mano": non dipende dai dati locale del
// runtime (Cloudflare Workers non garantisce l'ICU per tutte le lingue).
function fmtDate(d) {
  return `${WEEKDAY_LABEL[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function buildReply(match, thresholdM, date) {
  if (!match || match.distanceMeters > thresholdM) {
    const dist = match ? ` (la via più vicina è a ${Math.round(match.distanceMeters)} m)` : '';
    return (
      `🤔 Non ho trovato una via abbastanza vicina alla posizione${dist}.\n\n` +
      `Può darsi che la posizione sia fuori dal Comune di Firenze (il dataset copre solo Firenze città) ` +
      `o che quella via non sia nel calendario. Prova a condividere la posizione stando proprio sulla strada.`
    );
  }

  const f = match.feature;
  const a = decide(f, date);
  const name = f.name || 'Via non specificata';

  const lines = [];
  lines.push(`📍 <b>${esc(name)}</b>`);
  lines.push(`<i>a ~${Math.round(match.distanceMeters)} m dalla posizione condivisa</i>`);
  lines.push('');
  lines.push(`🗓 <b>${esc(fmtDate(date))}</b> → ${STATUS[a.status]} lavaggio/spazzamento`);
  lines.push(`<i>${esc(a.reason)}</i>`);

  if (f.weekdays && f.weekdays.length) {
    lines.push('');
    lines.push(`Giorni di servizio: <b>${esc(weekdayNames(f.weekdays).join(', '))}</b>`);
    if (f.ordinals && !f.ordinals.everyWeek && f.ordinals.weeks && f.ordinals.weeks.length) {
      lines.push(`Settimane del mese: ${f.ordinals.weeks.map((w) => `${w}ª`).join(', ')}`);
    }
    if (f.times && f.times.length) lines.push(`Fascia oraria: ${esc(f.times.join(', '))}`);
  }

  if (f.raw) {
    const raw = f.raw.length > 500 ? f.raw.slice(0, 500) + '…' : f.raw;
    lines.push('');
    lines.push('📄 Testo dal calendario ufficiale:');
    lines.push(`<code>${esc(raw)}</code>`);
  }

  lines.push('');
  lines.push('<i>Dati: open data Comune di Firenze (fonte Alia). Fa sempre fede il cartello in strada.</i>');
  return lines.join('\n');
}
