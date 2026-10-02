// Track T8 — low-level drawing on a jsPDF page: rich text with vector glyphs, chart symbols, small marks.
// Coordinates are points, y down from the top of the page (jsPDF's default with unit 'pt').
import type { jsPDF } from 'jspdf';
import type { ChartSymbol, ShapeId } from './symbols';
import { type GlyphId, type LaidLine, type Measure, type Rgb, type TextStyle } from './text';

export const INK: Rgb = [33, 30, 27];
export const MUTED: Rgb = [104, 97, 89];
export const FAINT: Rgb = [150, 143, 134];
export const RULE: Rgb = [216, 209, 200];
export const PANEL: Rgb = [247, 244, 239];
export const ACCENT: Rgb = [169, 75, 37];
export const ACCENT_SOFT: Rgb = [247, 231, 221];
export const WHITE: Rgb = [255, 255, 255];
/** Thin chart grid lines and the heavy every-10 lines. */
export const GRID_THIN: Rgb = [112, 106, 98];
export const GRID_HEAVY: Rgb = [28, 26, 24];

/** Body text styles. */
export const BODY: TextStyle = { font: 'helvetica', style: 'normal', size: 9.5, color: INK };

/** Font objects by "name/style", for width measuring without switching the current font. */
type FontObject = unknown;

/** A `Measure` over a jsPDF document's standard fonts. */
export function measurerOf(pdf: jsPDF): Measure {
  const cache = new Map<string, FontObject>();
  const internal = pdf.internal as unknown as { getFont(name: string, style: string): FontObject };
  return (text, style) => {
    const key = `${style.font}/${style.style}`;
    let font = cache.get(key);
    if (!font) {
      font = internal.getFont(style.font, style.style);
      cache.set(key, font);
    }
    // No kerning: the text operators jsPDF writes are not kerned either, so a kerned width would drift.
    return pdf.getStringUnitWidth(text, { font, doKerning: false }) * style.size;
  };
}

/** Tracks the current text state so repeated runs in one style do not re-set it. */
export class Pen {
  private font = '';
  private size = -1;
  private color = '';
  readonly pdf: jsPDF;
  constructor(pdf: jsPDF) {
    this.pdf = pdf;
  }

  style(s: TextStyle): void {
    const f = `${s.font}/${s.style}`;
    if (f !== this.font) {
      this.pdf.setFont(s.font, s.style);
      this.font = f;
    }
    if (s.size !== this.size) {
      this.pdf.setFontSize(s.size);
      this.size = s.size;
    }
    const c = s.color.join(',');
    if (c !== this.color) {
      this.pdf.setTextColor(s.color[0], s.color[1], s.color[2]);
      this.color = c;
    }
  }

  /** After drawing with another font (Symbol), forget the state. */
  reset(): void {
    this.font = '';
    this.size = -1;
    this.color = '';
  }

  text(text: string, x: number, y: number, s: TextStyle, opts?: { align?: 'left' | 'right' | 'center'; charSpace?: number }): void {
    if (!text) return;
    this.style(s);
    if (opts?.align || opts?.charSpace) this.pdf.text(text, x, y, { align: opts.align, charSpace: opts.charSpace });
    else this.pdf.text(text, x, y);
  }
}

/** Draws a laid-out line with its baseline at `y`. */
export function drawLine(pen: Pen, line: LaidLine, x: number, y: number): void {
  for (const p of line.pieces) {
    if (p.kind === 'text') pen.text(p.text, x + p.x, y, p.style);
    else drawGlyph(pen, p.glyph, x + p.x, y, p.width, p.style);
  }
}

function strokeSegment(pdf: jsPDF, ax: number, ay: number, bx: number, by: number): void {
  pdf.line(ax, ay, bx, by);
}

/** An arrow from (sx, sy) to the tip (tx, ty) with an open head. */
function arrow(pdf: jsPDF, sx: number, sy: number, tx: number, ty: number, head: number): void {
  const dx = tx - sx;
  const dy = ty - sy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  strokeSegment(pdf, sx, sy, tx, ty);
  strokeSegment(pdf, tx - ux * head + px * head * 0.78, ty - uy * head + py * head * 0.78, tx, ty);
  strokeSegment(pdf, tx - ux * head - px * head * 0.78, ty - uy * head - py * head * 0.78, tx, ty);
}

