export const app = {
  graph: { setDirtyCanvas() {} },
  registerExtension(ext) { window.__ext = ext; },
  async queuePrompt() { window.__queued = (window.__queued || 0) + 1; },
};
