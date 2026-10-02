// Track T2.3 — the chart settings sidebar of the Source and Chart tabs (DESIGN.md §1.3 F1 step 3): technique,
// hand, C2C start corner, round lean; yarn weight, hook and "I have a swatch" (§2.2.5: the measurement clears when
// the technique changes, the hook and measurements when the weight changes); finished size with the aspect lock,
// border width and color (§2.3.3, §2.7.10); colors (auto or a maximum), palette source with Red Heart Super Saver
// as the default line (§2.4.4), detail preset; and, folded away, picture kind, row fade and repeats.
//
// Every control writes through the slice (`changeSettings`, one undo step each); a change that would move hand
// edits to another chart size asks first (the dialog lives in the tabs).
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { countsPer4In, checkGauge, measurementField, resolveGaugeChecked, TABLE_A } from '../../core/gauge';
import { SHIPPED_LINES } from '../../core/yarn/lines';
import { useAppStore } from '../../state/appStore';
import { useProjectStore } from '../../state/projectStore';
import { changeSettings, handRecipe, hookRecipe, settingsRecipe, sourceOf, techniqueRecipe, twoDOf, weightRecipe } from '../../state/slices/twoD';
import type { ChartSettings, Cyc, GaugeSpec, Technique2D } from '../../types';
import { Badge, Button, formatLength, NumberField, Panel, SegmentedControl, Select, Sidebar, Stack, Switch, TextField } from '../common';
import { refOf } from './chartTools';
import { colorBudget, CORNERS, countsText, croppedSize, defaultHook, hookLabel, HOOKS, planChart, takesBorder, techniqueInfo, TECHNIQUES, WEIGHTS } from './settingsModel';
import { useChartView } from './useChart';

const DETAIL_HINT: Record<ChartSettings['detail'], string> = {
  max: 'Every small detail kept, more color changes.',
  balanced: 'Stray stitches cleaned up; outlines and eyes kept.',
  easy: 'Larger color areas, fewer changes per row — quickest to work.',
};

const LEAN_HINT: Record<ChartSettings['roundLean']['mode'], string> = {
  note: 'Work the chart as drawn; the pattern says how far the design will drift.',
  preskew: 'Each round is shifted so the finished design stands straight.',
  turn: 'Turn after every round: no drift, but every other round is worked from the wrong side.',
};

function set(label: string, edit: (s: ChartSettings) => void, coalesceKey?: string): void {
  changeSettings(label, settingsRecipe((s) => edit(s as ChartSettings)), coalesceKey ? { coalesceKey } : {});
}

export function SettingsSidebar() {
  const settings = useProjectStore((s) => twoDOf(s.doc)?.settings);
  if (!settings) return null;
  return (
    <Sidebar>
      <TechniquePanel settings={settings} />
      <YarnPanel settings={settings} />
      <SizePanel settings={settings} />
      <ColorsPanel settings={settings} />
    </Sidebar>
  );
}

function TechniquePanel({ settings }: { settings: ChartSettings }) {
  const mosaic = useAppStore((s) => s.prefs.features.mosaic);
  const options = TECHNIQUES.filter((t) => !t.flag || (t.flag === 'mosaic' && mosaic) || t.id === settings.technique).map((t) => ({ value: t.id, label: t.label }));
  return (
    <Panel title="Technique" icon="grid">
      <Stack gap={4}>
        <Select<Technique2D>
          label="Stitch technique"
          value={settings.technique}
          options={options}
          onChange={(t) => changeSettings(`Technique: ${techniqueInfo(t).label}`, techniqueRecipe(t))}
          hint={techniqueInfo(settings.technique).description}
        />
        <SegmentedControl<'right' | 'left'>
          label="I crochet"
          value={settings.hand}
          fullWidth
          onChange={(h) => changeSettings(h === 'left' ? 'Left-handed' : 'Right-handed', handRecipe(h))}
          options={[
            { value: 'right', label: 'Right-handed' },
            { value: 'left', label: 'Left-handed' },
          ]}
        />
        {settings.technique === 'c2c' ? (
          <Select<ChartSettings['startCorner']>
            label="Start corner"
            value={settings.startCorner}
            options={CORNERS.map((c) => ({ value: c.value, label: c.value === (settings.hand === 'left' ? 'BL' : 'BR') ? `${c.label} (usual)` : c.label }))}
            onChange={(c) => set(`Start corner: ${CORNERS.find((x) => x.value === c)?.label ?? c}`, (s) => void (s.startCorner = c))}
            hint="The first tile; rows grow diagonally from it."
          />
        ) : null}
        {settings.technique === 'sc_tapestry_round' ? (
          <>
            <Select<ChartSettings['roundLean']['mode']>
              label="Round lean"
              value={settings.roundLean.mode}
              options={[
                { value: 'note', label: 'Note the drift' },
                { value: 'preskew', label: 'Pre-skew the chart' },
                { value: 'turn', label: 'Turn every round' },
              ]}
              onChange={(m) => set('Round lean', (s) => void (s.roundLean = { ...s.roundLean, mode: m }))}
              hint={LEAN_HINT[settings.roundLean.mode]}
            />
            {settings.roundLean.mode !== 'turn' ? (
              <NumberField
                label="Drift per round"
                suffix="st"
                value={settings.roundLean.stPerRnd}
                min={-8}
                max={8}
                step={0.1}
                precision={2}
                onChange={(v) => v !== null && set('Drift per round', (s) => void (s.roundLean = { ...s.roundLean, stPerRnd: v }))}
                hint="About 0.5 st to the right for right-handed sc; measure yours on a swatch tube."
              />
            ) : null}
          </>
        ) : null}
      </Stack>
    </Panel>
  );
}

