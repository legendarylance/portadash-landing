/**
 * Restroom Desert Report — Video Generator
 *
 * Generates a 1080x1920 TikTok/Reels video from pipeline JSON results.
 *
 * Usage:
 *   node make-video.js --input results/virginia_2026-06-05.json
 */

import { createCanvas, registerFont } from 'canvas';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Video config ──────────────────────────────────────────────────────────────
const W        = 1080;
const H        = 1920;
const FPS      = 30;
const FRAMES_DIR = path.join(__dirname, 'tmp_frames');

// ── Colors ────────────────────────────────────────────────────────────────────
const BG_TOP    = '#0D1B2A';   // deep navy
const BG_BOT    = '#1A3A2A';   // deep forest green
const ACCENT    = '#F5A623';   // amber/desert gold
const WHITE     = '#FFFFFF';
const DIM       = 'rgba(255,255,255,0.5)';
const RED       = '#FF4444';
const ORANGE    = '#FF8C00';
const CARD_BG   = 'rgba(255,255,255,0.07)';
const CARD_BORDER = 'rgba(255,255,255,0.12)';

// ── Draw helpers ──────────────────────────────────────────────────────────────
function drawBackground(ctx) {
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, BG_TOP);
  grad.addColorStop(1, BG_BOT);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Subtle grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 80) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 0; y < H; y += 80) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
}

function drawCactusEmoji(ctx, x, y, size) {
  ctx.font = `${size}px serif`;
  ctx.textAlign = 'center';
  ctx.fillText('🌵', x, y);
}

function drawText(ctx, text, x, y, { font, color, align = 'center', maxWidth } = {}) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  if (maxWidth) ctx.fillText(text, x, y, maxWidth);
  else ctx.fillText(text, x, y);
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
  if (fillStyle)  { ctx.fillStyle = fillStyle; ctx.fill(); }
  if (strokeStyle){ ctx.strokeStyle = strokeStyle; ctx.lineWidth = 1.5; ctx.stroke(); }
}

function gapColor(pct) {
  if (pct >= 90) return RED;
  if (pct >= 70) return ORANGE;
  return ACCENT;
}

// ── Frame builders ────────────────────────────────────────────────────────────

// Frame 0-29: Hook — "Did you know?"
function buildHookFrames(state, worstCity, worstPct) {
  const frames = [];
  for (let f = 0; f < 60; f++) {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const t = f / 60; // 0→1 progress
    drawBackground(ctx);

    const opacity = Math.min(1, t * 3);
    ctx.globalAlpha = opacity;

    drawCactusEmoji(ctx, W/2, 420, 140);

    drawText(ctx, 'Did you know?', W/2, 600, {
      font: 'bold 72px sans-serif', color: ACCENT,
    });

    if (t > 0.3) {
      const o2 = Math.min(1, (t - 0.3) * 3);
      ctx.globalAlpha = o2;
      drawText(ctx, `${worstPct}% of ${worstCity}`, W/2, 780, {
        font: 'bold 68px sans-serif', color: WHITE,
      });
      drawText(ctx, 'has NO public restroom', W/2, 880, {
        font: '52px sans-serif', color: WHITE,
      });
      drawText(ctx, 'within a 5-minute walk', W/2, 960, {
        font: '52px sans-serif', color: WHITE,
      });
    }

    ctx.globalAlpha = 1;
    frames.push(canvas.toBuffer('image/png'));
  }
  return frames;
}

// Frame 60-119: Title card
function buildTitleFrames(state) {
  const frames = [];
  for (let f = 0; f < 60; f++) {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const t = f / 60;
    drawBackground(ctx);

    ctx.globalAlpha = Math.min(1, t * 2);

    drawText(ctx, '🌵 RESTROOM DESERT REPORT', W/2, 500, {
      font: 'bold 48px sans-serif', color: ACCENT,
    });

    // State name — big
    const stateSize = state.length > 12 ? 100 : 130;
    drawText(ctx, state.toUpperCase(), W/2, 680, {
      font: `bold ${stateSize}px sans-serif`, color: WHITE,
    });

    drawText(ctx, 'Bottom 5 Worst Cities', W/2, 820, {
      font: '54px sans-serif', color: DIM,
    });
    drawText(ctx, 'for Public Restrooms', W/2, 900, {
      font: '54px sans-serif', color: DIM,
    });

    ctx.globalAlpha = 1;
    frames.push(canvas.toBuffer('image/png'));
  }
  return frames;
}

