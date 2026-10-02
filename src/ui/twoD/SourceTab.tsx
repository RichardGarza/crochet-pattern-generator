// Track T2 — the Source tab of a 2D project (DESIGN.md §1.3 F1 steps 1–3): picture intake (drop, choose or paste a
// JPG, PNG, WebP, GIF or iPhone HEIC — converted by the dev/preview server, §2.3.1; the EXIF orientation applied),
// crop (free, square or locked to the finished shape), rotate, flip, the background (keep, or "plain background →
// one yarn" with the brush of §2.3.2), the chart settings sidebar, and a live preview of the chart.
//
// The crop is dragged in the turned picture and stored in source pixels (`cropGeometry.ts`); a drag, a key press
// series and a brush stroke are one undo step each.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { navigate } from '../../app/router';
import { notify } from '../../app/toasts';
import { projectStore, useProjectStore } from '../../state/projectStore';
import {
  addSourcePicture,
  changeSettings,
  loadBackgroundBrush,
  setBackgroundBrush,
  setCrop,
  settingsRecipe,
  sourceOf,
  twoDOf,
  twoDUi,
  useTwoDUi,
  type BrushMode,
} from '../../state/slices/twoD';
import type { ChartSettings, CropRect } from '../../types';
import { decodeBlob, isImageDecodeError } from '../../workers/decode';
import { Badge, Banner, Button, ConfirmDialog, DropZone, Panel, SegmentedControl, Select, Sidebar, Slider, Spinner, Stack, TabLayout, Toolbar, ToolbarDivider } from '../common';
import { StatusItems, useShortcutGroup } from '../shell';
import { brushCounts, brushFits, emptyBrush, paintStroke, toBrush, type BrushMask, type BrushValue } from './brush';
import { ChartThumb } from './ChartThumb';
import { editCount, refOf } from './chartTools';
import {
  aspectOf,
  cropFromDisplay,
  cropRectOf,
  displaySize,
  dragRect,
  fitAspect,
  fitScale,
  flipCrop,
  fullCrop,
  isFullCrop,
  orientationOf,
  rotateCrop,
  sourceLayerStyle,
  toDisplayRect,
  toSourcePoint,
  type Handle,
  type Orientation,
  type Rect,
  type Size,
} from './cropGeometry';
import { useAssetUrl, useElementSize } from './hooks';
import { TwoDIcon, ToolButton } from './icons';
import { PictureView } from './PictureView';
import { finishedAspect, countsText, chartGaugeSpec } from './settingsModel';
import { SettingsSidebar } from './SettingsSidebar';
import { SizeChangeDialog } from './SizeChangeDialog';
import { useChartJob, useChartView } from './useChart';
import { resolveGaugeChecked } from '../../core/gauge';
import './twoD.css';

export const PICTURE_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.gif,.heic,.heif';

/** Reads a picture file (HEIC through the server) and makes it the project's source. */
function usePictureIntake(): { busy: boolean; error: string | null; take(file: File): Promise<void>; clearError(): void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const take = useCallback(async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const decoded = await decodeBlob(file);
      const blob = decoded.source;
      const stored = blob instanceof File || blob.type ? blob : new Blob([blob], { type: file.type || 'image/jpeg' });
      const added = await addSourcePicture(stored, { name: file.name, w: decoded.image.w, h: decoded.image.h });
      if (added && decoded.convertedFromHeic) notify.info('Converted from HEIC: the picture is kept as a JPEG.');
      if (!added) setError('This project is read-only here, so the picture was not added.');
    } catch (e) {
      setError(isImageDecodeError(e) ? (e as Error).message : `This picture could not be read${e instanceof Error && e.message ? `: ${e.message}` : '.'}`);
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, take, clearError: () => setError(null) };
}

export function SourceTab() {
  useChartJob();
  const hasPicture = useProjectStore((s) => !!sourceOf(s.doc));
  const intake = usePictureIntake();
  if (!hasPicture) return <SourceEmpty intake={intake} />;
  return <SourceEditor intake={intake} />;
}

