// Track T2.3 — the chart drawn on a canvas (DESIGN.md F1 steps 4–5): true-aspect cells, thin lines between
// stitches, stronger lines every 5 and 10 (counted from where Row 1 starts), row numbers on the edge where each row
// starts, stitch numbers along the bottom, the color code in every cell large enough to hold it (§5.7: colors are
// always paired with letter codes), hand-edit and lock marks, the hovered and keyboard cells.
//
// The canvas covers the visible part only (a 1000 × 1000 chart at 20 px a stitch is far beyond any canvas): a
// scroller holds a spacer of the full size and the canvas, pinned over it, redraws the visible cells on scroll.
// Without a 2D context (happy-dom) nothing is drawn and everything else works.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { ChartSettings, Hand, Technique2D } from '../../types';
import { cellAt, cellRect, chartLayout, fitCellWidth, gridWeight, labelEvery, lineOfRow, rowStartSide, stitchOfColumn, textOn, type ChartLayout } from './chartLayout';
import type { DisplayChart } from './chartTools';
import { useElementSize } from './hooks';

export interface ChartCanvasProps {
  chart: DisplayChart;
  /** Stitch width / height (the gauge cell). */
  aspect: number;
  technique: Technique2D;
  hand: Hand;
  roundLean?: ChartSettings['roundLean'];
  zoom: 'fit' | number;
  gridLines: boolean;
  cursor: number | null;
  hover: number | null;
  /** Cells of this palette label are outlined (hovering a palette row). */
  highlightLabel?: number | null;
  /** The chart is older than the settings (a newer one is being computed). */
  stale?: boolean;
  /** Reports the stitch width the view uses (the fit value when zoom is 'fit'). */
  onCellWidth?(px: number): void;
  onCellDown?(cell: number, e: ReactPointerEvent<HTMLDivElement>): void;
  onCellDrag?(cell: number): void;
  onCellUp?(): void;
  onHover?(cell: number | null): void;
  onKeyDown?(e: KeyboardEvent<HTMLDivElement>): void;
  onWheelZoom?(dir: 1 | -1): void;
  label: string;
  describedBy?: string;
}

interface Bitmap {
  canvas: HTMLCanvasElement;
  key: Uint8Array;
}

