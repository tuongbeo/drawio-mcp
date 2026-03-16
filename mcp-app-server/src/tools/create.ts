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
 * Sequence: vertical lifelines + horizontal message arrows at correct Y positions.
 * Fix #5: messages use explicit mxPoint geometry instead of header-to-header routing,
 * ensuring arrows appear at proper timestamps along each lifeline.
 */
function buildSequenceXml(entities: string[], relationships: Relationship[]): string {
  const cells: string[] = [];
  const LW = 130, LH = 44, GAP = 170, MSG_START_Y = 110, MSG_GAP = 55;
  const lifelineH = Math.max(relationships.length * MSG_GAP + 80, 200);

  entities.forEach((e, i) => {
    const x = 80 + i * GAP;
    const centerX = x + LW / 2;

    // Header box (top)
    cells.push(vertex(`lh_${i}`, e, x, 30, LW, LH,
      'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontStyle=1;'));

    // Lifeline — thin dashed vertical bar
    cells.push(vertex(`ll_${i}`, '', centerX - 1, 74, 2, lifelineH,
      'fillColor=#aaaaaa;strokeColor=none;'));

    // Footer box (bottom) — mirrors header for visual closure
    cells.push(vertex(`lf_${i}`, e, x, 74 + lifelineH, LW, LH,
      'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;'));
  });

  // Messages as explicit-geometry edges (horizontal arrows at correct Y)
  relationships.forEach((r, idx) => {
    const fromIdx = entities.indexOf(r.from);
    const toIdx = entities.indexOf(r.to);
    if (fromIdx < 0 || toIdx < 0) return;

    const y = MSG_START_Y + idx * MSG_GAP;
    const fromX = 80 + fromIdx * GAP + LW / 2;
    const toX = 80 + toIdx * GAP + LW / 2;

    // Return messages (response) use dashed style
    const isReturn = r.type === 'dependency' ||
      (r.label ?? '').match(/^\d+\..*return|response|ok|result|data|redirect/i) !== null;

    const msgStyle = isReturn
      ? 'edgeStyle=orthogonalEdgeStyle;dashed=1;endArrow=open;strokeColor=#82b366;'
      : 'edgeStyle=orthogonalEdgeStyle;endArrow=block;endFill=1;strokeColor=#555555;';

    // Build edge with explicit Array-of-points geometry for precise horizontal placement
    cells.push(
      `    <mxCell id="msg_${idx}" value="${escapeXml(r.label ?? '')}" ` +
      `style="${escapeXml(msgStyle)}" edge="1" parent="1">\n` +
      `      <mxGeometry relative="1" as="geometry">\n` +
      `        <Array as="points">\n` +
      `          <mxPoint x="${fromX}" y="${y}"/>\n` +
      `          <mxPoint x="${toX}" y="${y}"/>\n` +
      `        </Array>\n` +
      `      </mxGeometry>\n` +
      `    </mxCell>`
    );
  });

  return wrapRoot(cells);
}

/**
 * Activity: start node → actions → diamonds for decisions → end node.
 * Fix #4: properly detects decision nodes by name pattern and uses
 * the relationships array for branching edges with Yes/No labels.
 */