const SYMBOL_CHARS: Partial<Record<GlyphId, string>> = { delta: 'D', ge: '³', le: '£', approx: '»' };

/** A glyph of `GLYPHS` in a box `width` wide, baseline `y`. */
export function drawGlyph(pen: Pen, glyph: GlyphId, x: number, y: number, width: number, s: TextStyle): void {
  const pdf = pen.pdf;
  const sym = SYMBOL_CHARS[glyph];
  if (sym) {
    pdf.setFont('symbol', 'normal');
    pdf.setFontSize(s.size);
    pdf.setTextColor(s.color[0], s.color[1], s.color[2]);
    pdf.text(sym, x, y);
    pen.reset();
    return;
  }
  const em = s.size;
  const bold = s.style === 'bold' || s.style === 'bolditalic';
  pdf.setDrawColor(s.color[0], s.color[1], s.color[2]);
  pdf.setLineWidth(em * (bold ? 0.095 : 0.072));
  pdf.setLineCap('round');
  pdf.setLineJoin('round');
  const cy = y - em * 0.34;
  const pad = em * 0.1;
  const head = em * 0.24;
  const half = Math.min(width / 2 - pad, em * 0.3);
  const cx = x + width / 2;
  switch (glyph) {
    case 'arrow-left':
      arrow(pdf, x + width - pad, cy, x + pad, cy, head);
      break;
    case 'arrow-right':
      arrow(pdf, x + pad, cy, x + width - pad, cy, head);
      break;
    case 'arrow-up':
      arrow(pdf, cx, cy + em * 0.36, cx, cy - em * 0.36, head);
      break;
    case 'arrow-down':
      arrow(pdf, cx, cy - em * 0.36, cx, cy + em * 0.36, head);
      break;
    case 'arrow-up-left':
      arrow(pdf, cx + half, cy + half, cx - half, cy - half, head);
      break;
    case 'arrow-up-right':
      arrow(pdf, cx - half, cy + half, cx + half, cy - half, head);
      break;
    case 'arrow-down-left':
      arrow(pdf, cx + half, cy - half, cx - half, cy + half, head);
      break;
    case 'arrow-down-right':
      arrow(pdf, cx - half, cy - half, cx + half, cy + half, head);
      break;
    case 'check':
      pdf.lines(
        [
          [em * 0.18, em * 0.2],
          [em * 0.34, -em * 0.5],
        ],
        x + pad,
        cy,
        [1, 1],
        'S',
        false,
      );
      break;
    default:
      break;
  }
  pdf.setLineCap('butt');
  pdf.setLineJoin('miter');
}

/** A closed polygon through absolute points. */
function polygon(pdf: jsPDF, pts: readonly (readonly [number, number])[], style: 'F' | 'S'): void {
  const deltas: number[][] = [];
  for (let i = 1; i < pts.length; i++) deltas.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
  pdf.lines(deltas, pts[0][0], pts[0][1], [1, 1], style, true);
}

/**
 * A chart symbol centered at (cx, cy) in a cell of `size` (the cell's shorter side), in the current fill and draw
 * colors (the caller sets both to the ink). Strokes are `size × 0.1` wide.
 */
export function drawSymbol(pdf: jsPDF, symbol: ChartSymbol, cx: number, cy: number, size: number, pen?: Pen, ink?: Rgb): void {
  if (symbol.kind === 'text') {
    if (!pen || !ink) return;
    const fs = size * (symbol.text.length > 1 ? 0.5 : 0.66);
    pen.text(symbol.text, cx, cy + fs * 0.36, { font: 'helvetica', style: 'bold', size: fs, color: ink }, { align: 'center' });
    return;
  }
  const s = size * 0.64;
  const sw = Math.max(0.45, size * 0.1);
  pdf.setLineWidth(sw);
  drawShape(pdf, symbol.shape, cx, cy, s);
}

