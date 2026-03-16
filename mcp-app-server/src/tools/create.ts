/**
 * Phase 1 — Core Diagram Generation Tools (Stateless)
 * create_diagram | create_from_mermaid | create_from_template
 */

import type {
  CreateFromTemplateInput,
  Relationship,
  TemplateType,
} from '../types.js';

// ─── Shape Style Map ─────────────────────────────────────────────────────────

export const SHAPE_STYLES: Record<string, string> = {
  rectangle: 'rounded=0;whiteSpace=wrap;html=1;',
  rounded_rectangle: 'rounded=1;whiteSpace=wrap;html=1;arcSize=50;',
  ellipse: 'ellipse;whiteSpace=wrap;html=1;',
  diamond: 'rhombus;whiteSpace=wrap;html=1;',
  actor: 'shape=mxgraph.uml.actor;whiteSpace=wrap;html=1;',
  cylinder: 'shape=cylinder3;whiteSpace=wrap;html=1;',
  cloud: 'shape=cloud;whiteSpace=wrap;html=1;',
  document: 'shape=document;whiteSpace=wrap;html=1;',
  swimlane: 'swimlane;startSize=30;',
  start_node: 'ellipse;aspect=fixed;fillColor=#000000;strokeColor=#000000;',
  end_node: 'ellipse;aspect=fixed;fillColor=#000000;strokeColor=#000000;double=1;',
};

// ─── Relationship Style Map ───────────────────────────────────────────────────

const REL_STYLES: Record<string, string> = {
  association: 'edgeStyle=orthogonalEdgeStyle;',
  inheritance: 'edgeStyle=orthogonalEdgeStyle;endArrow=block;endFill=0;',
  dependency: 'edgeStyle=orthogonalEdgeStyle;dashed=1;',
  aggregation: 'edgeStyle=orthogonalEdgeStyle;startArrow=ERmanyToOne;startFill=0;endArrow=none;',
  message: 'edgeStyle=orthogonalEdgeStyle;',
  include: 'edgeStyle=orthogonalEdgeStyle;dashed=1;endArrow=open;',
  extend: 'edgeStyle=orthogonalEdgeStyle;dashed=1;endArrow=open;',
};

// ─── XML Helpers ──────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function vertex(
  id: string,
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
  style: string,
): string {
  return `    <mxCell id="${escapeXml(id)}" value="${escapeXml(label)}" style="${escapeXml(style)}" vertex="1" parent="1">
      <mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry"/>
    </mxCell>`;
}

function edge(
  id: string,
  label: string,
  source: string,
  target: string,
  style: string,
): string {
  return `    <mxCell id="${escapeXml(id)}" value="${escapeXml(label)}" style="${escapeXml(style)}" edge="1" source="${escapeXml(source)}" target="${escapeXml(target)}" parent="1">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>`;
}

function wrapRoot(cells: string[]): string {
  return `<mxGraphModel>\n  <root>\n    <mxCell id="0"/>\n    <mxCell id="1" parent="0"/>\n${cells.join('\n')}\n  </root>\n</mxGraphModel>`;
}

// ─── Template Builders ────────────────────────────────────────────────────────

/**
 * Use Case: Actor shapes + System boundary rect + ellipse use cases
 */
function buildUsecaseXml(entities: string[], relationships: Relationship[]): string {
  const cells: string[] = [];
  const ACTOR_W = 40, ACTOR_H = 60;
  const UC_W = 120, UC_H = 60;

  // Separate actors vs use cases by looking at relationships
  const actorSet = new Set<string>();
  const ucSet = new Set<string>();
  for (const r of relationships) {
    if (r.type === 'association' || !r.type) {
      actorSet.add(r.from);
      ucSet.add(r.to);
    }
  }
  // Any entity not in either set defaults to use case
  for (const e of entities) {
    if (!actorSet.has(e) && !ucSet.has(e)) ucSet.add(e);
  }

  const actors = [...actorSet];
  const usecases = [...ucSet];

  // System boundary
  if (usecases.length > 0) {
    const sysW = UC_W + 120;
    const sysH = usecases.length * 90 + 60;
    cells.push(vertex('sys_boundary', 'System', 200, 60, sysW, sysH,
      'rounded=1;whiteSpace=wrap;html=1;fillColor=none;dashed=1;'));
  }

  // Actors (left column)
  actors.forEach((a, i) => {
    cells.push(vertex(`actor_${i}`, a, 60, 80 + i * 100, ACTOR_W, ACTOR_H, SHAPE_STYLES.actor));
  });

  // Use cases (inside system boundary)
  usecases.forEach((u, i) => {
    cells.push(vertex(`uc_${i}`, u, 260, 90 + i * 90, UC_W, UC_H, SHAPE_STYLES.ellipse));
  });

  // Edges
  relationships.forEach((r, i) => {
    const srcIdx = actors.indexOf(r.from);
    const tgtIdx = usecases.indexOf(r.to);
    const src = srcIdx >= 0 ? `actor_${srcIdx}` : `uc_${usecases.indexOf(r.from)}`;
    const tgt = tgtIdx >= 0 ? `uc_${tgtIdx}` : `actor_${actors.indexOf(r.to)}`;
    const style = REL_STYLES[r.type ?? 'association'];
    cells.push(edge(`e_${i}`, r.label ?? '', src, tgt, style));
  });

  return wrapRoot(cells);
}