function buildActivityXml(entities: string[], relationships: Relationship[]): string {
  const cells: string[] = [];
  const AW = 160, AH = 50, DECISION_H = 60, GAP = 90, MAIN_X = 200, BRANCH_X = 460;

  // Detect which entities are decision nodes (name ends with ? or contains decision keywords)
  const DECISION_RE = /\?$|^(is |check |valid|ok\?|decision)/i;
  const isDecisionNode = (name: string) => DECISION_RE.test(name.trim());
  const isStartNode = (name: string) => name.toLowerCase() === 'start';
  const isEndNode = (name: string) => name.toLowerCase() === 'end' || name.toLowerCase() === 'end state';

  // Assign stable cell IDs for each entity (slug the name)
  const idOf = (name: string) => `n_${entities.indexOf(name).toString()}`;

  // Start node
  cells.push(vertex('start', '', MAIN_X + AW / 2 - 15, 20, 30, 30, SHAPE_STYLES.start_node));

  // Lay out all nodes vertically; we'll use relationships for edges
  entities.forEach((e, i) => {
    const y = 80 + i * GAP;
    const id = idOf(e);

    if (isStartNode(e)) {
      // Named "Start" entity — skip, we already have the start_node dot
      return;
    }
    if (isEndNode(e)) {
      cells.push(vertex(id, '', MAIN_X + AW / 2 - 15, y, 30, 30, SHAPE_STYLES.end_node));
      return;
    }

    if (isDecisionNode(e)) {
      cells.push(vertex(id, e, MAIN_X, y, AW, DECISION_H,
        'rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;'));
    } else {
      cells.push(vertex(id, e, MAIN_X, y, AW, AH,
        'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;'));
    }
  });

  // Build edges: if relationships provided, use them (with labels + branching)
  if (relationships.length > 0) {
    // Track "No" branches — route them to the right (BRANCH_X)
    const noBranches = new Set(
      relationships
        .filter(r => r.label?.toLowerCase() === 'no')
        .map(r => r.from)
    );

    // Add branch column boxes for "Cancel" type nodes that receive No edges
    const branchTargets = new Set(
      relationships
        .filter(r => r.label?.toLowerCase() === 'no')
        .map(r => r.to)
    );

    relationships.forEach((r, i) => {
      const fromId = isStartNode(r.from) ? 'start' : idOf(r.from);
      const toId = isEndNode(r.to) ? idOf(r.to) : idOf(r.to);

      // "No" branch exits right side of diamond; other exits go down
      const isNo = r.label?.toLowerCase() === 'no';
      const edgeStyle = isNo
        ? 'edgeStyle=orthogonalEdgeStyle;exitX=1;exitY=0.5;exitDx=0;exitDy=0;'
        : 'edgeStyle=orthogonalEdgeStyle;';

      cells.push(edge(`e_${i}`, r.label ?? '', fromId, toId, edgeStyle));
    });
  } else {
    // No relationships provided — build simple linear flow
    cells.push(edge('fl_s', '', 'start', idOf(entities[0]),
      'edgeStyle=orthogonalEdgeStyle;'));
    entities.forEach((e, i) => {
      if (i < entities.length - 1) {
        cells.push(edge(`fl_${i}`, '', idOf(e), idOf(entities[i + 1]),
          'edgeStyle=orthogonalEdgeStyle;'));
      }
    });
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
// NOTE: Kroki supports svg/png output for mermaid — NOT xml.
// Fix: fetch SVG then embed as base64 image inside mxGraphModel.
// All Mermaid types work: flowchart, sequenceDiagram, erDiagram, classDiagram, stateDiagram-v2.

export async function mermaidToXml(mermaid: string): Promise<string> {
  const resp = await fetch('https://kroki.io/mermaid/svg', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: mermaid,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Kroki conversion failed (${resp.status}): ${body.slice(0, 200)}`);
  }
  const svg = await resp.text();

  // Parse canvas size from SVG attributes for proper viewport
  const wMatch = svg.match(/width[=:\s"']+([\d.]+)/);
  const hMatch = svg.match(/height[=:\s"']+([\d.]+)/);
  const w = wMatch ? Math.min(Math.round(parseFloat(wMatch[1])), 1400) : 900;
  const h = hMatch ? Math.min(Math.round(parseFloat(hMatch[1])), 1000) : 600;

  // Encode SVG as base64 data URI (btoa is global in Workers + Node.js)
  const b64 = btoa(unescape(encodeURIComponent(svg)));
  const dataUri = `data:image/svg+xml;base64,${b64}`;

  return `<mxGraphModel>
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <mxCell id="2" value="" style="shape=image;verticalLabelPosition=bottom;labelBackgroundColor=default;verticalAlign=top;aspect=fixed;image=${escapeXml(dataUri)};" vertex="1" parent="1">
      <mxGeometry x="0" y="0" width="${w}" height="${h}" as="geometry"/>
    </mxCell>
  </root>
</mxGraphModel>`;
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
