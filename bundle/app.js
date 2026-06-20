import { AnnaAppRuntime } from '/static/anna-apps/_sdk/latest/index.js';

// This app "borrows" the Anna runtime: research synthesis uses the host LLM
// (anna.llm.complete) and the library uses host storage (anna.storage).
// No custom executa/tool is needed — everything runs through host APIs.
const STORAGE_KEY = 'research-digest:digests';
const DEPTHS = {
  quick:    { points: 3, concepts: 3, instruction: 'Provide a quick overview.' },
  standard: { points: 5, concepts: 5, instruction: 'Provide a thorough overview.' },
  deep:     { points: 7, concepts: 7, instruction: 'Provide an in-depth analysis.' },
};

let anna = null;
let currentDigest = null;
let selectedDepth = 'standard';
let isSaved = false;

// Lightweight diagnostic logging (console only — no on-screen overlay).
function dbg(msg) {
  try { console.log('[RDG]', msg); } catch {}
}

function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(
      `${label} timed out after ${ms / 1000}s — the tool ran but no LLM result came back. This usually means the Anna Agent is too old to relay sampling. Upgrade the Agent (⟲ on the executa card) and retry.`
    )), ms)),
  ]);
}

// ── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  dbg('init — build v0.6-hostllm');
  await connectWithRetry(4);
  setupListeners();
  await loadHistory();
}

// Anna occasionally serves a stale SDK on first load (intermittent "token version
// mismatch"); retrying the handshake recovers it without a manual reload.
async function connectWithRetry(tries) {
  for (let i = 1; i <= tries; i++) {
    try {
      anna = await AnnaAppRuntime.connect();
      dbg('connected (try ' + i + '): llm=' + !!anna?.llm?.complete + ' storage=' + !!anna?.storage?.get);
      hideError();
      return;
    } catch (err) {
      dbg('connect attempt ' + i + ' failed: ' + (err?.message || err));
      if (i < tries) {
        await new Promise((r) => setTimeout(r, 500 * i));
      } else {
        showReconnect();
      }
    }
  }
}

function showReconnect() {
  let b = document.getElementById('global-error');
  if (!b) { showError(''); b = document.getElementById('global-error'); }
  b.innerHTML = '⚠ Couldn\'t reach the Anna runtime. ';
  const a = document.createElement('button');
  a.textContent = 'Reconnect';
  a.style.cssText = 'margin-left:8px;background:#b04141;color:#fff;border:0;border-radius:5px;padding:3px 10px;cursor:pointer;font-size:12px';
  a.addEventListener('click', async (e) => {
    e.stopPropagation();
    b.textContent = 'Reconnecting…';
    await connectWithRetry(3);
    if (anna) { await loadHistory(); showToast('Reconnected'); }
  });
  b.appendChild(a);
  b.style.display = 'block';
}

// ── EVENT WIRING ─────────────────────────────────────────────────────────────
function setupListeners() {
  document.getElementById('research-btn').addEventListener('click', onResearchClick);

  document.getElementById('topic-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onResearchClick();
  });

  document.querySelectorAll('.depth-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.depth-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedDepth = btn.dataset.depth;
    });
  });

  document.querySelectorAll('.example-topic').forEach((el) => {
    el.addEventListener('click', () => {
      document.getElementById('topic-input').value = el.dataset.topic;
      onResearchClick();
    });
  });

  document.getElementById('btn-save').addEventListener('click', onSave);
  document.getElementById('btn-discard').addEventListener('click', onDiscard);
  document.getElementById('error-close')?.addEventListener('click', hideError);

  const onExport = (fn) => async () => {
    if (!currentDigest) return;
    try { await fn(currentDigest); }
    catch (e) { showError('Export failed: ' + (e?.message || e)); }
  };
  document.getElementById('btn-export-pdf').addEventListener('click', onExport(exportPDF));
  document.getElementById('btn-export-word').addEventListener('click', onExport(exportWord));
  document.getElementById('btn-export-ppt').addEventListener('click', onExport(exportPPT));
  document.getElementById('btn-export-md').addEventListener('click', onExport(copyMarkdown));
}

