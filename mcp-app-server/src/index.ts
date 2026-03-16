/**
 * index.ts — Node.js entry point
 * Supports two transports:
 *   - HTTP (Express + StreamableHTTPServerTransport) → default for remote access
 *   - stdio (StdioServerTransport) → Claude Desktop config
 *
 * Usage:
 *   npm run dev:node              → HTTP server on :3001/mcp
 *   node dist/index.js --stdio   → stdio transport
 */

import express from 'express';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  createServer,
  InMemorySessionStore,
  buildHtml,
  processAppBundle,
} from './shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// ─── Load bundles from node_modules at startup (Node.js only) ────────────────

function loadBundle(candidates: string[]): string {
  for (const c of candidates) {
    const p = join(root, 'node_modules', c);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return '// bundle not found';
}

const APP_BUNDLE_RAW = loadBundle([
  '@modelcontextprotocol/ext-apps/dist/app-with-deps.js',
  '@modelcontextprotocol/ext-apps/dist/index.js',
  '@modelcontextprotocol/ext-apps/app-with-deps.js',
]);
const APP_BUNDLE = processAppBundle(APP_BUNDLE_RAW);

const PAKO_BUNDLE = loadBundle([
  'pako/dist/pako_deflate.min.js',
  'pako/dist/pako.min.js',
]);

function getHtml(xml: string, title: string, editUrl: string): string {
  return buildHtml(APP_BUNDLE, PAKO_BUNDLE, xml, title, editUrl);
}

// ─── Shared session store (in-memory for Node.js) ─────────────────────────────

const sessions = new InMemorySessionStore();

// ─── stdio Transport ──────────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  const server = createServer({ getHtml, sessions });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep process alive
  process.stdin.resume();
}

// ─── HTTP Transport ───────────────────────────────────────────────────────────

async function runHttp(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // CORS preflight
  app.options('/mcp', (_req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
    res.sendStatus(204);
  });

  // MCP endpoint — stateless: new transport per request
  app.post('/mcp', async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });

    res.on('close', () => {
      transport.close().catch(() => {/* ignore */});
    });

    const server = createServer({ getHtml, sessions });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Health
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'drawio-mcp', version: '2.0.0', ts: new Date().toISOString() });
  });

  app.get('/', (_req, res) => {
    res.json({ status: 'ok', mcp_endpoint: '/mcp', docs: 'https://github.com/tuongbeo/drawio-mcp' });
  });

  const PORT = parseInt(process.env.PORT ?? '3001', 10);
  app.listen(PORT, () => {
    console.error(`✓ drawio-mcp Node.js server running at http://localhost:${PORT}/mcp`);
    console.error(`  Add to Claude.ai: Settings → Connectors → Add custom → http://localhost:${PORT}/mcp`);
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const useStdio = process.argv.includes('--stdio');

if (useStdio) {
  runStdio().catch((err) => {
    console.error('stdio error:', err);
    process.exit(1);
  });
} else {
  runHttp().catch((err) => {
    console.error('HTTP server error:', err);
    process.exit(1);
  });
}