function SourceEmpty({ intake }: { intake: ReturnType<typeof usePictureIntake> }) {
  return (
    <TabLayout mainLabel="Add a picture" mainBackdrop="canvas" mainPadding="lg">
      <div className="twod-intake">
        <div className="twod-intake__card">
          <h2 className="twod-intake__title">Start with a picture</h2>
          <p className="twod-intake__lead">Logos, drawings, pixel art and photos all work. You will crop it, choose a yarn and a size, and get a chart with every row written out.</p>
          <DropZone
            size="lg"
            icon="image"
            accept={PICTURE_ACCEPT}
            title={intake.busy ? 'Reading your picture…' : 'Drop a picture here, or paste one'}
            hint="JPG, PNG, WebP, GIF or iPhone HEIC"
            buttonLabel="Choose a picture"
            disabled={intake.busy}
            onFiles={(files) => void intake.take(files[0])}
            onReject={(files) => notify.warn(`${files[0]?.name ?? 'That file'} is not a picture this app can read (JPG, PNG, WebP, GIF or HEIC).`)}
          >
            {intake.busy ? <Spinner label="Reading the picture" /> : null}
          </DropZone>
          {intake.error ? (
            <Banner tone="danger" title="That picture did not work" onDismiss={intake.clearError} dismissLabel="Dismiss">
              {intake.error}
            </Banner>
          ) : null}
          <ol className="twod-intake__steps" aria-label="What happens next">
            <li>
              <TwoDIcon name="crop" /> Crop, turn or flip it
            </li>
            <li>
              <TwoDIcon name="background-brush" /> Keep the background, or work it in one yarn
            </li>
            <li>
              <TwoDIcon name="grid-lines" /> Pick a technique, yarn and finished size
            </li>
          </ol>
        </div>
      </div>
    </TabLayout>
  );
}

type StageMode = 'crop' | 'brush';

