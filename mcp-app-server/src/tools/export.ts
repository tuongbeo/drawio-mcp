/**
 * Phase 2 — Export Tools (Stateless)
 * export_diagram → calls export.diagrams.net public API
 */

import type { ExportDiagramInput, ExportDiagramOutput } from '../types.js';

// ─── MIME map ────────────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

// ─── Core export function (Workers-safe: uses fetch + btoa + Uint8Array) ─────

export async function exportDiagram(
  input: ExportDiagramInput,
): Promise<ExportDiagramOutput> {
  const { xml, format, scale = 1, transparent = false, width } = input;

  // Validate scale range
  if (scale < 1 || scale > 4) {
    throw new Error('scale must be between 1 and 4');
  }

  const params = new URLSearchParams({
    xml,
    format,
    scale: String(scale),
  });

  if (transparent && format === 'png') {
    params.set('transparent', '1');
  }
  if (width !== undefined) {
    params.set('w', String(width));
  }

  const resp = await fetch('https://export.diagrams.net/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(
      `export.diagrams.net returned ${resp.status}: ${errBody.slice(0, 200)}`,
    );
  }

  const buffer = await resp.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // btoa is global in both Workers and modern Node.js
  // Chunk to avoid call-stack overflow on large diagrams
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const base64 = btoa(binary);

  return {
    base64,
    mime_type: MIME_MAP[format] ?? 'application/octet-stream',
    filename: `diagram.${format}`,
    size_bytes: buffer.byteLength,
  };
}

// ─── Format tool output as MCP text content ──────────────────────────────────

export function formatExportOutput(result: ExportDiagramOutput): string {
  return JSON.stringify({
    status: 'exported',
    filename: result.filename,
    mime_type: result.mime_type,
    size_bytes: result.size_bytes,
    // Include first 80 chars of base64 as preview hint
    base64_preview: result.base64.slice(0, 80) + '...',
    base64: result.base64,
  }, null, 2);
}
