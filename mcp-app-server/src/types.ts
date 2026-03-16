// ─── Diagram Types ────────────────────────────────────────────────────────────

export type DiagramType =
  | 'flowchart'
  | 'sequence'
  | 'usecase'
  | 'activity'
  | 'erd'
  | 'class'
  | 'component'
  | 'deployment'
  | 'generic';

export type TemplateType =
  | 'usecase'
  | 'sequence'
  | 'activity'
  | 'erd'
  | 'class'
  | 'component'
  | 'deployment';

export type ShapeType =
  | 'rectangle'
  | 'rounded_rectangle'
  | 'ellipse'
  | 'diamond'
  | 'actor'
  | 'cylinder'
  | 'cloud'
  | 'document'
  | 'swimlane'
  | 'start_node'
  | 'end_node';

export type RelationshipType =
  | 'association'
  | 'inheritance'
  | 'dependency'
  | 'aggregation'
  | 'message'
  | 'include'
  | 'extend';

// ─── Tool Inputs ──────────────────────────────────────────────────────────────

export interface CreateDiagramInput {
  xml: string;
  title?: string;
  diagramType?: DiagramType;
}

export interface CreateFromMermaidInput {
  mermaid: string;
  title?: string;
}

export interface Relationship {
  from: string;
  to: string;
  label?: string;
  type?: RelationshipType;
}

export interface CreateFromTemplateInput {
  template: TemplateType;
  entities: string[];
  relationships?: Relationship[];
  title?: string;
}

export interface ExportDiagramInput {
  xml: string;
  format: 'png' | 'svg' | 'pdf';
  scale?: number;
  transparent?: boolean;
  width?: number;
}

export interface ExportDiagramOutput {
  base64: string;
  mime_type: string;
  filename: string;
  size_bytes: number;
}

// ─── Session / CRUD ───────────────────────────────────────────────────────────

export interface SessionData {
  xml: string;
  title: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
}

export interface AddCellOp {
  op: 'add_cell';
  id: string;
  shape: ShapeType;
  label: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  style?: string;
}

export interface AddEdgeOp {
  op: 'add_edge';
  id: string;
  source_id: string;
  target_id: string;
  label?: string;
  style?: string;
}

export interface EditCellOp {
  op: 'edit_cell';
  id: string;
  label?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  style?: string;
}

export interface EditEdgeOp {
  op: 'edit_edge';
  id: string;
  label?: string;
  source_id?: string;
  target_id?: string;
  style?: string;
}

export interface DeleteCellOp {
  op: 'delete_cell';
  id: string;
}

export interface SetMetadataOp {
  op: 'set_metadata';
  id: string;
  key: string;
  value: string;
}

export type Operation =
  | AddCellOp
  | AddEdgeOp
  | EditCellOp
  | EditEdgeOp
  | DeleteCellOp
  | SetMetadataOp;

export interface BatchUpdateInput {
  session_id: string;
  operations: Operation[];
  auto_layout?: boolean;
}

// ─── Cloudflare Worker Env ────────────────────────────────────────────────────

export interface WorkerEnv {
  DIAGRAM_SESSION?: DurableObjectNamespace;
  ENVIRONMENT?: string;
}

// ─── MCP JSON-RPC (minimal) ──────────────────────────────────────────────────

export interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
