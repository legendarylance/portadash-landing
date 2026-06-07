/**
 * Restroom Desert Report — Data Pipeline
 *
 * Single state:
 *   node pipeline.js --state "Virginia"
 *
 * With population-weighted gap (US Census ACS, recommended for press):
 *   node pipeline.js --state "Virginia" --census
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
 *
 * Environment:
 *   CENSUS_API_KEY — free key from api.census.gov (increases Census rate limits)
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
const CENSUS_DELAY     = 600;   // ms between Census API calls

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

// Facilities per 100k residents — counters land-area bias
// WHO recommends ~1 public toilet per 500 people = 200 per 100k
function per100kLabel(rate) {
  if (rate >= 150) return '✅ Well served';
  if (rate >= 75)  return '🟡 Adequate';
  if (rate >= 30)  return '🟠 Underserved';
  return '🔴 Severely underserved';
}

// ── Census state FIPS codes ───────────────────────────────────────────────────
const STATE_FIPS = {
  'Alabama': '01', 'Alaska': '02', 'Arizona': '04', 'Arkansas': '05',
  'California': '06', 'Colorado': '08', 'Connecticut': '09', 'Delaware': '10',
  'Florida': '12', 'Georgia': '13', 'Hawaii': '15', 'Idaho': '16',
  'Illinois': '17', 'Indiana': '18', 'Iowa': '19', 'Kansas': '20',
  'Kentucky': '21', 'Louisiana': '22', 'Maine': '23', 'Maryland': '24',
  'Massachusetts': '25', 'Michigan': '26', 'Minnesota': '27', 'Mississippi': '28',
  'Missouri': '29', 'Montana': '30', 'Nebraska': '31', 'Nevada': '32',
  'New Hampshire': '33', 'New Jersey': '34', 'New Mexico': '35', 'New York': '36',
  'North Carolina': '37', 'North Dakota': '38', 'Ohio': '39', 'Oklahoma': '40',
  'Oregon': '41', 'Pennsylvania': '42', 'Rhode Island': '44', 'South Carolina': '45',
  'South Dakota': '46', 'Tennessee': '47', 'Texas': '48', 'Utah': '49',
  'Vermont': '50', 'Virginia': '51', 'Washington': '53', 'West Virginia': '54',
  'Wisconsin': '55', 'Wyoming': '56',
};

// ── Cache — persist successful scores across runs ─────────────────────────────
const CACHE_PATH = path.join(__dirname, 'results', 'cache.json');

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch (_) { return {}; }
}

function saveCache(cache) {
  const outDir = path.join(__dirname, 'results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
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
async function getFacilities(bbox, attempt = 1) {
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

  // Retry once on total failure
  if (attempt < 2) {
    await sleep(5000);
    return getFacilities(bbox, attempt + 1);
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

// ── Census: population-weighted gap ──────────────────────────────────────────
//
// Approach: US Census ACS 5-year block group data (pop + internal point lat/lon)
// for each county that overlaps the city. Filter block group centroids to those
// inside the city boundary, then compute what share of the population lives in a
// "desert" cell (no facility within 400m of their block group centroid).
//
// More accurate than land-area gap because dense neighbourhoods count more than
// empty industrial zones.

// Census Geocoder: lat/lon → county FIPS (3-digit)
async function getCountyFips(lat, lon) {
  const url = `https://geocoding.geo.census.gov/geocoder/geographies/coordinates?x=${lon}&y=${lat}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`;
  try {
    const res = await fetch(url, { headers: REQUEST_HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    const counties = data?.result?.geographies?.Counties;
    if (!counties?.length) return null;
    return counties[0].COUNTY; // e.g. "760"
  } catch (_) {
    return null;
  }
}

// Census ACS 5-year: all block groups in a county with population + centroid
// Returns array of { lat, lon, pop }
async function getCensusBlockGroupData(stFips, coFips) {
  const key = process.env.CENSUS_API_KEY ? `&key=${process.env.CENSUS_API_KEY}` : '';
  const url = `https://api.census.gov/data/2023/acs/acs5?get=B01001_001E,INTPTLAT,INTPTLON&for=block+group:*&in=state:${stFips}+county:${coFips}${key}`;

  try {
    const res = await fetch(url, { headers: REQUEST_HEADERS });
    if (!res.ok) return [];
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length < 2) return [];

    return rows.slice(1)
      .map(row => ({
        pop: parseInt(row[0]) || 0,
        lat: parseFloat(row[1]),
        lon: parseFloat(row[2]),
      }))
      .filter(bg => bg.pop > 0 && !isNaN(bg.lat) && !isNaN(bg.lon));
  } catch (_) {
    return [];
  }
}

// Compute population-weighted gap % from Census block group centroids
function computePopWeightedGap(geojson, facilities, blockGroups) {
  const cityFeature = geojson
    ? { type: 'Feature', geometry: geojson, properties: {} }
    : null;

  let totalPop = 0;
  let desertPop = 0;

  for (const bg of blockGroups) {
    // Filter to block groups whose centroid is inside the city boundary
    if (cityFeature) {
      try {
        if (!turf.booleanPointInPolygon(turf.point([bg.lon, bg.lat]), cityFeature)) continue;
      } catch (_) {
        // Malformed polygon — include anyway
      }
    }

    totalPop += bg.pop;
    const covered = facilities.some(f => flatDist(bg.lat, bg.lon, f.lat, f.lon) <= DEAD_ZONE_RADIUS);
    if (!covered) desertPop += bg.pop;
  }

  return totalPop > 0 ? Math.round((desertPop / totalPop) * 100) : null;
}

// Enrich a result with population-weighted gap — fetches Census data for one city
async function enrichWithCensus(result, stFips) {
  if (!result._boundary || !result._facilities) return;

  const { bbox, geojson } = result._boundary;
  const lat = (parseFloat(bbox[0]) + parseFloat(bbox[1])) / 2;
  const lon = (parseFloat(bbox[2]) + parseFloat(bbox[3])) / 2;

  const coFips = await getCountyFips(lat, lon);
  if (!coFips) { result.popWeightedGapPct = null; return; }

  await sleep(CENSUS_DELAY);

  const blockGroups = await getCensusBlockGroupData(stFips, coFips);
  if (!blockGroups.length) { result.popWeightedGapPct = null; return; }

  result.popWeightedGapPct = computePopWeightedGap(geojson, result._facilities, blockGroups);
}

// ── Score a single city ───────────────────────────────────────────────────────
async function scoreCity(city, index, total, cache) {
  process.stdout.write(`  [${index + 1}/${total}] ${city.name} ... `);

  // Return cached result if available
  if (cache[city.name]) {
    const cached = cache[city.name];
    console.log(`${cached.gapPct}% gap · ${cached.facilitiesFound} facilities (cached)`);
    return cached;
  }

  try {
    await sleep(NOMINATIM_DELAY);
    const boundary = await getCityBoundary(city.name);
    if (!boundary) {
      console.log('skipped (not found)');
      return null;
    }

    await sleep(OVERPASS_DELAY);
    let facilities = await getFacilities(boundary.bbox);

    // Sanity check — 0 facilities for a city of 50k+ is almost certainly a
    // rate-limit false negative. Wait and retry once more.
    if (facilities.length === 0 && city.pop > 50000) {
      process.stdout.write('(0 facilities — retrying in 8s) ');
      await sleep(8000);
      facilities = await getFacilities(boundary.bbox);
    }

    const gapPct            = computeGapScore(boundary.bbox, boundary.geojson, facilities);
    const facilitiesPer100k = city.pop > 0 ? Math.round((facilities.length / city.pop) * 100000) : 0;
    const flagged = facilities.length === 0 ? ' ⚠️  flagged — verify manually' : '';
    console.log(`${gapPct}% gap · ${facilities.length} facilities · ${facilitiesPer100k}/100k${flagged}`);

    const result = {
      name:               city.name,
      population:         city.pop,
      populationFormatted: formatPop(city.pop),
      gapPct,
      gapLabel:           gapLabel(gapPct),
      facilitiesFound:    facilities.length,
      facilitiesPer100k,
      per100kLabel:       per100kLabel(facilitiesPer100k),
      restroomCount:      facilities.filter(f => f.type === 'restroom').length,
      libraryCount:       facilities.filter(f => f.type === 'library').length,
      museumCount:        facilities.filter(f => f.type === 'museum').length,
      // Internal fields — used for Census enrichment, stripped from public JSON
      _boundary:  { bbox: boundary.bbox, geojson: boundary.geojson },
      _facilities: facilities,
    };

    // Save to cache immediately so progress is never lost
    if (facilities.length > 0) {
      cache[city.name] = result;
      saveCache(cache);
    }

    return result;
  } catch (err) {
    console.log(`error: ${err.message}`);
    return null;
  }
}

// ── Strip internal cache fields before writing public JSON ────────────────────
function toPublicResult(r) {
  const { _boundary, _facilities, ...pub } = r;
  return pub;
}

// ── Format social media caption (worst-only Series 1) ────────────────────────
function formatCaption(state, ranked, topN) {
  const worst = ranked.slice(0, topN);
  const date  = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const stateTag = state.replace(/\s/g, '');
  const hasPopWeighted = worst.some(c => c.popWeightedGapPct != null);

  const worstLines = worst.map((c, i) => {
    const lines = [
      `${i + 1}. ${c.name}`,
      `   🌵 ${c.gapPct}% land desert · ${c.facilitiesPer100k} per 100k residents`,
    ];
    if (c.popWeightedGapPct != null) {
      lines.push(`   👥 ${c.popWeightedGapPct}% of residents in a desert zone`);
    }
    return lines.join('\n');
  }).join('\n');

  const worstCity = worst[0]?.name.split(',')[0] || state;

  const methodologyNote = hasPopWeighted
    ? `📊 Three metrics used to reduce bias:
• Desert % = share of city land with no facility within 400m
• Per 100k = facilities per 100,000 residents (WHO benchmark: 200)
• Residents % = share of population in a desert zone (US Census ACS data)`
    : `📊 Two metrics used to reduce bias:
• Desert % = share of city land with no facility within 400m
• Per 100k = facilities per 100,000 residents (WHO benchmark: 200)`;

  return `
🌵 RESTROOM DESERT REPORT — ${state.toUpperCase()}
📅 ${date}

Bottom 5 worst cities for public restrooms in ${state}:

${worstLines}

A Restroom Desert is any area where no public restroom exists within a 5-minute walk.

${methodologyNote}

Data: OpenStreetMap + community pins. Think we missed a facility? Add it → portadash.com/deserts

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
async function runState(stateName, topN, useCensus) {
  const cities = CITIES_BY_STATE[stateName];
  if (!cities) {
    console.error(`\nState not found: "${stateName}". Run --list-states to see options.\n`);
    return false;
  }

  const stFips = STATE_FIPS[stateName];
  if (useCensus && !stFips) {
    console.warn(`  ⚠️  No FIPS code found for ${stateName} — skipping Census enrichment`);
  }

  const cache = loadCache();
  const cached  = cities.filter(c => cache[c.name]).length;
  const toScore = cities.filter(c => !cache[c.name]).length;
  console.log(`\n🌵 ${stateName} — ${cities.length} cities (${cached} cached, ${toScore} to score)`);

  const results = [];
  for (let i = 0; i < cities.length; i++) {
    const result = await scoreCity(cities[i], i, cities.length, cache);
    if (result) results.push(result);
  }

  if (results.length === 0) {
    console.error(`  No cities scored for ${stateName}.\n`);
    return false;
  }

  const ranked = results.sort((a, b) => b.gapPct - a.gapPct);
  const worst  = ranked.slice(0, topN);

  // ── Census enrichment for worst-N cities ──────────────────────────────────
  if (useCensus && stFips) {
    console.log(`\n📊 Census enrichment — worst ${topN} cities (US ACS 5-year, 2023):`);
    for (const city of worst) {
      process.stdout.write(`  ${city.name.split(',')[0]} ...`);
      // Skip if already enriched in this session
      if (city.popWeightedGapPct !== undefined) {
        console.log(` ${city.popWeightedGapPct !== null ? `${city.popWeightedGapPct}%` : 'n/a'} (cached)`);
        continue;
      }
      try {
        await enrichWithCensus(city, stFips);
        console.log(` ${city.popWeightedGapPct !== null ? `${city.popWeightedGapPct}%` : 'n/a'}`);
        // Persist Census result back to cache
        if (cache[city.name]) {
          cache[city.name].popWeightedGapPct = city.popWeightedGapPct;
          saveCache(cache);
        }
      } catch (err) {
        city.popWeightedGapPct = null;
        console.log(` error: ${err.message}`);
      }
      await sleep(CENSUS_DELAY);
    }
  }

  // ── Print results table ───────────────────────────────────────────────────
  const hasPopWeighted = useCensus && worst.some(c => c.popWeightedGapPct != null);
  const LINE = '─'.repeat(hasPopWeighted ? 95 : 80);

  console.log(`\n${LINE}`);
  console.log(`RESULTS — ${stateName} (${results.length} cities scored)`);
  console.log(LINE);

  if (hasPopWeighted) {
    console.log(`${'Rank'.padEnd(6)}${'City'.padEnd(28)}${'Pop'.padEnd(8)}${'Gap %'.padEnd(8)}${'Per 100k'.padEnd(10)}${'Pop-Wtd %'.padEnd(11)}Access`);
  } else {
    console.log(`${'Rank'.padEnd(6)}${'City'.padEnd(28)}${'Pop'.padEnd(8)}${'Gap %'.padEnd(8)}${'Per 100k'.padEnd(10)}Access`);
  }
  console.log(LINE);

  ranked.forEach((c, i) => {
    const base = `${String(i+1).padEnd(6)}${c.name.padEnd(28)}${c.populationFormatted.padEnd(8)}` +
      `${`${c.gapPct}%`.padEnd(8)}${`${c.facilitiesPer100k}`.padEnd(10)}`;
    const popWtd = hasPopWeighted
      ? `${(c.popWeightedGapPct != null ? `${c.popWeightedGapPct}%` : 'n/a').padEnd(11)}`
      : '';
    console.log(base + popWtd + c.per100kLabel);
  });
  console.log(LINE);

  // ── Save files ────────────────────────────────────────────────────────────
  const dateStr = new Date().toISOString().split('T')[0];
  const slug    = stateName.toLowerCase().replace(/\s/g, '_');
  const outDir  = path.join(__dirname, 'results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

  const jsonPath = path.join(outDir, `${slug}_${dateStr}.json`);
  const txtPath  = path.join(outDir, `${slug}_${dateStr}.txt`);

  fs.writeFileSync(jsonPath, JSON.stringify({
    state: stateName,
    generatedAt: new Date().toISOString(),
    methodology: 'OSM public toilets, libraries, museums. Gap % = share of city area with no facility within 400m. Per 100k = facilities per 100,000 residents. Pop-Wtd % = share of population in a desert zone (US Census ACS 5-year block groups).',
    censusEnriched: useCensus && hasPopWeighted,
    citiesScored: results.length,
    worst: worst.map(toPublicResult),
    all:   ranked.map(toPublicResult),
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
  const topN      = parseInt(args[args.indexOf('--top') + 1]) || 5;
  const useCensus = args.includes('--census');

  if (useCensus && !process.env.CENSUS_API_KEY) {
    console.log('  ℹ️  CENSUS_API_KEY not set — using Census API without a key (rate-limited).');
    console.log('      Get a free key at https://api.census.gov/data/key_signup.html\n');
  }

  // ── --list-states ──
  if (args.includes('--list-states')) {
    console.log('\nAvailable states:\n');
    STATE_NAMES.forEach(s => console.log(`  ${s} (${CITIES_BY_STATE[s].length} cities)`));
    console.log();
    return;
  }

  // ── --schedule ──
  if (args.includes('--schedule')) {
    const startIdx   = args.indexOf('--start');
    const cadenceIdx = args.indexOf('--cadence');
    const startDate  = startIdx   !== -1 ? args[startIdx + 1]            : new Date().toISOString().split('T')[0];
    const cadence    = cadenceIdx !== -1 ? parseInt(args[cadenceIdx + 1]) : 3;

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
    console.log(`\n🌵 Restroom Desert Report — Batch run (${states.length} states)${useCensus ? ' + Census' : ''}`);
    for (const state of states) {
      await runState(state, topN, useCensus);
    }
    console.log(`\n✅ Batch complete. Results saved to pipeline/results/\n`);
    return;
  }

  // ── --state (single) ──
  const stateIdx = args.indexOf('--state');
  if (stateIdx !== -1 && args[stateIdx + 1]) {
    await runState(args[stateIdx + 1], topN, useCensus);
    return;
  }

  // ── Help ──
  console.log(`
Usage:
  node pipeline.js --state "Virginia"
  node pipeline.js --state "Virginia" --census
  node pipeline.js --batch "Virginia,North Carolina,Tennessee,Georgia,South Carolina"
  node pipeline.js --batch "Virginia,North Carolina" --census
  node pipeline.js --schedule --start "2026-07-01" --cadence 3
  node pipeline.js --list-states

Options:
  --census    Compute population-weighted gap % using US Census ACS 5-year
              block group data (enriches the worst-N cities only).
              Set CENSUS_API_KEY env var for higher rate limits.
  --top N     Show worst N cities (default: 5)
  `);
}

main().catch(err => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
