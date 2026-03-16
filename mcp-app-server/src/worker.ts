/**
 * worker.ts — Cloudflare Workers entry point
 * Web Standard APIs ONLY: fetch, Request, Response, URL, crypto, TextEncoder, btoa
 * No: Buffer, fs, path, require()
 *
 * MCP transport: Stateless JSON-RPC over HTTP POST /mcp
 * Sessions: Cloudflare Durable Objects (DiagramSession)
 * HTML: Pre-built at build time via build-html.ts → generated-html.ts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkerEnv } from './types.js';
import { createServer, DurableObjectSessionStore, KVSessionStore } from './shared.js';
import { DiagramSession } from './durable/DiagramSession.js';
// Generated at build time — contains pre-inlined SDK bundles
import { buildPrebuiltHtml } from './generated-html.js';

// Re-export Durable Object class for wrangler binding
export { DiagramSession };

// ─── CORS Headers ────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
};

function corsResponse(body: string, status: number, contentType = 'application/json'): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': contentType, ...CORS_HEADERS },
  });
}

// ─── Worker Fetch Transport ──────────────────────────────────────────────────
// Adapts MCP SDK's McpServer to the Web Standard Request/Response API.
// Each request creates a fresh McpServer instance (stateless per-request).

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

class WorkerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private _pendingResponse: {
    resolve: (msg: JSONRPCMessage) => void;
    reject: (err: Error) => void;
  } | null = null;

  async start(): Promise<void> {
    // No-op: connection starts when processMessage is called
  }

  async close(): Promise<void> {
    this.onclose?.();
  }

  /** Called by McpServer to send the response back to the client */
  async send(message: JSONRPCMessage): Promise<void> {
    if (this._pendingResponse) {
      const { resolve } = this._pendingResponse;
      this._pendingResponse = null;
      resolve(message);
    }
  }

  /** Main entry: feed a JSON-RPC request in, get the response out.
   *  Notifications (no id field) don't expect a response — return null immediately.
   */
  processMessage(request: JSONRPCMessage): Promise<JSONRPCMessage | null> {
    // Notifications have no id — fire-and-forget, no response expected
    const isNotification =
      !('id' in request) ||
      (request as Record<string, unknown>).id === undefined ||
      (request as Record<string, unknown>).id === null;

    if (isNotification) {
      this.onmessage?.(request);
      return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
      this._pendingResponse = { resolve: resolve as (msg: JSONRPCMessage) => void, reject };

      // Deliver to McpServer — triggers onmessage → handler → send()
      if (this.onmessage) {
        this.onmessage(request);
      } else {
        reject(new Error('Transport not connected to server'));
      }
    });
  }
}

// ─── MCP Request Handler ─────────────────────────────────────────────────────

async function handleMcpRequest(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // GET /mcp — some clients probe the endpoint before connecting
  if (request.method === 'GET') {
    return corsResponse(JSON.stringify({ jsonrpc: '2.0', result: { status: 'ready' } }), 200);
  }

  if (request.method !== 'POST') {
    return corsResponse(
      JSON.stringify({ error: 'Method Not Allowed — use POST /mcp' }),
      405,
    );
  }

  let body: JSONRPCMessage;
  try {
    body = await request.json() as JSONRPCMessage;
  } catch {
    return corsResponse(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: invalid JSON' } }),
      400,
    );
  }

  // Build session store — priority: Durable Objects > KV > in-memory
  // Durable Objects: paid plan only ($5/mo) — best persistence
  // KV: free tier, 24h TTL — run `wrangler kv namespace create DIAGRAM_SESSIONS` to enable
  // in-memory: fallback, sessions lost between requests on free tier
  const sessionStore = env.DIAGRAM_SESSION
    ? new DurableObjectSessionStore(env.DIAGRAM_SESSION)
    : env.DIAGRAM_SESSIONS
      ? new KVSessionStore(env.DIAGRAM_SESSIONS)
      : buildFallbackStore();

  // Create transport + server
  const transport = new WorkerTransport();
  const server = createServer({
    getHtml: (xml, title, editUrl) => buildPrebuiltHtml(xml, title, editUrl),
    sessions: sessionStore,
  });

  // Connect server to transport
  await server.connect(transport);

  try {
    const method = (body as Record<string, unknown>).method as string | undefined;

    // Notifications (no id) — fire-and-forget, return 202 immediately
    const isNotification =
      !('id' in body) ||
      (body as Record<string, unknown>).id === undefined ||
      (body as Record<string, unknown>).id === null;

    if (isNotification) {
      transport.onmessage?.(body);
      return new Response(null, { status: 202, headers: CORS_HEADERS });
    }

    // Auto-initialize: each Worker request creates a fresh McpServer instance.
    // For non-initialize requests the SDK requires the server to have already
    // completed the initialize handshake, so we do it silently here.
    if (method !== 'initialize') {
      await transport.processMessage({
        jsonrpc: '2.0',
        id: '__auto_init__',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'claude.ai', version: '1.0' },
        },
      } as JSONRPCMessage);
      // Response discarded — server is now in initialized state
    }

    // Process the actual request
    const response = await Promise.race([
      transport.processMessage(body),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Request timeout (25s)')), 25_000),
      ),
    ]);

    if (response === null) {
      return new Response(null, { status: 202, headers: CORS_HEADERS });
    }

    return corsResponse(JSON.stringify(response), 200);
  } catch (err) {
    const id = 'id' in (body as object) ? (body as { id: unknown }).id : null;
    return corsResponse(
      JSON.stringify({
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code: -32603, message: `Internal error: ${String(err)}` },
      }),
      500,
    );
  } finally {
    await server.close().catch(() => {/* ignore cleanup errors */});
  }
}

// ─── Fallback in-memory store (free tier — no Durable Objects) ───────────────

import { InMemorySessionStore } from './shared.js';

function buildFallbackStore(): InMemorySessionStore {
  // WARNING: in-memory sessions DON'T persist across Worker requests on free tier.
  // Sessions created in one request will NOT be found in the next request.
  //
  // To enable persistent sessions without paying for DO:
  //   1. Run: npx wrangler kv namespace create DIAGRAM_SESSIONS
  //   2. Add to wrangler.toml:
  //        [[kv_namespaces]]
  //        binding = "DIAGRAM_SESSIONS"
  //        id = "<your-namespace-id>"
  //   3. Redeploy: npm run deploy
  //
  // The error "Session not found" on free tier is expected — switch to KV.
  return new InMemorySessionStore();
}

// ─── Health Check ─────────────────────────────────────────────────────────────

function handleHealth(): Response {
  return corsResponse(
    JSON.stringify({
      status: 'ok',
      service: 'drawio-mcp',
      version: '2.0.0',
      endpoint: '/mcp',
      transport: 'streamable-http-stateless',
      ts: new Date().toISOString(),
    }),
    200,
  );
}

// ─── Main Fetch Handler ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/mcp':
      case '/mcp/':
        return handleMcpRequest(request, env);

      case '/health':
      case '/':
        return handleHealth();

      default:
        return corsResponse(
          JSON.stringify({ error: `Not found: ${url.pathname}` }),
          404,
        );
    }
  },
};
