# Research Digest AI — Hackathon Submission

**Tagline:** Turn any topic into a structured, reviewable knowledge digest — AI synthesizes, you approve, your library remembers.

**Links**
- Repo: https://github.com/kataenda/anna-research-digest
- Live demo: https://annaresearch.soenic.com
- Demo video: https://youtu.be/QdnF-ZqskO8

---

## What we built

Research Digest AI is an AI-native research assistant on Anna. You type any topic, pick a depth (Quick / Standard / Deep Dive), and Claude synthesizes it into four structured cards — **Summary, Key Points, Key Concepts, and Related Topics** — plus a confidence signal. You then **review and approve** the digest before it's saved to a persistent library, and you can chain into any related topic with one click. It's a complete workflow, not a chat window.

## Who it's for

Anyone who learns or researches fast: students, developers, analysts, and curious people who want a clean, scannable briefing on a topic instead of wading through a wall of chat text — and who want to keep what they save.

## How AI is used (meaningfully)

The AI is the engine of every result, not a decoration. The app **borrows the Anna AI runtime**: it calls the host LLM directly via `anna.llm.complete`, constrained to return **strict, typed JSON**, which the UI renders as structured cards — i.e. AI producing structured app state, not free-form text. Depth control changes the synthesis (3/5/7 points), and a per-digest confidence level (high/medium/low) helps the human reviewer judge trustworthiness. No third-party API key is needed — model selection, billing, and quota are owned by Anna. A companion Anna Skill lets the same capability work conversationally in chat, including the human-review handoff.

## How it connects to Anna

Built natively on Anna primitives — the app runs entirely on host APIs, no custom backend:
- **App + Manifest (schema v2)** — UI bundle, permissions, views, `host_api`
- **Host LLM** — `anna.llm.complete` generates every digest (the "borrow an AI runtime" pattern)
- **Host storage** — `anna.storage.get/set` persists the approved digest library
- **Skill (executa)** — `research-coach`, a declarative `SKILL.md` that picks depth and enforces the human-review protocol in chat
- **Host APIs** — `anna.chat.write_message` (save confirmation back to Anna chat), `anna.window.set_title`
- **Permissions** — `llm.complete`, `storage.read`, `storage.write`, `chat.write_message`, `ui.svg`

## Why it fits the judging criteria

- **Usefulness** — a real everyday research workflow with a persistent library
- **Working demo** — runs natively inside Anna (host LLM + storage) and as a standalone deployed web service (Docker/Coolify)
- **Meaningful AI** — structured generation + depth + confidence, core to the app, powered by Anna's own LLM (no third-party key)
- **Fit with Anna** — App + Manifest + Skill + host APIs (`llm.complete`, `storage`, `chat`); it borrows the Anna AI runtime instead of shipping its own backend
- **Creativity & execution** — human-in-the-loop review, related-topic chaining, clean structured-card UI
