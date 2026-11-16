// Embedding in ComfyUI node wrappers: shrink-to-fit wrapper, definite wrapper, fullscreen round trip.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': mime[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(0);
const port = server.address().port;
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1300,820'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1300, height: 820 });
const logs = [];
page.on('console', (m) => { if (!/GPU stall/.test(m.text())) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.stack || e.message}`));
let failed = false;
try {
  await page.goto(`http://127.0.0.1:${port}/tests/harness.html`);
  await page.waitForFunction('window.ready === true', { timeout: 20000 });
  const R = await page.evaluate(async () => {
    const R = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const TP = window.TP;
    const mount = (wrapStyle, embed, nodeW = 980) => {
      const wrap = document.createElement('div'); wrap.style.cssText = wrapStyle; document.body.append(wrap);
      const host = document.createElement('div');
      host.style.cssText = 'width:100%;height:100%;position:relative;overflow:hidden;pointer-events:auto';
      const ed = new TP.TexturePaintEditor(); host.append(ed.root); wrap.append(host);
      if (embed) { ed.root.classList.add('tp-embed'); TP.layoutEmbedHost(host, nodeW); }
      return { wrap, host, ed };
    };
    const rect = (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
    // 1) wrapper that shrinks to its content with an auto height (what collapsed the editor in the Vue node renderer)
    const shrink = 'display:flex;flex-direction:column;align-items:flex-start;position:absolute;left:0;top:0;width:1000px';
    const a = mount(shrink, false); await sleep(200); R.oldCollapsed = rect(a.ed.root); a.ed.dispose(); a.wrap.remove();
    const b = mount(shrink, true); await sleep(300);
    R.shrinkRoot = rect(b.ed.root); R.shrinkHost = rect(b.host);
    R.stage = [b.ed.ui.stage.clientWidth, b.ed.ui.stage.clientHeight];
    R.pane3d = rect(b.ed.ui.pane3d);
    // 2) wrapper with a definite size (classic canvas): the editor fills it exactly
    b.ed.dispose(); b.wrap.remove();
    const c = mount('position:absolute;left:0;top:0;width:860px;height:700px', true, 892); await sleep(300);
    R.fixedRoot = rect(c.ed.root);
    // 3) fullscreen and back
    c.ed.setFullscreen(true); await sleep(200); R.full = rect(c.ed.root);
    c.ed.setFullscreen(false); await sleep(300); R.back = rect(c.ed.root); R.backInHost = c.ed.root.parentNode === c.host;
    R.backStage = [c.ed.ui.stage.clientWidth, c.ed.ui.stage.clientHeight];
    R.win = [innerWidth, innerHeight];
    // 4) wider node later: min width follows
    c.host.style.minWidth = ''; TP.layoutEmbedHost(c.host, 1400); R.minW = c.host.style.minWidth;
    return R;
  });
  console.log(JSON.stringify(R));
  const must = {
    'without the fix an auto-size wrapper breaks the editor size (tiny or runaway tall)': R.oldCollapsed[0] < 700 || R.oldCollapsed[1] > 1500,
    'shrink-to-fit wrapper: editor is node-wide (>=948) and >=640 tall': R.shrinkRoot[0] >= 948 && R.shrinkRoot[1] >= 640 && R.shrinkRoot[0] === R.shrinkHost[0] && R.shrinkRoot[1] === R.shrinkHost[1],
    '3D pane gets a usable size': R.pane3d[0] > 250 && R.pane3d[1] > 450 && R.stage[0] >= 600,
    'definite-size wrapper: editor fills it exactly': R.fixedRoot[0] === 860 && R.fixedRoot[1] === 700,
    'fullscreen covers the window': R.full[0] === R.win[0] && R.full[1] === R.win[1],
    'exit fullscreen returns to the host at the same size': R.back[0] === 860 && R.back[1] === 700 && R.backInHost && R.backStage[0] >= 500,
    'min width follows the node width': R.minW === '1368px',
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