function swatchFieldsOf(g: GaugeSpec): 'swatch' | 'c2cSwatch' {
  return g.technique !== 'amigurumi_sc' && measurementField(g.technique) === 'c2cSwatch' ? 'c2cSwatch' : 'swatch';
}

function YarnPanel({ settings }: { settings: ChartSettings }) {
  const gauge = useProjectStore((s) => s.doc?.gauge);
  const units = useAppStore((s) => s.prefs.units);
  if (!gauge) return null;
  const spec: GaugeSpec = gauge.technique === settings.technique ? gauge : { ...gauge, technique: settings.technique };
  const field = swatchFieldsOf(spec);
  const hasSwatch = field === 'c2cSwatch' ? !!spec.c2cSwatch : !!spec.swatch;
  const issues = checkGauge(spec);
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity !== 'error');
  const def = defaultHook(spec);
  const hookOptions = [{ value: 'default', label: `Usual for this yarn — ${hookLabel(def)}` }, ...HOOKS.map((mm) => ({ value: String(mm), label: hookLabel(mm) }))];
  const hookValue = spec.hookMm === undefined ? 'default' : String(spec.hookMm);
  if (spec.hookMm !== undefined && !HOOKS.includes(spec.hookMm)) hookOptions.push({ value: String(spec.hookMm), label: hookLabel(spec.hookMm) });
  const table = TABLE_A[spec.cyc];
  const startSwatch = () => {
    changeSettings('I have a swatch', (d) => {
      if (field === 'c2cSwatch') d.gauge.c2cSwatch = { tiles: 5, spanIn: 4 };
      else d.gauge.swatch = { sts: table.sts4, rows: table.rows4, spanIn: 4 };
    });
  };
  const stopSwatch = () => {
    changeSettings('Use the yarn tables', (d) => {
      delete d.gauge.swatch;
      delete d.gauge.c2cSwatch;
    });
  };
  const resolved = errors.length === 0 ? resolveGaugeChecked(spec).gauge : undefined;
  const counts = resolved ? countsPer4In(resolved.cell) : null;
  const round = (x: number) => Math.round(x * 10) / 10;
  return (
    <Panel title="Yarn and hook" icon="yarn">
      <Stack gap={4}>
        <Select<string>
          label="Yarn weight"
          value={String(spec.cyc)}
          options={WEIGHTS.map((w) => ({ value: String(w.cyc), label: w.label }))}
          onChange={(v) => changeSettings('Yarn weight', weightRecipe(Number(v) as Cyc))}
          hint="Changing the weight resets the hook and any swatch."
        />
        <Select<string> label="Hook" value={hookValue} options={hookOptions} onChange={(v) => changeSettings('Hook', hookRecipe(v === 'default' ? undefined : Number(v)))} />
        <Switch label="I have a swatch" description="Measure a swatch in this technique for a true size." checked={hasSwatch} onChange={(on) => (on ? startSwatch() : stopSwatch())} />
        {hasSwatch && field === 'swatch' && spec.swatch ? (
          <div className="twod-swatch">
            <NumberField label="Stitches" value={spec.swatch.sts} min={0.5} max={1000} step={0.5} precision={1} size="sm" onChange={(v) => v !== null && changeSettings('Swatch stitches', (d) => void (d.gauge.swatch = { ...d.gauge.swatch!, sts: v }))} />
            <NumberField label="Rows" value={spec.swatch.rows} min={0.5} max={1000} step={0.5} precision={1} size="sm" onChange={(v) => v !== null && changeSettings('Swatch rows', (d) => void (d.gauge.swatch = { ...d.gauge.swatch!, rows: v }))} />
            <NumberField label="Over" kind="length" units={units} value={spec.swatch.spanIn} min={0.5} max={40} size="sm" onChange={(v) => v !== null && changeSettings('Swatch size', (d) => void (d.gauge.swatch = { ...d.gauge.swatch!, spanIn: v }))} />
          </div>
        ) : null}
        {hasSwatch && field === 'c2cSwatch' && spec.c2cSwatch ? (
          <div className="twod-swatch twod-swatch--two">
            <NumberField label="Tiles" value={spec.c2cSwatch.tiles} min={1} max={500} step={1} precision={0} size="sm" onChange={(v) => v !== null && changeSettings('Swatch tiles', (d) => void (d.gauge.c2cSwatch = { ...d.gauge.c2cSwatch!, tiles: v }))} />
            <NumberField label="Over" kind="length" units={units} value={spec.c2cSwatch.spanIn} min={0.5} max={60} size="sm" onChange={(v) => v !== null && changeSettings('Swatch size', (d) => void (d.gauge.c2cSwatch = { ...d.gauge.c2cSwatch!, spanIn: v }))} />
          </div>
        ) : null}
        {errors.length > 0 ? (
          <p className="twod-note twod-note--danger" role="alert">
            {errors[0].message}
          </p>
        ) : counts ? (
          <p className="twod-note">
            Gauge {settings.technique === 'c2c' ? `${round(counts.sts4)} tiles` : `${round(counts.sts4)} sts × ${round(counts.rows4)} ${settings.technique === 'sc_tapestry_round' ? 'rounds' : 'rows'}`} per {formatLength(4, units, units === 'cm' ? 1 : 0)}
            {hasSwatch ? ' (your swatch)' : ' (yarn tables)'}
          </p>
        ) : null}
        {warnings.length > 0 ? (
          <ul className="twod-warnings">
            {warnings.slice(0, 2).map((w) => (
              <li key={w.code + w.message}>
                <Badge tone="warn" size="sm">
                  Check
                </Badge>{' '}
                {w.message}
              </li>
            ))}
          </ul>
        ) : null}
      </Stack>
    </Panel>
  );
}

