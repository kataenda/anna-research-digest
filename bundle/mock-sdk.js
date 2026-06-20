// Local/standalone stand-in for the Anna App Runtime SDK.
// NOT deployed to Anna — used only when the app runs as a standalone web service
// (server.js injects an import map so the Anna SDK import resolves here).
// Mirrors the real SDK shape: `import { AnnaAppRuntime }` + `AnnaAppRuntime.connect()`.
//
// The app borrows the Anna runtime via anna.llm.complete + anna.storage. This shim
// maps those onto a standalone host:
//   - llm.complete  → POST /llm (server.js calls Claude, returns MCP-shaped result)
//   - storage.*     → browser localStorage
//   - chat/window   → console / document.title

export class AnnaAppRuntime {
  static async connect() {
    console.log('[mock-sdk] Running in standalone mode');

    return {
      llm: {
        complete: async (args) => {
          const res = await fetch('/llm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(args ?? {}),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (data?.__error) throw new Error(data.__error);
          return data; // { content: { type: 'text', text } }
        },
      },
      storage: {
        get: async ({ key }) => {
          try { return JSON.parse(localStorage.getItem(`anna:${key}`)); } catch { return null; }
        },
        set: async ({ key, value }) => {
          localStorage.setItem(`anna:${key}`, JSON.stringify(value));
        },
      },
      chat: {
        write_message: async ({ content }) => { console.log('[Anna Chat]', content); },
      },
      window: {
        set_title: async ({ title }) => { document.title = title; },
      },
    };
  }
}
