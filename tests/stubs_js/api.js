const listeners = {};
export const api = {
  addEventListener(t, f) { (listeners[t] ||= []).push(f); },
  fetchApi(path, opts) { return fetch(path, opts); },
  async queuePrompt() { window.__apiQueued = (window.__apiQueued || 0) + 1; },
};
setInterval(async () => {
  try {
    const evs = await (await fetch('/__events')).json();
    for (const e of evs) for (const f of (listeners[e.event] || [])) f({ detail: e.data });
  } catch (_) { /* server gone */ }
}, 150);