// ── RESEARCH ─────────────────────────────────────────────────────────────────
async function onResearchClick() {
  const topic = document.getElementById('topic-input').value.trim();
  if (!topic) {
    document.getElementById('topic-input').focus();
    return;
  }
  await doResearch(topic, selectedDepth);
}

async function doResearch(topic, depth) {
  showLoading(topic);
  hideError();
  isSaved = false;
  currentDigest = null;

  try {
    const result = await generateDigest(topic, depth);
    currentDigest = result;
    renderDigest(result);
    setWindowTitle(result.title);
  } catch (err) {
    showEmptyState();
    showError(err.message || 'Research failed.');
  }
}

// ── LLM SYNTHESIS (host runtime) ──────────────────────────────────────────────
async function generateDigest(topic, depth) {
  if (!anna?.llm?.complete) throw new Error('Anna runtime not connected. Please run inside Anna.');
  const cfg = DEPTHS[depth] ?? DEPTHS.standard;
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
  const userText = `${cfg.instruction} Research topic: "${topic}"`;

  dbg('llm.complete → depth=' + depth + ' topic="' + topic + '"');
  const res = await withTimeout(
    anna.llm.complete({
      messages: [{ role: 'user', content: { type: 'text', text: userText } }],
      systemPrompt,
      maxTokens: 1500,
      includeContext: 'none',
    }),
    60000,
    'llm.complete'
  );
  dbg('llm.complete ← ' + JSON.stringify(res ?? null).slice(0, 200));

  // MCP-shaped result: { content: {type:'text', text} } | { content: [{text}] } | { text }
  const c = res?.content;
  let raw = '';
  if (typeof c === 'string') raw = c;
  else if (c && typeof c === 'object' && typeof c.text === 'string') raw = c.text;
  else if (Array.isArray(c)) raw = c.map((p) => p?.text ?? '').join('');
  else raw = res?.text ?? res?.completion ?? '';

  raw = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let digest;
  try {
    digest = JSON.parse(raw);
  } catch {
    throw new Error('Model did not return valid JSON. Got: ' + raw.slice(0, 160));
  }
  return {
    ...digest,
    id: `digest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    topic,
    depth,
    generated_at: new Date().toISOString(),
  };
}

// ── LIBRARY (host storage) ────────────────────────────────────────────────────
async function loadDigests() {
  if (!anna?.storage?.get) return [];
  try {
    const r = await anna.storage.get({ key: STORAGE_KEY });
    const v = (r && typeof r === 'object' && 'value' in r) ? r.value : r;
    return Array.isArray(v) ? v : [];
  } catch (e) {
    dbg('storage.get failed: ' + (e?.message || e));
    return [];
  }
}

async function saveDigests(arr) {
  if (!anna?.storage?.set) throw new Error('Storage not available in this runtime.');
  await anna.storage.set({ key: STORAGE_KEY, value: arr });
}

// ── SAVE / DISCARD ────────────────────────────────────────────────────────────
async function onSave() {
  if (!currentDigest || isSaved) return;

  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const arr = await loadDigests();
    if (!arr.some((d) => d.id === currentDigest.id)) {
      arr.unshift(currentDigest);
      await saveDigests(arr.slice(0, 100));
    }
    isSaved = true;
    btn.textContent = 'Saved!';
    showToast('Saved to library');

    if (anna?.chat?.write_message) {
      try {
        await anna.chat.write_message({
          role: 'assistant',
          content: `Research digest saved: **${currentDigest.title}**. You can find it in your library anytime.`,
        });
      } catch {}
    }

    await loadHistory();
  } catch (err) {
    showError('Failed to save: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Save to Library';
  }
}

function onDiscard() {
  currentDigest = null;
  document.getElementById('topic-input').value = '';
  showEmptyState();
  setWindowTitle('Research Digest AI');
}

// ── HISTORY ───────────────────────────────────────────────────────────────────
async function loadHistory() {
  if (!anna) return;
  try {
    renderHistory(await loadDigests());
  } catch (err) {
    dbg('loadHistory failed: ' + (err?.message || err));
  }
}

async function deleteFromHistory(id, event) {
  event.stopPropagation();
  // Note: window.confirm() is blocked inside Anna's sandboxed iframe, so we
  // delete directly and surface a toast (undo-free, single-click remove).
  try {
    const arr = (await loadDigests()).filter((d) => d.id !== id);
    await saveDigests(arr);
    if (currentDigest?.id === id) {
      currentDigest = null;
      showEmptyState();
    }
    await loadHistory();
    showToast('Removed from library');
  } catch (err) {
    showError('Failed to delete: ' + err.message);
  }
}

// ── RENDER ────────────────────────────────────────────────────────────────────
function renderDigest(d) {
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('loading').style.display = 'none';

  document.getElementById('digest-title').textContent = d.title;

  const depthTag = document.getElementById('digest-depth-tag');
  depthTag.textContent = d.depth ?? 'standard';
  depthTag.className = `depth-tag ${d.depth ?? 'standard'}`;

  document.getElementById('digest-time').textContent = d.generated_at
    ? new Date(d.generated_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
    : '';

  const confEl = document.getElementById('digest-confidence');
  if (d.confidence) {
    confEl.textContent = d.confidence;
    confEl.className = `confidence-badge ${d.confidence}`;
    confEl.style.display = '';
  } else {
    confEl.style.display = 'none';
  }

  document.getElementById('digest-summary').textContent = d.summary ?? '';

  const pointsEl = document.getElementById('digest-points');
  pointsEl.innerHTML = '';
  (d.key_points ?? []).forEach((pt) => {
    const li = document.createElement('li');
    li.textContent = pt;
    pointsEl.appendChild(li);
  });

  const conceptsEl = document.getElementById('digest-concepts');
  conceptsEl.innerHTML = '';
  (d.concepts ?? []).forEach((c) => {
    const div = document.createElement('div');
    div.className = 'concept-item';
    div.innerHTML = `<div class="concept-term">${escHtml(c.term)}</div>
                     <div class="concept-def">${escHtml(c.definition)}</div>`;
    conceptsEl.appendChild(div);
  });

  const relatedEl = document.getElementById('digest-related');
  relatedEl.innerHTML = '';
  (d.related_topics ?? []).forEach((topic) => {
    const tag = document.createElement('span');
    tag.className = 'related-tag';
    tag.textContent = topic;
    tag.addEventListener('click', () => {
      document.getElementById('topic-input').value = topic;
      doResearch(topic, selectedDepth);
    });
    relatedEl.appendChild(tag);
  });

  const saveBtn = document.getElementById('btn-save');
  saveBtn.disabled = false;
  saveBtn.textContent = 'Save to Library';

  const view = document.getElementById('digest-view');
  view.classList.add('visible');
  view.style.display = 'block';
}

function renderHistory(digests) {
  const list = document.getElementById('history-list');
  document.getElementById('history-count').textContent =
    digests.length === 1 ? '1 saved' : `${digests.length} saved`;

  if (digests.length === 0) {
    list.innerHTML = '<div class="history-empty">No saved digests yet.<br>Research a topic and save it here.</div>';
    return;
  }

  list.innerHTML = '';
  digests.forEach((d) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.dataset.id = d.id;

    const date = d.generated_at
      ? new Date(d.generated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : '';

    item.innerHTML = `
      <div class="history-topic">${escHtml(d.topic)}</div>
      <div class="history-meta">
        <span class="depth-tag ${d.depth ?? 'standard'}">${d.depth ?? 'standard'}</span>
        <span>${date}</span>
      </div>
      <button class="history-delete" title="Remove" data-id="${escHtml(d.id)}">✕</button>
    `;

    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('history-delete')) {
        deleteFromHistory(e.target.dataset.id, e);
        return;
      }
      currentDigest = d;
      isSaved = true;
      renderDigest(d);
      setWindowTitle(d.title);
      document.querySelectorAll('.history-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      const saveBtn = document.getElementById('btn-save');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saved';
    });

    list.appendChild(item);
  });
}

// ── UI STATE HELPERS ──────────────────────────────────────────────────────────
function showLoading(topic) {
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('digest-view').style.display = 'none';
  document.getElementById('digest-view').classList.remove('visible');
  document.getElementById('loading-topic').textContent = `Researching: ${topic}`;
  document.getElementById('loading').style.display = 'flex';
  document.getElementById('research-btn').disabled = true;
  document.getElementById('research-btn').textContent = 'Researching...';
}

function showEmptyState() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('digest-view').style.display = 'none';
  document.getElementById('digest-view').classList.remove('visible');
  document.getElementById('empty-state').style.display = '';
  resetBtn();
}

function resetBtn() {
  const btn = document.getElementById('research-btn');
  btn.disabled = false;
  btn.textContent = 'Research';
}

function showError(msg) {
  let b = document.getElementById('global-error');
  if (!b) {
    b = document.createElement('div');
    b.id = 'global-error';
    b.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;max-width:92%;background:#4a1414;color:#ffd9d9;border:1px solid #b04141;padding:10px 16px;border-radius:8px;font-size:13px;line-height:1.4;box-shadow:0 6px 20px rgba(0,0,0,.45);cursor:pointer;white-space:pre-wrap';
    b.title = 'Click to dismiss';
    b.addEventListener('click', () => { b.style.display = 'none'; });
    document.body.appendChild(b);
  }
  b.textContent = '⚠ ' + msg;
  b.style.display = 'block';
  resetBtn();
}

function hideError() {
  const b = document.getElementById('global-error');
  if (b) b.style.display = 'none';
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

async function setWindowTitle(title) {
  if (anna?.window?.set_title) {
    try { await anna.window.set_title({ title }); } catch {}
  }
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── EXPORT (PDF / Word / PowerPoint / Markdown) ───────────────────────────────
const _scripts = {};
function loadScript(src) {
  if (_scripts[src]) return _scripts[src];
  _scripts[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
  return _scripts[src];
}

function safeName(d) {
  return String(d.topic || d.title || 'research-digest')
    .replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60).toLowerCase() || 'research-digest';
}

function downloadBlob(blob, filename) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
    return true;
  } catch {
    return false;
  }
}

function digestToMarkdown(d) {
  const out = [`# ${d.title || 'Research Digest'}`, ''];
  out.push(`*Confidence: ${d.confidence || '—'} · Depth: ${d.depth || 'standard'}*`, '');
  out.push('## Summary', d.summary || '', '');
  out.push('## Key Points', ...(d.key_points || []).map((p) => `- ${p}`), '');
  out.push('## Key Concepts', ...(d.concepts || []).map((c) => `- **${c.term}** — ${c.definition}`), '');
  out.push('## Related Topics', (d.related_topics || []).join(', '), '');
  return out.join('\n');
}

function digestToHtml(d) {
  return `<h1>${escHtml(d.title || 'Research Digest')}</h1>`
    + `<p style="color:#666;font-style:italic">Confidence: ${escHtml(d.confidence || '—')} · Depth: ${escHtml(d.depth || 'standard')} · ${escHtml(new Date(d.generated_at || Date.now()).toLocaleString())}</p>`
    + `<h2>Summary</h2><p>${escHtml(d.summary || '')}</p>`
    + `<h2>Key Points</h2><ul>${(d.key_points || []).map((p) => `<li>${escHtml(p)}</li>`).join('')}</ul>`
    + `<h2>Key Concepts</h2><ul>${(d.concepts || []).map((c) => `<li><b>${escHtml(c.term)}</b> — ${escHtml(c.definition)}</li>`).join('')}</ul>`
    + `<h2>Related Topics</h2><p>${(d.related_topics || []).map(escHtml).join(', ')}</p>`;
}

async function copyMarkdown(d) {
  const md = digestToMarkdown(d);
  try {
    await navigator.clipboard.writeText(md);
    showToast('Markdown copied to clipboard');
  } catch {
    if (downloadBlob(new Blob([md], { type: 'text/markdown' }), safeName(d) + '.md')) showToast('Markdown downloaded');
    else showError('Clipboard and download are both blocked by the runtime sandbox.');
  }
}

function exportWord(d) {
  const html = `<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${escHtml(d.title || 'Research Digest')}</title></head><body style="font-family:Calibri,Arial,sans-serif;line-height:1.5">${digestToHtml(d)}</body></html>`;
  const blob = new Blob(['﻿' + html], { type: 'application/msword' });
  if (downloadBlob(blob, safeName(d) + '.doc')) showToast('Word document exported');
  else showError('Download is blocked by the runtime sandbox.');
}

async function exportPDF(d) {
  await loadScript('vendor/jspdf.umd.min.js');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 48;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const width = pageW - margin * 2;
  let y = margin;
  const ensure = (h) => { if (y + h > pageH - margin) { doc.addPage(); y = margin; } };
  const write = (str, size, style, color) => {
    doc.setFont('helvetica', style || 'normal');
    doc.setFontSize(size);
    doc.setTextColor(color || '#111111');
    doc.splitTextToSize(String(str), width).forEach((ln) => { ensure(size * 1.4); doc.text(ln, margin, y); y += size * 1.4; });
  };
  write(d.title || 'Research Digest', 20, 'bold');
  y += 4; write(`Confidence: ${d.confidence || '—'}   ·   Depth: ${d.depth || 'standard'}`, 10, 'italic', '#666666'); y += 12;
  write('Summary', 14, 'bold'); write(d.summary || '', 11); y += 10;
  write('Key Points', 14, 'bold'); (d.key_points || []).forEach((p) => write('•  ' + p, 11)); y += 10;
  write('Key Concepts', 14, 'bold'); (d.concepts || []).forEach((c) => write('•  ' + c.term + ' — ' + c.definition, 11)); y += 10;
  write('Related Topics', 14, 'bold'); write((d.related_topics || []).join(', '), 11);
  if (downloadBlob(doc.output('blob'), safeName(d) + '.pdf')) { showToast('PDF exported'); return; }
  try { doc.save(safeName(d) + '.pdf'); showToast('PDF exported'); }
  catch { showError('Download is blocked by the runtime sandbox.'); }
}

async function exportPPT(d) {
  await loadScript('vendor/pptxgen.bundle.js');
  const PptxGen = window.PptxGenJS;
  const pptx = new PptxGen();
  pptx.layout = 'LAYOUT_WIDE';
  const ACCENT = '7AA2F7';

  let s = pptx.addSlide();
  s.background = { color: '1A1B26' };
  s.addText(d.title || 'Research Digest', { x: 0.5, y: 2.0, w: 12.3, h: 1.4, fontSize: 34, bold: true, color: 'FFFFFF', align: 'center' });
  s.addText(`Confidence: ${d.confidence || '—'}   ·   Depth: ${d.depth || 'standard'}`, { x: 0.5, y: 3.5, w: 12.3, h: 0.5, fontSize: 14, color: 'A9B1D6', align: 'center' });

  s = pptx.addSlide();
  s.addText('Summary', { x: 0.5, y: 0.3, w: 12, h: 0.6, fontSize: 26, bold: true, color: ACCENT });
  s.addText(d.summary || '', { x: 0.5, y: 1.2, w: 12.3, h: 5, fontSize: 16, color: '363636' });

  s = pptx.addSlide();
  s.addText('Key Points', { x: 0.5, y: 0.3, w: 12, h: 0.6, fontSize: 26, bold: true, color: ACCENT });
  s.addText((d.key_points || []).map((p) => ({ text: p, options: { bullet: true } })), { x: 0.6, y: 1.2, w: 12.1, h: 5.6, fontSize: 16, color: '363636' });

  s = pptx.addSlide();
  s.addText('Key Concepts', { x: 0.5, y: 0.3, w: 12, h: 0.6, fontSize: 26, bold: true, color: ACCENT });
  s.addText((d.concepts || []).map((c) => ({ text: `${c.term}: ${c.definition}`, options: { bullet: true } })), { x: 0.6, y: 1.2, w: 12.1, h: 5.6, fontSize: 15, color: '363636' });

  s = pptx.addSlide();
  s.addText('Related Topics', { x: 0.5, y: 0.3, w: 12, h: 0.6, fontSize: 26, bold: true, color: ACCENT });
  s.addText((d.related_topics || []).map((t) => ({ text: t, options: { bullet: true } })), { x: 0.6, y: 1.2, w: 12.1, h: 4.5, fontSize: 18, color: '363636' });

  const blob = await pptx.write('blob');
  if (downloadBlob(blob, safeName(d) + '.pptx')) { showToast('PowerPoint exported'); return; }
  try { await pptx.writeFile({ fileName: safeName(d) + '.pptx' }); showToast('PowerPoint exported'); }
  catch { showError('Download is blocked by the runtime sandbox.'); }
}

// ── BOOT ─────────────────────────────────────────────────────────────────────
init();
