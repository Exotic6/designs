/**
 * Records each HTML slide as a WebM video using Playwright's native video
 * recording at 1920×1080. Each slide plays its full CSS animation then holds
 * for a few seconds so viewers can read the final state.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DESIGNS_DIR = '/home/user/designs';
const VIDEOS_DIR  = '/home/user/designs/videos';
const PORT = 8766;

// Slides in presentation order
// duration = animation play time (ms), hold = pause on final state (ms)
const SLIDES = [
  { file: 'receipt-slide.html',       duration: 5500, hold: 3000 },
  { file: 'GST Hub Diagram.html',     duration: 4000, hold: 3000 },
  { file: 'GST Price Tags.html',      duration: 4000, hold: 3000 },
  { file: 'GST BAS Dashboard.html',   duration: 4000, hold: 3000 },
  { file: 'GST Ledger.html',          duration: 2500, hold: 3000 },
  { file: 'GST P&L Comparison.html',  duration: 2500, hold: 3000 },
  { file: 'GST Summary.html',         duration: 3600, hold: 3500 },
];

// ── HTTP server ───────────────────────────────────────────────────────────────

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath  = decodeURIComponent(req.url.split('?')[0]);
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

function safeName(f) {
  return f.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

// ── Per-slide recording ───────────────────────────────────────────────────────

async function recordSlide(browser, file, duration, hold) {
  const name    = safeName(file);
  const rawDir  = path.join(VIDEOS_DIR, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });

  const url = `http://localhost:${PORT}/${encodeURIComponent(file)}`;

  // Playwright records into a temp dir named by context; we collect after close
  const tempVideoDir = path.join(VIDEOS_DIR, `_tmp_${name}`);
  fs.mkdirSync(tempVideoDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: {
      dir:  tempVideoDir,
      size: { width: 1920, height: 1080 },
    },
  });

  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });

  // Play through animation
  await page.waitForTimeout(duration);

  // Hold on final state
  await page.waitForTimeout(hold);

  // Close page first so the video handle is accessible
  const video = page.video();
  await page.close();
  await context.close();   // flushes & finalises the WebM file

  // Retrieve and move to a stable name
  const videoPath = await video.path();
  const destPath  = path.join(rawDir, `${name}.webm`);
  fs.renameSync(videoPath, destPath);

  // Clean up temp dir
  try { fs.rmdirSync(tempVideoDir); } catch {}

  console.log(`  ✓ ${file}  →  ${destPath}`);
  return { name, file, webm: destPath, duration_ms: duration + hold };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
  const server  = await startServer();
  const browser = await chromium.launch({ args: ['--disable-web-security'] });

  const manifest = { slides: [] };

  for (const { file, duration, hold } of SLIDES) {
    console.log(`\nRecording: ${file}`);
    try {
      const result = await recordSlide(browser, file, duration, hold);
      manifest.slides.push(result);
    } catch (err) {
      console.error(`  ✗ ${err.message}`);
    }
  }

  await browser.close();
  server.close();

  fs.writeFileSync(path.join(VIDEOS_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('\nDone. Manifest → videos/manifest.json');
}

main().catch(err => { console.error(err); process.exit(1); });
