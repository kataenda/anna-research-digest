/**
 * research-processor — Anna Executa stdio tool (protocol v2).
 *
 * Generates structured research digests by asking the HOST (Anna) to run an
 * LLM completion via reverse `sampling/createMessage`. The plugin never holds
 * an LLM API key — the host owns model selection, billing and quota.
 *
 * Methods: initialize, describe, invoke (params.tool), health, shutdown.
 * Tools:   research, get_history, save_digest, delete_digest.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';
import { SamplingClient, SamplingError, PROTOCOL_VERSION_V2 } from './sampling.js';

const STATE_DIR = join(homedir(), '.anna', 'research-digest');
const STATE_FILE = join(STATE_DIR, 'state.json');

// ─── State (persistent library) ──────────────────────────────────────────────
function ensureDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}
function loadState() {
  ensureDir();
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { digests: [] };
  }
}
function saveState(state) {
  ensureDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Wiring ───────────────────────────────────────────────────────────────────
function writeFrame(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
const sampling = new SamplingClient({ writeFrame });

const MANIFEST = {
  display_name: 'Research Processor',
  version: '0.1.0',
  description: 'AI-powered research digest generator. Synthesizes any topic into structured knowledge cards via host LLM sampling.',
  author: 'kataenda',
  host_capabilities: ['llm.sample'],
  tools: [
    {
      name: 'research',
      description: 'Generate a structured research digest for any topic.',
      parameters: [
        { name: 'topic', type: 'string', description: 'The topic or question to research', required: true },
        { name: 'depth', type: 'string', description: 'Digest depth: quick | standard | deep', required: false, default: 'standard' },
      ],
    },
    {
      name: 'get_history',
      description: 'Retrieve all saved research digests from the library.',
      parameters: [],
    },
    {
      name: 'save_digest',
      description: 'Save an approved digest to the personal library.',
      parameters: [
        { name: 'digest', type: 'object', description: 'The full digest object to save', required: true },
      ],
    },
    {
      name: 'delete_digest',
      description: 'Remove a saved digest from the library.',
      parameters: [
        { name: 'id', type: 'string', description: 'The digest ID to delete', required: true },
      ],
    },
  ],
  runtime: { type: 'node', min_version: '18.0.0' },
};

// ─── Tool implementations ───────────────────────────────────────────────────────
async function research(args, invokeId) {
  const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
  if (!topic) throw new Error('topic is required');
  const depth = ['quick', 'standard', 'deep'].includes(args.depth) ? args.depth : 'standard';

  const depthConfig = {
    quick:    { points: 3, concepts: 3, instruction: 'Provide a quick overview.' },
    standard: { points: 5, concepts: 5, instruction: 'Provide a thorough overview.' },
    deep:     { points: 7, concepts: 7, instruction: 'Provide an in-depth analysis.' },
  };
  const cfg = depthConfig[depth];

  const systemPrompt = `You are a research analyst. Return ONLY valid JSON — no markdown fences, no extra text.
The JSON must match this exact structure:
{
  "title": "string (Research Digest: <topic>)",
  "summary": "string (2-3 sentences executive summary)",
  "key_points": ["string", ...] (exactly ${cfg.points} points),
  "concepts": [{"term": "string", "definition": "string (1-2 sentences)"}, ...] (exactly ${cfg.concepts} concepts),
  "related_topics": ["string", "string", "string"] (exactly 3 suggestions),
  "confidence": "high | medium | low"
}`;

  const result = await sampling.createMessage({
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: `${cfg.instruction} Research topic: "${topic}"` },
      },
    ],
    systemPrompt,
    maxTokens: 1500,
    metadata: { executa_invoke_id: invokeId, tool: 'research' },
    timeoutMs: 60_000,
  });

  const content = result.content || {};
  let raw = content.type === 'text' ? String(content.text || '') : '';
  raw = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

  const digest = JSON.parse(raw);
  return {
    ...digest,
    id: `digest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    topic,
    depth,
    model: result.model,
    generated_at: new Date().toISOString(),
  };
}

function getHistory() {
  const state = loadState();
  return { digests: state.digests ?? [] };
}
function saveDigest(args) {
  const digest = args.digest;
  if (!digest || !digest.id) throw new Error('digest object with id is required');
  const state = loadState();
  state.digests = state.digests ?? [];
  if (!state.digests.find((d) => d.id === digest.id)) {
    state.digests.unshift(digest);
    state.digests = state.digests.slice(0, 100);
    saveState(state);
  }
  return { saved: true, id: digest.id };
}
function deleteDigest(args) {
  const id = args.id;
  if (!id) throw new Error('id is required');
  const state = loadState();
  state.digests = (state.digests ?? []).filter((d) => d.id !== id);
  saveState(state);
  return { deleted: true, id };
}

// ─── Protocol handlers ──────────────────────────────────────────────────────────
function makeResponse(id, { result, error } = {}) {
  const out = { jsonrpc: '2.0', id };
  if (error) out.error = error;
  else out.result = result;
  return out;
}

function handleInitialize(reqId, params) {
  const proto = (params && params.protocolVersion) || '1.1';
  if (proto !== PROTOCOL_VERSION_V2) {
    sampling.disable(
      `host did not negotiate v2 (offered protocolVersion=${proto}); ` +
      'sampling/createMessage requires Executa protocol 2.0'
    );
  }
  return makeResponse(reqId, {
    result: {
      protocolVersion: proto === PROTOCOL_VERSION_V2 ? '2.0' : '1.1',
      serverInfo: { name: MANIFEST.display_name, version: MANIFEST.version },
      client_capabilities: proto === PROTOCOL_VERSION_V2 ? { sampling: {} } : {},
      capabilities: {},
    },
  });
}

async function handleInvoke(reqId, params) {
  const tool = params && params.tool;
  const args = (params && params.arguments) || {};
  const invokeId = (params && params.invoke_id) || '';
  try {
    let data;
    switch (tool) {
      case 'research':      data = await research(args, invokeId); break;
      case 'get_history':   data = getHistory();                   break;
      case 'save_digest':   data = saveDigest(args);               break;
      case 'delete_digest': data = deleteDigest(args);             break;
      default:
        return makeResponse(reqId, { error: { code: -32601, message: `Unknown tool: ${tool}` } });
    }
    return makeResponse(reqId, { result: { success: true, tool, data } });
  } catch (err) {
    if (err instanceof SamplingError) {
      return makeResponse(reqId, { error: { code: err.code, message: err.message, data: err.data } });
    }
    return makeResponse(reqId, { error: { code: -32603, message: `Tool execution failed: ${err.message}` } });
  }
}

async function handleMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    writeFrame(makeResponse(null, { error: { code: -32700, message: 'Parse error' } }));
    return;
  }

  // Reverse-RPC reply from host → resolve a pending sampling promise.
  if (!('method' in msg)) {
    if (!sampling.dispatchResponse(msg)) {
      process.stderr.write(`unmatched response id=${JSON.stringify(msg.id)}\n`);
    }
    return;
  }

  const { method, id: reqId } = msg;
  const params = msg.params || {};
  let resp;
  switch (method) {
    case 'initialize': resp = handleInitialize(reqId, params);     break;
    case 'describe':   resp = makeResponse(reqId, { result: MANIFEST }); break;
    case 'invoke':     resp = await handleInvoke(reqId, params);   break;
    case 'health':     resp = makeResponse(reqId, { result: { status: 'healthy', version: MANIFEST.version } }); break;
    case 'shutdown':   resp = makeResponse(reqId, { result: { ok: true } }); break;
    default:           resp = makeResponse(reqId, { error: { code: -32601, message: `Method not found: ${method}` } });
  }
  if (reqId != null) writeFrame(resp);
}

// ─── Main loop ──────────────────────────────────────────────────────────────────
function main() {
  process.stderr.write('research-processor plugin started (protocol v2, host sampling)\n');
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    handleMessage(trimmed).catch((err) => {
      process.stderr.write(`handler error: ${err.stack || err}\n`);
    });
  });
  rl.on('close', () => process.exit(0));
}

main();
