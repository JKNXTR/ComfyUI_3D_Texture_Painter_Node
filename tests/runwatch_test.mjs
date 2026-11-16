// A late "execution_success" of the previous run must not end the next run (tile 2 failed with "produced no new result" because of this).
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { adoptStart, successBelongsTo } = await import(path.join(root, 'src/runwatch.js'));
let failed = false; const ok = (n, v) => { console.log((v ? 'PASS ' : 'FAIL ') + n); if (!v) failed = true; };
// timeline of a tile run: waiter 2 is created, run 1's success arrives, THEN run 2 starts
const w2 = {};
ok('success of the previous run before the new run started is ignored', successBelongsTo(w2, true, 'p1') === false);
adoptStart(w2, 'p2');
ok('success of an older prompt id is ignored', successBelongsTo(w2, true, 'p1') === false);
ok('success of its own prompt counts', successBelongsTo(w2, true, 'p2') === true);
ok('success without a prompt id counts once the run started', successBelongsTo(w2, true, undefined) === true);
adoptStart(w2, 'p3'); ok('the first start owns the waiter (later starts do not steal it)', w2.promptId === 'p2');
const w3 = {}; adoptStart(w3, undefined); ok('start event without id is accepted', w3.promptId === '?' && successBelongsTo(w3, true, 'x') === true);
ok('frontends without start events keep the old behaviour', successBelongsTo({}, false, 'p1') === true);
ok('no waiter -> not ours', successBelongsTo(null, true, 'p1') === false);
process.exit(failed ? 1 : 0);
