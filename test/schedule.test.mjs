import test from 'node:test';
import assert from 'node:assert';
import { romeParts, romeDate, addDays, isoWeek, nextWindow } from '../src/schedule-core.js';

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