function SourceEditor({ intake }: { intake: ReturnType<typeof usePictureIntake> }) {
  const doc = useProjectStore((s) => s.doc);
  const readOnly = useProjectStore((s) => s.readOnly);
  const twoD = twoDOf(doc)!;
  const src = sourceOf(doc)!;
  const settings = twoD.settings;
  const crop = twoD.crop;
  const url = useAssetUrl(src.asset);
  const [mode, setMode] = useState<StageMode>('crop');
  const cropLock = useTwoDUi((s) => s.cropLock);
  const brushing = settings.background === 'remove' && mode === 'brush';
  const gauge = resolveGaugeChecked(chartGaugeSpec(doc!, settings.technique)).gauge;
  const finished = finishedAspect(settings, gauge);
  // The finished-shape lock is only meaningful while both sizes are fixed.
  const lock = cropLock === 'finished' && finished === null ? 'free' : cropLock;
  const lockAspect = lock === 'square' ? 1 : lock === 'finished' ? finished : null;
  const orientation = orientationOf(crop);
  const [replaceFile, setReplaceFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const edits = editCount(twoD.edits);


  const applyLock = (lock: 'free' | 'square' | 'finished') => {
    twoDUi.setState({ cropLock: lock });
    const aspect = lock === 'square' ? 1 : lock === 'finished' ? finished : null;
    if (!aspect) return;
    const disp = displaySize(src, orientation.rotate);
    const shown = toDisplayRect(src, orientation, cropRectOf(src, crop));
    if (Math.abs(aspectOf(shown) / aspect - 1) < 0.005) return;
    setCrop(cropFromDisplay(src, orientation, fitAspect(shown, aspect, disp)), { label: 'Crop to shape' });
  };
  const turn = (dir: 1 | -1) => setCrop(rotateCrop(src, crop, dir), { label: dir > 0 ? 'Rotate right' : 'Rotate left' });
  const flip = () => setCrop(flipCrop(src, crop), { label: 'Flip' });
  const resetCrop = () => setCrop(orientation.rotate || orientation.flipX ? { ...fullCrop(src), ...orientation } : undefined, { label: 'Reset crop' });

  useShortcutGroup({
    id: 'twod-source',
    title: 'Source picture',
    rows: [
      { keys: [['←', '→', '↑', '↓']], what: 'Move the crop (with the crop focused; ⇧ moves 10×)' },
      { keys: [['⌥', '←', '→', '↑', '↓']], what: 'Resize the crop from its right and bottom edges' },
      { keys: [['[']], what: 'Rotate left' },
      { keys: [[']']], what: 'Rotate right' },
      { keys: [['B']], what: 'Background brush (when the background is worked in one yarn)' },
      { keys: [['C']], what: 'Crop' },
    ],
  });
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('dialog[open]')) return;
      if (e.key === '[') turn(-1);
      else if (e.key === ']') turn(1);
      else if ((e.key === 'b' || e.key === 'B') && settings.background === 'remove') setMode('brush');
      else if (e.key === 'c' || e.key === 'C') setMode('crop');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const takeReplacement = (f: File) => {
    if (edits > 0) setReplaceFile(f);
    else void intake.take(f);
  };

  const toolbar = (
    <Toolbar label="Picture tools">
      <SegmentedControl<StageMode>
        ariaLabel="What dragging on the picture does"
        value={brushing ? 'brush' : 'crop'}
        onChange={(m) => setMode(m)}
        size="sm"
        options={[
          { value: 'crop', label: 'Crop', icon: undefined },
          { value: 'brush', label: 'Brush background', disabled: settings.background !== 'remove' },
        ]}
      />
      <ToolbarDivider />
      <SegmentedControl<'free' | 'square' | 'finished'>
        ariaLabel="Crop shape"
        value={lock}
        onChange={applyLock}
        size="sm"
        options={[
          { value: 'free', label: 'Free' },
          { value: 'square', label: 'Square' },
          { value: 'finished', label: 'Finished size', disabled: finished === null, tooltip: finished === null ? 'Turn off "Keep the picture’s proportions" and set a width and a height first' : undefined },
        ]}
      />
      <ToolbarDivider />
      <ToolButton icon="rotate-left" label="Rotate left" shortcut="[" onClick={() => turn(-1)} disabled={readOnly} />
      <ToolButton icon="rotate-right" label="Rotate right" shortcut="]" onClick={() => turn(1)} disabled={readOnly} />
      <ToolButton icon="flip" label="Flip left to right" onClick={flip} pressed={orientation.flipX} disabled={readOnly} />
      <ToolbarDivider />
      <Button size="sm" variant="ghost" icon="refresh" onClick={resetCrop} disabledReason={isFullCrop(src, crop) && !orientation.rotate && !orientation.flipX ? 'Nothing to reset' : undefined}>
        Reset
      </Button>
    </Toolbar>
  );

  return (
    <>
      <TabLayout
        className="twod-layout"
        sidebar={<SettingsSidebar />}
        sidebarLabel="Chart settings"
        toolbar={toolbar}
        inspector={
          <SourceInspector
            onReplace={() => fileInput.current?.click()}
            busy={intake.busy}
            mode={brushing ? 'brush' : 'crop'}
            onBrush={() => setMode('brush')}
          />
        }
        inspectorLabel="Picture and background"
        mainLabel="Picture"
        mainPadding="none"
        mainBackdrop="canvas"
      >
        {intake.error ? (
          <div className="twod-stage-banner">
            <Banner tone="danger" title="That picture did not work" onDismiss={intake.clearError} dismissLabel="Dismiss">
              {intake.error}
            </Banner>
          </div>
        ) : null}
        <PictureStage url={url} src={src} crop={crop} lockAspect={lockAspect} brushing={brushing} readOnly={readOnly} />
        <input
          ref={fileInput}
          type="file"
          accept={PICTURE_ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) takeReplacement(f);
          }}
        />
        <SourceStatus />
      </TabLayout>
      <SizeChangeDialog />
      <ConfirmDialog
        open={replaceFile !== null}
        title="Replace the picture?"
        confirmLabel="Replace picture"
        tone="primary"
        onCancel={() => setReplaceFile(null)}
        onConfirm={() => {
          const f = replaceFile;
          setReplaceFile(null);
          if (f) void intake.take(f);
        }}
      >
        <p className="twod-dialog-text">
          Your settings stay. The crop, the background brush and {edits} hand {edits === 1 ? 'edit' : 'edits'} on the chart are cleared — Undo brings them back.
        </p>
      </ConfirmDialog>
    </>
  );
}

function SourceStatus() {
  const chart = useChartView();
  const r = chart.result;
  if (!r) return null;
  return (
    <StatusItems>
      <span>
        Chart {r.size.cols} × {r.size.rows}
      </span>
      <span>{r.grid.palette.length} colors</span>
    </StatusItems>
  );
}

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const BRUSH_VALUE: Record<BrushMode, BrushValue> = { background: 1, subject: 2, erase: 0 };

