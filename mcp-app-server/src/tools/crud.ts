/**
 * Phase 4 — CRUD Tools (Stateful, Session-based)
 * batch_update | list_cells | get_diagram
 * XML manipulation via fast-xml-parser (Workers-compatible)
 */

import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import type {
  Operation,
  AddCellOp,
  AddEdgeOp,
  EditCellOp,
  EditEdgeOp,
  SessionData,
} from '../types.js';
import { SHAPE_STYLES } from './create.js';

// ─── XML Parser Config ────────────────────────────────────────────────────────

const PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'mxCell',
  allowBooleanAttributes: true,
});

const BUILDER = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  indentBy: '  ',
});

// ─── Parsed Structures ────────────────────────────────────────────────────────

interface MxGeometry {
  '@_x'?: string | number;
  '@_y'?: string | number;
  '@_width'?: string | number;
  '@_height'?: string | number;
  '@_relative'?: string;
  '@_as': string;
}

interface MxCell {
  '@_id': string;
  '@_value'?: string;
  '@_style'?: string;
  '@_vertex'?: string;
  '@_edge'?: string;
  '@_source'?: string;
  '@_target'?: string;
  '@_parent': string;
  mxGeometry?: MxGeometry;
}

interface ParsedXml {
  mxGraphModel: {
    root: {
      mxCell: MxCell[];
    };
  };
}

// ─── Parse XML to Cells Array ─────────────────────────────────────────────────

function parseXml(xml: string): MxCell[] {
  const parsed = PARSER.parse(xml) as ParsedXml;
  return parsed?.mxGraphModel?.root?.mxCell ?? [];
}

// ─── Serialize Cells back to XML ──────────────────────────────────────────────

function serializeXml(cells: MxCell[]): string {
  const obj = {
    mxGraphModel: {
      root: {
        mxCell: cells,
      },
    },
  };
  return BUILDER.build(obj) as string;
}

// ─── Operation Handlers ────────────────────────────────────────────────────────

function applyAddCell(cells: MxCell[], op: AddCellOp): MxCell[] {
  const style = op.style ?? SHAPE_STYLES[op.shape] ?? SHAPE_STYLES.rectangle;
  const newCell: MxCell = {
    '@_id': op.id,
    '@_value': op.label,
    '@_style': style,
    '@_vertex': '1',
    '@_parent': '1',
    mxGeometry: {
      '@_x': op.x,
      '@_y': op.y,
      '@_width': op.width ?? 120,
      '@_height': op.height ?? 60,
      '@_as': 'geometry',
    },
  };
  return [...cells, newCell];
}

function applyAddEdge(cells: MxCell[], op: AddEdgeOp): MxCell[] {
  const newEdge: MxCell = {
    '@_id': op.id,
    '@_value': op.label ?? '',
    '@_style': op.style ?? 'edgeStyle=orthogonalEdgeStyle;',
    '@_edge': '1',
    '@_source': op.source_id,
    '@_target': op.target_id,
    '@_parent': '1',
    mxGeometry: {
      '@_relative': '1',
      '@_as': 'geometry',
    },
  };
  return [...cells, newEdge];
}

function applyEditCell(cells: MxCell[], op: EditCellOp): MxCell[] {
  return cells.map((c) => {
    if (c['@_id'] !== op.id) return c;
    const updated: MxCell = { ...c };
    if (op.label !== undefined) updated['@_value'] = op.label;
    if (op.style !== undefined) updated['@_style'] = op.style;
    if (
      op.x !== undefined ||
      op.y !== undefined ||
      op.width !== undefined ||
      op.height !== undefined
    ) {
      updated.mxGeometry = {
        ...updated.mxGeometry,
        '@_as': 'geometry',
        ...(op.x !== undefined && { '@_x': op.x }),
        ...(op.y !== undefined && { '@_y': op.y }),
        ...(op.width !== undefined && { '@_width': op.width }),
        ...(op.height !== undefined && { '@_height': op.height }),
      };
    }
    return updated;
  });
}

function applyEditEdge(cells: MxCell[], op: EditEdgeOp): MxCell[] {
  return cells.map((c) => {
    if (c['@_id'] !== op.id) return c;
    const updated: MxCell = { ...c };
    if (op.label !== undefined) updated['@_value'] = op.label;
    if (op.style !== undefined) updated['@_style'] = op.style;
    if (op.source_id !== undefined) updated['@_source'] = op.source_id;
    if (op.target_id !== undefined) updated['@_target'] = op.target_id;
    return updated;
  });
}

function applyDeleteCell(cells: MxCell[], id: string): MxCell[] {
  return cells.filter(
    (c) => c['@_id'] !== id && c['@_source'] !== id && c['@_target'] !== id,
  );
}

