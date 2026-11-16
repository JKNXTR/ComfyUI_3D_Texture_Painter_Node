// The viewport (DOM) widget of the painter node is not serialized, but it sits at widget index 0. Depending on the ComfyUI frontend version,
// widgets_values is then applied by absolute widget index (everything shifts by one) or by serializable index. This re-applies the saved values
// to the serializable widgets in order, accepting both layouts: N values (saved by the frontend) or N+1 values (a leading placeholder for the viewport).
export function realignWidgetValues(node, info) {
  const vals = info && info.widgets_values;
  if (!Array.isArray(vals) || !node || !Array.isArray(node.widgets)) return 'skip';
  const ser = node.widgets.filter((w) => w && w.serialize !== false);
  let off;
  if (vals.length === ser.length) off = 0;
  else if (vals.length === ser.length + 1) off = 1;
  else return 'skip';
  ser.forEach((w, i) => { const v = vals[i + off]; if (v !== undefined) w.value = v; });
  return off ? 'shifted' : 'ok';
}