interface PictureStageProps {
  url: string | null;
  src: Size & { asset?: unknown };
  crop: CropRect | undefined;
  lockAspect: number | null;
  brushing: boolean;
  readOnly: boolean;
}

/** The picture, turned and mirrored, with the crop box (drag, keys) or the background brush. */
function PictureStage({ url, src, crop, lockAspect, brushing, readOnly }: PictureStageProps) {
  const [room, setRoom] = useState<HTMLDivElement | null>(null);
  const size = useElementSize(room);
  const orientation = orientationOf(crop);
  const disp = displaySize(src, orientation.rotate);
  const scale = fitScale(disp, { w: size.w - 48, h: size.h - 48 }, 8);
  const shown = toDisplayRect(src, orientation, cropRectOf(src, crop));
  const [draft, setDraft] = useState<Rect | null>(null);
  const rect = draft ?? shown;
  const drag = useRef<{ handle: Handle; x: number; y: number; start: Rect; id: number } | null>(null);

  const commit = (r: Rect, label = 'Crop') => setCrop(cropFromDisplay(src, orientation, r), { label });

  const onHandleDown = (handle: Handle) => (e: ReactPointerEvent<HTMLElement>) => {
    if (readOnly || brushing || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { handle, x: e.clientX, y: e.clientY, start: rect, id: e.pointerId };
  };
  const onMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || scale <= 0) return;
    setDraft(dragRect(d.start, d.handle, (e.clientX - d.x) / scale, (e.clientY - d.y) / scale, disp, { aspect: lockAspect, min: Math.max(4, Math.min(disp.w, disp.h) * 0.02) }));
  };
  const onUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (draft) commit(draft);
    setDraft(null);
  };

  const onCropKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (readOnly) return;
    const step = Math.max(1, Math.round(Math.max(disp.w, disp.h) * (e.shiftKey ? 0.05 : 0.01)));
    const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = dirs[e.key];
    if (!d) return;
    e.preventDefault();
    const next = e.altKey ? dragRect(shown, 'se', d[0] * step, d[1] * step, disp, { aspect: lockAspect, min: 4 }) : dragRect(shown, 'move', d[0] * step, d[1] * step, disp);
    setCrop(cropFromDisplay(src, orientation, next), { label: e.altKey ? 'Resize crop' : 'Move crop', coalesceKey: 'crop-keys' });
  };

  return (
    <div className="twod-stage" ref={setRoom} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      {scale > 0 ? (
        <PictureView url={url} src={src} orientation={orientation} scale={scale} alt="Your picture, turned and cropped as the chart will use it" className="twod-stage__picture">
          <BrushLayer src={src} orientation={orientation} scale={scale} active={brushing} />
          <BackgroundPreview cropRect={rect} scale={scale} />
          <div
            className={brushing ? 'twod-crop twod-crop--passive' : 'twod-crop'}
            style={{ left: rect.x * scale, top: rect.y * scale, width: rect.w * scale, height: rect.h * scale }}
            tabIndex={brushing ? -1 : 0}
            role="group"
            aria-roledescription="crop box"
            aria-label={`Crop: ${Math.round(rect.w)} × ${Math.round(rect.h)} pixels of the picture. Arrow keys move it; Option or Alt with the arrows resizes it.`}
            onKeyDown={onCropKey}
            onBlur={() => projectStore.getState().endCoalescing()}
            onPointerDown={onHandleDown('move')}
          >
            <span className="twod-crop__thirds" aria-hidden />
            {!brushing
              ? HANDLES.map((h) => <span key={h} className={`twod-crop__handle twod-crop__handle--${h}`} data-handle={h} aria-hidden onPointerDown={onHandleDown(h)} />)
              : null}
          </div>
        </PictureView>
      ) : null}
    </div>
  );
}

