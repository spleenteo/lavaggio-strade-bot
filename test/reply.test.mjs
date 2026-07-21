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

test('windowLabel: query notturna (00:00–05:59) non deve etichettare STANOTTE la finestra del giorno dopo', () => {
  // Query mercoledì 01:00: la finestra che inizia alla mezzanotte SUCCESSIVA (giovedì 00:00–06:00)
  // è "domani", non "stanotte" — altrimenti si confonde con la finestra di stanotte (mer 00:00, già passata).
  const win = { start: romeDate(2026, 7, 23, 0, 0), end: romeDate(2026, 7, 23, 6, 0), ongoing: false };
  const queryNotturna = romeDate(2026, 7, 22, 1, 0);
  assert.equal(windowLabel(win, queryNotturna), 'domani 00:00–06:00');
});

test('nessun caveat di parità: la semantica pari/dispari è confermata, le date sono affidabili come le altre', () => {
  const paritySchedule = { weekday: 3, weeks: ALL, parity: 'even', start: '00:00', end: '06:00' };
  const matchParity = { feature: feat('VIA PARI', 7000, 'DA A A B', paritySchedule), distanceMeters: 5 };
  const trattoParityTxt = buildTrattoReply(matchParity, 60, NOW, false);
  assert.ok(!trattoParityTxt.includes('settimane alterne'));

  const streetParity = { viaId: 7000, via: 'VIA PARI', searchName: 'via pari', tratti: [0] };
  const streetParityTxt = buildStreetReply(streetParity, [feat('VIA PARI', 7000, 'DA A A B', paritySchedule)], NOW);
  assert.ok(!streetParityTxt.includes('settimane alterne'));
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

// ── rassicurazione "stanotte nessun lavaggio" quando la finestra non è imminente ──

test('buildTrattoReply: schedule lontano → rassicurazione "stanotte nessun lavaggio"', () => {
  const lontano = { weekday: 2, weeks: [1], parity: null, start: '00:00', end: '06:00' }; // 1° martedì → 4/8
  const match = { feature: feat('VIA PISANA', 5000, 'DA A A B', lontano), distanceMeters: 12 };
  const txt = buildTrattoReply(match, 60, NOW, false);
  assert.ok(txt.includes('🌙 Stanotte (notte mar→mer): ✅ nessun lavaggio previsto.'));
});

test('buildTrattoReply: schedule imminente (STANOTTE) → nessuna rassicurazione', () => {
  const match = { feature: feat('VIA MASACCIO', 9800, 'DA MIRANDOLA A LA FARINA', notturnoMer), distanceMeters: 12 };
  const txt = buildTrattoReply(match, 60, NOW, false);
  assert.ok(!txt.includes('🌙'));
});

test('buildStreetReply: due gruppi entrambi lontani → UNA sola rassicurazione', () => {
  const lontano = { weekday: 2, weeks: [1], parity: null, start: '00:00', end: '06:00' }; // 1° martedì → 4/8
  const lontano2 = { weekday: 4, weeks: [1], parity: null, start: '00:00', end: '06:00' }; // 1° giovedì → 6/8
  const features = [
    feat('VIA PISANA', 5000, 'DA A A B', lontano),
    feat('VIA PISANA', 5000, 'DA B A C', lontano2),
  ];
  const street = { viaId: 5000, via: 'VIA PISANA', searchName: 'via pisana', tratti: [0, 1] };
  const txt = buildStreetReply(street, features, NOW);
  const count = (txt.match(/🌙/g) || []).length;
  assert.equal(count, 1);
  assert.ok(txt.includes('🌙 Stanotte (notte mar→mer): ✅ nessun lavaggio previsto.'));
});

test('buildStreetReply: un gruppo imminente + uno lontano → nessuna rassicurazione', () => {
  const lontano = { weekday: 2, weeks: [1], parity: null, start: '00:00', end: '06:00' }; // 1° martedì → 4/8
  const features = [
    feat('VIA PISANA', 5000, 'DA A A B', lontano),
    feat('VIA PISANA', 5000, 'DA B A C', notturnoMer), // STANOTTE
  ];
  const street = { viaId: 5000, via: 'VIA PISANA', searchName: 'via pisana', tratti: [0, 1] };
  const txt = buildStreetReply(street, features, NOW);
  assert.ok(!txt.includes('🌙'));
});

test('buildTrattoReply: span notturno con query alle 01:00 → notte IN CORSO (mar→mer), non quella successiva', () => {
  const notteInCorso = romeDate(2026, 7, 22, 1, 0); // mercoledì 01:00
  const lontano = { weekday: 2, weeks: [1], parity: null, start: '00:00', end: '06:00' }; // 1° martedì → 4/8
  const match = { feature: feat('VIA PISANA', 5000, 'DA A A B', lontano), distanceMeters: 12 };
  const txt = buildTrattoReply(match, 60, notteInCorso, false);
  assert.ok(txt.includes('(notte mar→mer)'));
});
