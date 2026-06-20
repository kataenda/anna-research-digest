/**
 * Standalone host for Research Digest AI (web deployment, e.g. Coolify / local).
 *
 * Inside Anna the app "borrows the Anna runtime": it calls the host LLM via
 * `anna.llm.complete` and persists via `anna.storage`. This server emulates that
 * host role for STANDALONE deployment so the same bundle/ UI runs as a normal
 * web app:
 *   - Serves the bundle/ UI
 *   - Injects an import map so the Anna SDK import resolves to bundle/mock-sdk.js
 *   - Implements POST /llm — the stand-in for anna.llm.complete — by calling the
 *     Claude API with ANTHROPIC_API_KEY and returning an MCP-shaped completion
 *   - Exposes /health for container health checks
 *
 * (Storage in standalone mode lives in the browser via localStorage — see
 * mock-sdk.js — so no server-side persistence is required.)
 *
 * Env:
 *   ANTHROPIC_API_KEY  (required) — used only by this standalone LLM host
 *   ANNA_LOCAL_MODEL   (optional) — Claude model id (default claude-opus-4-8)
 *   PORT / HOST        (optional) — defaults 3000 / 0.0.0.0
 *
 * Run: node server.js
 */

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const BUNDLE_DIR = join(__dirname, 'bundle');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MODEL = process.env.ANNA_LOCAL_MODEL || 'claude-opus-4-8';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\n  ERROR: ANTHROPIC_API_KEY is not set (needed by the standalone LLM host).');
  console.error('  On the Anna platform this is NOT needed — Anna provides the LLM.');
  console.error('  For standalone/Coolify, set ANTHROPIC_API_KEY and redeploy.\n');
  process.exit(1);
}

// ── LLM HOST (stands in for anna.llm.complete) ─────────────────────────────────
// Accepts the same args the frontend sends to anna.llm.complete
// ({ messages, systemPrompt, maxTokens }) and returns an MCP-shaped result
// ({ content: { type: 'text', text } }) — identical to what Anna's runtime returns.
async function llmComplete({ messages, systemPrompt, maxTokens }) {
  const userText = (messages || [])
    .map((m) => {
      const c = m?.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map((b) => b?.text ?? '').join('');
      return c?.text ?? '';
    })
    .join('\n');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens || 1500,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: userText }],
    }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Anthropic API ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  const text = (data.content || []).map((b) => b.text || '').join('');
  return { content: { type: 'text', text }, model: data.model, stopReason: data.stop_reason };
}

// ── STATIC FILE MIME TYPES ───────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
};

const IMPORT_MAP = `<script type="importmap">
{"imports":{"/static/anna-apps/_sdk/latest/index.js":"/mock-sdk.js"}}
</script>`;

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') { res.writeHead(200, cors); res.end(); return; }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // POST /llm — stand-in for anna.llm.complete
  if (req.method === 'POST' && url.pathname === '/llm') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const args = JSON.parse(body || '{}');
        console.log('  [llm] complete', JSON.stringify(args.messages?.[0]?.content ?? '').slice(0, 80));
        const result = await llmComplete(args);
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ __error: err.message }));
      }
    });
    return;
  }

  // ── GET — serve static files ─────────────────────────────────────────────
  const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const fullPath = join(BUNDLE_DIR, filePath);

  if (!fullPath.startsWith(BUNDLE_DIR) || !existsSync(fullPath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext  = extname(fullPath);
  const mime = MIME[ext] ?? 'text/plain';
  const isText = /^(text\/|application\/(javascript|json)|image\/svg)/.test(mime);

  if (!isText) {
    res.writeHead(200, { 'Content-Type': mime, ...cors });
    res.end(readFileSync(fullPath));
    return;
  }

  let content = readFileSync(fullPath, 'utf8');
  if (filePath === '/index.html') {
    content = content.replace('<head>', `<head>\n  ${IMPORT_MAP}`);
  }
  res.writeHead(200, { 'Content-Type': mime, ...cors });
  res.end(content);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Research Digest AI — listening on http://${HOST}:${PORT}  (LLM host model: ${MODEL})\n`);
});

const shutdown = () => process.exit(0);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