/** The chart's background stitches over the crop (§2.3.2 "show the mask"), when the background is worked in one yarn. */
function BackgroundPreview({ cropRect, scale }: { cropRect: Rect; scale: number }) {
  const chart = useChartView();
  const remove = useProjectStore((s) => twoDOf(s.doc)?.settings.background === 'remove');
  const ref = useRef<HTMLCanvasElement>(null);
  const grid = chart.result?.grid;
  const bg = grid ? grid.palette.findIndex((p) => p.role === 'background') : -1;
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext?.('2d') ?? null;
    if (!canvas || !ctx || !grid || bg < 0) return;
    canvas.width = grid.cols;
    canvas.height = grid.rows;
    const img = ctx.createImageData(grid.cols, grid.rows);
    for (let i = 0; i < grid.cols * grid.rows; i++) {
      if (grid.labels[i] !== bg) continue;
      const x = i % grid.cols;
      const y = Math.floor(i / grid.cols);
      const stripe = (x + y) % 2 === 0;
      img.data.set(stripe ? [190, 30, 90, 150] : [190, 30, 90, 90], 4 * i);
    }
    ctx.putImageData(img, 0, 0);
  }, [grid, bg]);
  if (!remove || !grid || bg < 0) return null;
  return (
    <canvas
      ref={ref}
      className="twod-bgpreview"
      aria-hidden
      style={{ left: cropRect.x * scale, top: cropRect.y * scale, width: cropRect.w * scale, height: cropRect.h * scale, opacity: chart.fresh ? 1 : 0.5 }}
    />
  );
}

/** The background brush: drawn on the uncropped source's brush grid, in the picture's own orientation. */
function BrushLayer({ src, orientation, scale, active }: { src: Size; orientation: Orientation; scale: number; active: boolean }) {
  const doc = useProjectStore((s) => s.doc);
  const ref = twoDOf(doc)?.backgroundEdits;
  const remove = twoDOf(doc)?.settings.background === 'remove';
  const brushMode = useTwoDUi((s) => s.brushMode);
  const brushSize = useTwoDUi((s) => s.brushSize);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mask, setMask] = useState<BrushMask | null>(null);
  const stroke = useRef<{ last: [number, number]; id: number; changed: number; work: BrushMask } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  // Load the stored brush (or start an empty one) whenever the stored asset changes.
  const key = ref?.key ?? '';
  useEffect(() => {
    let live = true;
    const d = projectStore.getState().doc;
    if (!d) return undefined;
    void loadBackgroundBrush(d).then((m) => {
      if (!live) return;
      setMask(m && brushFits(m, src) ? m : emptyBrush(src));
    });
    return () => {
      live = false;
    };
  }, [key, src]);

  const paint = useCallback((m: BrushMask) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext?.('2d') ?? null;
    if (!canvas || !ctx) return;
    canvas.width = m.w;
    canvas.height = m.h;
    const img = ctx.createImageData(m.w, m.h);
    for (let i = 0; i < m.data.length; i++) {
      const v = m.data[i];
      if (v === 1) img.data.set([190, 30, 90, 140], 4 * i);
      else if (v === 2) img.data.set([20, 150, 130, 140], 4 * i);
    }
    ctx.putImageData(img, 0, 0);
  }, []);
  useEffect(() => {
    if (mask) paint(mask);
  }, [mask, paint]);

  if (!remove || !mask) return null;
  const radius = Math.max(1, (brushSize / 100) * Math.max(mask.w, mask.h) * 0.5);
  const toCell = (e: ReactPointerEvent<HTMLElement>): [number, number] | null => {
    const el = e.currentTarget.parentElement; // the display box of the picture
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const dx = (e.clientX - box.left) / scale;
    const dy = (e.clientY - box.top) / scale;
    const [sx, sy] = toSourcePoint(src, orientation, dx, dy);
    return toBrush(src, mask, sx, sy);
  };
  const value = BRUSH_VALUE[brushMode];
  const cursorPx = radius * (src.w / mask.w) * scale * 2;
  return (
    <div className="twod-brush" style={{ pointerEvents: active ? 'auto' : 'none' }}>
      <canvas ref={canvasRef} className="twod-brush__canvas" style={sourceLayerStyle(src, orientation, scale)} aria-hidden />
      {active ? (
        <div
          className="twod-brush__input"
          aria-hidden
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            const c = toCell(e);
            if (!c) return;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            const work: BrushMask = { w: mask.w, h: mask.h, data: mask.data.slice() };
            const changed = paintStroke(work, c, c, radius, value);
            stroke.current = { last: c, id: e.pointerId, changed, work };
            paint(work);
          }}
          onPointerMove={(e) => {
            const parent = e.currentTarget.parentElement?.getBoundingClientRect();
            if (parent) setCursor({ x: e.clientX - parent.left, y: e.clientY - parent.top });
            const s = stroke.current;
            if (!s || s.id !== e.pointerId) return;
            const c = toCell(e);
            if (!c) return;
            const changed = paintStroke(s.work, s.last, c, radius, value);
            s.last = c;
            if (changed > 0) {
              s.changed += changed;
              paint(s.work);
            }
          }}
          onPointerUp={(e) => {
            const s = stroke.current;
            if (!s || s.id !== e.pointerId) return;
            stroke.current = null;
            setMask(s.work);
            if (s.changed > 0) void setBackgroundBrush(s.work);
          }}
          onPointerCancel={() => {
            const s = stroke.current;
            stroke.current = null;
            if (s) paint(mask);
          }}
          onPointerLeave={() => setCursor(null)}
        />
      ) : null}
      {active && cursor ? <span className={`twod-brush__cursor twod-brush__cursor--${brushMode}`} style={{ left: cursor.x, top: cursor.y, width: cursorPx, height: cursorPx }} aria-hidden /> : null}
    </div>
  );
}

