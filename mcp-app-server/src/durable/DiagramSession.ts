/**
 * Phase 3 — DiagramSession Durable Object
 * Persistent session storage for stateful diagram editing.
 * Requires Cloudflare Workers PAID plan ($5/month).
 */

import type { SessionData } from '../types.js';

// Type stubs for CF Workers types (resolved at build time via @cloudflare/workers-types)
declare const DurableObject: new (state: DurableObjectState, env: unknown) => unknown;

export class DiagramSession {
  private readonly state: DurableObjectState;
  // 24h TTL alarm
  private static readonly TTL_MS = 24 * 60 * 60 * 1000;

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      switch (url.pathname) {
        case '/get':
          return this.handleGet(url);

        case '/set':
          return this.handleSet(request, url);

        case '/delete':
          return this.handleDelete();

        case '/ping':
          return Response.json({ ok: true, ts: new Date().toISOString() });

        default:
          return new Response('Not found', { status: 404 });
      }
    } catch (err) {
      return Response.json(
        { error: String(err) },
        { status: 500 },
      );
    }
  }

  // ── GET /get?id=<session_id> ───────────────────────────────────────────────

  private async handleGet(_url: URL): Promise<Response> {
    const data = await this.state.storage.get<SessionData>('session');
    if (!data) {
      return new Response('Session not found', { status: 404 });
    }
    return Response.json(data);
  }

  // ── POST /set?id=<session_id> ─────────────────────────────────────────────

  private async handleSet(request: Request, url: URL): Promise<Response> {
    const body = (await request.json()) as Partial<SessionData>;
    const existing = (await this.state.storage.get<SessionData>('session')) ?? undefined;

    const now = new Date().toISOString();
    const updated: SessionData = {
      xml: body.xml ?? existing?.xml ?? this.blankXml(),
      title: body.title ?? existing?.title ?? 'Untitled',
      created_at: existing?.created_at ?? now,
      updated_at: now,
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(body.metadata ?? {}),
      },
    };

    await this.state.storage.put('session', updated);

    // Set TTL alarm — resets on every write
    await this.state.storage.setAlarm(Date.now() + DiagramSession.TTL_MS);

    const sessionId = url.searchParams.get('id') ?? 'unknown';
    return Response.json({ ok: true, session_id: sessionId, updated_at: now });
  }

  // ── DELETE /delete ────────────────────────────────────────────────────────

  private async handleDelete(): Promise<Response> {
    await this.state.storage.deleteAll();
    return Response.json({ ok: true });
  }

  // ── Alarm handler — fires after TTL to clean up expired sessions ──────────

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private blankXml(): string {
    return `<mxGraphModel>
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
  </root>
</mxGraphModel>`;
  }
}