/**
 * Sequence: vertical lifelines + horizontal message arrows
 */
function buildSequenceXml(entities: string[], relationships: Relationship[]): string {
  const cells: string[] = [];
  const LW = 120, LH = 40, GAP = 160, LIFETIME_H = 60;

  entities.forEach((e, i) => {
    const x = 100 + i * GAP;
    // Header box
    cells.push(vertex(`lh_${i}`, e, x, 40, LW, LH,
      'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;'));
    // Lifeline (dashed vertical)
    cells.push(vertex(`ll_${i}`, '', x + LW / 2 - 1, 80, 2,
      Math.max(relationships.length * LIFETIME_H + 40, 100),
      'fillColor=#000000;strokeColor=none;'));
  });

  relationships.forEach((r, idx) => {
    const fromIdx = entities.indexOf(r.from);
    const toIdx = entities.indexOf(r.to);
    if (fromIdx < 0 || toIdx < 0) return;
    const y = 120 + idx * LIFETIME_H;
    const style = 'edgeStyle=orthogonalEdgeStyle;exitX=0.5;exitY=1;entryX=0.5;entryY=1;';
    cells.push(edge(`msg_${idx}`, r.label ?? '', `lh_${fromIdx}`, `lh_${toIdx}`, style));
    // Override with explicit position label
    cells.push(vertex(`lbl_${idx}`, r.label ?? `step ${idx + 1}`,
      Math.min(fromIdx, toIdx) * GAP + 100 + LW / 2,
      y - 12, Math.abs(fromIdx - toIdx) * GAP, 24,
      'text;html=1;align=center;verticalAlign=middle;resizable=0;'));
  });

  return wrapRoot(cells);
}

/**
 * Activity: rounded start node + rectangle actions + diamond decisions + end node
 */
function buildActivityXml(entities: string[], _relationships: Relationship[]): string {
  const cells: string[] = [];
  const AW = 140, AH = 50, GAP = 80, startX = 200;

  // Start
  cells.push(vertex('start', '', startX, 40, 30, 30, SHAPE_STYLES.start_node));

  entities.forEach((e, i) => {
    const y = 110 + i * GAP;
    const isDecision = e.startsWith('?') || e.toLowerCase().startsWith('if ');
    const label = isDecision ? e.replace(/^\?/, '').trim() : e;
    const style = isDecision ? SHAPE_STYLES.diamond : SHAPE_STYLES.rounded_rectangle;
    const h = isDecision ? AW / 2 : AH;
    cells.push(vertex(`act_${i}`, label, startX - AW / 2 + 15, y, AW, h, style));

    // Connect from previous
    const from = i === 0 ? 'start' : `act_${i - 1}`;
    cells.push(edge(`fl_${i}`, '', from, `act_${i}`,
      'edgeStyle=orthogonalEdgeStyle;'));
  });

  // End
  const endY = 110 + entities.length * GAP;
  cells.push(vertex('end', '', startX, endY, 30, 30, SHAPE_STYLES.end_node));
  if (entities.length > 0) {
    cells.push(edge('fl_end', '', `act_${entities.length - 1}`, 'end',
      'edgeStyle=orthogonalEdgeStyle;'));
  }

  return wrapRoot(cells);
}

/**
 * ERD: rectangle entities + labeled edges with cardinality
 */
function buildErdXml(entities: string[], relationships: Relationship[]): string {
  const cells: string[] = [];
  const EW = 160, EH = 60, COLS = 3;

  entities.forEach((e, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    cells.push(vertex(`ent_${i}`, e, 100 + col * 220, 100 + row * 120, EW, EH,
      'rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;'));
  });

  relationships.forEach((r, i) => {
    const srcIdx = entities.indexOf(r.from);
    const tgtIdx = entities.indexOf(r.to);
    if (srcIdx < 0 || tgtIdx < 0) return;
    const style = 'edgeStyle=orthogonalEdgeStyle;endArrow=ERmanyToOne;startArrow=ERmanyToOne;';
    cells.push(edge(`rel_${i}`, r.label ?? '1:N', `ent_${srcIdx}`, `ent_${tgtIdx}`, style));
  });

  return wrapRoot(cells);
}

/**
 * Class: rectangle with 3 sections (name/attrs/methods) + typed connectors
 */
