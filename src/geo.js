// Geometria PURA (nessuna dipendenza). Calcola la via più vicina a un punto,
// usando una proiezione equirettangolare locale (accurata a scala urbana) per
// misurare le distanze in metri. Ogni feature ha:
//   { name, weekdays, ordinals, times, raw, lines: [[[lon,lat],...]], bbox:[minLon,minLat,maxLon,maxLat] }

const R = 6371000; // raggio terrestre (m)

function metersPerDegLon(lat) {
  return (Math.PI / 180) * R * Math.cos((lat * Math.PI) / 180);
}
const M_PER_DEG_LAT = (Math.PI / 180) * R;

/** Distanza minima (m) da un punto al bounding box: usata come lower bound. */
function pointToBboxMeters(lon, lat, bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const dLon = Math.max(minLon - lon, 0, lon - maxLon);
  const dLat = Math.max(minLat - lat, 0, lat - maxLat);
  const x = dLon * metersPerDegLon(lat);
  const y = dLat * M_PER_DEG_LAT;
  return Math.hypot(x, y);
}

/** Distanza (m) da un punto a un segmento, in coordinate locali piane. */
function pointToSegmentMeters(lon, lat, aLon, aLat, bLon, bLat) {
  const mLon = metersPerDegLon(lat);
  const px = 0;
  const py = 0;
  const ax = (aLon - lon) * mLon;
  const ay = (aLat - lat) * M_PER_DEG_LAT;
  const bx = (bLon - lon) * mLon;
  const by = (bLat - lat) * M_PER_DEG_LAT;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function pointToLinesMeters(lon, lat, lines) {
  let min = Infinity;
  for (const line of lines) {
    if (line.length === 1) {
      const [plon, plat] = line[0];
      min = Math.min(min, pointToSegmentMeters(lon, lat, plon, plat, plon, plat));
      continue;
    }
    for (let i = 0; i < line.length - 1; i++) {
      const [aLon, aLat] = line[i];
      const [bLon, bLat] = line[i + 1];
      const d = pointToSegmentMeters(lon, lat, aLon, aLat, bLon, bLat);
      if (d < min) min = d;
    }
  }
  return min;
}

/**
 * Trova la feature più vicina. Usa il lower bound sul bbox per saltare le vie
 * lontane senza calcolare tutti i segmenti.
 * @returns {{feature:object, distanceMeters:number}|null}
 */
export function nearest(features, lon, lat) {
  let best = null;
  for (const f of features) {
    if (f.bbox && pointToBboxMeters(lon, lat, f.bbox) > (best ? best.distanceMeters : Infinity)) {
      continue;
    }
    const d = pointToLinesMeters(lon, lat, f.lines);
    if (!best || d < best.distanceMeters) best = { feature: f, distanceMeters: d };
  }
  return best;
}

/** Calcola il bounding box di un insieme di linee. */
export function bboxOfLines(lines) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const line of lines) {
    for (const [lon, lat] of line) {
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return [minLon, minLat, maxLon, maxLat];
}
