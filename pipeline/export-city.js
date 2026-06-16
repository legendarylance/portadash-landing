/**
 * Restroom Desert Report — City Facility Exporter
 *
 * Fetches all facilities for a given city from OpenStreetMap (Overpass API)
 * and exports a CSV + GeoJSON for sharing with city officials.
 *
 * Usage:
 *   node export-city.js --city "Richmond, VA"
 *   node export-city.js --city "Richmond, VA" --output results/richmond_facilities
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REQUEST_HEADERS = {
  'User-Agent': 'PortaDash-RestroomDesertReport/1.0 (portadash.com)',
};

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Get city boundary from Nominatim
async function getCityBoundary(cityName) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cityName)}&format=json&limit=3&polygon_geojson=1`;
  const res = await fetch(url, { headers: REQUEST_HEADERS });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const results = await res.json();
  const withPoly = results.filter(r => r.geojson && ['Polygon','MultiPolygon'].includes(r.geojson.type));
  const r = withPoly[0] || results[0];
  if (!r) throw new Error(`City not found: ${cityName}`);
  return { bbox: r.boundingbox, geojson: r.geojson, displayName: r.display_name };
}

// Fetch all facilities with full tag data
async function fetchFacilities(bbox) {
  const [south, north, west, east] = [
    parseFloat(bbox[0]), parseFloat(bbox[1]),
    parseFloat(bbox[2]), parseFloat(bbox[3]),
  ];
  const bboxStr = `${south},${west},${north},${east}`;

  // Exclude portable/temporary toilets — we only want permanent public facilities
  const query = `[out:json][timeout:60];
(
  node["amenity"="toilets"]["portable"!="yes"]["temporary"!="yes"](${bboxStr});
  way["amenity"="toilets"]["portable"!="yes"]["temporary"!="yes"](${bboxStr});
  node["amenity"="library"](${bboxStr});
  way["amenity"="library"](${bboxStr});
  node["tourism"="museum"](${bboxStr});
  way["tourism"="museum"](${bboxStr});
);
out center tags;`;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: REQUEST_HEADERS,
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data?.elements) continue;
      return data.elements;
    } catch (_) { continue; }
  }
  throw new Error('All Overpass endpoints failed');
}

// Parse OSM element into a clean record
function parseElement(el) {
  const lat  = el.lat ?? el.center?.lat;
  const lon  = el.lon ?? el.center?.lon;
  if (!lat || !lon) return null;

  const tags = el.tags || {};
  const osmType = el.type === 'way' ? 'way' : 'node';
  const osmUrl  = `https://www.openstreetmap.org/${osmType}/${el.id}`;

  let type, category;
  if (tags.amenity === 'toilets') {
    type     = 'Public Restroom';
    category = 'restroom';
  } else if (tags.amenity === 'library') {
    // Exclude school libraries — not publicly accessible
    const name     = (tags.name || '').toLowerCase();
    const operator = (tags.operator || '').toLowerCase();
    const isSchool = ['school', 'middle', 'elementary', 'high school', 'academy']
      .some(w => name.includes(w) || operator.includes(w));
    if (isSchool) return null;
    type     = 'Library';
    category = 'library';
  } else if (tags.tourism === 'museum') {
    type     = 'Museum';
    category = 'museum';
  } else {
    return null;
  }

  // Ownership flags from OSM tags
  const operator   = tags.operator || tags['operator:wikidata'] || '';
  const access     = tags.access || (tags.amenity === 'toilets' ? 'yes' : '');
  const fee        = tags.fee || 'no';
  const opening    = tags.opening_hours || '';
  const wheelchair = tags.wheelchair || '';
  const portable   = tags.portable === 'yes' ? 'yes' : 'no';
  const temporary  = tags.temporary === 'yes' ? 'yes' : 'no';
  const name       = tags.name || tags['name:en'] || '';

  return {
    name,
    type,
    category,
    latitude:  lat,
    longitude: lon,
    operator,
    access,
    fee,
    opening_hours: opening,
    wheelchair,
    portable,
    temporary,
    osm_url: osmUrl,
    osm_id:  el.id,
  };
}

// Write CSV
function writeCSV(records, outPath) {
  const headers = [
    'Name', 'Type', 'Latitude', 'Longitude',
    'Operator/Owner', 'Access', 'Fee', 'Opening Hours',
    'Wheelchair', 'Portable', 'Temporary', 'OSM Source URL'
  ];
  const rows = records.map(r => [
    `"${r.name}"`,
    `"${r.type}"`,
    r.latitude,
    r.longitude,
    `"${r.operator}"`,
    `"${r.access}"`,
    `"${r.fee}"`,
    `"${r.opening_hours}"`,
    `"${r.wheelchair}"`,
    r.portable,
    r.temporary,
    `"${r.osm_url}"`,
  ].join(','));
  fs.writeFileSync(outPath, [headers.join(','), ...rows].join('\n'));
}

// Write GeoJSON
function writeGeoJSON(records, outPath) {
  const geojson = {
    type: 'FeatureCollection',
    features: records.map(r => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.longitude, r.latitude] },
      properties: {
        name:          r.name || `(unnamed ${r.type})`,
        type:          r.type,
        operator:      r.operator,
        access:        r.access,
        fee:           r.fee,
        opening_hours: r.opening_hours,
        wheelchair:    r.wheelchair,
        portable:      r.portable,
        temporary:     r.temporary,
        osm_url:       r.osm_url,
      },
    })),
  };
  fs.writeFileSync(outPath, JSON.stringify(geojson, null, 2));
}

// Main
async function main() {
  const args      = process.argv.slice(2);
  const cityIdx   = args.indexOf('--city');
  const outputIdx = args.indexOf('--output');

  if (cityIdx === -1 || !args[cityIdx + 1]) {
    console.log(`
Usage:
  node export-city.js --city "Richmond, VA"
  node export-city.js --city "Richmond, VA" --output results/richmond_facilities
`);
    process.exit(1);
  }

  const cityName  = args[cityIdx + 1];
  const outBase   = outputIdx !== -1
    ? args[outputIdx + 1]
    : path.join(__dirname, 'results', cityName.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_facilities');

  const outDir = path.dirname(outBase);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  console.log(`\n📍 Exporting facilities — ${cityName}`);

  process.stdout.write('  Getting city boundary ...');
  const boundary = await getCityBoundary(cityName);
  console.log(` ${boundary.displayName}`);

  await sleep(1200);

  process.stdout.write('  Fetching facilities from OpenStreetMap ...');
  const elements = await fetchFacilities(boundary.bbox);
  console.log(` ${elements.length} raw elements`);

  const records = elements.map(parseElement).filter(Boolean);

  // Summary
  const restrooms = records.filter(r => r.category === 'restroom');
  const libraries  = records.filter(r => r.category === 'library');
  const museums    = records.filter(r => r.category === 'museum');
  const portable   = restrooms.filter(r => r.portable === 'yes');
  const temporary  = restrooms.filter(r => r.temporary === 'yes');

  console.log(`\n  Summary:`);
  console.log(`    Public restrooms : ${restrooms.length} (${portable.length} portable, ${temporary.length} temporary)`);
  console.log(`    Libraries        : ${libraries.length}`);
  console.log(`    Museums          : ${museums.length}`);
  console.log(`    Total            : ${records.length}`);

  // Write outputs
  const csvPath     = outBase + '.csv';
  const geojsonPath = outBase + '.geojson';

  writeCSV(records, csvPath);
  writeGeoJSON(records, geojsonPath);

  console.log(`\n✅ Exported:`);
  console.log(`   CSV     : ${csvPath}`);
  console.log(`   GeoJSON : ${geojsonPath}`);
  console.log(`\n   Open the GeoJSON at geojson.io to preview on a map.`);
  console.log(`   Share the CSV with city officials for verification.\n`);
}

main().catch(err => {
  console.error('Export failed:', err.message);
  process.exit(1);
});
