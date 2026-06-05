/**
 * Restroom Desert Report — Data Pipeline
 *
 * Usage:
 *   node pipeline.js --state "Virginia"
 *   node pipeline.js --state "California" --top 10
 *   node pipeline.js --list-states
 *
 * Output:
 *   results/<state>_<date>.json   — full ranked data
 *   results/<state>_<date>.txt    — human-readable summary for social captions
 */

import { CITIES_BY_STATE, STATE_NAMES } from './cities.js';
import * as turf from '@turf/turf';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
const DEAD_ZONE_RADIUS = 400;   // meters — same as website
const GRID_STEPS       = 60;    // grid resolution (60x60 = 3600 cells per city)
const NOMINATIM_DELAY  = 1200;  // ms between Nominatim requests (rate limit)
const OVERPASS_DELAY   = 2000;  // ms between Overpass requests

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function flatDist(lat1, lon1, lat2, lon2) {
  const dlat = (lat2 - lat1) * 111000;
  const dlon = (lon2 - lon1) * 111000 * Math.cos(lat1 * Math.PI / 180);
  return Math.sqrt(dlat * dlat + dlon * dlon);
}

function formatPop(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  return Math.round(n / 1000) + 'k';
}

function gapLabel(pct) {
  if (pct >= 80) return '🌵 Severe Desert';
  if (pct >= 60) return '🟠 High Desert';
  if (pct >= 40) return '🟡 Moderate Desert';
  if (pct >= 20) return '🟢 Low Desert';
  return '💧 Well Covered';
}

// ── Nominatim: get city boundary ──────────────────────────────────────────────
const REQUEST_HEADERS = {
  'User-Agent': 'PortaDash-RestroomDesertReport/1.0 (portadash.com)',
};

async function getCityBoundary(cityName) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cityName)}&format=json&limit=3&polygon_geojson=1`;
  const res = await fetch(url, { headers: REQUEST_HEADERS });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const results = await res.json();

  // Prefer results with a polygon boundary
  const withPoly = results.filter(r => r.geojson && ['Polygon','MultiPolygon'].includes(r.geojson.type));
  const r = withPoly[0] || results[0];
  if (!r) return null;

  return {
    bbox: r.boundingbox,
    geojson: r.geojson || null,
    displayName: r.display_name,
  };
}

// ── Overpass: get facilities in bounding box ──────────────────────────────────
async function getFacilities(bbox) {
  const [south, north, west, east] = [
    parseFloat(bbox[0]), parseFloat(bbox[1]),
    parseFloat(bbox[2]), parseFloat(bbox[3]),
  ];
  const bboxStr = `${south},${west},${north},${east}`;
  const query = `[out:json][timeout:60];(node["amenity"="toilets"]["temporary"!="yes"]["portable"!="yes"](${bboxStr});way["amenity"="toilets"]["temporary"!="yes"]["portable"!="yes"](${bboxStr});node["amenity"="library"](${bboxStr});way["amenity"="library"](${bboxStr});node["tourism"="museum"](${bboxStr});way["tourism"="museum"](${bboxStr}););out center;`;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: REQUEST_HEADERS,
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data?.elements) continue;

      const facilities = [];
      for (const el of data.elements) {
        const lat = el.lat ?? el.center?.lat;
        const lon = el.lon ?? el.center?.lon;
        if (!lat || !lon) continue;
        const tags = el.tags || {};
        if (tags.amenity === 'toilets') {
          if (tags.temporary === 'yes' || tags.portable === 'yes') continue;
          facilities.push({ lat, lon, type: 'restroom' });
        } else if (tags.amenity === 'library') {
          facilities.push({ lat, lon, type: 'library' });
        } else if (tags.tourism === 'museum') {
          facilities.push({ lat, lon, type: 'museum' });
        }
      }
      return facilities;
    } catch (_) {
      continue;
    }
  }
  return [];
}

// ── Gap score calculation ─────────────────────────────────────────────────────
function computeGapScore(bbox, geojson, facilities) {
  const south = parseFloat(bbox[0]);
  const north = parseFloat(bbox[1]);
  const west  = parseFloat(bbox[2]);
  const east  = parseFloat(bbox[3]);

  const latStep = (north - south) / GRID_STEPS;
  const lonStep = (east - west)   / GRID_STEPS;

  const highlightFeature = geojson
    ? { type: 'Feature', geometry: geojson, properties: {} }
    : null;

  let totalCells = 0;
  let deadCells  = 0;

  for (let lat = south + latStep / 2; lat < north; lat += latStep) {
    for (let lon = west + lonStep / 2; lon < east; lon += lonStep) {
      // If we have a boundary polygon, only count cells inside it
      if (highlightFeature) {
        try {
          if (!turf.booleanPointInPolygon(turf.point([lon, lat]), highlightFeature)) continue;
        } catch (_) {
          // Malformed polygon — skip boundary check
        }
      }
      totalCells++;
      const covered = facilities.some(f => flatDist(lat, lon, f.lat, f.lon) <= DEAD_ZONE_RADIUS);
      if (!covered) deadCells++;
    }
  }

  return totalCells > 0 ? Math.round((deadCells / totalCells) * 100) : 0;
}

// ── Score a single city ───────────────────────────────────────────────────────
async function scoreCity(city, index, total) {
  process.stdout.write(`  [${index + 1}/${total}] ${city.name} ... `);

  try {
    await sleep(NOMINATIM_DELAY);
    const boundary = await getCityBoundary(city.name);
    if (!boundary) {
      console.log('skipped (not found)');
      return null;
    }

    await sleep(OVERPASS_DELAY);
    const facilities = await getFacilities(boundary.bbox);
    const gapPct = computeGapScore(boundary.bbox, boundary.geojson, facilities);

    console.log(`${gapPct}% gap · ${facilities.length} facilities`);

    return {
      name: city.name,
      population: city.pop,
      populationFormatted: formatPop(city.pop),
      gapPct,
      gapLabel: gapLabel(gapPct),
      facilitiesFound: facilities.length,
      restroomCount: facilities.filter(f => f.type === 'restroom').length,
      libraryCount:  facilities.filter(f => f.type === 'library').length,
      museumCount:   facilities.filter(f => f.type === 'museum').length,
    };
  } catch (err) {
    console.log(`error: ${err.message}`);
    return null;
  }
}

// ── Format social media caption ───────────────────────────────────────────────
function formatCaption(state, ranked, topN) {
  const worst = ranked.slice(0, topN);
  const best  = ranked.slice(-topN).reverse();
  const date  = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const worstLines = worst.map((c, i) => `${i + 1}. ${c.name} — ${c.gapPct}% desert`).join('\n');
  const bestLines  = best.map((c, i) =>  `${i + 1}. ${c.name} — ${c.gapPct}% desert`).join('\n');

  return `
