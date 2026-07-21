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
import { parseProps } from '../src/schedule-core.js';
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

  const features = [];
  for (const f of geojson.features) {
    const lines = geometryToLines(f.geometry);
    if (!lines.length) continue;
    const props = f.properties || {};
    const parsed = parseProps(props);
    const name = props.name || props.Name || props.via || props.VIA || props.nome || props.NOME || null;
    features.push({
      name,
      lines,
      bbox: bboxOfLines(lines),
      weekdays: parsed.weekdays,
      ordinals: parsed.ordinals,
      times: parsed.times,
      raw: parsed.raw,
    });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: DATA_URL,
    license: 'CC-BY-NC-SA 4.0 - Comune di Firenze (fonte Alia)',
    count: features.length,
    features,
  };

  mkdirSync('data', { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));
  const withDays = features.filter((f) => f.weekdays.length).length;
  console.log(`✓ Scritte ${features.length} vie in ${OUT} (${withDays} con giorni riconosciuti).`);
  console.log(`  Dimensione: ${(JSON.stringify(out).length / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
