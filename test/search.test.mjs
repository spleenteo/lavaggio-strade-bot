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

// --- Numeri civici nella query (retry a due passate) ---

const STREETS_99 = buildIndex([
  ...FEATURES,
  { via: "VIA RAGAZZI DEL '99", viaId: 111, searchName: 'via ragazzi del 99' },
]);

test('searchStreets: ignora il numero civico se la query piena non matcha', () => {
  const r = searchStreets(STREETS_99, 'borgo allegri 23');
  assert.equal(r.length, 1);
  assert.equal(r[0].viaId, 400);
});

test('searchStreets: civico con lettera o barra ("15/r", "23a")', () => {
  assert.equal(searchStreets(STREETS_99, 'via masaccio 15/r')[0].viaId, 9800);
  assert.equal(searchStreets(STREETS_99, 'Borgo Allegri 23a')[0].viaId, 400);
});

test('searchStreets: le vie con numeri veri nel nome restano cercabili', () => {
  const r = searchStreets(STREETS_99, "via ragazzi del '99");
  assert.equal(r[0].viaId, 111); // passata piena: il "99" NON viene scartato
});

test('searchStreets: query di soli numeri non matcha nulla', () => {
  assert.deepEqual(searchStreets(STREETS_99, '23'), []);
});
