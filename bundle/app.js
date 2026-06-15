import { connect } from '/static/anna-apps/_sdk/latest/index.js';

// Resolved at publish time by Anna runtime; fallback lets us test locally
const TOOL_ID = window.__ANNA_TOOL_IDS__?.['research-processor'] ?? 'tool-kataenda-research-processor-kfj4mr5e';

let anna = null;
let currentDigest = null;
let selectedDepth = 'standard';
let isSaved = false;

// ── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  try {
    anna = await connect();
  } catch (err) {
    console.warn('Anna runtime not available — running in offline mode', err);
  }

  setupListeners();
  await loadHistory();
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
  document.getElementById('error-close').addEventListener('click', hideError);
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
    const result = await invokeToolOrFallback('research', { topic, depth });
    currentDigest = result;
    renderDigest(result);
    setWindowTitle(result.title);
  } catch (err) {
    showError(err.message || 'Research failed. Check your API key.');
    showEmptyState();
  }
}

// ── TOOL INVOCATION ───────────────────────────────────────────────────────────
async function invokeToolOrFallback(method, args) {
  if (anna) {
    const res = await anna.tools.invoke({ tool_id: TOOL_ID, method, args });
    if (res?.error) throw new Error(res.error.message ?? JSON.stringify(res.error));
    return res;
  }
  throw new Error('Anna runtime not connected. Please run inside Anna.');
}

// ── SAVE / DISCARD ────────────────────────────────────────────────────────────
async function onSave() {
  if (!currentDigest || isSaved) return;

  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    await invokeToolOrFallback('save_digest', { digest: currentDigest });
    isSaved = true;
    btn.textContent = 'Saved!';
    showToast('Saved to library');

    if (anna) {
      await anna.chat.write_message({
        role: 'assistant',
        content: `Research digest saved: **${currentDigest.title}**. You can find it in your library anytime.`,
      });
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
    const { digests } = await invokeToolOrFallback('get_history', {});
    renderHistory(digests ?? []);
  } catch (err) {
    console.warn('Could not load history:', err);
  }
}

async function deleteFromHistory(id, event) {
  event.stopPropagation();
  if (!confirm('Remove this digest from your library?')) return;

  try {
    await invokeToolOrFallback('delete_digest', { id });
    if (currentDigest?.id === id) {
      currentDigest = null;
      showEmptyState();
    }
    await loadHistory();
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
  const banner = document.getElementById('error-banner');
  document.getElementById('error-msg').textContent = msg;
  banner.style.display = '';
  resetBtn();
}

function hideError() {
  document.getElementById('error-banner').style.display = 'none';
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

async function setWindowTitle(title) {
  if (anna?.window?.set_title) {
    try { await anna.window.set_title(title); } catch {}
  }
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── BOOT ─────────────────────────────────────────────────────────────────────
init();
