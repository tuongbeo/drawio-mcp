/**
 * worker.ts - Cloudflare Workers entry point
 * Web Standard APIs ONLY: fetch, Request, Response, URL, crypto
 *
 * KEY FIX: buildViewerHtml() calls Kroki API server-side -> ~2KB HTML.
 * Old approach embedded 266KB bundle in JSON -> Unexpected token error.
 */

import type { WorkerEnv } from './types.js';
import { createServer, DurableObjectSessionStore, KVSessionStore, InMemorySessionStore } from './shared.js';
import { DiagramSession } from './durable/DiagramSession.js';

export { DiagramSession };

// --- Viewer: Kroki SVG in minimal HTML ---

async function buildViewerHtml(xml: string, title: string, editUrl: string): Promise<string> {
  let svg = '';
  try {
    const resp = await fetch('https://kroki.io/drawio/svg', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: xml,
      signal: AbortSignal.timeout(8000),
    } as RequestInit);
    if (resp.ok) svg = await resp.text();
  } catch { /* fallback to link-only */ }

  const t = title.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  const u = editUrl.replace(/"/g,'&quot;');
  const body = svg
    ? `<div class="d">${svg}</div>`
    : `<div class="d"><div class="fb"><p>Preview unavailable</p><a class="bl" href="${u}" target="_blank" rel="noopener">Open in draw.io</a></div></div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>${t}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f5f5}
.h{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;background:#fff;border-bottom:1px solid #e0e0e0}
.t{font-size:14px;font-weight:600;color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%}
.btn{font-size:12px;color:#1565c0;text-decoration:none;padding:4px 10px;border:1px solid #1565c0;border-radius:4px}
.btn:hover{background:#e3f2fd}
.d{padding:16px;display:flex;align-items:flex-start;justify-content:center;min-height:calc(100vh - 42px)}
.d svg{max-width:100%;height:auto}
.fb{text-align:center;padding:40px 20px}
.fb p{color:#999;font-size:14px;margin-bottom:16px}
.bl{display:inline-block;padding:10px 20px;background:#f08705;color:#fff;text-decoration:none;border-radius:6px;font-size:14px}
</style>
</head>
<body>
<div class="h"><span class="t">${t}</span><a class="btn" href="${u}" target="_blank" rel="noopener">Open in draw.io</a></div>
${body}
</body>
</html>`;
}

// --- CORS ---

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

function cors(body: string, status: number, type = 'application/json'): Response {
  return new Response(body, { status, headers: { 'Content-Type': type, ...CORS } });
}

// --- MCP Transport ---

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

class WorkerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private _p: { resolve: (m: JSONRPCMessage) => void; reject: (e: Error) => void } | null = null;

  async start(): Promise<void> {}
  async close(): Promise<void> { this.onclose?.(); }

  async send(msg: JSONRPCMessage): Promise<void> {
    if (this._p) { const { resolve } = this._p; this._p = null; resolve(msg); }
  }

  processMessage(req: JSONRPCMessage): Promise<JSONRPCMessage | null> {
    const isNotif = !('id' in req) || (req as Record<string,unknown>).id == null;
    if (isNotif) { this.onmessage?.(req); return Promise.resolve(null); }
    return new Promise((resolve, reject) => {
      this._p = { resolve: resolve as (m: JSONRPCMessage) => void, reject };
      if (this.onmessage) this.onmessage(req);
      else reject(new Error('Transport not connected'));
    });
  }
}

// --- MCP Handler ---

async function handleMcp(req: Request, env: WorkerEnv): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method === 'GET') return cors(JSON.stringify({ jsonrpc:'2.0', result:{ status:'ready' } }), 200);
  if (req.method !== 'POST') return cors(JSON.stringify({ error:'Use POST /mcp' }), 405);

  let body: JSONRPCMessage;
  try { body = await req.json() as JSONRPCMessage; }
  catch { return cors(JSON.stringify({ jsonrpc:'2.0',id:null,error:{ code:-32700,message:'Parse error' } }), 400); }

  const sessions = env.DIAGRAM_SESSION
    ? new DurableObjectSessionStore(env.DIAGRAM_SESSION)
    : env.DIAGRAM_SESSIONS ? new KVSessionStore(env.DIAGRAM_SESSIONS) : new InMemorySessionStore();

  const transport = new WorkerTransport();
  const server = createServer({ getHtml: buildViewerHtml, sessions });
  await server.connect(transport);

  try {
    const method = (body as Record<string,unknown>).method as string | undefined;
    const isNotif = !('id' in body) || (body as Record<string,unknown>).id == null;
    if (isNotif) { transport.onmessage?.(body); return new Response(null, { status: 202, headers: CORS }); }

    if (method !== 'initialize') {
      await transport.processMessage({
        jsonrpc:'2.0', id:'__init__', method:'initialize',
        params:{ protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{ name:'claude.ai', version:'1' } },
      } as JSONRPCMessage);
      await transport.processMessage({ jsonrpc:'2.0', method:'notifications/initialized', params:{} } as JSONRPCMessage);
    }

    const result = await Promise.race([
      transport.processMessage(body),
      new Promise<never>((_,rej) => setTimeout(() => rej(new Error('Timeout 25s')), 25000)),
    ]);

    if (result === null) return new Response(null, { status: 202, headers: CORS });
    return cors(JSON.stringify(result), 200);
  } catch (err) {
    const id = 'id' in (body as object) ? (body as { id:unknown }).id : null;
    return cors(JSON.stringify({ jsonrpc:'2.0', id: id??null, error:{ code:-32603, message:String(err) } }), 500);
  } finally {
    await server.close().catch(() => {});
  }
}

// --- Main ---

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/mcp' || pathname === '/mcp/') {
      const r = await handleMcp(request, env);
      const h = new Headers(r.headers);
      h.set('Mcp-Session-Id', 'drawio-public-server');
      return new Response(r.body, { status: r.status, headers: h });
    }
    if (pathname === '/health' || pathname === '/') {
      return cors(JSON.stringify({ status:'ok', service:'drawio-mcp', version:'2.1.0', ts:new Date().toISOString() }), 200);
    }
    return cors(JSON.stringify({ error:`Not found: ${pathname}` }), 404);
  },
};
