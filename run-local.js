/**
 * Local dev entry point for Research Digest AI.
 *
 * This is a thin wrapper around server.js (the same server used in production).
 * It just applies local-friendly defaults, then starts the real server.
 *
 * Run:
 *   Windows PowerShell:  $env:ANTHROPIC_API_KEY = "sk-ant-..."; node run-local.js
 *   macOS / Linux:       ANTHROPIC_API_KEY=sk-ant-... node run-local.js
 *
 * Then open http://localhost:3000
 */

process.env.PORT = process.env.PORT || '3000';
process.env.HOST = process.env.HOST || '127.0.0.1';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\n  ERROR: ANTHROPIC_API_KEY environment variable is not set.');
  console.error('  Set it first:');
  console.error('    Windows PowerShell:  $env:ANTHROPIC_API_KEY = "sk-ant-..."');
  console.error('    macOS / Linux:       export ANTHROPIC_API_KEY=sk-ant-...\n');
  process.exit(1);
}

await import('./server.js');
