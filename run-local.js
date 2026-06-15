/**
 * Local dev server for Research Digest AI
 * - Serves bundle/ files on http://localhost:3000
 * - Spawns the Node.js plugin as a child process
 * - Proxies /invoke POST requests to the plugin via JSON-RPC stdio
 * - Injects an import map so the mock SDK replaces the Anna SDK
 *
 * Run: node run-local.js
 */

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const BUNDLE_DIR  = join(__dirname, 'bundle');
const PLUGIN_DIR  = join(__dirname, 'executas', 'research-processor-node');
const PORT        = 3000;

// ── SPAWN PLUGIN ─────────────────────────────────────────────────────────────
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\n  ERROR: ANTHROPIC_API_KEY environment variable is not set.');
  console.error('  Set it first:');
  console.error('    Windows PowerShell:  $env:ANTHROPIC_API_KEY = "sk-ant-..."');
  console.error('    Mac/Linux:           export ANTHROPIC_API_KEY=sk-ant-...\n');
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
  '.json': 'application/json',
  '.ico':  'image/x-icon',
};

// Injected into index.html so the Anna SDK import resolves to mock-sdk.js
const IMPORT_MAP = `<script type="importmap">
{"imports":{"/static/anna-apps/_sdk/latest/index.js":"/mock-sdk.js"}}
</script>`;

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url  = new URL(req.url, `http://localhost:${PORT}`);
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

  if (!existsSync(fullPath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext  = extname(fullPath);
  const mime = MIME[ext] ?? 'text/plain';
  let content = readFileSync(fullPath, 'utf8');

  // Inject import map right after <head> so mock SDK is used
  if (filePath === '/index.html') {
    content = content.replace('<head>', `<head>\n  ${IMPORT_MAP}`);
  }

  res.writeHead(200, { 'Content-Type': mime, ...cors });
  res.end(content);
});

server.listen(PORT, () => {
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║   Research Digest AI — Local Demo   ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log(`\n  Open browser: http://localhost:${PORT}\n`);
  console.log('  Press Ctrl+C to stop.\n');
});

process.on('SIGINT', () => { plugin.kill(); process.exit(0); });
process.on('exit',   () => plugin.kill());
