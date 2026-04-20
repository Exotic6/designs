/**
 * Captures HTML slides as time-sequenced PNG frames using Playwright.
 * Each frame represents the animation state at a real-world timestamp.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DESIGNS_DIR = '/home/user/designs';
const SCREENSHOTS_DIR = '/home/user/designs/screenshots';
const PORT = 8765;

// Frame interval in ms — smaller = smoother animation, more slides
const FRAME_MS = 300;

// Slides in presentation order with their animation durations
const SLIDES = [
  { file: 'receipt-slide.html',       duration: 5400 },
  { file: 'GST Hub Diagram.html',     duration: 3800 },
  { file: 'GST Price Tags.html',      duration: 3800 },
  { file: 'GST BAS Dashboard.html',   duration: 3800 },
  { file: 'GST Ledger.html',          duration: 2400 },
  { file: 'GST P&L Comparison.html',  duration: 2200 },
  { file: 'GST Summary.html',         duration: 3500 },
];

// ── HTTP server ───────────────────────────────────────────────────────────────

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const filePath = path.normalize(path.join(DESIGNS_DIR, urlPath));
      if (!filePath.startsWith(DESIGNS_DIR)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        const mimes = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
        res.writeHead(200, { 'Content-Type': mimes[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(PORT, () => { console.log(`Server on :${PORT}`); resolve(server); });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeName(f) {
  return f.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

// ── Per-slide capture ─────────────────────────────────────────────────────────

async function captureSlide(browser, file, duration) {
  const name = safeName(file);
  const dir  = path.join(SCREENSHOTS_DIR, name);
  fs.mkdirSync(dir, { recursive: true });

  const url    = `http://localhost:${PORT}/${encodeURIComponent(file)}`;
  const frames = Math.ceil(duration / FRAME_MS) + 1;

  console.log(`  Capturing ${file} (${frames} frames × ${FRAME_MS}ms) …`);

  // ── Real-time animation capture ──────────────────────────────────────────
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(url, { waitUntil: 'networkidle' });

  const screenshots = [];
  let prevTime = 0;
  for (let i = 0; i <= frames; i++) {
    const targetTime = i * FRAME_MS;
    const wait = targetTime - prevTime;
    if (wait > 0) await page.waitForTimeout(wait);
    prevTime = targetTime;

    const imgPath = path.join(dir, `frame_${String(i).padStart(3, '0')}.png`);
    await page.screenshot({ path: imgPath, fullPage: false });
    screenshots.push({ index: i, time_ms: targetTime, path: imgPath });
  }
  await page.close();

  // ── Final-state capture (animation suppressed) ───────────────────────────
  const fp = await browser.newPage();
  await fp.setViewportSize({ width: 1920, height: 1080 });
  await fp.goto(url, { waitUntil: 'networkidle' });
  await fp.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0.001s !important;
        animation-delay:    0s    !important;
        transition-duration:0.001s !important;
        transition-delay:   0s    !important;
      }
    `,
  });
  // Trigger JS-driven sequences (replay buttons, counters etc.)
  await fp.evaluate(() => {
    if (typeof window.runSequence === 'function') window.runSequence();
    document.querySelectorAll('[data-replay]').forEach(el => el.click());
  });
  await fp.waitForTimeout(400);
  const finalPath = path.join(dir, 'final.png');
  await fp.screenshot({ path: finalPath, fullPage: false });
  await fp.close();

  // Append final as the last "frame" at duration + 1 frame
  screenshots.push({ index: frames + 1, time_ms: duration + FRAME_MS, path: finalPath, isFinal: true });

  return { name, dir, file, frames: screenshots };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ args: ['--disable-web-security'] });

  const manifest = { frameMs: FRAME_MS, slides: [] };

  for (const { file, duration } of SLIDES) {
    try {
      const result = await captureSlide(browser, file, duration);
      manifest.slides.push(result);
      console.log(`  ✓ ${file} — ${result.frames.length} frames captured\n`);
    } catch (err) {
      console.error(`  ✗ ${file}: ${err.message}\n`);
    }
  }

  await browser.close();
  server.close();

  fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('Manifest written → screenshots/manifest.json');
}

main().catch(err => { console.error(err); process.exit(1); });
