// Sizing of the editor inside a ComfyUI node. The DOM-widget wrapper that ComfyUI (classic canvas or the newer Vue node
// renderer) puts around the editor is not always a definite-size box - in some versions it shrinks to its content, so
// "width/height: 100%" collapsed the editor to a small box in the corner of a large node. The host therefore gets explicit
// minimum sizes derived from the node, and the editor root fills the host (position:absolute, see .tp-embed in ui.js).
export const EMBED = { minW: 420, minH: 640, padX: 32 };

/** host = the element given to addDOMWidget; nodeW = node.size[0] (graph units). Returns [minWidth, minHeight] in px. */
export function layoutEmbedHost(host, nodeW) {
  const W = Math.max(EMBED.minW, Math.round((Number(nodeW) || 0) - EMBED.padX));
  host.style.minWidth = W + 'px';
  host.style.minHeight = EMBED.minH + 'px';
  return [W, EMBED.minH];
}
