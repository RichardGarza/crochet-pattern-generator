// Track T2 — the Chart tab (DESIGN.md §1.3 F1 steps 4–5): the picture and the chart side by side with true-aspect
// cells and 5/10 lines, live metrics (confetti, changes per row, bobbins, fidelity, workability), and the editor —
// paint, flood fill, replace, eyedropper, lock, erase, merge colors, recolor to a yarn — with undo.
//
// Every tool goes through `applyChartTool` / `applyPaletteOp` / `strokeRecipe` (`chartTools.ts`, pure) and
// `projectStore.update`: hand edits are `ColorRef` overrides and locks in `doc.twoD.edits` (§5.5.5); a drag is one
// undo step. The chart is recomputed by the chart2d worker after every change (`useChartJob`); until it answers,
// the edits are drawn over the last chart.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { navigate } from '../../app/router';
import { resolveGaugeChecked } from '../../core/gauge';
import { deltaE00Hex } from '../../core/kernel/color';
import { DEFAULT_REFERENCE_LINE_ID, getShippedLine, SHIPPED_LINES } from '../../core/yarn/lines';
import { derivedStore } from '../../state/derivedStore';
import { projectStore, useProjectStore } from '../../state/projectStore';
import { changeSettings, runChartJob, settingsRecipe, sourceOf, twoDOf, twoDUi, useTwoDUi, type ChartToolId } from '../../state/slices/twoD';
import type { ChartResult, ColorRef, PaletteEntry, ProjectDoc, Yarn } from '../../types';
import { Badge, Banner, Button, ConfirmDialog, Dialog, EmptyState, IconButton, Panel, ProgressBar, Sidebar, Spinner, Stack, TabLayout, Toolbar, ToolbarDivider, VisuallyHidden } from '../common';
import { StatusItems, useShortcutGroup } from '../shell';
import { ChartCanvas } from './ChartCanvas';
import { lineOfRow, stitchOfColumn, zoomStep } from './chartLayout';
import {
  applyChartTool,
  applyPaletteOp,
  cellsBetween,
  clearEditsRecipe,
  displayChart,
  editCount,
  editsAt,
  labelCounts,
  refOf,
  refOfYarn,
  sameRef,
  strokeRecipe,
  type DisplayChart,
  type PaletteOp,
} from './chartTools';
import { cropRectOf, fitScale, orientationOf, toDisplayRect } from './cropGeometry';
import { useAssetUrl, useElementSize } from './hooks';
import { ToolButton, type TwoDIconName } from './icons';
import { PictureView } from './PictureView';
import { chartGaugeSpec, countsText } from './settingsModel';
import { SettingsSidebar } from './SettingsSidebar';
import { SizeChangeDialog } from './SizeChangeDialog';
import { useChartJob, useChartView } from './useChart';
import './twoD.css';

const TOOLS: { id: ChartToolId; icon: TwoDIconName; label: string; key: string; hint: string }[] = [
  { id: 'paint', icon: 'brush', label: 'Paint', key: 'B', hint: 'Click or drag to paint stitches in the current color.' },
  { id: 'fill', icon: 'bucket', label: 'Fill', key: 'F', hint: 'Fill the connected area of one color.' },
  { id: 'replace', icon: 'swap', label: 'Replace color', key: 'R', hint: 'Every stitch of the clicked color takes the current color.' },
  { id: 'eyedropper', icon: 'eyedropper', label: 'Pick color', key: 'I', hint: 'Click a stitch to make its color the current color.' },
  { id: 'lock', icon: 'lock', label: 'Lock', key: 'L', hint: 'Locked stitches keep their color when the chart is cleaned up.' },
  { id: 'erase', icon: 'eraser', label: 'Erase edits', key: 'E', hint: 'Back to the computed color; removes paint and locks.' },
];

