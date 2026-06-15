/**
 * Production server for Research Digest AI (standalone web deployment, e.g. Coolify)
 *
 * - Serves the bundle/ UI
 * - Spawns the research-processor plugin as a child process
 * - Proxies /invoke POST requests to the plugin via JSON-RPC over stdio
 * - Injects an import map so the Anna SDK resolves to the local mock (standalone mode)
 * - Exposes /health for container health checks
 *
 * Env:
 *   ANTHROPIC_API_KEY  (required) — Claude API key
 *   PORT               (optional) — defaults to 3000
 *   HOST               (optional) — defaults to 0.0.0.0
 *
 * Run: node server.js
 */

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const BUNDLE_DIR = join(__dirname, 'bundle');
const PLUGIN_DIR = join(__dirname, 'executas', 'research-processor-node');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ── SPAWN PLUGIN ─────────────────────────────────────────────────────────────
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\n  ERROR: ANTHROPIC_API_KEY environment variable is not set.');
  console.error('  Set it in your Coolify service environment variables, then redeploy.\n');
  process.exit(1);
}

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

plugin.stdout.on('data', (chunk) => {
  lineBuffer += chunk.toString();
  let nl;
  while ((nl = lineBuffer.indexOf('\n')) !== -1) {
    const line = lineBuffer.slice(0, nl).trim();
    lineBuffer = lineBuffer.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const cb = pending.get(msg.id);
      if (cb) { pending.delete(msg.id); cb(msg); }
    } catch { /* ignore non-JSON stdout */ }
  }
});

function invokePlugin(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Plugin timeout on method "${method}"`));
    }, 45_000);

    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });

    plugin.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n'
    );
  });
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

// Injected into index.html so the Anna SDK import resolves to mock-sdk.js
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

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, cors);
    res.end();
    return;
  }

  // ── Health check ─────────────────────────────────────────────────────────
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // ── POST /invoke — proxy to plugin ──────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/invoke') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { method, args } = JSON.parse(body);
        console.log(`  [invoke] ${method}`, JSON.stringify(args).slice(0, 80));
        const msg = await invokePlugin(method, args ?? {});
        if (msg.result !== undefined) {
          res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
          res.end(JSON.stringify(msg.result));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
          res.end(JSON.stringify({ __error: msg.error?.message ?? 'Plugin error' }));
        }
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

  // Prevent path traversal outside the bundle dir
  if (!fullPath.startsWith(BUNDLE_DIR) || !existsSync(fullPath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext  = extname(fullPath);
  const mime = MIME[ext] ?? 'text/plain';
  const isText = /^(text\/|application\/(javascript|json)|image\/svg)/.test(mime);

  if (!isText) {
    // Binary assets (png, ico) — serve raw bytes, never decode as text
    res.writeHead(200, { 'Content-Type': mime, ...cors });
    res.end(readFileSync(fullPath));
    return;
  }

  let content = readFileSync(fullPath, 'utf8');

  // Inject import map right after <head> so the mock SDK is used in standalone mode
  if (filePath === '/index.html') {
    content = content.replace('<head>', `<head>\n  ${IMPORT_MAP}`);
  }

  res.writeHead(200, { 'Content-Type': mime, ...cors });
  res.end(content);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Research Digest AI — listening on http://${HOST}:${PORT}\n`);
});

const shutdown = () => { plugin.kill(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => plugin.kill());