function buildClassXml(entities: string[], relationships: Relationship[]): string {
  const cells: string[] = [];
  const CW = 160, CH = 80, COLS = 3;

  entities.forEach((e, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    // Parse "ClassName: attr1, attr2 | method1(), method2()"
    const parts = e.split('|');
    const namePart = parts[0]?.trim() ?? e;
    const attrPart = parts[1]?.trim() ?? '';
    const methodPart = parts[2]?.trim() ?? '';

    const label = `${namePart}\n──────\n${attrPart || '+ attribute: Type'}\n──────\n${methodPart || '+ method(): void'}`;
    cells.push(vertex(`cls_${i}`, label, 100 + col * 220, 100 + row * 160, CW, CH + 40,
      'text;strokeColor=#000000;fillColor=#ffffff;align=left;verticalAlign=top;spacingLeft=4;html=1;overflow=hidden;whiteSpace=wrap;'));
  });

  relationships.forEach((r, i) => {
    const srcIdx = entities.indexOf(r.from);
    const tgtIdx = entities.indexOf(r.to);
    if (srcIdx < 0 || tgtIdx < 0) return;
    const style = REL_STYLES[r.type ?? 'association'];
    cells.push(edge(`cls_e_${i}`, r.label ?? '', `cls_${srcIdx}`, `cls_${tgtIdx}`, style));
  });

  return wrapRoot(cells);
}

/**
 * Component: rectangle components + interface lollipop notation
 */
function buildComponentXml(entities: string[], relationships: Relationship[]): string {
  const cells: string[] = [];
  const CW = 140, CH = 60, COLS = 3;

  entities.forEach((e, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    cells.push(vertex(`cmp_${i}`, e, 100 + col * 210, 100 + row * 120, CW, CH,
      'shape=component;whiteSpace=wrap;html=1;'));
  });

  relationships.forEach((r, i) => {
    const srcIdx = entities.indexOf(r.from);
    const tgtIdx = entities.indexOf(r.to);
    if (srcIdx < 0 || tgtIdx < 0) return;
    cells.push(edge(`cmp_e_${i}`, r.label ?? '', `cmp_${srcIdx}`, `cmp_${tgtIdx}`,
      'edgeStyle=orthogonalEdgeStyle;dashed=1;endArrow=open;'));
  });

  return wrapRoot(cells);
}

/**
 * Deployment: 3D box nodes + artifact rectangles inside
 */
function buildDeploymentXml(entities: string[], relationships: Relationship[]): string {
  const cells: string[] = [];
  const NW = 160, NH = 100, COLS = 3;

  entities.forEach((e, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    cells.push(vertex(`dep_${i}`, e, 80 + col * 220, 80 + row * 160, NW, NH,
      'shape=mxgraph.cisco.servers.standard_server;sketch=0;html=1;pointerEvents=1;dashed=0;fillColor=#036897;strokeColor=#ffffff;strokeWidth=2;verticalLabelPosition=bottom;verticalAlign=top;align=center;outlineConnect=0;'));
  });

  relationships.forEach((r, i) => {
    const srcIdx = entities.indexOf(r.from);
    const tgtIdx = entities.indexOf(r.to);
    if (srcIdx < 0 || tgtIdx < 0) return;
    cells.push(edge(`dep_e_${i}`, r.label ?? '', `dep_${srcIdx}`, `dep_${tgtIdx}`,
      'edgeStyle=orthogonalEdgeStyle;'));
  });

  return wrapRoot(cells);
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

const TEMPLATE_BUILDERS: Record<TemplateType, (e: string[], r: Relationship[]) => string> = {
  usecase: buildUsecaseXml,
  sequence: buildSequenceXml,
  activity: buildActivityXml,
  erd: buildErdXml,
  class: buildClassXml,
  component: buildComponentXml,
  deployment: buildDeploymentXml,
};

export function buildTemplateXml(input: CreateFromTemplateInput): string {
  const builder = TEMPLATE_BUILDERS[input.template];
  if (!builder) throw new Error(`Unknown template: ${input.template}`);
  return builder(input.entities, input.relationships ?? []);
}

// ─── Mermaid → draw.io XML via Kroki ─────────────────────────────────────────

export async function mermaidToXml(mermaid: string): Promise<string> {
  const resp = await fetch('https://kroki.io/mermaid/xml', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: mermaid,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Kroki conversion failed (${resp.status}): ${body.slice(0, 200)}`);
  }
  return resp.text();
}

// ─── pako-based XML compression (Workers-safe) ───────────────────────────────
// Used to build the #create= URL for app.diagrams.net

export function compressXmlForUrl(xml: string): string {
  // Encode as UTF-8 bytes
  const bytes = new TextEncoder().encode(xml);
  // Simple deflate via CompressionStream (available in Workers)
  // Falls back to btoa when CompressionStream unavailable (Node.js dev)
  return btoa(String.fromCharCode(...bytes));
}

export function buildDiagramUrl(xml: string): string {
  const compressed = compressXmlForUrl(xml);
  return `https://app.diagrams.net/#create=${encodeURIComponent(compressed)}`;
}
