/**
 * shared.ts — Core MCP server factory
 * Creates McpServer with all tools, registers MCP Apps HTML resource.
 * Imported by both index.ts (Node.js) and worker.ts (Cloudflare Workers).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  buildTemplateXml,
  buildDiagramUrl,
  mermaidToXml,
} from './tools/create.js';
import { exportDiagram, formatExportOutput } from './tools/export.js';
import {
  applyBatchOperations,
  listCells,
  blankDiagramXml,
  createSessionData,
  updateSessionXml,
  validateDiagramXml,
} from './tools/crud.js';
import type {
  DiagramType,
  TemplateType,
  RelationshipType,
  WorkerEnv,
  SessionData,
} from './types.js';

// ─── HTML / App Resource ──────────────────────────────────────────────────────

/**
 * processAppBundle: Strip ESM export from the inline App bundle so it's safe
 * to use in a sandboxed <script> tag (no allow-same-origin, no module imports).
 */
export function processAppBundle(bundle: string): string {
  // Remove trailing ESM export: export { ... as App }
  return bundle.replace(/\nexport\s*\{[^}]*\}\s*;?\s*$/, '').trimEnd();
}

/**
 * buildHtml: Assemble the MCP Apps viewer HTML that gets served as the
 * app resource. The HTML renders draw.io XML inline using the viewer SDK.
 *
 * @param appBundle    - Pre-processed @modelcontextprotocol/ext-apps browser bundle
 * @param pakoBundle   - pako deflate bundle for XML compression
 * @param xml          - draw.io XML to render (injected server-side per request)
 * @param title        - Diagram title shown in viewer header
 * @param editUrl      - "Open in draw.io" link (https://app.diagrams.net/#create=...)
 */
