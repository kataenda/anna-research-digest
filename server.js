/**
 * Standalone host for Research Digest AI (web deployment, e.g. Coolify / local).
 *
 * In production on Anna, the platform provides the LLM via reverse
 * `sampling/createMessage` and the plugin holds no API key. This server
 * emulates that host role for STANDALONE deployment:
 *   - Serves the bundle/ UI
 *   - Spawns the research-processor plugin (Executa protocol v2 over stdio)
 *   - Translates /invoke POST → plugin `invoke {tool, arguments}` (unwraps data)
 *   - Acts as the SAMPLING HOST: answers the plugin's `sampling/createMessage`
 *     requests by calling the Claude API with ANTHROPIC_API_KEY
 *   - Exposes /health for container health checks
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
import { spawn } from 'child_process';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const BUNDLE_DIR = join(__dirname, 'bundle');
const PLUGIN_DIR = join(__dirname, 'executas', 'research-processor-node');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MODEL = process.env.ANNA_LOCAL_MODEL || 'claude-opus-4-8';

// ── LLM HOST (stands in for Anna's sampling provider) ──────────────────────────
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\n  ERROR: ANTHROPIC_API_KEY is not set (needed by the standalone LLM host).');
  console.error('  On the Anna platform this is NOT needed — Anna provides the LLM.');
  console.error('  For standalone/Coolify, set ANTHROPIC_API_KEY and redeploy.\n');
  process.exit(1);
}
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── SPAWN PLUGIN ─────────────────────────────────────────────────────────────
const plugin = spawn('node', ['index.js'], {
  cwd: PLUGIN_DIR,
  env: { ...process.env },
  stdio: ['pipe', 'pipe', 'inherit'],
});
plugin.on('error', (err) => {
  console.error('Plugin failed to start:', err.message);
  process.exit(1);
});
plugin.on('exit', (code) => {
  console.error(`Plugin process exited with code ${code}. Shutting down.`);
  process.exit(code ?? 1);
});

let reqId = 0;
const pending = new Map();
let lineBuffer = '';

function sendToPlugin(frame) {
  plugin.stdin.write(JSON.stringify(frame) + '\n');
}

// Answer the plugin's reverse sampling request by calling Claude.
async function handleSampling(msg) {
  const p = msg.params || {};
  try {
    const userText = (p.messages || [])
      .map((m) => (m.content && m.content.text) || '')
      .join('\n');
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: p.maxTokens || 1024,
      ...(p.systemPrompt ? { system: p.systemPrompt } : {}),
      messages: [{ role: 'user', content: userText }],
    });
    const text = resp.content?.[0]?.text ?? '';
    sendToPlugin({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: { type: 'text', text },
        model: resp.model,
        usage: resp.usage,
        stopReason: resp.stop_reason,
      },
    });
  } catch (err) {
    sendToPlugin({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32003, message: `LLM host error: ${err.message}` },
    });
  }
}

plugin.stdout.on('data', (chunk) => {
  lineBuffer += chunk.toString();
  let nl;
  while ((nl = lineBuffer.indexOf('\n')) !== -1) {
    const line = lineBuffer.slice(0, nl).trim();
    lineBuffer = lineBuffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    // Reverse request FROM the plugin (wants the host to sample an LLM).
    if (msg.method === 'sampling/createMessage') {
      handleSampling(msg);
      continue;
    }
    // Otherwise: a response to one of OUR requests.
    const cb = pending.get(msg.id);
    if (cb) { pending.delete(msg.id); cb(msg); }
  }
});

function rpc(method, params, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Plugin timeout on "${method}"`));
    }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    sendToPlugin({ jsonrpc: '2.0', id, method, params: params ?? {} });
  });
}

// Negotiate protocol v2 so the plugin enables host sampling.
rpc('initialize', { protocolVersion: '2.0' }).catch(() => {});

// Translate a browser tool call → plugin invoke, returning the unwrapped data
// (mirrors how Anna unwraps {success, data} → data).
async function invokeTool(method, args) {
  const msg = await rpc('invoke', { tool: method, arguments: args ?? {} });
  if (msg.error) throw new Error(msg.error.message ?? 'Plugin error');
  const r = msg.result ?? {};
  if (r.success === false) throw new Error(r.error ?? 'Tool failed');
  return r.data ?? r;
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

  if (req.method === 'POST' && url.pathname === '/invoke') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { method, args } = JSON.parse(body);
        console.log(`  [invoke] ${method}`, JSON.stringify(args ?? {}).slice(0, 80));
        const data = await invokeTool(method, args ?? {});
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify(data));
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

const shutdown = () => { plugin.kill(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => plugin.kill());