export function ChartTab() {
  useChartJob();
  const hasPicture = useProjectStore((s) => !!sourceOf(s.doc));
  const projectId = useProjectStore((s) => s.doc?.id);
  const chart = useChartView();
  if (!hasPicture) {
    return (
      <TabLayout mainLabel="Chart" mainBackdrop="canvas" mainPadding="lg">
        <div className="twod-center">
          <EmptyState
            icon="chart"
            title="No chart yet"
            variant="panel"
            size="lg"
            level={2}
            actions={
              <Button variant="primary" icon="image" onClick={() => projectId && navigate({ screen: 'project', projectId, tab: 'source' })}>
                Add a picture
              </Button>
            }
          >
            The chart is made from your picture. Add one on the Source tab, then come back to edit stitches.
          </EmptyState>
        </div>
      </TabLayout>
    );
  }
  if (!chart.result) {
    return (
      <>
        <TabLayout className="twod-layout" sidebar={<SettingsSidebar />} sidebarLabel="Chart settings" mainLabel="Chart" mainBackdrop="canvas" mainPadding="lg">
          <div className="twod-center">
            <ChartPending />
          </div>
        </TabLayout>
        <SizeChangeDialog />
      </>
    );
  }
  return <ChartEditor result={chart.result} fresh={chart.fresh} />;
}

function retry(): void {
  const doc = projectStore.getState().doc;
  if (!doc) return;
  derivedStore.getState().clear('chart');
  void runChartJob(doc);
}

/** What the tab shows before the first chart: computing, an error, or an engine that is not in this build. */
function ChartPending() {
  const chart = useChartView();
  if (chart.engine === 'unavailable') {
    return (
      <EmptyState icon="hourglass" title="Charts are not available in this version yet" variant="panel" size="lg" level={2}>
        Your picture and settings are saved. As soon as the chart engine is part of the app, your chart appears here — nothing to redo.
      </EmptyState>
    );
  }
  if (chart.job.status === 'error') {
    return (
      <div className="twod-pending">
        <Banner tone="danger" title="The chart could not be made" actions={<Button onClick={retry}>Try again</Button>}>
          {chart.job.error?.message ?? 'Something went wrong while charting the picture.'}
        </Banner>
      </div>
    );
  }
  return (
    <div className="twod-pending" role="status" aria-live="polite">
      <div className="twod-skeleton" aria-hidden>
        {Array.from({ length: 48 }, (_, i) => (
          <span key={i} />
        ))}
      </div>
      <p className="twod-pending__text">
        <Spinner size={16} /> Making your chart…
      </p>
      {chart.job.progress !== null ? <ProgressBar value={chart.job.progress} label="Charting" size="sm" /> : null}
    </div>
  );
}

function cellWords(doc: ProjectDoc, shown: DisplayChart, cell: number): string {
  const t = twoDOf(doc)!;
  const { cols, rows } = shown.grid;
  const r = Math.floor(cell / cols);
  const c = cell % cols;
  const entry = shown.grid.palette[shown.grid.labels[cell]];
  const what = entry ? `${entry.code} ${entry.name}` : 'no color';
  const marks = [shown.edited[cell] ? 'painted' : '', shown.locked[cell] ? 'locked' : ''].filter(Boolean).join(', ');
  let where: string;
  if (t.settings.technique === 'c2c') where = `Column ${stitchOfColumn(cols, c, t.settings.hand)}, row ${rows - r} from the bottom`;
  else {
    const line = lineOfRow(rows, r);
    const rtl = t.settings.technique === 'sc_tapestry_round' && t.settings.roundLean.mode !== 'turn' ? t.settings.hand !== 'left' : (line % 2 === 1) === (t.settings.hand !== 'left');
    const st = rtl ? cols - c : c + 1;
    where = `${t.settings.technique === 'sc_tapestry_round' ? 'Round' : 'Row'} ${line}, stitch ${st}`;
  }
  return `${where}: ${what}${marks ? ` (${marks})` : ''}`;
}

let strokeSerial = 0;

