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
