/**
 * Restroom Desert Report — Carousel Generator
 *
 * Generates a 4-slide Instagram carousel (1080×1080 PNG per slide).
 * Slide 1: The scenario — universal physical moment, second person
 * Slide 2: City name + gap % reveal — dry, one-liner
 * Slide 3: Rankings — all 5 worst cities
 * Slide 4: CTA — "Find a bathroom before it finds you."
 *
 * Usage:
 *   node make-carousel.js --input results/virginia_2026-06-07.json
 *   node make-carousel.js --input results/virginia_2026-06-07.json --city-index 1
 */

import { createCanvas } from 'canvas';
import { createHash }   from 'crypto';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Canvas constants ──────────────────────────────────────────────────────────
const W = 1080;
const H = 1080;

// ── Colors ────────────────────────────────────────────────────────────────────
const BG_TOP      = '#0D1B2A';
const BG_BOT      = '#1A3A2A';
const ACCENT      = '#F5A623';
const WHITE       = '#FFFFFF';
const DIM         = 'rgba(255,255,255,0.5)';
const RED         = '#FF4444';
const ORANGE      = '#FF8C00';
const CARD_BG     = 'rgba(255,255,255,0.07)';
const CARD_BORDER = 'rgba(255,255,255,0.12)';

// ── Scenario templates ────────────────────────────────────────────────────────
// Selected deterministically by city name hash so same city = same scenario.
// All second-person. All physical. All end on the data as punchline.
const SCENARIOS = [
  // 0 — morning run
  `You're 3 miles into your morning run.\n\nThe coffee kicked in at mile 2.\n\nThere is no bathroom.`,

  // 1 — road trip
  `You said you didn't need to stop.\n\nThat was 45 minutes ago.\n\nYou were wrong.`,

  // 2 — toddler
  `Your toddler just said the words.\n\nYou know the ones.\n\n"I need to go NOW."`,

  // 3 — first date
  `You're on a first date.\nEverything is going well.\n\nAnd then it isn't.`,

  // 4 — festival
  `You paid $180 for this festival ticket.\n\nThe porta-potty line is 40 people long.\n\nOne of them is not going to make it.`,

  // 5 — dog walk
  `You took the dog for a quick walk.\n\nThe dog is fine.\n\nYou are not fine.`,

  // 6 — hiking
  `Beautiful trail.\nGreat views.\n\nNo bathroom for the next 4 miles.\n\nYou should have checked PortaDash.`,

  // 7 — commute
  `The train is delayed.\n\nThe station bathroom is locked.\n\nThe next stop is 22 minutes away.\n\nThis is fine.`,
];