function SourceInspector({ onReplace, busy, mode, onBrush }: { onReplace(): void; busy: boolean; mode: StageMode; onBrush(): void }) {
  const doc = useProjectStore((s) => s.doc);
  const twoD = twoDOf(doc)!;
  const src = sourceOf(doc)!;
  const settings = twoD.settings;
  const brushMode = useTwoDUi((s) => s.brushMode);
  const brushSize = useTwoDUi((s) => s.brushSize);
  const chart = useChartView();
  const [brushInfo, setBrushInfo] = useState<{ key: string; counts: { background: number; subject: number } | null } | null>(null);
  const brushKey = twoD.backgroundEdits?.key ?? '';
  useEffect(() => {
    let live = true;
    const d = projectStore.getState().doc;
    if (!d || !brushKey) return undefined;
    void loadBackgroundBrush(d).then((m) => live && setBrushInfo({ key: brushKey, counts: m ? brushCounts(m) : null }));
    return () => {
      live = false;
    };
  }, [brushKey]);
  const counts = brushKey && brushInfo?.key === brushKey ? brushInfo.counts : null;
  const palette = chart.result?.grid.palette ?? [];
  const bgEntry = palette.find((p) => p.role === 'background');
  const setBackground = (v: ChartSettings['background']) => changeSettings(v === 'remove' ? 'Plain background in one yarn' : 'Keep the background', settingsRecipe((s) => void (s.background = v)));
  const bgOptions = [{ value: '', label: 'Automatic (closest yarn)' }, ...palette.filter((p) => p.role !== 'background').map((p, i) => ({ value: String(i), label: `${p.code} · ${p.name}` }))];
  const chosen = settings.backgroundColor ? palette.filter((p) => p.role !== 'background').findIndex((p) => p.hex.toLowerCase() === settings.backgroundColor!.hex.toLowerCase()) : -1;
  return (
    <Sidebar>
      <Panel title="Picture" icon="image">
        <Stack gap={3}>
          <div className="twod-picinfo">
            <span className="twod-picinfo__name" title={src.name}>
              {src.name}
            </span>
            <span className="twod-muted">
              {src.w} × {src.h} px
            </span>
          </div>
          <Button size="sm" icon="upload" onClick={onReplace} loading={busy}>
            Replace picture…
          </Button>
        </Stack>
      </Panel>
      <Panel title="Background" icon="layers">
        <Stack gap={4}>
          <SegmentedControl<ChartSettings['background']>
            label="Background"
            value={settings.background}
            fullWidth
            onChange={setBackground}
            options={[
              { value: 'keep', label: 'Keep it' },
              { value: 'remove', label: 'One yarn' },
            ]}
          />
          <p className="twod-note">
            {settings.background === 'keep'
              ? 'Everything in the picture is charted as it is.'
              : 'A plain background becomes one yarn color. Brush to fix what the automatic outline gets wrong.'}
          </p>
          {settings.background === 'remove' ? (
            <>
              {bgEntry ? (
                <div className="twod-bgyarn">
                  <span className="twod-swatch" style={{ background: bgEntry.hex }} aria-hidden />
                  <span>
                    Background: {bgEntry.code} · {bgEntry.name}
                  </span>
                </div>
              ) : null}
              <Select<string>
                label="Background yarn"
                value={chosen >= 0 ? String(chosen) : ''}
                options={bgOptions}
                onChange={(v) => {
                  const entry = v === '' ? undefined : palette.filter((p) => p.role !== 'background')[Number(v)];
                  changeSettings(
                    'Background yarn',
                    settingsRecipe((s) => {
                      if (entry) s.backgroundColor = refOf(entry);
                      else delete s.backgroundColor;
                    }),
                  );
                }}
              />
              <SegmentedControl<BrushMode>
                label="Brush"
                value={brushMode}
                fullWidth
                size="sm"
                onChange={(m) => {
                  twoDUi.setState({ brushMode: m });
                  onBrush();
                }}
                options={[
                  { value: 'background', label: 'Background' },
                  { value: 'subject', label: 'Keep' },
                  { value: 'erase', label: 'Undo brush' },
                ]}
              />
              <Slider label="Brush size" value={brushSize} min={1} max={12} step={1} onChange={(v) => twoDUi.setState({ brushSize: v })} format={(v) => `${v}`} endLabels={['Fine', 'Broad']} />
              <ul className="twod-legend" aria-label="Brush colors">
                <li>
                  <span className="twod-legend__swatch twod-legend__swatch--bg" aria-hidden /> Background (worked in the background yarn)
                </li>
                <li>
                  <span className="twod-legend__swatch twod-legend__swatch--subject" aria-hidden /> Keep (always part of the design)
                </li>
              </ul>
              <Stack direction="row" gap={2} wrap>
                <Button size="sm" variant={mode === 'brush' ? 'primary' : 'secondary'} onClick={onBrush}>
                  {mode === 'brush' ? 'Brushing' : 'Start brushing'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void setBackgroundBrush(null)} disabledReason={twoD.backgroundEdits ? undefined : 'Nothing brushed yet'}>
                  Clear brush
                </Button>
              </Stack>
              {counts && (counts.background > 0 || counts.subject > 0) ? (
                <p className="twod-note">
                  Brushed: {counts.background > 0 ? 'background' : ''}
                  {counts.background > 0 && counts.subject > 0 ? ' and ' : ''}
                  {counts.subject > 0 ? 'keep' : ''} areas.
                </p>
              ) : null}
            </>
          ) : null}
        </Stack>
      </Panel>
      <ChartPreviewPanel />
    </Sidebar>
  );
}

