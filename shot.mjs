// Dev-only screenshot helper (not part of the entry's program): serves the built
// output directory over localhost and captures the three dashboard states as
// JPEGs into screenshots/. Run: node shot.mjs [out-dir]
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium } from 'playwright';

const root = process.argv[2] ?? 'out';
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

const server = createServer((req, res) => {
  const p = join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'dashboard/index.html');
  if (!existsSync(p)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/dashboard/index.html`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.screenshot({ path: 'screenshots/1-board.jpg', type: 'jpeg', quality: 95 });

// Detail view: open the 3rd ranked row, then scroll the detail panel so the farm plan shows.
await page.click('#rows tr:nth-child(3)');
await page.waitForTimeout(400);
await page.evaluate(() => { const d = document.getElementById('detail'); d.scrollTop = 420; });
await page.waitForTimeout(200);
await page.screenshot({ path: 'screenshots/2-detail.jpg', type: 'jpeg', quality: 95 });

// Filtered view: category = Risk Curators.
await page.selectOption('#cat', 'Risk Curators');
await page.waitForTimeout(400);
await page.screenshot({ path: 'screenshots/3-filter.jpg', type: 'jpeg', quality: 95 });

console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
server.close();