function SizePanel({ settings }: { settings: ChartSettings }) {
  const doc = useProjectStore((s) => s.doc);
  const units = useAppStore((s) => s.prefs.units);
  const chart = useChartView();
  const src = sourceOf(doc);
  const crop = twoDOf(doc)?.crop;
  const plan = useMemo(() => (doc && src ? planChart(doc, settings, croppedSize(src, crop)) : null), [doc, src, crop, settings]);
  const round = settings.technique === 'sc_tapestry_round';
  const p = plan && 'plan' in plan ? plan.plan : null;
  const pixel = chart.result?.kind === 'pixel' && settings.imageKind !== 'photo' && settings.imageKind !== 'flat';
  // Pixel art has its own size (one cell per pixel): show the worker's when it has one.
  const size = pixel && chart.result ? chart.result.size : p?.size;
  const shownW = settings.widthIn ?? size?.actualW ?? null;
  const shownH = settings.heightIn ?? size?.actualH ?? null;
  const setW = (v: number | null) =>
    set(round ? 'Circumference' : 'Width', (s) => {
      if (v === null) delete s.widthIn;
      else s.widthIn = v;
      if (s.lockAspect) delete s.heightIn;
    });
  const setH = (v: number | null) =>
    set('Height', (s) => {
      if (v === null) delete s.heightIn;
      else s.heightIn = v;
      if (s.lockAspect) delete s.widthIn;
    });
  const setLock = (on: boolean) =>
    set(on ? 'Keep proportions' : 'Set width and height', (s) => {
      s.lockAspect = on;
      if (on) {
        if (s.widthIn !== undefined) delete s.heightIn;
      } else if (size) {
        s.widthIn = s.widthIn ?? Math.round(size.actualW * 100) / 100;
        s.heightIn = s.heightIn ?? Math.round(size.actualH * 100) / 100;
      }
    });
  const palette = chart.result?.grid.palette ?? [];
  const borderOptions = [{ value: '', label: palette[0] ? `Color A (${palette[0].name})` : 'Color A' }, ...palette.map((e, i) => ({ value: String(i), label: `${e.code} · ${e.name}` }))];
  const borderIndex = settings.border.color ? palette.findIndex((e) => e.hex.toLowerCase() === settings.border.color!.hex.toLowerCase()) : -1;
  const borderValue = settings.border.color && borderIndex >= 0 ? String(borderIndex) : '';
  if (settings.border.color && borderIndex < 0) borderOptions.push({ value: 'kept', label: `Your color ${settings.border.color.hex}` });
  const tol = p ? Math.round(p.gauge.tol * 100) : null;
  const issues = p?.issues.filter((i) => i.code.startsWith('W_GRID')) ?? [];
  return (
    <Panel title="Finished size" icon="ruler">
      <Stack gap={4}>
        <div className="twod-size-fields">
          <NumberField label={round ? 'Around' : 'Width'} kind="length" units={units} value={shownW} min={0.5} max={600} allowEmpty onChange={setW} />
          <NumberField label={round ? 'Tall' : 'Height'} kind="length" units={units} value={shownH} min={0.5} max={600} allowEmpty onChange={setH} />
        </div>
        <Switch
          label="Keep the picture's proportions"
          description={settings.lockAspect ? 'Type a width or a height; the other follows the picture.' : 'Both sizes are fixed: crop the picture to match.'}
          checked={settings.lockAspect}
          onChange={setLock}
        />
        {takesBorder(settings.technique) ? (
          <div className="twod-size-fields">
            <NumberField label="Border" kind="length" units={units} value={settings.border.widthIn} min={0} max={24} onChange={(v) => set('Border width', (s) => void (s.border = { ...s.border, widthIn: v ?? 0 }))} hint={settings.border.widthIn > 0 ? 'sc rounds, included in the size' : 'None'} />
            <Select<string>
              label="Border color"
              value={settings.border.color ? (borderValue || 'kept') : ''}
              disabled={!(settings.border.widthIn > 0)}
              options={borderOptions}
              onChange={(v) => {
                if (v === 'kept') return;
                const entry = v === '' ? undefined : palette[Number(v)];
                set('Border color', (s) => {
                  if (entry) s.border = { ...s.border, color: refOf(entry) };
                  else s.border = { widthIn: s.border.widthIn };
                });
              }}
            />
          </div>
        ) : null}
        {size ? (
          <div className="twod-size-summary" aria-live="polite">
            <strong>
              {formatLength(size.actualW, units, 1)} × {formatLength(size.actualH, units, 1)}
            </strong>
            {tol !== null ? <span className="twod-muted"> ±{tol}%</span> : null}
            <span className="twod-size-counts">
              {countsText(settings.technique, size.cols, size.rows)}
              {size.borderRounds > 0 ? ` + ${size.borderRounds} border ${size.borderRounds === 1 ? 'round' : 'rounds'}` : ''}
            </span>
            {p?.defaultSize && !pixel ? <span className="twod-muted">Default size, 60 stitches wide. Type a size to change it.</span> : null}
            {pixel ? <span className="twod-muted">Pixel art: one stitch per pixel.</span> : null}
          </div>
        ) : plan && 'errors' in plan ? (
          <p className="twod-note twod-note--danger">{plan.errors[0]?.message ?? 'This size cannot be charted.'}</p>
        ) : null}
        {issues.length > 0 ? (
          <ul className="twod-warnings">
            {issues.map((w) => (
              <li key={w.code}>
                <Badge tone={w.code === 'W_GRID_LARGE' || w.code === 'W_GRID_CAPPED' ? 'warn' : 'info'} size="sm">
                  {w.code === 'W_GRID_LARGE' ? 'Large' : w.code === 'W_GRID_CAPPED' ? 'Capped' : 'Note'}
                </Badge>{' '}
                {w.message}
              </li>
            ))}
          </ul>
        ) : null}
      </Stack>
    </Panel>
  );
}

