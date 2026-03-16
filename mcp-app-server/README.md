# drawio-mcp — Remote MCP Server (TypeScript + Cloudflare Workers)

A fully-featured, self-hostable MCP server for generating and editing draw.io diagrams
inline inside Claude.ai. Renders diagrams as interactive iframes via the MCP Apps extension.

**Live hosted version** (no setup): [`https://mcp.draw.io/mcp`](https://mcp.draw.io/mcp)

---

## Features

| Phase | Tools | Type |
|-------|-------|------|
| 1 | `create_diagram` | Stateless — render any mxGraph XML |
| 1 | `create_from_mermaid` | Stateless — Mermaid → draw.io via Kroki |
| 1 | `create_from_template` | Stateless — 7 diagram templates (ERD, UML, etc.) |
| 2 | `export_diagram` | Stateless — PNG / SVG / PDF via export.diagrams.net |
| 3 | `create_session` / `get_session` / `delete_session` | Stateful sessions (Durable Objects) |
| 4 | `batch_update` | Stateful — add/edit/delete cells in bulk |
| 4 | `list_cells` / `get_diagram` / `export_session` | Stateful inspection + export |

**Phase 1+2 work on Cloudflare Workers free tier.**  
**Phase 3+4 require a paid Workers plan ($5/month) for Durable Objects.**

---

## Quick Start

### Add hosted endpoint to Claude.ai

1. Claude.ai → Settings → Connectors → Add custom connector  
2. URL: `https://mcp.draw.io/mcp`  
3. All 11 tools become available immediately

### Self-host on Cloudflare Workers

```bash
git clone https://github.com/tuongbeo/drawio-mcp
cd drawio-mcp/mcp-app-server

npm install

# Authenticate with Cloudflare (one-time)
npx wrangler login

# Build + deploy
npm run deploy
# → https://drawio-mcp.<account>.workers.dev/mcp
```

Add your deployed URL to Claude.ai as a custom connector.

### Local development (Node.js)

```bash
npm install
npm run dev:node
# → http://localhost:3001/mcp

# Add to Claude.ai as custom connector: http://localhost:3001/mcp
```

### Local Cloudflare Workers dev

```bash
npm run dev:worker
# → http://localhost:8787/mcp
```

### Claude Desktop (stdio)

```json
{
  "mcpServers": {
    "drawio": {
      "command": "node",
      "args": ["/path/to/mcp-app-server/dist/index.js", "--stdio"]
    }
  }
}
```

*Note: Claude Desktop does not support the MCP Apps extension — tools return XML as text.*

---

## Tool Reference

### `create_diagram`

Render draw.io XML as an inline interactive viewer.

```
xml         string   — mxGraphModel XML (required)
title       string   — Viewer header title (default: "Diagram")
diagramType string   — Context hint: flowchart | sequence | usecase | activity |
                       erd | class | component | deployment | generic
```

### `create_from_mermaid`

Convert Mermaid.js syntax to draw.io XML via [Kroki](https://kroki.io), then render inline.

```
mermaid   string   — Valid Mermaid.js syntax (required)
title     string   — Diagram title
```

Supported: `flowchart`, `sequenceDiagram`, `erDiagram`, `classDiagram`, `stateDiagram-v2`

### `create_from_template`

Generate structured diagrams server-side from entities + relationships. No external API.

```
template      string     — usecase | sequence | activity | erd | class | component | deployment
entities      string[]   — Entity/actor/component names (1–20)
relationships array      — Connections: { from, to, label?, type? }
title         string     — Diagram title
```

Relationship types: `association | inheritance | dependency | aggregation | message | include | extend`

### `export_diagram`

Export XML to PNG/SVG/PDF via [export.diagrams.net](https://export.diagrams.net/).

```
xml          string    — mxGraphModel XML (required)
format       string    — png | svg | pdf
scale        number    — 1–4 (default: 1, use 2 for HiDPI)
transparent  boolean   — PNG transparent background (default: false)
width        number    — Override output width in pixels
```

Returns: `{ base64, mime_type, filename, size_bytes }`

### Session tools (Phase 3+4 — requires Durable Objects)

```
create_session   { xml?, title? }         → { session_id, title, created_at }
get_session      { session_id }           → SessionData
delete_session   { session_id }           → confirmation
batch_update     { session_id, ops[], auto_layout? } → updated viewer + metadata
list_cells       { session_id, offset?, limit? }     → paginated cell list
get_diagram      { session_id, include_viewer? }     → XML + metadata
export_session   { session_id, format, scale? }      → base64 binary
```

#### `batch_update` operation types

```typescript
{ op: 'add_cell',   id, shape, label, x, y, width?, height?, style? }
{ op: 'add_edge',   id, source_id, target_id, label?, style? }
{ op: 'edit_cell',  id, label?, x?, y?, width?, height?, style? }
{ op: 'edit_edge',  id, label?, source_id?, target_id?, style? }
{ op: 'delete_cell', id }
{ op: 'set_metadata', id, key, value }
```

Shape types: `rectangle | rounded_rectangle | ellipse | diamond | actor | cylinder | cloud | document | swimlane | start_node | end_node`

---

## Architecture

```
mcp-app-server/
├── src/
│   ├── shared.ts          # McpServer factory — all 11 tools + session store interface
│   ├── index.ts           # Node.js: Express HTTP (:3001/mcp) + stdio transports
│   ├── worker.ts          # Cloudflare Workers: WorkerTransport adapter + fetch handler
│   ├── build-html.ts      # Build script: inlines ext-apps + pako → generated-html.ts
│   ├── generated-html.ts  # Auto-generated — 266KB pre-built HTML with bundled SDKs
│   ├── types.ts           # All TypeScript interfaces
│   └── tools/
│       ├── create.ts      # Template builders (7 types) + mermaidToXml
│       ├── export.ts      # exportDiagram → export.diagrams.net
│       └── crud.ts        # XML manipulation (fast-xml-parser), listCells, sessionHelpers
└── durable/
    └── DiagramSession.ts  # Durable Object: 24h TTL session storage
```

### Session storage

| Runtime | Store | Persistence |
|---------|-------|-------------|
| Node.js | `InMemorySessionStore` (Map) | Process lifetime only |
| CF Workers free | `InMemorySessionStore` | Per-request only (resets!) |
| CF Workers paid | `DurableObjectSessionStore` | 24h TTL, cross-request |

### WorkerTransport

Custom adapter bridging `McpServer` (designed for Node.js streams) to the
Cloudflare Workers `Request`/`Response` model. Each HTTP request creates a fresh
`McpServer` instance (stateless), passes the JSON-RPC body through, and returns
the response.

---

## Building

```bash
# 1. Install dependencies (first time)
npm install

# 2. Pre-build HTML — inlines ~265KB of SDK bundles into generated-html.ts
npm run build:html

# 3. TypeScript compile → dist/
npm run build:tsc

# Combined
npm run build
```

The `build:html` step reads:
- `@modelcontextprotocol/ext-apps/dist/src/app.js` (~235KB) — MCP Apps SDK for Claude.ai
- `pako/dist/pako_deflate.min.js` (~27KB) — deflate for `#create=` URL compression

Both are inlined into `src/generated-html.ts` so the Cloudflare Worker can serve
the HTML without `fs` access at runtime.

---

## Enabling Durable Objects (Phase 3+4)

1. Upgrade to Cloudflare Workers **Paid plan** ($5/month)
2. Deploy once — `wrangler.toml` already declares the binding and migration
3. Sessions now persist for 24 hours with automatic cleanup via alarm API

The `wrangler.toml` migration block:
```toml
[[durable_objects.bindings]]
name = "DIAGRAM_SESSION"
class_name = "DiagramSession"

[[migrations]]
tag = "v1"
new_classes = ["DiagramSession"]
```

---

## Claude orchestration with Google Drive

The Worker does **not** handle Google Drive. Claude handles multi-MCP orchestration:

1. `create_from_template` → returns XML + base64 PNG
2. `Google Drive MCP` → `create_drive_file` with the PNG base64
3. Claude constructs `https://app.diagrams.net/#G{fileId}` for the edit link

---

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `POST /mcp` | POST | MCP JSON-RPC endpoint |
| `OPTIONS /mcp` | OPTIONS | CORS preflight |
| `GET /health` | GET | Health check |
| `GET /` | GET | Info |

---

## Testing Checklist

- [x] `npm run build` completes with zero TypeScript errors
- [x] `tools/list` returns all 11 tools
- [x] `create_diagram` returns `resource` block + `text` block
- [x] `create_from_template` generates valid mxGraph XML for all 7 templates
- [x] `batch_update` with 11 ops produces correct cell/edge counts
- [x] `list_cells` returns paginated results (6 vertices, 5 edges for auth flow test)
- [x] `export_diagram` returns graceful error when network is unavailable
- [x] `create_from_mermaid` returns graceful error when Kroki is unavailable
- [ ] `export_diagram` returns valid base64 PNG (requires export.diagrams.net access)
- [ ] `create_from_mermaid` renders correctly (requires kroki.io access)
- [ ] Durable Objects sessions persist across requests (requires paid CF plan)