function ChartPreviewPanel() {
  const chart = useChartView();
  const projectId = useProjectStore((s) => s.doc?.id);
  const technique = useProjectStore((s) => twoDOf(s.doc)?.settings.technique ?? 'sc_graphgan');
  const aspect = useProjectStore((s) => {
    const d = s.doc;
    const t = twoDOf(d);
    if (!d || !t) return 1;
    const g = resolveGaugeChecked(chartGaugeSpec(d, t.settings.technique)).gauge;
    return g ? g.cell.w / g.cell.h : 1;
  });
  const r = chart.result;
  const open = () => projectId && navigate({ screen: 'project', projectId, tab: 'chart' });
  let body;
  if (chart.engine === 'unavailable') {
    body = <p className="twod-note">Charts cannot be computed in this version of the app yet. Your picture and settings are saved.</p>;
  } else if (!r) {
    body = chart.job.status === 'error' ? <p className="twod-note twod-note--danger">{chart.job.error?.message ?? 'The chart could not be made.'}</p> : <Spinner label="Making the chart…" />;
  } else {
    body = (
      <Stack gap={3}>
        <div className={chart.fresh ? 'twod-thumbwrap' : 'twod-thumbwrap twod-thumbwrap--stale'}>
          <ChartThumb grid={r.grid} aspect={aspect} maxW={248} maxH={200} label={`Chart preview: ${countsText(technique, r.size.cols, r.size.rows)}, ${r.grid.palette.length} colors`} />
        </div>
        <p className="twod-note">
          {countsText(technique, r.size.cols, r.size.rows)} · {r.grid.palette.length} colors
          {chart.fresh ? '' : ' · updating…'}
        </p>
        <Button size="sm" variant="primary" iconEnd="arrow-right" onClick={open}>
          Open the chart
        </Button>
      </Stack>
    );
  }
  return (
    <Panel title="Chart" icon="chart" actions={r && !chart.fresh ? <Badge size="sm">Updating</Badge> : undefined}>
      {body}
    </Panel>
  );
}
