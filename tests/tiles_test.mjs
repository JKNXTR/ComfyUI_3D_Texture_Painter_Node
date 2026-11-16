// Tile grid of the editor must equal the Python one (same table), plus the mask test.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { tileGrid, tilesWithMask } = await import(path.join(root, 'src/tiles.js'));
const CASES = [[4096, 2048, 3, 2, 0.12], [1024, 1024, 2, 2, 0.0], [1000, 777, 4, 3, 0.25], [512, 512, 1, 1, 0.12], [999, 1001, 5, 7, 0.3]];
const py = JSON.parse(execFileSync('python3', [path.join(root, 'tests/test_tiles.py'), 'dump']).toString());
let failed = false; const ok = (n, v) => { console.log((v ? 'PASS ' : 'FAIL ') + n); if (!v) failed = true; };
CASES.forEach((c, i) => {
  const js = tileGrid(...c).map((t) => [t.x0, t.y0, t.x1, t.y1, t.cx0, t.cx1, t.cy0, t.cy1]);
  ok(`grid ${c.join('x')} equals Python`, JSON.stringify(js) === JSON.stringify(py[i]));
});
// mask: bottom-up RGBA, paint v in [0.9,0.95] (near the TOP of the image), u in [0.6,0.7]  -> tile 1 of a 2x2 grid (top right)
const S = 256, buf = new Uint8Array(S * S * 4);
for (let y = Math.floor(0.9 * S); y < Math.floor(0.95 * S); y++) for (let x = Math.floor(0.6 * S); x < Math.floor(0.7 * S); x++) buf[(y * S + x) * 4] = 255;
ok('mask near the top right selects tile 1 only', JSON.stringify(tilesWithMask(tileGrid(1024, 1024, 2, 2, 0.12), 1024, 1024, buf, S)) === '[1]');
process.exit(failed ? 1 : 0);
