/**
 * Restroom Desert Report — Data Pipeline
 *
 * Single state:
 *   node pipeline.js --state "Virginia"
 *
 * Batch (multiple states at once):
 *   node pipeline.js --batch "Virginia,North Carolina,Tennessee,Georgia,South Carolina"
 *
 * Generate a full posting schedule (no scoring):
 *   node pipeline.js --schedule --start "2026-07-01" --cadence 3
 *
 * List available states:
 *   node pipeline.js --list-states
 *
 * Output per state:
 *   results/<state>_<date>.json   — full ranked data
 *   results/<state>_<date>.txt    — worst-5 social caption ready to post
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

// ── Format social media caption (worst-only Series 1) ────────────────────────
function formatCaption(state, ranked, topN) {
  const worst = ranked.slice(0, topN);
  const date  = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const stateTag = state.replace(/\s/g, '');
  const worstLines = worst.map((c, i) => `${i + 1}. ${c.name} — ${c.gapPct}% restroom desert`).join('\n');
  const worstCity  = worst[0]?.name.split(',')[0] || state;

  return `
🌵 RESTROOM DESERT REPORT — ${state.toUpperCase()}
📅 ${date}

Bottom 5 worst cities for public restrooms in ${state}:

${worstLines}

A Restroom Desert is any area where no public restroom exists within a 5-minute walk. These cities have the highest share of their land area with zero coverage.

Think we got it wrong? Add missing facilities at portadash.com/deserts — your corrections improve the next report.

${worstCity}, do you agree? Drop your experience below 👇

#RestroomDesert #PublicRestrooms #${stateTag} #PortaDash #CivicData #PublicHealth
`.trim();
}

// ── Generate posting schedule ─────────────────────────────────────────────────
function generateSchedule(startDateStr, postsPerWeek) {
  const POSTING_DAYS = {
    1: [1],         // 1x/week — Monday
    2: [1, 4],      // 2x/week — Mon, Thu
    3: [1, 3, 5],   // 3x/week — Mon, Wed, Fri
  }[postsPerWeek] || [1, 3, 5];

  const start = new Date(startDateStr);
  const schedule = [];
  let current = new Date(start);
  let stateIndex = 0;

  // Skip Virginia — already have it
  const states = STATE_NAMES.filter(s => s !== 'Virginia');

  while (stateIndex < states.length) {
    const dow = current.getDay(); // 0=Sun, 1=Mon...
    if (POSTING_DAYS.includes(dow)) {
      schedule.push({
        date: current.toISOString().split('T')[0],
        dayOfWeek: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow],
        state: states[stateIndex],
        series: 'Series 1 — Worst 5 Restroom Deserts',
      });
      stateIndex++;
    }
    current.setDate(current.getDate() + 1);
  }
  return schedule;
}

// ── Score and save a single state ─────────────────────────────────────────────
async function runState(stateName, topN) {
  const cities = CITIES_BY_STATE[stateName];
  if (!cities) {
    console.error(`\nState not found: "${stateName}". Run --list-states to see options.\n`);
    return false;
  }

  console.log(`\n🌵 ${stateName} — scoring ${cities.length} cities`);

  const results = [];
  for (let i = 0; i < cities.length; i++) {
    const result = await scoreCity(cities[i], i, cities.length);
    if (result) results.push(result);
  }

  if (results.length === 0) {
    console.error(`  No cities scored for ${stateName}.\n`);
    return false;
  }

  const ranked = results.sort((a, b) => b.gapPct - a.gapPct);

  // Print table
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`RESULTS — ${stateName} (${results.length} cities scored)`);
  console.log('─'.repeat(60));
  console.log(`${'Rank'.padEnd(6)}${'City'.padEnd(28)}${'Pop'.padEnd(8)}${'Gap %'.padEnd(8)}Label`);
  console.log('─'.repeat(60));
  ranked.forEach((c, i) => {
    console.log(`${String(i+1).padEnd(6)}${c.name.padEnd(28)}${c.populationFormatted.padEnd(8)}${`${c.gapPct}%`.padEnd(8)}${c.gapLabel}`);
  });
  console.log('─'.repeat(60));

  // Save files
  const dateStr = new Date().toISOString().split('T')[0];
  const slug    = stateName.toLowerCase().replace(/\s/g, '_');
  const outDir  = path.join(__dirname, 'results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

  const jsonPath = path.join(outDir, `${slug}_${dateStr}.json`);
  const txtPath  = path.join(outDir, `${slug}_${dateStr}.txt`);

  fs.writeFileSync(jsonPath, JSON.stringify({
    state: stateName,
    generatedAt: new Date().toISOString(),
    methodology: 'OSM public toilets, libraries, museums. Gap % = share of city area with no facility within 400m.',
    citiesScored: results.length,
    worst: ranked.slice(0, topN),
    all: ranked,
  }, null, 2));

  const caption = formatCaption(stateName, ranked, topN);
  fs.writeFileSync(txtPath, caption);

  console.log(`\n✅ Saved: ${jsonPath}`);
  console.log(`           ${txtPath}`);
  console.log('\n📋 Caption:\n');
  console.log(caption);
  console.log();
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const topN = parseInt(args[args.indexOf('--top') + 1]) || 5;

  // ── --list-states ──
  if (args.includes('--list-states')) {
    console.log('\nAvailable states:\n');
    STATE_NAMES.forEach(s => console.log(`  ${s} (${CITIES_BY_STATE[s].length} cities)`));
    console.log();
    return;
  }

  // ── --schedule ──
  if (args.includes('--schedule')) {
    const startIdx = args.indexOf('--start');
    const cadenceIdx = args.indexOf('--cadence');
    const startDate = startIdx !== -1 ? args[startIdx + 1] : new Date().toISOString().split('T')[0];
    const cadence   = cadenceIdx !== -1 ? parseInt(args[cadenceIdx + 1]) : 3;

    const schedule = generateSchedule(startDate, cadence);
    const outDir   = path.join(__dirname, 'results');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
    const schedulePath = path.join(outDir, 'posting_schedule.json');
    const csvPath      = path.join(outDir, 'posting_schedule.csv');

    fs.writeFileSync(schedulePath, JSON.stringify(schedule, null, 2));
    const csv = ['Date,Day,State,Series', ...schedule.map(r => `${r.date},${r.dayOfWeek},"${r.state}","${r.series}"`)].join('\n');
    fs.writeFileSync(csvPath, csv);

    console.log(`\n📅 Posting Schedule — ${cadence}x/week starting ${startDate}`);
    console.log(`   ${schedule.length} posts · completes ${schedule[schedule.length-1].date}\n`);
    console.log(`${'Date'.padEnd(14)}${'Day'.padEnd(6)}State`);
    console.log('─'.repeat(50));
    schedule.forEach(r => console.log(`${r.date.padEnd(14)}${r.dayOfWeek.padEnd(6)}${r.state}`));
    console.log(`\n✅ Saved: ${schedulePath}`);
    console.log(`           ${csvPath}\n`);
    return;
  }

  // ── --batch ──
  if (args.includes('--batch')) {
    const batchIdx = args.indexOf('--batch');
    if (!args[batchIdx + 1]) {
      console.error('\nProvide a comma-separated list of states: --batch "Virginia,North Carolina,Tennessee"\n');
      process.exit(1);
    }
    const states = args[batchIdx + 1].split(',').map(s => s.trim());
    console.log(`\n🌵 Restroom Desert Report — Batch run (${states.length} states)`);
    for (const state of states) {
      await runState(state, topN);
    }
    console.log(`\n✅ Batch complete. Results saved to pipeline/results/\n`);
    return;
  }

  // ── --state (single) ──
  const stateIdx = args.indexOf('--state');
  if (stateIdx !== -1 && args[stateIdx + 1]) {
    await runState(args[stateIdx + 1], topN);
    return;
  }

  // ── Help ──
  console.log(`
Usage:
  node pipeline.js --state "Virginia"
  node pipeline.js --batch "Virginia,North Carolina,Tennessee,Georgia,South Carolina"
  node pipeline.js --schedule --start "2026-07-01" --cadence 3
  node pipeline.js --list-states
  `);
}

main().catch(err => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