function ColorsPanel({ settings }: { settings: ChartSettings }) {
  const budget = colorBudget(settings.technique);
  const auto = settings.maxColors === 'auto';
  const csvInput = useRef<HTMLInputElement>(null);
  const [csvDraft, setCsvDraft] = useState<string | null>(null);
  const csv = csvDraft ?? settings.customCsv ?? '';
  const lines = SHIPPED_LINES;
  let paletteHint: ReactNode = 'Colors from the picture, named after the closest Red Heart Super Saver shades.';
  if (settings.paletteMode === 'line') paletteHint = 'Only real shades of the chosen yarn line.';
  if (settings.paletteMode === 'custom') paletteHint = 'One color per line: #hex, name, brand, code, yards per skein.';
  return (
    <Panel title="Colors" icon="palette">
      <Stack gap={4}>
        <Switch
          label="Choose the number of colors for me"
          checked={auto}
          onChange={(on) => set(on ? 'Colors: automatic' : 'Colors: up to a number', (s) => void (s.maxColors = on ? 'auto' : budget.defaultK))}
        />
        {!auto ? (
          <NumberField
            label="Most colors"
            value={typeof settings.maxColors === 'number' ? settings.maxColors : budget.defaultK}
            min={1}
            max={budget.maxK}
            step={1}
            precision={0}
            stepper
            onChange={(v) => v !== null && set('Most colors', (s) => void (s.maxColors = Math.round(v)))}
            hint={`Up to ${budget.maxK} for this technique (the background yarn is extra).`}
          />
        ) : null}
        <Select<ChartSettings['paletteMode']>
          label="Yarn colors from"
          value={settings.paletteMode}
          options={[
            { value: 'auto', label: 'The picture (auto)' },
            { value: 'line', label: 'A yarn line' },
            { value: 'stash', label: 'My stash (coming soon)', disabled: true },
            { value: 'custom', label: 'My own list (CSV)' },
          ]}
          onChange={(m) => set('Yarn colors from', (s) => void (s.paletteMode = m))}
          hint={paletteHint}
        />
        {settings.paletteMode === 'line' || settings.paletteMode === 'auto' ? (
          <Select<string>
            label={settings.paletteMode === 'line' ? 'Yarn line' : 'Name colors after'}
            value={settings.paletteMode === 'line' ? (settings.lineIds[0] ?? lines[0]?.id ?? '') : settings.referenceLineId || lines[0]?.id || ''}
            options={lines.map((l) => ({ value: l.id, label: `${l.brand} ${l.line} (${l.yarns.length} shades)` }))}
            onChange={(id) =>
              set('Yarn line', (s) => {
                if (s.paletteMode === 'line') s.lineIds = [id];
                else s.referenceLineId = id;
              })
            }
          />
        ) : null}
        {settings.paletteMode === 'custom' ? (
          <Stack gap={2}>
            <TextField
              label="Color list"
              multiline
              rows={4}
              value={csv}
              placeholder={'#b22222, Cherry red\n#f5f0e6, Cream'}
              onChange={setCsvDraft}
              onBlur={() => {
                if (csvDraft !== null && csvDraft !== (settings.customCsv ?? '')) set('Color list', (s) => void (s.customCsv = csvDraft));
                setCsvDraft(null);
              }}
            />
            <input
              ref={csvInput}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                const text = await f.text();
                set('Load color list', (s) => void (s.customCsv = text));
              }}
            />
            <Button size="sm" icon="upload" onClick={() => csvInput.current?.click()}>
              Load a CSV file…
            </Button>
          </Stack>
        ) : null}
        <SegmentedControl<ChartSettings['detail']>
          label="Detail"
          value={settings.detail}
          fullWidth
          onChange={(v) => set('Detail', (s) => void (s.detail = v))}
          options={[
            { value: 'max', label: 'Max' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'easy', label: 'Easy' },
          ]}
        />
        <p className="twod-note">{DETAIL_HINT[settings.detail]}</p>
      </Stack>
      <AdvancedSettings settings={settings} />
    </Panel>
  );
}

