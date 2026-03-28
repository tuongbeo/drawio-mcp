/**
 * worker.ts - Cloudflare Workers entry point
 * Web Standard APIs ONLY: fetch, Request, Response, URL, crypto
 *
 * Renders draw.io XML as SVG inline — no external service needed.
 * mxGraphToSvg() parses mxGraphModel XML and produces a native SVG.
 */

import type { WorkerEnv } from './types.js';
import { createServer, DurableObjectSessionStore, KVSessionStore, InMemorySessionStore } from './shared.js';
import { DiagramSession } from './durable/DiagramSession.js';

export { DiagramSession };

// ─── mxGraph XML → SVG renderer ──────────────────────────────────────────────
// Pure Worker-compatible renderer. Parses mxCell elements and produces SVG.

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function attr(style: string, key: string, fallback: string): string {
  const m = style.match(new RegExp(`(?:^|;)${key}=([^;]+)`));
  return m ? m[1] : fallback;
}

function mxGraphToSvg(xml: string): string {
  // Parse all mxCell elements
  const cellRe = /<mxCell([^>]*)>([\s\S]*?)<\/mxCell>|<mxCell([^>]*)\/>/g;
  const geomRe = /<mxGeometry([^/]*)\/?>/;

  interface Cell {
    id: string; value: string; style: string;
    vertex: boolean; edge: boolean;
    source: string; target: string;
    x: number; y: number; w: number; h: number;
  }

  const cells: Cell[] = [];
  const byId: Record<string, Cell> = {};
  let match: RegExpExecArray | null;

  while ((match = cellRe.exec(xml)) !== null) {
    const attrs = match[1] || match[3] || '';
    const inner = match[2] || '';

    const get = (k: string) => { const m = attrs.match(new RegExp(`${k}="([^"]*)"`)); return m ? m[1] : ''; };
    const geomMatch = geomRe.exec(inner);
    const ga = geomMatch ? geomMatch[1] : '';
    const gn = (k: string) => { const m = ga.match(new RegExp(`${k}="([^"]*)"`)); return m ? parseFloat(m[1]) : 0; };

    const c: Cell = {
      id: get('id'), value: get('value'), style: get('style'),
      vertex: get('vertex') === '1', edge: get('edge') === '1',
      source: get('source'), target: get('target'),
      x: gn('x'), y: gn('y'), w: gn('width'), h: gn('height'),
    };
    cells.push(c);
    byId[c.id] = c;
  }

  // Compute bounding box
  let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
  for (const c of cells) {
    if (!c.vertex || !c.w) continue;
    minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + c.w); maxY = Math.max(maxY, c.y + c.h);
  }
  if (minX === Infinity) return '';

  const PAD = 20;
  const vx = minX - PAD, vy = minY - PAD;
  const vw = maxX - minX + PAD * 2, vh = maxY - minY + PAD * 2;

  const shapes: string[] = [];
  const edges: string[] = [];
  const labels: string[] = [];

  for (const c of cells) {
    if (c.vertex && c.w > 0) {
      const x = c.x, y = c.y, w = c.w, h = c.h;
      const s = c.style;
      const fill  = attr(s, 'fillColor',   '#dae8fc');
      const stroke = attr(s, 'strokeColor', '#6c8ebf');
      const fillSafe  = fill  === 'none' ? 'none' : fill.startsWith('#') ? fill : '#' + fill;
      const strokeSafe = stroke === 'none' ? 'none' : stroke.startsWith('#') ? stroke : '#' + stroke;
      const lw = parseFloat(attr(s, 'strokeWidth', '1'));

      if (s.includes('ellipse') || s.includes('aspect=fixed')) {
        const rx = w / 2, ry = h / 2;
        const isDouble = s.includes('double=1');
        shapes.push(`<ellipse cx="${x+rx}" cy="${y+ry}" rx="${rx}" ry="${ry}" fill="${fillSafe}" stroke="${strokeSafe}" stroke-width="${lw}"/>`);
        if (isDouble) shapes.push(`<ellipse cx="${x+rx}" cy="${y+ry}" rx="${rx-3}" ry="${ry-3}" fill="none" stroke="${strokeSafe}" stroke-width="${lw}"/>`);
      } else if (s.includes('rhombus')) {
        const cx = x + w/2, cy = y + h/2;
        shapes.push(`<polygon points="${cx},${y} ${x+w},${cy} ${cx},${y+h} ${x},${cy}" fill="${fillSafe}" stroke="${strokeSafe}" stroke-width="${lw}"/>`);
      } else {
        // rectangle (rounded or plain)
        const r = s.includes('rounded=1') ? Math.min(8, h * 0.25) : 0;
        shapes.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${fillSafe}" stroke="${strokeSafe}" stroke-width="${lw}"/>`);
      }

      // label
      if (c.value) {
        const cx = x + w/2, cy = y + h/2;
        const fs = parseFloat(attr(s, 'fontSize', '12'));
        labels.push(`<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="${fs}" font-family="Arial,sans-serif" fill="#333">${esc(c.value)}</text>`);
      }
    }

    if (c.edge) {
      const src = byId[c.source], tgt = byId[c.target];
      if (!src || !tgt) continue;
      // Simple center-to-center arrow
      const x1 = src.x + src.w/2, y1 = src.y + src.h/2;
      const x2 = tgt.x + tgt.w/2, y2 = tgt.y + tgt.h/2;
      edges.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#555" stroke-width="1.5" marker-end="url(#arr)"/>`);
      if (c.value) {
        const mx = (x1+x2)/2, my = (y1+y2)/2;
        labels.push(`<text x="${mx}" y="${my-4}" text-anchor="middle" font-size="10" font-family="Arial,sans-serif" fill="#555" paint-order="stroke" stroke="white" stroke-width="3">${esc(c.value)}</text>`);
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" width="${vw}" height="${vh}">
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="8" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="#555"/>
    </marker>
  </defs>
  <rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="#f5f5f5"/>
  ${shapes.join('\n  ')}
  ${edges.join('\n  ')}
  ${labels.join('\n  ')}
</svg>`;
}

// ─── HTML Builder ─────────────────────────────────────────────────────────────

async function buildViewerHtml(xml: string, title: string, editUrl: string): Promise<string> {
  const svg = mxGraphToSvg(xml);
  const t = esc(title);
  const u = editUrl.replace(/"/g, '&quot;');
  const body = svg
    ? `<div class="d">${svg}</div>`
    : `<div class="d"><div class="fb"><p>Preview unavailable</p><a class="bl" href="${u}" target="_blank" rel="noopener">Open in draw.io ↗</a></div></div>`;

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
.d{padding:16px;overflow:auto;max-height:calc(100vh - 42px);display:flex;justify-content:center}
.d svg{max-width:100%;height:auto;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.12)}
.fb{text-align:center;padding:40px 20px}
.fb p{color:#999;font-size:14px;margin-bottom:16px}
.bl{display:inline-block;padding:10px 20px;background:#f08705;color:#fff;text-decoration:none;border-radius:6px;font-size:14px}
</style>
</head>
<body>
<div class="h"><span class="t">${t}</span><a class="btn" href="${u}" target="_blank" rel="noopener">Open in draw.io ↗</a></div>
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
