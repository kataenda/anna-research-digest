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

The AI is the engine of every result, not a decoration. Claude (`claude-opus-4-8`) runs inside an Anna Tool and is constrained to return **strict, typed JSON**, which the UI renders as structured cards — i.e. AI producing structured app state. Depth control changes the synthesis, and a per-digest confidence level (high/medium/low) helps the human reviewer judge trustworthiness. A companion Anna Skill lets the same capability work conversationally in chat, including the human-review handoff.

## How it connects to Anna

Built natively on Anna primitives:
- **App + Manifest (v1)** — UI bundle, permissions, views, `host_api`
- **Tool (executa)** — `research-processor`, a JSON-RPC plugin (`research`, `get_history`, `save_digest`, `delete_digest`)
- **Skill (executa)** — `research-coach`, in-chat behavior that drives the tool
- **Runtime APIs** — `tools.invoke` (synthesis + library), `storage` (persistent digests), `chat.write_message` (save confirmation back to Anna chat)
- **Permissions** — `storage.read`, `storage.write`, `tools.invoke`, `chat.write_message`

## Why it fits the judging criteria

- **Usefulness** — a real everyday research workflow with a persistent library
- **Working demo** — runs end-to-end locally (`node run-local.js`) and as a deployed web service (Docker/Coolify)
- **Meaningful AI** — structured generation + depth + confidence, core to the app
- **Fit with Anna** — App + Manifest + Tool + Skill, using tools/storage/chat
- **Creativity & execution** — human-in-the-loop review, related-topic chaining, clean structured-card UI
