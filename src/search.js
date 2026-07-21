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