function drawShape(pdf: jsPDF, shape: ShapeId, cx: number, cy: number, s: number): void {
  const h = s / 2;
  switch (shape) {
    case 'blank':
      return;
    case 'dot':
      pdf.circle(cx, cy, s * 0.27, 'F');
      return;
    case 'circle':
      pdf.circle(cx, cy, s * 0.38, 'S');
      return;
    case 'circle-dot':
      pdf.circle(cx, cy, s * 0.4, 'S');
      pdf.circle(cx, cy, s * 0.11, 'F');
      return;
    case 'square':
      pdf.rect(cx - s * 0.32, cy - s * 0.32, s * 0.64, s * 0.64, 'F');
      return;
    case 'square-open':
      pdf.rect(cx - s * 0.36, cy - s * 0.36, s * 0.72, s * 0.72, 'S');
      return;
    case 'square-dot':
      pdf.rect(cx - s * 0.38, cy - s * 0.38, s * 0.76, s * 0.76, 'S');
      pdf.circle(cx, cy, s * 0.11, 'F');
      return;
    case 'half-square':
      polygon(pdf, [[cx - s * 0.38, cy - s * 0.38], [cx + s * 0.38, cy + s * 0.38], [cx - s * 0.38, cy + s * 0.38]], 'F');
      return;
    case 'triangle':
      polygon(pdf, [[cx, cy - h * 0.9], [cx + h * 0.88, cy + h * 0.62], [cx - h * 0.88, cy + h * 0.62]], 'F');
      return;
    case 'triangle-open':
      polygon(pdf, [[cx, cy - h * 0.88], [cx + h * 0.86, cy + h * 0.62], [cx - h * 0.86, cy + h * 0.62]], 'S');
      return;
    case 'triangle-down':
      polygon(pdf, [[cx, cy + h * 0.9], [cx + h * 0.88, cy - h * 0.62], [cx - h * 0.88, cy - h * 0.62]], 'F');
      return;
    case 'diamond':
      polygon(pdf, [[cx, cy - h], [cx + h * 0.78, cy], [cx, cy + h], [cx - h * 0.78, cy]], 'F');
      return;
    case 'diamond-open':
      polygon(pdf, [[cx, cy - h], [cx + h * 0.8, cy], [cx, cy + h], [cx - h * 0.8, cy]], 'S');
      return;
    case 'cross':
      pdf.line(cx - h * 0.72, cy - h * 0.72, cx + h * 0.72, cy + h * 0.72);
      pdf.line(cx - h * 0.72, cy + h * 0.72, cx + h * 0.72, cy - h * 0.72);
      return;
    case 'plus':
      pdf.line(cx - h * 0.85, cy, cx + h * 0.85, cy);
      pdf.line(cx, cy - h * 0.85, cx, cy + h * 0.85);
      return;
    case 'slash':
      pdf.line(cx - h * 0.7, cy + h * 0.85, cx + h * 0.7, cy - h * 0.85);
      return;
    case 'backslash':
      pdf.line(cx - h * 0.7, cy - h * 0.85, cx + h * 0.7, cy + h * 0.85);
      return;
    case 'bar-v':
      pdf.rect(cx - s * 0.1, cy - h * 0.9, s * 0.2, s * 0.9, 'F');
      return;
    case 'bar-h':
      pdf.rect(cx - h * 0.9, cy - s * 0.1, s * 0.9, s * 0.2, 'F');
      return;
    case 'star': {
      const pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? h * 1.02 : h * 0.42;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        pts.push([cx + r * Math.cos(a), cy + h * 0.08 + r * Math.sin(a)]);
      }
      polygon(pdf, pts, 'F');
      return;
    }
    case 'heart':
      pdf.circle(cx - h * 0.4, cy - h * 0.22, h * 0.44, 'F');
      pdf.circle(cx + h * 0.4, cy - h * 0.22, h * 0.44, 'F');
      polygon(pdf, [[cx - h * 0.82, cy - h * 0.08], [cx + h * 0.82, cy - h * 0.08], [cx, cy + h * 0.86]], 'F');
      return;
  }
}

/** An empty checkbox whose top-left is (x, y). */
export function checkbox(pdf: jsPDF, x: number, y: number, size: number): void {
  pdf.setDrawColor(INK[0], INK[1], INK[2]);
  pdf.setLineWidth(0.7);
  pdf.roundedRect(x, y, size, size, 1.2, 1.2, 'S');
}

/** Fill and draw colors at once. */
export function colors(pdf: jsPDF, fill: Rgb | null, draw: Rgb | null): void {
  if (fill) pdf.setFillColor(fill[0], fill[1], fill[2]);
  if (draw) pdf.setDrawColor(draw[0], draw[1], draw[2]);
}