🌵 RESTROOM DESERT REPORT — ${state.toUpperCase()}
📅 ${date}

━━ WORST ${topN} ━━
${worstLines}

━━ BEST ${topN} ━━
${bestLines}

A Restroom Desert = any area where no public restroom exists within a 5-minute walk.
Score = % of city with no facility within 400m (OSM data + community pins).

Think we missed a facility in your city? Add it → portadash.com/deserts
Download PortaDash → portadash.com

#RestroomDesert #PublicRestrooms #${state.replace(/\s/g, '')} #PortaDash #CivicData
`.trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list-states')) {
    console.log('\nAvailable states:\n');
    STATE_NAMES.forEach(s => console.log(`  ${s} (${CITIES_BY_STATE[s].length} cities)`));
    console.log();
    return;
  }

  const stateIndex = args.indexOf('--state');
  if (stateIndex === -1 || !args[stateIndex + 1]) {
    console.log('\nUsage:');
    console.log('  node pipeline.js --state "Virginia"');
    console.log('  node pipeline.js --state "California" --top 10');
    console.log('  node pipeline.js --list-states\n');
    process.exit(1);
  }

  const stateName = args[stateIndex + 1];
  const topN = parseInt(args[args.indexOf('--top') + 1]) || 5;

  const cities = CITIES_BY_STATE[stateName];
  if (!cities) {
    console.error(`\nState not found: "${stateName}"`);
    console.error('Run with --list-states to see available states.\n');
    process.exit(1);
  }

  console.log(`\n🌵 Restroom Desert Report — ${stateName}`);
  console.log(`   Scoring ${cities.length} cities (top ${topN} worst/best)\n`);

  const results = [];
  for (let i = 0; i < cities.length; i++) {
    const result = await scoreCity(cities[i], i, cities.length);
    if (result) results.push(result);
  }

  if (results.length === 0) {
    console.error('\nNo cities scored successfully.\n');
    process.exit(1);
  }

  // Sort worst → best
  const ranked = results.sort((a, b) => b.gapPct - a.gapPct);

  // Print summary
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`RESULTS — ${stateName} (${results.length} cities scored)`);
  console.log('─'.repeat(60));
  console.log(`${'Rank'.padEnd(6)}${'City'.padEnd(28)}${'Pop'.padEnd(8)}${'Gap %'.padEnd(8)}Label`);
  console.log('─'.repeat(60));
  ranked.forEach((c, i) => {
    const rank = String(i + 1).padEnd(6);
    const name = c.name.padEnd(28);
    const pop  = c.populationFormatted.padEnd(8);
    const gap  = `${c.gapPct}%`.padEnd(8);
    console.log(`${rank}${name}${pop}${gap}${c.gapLabel}`);
  });
  console.log('─'.repeat(60));

  // Save results
  const dateStr = new Date().toISOString().split('T')[0];
  const slug    = stateName.toLowerCase().replace(/\s/g, '_');
  const outDir  = path.join(__dirname, 'results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

  const jsonPath = path.join(outDir, `${slug}_${dateStr}.json`);
  const txtPath  = path.join(outDir, `${slug}_${dateStr}.txt`);

  const output = {
    state: stateName,
    generatedAt: new Date().toISOString(),
    methodology: 'OSM public toilets, libraries, museums. Gap % = share of city area with no facility within 400m.',
    citiesScored: results.length,
    worst: ranked.slice(0, topN),
    best:  ranked.slice(-topN).reverse(),
    all:   ranked,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));
  fs.writeFileSync(txtPath, formatCaption(stateName, ranked, topN));

  console.log(`\n✅ Saved:`);
  console.log(`   ${jsonPath}`);
  console.log(`   ${txtPath}`);
  console.log('\n📋 Social caption preview:\n');
  console.log(formatCaption(stateName, ranked, topN));
  console.log();
}

main().catch(err => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