// Frame 120+: City reveal — each city animates in one by one
function buildCityFrames(worst) {
  const FRAMES_PER_CITY = 40;
  const frames = [];

  for (let cityIdx = 0; cityIdx <= worst.length; cityIdx++) {
    const citiesShown = cityIdx;
    const animFrames  = cityIdx < worst.length ? FRAMES_PER_CITY : 60; // hold last frame longer

    for (let f = 0; f < animFrames; f++) {
      const canvas = createCanvas(W, H);
      const ctx = canvas.getContext('2d');
      drawBackground(ctx);

      // Header
      drawText(ctx, '🌵 RESTROOM DESERT REPORT', W/2, 120, {
        font: 'bold 38px sans-serif', color: ACCENT,
      });
      drawText(ctx, worst[0]?.name.split(',')[1]?.trim() || '', W/2, 190, {
        font: 'bold 64px sans-serif', color: WHITE,
      });

      // City cards
      const cardH   = 190;
      const cardGap = 24;
      const cardX   = 60;
      const cardW   = W - 120;
      const startY  = 280;

      for (let i = 0; i < worst.length; i++) {
        const city = worst[i];
        const y    = startY + i * (cardH + cardGap);
        const isNew = i === citiesShown - 1;
        const shown = i < citiesShown;
        const progress = isNew ? Math.min(1, (f / FRAMES_PER_CITY) * 2) : 1;

        if (!shown && !isNew) continue;

        ctx.globalAlpha = shown ? 1 : progress;

        // Card background
        drawRoundRect(ctx, cardX, y, cardW, cardH, 20, CARD_BG, CARD_BORDER);

        // Rank badge
        const badgeColor = gapColor(city.gapPct);
        drawRoundRect(ctx, cardX + 24, y + 24, 80, 80, 12, badgeColor, null);
        drawText(ctx, String(i + 1), cardX + 64, y + 82, {
          font: 'bold 52px sans-serif', color: WHITE, align: 'center',
        });

        // City name
        const cityShort = city.name.split(',')[0];
        drawText(ctx, cityShort, cardX + 130, y + 72, {
          font: 'bold 52px sans-serif', color: WHITE, align: 'left',
        });

        // Gap bar background
        const barX = cardX + 130;
        const barY = y + 110;
        const barW = cardW - 200;
        const barH2 = 18;
        drawRoundRect(ctx, barX, barY, barW, barH2, 9, 'rgba(255,255,255,0.1)', null);

        // Gap bar fill — animate width
        const fillW = (city.gapPct / 100) * barW * (isNew ? progress : 1);
        if (fillW > 0) {
          const barGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
          barGrad.addColorStop(0, ACCENT);
          barGrad.addColorStop(1, RED);
          drawRoundRect(ctx, barX, barY, fillW, barH2, 9, barGrad, null);
        }

        // Gap % label
        const pctShown = isNew ? Math.round(city.gapPct * progress) : city.gapPct;
        drawText(ctx, `${pctShown}%`, cardX + cardW - 30, y + 82, {
          font: `bold 52px sans-serif`, color: gapColor(city.gapPct), align: 'right',
        });

        ctx.globalAlpha = 1;
      }

      // Footer
      const footerY = H - 180;
      drawText(ctx, '% = city area with no restroom within 400m', W/2, footerY, {
        font: '34px sans-serif', color: 'rgba(255,255,255,0.4)',
      });
      drawText(ctx, 'Add missing facilities → portadash.com/deserts', W/2, footerY + 60, {
        font: '34px sans-serif', color: ACCENT,
      });
      drawText(ctx, 'portadash.com', W/2, footerY + 120, {
        font: 'bold 38px sans-serif', color: WHITE,
      });

      frames.push(canvas.toBuffer('image/png'));
    }
  }
  return frames;
}

// ── Write frames to disk ──────────────────────────────────────────────────────
function writeFrames(allFrames) {
  if (fs.existsSync(FRAMES_DIR)) fs.rmSync(FRAMES_DIR, { recursive: true });
  fs.mkdirSync(FRAMES_DIR);
  allFrames.forEach((buf, i) => {
    const padded = String(i).padStart(5, '0');
    fs.writeFileSync(path.join(FRAMES_DIR, `frame_${padded}.png`), buf);
  });
}

// ── Assemble video with ffmpeg ────────────────────────────────────────────────
function assembleVideo(outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(path.join(FRAMES_DIR, 'frame_%05d.png'))
      .inputFPS(FPS)
      .videoCodec('libx264')
      .outputOptions([
        '-pix_fmt yuv420p',
        '-preset fast',
        '-crf 20',
        '-movflags +faststart',
      ])
      .size(`${W}x${H}`)
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const inputIdx = args.indexOf('--input');

  if (inputIdx === -1 || !args[inputIdx + 1]) {
    console.log('\nUsage: node make-video.js --input results/virginia_2026-06-05.json\n');
    process.exit(1);
  }

  const inputPath = args[inputIdx + 1];
  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const data  = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const state = data.state;
  const worst = data.worst;

  if (!worst || worst.length === 0) {
    console.error('No worst cities found in data file.');
    process.exit(1);
  }

  console.log(`\n🎬 Generating video — Restroom Desert Report: ${state}`);
  console.log(`   Cities: ${worst.map(c => c.name.split(',')[0]).join(', ')}\n`);

  process.stdout.write('  Building frames ...');
  const hookFrames  = buildHookFrames(state, worst[0].name.split(',')[0], worst[0].gapPct);
  const titleFrames = buildTitleFrames(state);
  const cityFrames  = buildCityFrames(worst);
  const allFrames   = [...hookFrames, ...titleFrames, ...cityFrames];
  console.log(` ${allFrames.length} frames (${(allFrames.length / FPS).toFixed(1)}s)`);

  process.stdout.write('  Writing frames to disk ...');
  writeFrames(allFrames);
  console.log(' done');

  const slug      = state.toLowerCase().replace(/\s/g, '_');
  const dateStr   = new Date().toISOString().split('T')[0];
  const outDir    = path.join(__dirname, 'results');
  const videoPath = path.join(outDir, `${slug}_${dateStr}.mp4`);

  process.stdout.write('  Encoding video ...');
  await assembleVideo(videoPath);
  console.log(' done');

  // Cleanup frames
  fs.rmSync(FRAMES_DIR, { recursive: true });

  console.log(`\n✅ Video saved: ${videoPath}`);
  console.log(`   Duration: ${(allFrames.length / FPS).toFixed(1)}s`);
  console.log(`   Size: ${(fs.statSync(videoPath).size / 1024 / 1024).toFixed(1)} MB\n`);
}

main().catch(err => {
  console.error('Video generation failed:', err.message);
  process.exit(1);
});