function ChartEditor({ result, fresh }: { result: ChartResult; fresh: boolean }) {
  const doc = useProjectStore((s) => s.doc)!;
  const readOnly = useProjectStore((s) => s.readOnly);
  const twoD = twoDOf(doc)!;
  const settings = twoD.settings;
  const edits = twoD.edits;
  const tool = useTwoDUi((s) => s.tool);
  const colorPick = useTwoDUi((s) => s.color);
  const zoom = useTwoDUi((s) => s.zoom);
  const showPhoto = useTwoDUi((s) => s.showPhoto);
  const gridLines = useTwoDUi((s) => s.gridLines);
  const cursor = useTwoDUi((s) => s.cursor);
  const [hover, setHover] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [colorDialog, setColorDialog] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [announce, setAnnounce] = useState('');
  const cellWRef = useRef(8);
  const helpId = useId();
  const gauge = useMemo(() => resolveGaugeChecked(chartGaugeSpec(doc, settings.technique)).gauge, [doc, settings.technique]);
  const aspect = gauge ? gauge.cell.w / gauge.cell.h : 1;
  const grid = result.grid;
  const shown = useMemo(() => displayChart(grid, edits, SHIPPED_LINES.flatMap((l) => l.yarns)), [grid, edits]);
  const counts = useMemo(() => labelCounts(shown.grid), [shown]);
  const { cols, rows } = grid;
  const palette = shown.grid.palette;
  const firstColor = palette.find((p) => p.role !== 'background') ?? palette[0];
  const color: ColorRef | null = colorPick ?? (firstColor ? refOf(firstColor) : null);
  const colorLabel = color ? palette.findIndex((p) => sameRef(refOf(p), color)) : -1;
  const colorEntry = colorLabel >= 0 ? palette[colorLabel] : null;
  const stroke = useRef<{ key: string; last: number; mode: 'paint' | 'lock' | 'unlock' | 'erase' } | null>(null);
  const nEdits = editCount(editsAt(edits, cols, rows));


  const apply = useCallback(
    (cell: number, o: { stroke?: boolean } = {}) => {
      if (readOnly) return;
      const st = projectStore.getState();
      const d = st.doc;
      const e = d?.twoD?.edits;
      let t;
      switch (tool) {
        case 'paint':
        case 'fill':
        case 'replace':
          if (!color) return;
          t = { kind: tool, color } as const;
          break;
        case 'eyedropper':
          t = { kind: 'eyedropper' } as const;
          break;
        case 'lock':
          t = { kind: 'lock', mode: 'toggle' } as const;
          break;
        case 'erase':
          t = { kind: 'erase' } as const;
          break;
      }
      const res = applyChartTool(grid, e, cell, t);
      if (!res) return;
      if (res.kind === 'pick') {
        twoDUi.setState({ color: res.color, tool: 'paint' });
        setAnnounce(`Current color: ${res.entry.code} ${res.entry.name}. Paint tool.`);
        return;
      }
      const key = o.stroke ? `chart-stroke-${++strokeSerial}` : undefined;
      st.update(res.label, res.recipe, key ? { coalesceKey: key } : undefined);
      if (o.stroke && key) {
        const mode = tool === 'lock' ? (res.label === 'Lock stitches' ? 'lock' : 'unlock') : tool === 'erase' ? 'erase' : 'paint';
        stroke.current = { key, last: cell, mode };
      }
    },
    [readOnly, tool, color, grid],
  );

  const onCellDown = (cell: number) => {
    const strokeTool = tool === 'paint' || tool === 'lock' || tool === 'erase';
    stroke.current = null;
    apply(cell, { stroke: strokeTool });
    if (strokeTool && !stroke.current) {
      // The first cell changed nothing (already that color): the drag still paints the rest.
      const key = `chart-stroke-${++strokeSerial}`;
      const e = projectStore.getState().doc?.twoD?.edits;
      const locked = editsAt(e, cols, rows).locked.includes(cell);
      stroke.current = { key, last: cell, mode: tool === 'lock' ? (locked ? 'lock' : 'unlock') : tool === 'erase' ? 'erase' : 'paint' };
    }
  };
  const onCellDrag = (cell: number) => {
    const s = stroke.current;
    if (!s || cell === s.last || readOnly) return;
    const cells = cellsBetween(cols, s.last, cell).slice(1);
    s.last = cell;
    const t = s.mode === 'paint' ? (color ? { kind: 'paint' as const, color } : null) : s.mode === 'erase' ? { kind: 'erase' as const } : { kind: 'lock' as const, lock: s.mode === 'lock' };
    if (!t) return;
    const label = s.mode === 'paint' ? 'Paint' : s.mode === 'erase' ? 'Erase hand edits' : s.mode === 'lock' ? 'Lock stitches' : 'Unlock stitches';
    projectStore.getState().update(label, strokeRecipe(cols, rows, cells, t), { coalesceKey: s.key });
  };
  const onCellUp = () => {
    stroke.current = null;
    projectStore.getState().endCoalescing();
  };

  const setZoom = (z: 'fit' | number) => twoDUi.setState({ zoom: z });
  const zoomBy = (dir: 1 | -1) => setZoom(zoomStep(zoom === 'fit' ? cellWRef.current : zoom, dir));

  const moveCursor = (dc: number, dr: number) => {
    const cur = cursor ?? Math.floor(rows / 2) * cols + Math.floor(cols / 2);
    const r = Math.min(rows - 1, Math.max(0, Math.floor(cur / cols) + dr));
    const c = Math.min(cols - 1, Math.max(0, (cur % cols) + dc));
    const next = r * cols + c;
    twoDUi.setState({ cursor: next });
    setAnnounce(cellWords(doc, shown, next));
  };

  const onChartKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const big = e.shiftKey ? 10 : 1;
    const cur = cursor ?? Math.floor(rows / 2) * cols + Math.floor(cols / 2);
    switch (e.key) {
      case 'ArrowLeft':
        moveCursor(-big, 0);
        break;
      case 'ArrowRight':
        moveCursor(big, 0);
        break;
      case 'ArrowUp':
        moveCursor(0, -big);
        break;
      case 'ArrowDown':
        moveCursor(0, big);
        break;
      case 'Home':
        moveCursor(-cols, 0);
        break;
      case 'End':
        moveCursor(cols, 0);
        break;
      case 'PageUp':
        moveCursor(0, -10);
        break;
      case 'PageDown':
        moveCursor(0, 10);
        break;
      case ' ':
      case 'Enter':
        if (cursor === null) twoDUi.setState({ cursor: cur });
        apply(cur);
        setAnnounce(cellWords(projectStore.getState().doc!, displayChart(grid, projectStore.getState().doc?.twoD?.edits), cur));
        break;
      case 'Escape':
        twoDUi.setState({ cursor: null });
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // Tool and view shortcuts while the tab is open (not while typing or in a dialog).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (document.querySelector('dialog[open]')) return;
      const k = e.key.toLowerCase();
      const t = TOOLS.find((x) => x.key.toLowerCase() === k);
      if (t) twoDUi.setState({ tool: t.id });
      else if (k === 'g') twoDUi.setState({ gridLines: !twoDUi.getState().gridLines });
      else if (k === 'p') twoDUi.setState({ showPhoto: !twoDUi.getState().showPhoto });
      else if (e.key === '+' || e.key === '=') zoomBy(1);
      else if (e.key === '-' || e.key === '_') zoomBy(-1);
      else if (e.key === '0') setZoom('fit');
      else if (/^[1-9]$/.test(e.key)) {
        const entry = palette[Number(e.key) - 1];
        if (!entry) return;
        twoDUi.setState({ color: refOf(entry) });
        setAnnounce(`Current color: ${entry.code} ${entry.name}`);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useShortcutGroup({
    id: 'twod-chart',
    title: 'Chart',
    rows: [
      ...TOOLS.map((t) => ({ keys: [[t.key]], what: t.label })),
      { keys: [['1'], ['9']], what: 'Current color: the 1st … 9th color of the palette' },
      { keys: [['←', '→', '↑', '↓']], what: 'Move the stitch cursor (chart focused; ⇧ moves 10)' },
      { keys: [['Space'], ['Enter']], what: 'Use the tool on the stitch under the cursor' },
      { keys: [['+'], ['−']], what: 'Zoom in, out' },
      { keys: [['0']], what: 'Fit the chart' },
      { keys: [['G']], what: 'Grid lines on or off' },
      { keys: [['P']], what: 'Picture beside the chart on or off' },
    ],
  });

  const doPaletteOp = (op: PaletteOp) => {
    const res = applyPaletteOp(grid, projectStore.getState().doc?.twoD?.edits, op);
    if (!res) return;
    projectStore.getState().update(res.label, res.recipe);
    setColorDialog(null);
  };

  const toolbar = (
    <Toolbar label="Chart tools" className="twod-toolbar">
      <div className="twod-toolgroup" role="radiogroup" aria-label="Tool">
        {TOOLS.map((t) => (
          <ToolButton key={t.id} icon={t.icon} label={`${t.label} — ${t.hint}`} shortcut={t.key} pressed={tool === t.id} onClick={() => twoDUi.setState({ tool: t.id })} disabled={readOnly} />
        ))}
      </div>
      <ToolbarDivider />
      <div className="twod-current" aria-live="polite">
        <span className="twod-swatch twod-swatch--lg" style={{ background: color?.hex ?? 'transparent' }} aria-hidden />
        <span className="twod-current__text">
          <span className="twod-muted">Color</span> {colorEntry ? `${colorEntry.code} · ${colorEntry.name}` : (color?.hex ?? 'none')}
        </span>
      </div>
      <span className="twod-toolbar__spacer" />
      <ToolButton icon="zoom-out" label="Zoom out" shortcut="−" onClick={() => zoomBy(-1)} />
      <span className="twod-zoom" aria-live="polite">
        {zoom === 'fit' ? 'Fit' : `${Math.round(zoom)} px`}
      </span>
      <ToolButton icon="zoom-in" label="Zoom in" shortcut="+" onClick={() => zoomBy(1)} />
      <ToolButton icon="fit" label="Fit the chart" shortcut="0" pressed={zoom === 'fit'} onClick={() => setZoom('fit')} />
      <ToolbarDivider />
      <ToolButton icon="grid-lines" label="Grid lines" shortcut="G" pressed={gridLines} onClick={() => twoDUi.setState({ gridLines: !gridLines })} />
      <ToolButton icon="split-view" label="Picture beside the chart" shortcut="P" pressed={showPhoto} onClick={() => twoDUi.setState({ showPhoto: !showPhoto })} />
    </Toolbar>
  );

  const repeats = result.repeats?.verticalBlocks ?? [];
  const askRepeats = settings.applyRepeats === 'ask' && repeats.length > 0;

  return (
    <>
      <TabLayout
        className="twod-layout"
        sidebar={<SettingsSidebar />}
        sidebarLabel="Chart settings"
        toolbar={toolbar}
        inspector={
          <ChartInspector
            shown={shown}
            counts={counts}
            result={result}
            colorLabel={colorLabel}
            onPick={(i) => {
              twoDUi.setState({ color: refOf(palette[i]) });
              if (tool === 'eyedropper') twoDUi.setState({ tool: 'paint' });
            }}
            onHighlight={setHighlight}
            onEdit={setColorDialog}
            onClear={() => setConfirmClear(true)}
            edits={nEdits}
          />
        }
        inspectorLabel="Colors and metrics"
        mainLabel="Picture and chart"
        mainPadding="none"
        mainBackdrop="canvas"
      >
        {askRepeats ? (
          <div className="twod-stage-banner">
            <Banner
              tone="info"
              title="Rows repeat in this chart"
              actions={
                <>
                  <Button size="sm" variant="primary" onClick={() => changeSettings('Write as repeats', settingsRecipe((s) => void (s.applyRepeats = 'auto')))}>
                    Write as a repeat
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => changeSettings('Write every row', settingsRecipe((s) => void (s.applyRepeats = 'off')))}>
                    Write every row
                  </Button>
                </>
              }
            >
              Rows {repeats[0].from}–{repeats[0].to} repeat rows {repeats[0].repeatOf[0]}–{repeats[0].repeatOf[1]}. The pattern can say “repeat” instead of writing them out.
            </Banner>
          </div>
        ) : null}
        <div className={showPhoto ? 'twod-split' : 'twod-split twod-split--solo'}>
          {showPhoto ? <PhotoPane doc={doc} hover={hover ?? cursor} cols={cols} rows={rows} /> : null}
          <div className="twod-chartpane">
            <ChartCanvas
              chart={shown}
              aspect={aspect}
              technique={settings.technique}
              hand={settings.hand}
              roundLean={settings.roundLean}
              zoom={zoom}
              gridLines={gridLines}
              cursor={cursor}
              hover={hover}
              highlightLabel={highlight}
              stale={!fresh}
              onCellWidth={(px) => (cellWRef.current = px)}
              onCellDown={(cell: number, e: ReactPointerEvent<HTMLDivElement>) => {
                e.currentTarget.focus({ preventScroll: true });
                twoDUi.setState({ cursor: cell });
                onCellDown(cell);
              }}
              onCellDrag={onCellDrag}
              onCellUp={onCellUp}
              onHover={setHover}
              onKeyDown={onChartKey}
              onWheelZoom={zoomBy}
              label={`Chart, ${countsText(settings.technique, cols, rows)}. Tool: ${TOOLS.find((t) => t.id === tool)?.label}.`}
              describedBy={helpId}
            />
            {!fresh ? (
              <div className="twod-updating" role="status">
                <Spinner size={14} /> Updating the chart…
              </div>
            ) : null}
            {hover !== null ? <div className="twod-hoverinfo">{cellWords(doc, shown, hover)}</div> : null}
          </div>
        </div>
        <VisuallyHidden>
          <span id={helpId}>Arrow keys move the stitch cursor; Space or Enter uses the tool. B paint, F fill, R replace, I pick a color, L lock, E erase. Press ? for every shortcut.</span>
          <span aria-live="polite">{announce}</span>
        </VisuallyHidden>
        <ChartStatus result={result} fresh={fresh} edits={nEdits} />
      </TabLayout>
      <SizeChangeDialog />
      {colorDialog !== null && palette[colorDialog] ? (
        <ColorDialog entry={palette[colorDialog]} label={colorDialog} palette={palette} onClose={() => setColorDialog(null)} onOp={doPaletteOp} referenceLineId={settings.referenceLineId} />
      ) : null}
      <ConfirmDialog
        open={confirmClear}
        title="Clear every hand edit?"
        confirmLabel="Clear edits"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false);
          projectStore.getState().update('Clear hand edits', clearEditsRecipe(cols, rows));
        }}
      >
        <p className="twod-dialog-text">
          {nEdits} painted or locked {nEdits === 1 ? 'stitch goes' : 'stitches go'} back to the computed chart. Undo brings them back.
        </p>
      </ConfirmDialog>
    </>
  );
}

