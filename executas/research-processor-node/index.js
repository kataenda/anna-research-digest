import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';

const STATE_DIR = join(homedir(), '.anna', 'research-digest');
const STATE_FILE = join(STATE_DIR, 'state.json');

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

async function research({ topic, depth = 'standard' }) {
  if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
    throw new Error('topic is required');
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable not set. ' +
      'Add it via Anna credential settings.'
    );
  }

  const client = new Anthropic({ apiKey });

  const depthConfig = {
    quick:    { points: 3, concepts: 3, instruction: 'Provide a quick overview.' },
    standard: { points: 5, concepts: 5, instruction: 'Provide a thorough overview.' },
    deep:     { points: 7, concepts: 7, instruction: 'Provide an in-depth analysis.' },
  };
  const cfg = depthConfig[depth] ?? depthConfig.standard;

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

  const msg = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `${cfg.instruction} Research topic: "${topic.trim()}"`,
    }],
  });

  let raw = msg.content[0]?.text ?? '';
  raw = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

  const digest = JSON.parse(raw);
  return {
    ...digest,
    id: `digest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    topic: topic.trim(),
    depth,
    generated_at: new Date().toISOString(),
  };
}

function getHistory() {
  const state = loadState();
  return { digests: state.digests ?? [] };
}

function saveDigest({ digest }) {
  if (!digest || !digest.id) throw new Error('digest object with id is required');
  const state = loadState();
  state.digests = state.digests ?? [];
  if (!state.digests.find(d => d.id === digest.id)) {
    state.digests.unshift(digest);
    state.digests = state.digests.slice(0, 100);
    saveState(state);
  }
  return { saved: true, id: digest.id };
}

function deleteDigest({ id }) {
  if (!id) throw new Error('id is required');
  const state = loadState();
  state.digests = (state.digests ?? []).filter(d => d.id !== id);
  saveState(state);
  return { deleted: true, id };
}

function describe() {
  return {
    name: 'research-processor',
    version: '1.0.0',
    description: 'AI-powered research digest generator. Synthesizes topics into structured knowledge cards.',
    methods: [
      {
        name: 'research',
        description: 'Generate a structured research digest for any topic.',
        params: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'The topic or question to research' },
            depth: { type: 'string', enum: ['quick', 'standard', 'deep'], description: 'Digest depth' },
          },
          required: ['topic'],
        },
      },
      {
        name: 'get_history',
        description: 'Retrieve all saved research digests from the library.',
        params: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'save_digest',
        description: 'Save an approved digest to the personal library.',
        params: {
          type: 'object',
          properties: {
            digest: { type: 'object', description: 'The full digest object to save' },
          },
          required: ['digest'],
        },
      },
      {
        name: 'delete_digest',
        description: 'Remove a saved digest from the library.',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The digest ID to delete' },
          },
          required: ['id'],
        },
      },
    ],
  };
}

// JSON-RPC 2.0 over stdio
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = request;

  const respond = (payload) => {
    process.stdout.write(JSON.stringify(payload) + '\n');
  };

  try {
    let result;
    const p = params ?? {};

    switch (method) {
      case 'describe':     result = describe();          break;
      case 'research':     result = await research(p);   break;
      case 'get_history':  result = getHistory();        break;
      case 'save_digest':  result = saveDigest(p);       break;
      case 'delete_digest': result = deleteDigest(p);   break;
      default:
        throw Object.assign(new Error(`Unknown method: ${method}`), { code: -32601 });
    }

    respond({ jsonrpc: '2.0', id, result });
  } catch (err) {
    respond({
      jsonrpc: '2.0',
      id,
      error: { code: err.code ?? -32603, message: err.message },
    });
  }
});