// ─── Single-operation dispatcher ─────────────────────────────────────────────

export function applyOperation(xml: string, op: Operation): string {
  const cells = parseXml(xml);

  let updated: MxCell[];
  switch (op.op) {
    case 'add_cell':
      updated = applyAddCell(cells, op);
      break;
    case 'add_edge':
      updated = applyAddEdge(cells, op);
      break;
    case 'edit_cell':
      updated = applyEditCell(cells, op);
      break;
    case 'edit_edge':
      updated = applyEditEdge(cells, op);
      break;
    case 'delete_cell':
      updated = applyDeleteCell(cells, op.id);
      break;
    case 'set_metadata': {
      // Store metadata as attribute on the cell (draw.io compatible)
      updated = cells.map((c) => {
        if (c['@_id'] !== op.id) return c;
        return { ...c, [`@_${op.key}`]: op.value };
      });
      break;
    }
    default:
      throw new Error(`Unknown operation: ${(op as { op: string }).op}`);
  }

  return serializeXml(updated);
}

// ─── Batch update ────────────────────────────────────────────────────────────

export function applyBatchOperations(xml: string, operations: Operation[]): string {
  let current = xml;
  for (const op of operations) {
    current = applyOperation(current, op);
  }
  return current;
}

// ─── List cells (paginated) ────────────────────────────────────────────────────

export interface CellSummary {
  id: string;
  label: string;
  type: 'vertex' | 'edge';
  shape_hint: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  source?: string;
  target?: string;
}

export function listCells(
  xml: string,
  offset = 0,
  limit = 50,
): { cells: CellSummary[]; total: number; has_more: boolean } {
  const cells = parseXml(xml).filter(
    (c) => c['@_id'] !== '0' && c['@_id'] !== '1',
  );
  const total = cells.length;
  const page = cells.slice(offset, offset + limit);

  const summaries: CellSummary[] = page.map((c) => {
    const isEdge = c['@_edge'] === '1';
    const geo = c.mxGeometry;
    const item: CellSummary = {
      id: c['@_id'],
      label: c['@_value'] ?? '',
      type: isEdge ? 'edge' : 'vertex',
      shape_hint: guessShape(c['@_style'] ?? ''),
    };
    if (!isEdge && geo) {
      item.x = Number(geo['@_x'] ?? 0);
      item.y = Number(geo['@_y'] ?? 0);
      item.width = Number(geo['@_width'] ?? 120);
      item.height = Number(geo['@_height'] ?? 60);
    }
    if (isEdge) {
      item.source = c['@_source'];
      item.target = c['@_target'];
    }
    return item;
  });

  return {
    cells: summaries,
    total,
    has_more: offset + limit < total,
  };
}

function guessShape(style: string): string {
  if (style.includes('shape=mxgraph.uml.actor')) return 'actor';
  if (style.includes('ellipse') && style.includes('double')) return 'end_node';
  if (style.includes('ellipse') && style.includes('fillColor=#000000')) return 'start_node';
  if (style.includes('ellipse')) return 'ellipse';
  if (style.includes('rhombus')) return 'diamond';
  if (style.includes('cylinder')) return 'cylinder';
  if (style.includes('cloud')) return 'cloud';
  if (style.includes('document')) return 'document';
  if (style.includes('swimlane')) return 'swimlane';
  if (style.includes('rounded=1')) return 'rounded_rectangle';
  return 'rectangle';
}

// ─── Blank diagram XML ────────────────────────────────────────────────────────

export function blankDiagramXml(title = 'Untitled'): string {
  return `<mxGraphModel>
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
  </root>
</mxGraphModel>`;
}

// ─── Validate that XML is parseable draw.io XML ────────────────────────────────

export function validateDiagramXml(xml: string): { valid: boolean; error?: string } {
  try {
    const cells = parseXml(xml);
    const hasRoot = cells.some((c) => c['@_id'] === '0' || c['@_id'] === '1');
    if (!hasRoot) return { valid: false, error: 'Missing root cells (id=0, id=1)' };
    return { valid: true };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}

// ─── Session helpers (used by worker.ts tools) ────────────────────────────────

export function createSessionData(xml?: string, title?: string): SessionData {
  const now = new Date().toISOString();
  return {
    xml: xml ?? blankDiagramXml(title),
    title: title ?? 'Untitled',
    created_at: now,
    updated_at: now,
    metadata: {},
  };
}

export function updateSessionXml(session: SessionData, xml: string): SessionData {
  return { ...session, xml, updated_at: new Date().toISOString() };
}