// Dry one-liners for slide 2 — paired with each scenario
const ONELINERS = [
  'Someone approved this.',
  'The math is not great.',
  'Someone built a parking lot here instead.',
  "The data doesn't care about your plans.",
  'Nobody put this on the agenda.',
  'This happens every single day.',
  'Nature called. The city did not pick up.',
  'Someone did this math and kept going.',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function selectScenario(cityName) {
  const hash = createHash('md5').update(cityName).digest('hex');
  return parseInt(hash.slice(0, 4), 16) % SCENARIOS.length;
}

function cityShort(fullName) {
  return fullName
    .split(',')[0]
    .replace(/\s+(city|town|cdp|village|borough|municipality)$/i, '')
    .trim();
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fitFontSize(ctx, text, maxWidth, maxSize, minSize) {
  for (let size = maxSize; size >= minSize; size -= 4) {
    ctx.font = `bold ${size}px sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) return size;
  }
  return minSize;
}

// ── Shared draw primitives ────────────────────────────────────────────────────
function drawBackground(ctx) {
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, BG_TOP);
  grad.addColorStop(1, BG_BOT);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(255,255,255,0.025)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 80) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 0; y < H; y += 80) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
}

function drawHeader(ctx) {
  ctx.save();
  ctx.font      = 'bold 18px sans-serif';
  ctx.fillStyle = ACCENT;
  ctx.textAlign = 'center';
  ctx.fillText('🌵 RESTROOM DESERT REPORT', W / 2, 56);
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(60, 70); ctx.lineTo(W - 60, 70);
  ctx.stroke();
  ctx.restore();
}

function drawDotIndicator(ctx, activeIndex) {
  const R = 5, SPACING = 22;
  const startX = W / 2 - 1.5 * SPACING;
  const y = H - 36;
  ctx.save();
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.arc(startX + i * SPACING, y, i === activeIndex ? R : R - 2, 0, Math.PI * 2);
    ctx.fillStyle = i === activeIndex ? WHITE : 'rgba(255,255,255,0.3)';
    ctx.fill();
  }
  ctx.restore();
}

function drawRoundRect(ctx, x, y, w, h, r, fillStyle, strokeStyle) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  if (fillStyle)   { ctx.fillStyle = fillStyle; ctx.fill(); }
  if (strokeStyle) { ctx.strokeStyle = strokeStyle; ctx.lineWidth = 1.5; ctx.stroke(); }
}

// ── Slide 1 — Scenario ────────────────────────────────────────────────────────
function drawSlide1(ctx, scenarioText, cityLabel) {
  ctx.save();
  drawBackground(ctx);
  drawHeader(ctx);

  // City label
  ctx.font      = '19px sans-serif';
  ctx.fillStyle = DIM;
  ctx.textAlign = 'center';
  ctx.fillText(cityLabel.toUpperCase(), W / 2, 104);

  // Scenario text — left aligned, large, paragraph-aware
  const FONT_SIZE = 52;
  const LINE_H    = FONT_SIZE * 1.5;
  const PARA_GAP  = 36;
  const MAX_W     = W - 160;
  const TEXT_X    = 80;

  ctx.font      = `${FONT_SIZE}px sans-serif`;
  ctx.fillStyle = WHITE;
  ctx.textAlign = 'left';

  const paragraphs = scenarioText.split('\n\n');
  const allLines   = paragraphs.map(p => {
    // Preserve explicit \n within a paragraph
    return p.split('\n').flatMap(line => wrapText(ctx, line, MAX_W));
  });

  // Anchor text near the top of the zone — not centred
  const ZONE_T = 148;
  let y = ZONE_T + LINE_H;

  for (const lines of allLines) {
    for (const line of lines) {
      ctx.fillText(line, TEXT_X, y);
      y += LINE_H;
    }
    y += PARA_GAP;
  }

  // Swipe affordance
  ctx.font      = '19px sans-serif';
  ctx.fillStyle = DIM;
  ctx.textAlign = 'center';
  ctx.fillText('Swipe →', W / 2, H - 58);

  drawDotIndicator(ctx, 0);
  ctx.restore();
}

// ── Slide 2 — Reveal ──────────────────────────────────────────────────────────
function drawSlide2(ctx, oneLiner, cityData) {
  const short = cityShort(cityData.name);
  const state = cityData.name.split(',')[1]?.trim() || '';

  ctx.save();
  drawBackground(ctx);
  drawHeader(ctx);

  // One-liner — italic, dim, centered
  ctx.save();
  ctx.font      = 'italic 22px sans-serif';
  ctx.fillStyle = DIM;
  ctx.textAlign = 'center';
  const wrappedOneLiner = wrapText(ctx, oneLiner, W - 180);
  let oly = 116;
  for (const line of wrappedOneLiner) {
    ctx.fillText(line, W / 2, oly);
    oly += 34;
  }
  ctx.restore();

  // Accent rule
  const rule1Y = oly + 20;
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth   = 2;
  ctx.beginPath(); ctx.moveTo(60, rule1Y); ctx.lineTo(W - 60, rule1Y); ctx.stroke();

  // City name — hero
  const nameSize = fitFontSize(ctx, short.toUpperCase(), W - 120, 110, 56);
  ctx.font        = `bold ${nameSize}px sans-serif`;
  ctx.fillStyle   = WHITE;
  ctx.textAlign   = 'center';
  const cityY     = rule1Y + nameSize + 28;
  ctx.fillText(short.toUpperCase(), W / 2, cityY);

  if (state) {
    ctx.font      = '19px sans-serif';
    ctx.fillStyle = DIM;
    ctx.fillText(state, W / 2, cityY + 32);
  }

  // Second rule
  const rule2Y = cityY + 66;
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth   = 2;
  ctx.beginPath(); ctx.moveTo(60, rule2Y); ctx.lineTo(W - 60, rule2Y); ctx.stroke();

  // Gap % — big, amber
  const gapText  = `${cityData.gapPct}%`;
  const gapSize  = fitFontSize(ctx, gapText, 480, 130, 80);
  ctx.font        = `bold ${gapSize}px sans-serif`;
  ctx.fillStyle   = ACCENT;
  ctx.textAlign   = 'center';
  const gapY      = rule2Y + gapSize + 22;
  ctx.fillText(gapText, W / 2, gapY);

  ctx.font      = 'bold 20px sans-serif';
  ctx.fillStyle = DIM;
  ctx.fillText('RESTROOM DESERT', W / 2, gapY + 36);

  // Per 100k — smaller, secondary
  ctx.font      = '22px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillText(`${cityData.facilitiesPer100k} public facilities per 100,000 residents`, W / 2, gapY + 82);
  ctx.font      = '16px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillText('WHO benchmark: 200', W / 2, gapY + 110);

  // Swipe
  ctx.font      = '19px sans-serif';
  ctx.fillStyle = DIM;
  ctx.fillText('See all 5 →', W / 2, H - 58);

  drawDotIndicator(ctx, 1);
  ctx.restore();
}

// ── Slide 3 — Rankings ────────────────────────────────────────────────────────
function drawSlide3(ctx, worst, stateName) {
  ctx.save();
  drawBackground(ctx);
  drawHeader(ctx);

  ctx.font      = 'bold 24px sans-serif';
  ctx.fillStyle = ACCENT;
  ctx.textAlign = 'center';
  ctx.fillText(`${stateName.toUpperCase()}'S RESTROOM DESERTS`, W / 2, 108);

  ctx.font      = '16px sans-serif';
  ctx.fillStyle = DIM;
  ctx.fillText('Worst 5 cities · % of land with no public facility within 400m', W / 2, 132);

  const maxGapPct   = Math.max(...worst.map(c => c.gapPct));
  const CARD_H      = 146;
  const CARD_GAP    = 8;
  const CARD_X      = 55;
  const CARD_W      = W - 110;
  const START_Y     = 150;
  const badgeColors = [ACCENT, RED, ORANGE, 'rgba(255,255,255,0.25)', 'rgba(255,255,255,0.18)'];
  const badgeTxtCol = ['#0D1B2A', WHITE, WHITE, WHITE, WHITE];

  worst.forEach((city, i) => {
    const y     = START_Y + i * (CARD_H + CARD_GAP);
    const isTop = i === 0;

    drawRoundRect(
      ctx, CARD_X, y, CARD_W, CARD_H, 14,
      isTop ? 'rgba(245,166,35,0.12)' : CARD_BG,
      isTop ? ACCENT : CARD_BORDER
    );

    // Rank badge
    const bx = CARD_X + 18;
    const by = y + (CARD_H / 2) - 28;
    drawRoundRect(ctx, bx, by, 58, 58, 10, badgeColors[i], null);
    ctx.font      = 'bold 26px sans-serif';
    ctx.fillStyle = badgeTxtCol[i];
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), bx + 29, by + 38);

    // City name
    const short = cityShort(city.name);
    ctx.font      = 'bold 24px sans-serif';
    ctx.fillStyle = WHITE;
    ctx.textAlign = 'left';
    ctx.fillText(short, CARD_X + 92, y + 36);

    // Gap %
    ctx.font      = '18px sans-serif';
    ctx.fillStyle = ACCENT;
    ctx.fillText(`${city.gapPct}% desert`, CARD_X + 92, y + 62);

    // Per 100k
    ctx.font      = '14px sans-serif';
    ctx.fillStyle = DIM;
    ctx.fillText(`${city.facilitiesPer100k} per 100k residents`, CARD_X + 92, y + 84);

    // Bar track
    const barX = CARD_X + 92;
    const barY = y + 104;
    const barW = CARD_W - 188;
    drawRoundRect(ctx, barX, barY, barW, 10, 5, 'rgba(255,255,255,0.1)', null);

    // Bar fill
    const fillW = (city.gapPct / maxGapPct) * barW;
    if (fillW > 0) {
      const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
      grad.addColorStop(0, ACCENT);
      grad.addColorStop(1, RED);
      drawRoundRect(ctx, barX, barY, fillW, 10, 5, grad, null);
    }

    // % label right of bar
    ctx.font      = 'bold 14px sans-serif';
    ctx.fillStyle = DIM;
    ctx.textAlign = 'right';
    ctx.fillText(`${city.gapPct}%`, CARD_X + CARD_W - 8, barY + 10);
  });

  ctx.font      = '13px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.textAlign = 'center';
  ctx.fillText('Data: OpenStreetMap + community pins · portadash.com', W / 2, H - 58);

  drawDotIndicator(ctx, 2);
  ctx.restore();
}

// ── Slide 4 — CTA ─────────────────────────────────────────────────────────────
function drawSlide4(ctx, stateName) {
  const stateTag = stateName.replace(/\s/g, '');
  const date     = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  ctx.save();
  drawBackground(ctx);
  drawHeader(ctx);

  // Main line — the brand voice
  ctx.font      = 'bold 52px sans-serif';
  ctx.fillStyle = WHITE;
  ctx.textAlign = 'center';
  ctx.fillText('Find a bathroom', W / 2, 300);

  ctx.font      = 'bold 52px sans-serif';
  ctx.fillStyle = ACCENT;
  ctx.fillText('before it finds you.', W / 2, 370);

  // Subline
  ctx.font      = '22px sans-serif';
  ctx.fillStyle = DIM;
  ctx.fillText('Add missing facilities. Help your city.', W / 2, 436);

  // URL card — white fill, dark text for contrast
  drawRoundRect(ctx, 120, 476, W - 240, 98, 16, WHITE, null);
  ctx.font      = 'bold 30px sans-serif';
  ctx.fillStyle = BG_TOP;
  ctx.textAlign = 'center';
  ctx.fillText('portadash.com/deserts  →', W / 2, 536);

  // Separator
  ctx.font      = '18px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillText('· · ·', W / 2, 626);

  // Hashtags
  ctx.font      = '19px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.38)';
  ctx.fillText('#RestroomDesert  #PublicHealth', W / 2, 680);
  ctx.fillText(`#${stateTag}  #CivicData`, W / 2, 714);
  ctx.fillText('#PortaDash', W / 2, 748);

  // Date note
  ctx.font      = '13px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fillText(`Data: OSM + manual verification · ${date}`, W / 2, 830);

  // Wordmark
  ctx.font      = 'bold 30px sans-serif';
  ctx.fillStyle = ACCENT;
  ctx.fillText('PortaDash', W / 2, 908);

  ctx.font      = '15px sans-serif';
  ctx.fillStyle = DIM;
  ctx.fillText('Find. Rate. Advocate.', W / 2, 936);

  drawDotIndicator(ctx, 3);
  ctx.restore();
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
async function generateCarousel(inputPath, { cityIndex = 0 } = {}) {
  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const data  = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const state = data.state;
  const worst = data.worst;

  if (!worst?.length) {
    console.error('No worst cities found in data file.');
    process.exit(1);
  }

  const city        = worst[Math.min(cityIndex, worst.length - 1)];
  const scenarioIdx = selectScenario(city.name);
  const scenario    = SCENARIOS[scenarioIdx];
  const oneLiner    = ONELINERS[scenarioIdx];
  const short       = cityShort(city.name);

  console.log(`\n🎨 Generating carousel — ${state} (featuring ${short})`);
  console.log(`   Scenario : #${scenarioIdx} — "${scenario.split('\n')[0]}"`);
  console.log(`   City slot: #${cityIndex + 1} of ${worst.length} worst\n`);

  const basePath = inputPath.replace(/\.json$/, '');
  const cityLabel = `${short} · ${state}`;

  const slideBuilders = [
    () => { const c = createCanvas(W, H); drawSlide1(c.getContext('2d'), scenario, cityLabel);      return c; },
    () => { const c = createCanvas(W, H); drawSlide2(c.getContext('2d'), oneLiner, city);           return c; },
    () => { const c = createCanvas(W, H); drawSlide3(c.getContext('2d'), worst, state);             return c; },
    () => { const c = createCanvas(W, H); drawSlide4(c.getContext('2d'), state);                    return c; },
  ];

  for (let i = 0; i < slideBuilders.length; i++) {
    process.stdout.write(`  Slide ${i + 1} ...`);
    const canvas  = slideBuilders[i]();
    const outPath = `${basePath}_carousel_${i + 1}.png`;
    fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
    console.log(` saved → ${path.basename(outPath)}`);
  }

  console.log(`\n✅ Carousel saved:`);
  for (let i = 1; i <= 4; i++) console.log(`   ${basePath}_carousel_${i}.png`);
  console.log();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args       = process.argv.slice(2);
  const inputIdx   = args.indexOf('--input');
  const cityIdxArg = args.indexOf('--city-index');

  if (inputIdx === -1 || !args[inputIdx + 1]) {
    console.log(`
Usage:
  node make-carousel.js --input results/virginia_2026-06-07.json

Options:
  --city-index N    Feature city #N from worst list, 0-based (default: 0 = worst)
`);
    process.exit(1);
  }

  await generateCarousel(args[inputIdx + 1], {
    cityIndex: cityIdxArg !== -1 ? parseInt(args[cityIdxArg + 1]) : 0,
  });
}

main().catch(err => {
  console.error('Carousel generation failed:', err.message);
  process.exit(1);
});