/** The cropped picture, as the chart sees it, with the stitch under the pointer outlined. */
function PhotoPane({ doc, hover, cols, rows }: { doc: ProjectDoc; hover: number | null; cols: number; rows: number }) {
  const src = sourceOf(doc)!;
  const crop = twoDOf(doc)?.crop;
  const url = useAssetUrl(src.asset);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const size = useElementSize(box);
  const o = orientationOf(crop);
  const view = toDisplayRect(src, o, cropRectOf(src, crop));
  const scale = fitScale(view, { w: size.w - 32, h: size.h - 32 }, 16);
  let mark = null;
  if (hover !== null && scale > 0) {
    const r = Math.floor(hover / cols);
    const c = hover % cols;
    const cw = (view.w * scale) / cols;
    const ch = (view.h * scale) / rows;
    mark = <span className="twod-photo__mark" style={{ left: c * cw, top: r * ch, width: Math.max(3, cw), height: Math.max(3, ch) }} aria-hidden />;
  }
  return (
    <div className="twod-photo" ref={setBox}>
      {scale > 0 ? (
        <PictureView url={url} src={src} orientation={o} view={view} scale={scale} alt="Your picture, cropped as the chart uses it">
          {mark}
        </PictureView>
      ) : null}
    </div>
  );
}

