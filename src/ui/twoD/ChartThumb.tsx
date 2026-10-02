// Track T2.3 — a small picture of the chart (true-aspect cells, no lines) for the Source tab's preview.
import { useEffect, useRef } from 'react';
import type { ChartGrid } from '../../types';

export function ChartThumb({ grid, aspect, maxW, maxH, label, highlightRole }: { grid: ChartGrid; aspect: number; maxW: number; maxH: number; label: string; highlightRole?: 'background' }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const physW = grid.cols * (aspect > 0 ? aspect : 1);
  const physH = grid.rows;
  const scale = Math.min(maxW / physW, maxH / physH);
  const w = Math.max(1, Math.round(physW * scale));
  const h = Math.max(1, Math.round(physH * scale));
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext?.('2d') ?? null;
    if (!canvas || !ctx) return;
    const img = ctx.createImageData(grid.cols, grid.rows);
    const rgb = grid.palette.map((p) => {
      const v = parseInt(p.hex.slice(1), 16) || 0;
      return [(v >> 16) & 255, (v >> 8) & 255, v & 255, highlightRole && p.role !== highlightRole ? 90 : 255];
    });
    for (let i = 0; i < grid.cols * grid.rows; i++) {
      const c = rgb[grid.labels[i]] ?? [128, 128, 128, 255];
      img.data.set(c, 4 * i);
    }
    const off = document.createElement('canvas');
    off.width = grid.cols;
    off.height = grid.rows;
    off.getContext('2d')?.putImageData(img, 0, 0);
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  }, [grid, w, h, highlightRole]);
  return <canvas ref={ref} className="twod-thumb" style={{ width: w, height: h }} role="img" aria-label={label} />;
}
