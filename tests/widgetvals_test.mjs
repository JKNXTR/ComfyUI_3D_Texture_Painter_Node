import { realignWidgetValues } from '../src/widgetvals.js';
let failed = false; const ok = (n, c, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  ' + x)); if (!c) failed = true; };
const mk = () => ({ widgets: [{ name: 'view', serialize: false, value: null }, ...['state_json', 'prompt', 'style', 'compose', 'seed', 'control'].map((n) => ({ name: n, value: undefined }))] });
const vals = ['{}', 'a cat', 'flat', true, 5, 'fixed'];
let n = mk(); // frontend saved N values, applied by absolute index (shifted): the helper must repair it
n.widgets.forEach((w, i) => { w.value = vals[i]; });
ok('N values: realigned from the shifted state', realignWidgetValues(n, { widgets_values: vals }) === 'ok' && n.widgets.slice(1).map((w) => w.value).join('|') === vals.join('|'));
n = mk(); ok('N+1 values (leading placeholder) are accepted', realignWidgetValues(n, { widgets_values: [null, ...vals] }) === 'shifted' && n.widgets[1].value === '{}' && n.widgets[6].value === 'fixed' && n.widgets[0].value === null);
n = mk(); ok('unknown length is left alone', realignWidgetValues(n, { widgets_values: [1, 2] }) === 'skip' && n.widgets[1].value === undefined);
ok('no info / no widgets is harmless', realignWidgetValues(mk(), null) === 'skip' && realignWidgetValues({}, { widgets_values: [] }) === 'skip');
process.exit(failed ? 1 : 0);
