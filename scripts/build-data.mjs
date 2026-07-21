// Scarica il KMZ del Comune di Firenze, lo converte in un JSON compatto e
// "pre-digerito" (geometrie + calendario già parsato + bbox) pronto per KV.
//
// Uso:  node scripts/build-data.mjs
// Output: data/pulizia_strade.json
//
// Questo script gira in Node (non nel Worker), quindi può usare adm-zip/xmldom.

import { writeFileSync, mkdirSync } from 'node:fs';
import AdmZip from 'adm-zip';
import { DOMParser } from '@xmldom/xmldom';
import { kml as kmlToGeoJSON } from '@tmcw/togeojson';
import { extractFields, parseSchedule, officialRaw } from '../src/parse-dataset.js';
import { normalizeName } from '../src/search.js';
import { bboxOfLines } from '../src/geo.js';

const DATA_URL = process.env.DATA_URL || 'https://datigis.comune.fi.it/kml/pulizia_strade.kmz';
const OUT = 'data/pulizia_strade.json';

const round = (n) => Math.round(n * 1e6) / 1e6;

/** Estrae dalla geometria GeoJSON un array di "linee" [[lon,lat],...]. */
function geometryToLines(geom) {
  if (!geom) return [];
  const strip = (coords) => coords.map(([lon, lat]) => [round(lon), round(lat)]);
  switch (geom.type) {
    case 'LineString':
      return [strip(geom.coordinates)];
    case 'MultiLineString':
      return geom.coordinates.map(strip);
    case 'Polygon':
      return geom.coordinates.map(strip);
    case 'MultiPolygon':
      return geom.coordinates.flat().map(strip);
    case 'Point':
      return [[[round(geom.coordinates[0]), round(geom.coordinates[1])]]];
    case 'GeometryCollection':
      return geom.geometries.flatMap(geometryToLines);
    default:
      return [];
  }
}

async function main() {
  console.log('Scarico il dataset da', DATA_URL);
  const res = await fetch(DATA_URL, {
    headers: { 'User-Agent': 'alia-lavaggio-strade-bot/1.0 (uso personale)' },
  });
  if (!res.ok) throw new Error(`Download fallito: HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());

  // KMZ = zip che contiene un .kml
  let kmlText;
  try {
    const zip = new AdmZip(buf);
    const entry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.kml'));
    if (!entry) throw new Error('Nessun .kml nel KMZ');
    kmlText = entry.getData().toString('utf8');
  } catch {
    const asText = buf.toString('utf8');
    if (asText.includes('<kml') || asText.includes('<Placemark')) kmlText = asText;
    else throw new Error('Formato dati non riconosciuto');
  }

  const dom = new DOMParser().parseFromString(kmlText, 'text/xml');
  const geojson = kmlToGeoJSON(dom);

  // Un record per (via, tratto, calendario): le feature duplicate si fondono.
  const byKey = new Map();
  let total = 0;
  let ok = 0;
  for (const f of geojson.features) {
    const lines = geometryToLines(f.geometry);
    if (!lines.length) continue;
    total++;
    const fields = extractFields(f.properties || {});
    const schedule = parseSchedule(fields);
    if (!schedule || !fields.indirizzo || !fields.codice_via) continue;
    ok++;
    const via = fields.indirizzo.trim();
    const tratto = (fields.tratto_strada || '').trim();
    const key = `${fields.codice_via}|${tratto}|${JSON.stringify(schedule)}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        via,
        viaId: Number(fields.codice_via),
        searchName: normalizeName(via),
        tratto,
        schedule,
        lines: [],
        bbox: null,
        raw: officialRaw(fields),
      });
    }
    byKey.get(key).lines.push(...lines);
  }
  const features = [...byKey.values()];
  for (const f of features) f.bbox = bboxOfLines(f.lines);

  // Validazione: se il formato upstream cambia, la build DEVE fallire.
  const vieUniche = new Set(features.map((f) => f.viaId)).size;
  const coverage = total ? ok / total : 0;
  console.log(`Parsing: ${ok}/${total} record (${(coverage * 100).toFixed(1)}%) → ${features.length} tratti, ${vieUniche} vie.`);
  if (vieUniche < 500) throw new Error(`Solo ${vieUniche} vie (< 500): formato upstream cambiato?`);
  if (coverage < 0.9) throw new Error(`Copertura parsing ${(coverage * 100).toFixed(1)}% (< 90%): formato upstream cambiato?`);

  const out = {
    generatedAt: new Date().toISOString(),
    source: DATA_URL,
    license: 'CC-BY-NC-SA 4.0 - Comune di Firenze (fonte Alia)',
    count: features.length,
    parseOk: ok,
    parseTotal: total,
    features,
  };

  mkdirSync('data', { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));
  console.log(`✓ Scritte ${features.length} voci (${vieUniche} vie) in ${OUT}.`);
  console.log(`  Dimensione: ${(JSON.stringify(out).length / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
