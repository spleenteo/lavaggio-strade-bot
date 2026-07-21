import test from 'node:test';
import assert from 'node:assert';
import { extractFields, parseSchedule, officialRaw } from '../src/parse-dataset.js';

// Fixture modellata sul dataset reale (record BORGO ALLEGRI, vedi spec).
const PROPS = {
  name: 'pulizia_strade_iternet.670368',
  description:
    'pulizia_strade_iternet <br>\n' +
    ' comune : FIRENZE \n indirizzo : BORGO ALLEGRI \n' +
    ' data_caricamento : 2026-02-23 03:03:01.193133+01 \n' +
    ' codice_via : 400 \n prima_settimana : 1 \n seconda_settimana : 1 \n' +
    ' terza_settimana : 1 \n quarta_settimana : 1 \n quinta_settimana : 1 \n' +
    ' giorno_settimana : GI \n ora_inizio : 00:00 \n ora_fine : 06:00 \n' +
    ' tratto_strada : DA AGNOLO A PIETRAPIANA \n notturno : 1 \n settimanale : 0 \n' +
    ' pari : 1 \n dispari : 0 \n tipo_record : I \n cod_top : RT04801701829TO \n cod_via : 400 \n' +
    '\nstroke-opacity: 1\nstroke: #bb3754\nicon: http://icons.opengeo.org/x.png',
};

test('extractFields legge i campi chiave', () => {
  const f = extractFields(PROPS);
  assert.equal(f.indirizzo, 'BORGO ALLEGRI');
  assert.equal(f.codice_via, '400');
  assert.equal(f.giorno_settimana, 'GI');
  assert.equal(f.tratto_strada, 'DA AGNOLO A PIETRAPIANA');
  assert.equal(f.ora_inizio, '00:00');
  assert.equal(f.data_caricamento, '2026-02-23 03:03:01.193133+01'); // valore con ":" interni
});

test('parseSchedule costruisce lo schedule', () => {
  const s = parseSchedule(extractFields(PROPS));
  assert.deepEqual(s, { weekday: 4, weeks: [1, 2, 3, 4, 5], parity: 'even', start: '00:00', end: '06:00' });
});

test('parseSchedule → null senza giorno riconosciuto', () => {
  assert.equal(parseSchedule({ ora_inizio: '00:00', ora_fine: '06:00' }), null);
  assert.equal(parseSchedule({ giorno_settimana: 'XX', ora_inizio: '00:00', ora_fine: '06:00' }), null);
});

test('parseSchedule → null con finestra invertita o settimane vuote', () => {
  const base = { giorno_settimana: 'LU', prima_settimana: '1', ora_inizio: '13:00', ora_fine: '06:00' };
  assert.equal(parseSchedule(base), null); // end ≤ start
  assert.equal(parseSchedule({ giorno_settimana: 'LU', ora_inizio: '00:00', ora_fine: '06:00' }), null); // nessuna settimana
});

test('officialRaw esclude gli stili KML', () => {
  const raw = officialRaw(extractFields(PROPS));
  assert.ok(raw.includes('indirizzo: BORGO ALLEGRI'));
  assert.ok(raw.includes('giorno_settimana: GI'));
  assert.ok(!raw.includes('stroke'));
  assert.ok(!raw.includes('icon'));
});