export function buildHtml(
  appBundle: string,
  pakoBundle: string,
  xml: string,
  title: string,
  editUrl: string,
): string {
  const escapedXml = xml.replace(/`/g, '\\`').replace(/\\/g, '\\\\').replace(/\$/g, '\\$');
  const escapedTitle = title.replace(/"/g, '&quot;');
  const escapedEditUrl = editUrl.replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapedTitle}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f5; }
  #header { display: flex; align-items: center; justify-content: space-between; padding: 8px 16px; background: #fff; border-bottom: 1px solid #e0e0e0; }
  #header h2 { font-size: 14px; font-weight: 600; color: #333; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
  #open-btn { font-size: 12px; color: #1565c0; text-decoration: none; padding: 4px 10px; border: 1px solid #1565c0; border-radius: 4px; white-space: nowrap; }
  #open-btn:hover { background: #e3f2fd; }
  #viewer { width: 100%; height: calc(100vh - 42px); border: none; }
  #loading { display: flex; align-items: center; justify-content: center; height: 100%; color: #999; font-size: 14px; }
</style>
</head>
<body>
<div id="header">
  <h2>${escapedTitle}</h2>
  <a id="open-btn" href="${escapedEditUrl}" target="_blank" rel="noopener">Open in draw.io ↗</a>
</div>
<div id="loading">Loading diagram…</div>
<script>
${pakoBundle}
</script>
<script>
var App;
${appBundle}
</script>
<script>
(function() {
  var XML = \`${escapedXml}\`;
  var EDIT_URL = "${escapedEditUrl}";

  function compressXml(xml) {
    try {
      if (typeof pako !== 'undefined' && pako.deflateRaw) {
        var bytes = new TextEncoder().encode(xml);
        var compressed = pako.deflateRaw(bytes);
        var binary = '';
        for (var i = 0; i < compressed.length; i++) binary += String.fromCharCode(compressed[i]);
        return btoa(binary);
      }
    } catch(e) {}
    var bytes = new TextEncoder().encode(xml);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function renderDiagram() {
    var loading = document.getElementById('loading');
    try {
      // Use MCP Apps SDK if available
      if (typeof App !== 'undefined' && App && App.create) {
        var container = document.createElement('div');
        container.style.cssText = 'width:100%;height:calc(100vh - 42px);';
        document.body.appendChild(container);
        if (loading) loading.style.display = 'none';
        App.create({
          container: container,
          xml: XML,
          editUrl: EDIT_URL,
        });
        return;
      }

      // Fallback: load viewer from CDN
      var script = document.createElement('script');
      script.src = 'https://viewer.diagrams.net/viewer-static.min.js';
      script.onload = function() {
        var compressed = compressXml(XML);
        var viewerUrl = 'https://viewer.diagrams.net/?lightbox=1&xml=' + encodeURIComponent(compressed);
        var iframe = document.createElement('iframe');
        iframe.id = 'viewer';
        iframe.src = viewerUrl;
        iframe.sandbox = 'allow-scripts allow-same-origin';
        if (loading) loading.replaceWith(iframe);
        else document.body.appendChild(iframe);
      };
      document.head.appendChild(script);
    } catch(e) {
      if (loading) loading.textContent = 'Error rendering diagram: ' + e.message;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderDiagram);
  } else {
    renderDiagram();
  }
})();
</script>
</body>
</html>`;
}

// ─── Session Storage Adapter ──────────────────────────────────────────────────

/**
 * ISessionStore — abstract interface so shared.ts works with both
 * Node.js (in-memory Map) and Cloudflare Workers (Durable Objects).
 */
export interface ISessionStore {
  get(sessionId: string): Promise<SessionData | null>;
  set(sessionId: string, data: SessionData): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

/** Node.js in-memory store (used by index.ts) */
export class InMemorySessionStore implements ISessionStore {
  private readonly store = new Map<string, SessionData>();

  async get(sessionId: string): Promise<SessionData | null> {
    return this.store.get(sessionId) ?? null;
  }

  async set(sessionId: string, data: SessionData): Promise<void> {
    this.store.set(sessionId, data);
  }

  async delete(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
  }
}

/** Cloudflare Durable Object store (used by worker.ts) */
export class DurableObjectSessionStore implements ISessionStore {
  constructor(
    private readonly namespace: DurableObjectNamespace,
  ) {}

  private stub(sessionId: string): DurableObjectStub {
    const id = this.namespace.idFromName(sessionId);
    return this.namespace.get(id);
  }

  async get(sessionId: string): Promise<SessionData | null> {
    const resp = await this.stub(sessionId).fetch(`http://do/get?id=${sessionId}`);
    if (resp.status === 404) return null;
    return resp.json() as Promise<SessionData>;
  }

  async set(sessionId: string, data: SessionData): Promise<void> {
    await this.stub(sessionId).fetch(
      `http://do/set?id=${sessionId}`,
      { method: 'POST', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } },
    );
  }

  async delete(sessionId: string): Promise<void> {
    await this.stub(sessionId).fetch(`http://do/delete?id=${sessionId}`, { method: 'DELETE' });
  }
}

// ─── Server Factory ───────────────────────────────────────────────────────────

export interface ServerDeps {
  /** Pre-built HTML string (from generated-html.ts in Worker; built at runtime in Node.js) */
  getHtml: (xml: string, title: string, editUrl: string) => string;
  /** Session persistence */
  sessions: ISessionStore;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({
    name: 'drawio-mcp-server',
    version: '2.0.0',
  });

  // ── MCP Apps resource (inline viewer iframe) ────────────────────────────────
  // The HTML resource is fetched by Claude.ai and rendered in a sandboxed iframe.
  // session_id is stored in the resource URI so the Worker can serve the right XML.
  server.resource(
    'drawio-viewer',
    'drawio://viewer/{session_id}',
    { mimeType: 'text/html', description: 'Interactive draw.io diagram viewer' },
    async (uri: URL) => {
      const sessionId = uri.pathname.split('/').pop() ?? 'default';
      const session = await deps.sessions.get(sessionId);
      const xml = session?.xml ?? blankDiagramXml();
      const title = session?.title ?? 'Diagram';
      const editUrl = buildDiagramUrl(xml);
      return {
        contents: [{
          uri: uri.toString(),
          mimeType: 'text/html',
          text: deps.getHtml(xml, title, editUrl),
        }],
      };
    },
  );

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 1 — Stateless Creation Tools
  // ════════════════════════════════════════════════════════════════════════════

  // ── create_diagram ──────────────────────────────────────────────────────────

  server.registerTool(
    'create_diagram',
    {
      title: 'Create Draw.io Diagram',
      description: `Render a draw.io diagram inline from mxGraph XML and return an interactive viewer.

Accepts native draw.io XML (mxGraphModel format) and renders it as an interactive iframe in
Claude.ai via the MCP Apps extension. Non-MCP-Apps clients receive the XML as plain text.

Args:
  - xml (string): draw.io XML in mxGraphModel format (REQUIRED)
  - title (string): Human-readable diagram title shown in viewer header (default: "Diagram")
  - diagramType (string): Hint for LLM context — does not change output format.
    Values: flowchart | sequence | usecase | activity | erd | class | component | deployment | generic

Returns:
  - Interactive inline viewer (MCP Apps clients: Claude.ai)
  - Plain XML text (non-MCP-Apps clients: Claude Desktop, etc.)
  - "Open in draw.io" URL for full editor access

XML Format:
  <mxGraphModel>
    <root>
      <mxCell id="0"/>
      <mxCell id="1" parent="0"/>
      <mxCell id="2" value="Label" style="rounded=1;" vertex="1" parent="1">
        <mxGeometry x="100" y="100" width="120" height="60" as="geometry"/>
      </mxCell>
    </root>
  </mxGraphModel>

Error Handling:
  - Invalid XML returns a parse error with the problematic content highlighted`,
      inputSchema: z.object({
        xml: z.string().min(10).describe('draw.io XML in mxGraphModel format'),
        title: z.string().optional().default('Diagram').describe('Diagram title for viewer header'),
        diagramType: z.enum([
          'flowchart', 'sequence', 'usecase', 'activity',
          'erd', 'class', 'component', 'deployment', 'generic',
        ] as [DiagramType, ...DiagramType[]]).optional().describe('Diagram type hint'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ xml, title = 'Diagram' }) => {
      const validation = validateDiagramXml(xml);
      if (!validation.valid) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error: Invalid draw.io XML — ${validation.error}\n\nReceived:\n${xml.slice(0, 500)}`,
          }],
          isError: true,
        };
      }

      // Store in session for resource serving
      const sessionId = generateSessionId();
      const sessionData = createSessionData(xml, title);
      await deps.sessions.set(sessionId, sessionData);

      const editUrl = buildDiagramUrl(xml);
      const resourceUri = `drawio://viewer/${sessionId}`;

      return {
        content: [
          {
            type: 'resource' as const,
            resource: {
              uri: resourceUri,
              mimeType: 'text/html',
              text: deps.getHtml(xml, title, editUrl),
            },
          },
          {
            type: 'text' as const,
            text: `✓ Diagram "${title}" created.\n\nEdit URL: ${editUrl}\n\nXML:\n${xml}`,
          },
        ],
      };
    },
  );

  // ── create_from_mermaid ────────────────────────────────────────────────────

  server.registerTool(
    'create_from_mermaid',
    {
      title: 'Create Diagram from Mermaid',
      description: `Convert Mermaid.js syntax to a draw.io diagram via Kroki API, then render inline.

Supported Mermaid diagram types:
  - sequenceDiagram — sequence / message flow diagrams
  - flowchart / graph — flowcharts (LR, TD, etc.)
  - erDiagram — entity-relationship diagrams
  - classDiagram — UML class diagrams
  - stateDiagram-v2 — state machine diagrams

Args:
  - mermaid (string): Valid Mermaid.js syntax (REQUIRED)
  - title (string): Diagram title (default: "Diagram")

Returns:
  Interactive inline draw.io viewer + "Open in draw.io" URL.

Example mermaid input:
  flowchart TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Action]
    B -->|No| D[End]

Error Handling:
  - Kroki API errors return descriptive message with HTTP status
  - Invalid Mermaid syntax causes Kroki to return 400 with details`,
      inputSchema: z.object({
        mermaid: z.string().min(5).describe('Mermaid.js diagram syntax'),
        title: z.string().optional().default('Diagram').describe('Diagram title'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ mermaid, title = 'Diagram' }) => {
      let xml: string;
      try {
        xml = await mermaidToXml(mermaid);
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error converting Mermaid to draw.io XML: ${String(err)}\n\nMermaid input:\n${mermaid}`,
          }],
          isError: true,
        };
      }

      const sessionId = generateSessionId();
      await deps.sessions.set(sessionId, createSessionData(xml, title));

      const editUrl = buildDiagramUrl(xml);

      return {
        content: [
          {
            type: 'resource' as const,
            resource: {
              uri: `drawio://viewer/${sessionId}`,
              mimeType: 'text/html',
              text: deps.getHtml(xml, title, editUrl),
            },
          },
          {
            type: 'text' as const,
            text: `✓ Converted Mermaid → draw.io XML. Diagram: "${title}"\nEdit: ${editUrl}`,
          },
        ],
      };
    },
  );

  // ── create_from_template ──────────────────────────────────────────────────

  server.registerTool(
    'create_from_template',
    {
      title: 'Create Diagram from Template',
      description: `Generate a structured draw.io diagram from a template type + entities/relationships.
No external API calls — XML is built server-side from the inputs.

Template types:
  - usecase     — Actor shapes + system boundary + use case ellipses
  - sequence    — Vertical lifelines + horizontal message arrows
  - activity    — Start node → actions → decisions → end node
  - erd         — Entity rectangles + cardinality-labeled edges
  - class       — Class boxes (name/attrs/methods) + typed connectors
  - component   — Component rectangles + interface connectors
  - deployment  — Server nodes + artifact dependencies

Args:
  - template (string): One of the template types above (REQUIRED)
  - entities (string[]): List of entity/component/actor names (REQUIRED)
  - relationships (array): Optional connections between entities
      - from (string): Source entity name
      - to (string): Target entity name
      - label (string): Edge label (optional)
      - type (string): association | inheritance | dependency | aggregation | message | include | extend
  - title (string): Diagram title (default: template name)

Returns:
  Interactive inline draw.io viewer + edit URL + XML.

Example:
  template: "erd"
  entities: ["User", "Order", "Product"]
  relationships: [
    { from: "User", to: "Order", label: "places", type: "association" },
    { from: "Order", to: "Product", label: "contains", type: "aggregation" }
  ]`,
      inputSchema: z.object({
        template: z.enum([
          'usecase', 'sequence', 'activity', 'erd', 'class', 'component', 'deployment',
        ] as [TemplateType, ...TemplateType[]]).describe('Diagram template type'),
        entities: z.array(z.string().min(1)).min(1).max(20)
          .describe('List of entity, component, or actor names'),
        relationships: z.array(z.object({
          from: z.string(),
          to: z.string(),
          label: z.string().optional(),
          type: z.enum([
            'association', 'inheritance', 'dependency', 'aggregation',
            'message', 'include', 'extend',
          ] as [RelationshipType, ...RelationshipType[]]).optional(),
        })).optional().describe('Connections between entities'),
        title: z.string().optional().describe('Diagram title'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ template, entities, relationships = [], title }) => {
      const diagramTitle = title ?? `${template.charAt(0).toUpperCase()}${template.slice(1)} Diagram`;

      let xml: string;
      try {
        xml = buildTemplateXml({ template, entities, relationships, title: diagramTitle });
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error building template: ${String(err)}`,
          }],
          isError: true,
        };
      }

      const sessionId = generateSessionId();
      await deps.sessions.set(sessionId, createSessionData(xml, diagramTitle));

      const editUrl = buildDiagramUrl(xml);

      return {
        content: [
          {
            type: 'resource' as const,
            resource: {
              uri: `drawio://viewer/${sessionId}`,
              mimeType: 'text/html',
              text: deps.getHtml(xml, diagramTitle, editUrl),
            },
          },
          {
            type: 'text' as const,
            text: `✓ Generated ${template} diagram: "${diagramTitle}"\n${entities.length} entities, ${relationships.length} relationships.\nEdit: ${editUrl}`,
          },
        ],
      };
    },
  );

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 2 — Export Tools (Stateless)
  // ════════════════════════════════════════════════════════════════════════════

  server.registerTool(
    'export_diagram',
    {
      title: 'Export Diagram to PNG/SVG/PDF',
      description: `Export draw.io XML to a binary image format (PNG, SVG, or PDF) via export.diagrams.net.
Useful for embedding diagrams in Confluence, Google Docs, or sharing as images.

Args:
  - xml (string): draw.io XML in mxGraphModel format (REQUIRED)
  - format (string): Output format — "png" | "svg" | "pdf" (REQUIRED)
  - scale (number): Scale factor 1–4 (default: 1). Use 2 for Retina/HiDPI output.
  - transparent (boolean): PNG only — transparent background (default: false)
  - width (number): Override output width in pixels (optional)

Returns JSON:
  {
    "base64": "...",          // Base64-encoded binary data
    "mime_type": "image/png", // MIME type
    "filename": "diagram.png",
    "size_bytes": 12345
  }

Notes:
  - Uses export.diagrams.net public API (no auth required)
  - SVG output is text-based and can be embedded directly in HTML
  - PDF output requires Chromium on the export server (may be slower)
  - Large or complex diagrams may take 2–5 seconds

Error Handling:
  - Network errors: returns error with HTTP status from export server
  - Invalid XML: export server returns 400 with details`,
      inputSchema: z.object({
        xml: z.string().min(10).describe('draw.io XML in mxGraphModel format'),
        format: z.enum(['png', 'svg', 'pdf']).describe('Export format'),
        scale: z.number().min(1).max(4).optional().default(1)
          .describe('Scale factor 1–4 (default 1, use 2 for HiDPI)'),
        transparent: z.boolean().optional().default(false)
          .describe('Transparent background (PNG only)'),
        width: z.number().int().positive().optional()
          .describe('Override output width in pixels'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ xml, format, scale = 1, transparent = false, width }) => {
      try {
        const result = await exportDiagram({ xml, format, scale, transparent, width });
        return {
          content: [{
            type: 'text' as const,
            text: formatExportOutput(result),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error exporting diagram: ${String(err)}`,
          }],
          isError: true,
        };
      }
    },
  );

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 3+4 — Session-based CRUD Tools
  // ════════════════════════════════════════════════════════════════════════════

  // ── create_session ────────────────────────────────────────────────────────

  server.registerTool(
    'create_session',
    {
      title: 'Create Diagram Session',
      description: `Create a new persistent diagram session for stateful editing.
Returns a session_id used by batch_update, list_cells, get_diagram, and export_session.

Sessions persist for 24 hours. Each session holds one diagram's XML.

Args:
  - xml (string): Initial draw.io XML (optional — starts blank if omitted)
  - title (string): Session/diagram title (default: "Untitled")

Returns:
  { session_id, title, created_at }

Use the returned session_id in subsequent batch_update calls.`,
      inputSchema: z.object({
        xml: z.string().optional().describe('Initial draw.io XML (blank diagram if omitted)'),
        title: z.string().optional().default('Untitled').describe('Diagram title'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ xml, title = 'Untitled' }) => {
      const sessionId = generateSessionId();
      const session = createSessionData(xml, title);
      await deps.sessions.set(sessionId, session);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ session_id: sessionId, title, created_at: session.created_at }, null, 2),
        }],
      };
    },
  );

  // ── get_session ───────────────────────────────────────────────────────────

  server.registerTool(
    'get_session',
    {
      title: 'Get Diagram Session',
      description: `Retrieve current XML and metadata for an existing session.

Args:
  - session_id (string): Session ID returned by create_session (REQUIRED)

Returns:
  Full SessionData: { xml, title, created_at, updated_at, metadata }

Use get_session before export_session to review the current diagram state.`,
      inputSchema: z.object({
        session_id: z.string().min(1).describe('Session ID from create_session'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id }) => {
      const session = await deps.sessions.get(session_id);
      if (!session) {
        return {
          content: [{ type: 'text' as const, text: `Error: Session "${session_id}" not found or expired.` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(session, null, 2) }],
      };
    },
  );

  // ── delete_session ────────────────────────────────────────────────────────

  server.registerTool(
    'delete_session',
    {
      title: 'Delete Diagram Session',
      description: `Delete a diagram session and free its storage. Sessions auto-expire after 24h.

Args:
  - session_id (string): Session ID to delete (REQUIRED)`,
      inputSchema: z.object({
        session_id: z.string().min(1).describe('Session ID to delete'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id }) => {
      await deps.sessions.delete(session_id);
      return {
        content: [{ type: 'text' as const, text: `Session "${session_id}" deleted.` }],
      };
    },
  );

  // ── batch_update ──────────────────────────────────────────────────────────

  server.registerTool(
    'batch_update',
    {
      title: 'Batch Update Diagram',
      description: `Apply multiple diagram operations in a single call (preferred over individual cell tools).
Operates on a session's XML and persists the result.

Args:
  - session_id (string): Target session ID (REQUIRED)
  - operations (array): List of operations to apply in order (REQUIRED)
  - auto_layout (boolean): Apply basic hierarchical layout after ops (default: false)

Operation types:
  add_cell:   { op, id, shape, label, x, y, width?, height?, style? }
  add_edge:   { op, id, source_id, target_id, label?, style? }
  edit_cell:  { op, id, label?, x?, y?, width?, height?, style? }
  edit_edge:  { op, id, label?, source_id?, target_id?, style? }
  delete_cell: { op, id }       — also removes connected edges
  set_metadata: { op, id, key, value }

Shape types: rectangle | rounded_rectangle | ellipse | diamond | actor |
             cylinder | cloud | document | swimlane | start_node | end_node

Returns:
  { session_id, operations_applied, xml_preview }

Example — build a 2-node flowchart:
  operations: [
    { op: "add_cell", id: "n1", shape: "rounded_rectangle", label: "Start", x: 100, y: 100 },
    { op: "add_cell", id: "n2", shape: "diamond", label: "Decision?", x: 100, y: 220 },
    { op: "add_edge", id: "e1", source_id: "n1", target_id: "n2", label: "next" }
  ]`,
      inputSchema: z.object({
        session_id: z.string().min(1).describe('Target session ID'),
        operations: z.array(z.discriminatedUnion('op', [
          z.object({
            op: z.literal('add_cell'),
            id: z.string(),
            shape: z.enum([
              'rectangle', 'rounded_rectangle', 'ellipse', 'diamond',
              'actor', 'cylinder', 'cloud', 'document',
              'swimlane', 'start_node', 'end_node',
            ]),
            label: z.string(),
            x: z.number(),
            y: z.number(),
            width: z.number().optional(),
            height: z.number().optional(),
            style: z.string().optional(),
          }),
          z.object({
            op: z.literal('add_edge'),
            id: z.string(),
            source_id: z.string(),
            target_id: z.string(),
            label: z.string().optional(),
            style: z.string().optional(),
          }),
          z.object({
            op: z.literal('edit_cell'),
            id: z.string(),
            label: z.string().optional(),
            x: z.number().optional(),
            y: z.number().optional(),
            width: z.number().optional(),
            height: z.number().optional(),
            style: z.string().optional(),
          }),
          z.object({
            op: z.literal('edit_edge'),
            id: z.string(),
            label: z.string().optional(),
            source_id: z.string().optional(),
            target_id: z.string().optional(),
            style: z.string().optional(),
          }),
          z.object({
            op: z.literal('delete_cell'),
            id: z.string(),
          }),
          z.object({
            op: z.literal('set_metadata'),
            id: z.string(),
            key: z.string(),
            value: z.string(),
          }),
        ])).min(1).max(100).describe('Operations to apply'),
        auto_layout: z.boolean().optional().default(false)
          .describe('Apply basic hierarchical layout after operations'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ session_id, operations, auto_layout = false }) => {
      const session = await deps.sessions.get(session_id);
      if (!session) {
        return {
          content: [{ type: 'text' as const, text: `Error: Session "${session_id}" not found.` }],
          isError: true,
        };
      }

      let updatedXml: string;
      try {
        updatedXml = applyBatchOperations(session.xml, operations as Parameters<typeof applyBatchOperations>[1]);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error applying operations: ${String(err)}` }],
          isError: true,
        };
      }

      const updatedSession = updateSessionXml(session, updatedXml);
      await deps.sessions.set(session_id, updatedSession);

      const editUrl = buildDiagramUrl(updatedXml);
      const preview = updatedXml.slice(0, 300) + (updatedXml.length > 300 ? '...' : '');

      return {
        content: [
          {
            type: 'resource' as const,
            resource: {
              uri: `drawio://viewer/${session_id}`,
              mimeType: 'text/html',
              text: deps.getHtml(updatedXml, session.title, editUrl),
            },
          },
          {
            type: 'text' as const,
            text: JSON.stringify({
              session_id,
              operations_applied: operations.length,
              updated_at: updatedSession.updated_at,
              edit_url: editUrl,
              xml_preview: preview,
            }, null, 2),
          },
        ],
      };
    },
  );

  // ── list_cells ────────────────────────────────────────────────────────────

  server.registerTool(
    'list_cells',
    {
      title: 'List Diagram Cells',
      description: `List all cells (shapes and edges) in a session diagram. Supports pagination.

Args:
  - session_id (string): Session ID (REQUIRED)
  - offset (number): Pagination offset, default 0
  - limit (number): Max results, 1–100, default 50

Returns:
  { cells: [...], total, has_more, offset }

Each cell: { id, label, type (vertex|edge), shape_hint, x?, y?, width?, height?, source?, target? }`,
      inputSchema: z.object({
        session_id: z.string().min(1),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(100).optional().default(50),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, offset = 0, limit = 50 }) => {
      const session = await deps.sessions.get(session_id);
      if (!session) {
        return {
          content: [{ type: 'text' as const, text: `Error: Session "${session_id}" not found.` }],
          isError: true,
        };
      }
      const result = listCells(session.xml, offset, limit);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ...result, offset, limit }, null, 2) }],
      };
    },
  );

  // ── get_diagram ───────────────────────────────────────────────────────────

  server.registerTool(
    'get_diagram',
    {
      title: 'Get Diagram XML',
      description: `Return the current draw.io XML for a session. Use before export_session or to inspect state.

Args:
  - session_id (string): Session ID (REQUIRED)
  - include_viewer (boolean): Also render the interactive viewer (default: false)

Returns:
  { session_id, title, xml, updated_at, edit_url }`,
      inputSchema: z.object({
        session_id: z.string().min(1),
        include_viewer: z.boolean().optional().default(false),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, include_viewer = false }) => {
      const session = await deps.sessions.get(session_id);
      if (!session) {
        return {
          content: [{ type: 'text' as const, text: `Error: Session "${session_id}" not found.` }],
          isError: true,
        };
      }

      const editUrl = buildDiagramUrl(session.xml);
      const summaryJson = JSON.stringify({
        session_id,
        title: session.title,
        xml: session.xml,
        updated_at: session.updated_at,
        edit_url: editUrl,
      }, null, 2);

      if (include_viewer) {
        return {
          content: [
            {
              type: 'resource' as const,
              resource: {
                uri: `drawio://viewer/${session_id}`,
                mimeType: 'text/html',
                text: deps.getHtml(session.xml, session.title, editUrl),
              },
            },
            { type: 'text' as const, text: summaryJson },
          ],
        };
      }
      return { content: [{ type: 'text' as const, text: summaryJson }] };
    },
  );

  // ── export_session ────────────────────────────────────────────────────────

  server.registerTool(
    'export_session',
    {
      title: 'Export Session Diagram',
      description: `Shortcut: retrieve session XML + export to PNG/SVG/PDF in one call.
Combines get_diagram + export_diagram without an extra round-trip.

Args:
  - session_id (string): Session ID (REQUIRED)
  - format (string): "png" | "svg" | "pdf" (REQUIRED)
  - scale (number): 1–4, default 1
  - transparent (boolean): PNG transparent background, default false
  - width (number): Override output width in pixels

Returns same as export_diagram: { base64, mime_type, filename, size_bytes }`,
      inputSchema: z.object({
        session_id: z.string().min(1),
        format: z.enum(['png', 'svg', 'pdf']),
        scale: z.number().min(1).max(4).optional().default(1),
        transparent: z.boolean().optional().default(false),
        width: z.number().int().positive().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ session_id, format, scale = 1, transparent = false, width }) => {
      const session = await deps.sessions.get(session_id);
      if (!session) {
        return {
          content: [{ type: 'text' as const, text: `Error: Session "${session_id}" not found.` }],
          isError: true,
        };
      }

      try {
        const result = await exportDiagram({ xml: session.xml, format, scale, transparent, width });
        return {
          content: [{
            type: 'text' as const,
            text: formatExportOutput(result),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Export error: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function generateSessionId(): string {
  return crypto.randomUUID();
}
