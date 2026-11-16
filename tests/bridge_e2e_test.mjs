// Two browser pages against the real server: the ComfyUI node page (e2e.html) and the standalone editor (/texpaint/standalone).
// Checks roles, live sync both ways, widgets, take-over, Queue from either side, progress/baked events, reconnect.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
const here = path.dirname(fileURLToPath(import.meta.url));
const srv = spawn('python3', [path.join(here, 'e2e_server.py')], { stdio: ['ignore', 'pipe', 'pipe'] });
let srvErr = ''; srv.stderr.on('data', (d) => { srvErr += d.toString(); });
const port = await new Promise((res, rej) => { let b = ''; srv.stdout.on('data', (d) => { b += d; const m = /PORT (\d+)/.exec(b); if (m) res(+m[1]); }); srv.on('exit', () => rej(new Error('server exited: ' + srvErr))); setTimeout(() => rej(new Error('start timeout ' + srvErr)), 20000); });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1300,820'] });
const logs = [];
const mk = async (name) => { const pg = await browser.newPage(); await pg.setViewport({ width: 1300, height: 820 }); pg.on('console', (m) => { if (!/GPU stall|Failed to load resource|\[TexturePainterAI\] (bridge|restore)/.test(m.text())) logs.push(`[${name}:${m.type()}] ${m.text()}`); }); pg.on('response', (r) => { if (r.status() === 404) logs.push(`[${name}:404] ${r.url()}`); }); pg.on('pageerror', (e) => logs.push(`[${name}:pageerror] ${e.stack || e.message}`)); return pg; };
let fails = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pg, fn, arg, ms = 60000) => { try { await pg.waitForFunction(fn, { timeout: ms, polling: 100 }, arg); return true; } catch (_) { return false; } };
const maskSum = (pg, which) => pg.evaluate((w) => { const ed = w === 'A' ? [...window.TexturePainterAI.records.values()][0].ed : window.TexturePainterStandalone.ed; const b = ed._readMaskPixels(); let s = 0; for (let i = 0; i < b.length; i += 4) s += b[i]; return s; }, which);
try {
  const A = await mk('node');
  await A.goto(`http://127.0.0.1:${port}/tests/e2e.html`); await A.waitForFunction('window.ready === true', { timeout: 20000 });
  const sid = await A.evaluate(async () => {
    const node = await window.makeNode(); const rec = window.TexturePainterAI.records.get(node.id), ed = rec.ed;
    const faces = [{ n: [0, 0, 1], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] }, { n: [0, 0, -1], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] }, { n: [1, 0, 0], v: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] }, { n: [-1, 0, 0], v: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] }, { n: [0, 1, 0], v: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] }, { n: [0, -1, 0], v: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] }];
    let obj = '', vi = 1;
    faces.forEach((f, i) => { const col = i % 3, row = Math.floor(i / 3), m = 0.01; const u0 = col / 3 + m, u1 = (col + 1) / 3 - m, v0 = row / 2 + m, v1 = (row + 1) / 2 - m; const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]; for (let k = 0; k < 4; k++) obj += `v ${f.v[k].join(' ')}\nvt ${uvs[k].join(' ')}\nvn ${f.n.join(' ')}\n`; const a = vi, b = vi + 1, c = vi + 2, d = vi + 3; obj += `f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}\nf ${a}/${a}/${a} ${c}/${c}/${c} ${d}/${d}/${d}\n`; vi += 4; });
    await ed.pickModelFile(new File([obj], 'my cube.obj')); ed.frameModel();
    await new Promise((r) => setTimeout(r, 300));
    ed.state.brush.size = 240; const p3 = ed.ui.pane3d;
    ed.beginStroke(false); ed.strokeMove(p3.offsetWidth / 2, p3.offsetHeight / 2, 0); ed.strokeMove(p3.offsetWidth / 2 + 40, p3.offsetHeight / 2 + 10, 0); ed.endStroke();
    await window.TexturePainterAI.autosave(rec);
    return rec.sid;
  });
  ok('node page has a session and the bridge started', !!sid && await waitFor(A, () => { const r = [...window.TexturePainterAI.records.values()][0]; return r.bridge && r.bridge.state.connected; }));
  const nodeMask0 = await maskSum(A, 'A'); ok('node mask painted', nodeMask0 > 0, nodeMask0);

  // ---- standalone joins: becomes master (auto claim), the node becomes the read-only mirror, state arrives
  const B = await mk('standalone');
  await B.goto(`http://127.0.0.1:${port}/texpaint/standalone`);
  await sleep(300);
  ok('picker lists the session of the open node', (await B.evaluate(() => document.body.innerText)).includes('my cube'));
  await B.goto(`http://127.0.0.1:${port}/texpaint/standalone?sid=${sid}`);
  ok('standalone editor started', await waitFor(B, () => window.TexturePainterStandalone && window.TexturePainterStandalone.ed));
  ok('standalone connected + master', await waitFor(B, () => { const c = window.TexturePainterStandalone.ctl; return c.state.connected && c.state.master === c.state.id && c.state.clients.length === 2; }));
  ok('node is the mirror', await waitFor(A, () => [...window.TexturePainterAI.records.values()][0].mirror === true));
  ok('standalone loaded the model + mask', await waitFor(B, () => window.TexturePainterStandalone.ed.hasModel), null);
  await waitFor(B, (t) => { const ed = window.TexturePainterStandalone.ed; const b = ed._readMaskPixels(); let s = 0; for (let i = 0; i < b.length; i += 4) s += b[i]; return Math.abs(s - t) < 1; }, nodeMask0);
  const sMask = await maskSum(B, 'B'); ok('standalone mask equals the node mask', Math.abs(sMask - nodeMask0) < 1, [sMask, nodeMask0]);
  ok('mirror shows the cover + status', await A.evaluate(() => !!document.querySelector('.tp-mirror') && document.querySelector('.tp-mirror').style.display !== 'none' && /mirror/.test(document.querySelector('.tp-bridge').textContent)));

  // ---- edit in the standalone -> the node mirror follows
  await B.evaluate(() => { const ed = window.TexturePainterStandalone.ed; const p = ed.ui.pane3d; ed.state.brush.size = 120; ed.beginStroke(false); ed.strokeMove(p.offsetWidth / 2 - 90, p.offsetHeight / 2 - 60, 0); ed.strokeMove(p.offsetWidth / 2 - 60, p.offsetHeight / 2 - 40, 0); ed.endStroke(); });
  const bMask1 = await maskSum(B, 'B'); ok('standalone stroke added mask', bMask1 > sMask, [bMask1, sMask]);
  ok('node mirror got the stroke', await waitFor(A, (t) => { const ed = [...window.TexturePainterAI.records.values()][0].ed; const b = ed._readMaskPixels(); let s = 0; for (let i = 0; i < b.length; i += 4) s += b[i]; return Math.abs(s - t) < 1; }, bMask1));

  // ---- widgets: both directions
  await A.evaluate(() => { const n = [...window.TexturePainterAI.records.values()][0]; const w = n.node.widgets.find((x) => x.name === 'prompt'); w.value = 'rusty metal from ComfyUI'; });
  ok('prompt typed in ComfyUI reaches the standalone', await waitFor(B, () => window.TexturePainterStandalone.ed.hooks.getPrompt() === 'rusty metal from ComfyUI'));
  await B.evaluate(() => window.TexturePainterStandalone.ed.hooks.setPrompt('mossy stone from standalone'));
  ok('prompt typed in the standalone reaches the node widget', await waitFor(A, () => [...window.TexturePainterAI.records.values()][0].node.widgets.find((x) => x.name === 'prompt').value === 'mossy stone from standalone'));

  // ---- Queue from ComfyUI while the standalone is master: the standalone captures first
  const q0 = await A.evaluate(() => window.__queued || 0);
  const k0 = await B.evaluate(() => window.TexturePainterStandalone.rec.lastKey);
  await B.evaluate(() => { window.TexturePainterStandalone.ed.state.brush.size = 100; window.TexturePainterStandalone.ed.beginStroke(false); const p = window.TexturePainterStandalone.ed.ui.pane3d; window.TexturePainterStandalone.ed.strokeMove(p.offsetWidth / 2 + 50, p.offsetHeight / 2 + 50, 0); window.TexturePainterStandalone.ed.endStroke(); });
  await A.evaluate(() => window.app.queuePrompt());
  ok('ComfyUI Queue went through', (await A.evaluate(() => window.__queued || 0)) === q0 + 1);
  const k1 = await B.evaluate(() => window.TexturePainterStandalone.rec.lastKey);
  ok('the standalone (master) captured for that Queue', k1 && k1 !== k0, [k0, k1]);

  // ---- Generate from the standalone: queued in ComfyUI without a second capture, the result comes back
  await A.evaluate(() => { window.__queued = 0; });
  const genP = B.evaluate(async () => { try { const r = await window.TexturePainterStandalone.ed.hooks.generate(); return { ok: true, w: r.bmp.width, h: r.bmp.height, sum: !!(r.stats && r.stats.summary) }; } catch (e) { return { ok: false, e: e.message }; } });
  ok('node got the queue command', await waitFor(A, () => (window.__queued || 0) >= 1));
  const run = await (await fetch(`http://127.0.0.1:${port}/__run`, { method: 'POST', body: JSON.stringify({ session: sid }) })).json();
  ok('server ran painter + bake', run.ok, run);
  const gen = await genP; ok('standalone received the generated result', gen.ok && gen.w > 0, gen);
  ok('generate used exactly one queue (no double capture/queue)', (await A.evaluate(() => window.__queued)) === 1);

  // ---- take over in the node: roles swap, node edits reach the standalone
  await waitFor(A, () => ![...window.TexturePainterAI.records.values()][0].restoring);
  await A.evaluate(() => document.querySelector('.tp-bridge button').click());
  ok('node is master after Take over', await waitFor(A, () => [...window.TexturePainterAI.records.values()][0].mirror === false && [...window.TexturePainterAI.records.values()][0].bridge.state.master === [...window.TexturePainterAI.records.values()][0].bridge.state.id));
  ok('standalone is the mirror', await waitFor(B, () => window.TexturePainterStandalone.rec.mirror === true));
  await A.evaluate(async () => { const rec = [...window.TexturePainterAI.records.values()][0], ed = rec.ed, p = ed.ui.pane3d; ed.state.brush.size = 150; ed.beginStroke(false); ed.strokeMove(p.offsetWidth / 2 + 80, p.offsetHeight / 2 - 80, 0); ed.endStroke(); });
  const aMask2 = await maskSum(A, 'A');
  ok('standalone mirror follows the node edit', await waitFor(B, (t) => { const ed = window.TexturePainterStandalone.ed; const b = ed._readMaskPixels(); let s = 0; for (let i = 0; i < b.length; i += 4) s += b[i]; return Math.abs(s - t) < 1; }, aMask2));

  // ---- bridge drop + reconnect: the standalone closes its socket, comes back, state is consistent
  await B.evaluate(() => window.TexturePainterStandalone.ctl.bc.ws.close());
  ok('standalone reconnects', await waitFor(B, () => window.TexturePainterStandalone.ctl.state.connected && window.TexturePainterStandalone.ctl.state.clients.length === 2, null, 15000));
  ok('exactly one master after reconnect', await waitFor(A, () => { const r = [...window.TexturePainterAI.records.values()][0]; return r.bridge.state.clients.length === 2 && !!r.bridge.state.master; }, null, 10000));
  // ---- standalone closed: node is alone and editable again
  await B.close();
  ok('node master again, editable', await waitFor(A, () => { const r = [...window.TexturePainterAI.records.values()][0]; return r.mirror === false && r.bridge.state.clients.length === 1; }, null, 15000));
} catch (e) { fails++; console.log('FAIL exception ' + (e.stack || e)); }
const errs = logs.filter((l) => /pageerror|\[(node|standalone):error\]/.test(l));
if (errs.length) { console.log('FAIL console errors:\n' + errs.slice(0, 8).join('\n')); fails++; }
if (fails) console.log(logs.slice(-25).join('\n'));
await browser.close(); srv.kill();
console.log(fails ? `FAILED ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
