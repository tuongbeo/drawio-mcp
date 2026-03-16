/**
 * Phase 2 — Export Tools (Stateless)
 * export_diagram → calls export.diagrams.net public API with SVG inline fallback.
 *
 * Fix #2: export.diagrams.net returns CF error 530/1016 from Worker network.
 * Fallback: for SVG, generate inline from mxGraph XML without external API.
 */

import type { ExportDiagramInput, ExportDiagramOutput } from '../types.js';

// ─── MIME map ────────────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

// ─── Primary: export.diagrams.net API ────────────────────────────────────────

async function exportViaExternalApi(input: ExportDiagramInput): Promise<ExportDiagramOutput> {
  const { xml, format, scale = 1, transparent = false, width } = input;

  if (scale < 1 || scale > 4) throw new Error('scale must be between 1 and 4');

  const params = new URLSearchParams({ xml, format, scale: String(scale) });
  if (transparent && format === 'png') params.set('transparent', '1');
  if (width !== undefined) params.set('w', String(width));

  const resp = await fetch('https://export.diagrams.net/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`export.diagrams.net returned ${resp.status}: ${errBody.slice(0, 200)}`);
  }

  const buffer = await resp.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }

  return {
    base64: btoa(binary),
    mime_type: MIME_MAP[format] ?? 'application/octet-stream',
    filename: `diagram.${format}`,
    size_bytes: buffer.byteLength,
  };
}

// ─── SVG Inline Fallback ──────────────────────────────────────────────────────
// Generates basic SVG representation from mxGraph XML without external API.
// Used when export.diagrams.net is unreachable (e.g. CF Worker network block).

interface ParsedCell {
  id: string; value: string; style: string;
  isEdge: boolean; isVertex: boolean;
  x: number; y: number; w: number; h: number;
  source?: string; target?: string;
}

function parseCellsFromXml(xml: string): ParsedCell[] {
  const cells: ParsedCell[] = [];
  const cellRe = /<mxCell([^>]*)>([\s\S]*?)<\/mxCell>|<mxCell([^>]*)\/>/g;
  const attrRe = /(\w[\w-]*)="([^"]*)"/g;
  let m: RegExpExecArray | null;

  while ((m = cellRe.exec(xml)) !== null) {
    const raw = m[1] ?? m[3] ?? '';
    const inner = m[2] ?? '';
    const attrs: Record<string, string> = {};
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(raw)) !== null) attrs[a[1]] = a[2];

    const geoRe = /mxGeometry[^>]*x="([^"]*)"[^>]*y="([^"]*)"[^>]*width="([^"]*)"[^>]*height="([^"]*)"/;
    const gm = geoRe.exec(inner);

    if (!attrs.id || attrs.id === '0' || attrs.id === '1') continue;

    cells.push({
      id: attrs.id ?? '',
      value: attrs.value ?? '',
      style: attrs.style ?? '',
      isEdge: attrs.edge === '1',
      isVertex: attrs.vertex === '1',
      x: gm ? parseFloat(gm[1]) : 0,
      y: gm ? parseFloat(gm[2]) : 0,
      w: gm ? parseFloat(gm[3]) : 120,
      h: gm ? parseFloat(gm[4]) : 60,
      source: attrs.source,
      target: attrs.target,
    });
  }
  return cells;
}

