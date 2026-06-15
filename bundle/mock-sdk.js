// Local development mock for Anna App Runtime SDK
// This file is NOT deployed to Anna — only used via run-local.js

export async function connect() {
  console.log('[mock-sdk] Running in local dev mode');

  async function pluginInvoke(method, args) {
    const res = await fetch('/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, args: args ?? {} }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data?.__error) throw new Error(data.__error);
    return data;
  }

  return {
    tools: {
      invoke: ({ tool_id, method, args }) => pluginInvoke(method, args),
    },
    storage: {
      get: async (key) => {
        try { return JSON.parse(localStorage.getItem(`anna:${key}`)); } catch { return null; }
      },
      set: async (key, value) => {
        localStorage.setItem(`anna:${key}`, JSON.stringify(value));
      },
    },
    chat: {
      write_message: async ({ content }) => {
        console.log('[Anna Chat]', content);
      },
    },
    window: {
      set_title: async (title) => { document.title = title; },
    },
  };
}