function AdvancedSettings({ settings }: { settings: ChartSettings }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="twod-advanced">
      <button type="button" className="twod-disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>More options</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden className={open ? 'twod-chevron twod-chevron--open' : 'twod-chevron'}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <Stack gap={4} className="twod-advanced__body">
          <Select<ChartSettings['imageKind']>
            label="Picture kind"
            value={settings.imageKind}
            options={[
              { value: 'auto', label: 'Detect for me' },
              { value: 'photo', label: 'Photo' },
              { value: 'flat', label: 'Flat art (logo, cartoon)' },
              { value: 'pixel', label: 'Pixel art (one stitch per pixel)' },
            ]}
            onChange={(k) => set('Picture kind', (s) => void (s.imageKind = k))}
          />
          <Switch
            label="Row fade for gradients"
            description="Soft gradients become stripes of changing width, never extra changes inside a row."
            checked={settings.dither === 'rowFade'}
            onChange={(on) => set(on ? 'Row fade on' : 'Row fade off', (s) => void (s.dither = on ? 'rowFade' : 'off'))}
          />
          <Select<ChartSettings['applyRepeats']>
            label="Repeated rows"
            value={settings.applyRepeats}
            options={[
              { value: 'auto', label: 'Write as repeats' },
              { value: 'ask', label: 'Ask me' },
              { value: 'off', label: 'Write every row' },
            ]}
            onChange={(v) => set('Repeated rows', (s) => void (s.applyRepeats = v))}
          />
        </Stack>
      ) : null}
    </div>
  );
}