function ChartStatus({ result, fresh, edits }: { result: ChartResult; fresh: boolean; edits: number }) {
  const errors = result.issues.filter((i) => i.severity === 'error').length;
  const warns = result.issues.filter((i) => i.severity === 'warn').length;
  return (
    <StatusItems>
      {errors > 0 ? (
        <Badge tone="danger" size="sm">
          {errors} {errors === 1 ? 'problem' : 'problems'}
        </Badge>
      ) : warns > 0 ? (
        <Badge tone="warn" size="sm">
          {warns} {warns === 1 ? 'note' : 'notes'}
        </Badge>
      ) : (
        <Badge tone="success" size="sm">
          Chart OK
        </Badge>
      )}
      <span>
        {result.size.cols} × {result.size.rows}
      </span>
      <span>Workability {Math.round(result.metrics.workability)}</span>
      {edits > 0 ? <span>{edits} hand edits</span> : null}
      {!fresh ? <span>Updating…</span> : null}
    </StatusItems>
  );
}

function workabilityWord(w: number): string {
  if (w >= 80) return 'Relaxed to work';
  if (w >= 55) return 'Some attention needed';
  return 'Busy: many changes';
}

function pct(x: number): string {
  const v = x <= 1 ? x * 100 : x;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
}

function ChartInspector({
  shown,
  counts,
  result,
  colorLabel,
  onPick,
  onHighlight,
  onEdit,
  onClear,
  edits,
}: {
  shown: DisplayChart;
  counts: number[];
  result: ChartResult;
  colorLabel: number;
  onPick(i: number): void;
  onHighlight(i: number | null): void;
  onEdit(i: number): void;
  onClear(): void;
  edits: number;
}) {
  const technique = useProjectStore((s) => twoDOf(s.doc)?.settings.technique ?? 'sc_graphgan');
  const m = result.metrics;
  const tapestry = technique === 'sc_tapestry' || technique === 'sc_tapestry_round';
  const bobbins = m.strandsPerColor.reduce((a, b) => a + b, 0);
  const notes = result.issues.filter((i) => i.severity !== 'info' || i.code.startsWith('I_'));
  return (
    <Sidebar>
      <Panel title={`Colors (${shown.grid.palette.length})`} icon="palette">
        <ul className="twod-palette" aria-label="Chart colors">
          {shown.grid.palette.map((p, i) => (
            <li key={`${p.code}-${i}`} className={i === colorLabel ? 'twod-palette__row twod-palette__row--on' : 'twod-palette__row'} onMouseEnter={() => onHighlight(i)} onMouseLeave={() => onHighlight(null)}>
              <button type="button" className="twod-palette__pick" aria-pressed={i === colorLabel} onClick={() => onPick(i)} onFocus={() => onHighlight(i)} onBlur={() => onHighlight(null)} title={i < 9 ? `Make ${p.code} the current color (${i + 1})` : `Make ${p.code} the current color`}>
                <span className="twod-swatch twod-swatch--lg" style={{ background: p.hex }} aria-hidden />
                <span className="twod-palette__code">{p.code}</span>
                <span className="twod-palette__name">
                  <span className="twod-palette__title">{p.name}</span>
                  <span className="twod-palette__meta">
                    {counts[i] ?? 0} sts
                    {p.deltaE00 !== undefined ? <> · ΔE {p.deltaE00.toFixed(1)}</> : null}
                    {p.role === 'background' ? ' · background' : p.role === 'override' ? ' · your color' : ''}
                    {p.deltaE00 !== undefined && p.deltaE00 > 10 ? ' · no close yarn' : ''}
                  </span>
                </span>
              </button>
              <IconButton icon="more" size="sm" label={`Change ${p.code} (${p.name})…`} onClick={() => onEdit(i)} />
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Workability" icon="sparkles">
        <div className="twod-score">
          <span className="twod-score__value">{Math.round(m.workability)}</span>
          <span className="twod-score__of">/ 100</span>
          <span className="twod-score__word">{workabilityWord(m.workability)}</span>
        </div>
        <div className="twod-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(m.workability)} aria-label="Workability">
          <span style={{ width: `${Math.max(0, Math.min(100, m.workability))}%` }} />
        </div>
        <dl className="twod-metrics">
          <div>
            <dt>Single stitches (confetti)</dt>
            <dd>
              {pct(m.confettiPct)} <span className="twod-muted">target under {tapestry ? '1%' : '2%'}</span>
            </dd>
          </div>
          <div>
            <dt>Color changes per row</dt>
            <dd>
              {m.changesPerRowMean.toFixed(1)} on average, {m.changesPerRowMax} at most
            </dd>
          </div>
          {m.busiestRows.length > 0 ? (
            <div>
              <dt>Busiest rows</dt>
              <dd>{m.busiestRows.slice(0, 5).join(', ')}</dd>
            </div>
          ) : null}
          <div>
            <dt>{technique === 'c2c' ? 'Bobbins (color areas)' : tapestry ? 'Strands' : 'Bobbins'}</dt>
            <dd>
              {bobbins} · about {m.ends} ends to weave in
            </dd>
          </div>
          {tapestry ? (
            <div>
              <dt>Colors carried in a row</dt>
              <dd>up to {m.carriedPerRowMax}</dd>
            </div>
          ) : null}
          <div>
            <dt>Match to the picture</dt>
            <dd>
              ΔE {m.fidelityDE00.toFixed(1)} <span className="twod-muted">lower is closer</span>
            </dd>
          </div>
        </dl>
      </Panel>
      <Panel title="Hand edits" icon="pencil">
        <Stack gap={3}>
          <p className="twod-note">
            {edits === 0 ? 'None yet. Painted and locked stitches keep their color when you change the settings.' : `${edits} ${edits === 1 ? 'stitch' : 'stitches'} painted or locked. They keep their color when you change the settings.`}
          </p>
          <Button size="sm" variant="ghost" icon="trash" onClick={onClear} disabledReason={edits === 0 ? 'No hand edits yet' : undefined}>
            Clear hand edits…
          </Button>
        </Stack>
      </Panel>
      {notes.length > 0 ? (
        <Panel title="Notes" icon="info">
          <ul className="twod-issues">
            {notes.map((i, k) => (
              <li key={`${i.code}-${k}`}>
                <Badge tone={i.severity === 'error' ? 'danger' : i.severity === 'warn' ? 'warn' : 'info'} size="sm">
                  {i.severity === 'error' ? 'Problem' : i.severity === 'warn' ? 'Check' : 'Note'}
                </Badge>{' '}
                {i.message}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </Sidebar>
  );
}

/** Merge a color into another, recolor it to a real yarn, or replace it with any color. */
function ColorDialog({ entry, label, palette, onClose, onOp, referenceLineId }: { entry: PaletteEntry; label: number; palette: PaletteEntry[]; onClose(): void; onOp(op: PaletteOp): void; referenceLineId: string }) {
  const line = getShippedLine(referenceLineId) ?? getShippedLine(DEFAULT_REFERENCE_LINE_ID) ?? SHIPPED_LINES[0];
  const [all, setAll] = useState(false);
  const [custom, setCustom] = useState(entry.hex);
  const yarns = useMemo(() => {
    const list: { yarn: Yarn; d: number }[] = (line?.yarns ?? []).map((yarn) => ({ yarn, d: deltaE00Hex(entry.hex.toLowerCase(), yarn.hex.toLowerCase()) }));
    return list.sort((a, b) => a.d - b.d || a.yarn.name.localeCompare(b.yarn.name));
  }, [line, entry.hex]);
  const shown = all ? yarns : yarns.slice(0, 8);
  const others = palette.map((p, i) => ({ p, i })).filter(({ i }) => i !== label);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Change ${entry.code} · ${entry.name}`}
      description="Every stitch of this color changes. Undo brings it back."
      size="md"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="twod-colordialog">
        <section aria-labelledby="twod-cd-yarn">
          <h3 id="twod-cd-yarn" className="twod-colordialog__h">
            Recolor to a yarn{line ? ` — ${line.brand} ${line.line}` : ''}
          </h3>
          <ul className="twod-yarnlist">
            {shown.map(({ yarn, d }) => (
              <li key={yarn.id}>
                <button type="button" className="twod-yarnbtn" onClick={() => onOp({ kind: 'recolor', label, yarn })} disabled={sameRef(refOf(entry), refOfYarn(yarn))}>
                  <span className="twod-swatch twod-swatch--lg" style={{ background: yarn.hex }} aria-hidden />
                  <span className="twod-yarnbtn__name">
                    {yarn.name}
                    {yarn.number ? <span className="twod-muted"> · {yarn.number}</span> : null}
                  </span>
                  <span className="twod-yarnbtn__de">ΔE {d.toFixed(1)}</span>
                </button>
              </li>
            ))}
          </ul>
          {yarns.length > 8 ? (
            <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>
              {all ? 'Show the closest only' : `Show all ${yarns.length} shades`}
            </Button>
          ) : null}
        </section>
        {others.length > 0 ? (
          <section aria-labelledby="twod-cd-merge">
            <h3 id="twod-cd-merge" className="twod-colordialog__h">
              Merge into another color
            </h3>
            <div className="twod-mergelist">
              {others.map(({ p, i }) => (
                <button key={`${p.code}-${i}`} type="button" className="twod-chipbtn" onClick={() => onOp({ kind: 'merge', from: label, into: i })}>
                  <span className="twod-swatch" style={{ background: p.hex }} aria-hidden />
                  {p.code} · {p.name}
                </button>
              ))}
            </div>
          </section>
        ) : null}
        <section aria-labelledby="twod-cd-any">
          <h3 id="twod-cd-any" className="twod-colordialog__h">
            Any color
          </h3>
          <div className="twod-anycolor">
            <label className="twod-anycolor__label">
              <input type="color" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Pick a color" />
              <span className="twod-mono">{custom}</span>
            </label>
            <Button size="sm" onClick={() => onOp({ kind: 'replace', label, color: { hex: custom.toLowerCase() } })} disabledReason={custom.toLowerCase() === entry.hex.toLowerCase() ? 'Pick a different color' : undefined}>
              Use this color
            </Button>
          </div>
        </section>
      </div>
    </Dialog>
  );
}