function renderCellAsSvg(cell: ParsedCell, cellMap: Map<string, ParsedCell>): string {
  if (cell.isEdge) {
    const src = cellMap.get(cell.source ?? '');
    const tgt = cellMap.get(cell.target ?? '');
    if (!src || !tgt) return '';
    const x1 = src.x + src.w / 2, y1 = src.y + src.h / 2;
    const x2 = tgt.x + tgt.w / 2, y2 = tgt.y + tgt.h / 2;
    const dashed = cell.style.includes('dashed=1') ? ' stroke-dasharray="6,3"' : '';
    const label = cell.value
      ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 4}" text-anchor="middle" font-family="Arial" font-size="11" fill="#555">${escSvg(cell.value)}</text>`
      : '';
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#555" stroke-width="1.5"${dashed} marker-end="url(#arrow)"/>${label}`;
  }

  const { x, y, w, h, style, value } = cell;
  const fill = style.includes('fillColor=#') ? (style.match(/fillColor=(#[0-9a-fA-F]+)/))?.[1] ?? '#dae8fc' : '#dae8fc';
  const stroke = style.includes('strokeColor=#') ? (style.match(/strokeColor=(#[0-9a-fA-F]+)/))?.[1] ?? '#6c8ebf' : '#6c8ebf';
  let shape = '';

  if (style.includes('ellipse') && style.includes('double=1')) {
    // End node
    shape = `<circle cx="${x + w / 2}" cy="${y + h / 2}" r="${Math.min(w, h) / 2}" fill="#333"/><circle cx="${x + w / 2}" cy="${y + h / 2}" r="${Math.min(w, h) / 2 - 3}" fill="none" stroke="#fff" stroke-width="2"/>`;
  } else if (style.includes('ellipse') && style.includes('fillColor=#000000')) {
    // Start node
    shape = `<circle cx="${x + w / 2}" cy="${y + h / 2}" r="${Math.min(w, h) / 2}" fill="#333"/>`;
  } else if (style.includes('rhombus')) {
    // Diamond
    shape = `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
  } else if (style.includes('ellipse')) {
    shape = `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
  } else {
    const rx = style.includes('rounded=1') ? '8' : '2';
    shape = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
  }

  const label = value
    ? `<text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle" dominant-baseline="middle" font-family="Arial,sans-serif" font-size="12" fill="#333">${escSvg(value)}</text>`
    : '';
  return shape + label;
}

function escSvg(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateInlineSvg(xml: string, scale = 1): ExportDiagramOutput {
  const cells = parseCellsFromXml(xml);
  const cellMap = new Map(cells.map(c => [c.id, c]));

  // Calculate bounding box
  const vertices = cells.filter(c => c.isVertex);
  const pad = 30;
  const minX = Math.min(...vertices.map(c => c.x), 0) - pad;
  const minY = Math.min(...vertices.map(c => c.y), 0) - pad;
  const maxX = Math.max(...vertices.map(c => c.x + c.w), 100) + pad;
  const maxY = Math.max(...vertices.map(c => c.y + c.h), 100) + pad;
  const vw = (maxX - minX) * scale;
  const vh = (maxY - minY) * scale;

  const shapeSvg = cells.map(c => renderCellAsSvg(c, cellMap)).filter(Boolean).join('\n  ');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="#555"/>
    </marker>
  </defs>
  <rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="white"/>
  ${shapeSvg}
</svg>`;

  const b64 = btoa(unescape(encodeURIComponent(svg)));
  return {
    base64: b64,
    mime_type: 'image/svg+xml',
    filename: 'diagram.svg',
    size_bytes: svg.length,
  };
}

// ─── Public export function with SVG fallback ─────────────────────────────────

export async function exportDiagram(input: ExportDiagramInput): Promise<ExportDiagramOutput> {
  // Try external API first (best quality — full Chromium rendering)
  try {
    return await exportViaExternalApi(input);
  } catch (primaryErr) {
    // SVG fallback: generate inline from XML (no external API needed)
    if (input.format === 'svg') {
      try {
        return generateInlineSvg(input.xml, input.scale ?? 1);
      } catch (fallbackErr) {
        throw new Error(
          `Export failed (API: ${String(primaryErr)}) and SVG fallback also failed: ${String(fallbackErr)}`
        );
      }
    }

    // PNG/PDF: no inline fallback — provide actionable error
    throw new Error(
      `Export API unavailable: ${String(primaryErr)}\n\n` +
      `Alternatives for PNG/PDF:\n` +
      `  1. Use format="svg" — inline SVG fallback is available\n` +
      `  2. Export manually at https://app.diagrams.net (paste XML, File → Export)\n` +
      `  3. Self-host the export service on a non-Cloudflare host\n` +
      `  Note: export.diagrams.net may block outbound requests from CF Worker IPs (error 530/1016).`
    );
  }
}

// ─── Format tool output as MCP text content ──────────────────────────────────

export function formatExportOutput(result: ExportDiagramOutput): string {
  return JSON.stringify({
    status: 'exported',
    filename: result.filename,
    mime_type: result.mime_type,
    size_bytes: result.size_bytes,
    base64_preview: result.base64.slice(0, 80) + '...',
    base64: result.base64,
  }, null, 2);
}