/** The chart at one pixel per stitch (scaled up without smoothing when drawn). */
function chartBitmap(chart: DisplayChart): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const { cols, rows, labels, palette } = chart.grid;
  if (!(cols > 0 && rows > 0)) return null;
  const c = document.createElement('canvas');
  c.width = cols;
  c.height = rows;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(cols, rows);
  const rgb = palette.map((p) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(p.hex);
    const v = m ? parseInt(m[1], 16) : 0x888888;
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  });
  for (let i = 0; i < cols * rows; i++) {
    const col = rgb[labels[i]] ?? [136, 136, 136];
    img.data[4 * i] = col[0];
    img.data[4 * i + 1] = col[1];
    img.data[4 * i + 2] = col[2];
    img.data[4 * i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function token(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

export function ChartCanvas(props: ChartCanvasProps) {
  const { chart, aspect, technique, hand, roundLean, zoom, gridLines, cursor, hover, highlightLabel, stale, onCellWidth, onCellDown, onCellDrag, onCellUp, onHover, onKeyDown, onWheelZoom, label, describedBy } = props;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [wrapEl, setWrapEl] = useState<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const box = useElementSize(wrapEl);
  const setWrap = useCallback((el: HTMLDivElement | null) => {
    wrapRef.current = el;
    setWrapEl(el);
  }, []);
  const { cols, rows } = chart.grid;
  const cellW = zoom === 'fit' ? fitCellWidth(cols, rows, aspect, box) : zoom;
  const layout = useMemo(() => chartLayout(cols, rows, aspect, cellW), [cols, rows, aspect, cellW]);
  const bitmap = useMemo<Bitmap | null>(() => {
    const canvas = chartBitmap(chart);
    return canvas ? { canvas, key: chart.grid.labels } : null;
  }, [chart]);
  const dragging = useRef(false);

  useEffect(() => {
    onCellWidth?.(cellW);
  }, [cellW, onCellWidth]);

  /** Where the chart's top left sits inside the scroller's content (centered when smaller than the view). */
  const offset = useCallback(
    (l: ChartLayout) => {
      const el = scrollRef.current;
      const vw = el?.clientWidth ?? 0;
      const vh = el?.clientHeight ?? 0;
      return { x: Math.max(0, (vw - l.width) / 2), y: Math.max(0, (vh - l.height) / 2) };
    },
    [],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const scroller = scrollRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !scroller || !wrap) return;
    const ctx = canvas.getContext?.('2d') ?? null;
    if (!ctx) return; // happy-dom, or a browser that refused a context
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const vw = scroller.clientWidth;
    const vh = scroller.clientHeight;
    if (canvas.width !== Math.round(vw * dpr) || canvas.height !== Math.round(vh * dpr)) {
      canvas.width = Math.round(vw * dpr);
      canvas.height = Math.round(vh * dpr);
      canvas.style.width = `${vw}px`;
      canvas.style.height = `${vh}px`;
    }
    const l = layout;
    const off = offset(l);
    const sx = scroller.scrollLeft - off.x;
    const sy = scroller.scrollTop - off.y;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    ctx.translate(-sx, -sy);
    const ink = token(wrap, '--color-text', '#222');
    const muted = token(wrap, '--color-text-muted', '#666');
    const surface = token(wrap, '--color-surface', '#fff');
    const accent = token(wrap, '--color-accent', '#c0562f');
    const focus = token(wrap, '--color-focus', '#2563eb');
    const font = token(wrap, '--font-sans', 'system-ui, sans-serif');
    const x0 = l.gutterX;
    const y0 = l.gutterY;
    const W = cols * l.cellW;
    const H = rows * l.cellH;
    // Paper under the chart and the gutters.
    ctx.fillStyle = surface;
    ctx.fillRect(0, 0, l.width, l.height);
    const bm = bitmap;
    if (bm) {
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = stale ? 0.55 : 1;
      ctx.drawImage(bm.canvas, 0, 0, cols, rows, x0, y0, W, H);
      ctx.globalAlpha = 1;
    }
    // Visible cell range.
    const c0 = Math.max(0, Math.floor((sx - x0) / l.cellW));
    const c1 = Math.min(cols - 1, Math.floor((sx + vw - x0) / l.cellW));
    const r0 = Math.max(0, Math.floor((sy - y0) / l.cellH));
    const r1 = Math.min(rows - 1, Math.floor((sy + vh - y0) / l.cellH));
    const { labels, palette } = chart.grid;
    // Codes in cells, edit and lock marks.
    const showCodes = l.cellW >= 15 && l.cellH >= 13;
    const marks = l.cellW >= 7 && l.cellH >= 6;
    if (showCodes) {
      ctx.font = `600 ${Math.max(9, Math.min(14, Math.floor(Math.min(l.cellW, l.cellH) * 0.5)))}px ${font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
    }
    for (let r = r0; r <= r1 && (showCodes || marks); r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c;
        const x = x0 + c * l.cellW;
        const y = y0 + r * l.cellH;
        const entry = palette[labels[i]];
        const fg = entry ? textOn(entry.hex) : '#000000';
        if (showCodes && entry) {
          ctx.fillStyle = fg === '#000000' ? 'rgba(0,0,0,0.62)' : 'rgba(255,255,255,0.85)';
          ctx.fillText(entry.code, x + l.cellW / 2, y + l.cellH / 2 + 0.5);
        }
        if (marks && chart.edited[i]) {
          ctx.fillStyle = fg === '#000000' ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.8)';
          const t = Math.min(6, l.cellW * 0.35);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + t, y);
          ctx.lineTo(x, y + t);
          ctx.closePath();
          ctx.fill();
        }
        if (marks && chart.locked[i]) {
          ctx.strokeStyle = fg === '#000000' ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.85)';
          ctx.lineWidth = 1.25;
          const s = Math.min(l.cellW, l.cellH) * 0.28;
          const cx = x + l.cellW - s - 1.5;
          const cy = y + l.cellH - s - 1.5;
          ctx.strokeRect(cx, cy + s * 0.4, s, s * 0.6);
          ctx.beginPath();
          ctx.arc(cx + s / 2, cy + s * 0.4, s * 0.32, Math.PI, 0);
          ctx.stroke();
        }
      }
    }
    // Grid lines: rows counted from the bottom (Row 1), stitches from where Row 1 starts.
    if (gridLines) {
      const thin = l.cellW >= 5 && l.cellH >= 4;
      const line = (x1: number, y1: number, x2: number, y2: number, w: number) => {
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      };
      for (let c = c0; c <= c1 + 1; c++) {
        const k = hand === 'left' ? c : cols - c;
        const wgt = gridWeight(k);
        if (wgt === 0 && !thin) continue;
        ctx.strokeStyle = wgt === 2 ? 'rgba(0,0,0,0.72)' : wgt === 1 ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.2)';
        const x = Math.round(x0 + c * l.cellW) + 0.5;
        line(x, y0 + r0 * l.cellH, x, y0 + (r1 + 1) * l.cellH, wgt === 2 ? 1.5 : 1);
      }
      for (let r = r0; r <= r1 + 1; r++) {
        const k = rows - r;
        const wgt = gridWeight(k);
        if (wgt === 0 && !thin) continue;
        ctx.strokeStyle = wgt === 2 ? 'rgba(0,0,0,0.72)' : wgt === 1 ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.2)';
        const y = Math.round(y0 + r * l.cellH) + 0.5;
        line(x0 + c0 * l.cellW, y, x0 + (c1 + 1) * l.cellW, y, wgt === 2 ? 1.5 : 1);
      }
    }
    // Frame.
    ctx.strokeStyle = muted;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 - 0.5, y0 - 0.5, W + 1, H + 1);
    // Row numbers on the edge where each row starts; stitch numbers along the bottom.
    ctx.fillStyle = muted;
    ctx.font = `500 11px ${font}`;
    ctx.textBaseline = 'middle';
    const everyR = labelEvery(l.cellH);
    for (let r = r0; r <= r1; r++) {
      const k = lineOfRow(rows, r);
      if (k !== 1 && k % everyR !== 0) continue;
      const side = rowStartSide({ technique, hand, roundLean }, k);
      if (!side) continue;
      const y = y0 + r * l.cellH + l.cellH / 2;
      ctx.textAlign = side === 'right' ? 'left' : 'right';
      ctx.fillText(String(k), side === 'right' ? x0 + W + 5 : x0 - 5, y);
    }
    const everyC = labelEvery(l.cellW);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let c = c0; c <= c1; c++) {
      const k = stitchOfColumn(cols, c, hand);
      if (k !== 1 && k % everyC !== 0) continue;
      ctx.fillText(String(k), x0 + c * l.cellW + l.cellW / 2, y0 + H + 4);
    }
    // Highlighted palette color, hover and keyboard cells.
    if (highlightLabel !== null && highlightLabel !== undefined && highlightLabel >= 0) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(1, Math.min(2, l.cellW / 6));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          if (labels[r * cols + c] !== highlightLabel) continue;
          ctx.strokeRect(x0 + c * l.cellW + 1, y0 + r * l.cellH + 1, l.cellW - 2, l.cellH - 2);
        }
      }
    }
    const ring = (cell: number, color: string, dashed: boolean) => {
      if (cell < 0 || cell >= cols * rows) return;
      const rc = cellRect(l, cell);
      ctx.save();
      ctx.lineWidth = 2;
      ctx.setLineDash(dashed ? [3, 2] : []);
      ctx.strokeStyle = surface;
      ctx.strokeRect(rc.x - 1.5, rc.y - 1.5, rc.w + 3, rc.h + 3);
      ctx.strokeStyle = color;
      ctx.strokeRect(rc.x - 1, rc.y - 1, rc.w + 2, rc.h + 2);
      ctx.restore();
    };
    if (hover !== null) ring(hover, accent, false);
    if (cursor !== null && document.activeElement === scroller) ring(cursor, focus, true);
  }, [layout, offset, cols, rows, chart, bitmap, gridLines, hand, technique, roundLean, highlightLabel, hover, cursor, stale]);

  const frame = useRef(0);
  const schedule = useCallback(() => {
    if (typeof requestAnimationFrame !== 'function') return draw();
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => draw());
  }, [draw]);

  useLayoutEffect(() => {
    schedule();
  }, [schedule, box.w, box.h]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  // A theme switch changes the tokens the canvas reads.
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return undefined;
    const mo = new MutationObserver(() => schedule());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    mq?.addEventListener?.('change', schedule);
    return () => {
      mo.disconnect();
      mq?.removeEventListener?.('change', schedule);
    };
  }, [schedule]);

  // Keep the keyboard cell in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (cursor === null || !el) return;
    const off = offset(layout);
    const rc = cellRect(layout, cursor);
    const left = rc.x + off.x;
    const top = rc.y + off.y;
    const pad = 24;
    if (left - pad < el.scrollLeft) el.scrollLeft = Math.max(0, left - pad);
    else if (left + rc.w + pad > el.scrollLeft + el.clientWidth) el.scrollLeft = left + rc.w + pad - el.clientWidth;
    if (top - pad < el.scrollTop) el.scrollTop = Math.max(0, top - pad);
    else if (top + rc.h + pad > el.scrollTop + el.clientHeight) el.scrollTop = top + rc.h + pad - el.clientHeight;
  }, [cursor, layout, offset]);

  // ⌘/Ctrl + wheel (and the trackpad pinch) zooms; React's wheel listener is passive, so this one is native.
  const wheelZoom = useRef(onWheelZoom);
  useEffect(() => {
    wheelZoom.current = onWheelZoom;
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !wheelZoom.current) return;
      e.preventDefault();
      wheelZoom.current(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const cellFromEvent = (e: { clientX: number; clientY: number }): number => {
    const el = scrollRef.current;
    if (!el) return -1;
    const rect = el.getBoundingClientRect();
    const off = offset(layout);
    return cellAt(layout, e.clientX - rect.left + el.scrollLeft - off.x, e.clientY - rect.top + el.scrollTop - off.y);
  };

  return (
    <div className="twod-chart" ref={setWrap}>
      <canvas className="twod-chart__canvas" ref={canvasRef} aria-hidden />
      <div
        className="twod-chart__scroller"
        ref={scrollRef}
        tabIndex={0}
        role="application"
        aria-roledescription="chart editor"
        aria-label={label}
        aria-describedby={describedBy}
        onScroll={schedule}
        onFocus={schedule}
        onBlur={schedule}
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const cell = cellFromEvent(e);
          if (cell < 0) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          onCellDown?.(cell, e);
        }}
        onPointerMove={(e) => {
          const cell = cellFromEvent(e);
          onHover?.(cell < 0 ? null : cell);
          if (dragging.current && cell >= 0) onCellDrag?.(cell);
        }}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          dragging.current = false;
          e.currentTarget.releasePointerCapture?.(e.pointerId);
          onCellUp?.();
        }}
        onPointerCancel={() => {
          if (dragging.current) {
            dragging.current = false;
            onCellUp?.();
          }
        }}
        onPointerLeave={() => onHover?.(null)}
      >
        <div className="twod-chart__spacer" style={{ width: layout.width, height: layout.height }} />
      </div>
    </div>
  );
}
