// Track T6.3 — the inspector's Colors page (DESIGN.md §4.2 Paint, Palette, Features; §2.11.1, §2.9.6): the brush
// (Paint P: brush, eraser, fill, pick a color; its size), the palette (add, rename, recolor, match to a yarn, merge,
// reorder, delete), the selected part's stripes / bands / patches / spots with their on-model guides, its face
// details (eyes, nose, mouth, cheeks, embroidery), and Apply photo colors. Every change is one history step through
// `colorTools.ts`; everything is reachable from the keyboard (placing by a click on the model also has fields).
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { notify } from '../../app/toasts';
import { isImplemented } from '../../core/stub';
import { nearestYarn } from '../../core/yarn/match';
import {
  addColorBlockedReason,
  addFeatureBlockedReason,
  addRegionBlockedReason,
  defaultFeature,
  FEATURE_KINDS,
  partName,
  PATH_FEATURE_KINDS,
  paletteIndex,
  paletteUse,
  removeColorBlockedReason,
  SAFETY_EYE_MM,
  type FeatureKind,
  type RegionKind,
} from '../../state/slices/model3d';
import { projectStore, useProjectStore } from '../../state/projectStore';
import type { CrochetModelV1, Feature, Part, Region } from '../../types/model';
import type { UnitPref } from '../../types/units';
import { Badge, Banner, Button, IconButton, NumberField, Panel, SegmentedControl, Select, Sidebar, Slider, Switch, TextField, cx, formatLength } from '../common';
import {
  addColor,
  addDetail,
  addRegionTo,
  brushColor,
  changeColor,
  changeFeature,
  changeRegion,
  clearPaint,
  DEFAULT_FEATURE_HEX,
  deleteColor,
  deleteFeature,
  deleteRegion,
  endColorEdit,
  FEATURE_HINTS,
  FEATURE_NAMES,
  meshLabelUse,
  mergeColors,
  moveColor,
  reorderRegion,
} from './colorTools';
import { prettyName } from './dimSpecs';
import { BRUSH_LIMITS_IN, editorStore, useEditorStore, type PaintMode } from './editorStore';
import { useModelMeshes } from './meshAssets';
import { applyPhotoColors, labelledViews, photoColorsBlockedReason } from './photoColors';

const READ_ONLY = 'This project is read-only';
/** The yarn line palette colors are matched against (T1's default reference line, §2.4.4). */
const MATCH_LINE_ID = 'red-heart-super-saver';
const MATCH_LINE_NAME = 'Red Heart Super Saver';

export interface ColorsPanelProps {
  model: CrochetModelV1;
  units: UnitPref;
  readOnly: boolean;
}

export function ColorsPanel({ model, units, readOnly }: ColorsPanelProps) {
  const selection = useEditorStore((s) => s.selection);
  const primary = selection[selection.length - 1];
  const part = primary ? model.parts.find((p) => p.id === primary) : undefined;
  return (
    <Sidebar>
      <BrushPanel model={model} units={units} readOnly={readOnly} part={part} />
      <PalettePanel model={model} readOnly={readOnly} />
      <RegionsPanel model={model} part={part} units={units} readOnly={readOnly} />
      <FeaturesPanel model={model} part={part} units={units} readOnly={readOnly} />
      <PhotoColorsPanel readOnly={readOnly} />
    </Sidebar>
  );
}

const colorLabel = (c: CrochetModelV1['palette'][number]) => (c.name ? prettyName(c.name) : prettyName(c.id));

/** A palette select with the color's swatch beside it. */
function ColorSelect({ model, label, value, onChange, disabled, allowDefault }: { model: CrochetModelV1; label: string; value: string | undefined; onChange(id: string): void; disabled?: boolean; allowDefault?: string }) {
  const hex = value ? model.palette.find((c) => c.id === value)?.hex : undefined;
  const options = model.palette.map((c) => ({ value: c.id, label: colorLabel(c) }));
  return (
    <div className="shape-color-select">
      <span className="shape-swatch shape-swatch--field" style={{ background: hex ?? 'transparent' }} aria-hidden="true" />
      <Select size="sm" label={label} value={value ?? ''} disabled={disabled} options={allowDefault ? [{ value: '', label: allowDefault }, ...options] : options} onChange={onChange} />
    </div>
  );
}

// ---- brush

const MODES: { value: PaintMode; label: string; tooltip: string }[] = [
  { value: 'brush', label: 'Brush', tooltip: 'Paint where you drag on a part' },
  { value: 'erase', label: 'Eraser', tooltip: 'Remove brush strokes: the stripes and the part’s color show again' },
  { value: 'fill', label: 'Fill', tooltip: 'Click a part: it all takes this color' },
  { value: 'pick', label: 'Pick', tooltip: 'Click the model to take a color from it' },
];

function BrushPanel({ model, units, readOnly, part }: { model: CrochetModelV1; units: UnitPref; readOnly: boolean; part?: Part }) {
  const tool = useEditorStore((s) => s.tool);
  const paint = useEditorStore((s) => s.paint);
  const color = brushColor(model, paint.color);
  const swatch = model.palette.find((c) => c.id === color);
  const on = tool === 'paint' && !readOnly;
  return (
    <Panel title="Paint" icon="pencil" actions={on ? <Badge tone="accent" size="sm" icon={null}>On</Badge> : null}>
      <div className="shape-stack">
        {on ? null : (
          <div className="shape-paint-off">
            <p className="shape-hint">Paint straight on the model, stitch by stitch: the pattern follows what you paint.</p>
            <Button size="sm" variant="primary" icon="pencil" disabledReason={readOnly ? READ_ONLY : undefined} onClick={() => editorStore.getState().setTool('paint')} aria-keyshortcuts="P">
              Start painting (P)
            </Button>
          </div>
        )}
        <SegmentedControl<PaintMode>
          label="Tool"
          size="sm"
          fullWidth
          value={paint.mode}
          disabled={readOnly}
          onChange={(mode) => {
            editorStore.getState().setPaint({ mode });
            if (!readOnly) editorStore.getState().setTool('paint');
          }}
          options={MODES}
        />
        <div className="shape-brush-color" aria-live="polite">
          <span className="shape-swatch shape-swatch--lg" style={{ background: swatch?.hex ?? 'transparent' }} aria-hidden="true" />
          <span>
            {paint.mode === 'erase' ? 'Erasing brush strokes' : <>Color: <strong>{swatch ? colorLabel(swatch) : '—'}</strong></>}
            <span className="shape-hint shape-brush-color__how">Choose another in Colors below{paint.mode !== 'pick' ? ', or use Pick' : ''}.</span>
          </span>
        </div>
        {paint.mode === 'brush' || paint.mode === 'erase' ? (
          <Slider
            label="Brush size"
            value={paint.radiusIn * 2}
            min={BRUSH_LIMITS_IN[0] * 2}
            max={BRUSH_LIMITS_IN[1] * 2}
            step={0.05}
            format={(v) => formatLength(v, units)}
            disabled={readOnly}
            onChange={(d) => editorStore.getState().setPaint({ radiusIn: d / 2 })}
            hint={
              <>
                Across the brush. <kbd className="ui-kbd">[</kbd> and <kbd className="ui-kbd">]</kbd> change it while painting.
              </>
            }
          />
        ) : null}
        {part && (part.paint || part.type === 'mesh') ? (
          <Button size="sm" variant="ghost" icon="x" disabledReason={readOnly ? READ_ONLY : undefined} onClick={() => void clearPaint(part.id)}>
            Clear brush strokes on {partName(part)}
          </Button>
        ) : null}
      </div>
    </Panel>
  );
}

// ---- palette

function PalettePanel({ model, readOnly }: { model: CrochetModelV1; readOnly: boolean }) {
  const paint = useEditorStore((s) => s.paint);
  const meshes = useModelMeshes();
  const chosen = brushColor(model, paint.color);
  const groupRef = useRef<HTMLDivElement>(null);
  const add = () => {
    const used = new Set(model.palette.map((c) => c.hex.toUpperCase()));
    const hex = SUGGESTED.find((h) => !used.has(h)) ?? '#888888';
    addColor(hex, 'New color');
  };
  const select = (id: string) => editorStore.getState().setPaint({ color: id, mode: paint.mode === 'erase' || paint.mode === 'pick' ? 'brush' : paint.mode });
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = paletteIndex(model, chosen);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = model.palette[(i + step + model.palette.length) % model.palette.length];
    select(next.id);
    groupRef.current?.querySelector<HTMLElement>(`[data-color="${next.id}"]`)?.focus();
  };
  const current = model.palette.find((c) => c.id === chosen);
  return (
    <Panel
      title="Colors"
      icon="palette"
      actions={
        <Badge tone="neutral" size="sm" icon={null}>
          {model.palette.length} / 16
        </Badge>
      }
    >
      <div className="shape-stack">
        <div ref={groupRef} role="radiogroup" aria-label="Brush color" className="shape-palette" onKeyDown={onKeyDown}>
          {model.palette.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={c.id === chosen}
              tabIndex={c.id === chosen ? 0 : -1}
              data-color={c.id}
              className={cx('shape-palette__item', c.id === chosen && 'shape-palette__item--on')}
              onClick={() => select(c.id)}
              title={`${colorLabel(c)} · ${c.hex}`}
            >
              <span className="shape-palette__chip" style={{ background: c.hex }} aria-hidden="true" />
              <span className="shape-palette__name">{colorLabel(c)}</span>
            </button>
          ))}
        </div>
        <Button size="sm" icon="plus" disabledReason={readOnly ? READ_ONLY : (addColorBlockedReason(model) ?? undefined)} onClick={add}>
          Add a color
        </Button>
        {current ? <ColorEditor key={`${current.id}:${current.name ?? ''}`} model={model} color={current} readOnly={readOnly} meshLabels={meshLabelUse(paletteIndex(model, current.id), meshes)} /> : null}
      </div>
    </Panel>
  );
}

/** Pleasant yarn-like colors offered for a new palette entry. */
const SUGGESTED = ['#E8A0B4', '#8FB8DE', '#9CC69B', '#F2C14E', '#C9A27E', '#B59BD6', '#F28C5B', '#6E8B74', '#D9D4CC', '#5B6C8F'];

function ColorEditor({ model, color, readOnly, meshLabels }: { model: CrochetModelV1; color: CrochetModelV1['palette'][number]; readOnly: boolean; meshLabels: number }) {
  // Keyed by the color's id and name (PalettePanel), so a name changed elsewhere (undo) starts the field over.
  const [name, setName] = useState(color.name ?? '');
  const [mergeInto, setMergeInto] = useState('');
  const use = paletteUse(model, color.id);
  const usedBy = use.parts.length + use.regions + use.features + (use.paintCells > 0 ? 1 : 0) + (meshLabels > 0 ? 1 : 0);
  const match = useMemo(() => (isImplemented(nearestYarn) ? nearestYarn(color.hex, [MATCH_LINE_ID]) : null), [color.hex]);
  const removeReason = readOnly ? READ_ONLY : removeColorBlockedReason(model, color.id, meshLabels);
  const i = paletteIndex(model, color.id);
  const others = model.palette.filter((c) => c.id !== color.id);
  return (
    <div className="shape-color-edit" aria-label={`Edit ${colorLabel(color)}`} role="group">
      <div className="shape-color-edit__row">
        <label className="shape-color-input">
          <span className="ui-visually-hidden">Color of {colorLabel(color)}</span>
          <input
            type="color"
            value={color.hex.toLowerCase()}
            disabled={readOnly}
            onChange={(e) => changeColor(color.id, { hex: e.target.value })}
            onBlur={() => endColorEdit()}
          />
        </label>
        <TextField
          size="sm"
          label="Name"
          value={name}
          disabled={readOnly}
          maxLength={60}
          onChange={setName}
          onBlur={() => {
            if (name.trim() !== (color.name ?? '')) changeColor(color.id, { name: name.trim() || null });
            endColorEdit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <p className="shape-hint">
        <code>{color.hex}</code> · {usedBy === 0 ? 'not used yet' : `used by ${describeUse(use, meshLabels)}`}
      </p>
      {match ? (
        <div className="shape-yarn-match">
          <span className="shape-swatch" style={{ background: match.yarn.hex }} aria-hidden="true" />
          <span className="shape-yarn-match__text">
            Closest {MATCH_LINE_NAME}: <strong>{match.yarn.name}</strong>
            {match.yarn.number ? ` (${match.yarn.number})` : ''} · ΔE {match.deltaE00.toFixed(1)}
            {match.deltaE00 < 2 ? ' · a match' : match.deltaE00 < 5 ? ' · close' : ' · not close'}
          </span>
          {match.deltaE00 >= 0.5 || color.name !== match.yarn.name ? (
            <Button size="sm" variant="ghost" disabledReason={readOnly ? READ_ONLY : undefined} onClick={() => changeColor(color.id, { hex: match.yarn.hex, name: match.yarn.name })}>
              Use this yarn
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="shape-color-edit__row shape-color-edit__row--end">
        <Select
          size="sm"
          label="Merge into"
          value={mergeInto}
          disabled={readOnly || others.length === 0}
          options={[{ value: '', label: 'Choose a color…' }, ...others.map((c) => ({ value: c.id, label: colorLabel(c) }))]}
          onChange={setMergeInto}
        />
        <Button
          size="sm"
          disabledReason={readOnly ? READ_ONLY : !mergeInto ? 'Choose the color to merge into' : undefined}
          onClick={() => {
            const into = mergeInto;
            setMergeInto('');
            void mergeColors(color.id, into).then((ok) => {
              if (ok) notify.success(`Merged ${colorLabel(color)} into ${colorLabel(model.palette.find((c) => c.id === into) ?? { id: into, hex: '' })}.`);
            });
          }}
        >
          Merge
        </Button>
      </div>
      <div className="shape-color-edit__row shape-color-edit__row--tools">
        <IconButton icon="chevron-up" size="sm" label="Move this color up" disabledReason={readOnly ? READ_ONLY : i === 0 ? 'Already first' : undefined} onClick={() => void moveColor(color.id, -1)} />
        <IconButton icon="chevron-down" size="sm" label="Move this color down" disabledReason={readOnly ? READ_ONLY : i === model.palette.length - 1 ? 'Already last' : undefined} onClick={() => void moveColor(color.id, 1)} />
        <span className="shape-actions__spacer" />
        <Button size="sm" variant="ghost" icon="trash" disabledReason={removeReason ?? undefined} onClick={() => void deleteColor(color.id, meshLabels)}>
          Delete
        </Button>
      </div>
    </div>
  );
}

function describeUse(use: ReturnType<typeof paletteUse>, meshLabels: number): string {
  const bits: string[] = [];
  if (use.parts.length) bits.push(use.parts.length === 1 ? '1 part' : `${use.parts.length} parts`);
  if (use.regions) bits.push(use.regions === 1 ? '1 stripe or spot' : `${use.regions} stripes or spots`);
  if (use.features) bits.push(use.features === 1 ? '1 detail' : `${use.features} details`);
  if (use.paintCells || meshLabels) bits.push('brush strokes');
  return bits.join(', ');
}

// ---- regions

const REGION_NAMES: Record<Region['kind'], string> = { band: 'Band', stripes: 'Stripes', patch: 'Patch', spot: 'Spot', pattern: 'Pattern' };
const REGION_HINTS: Record<RegionKind, string> = {
  band: 'One ring of color around the part',
  stripes: 'Repeating rounds of colors',
  patch: 'A colored area on one side (a belly, a bib)',
  spot: 'A round spot anywhere',
};

const pct = (x: number | undefined, d: number) => Math.round((x ?? d) * 100);

function regionSummary(r: Region): string {
  switch (r.kind) {
    case 'band':
      return `${pct(r.from, 0)}–${pct(r.to, 1)}% up`;
    case 'stripes':
      return `${r.colors.length} colors, ${pct(r.from, 0)}–${pct(r.to, 1)}% up`;
    case 'patch':
      return `${Math.round(r.spanDeg)}° wide, ${pct(r.from, 0)}–${pct(r.to, 1)}% up`;
    case 'spot':
      return `at ${Math.round(r.azimuthDeg)}°, ${Math.round(r.elevationDeg)}° up`;
    case 'pattern':
      return `${prettyName(r.pattern)} (shown in the pattern only)`;
  }
}

function regionColors(r: Region): string[] {
  return r.kind === 'stripes' || r.kind === 'pattern' ? r.colors : [r.color];
}

function RegionsPanel({ model, part, units, readOnly }: { model: CrochetModelV1; part?: Part; units: UnitPref; readOnly: boolean }) {
  const active = useEditorStore((s) => s.activeRegion);
  const palette = useMemo(() => new Map(model.palette.map((c) => [c.id, c.hex])), [model.palette]);
  if (!part) {
    return (
      <Panel title="Stripes & spots" icon="layers">
        <p className="shape-hint">Select a part to give it bands, stripes, a patch or spots.</p>
      </Panel>
    );
  }
  const regions = part.regions ?? [];
  const blocked = readOnly ? READ_ONLY : addRegionBlockedReason(model, part.id);
  return (
    <Panel
      title="Stripes & spots"
      icon="layers"
      actions={
        regions.length > 0 ? (
          <Badge tone="neutral" size="sm" icon={null}>
            {regions.length}
          </Badge>
        ) : null
      }
    >
      <div className="shape-stack">
        <p className="shape-hint">On {partName(part)}. Later ones are drawn over earlier ones; brush strokes go on top of all.</p>
        {regions.length > 0 ? (
          <ul className="shape-list" aria-label={`Stripes and spots on ${partName(part)}`}>
            {regions.map((r, i) => {
              const open = active?.partId === part.id && active.index === i;
              return (
                <li key={`${i}:${r.kind}`} className={cx('shape-list__item', open && 'shape-list__item--open')}>
                  <button
                    type="button"
                    className="shape-list__head"
                    aria-expanded={open}
                    onClick={() => editorStore.getState().setActiveRegion(open ? null : { partId: part.id, index: i })}
                  >
                    <span className="shape-list__swatches" aria-hidden="true">
                      {regionColors(r).map((c, k) => (
                        <span key={k} className="shape-swatch" style={{ background: palette.get(c) ?? 'transparent' }} />
                      ))}
                    </span>
                    <span className="shape-list__title">{REGION_NAMES[r.kind]}</span>
                    <span className="shape-list__meta">{regionSummary(r)}</span>
                  </button>
                  {open ? <RegionEditor model={model} part={part} index={i} region={r} units={units} readOnly={readOnly} count={regions.length} /> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        <div className="shape-add-row" role="group" aria-label="Add to this part">
          {(['band', 'stripes', 'patch', 'spot'] as const).map((k) => (
            <Button key={k} size="sm" icon="plus" title={REGION_HINTS[k]} disabledReason={blocked ?? undefined} onClick={() => addRegionTo(part.id, k)}>
              {REGION_NAMES[k]}
            </Button>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function RegionEditor({ model, part, index, region, units, readOnly, count }: { model: CrochetModelV1; part: Part; index: number; region: Region; units: UnitPref; readOnly: boolean; count: number }) {
  const key = (field: string) => `t6-region-${part.id}-${index}-${field}`;
  const set = (patch: Partial<Region>, field?: string) => changeRegion(part.id, index, { ...region, ...patch } as Region, field ? { coalesceKey: key(field) } : {});
  const end = () => projectStore.getState().endCoalescing();
  const pick = useEditorStore((s) => s.surfacePick);
  const placing = pick?.kind === 'region' && pick.partId === part.id && pick.index === index;
  const range = (r: { from?: number; to?: number }) => (
    <>
      <Slider label="Starts at" value={pct(r.from, 0)} min={0} max={100} format={(v) => `${v}% up`} disabled={readOnly} onChange={(v) => set({ from: Math.min(v / 100, r.to ?? 1) } as Partial<Region>, 'from')} onCommit={end} />
      <Slider label="Ends at" value={pct(r.to, 1)} min={0} max={100} format={(v) => `${v}% up`} disabled={readOnly} onChange={(v) => set({ to: Math.max(v / 100, r.from ?? 0) } as Partial<Region>, 'to')} onCommit={end} />
    </>
  );
  const around = (az: number) => (
    <Slider label="Around" value={Math.round(az)} min={-180} max={180} format={(v) => (v === 0 ? 'front' : Math.abs(v) >= 179 ? 'back' : `${Math.abs(v)}° to the ${v > 0 ? 'left' : 'right'}`)} disabled={readOnly} onChange={(v) => set({ azimuthDeg: v } as Partial<Region>, 'az')} onCommit={end} hint="Seen from the front: the toy’s own left or right." />
  );
  let fields: ReactNode = null;
  switch (region.kind) {
    case 'band':
      fields = (
        <>
          <ColorSelect model={model} label="Color" value={region.color} disabled={readOnly} onChange={(c) => set({ color: c })} />
          {range(region)}
        </>
      );
      break;
    case 'stripes':
      fields = (
        <>
          <fieldset className="shape-stripes">
            <legend className="shape-axes__legend">Stripe colors, bottom up</legend>
            {region.colors.map((c, k) => (
              <div key={k} className="shape-stripes__row">
                <ColorSelect model={model} label={`Stripe ${k + 1}`} value={c} disabled={readOnly} onChange={(v) => set({ colors: region.colors.map((x, j) => (j === k ? v : x)) })} />
                <IconButton icon="x" size="sm" label={`Remove stripe color ${k + 1}`} disabledReason={readOnly ? READ_ONLY : region.colors.length <= 1 ? 'Stripes need at least one color' : undefined} onClick={() => set({ colors: region.colors.filter((_, j) => j !== k) })} />
              </div>
            ))}
            <Button size="sm" variant="ghost" icon="plus" disabledReason={readOnly ? READ_ONLY : region.colors.length >= 8 ? 'At most 8 colors' : undefined} onClick={() => set({ colors: [...region.colors, part.color] })}>
              Add a stripe color
            </Button>
          </fieldset>
          <NumberField label="Stripe height" size="sm" kind="length" units={units} value={region.widthIn} min={0.05} max={48} disabled={readOnly} onChange={(v) => v !== null && set({ widthIn: v })} hint="How tall each stripe is." />
          {range(region)}
        </>
      );
      break;
    case 'patch':
      fields = (
        <>
          <ColorSelect model={model} label="Color" value={region.color} disabled={readOnly} onChange={(c) => set({ color: c })} />
          {around(region.azimuthDeg)}
          <Slider label="Width" value={Math.round(region.spanDeg)} min={5} max={360} format={(v) => `${v}° of the way round`} disabled={readOnly} onChange={(v) => set({ spanDeg: v }, 'span')} onCommit={end} />
          {range(region)}
        </>
      );
      break;
    case 'spot':
      fields = (
        <>
          <ColorSelect model={model} label="Color" value={region.color} disabled={readOnly} onChange={(c) => set({ color: c })} />
          {around(region.azimuthDeg)}
          <Slider label="Up or down" value={Math.round(region.elevationDeg)} min={-90} max={90} format={(v) => (v === 0 ? 'middle' : `${Math.abs(v)}° ${v > 0 ? 'up' : 'down'}`)} disabled={readOnly} onChange={(v) => set({ elevationDeg: v }, 'el')} onCommit={end} />
          <NumberField label="Size across" size="sm" kind="length" units={units} value={region.radiusIn * 2} min={0.05} max={20} disabled={readOnly} onChange={(v) => v !== null && set({ radiusIn: v / 2 })} />
        </>
      );
      break;
    case 'pattern':
      fields = <p className="shape-hint">This pattern came with the model. The 3D view does not draw it; the written pattern does.</p>;
      break;
  }
  return (
    <div className="shape-list__body">
      {region.kind === 'patch' || region.kind === 'spot' ? (
        <Button
          size="sm"
          variant={placing ? 'primary' : 'secondary'}
          icon="cube"
          disabledReason={readOnly ? READ_ONLY : undefined}
          onClick={() => editorStore.getState().setSurfacePick(placing ? null : { kind: 'region', partId: part.id, index })}
        >
          {placing ? 'Click on the model… (Esc)' : 'Place it on the model'}
        </Button>
      ) : null}
      {region.kind !== 'pattern' ? <p className="shape-hint">Or drag its handles on the model.</p> : null}
      {fields}
      <div className="shape-color-edit__row shape-color-edit__row--tools">
        <IconButton icon="chevron-up" size="sm" label="Draw it under the one before" disabledReason={readOnly ? READ_ONLY : index === 0 ? 'Already first' : undefined} onClick={() => reorderRegion(part.id, index, -1)} />
        <IconButton icon="chevron-down" size="sm" label="Draw it over the one after" disabledReason={readOnly ? READ_ONLY : index === count - 1 ? 'Already last' : undefined} onClick={() => reorderRegion(part.id, index, 1)} />
        <span className="shape-actions__spacer" />
        <Button size="sm" variant="ghost" icon="trash" disabledReason={readOnly ? READ_ONLY : undefined} onClick={() => deleteRegion(part.id, index)}>
          Remove
        </Button>
      </div>
    </div>
  );
}

// ---- features

function FeaturesPanel({ model, part, units, readOnly }: { model: CrochetModelV1; part?: Part; units: UnitPref; readOnly: boolean }) {
  const [kind, setKind] = useState<FeatureKind>('safety_eye');
  const [open, setOpen] = useState<string | null>(null);
  const pick = useEditorStore((s) => s.surfacePick);
  const audience = model.audience;
  if (!part) {
    return (
      <Panel title="Face & details" icon="eye">
        <p className="shape-hint">Select a part (usually the head) to add eyes, a nose, a mouth, cheeks or embroidery.</p>
      </Panel>
    );
  }
  const features = (model.features ?? []).filter((f) => f.on === part.id);
  const blocked = readOnly ? READ_ONLY : addFeatureBlockedReason(model, part.id);
  const isPath = PATH_FEATURE_KINDS.includes(kind);
  const placing = (pick?.kind === 'feature' || pick?.kind === 'path') && pick.featureKind === kind;
  const startPlacing = () => {
    if (placing) {
      editorStore.getState().setSurfacePick(null);
      return;
    }
    editorStore.getState().setSurfacePick(isPath ? { kind: 'path', featureKind: kind, partId: null, points: [] } : { kind: 'feature', featureKind: kind, partId: part.id });
  };
  const addFront = () => {
    // The keyboard path: at the front of the part, then adjust with the fields.
    const f = defaultFeature(kind, part, kind === 'safety_eye' || kind === 'embroidered_eye' ? 25 : 0, kind === 'safety_eye' || kind === 'embroidered_eye' ? 15 : 0);
    if (isPath) f.path = [[-15, -15], [0, -20], [15, -15]];
    const id = addDetail(f);
    if (id) setOpen(id);
  };
  return (
    <Panel
      title="Face & details"
      icon="eye"
      actions={
        features.length > 0 ? (
          <Badge tone="neutral" size="sm" icon={null}>
            {features.length}
          </Badge>
        ) : null
      }
    >
      <div className="shape-stack">
        {features.length > 0 ? (
          <ul className="shape-list" aria-label={`Details on ${partName(part)}`}>
            {features.map((f) => (
              <li key={f.id} className={cx('shape-list__item', open === f.id && 'shape-list__item--open')}>
                <button type="button" className="shape-list__head" aria-expanded={open === f.id} onClick={() => setOpen(open === f.id ? null : f.id)}>
                  <span className="shape-list__swatches" aria-hidden="true">
                    <span className="shape-swatch" style={{ background: model.palette.find((c) => c.id === f.color)?.hex ?? DEFAULT_FEATURE_HEX[f.kind] }} />
                  </span>
                  <span className="shape-list__title">{FEATURE_NAMES[f.kind]}</span>
                  <span className="shape-list__meta">{featureSummary(f, units)}</span>
                </button>
                {open === f.id ? <FeatureEditor model={model} feature={f} units={units} readOnly={readOnly} /> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="shape-hint">Nothing on {partName(part)} yet.</p>
        )}
        <div className="shape-feature-add">
          <Select<FeatureKind> size="sm" label="Add" value={kind} options={FEATURE_KINDS.map((k) => ({ value: k, label: FEATURE_NAMES[k] }))} onChange={setKind} hint={FEATURE_HINTS[kind]} />
          {kind === 'safety_eye' && audience === 'under3' ? (
            <Banner tone="warn" icon="warning">
              This toy is for a child under 3: embroider the eyes instead.
            </Banner>
          ) : null}
          <div className="shape-add-row">
            <Button size="sm" variant={placing ? 'primary' : 'secondary'} icon="cube" disabledReason={blocked ?? undefined} onClick={startPlacing}>
              {placing ? (isPath ? 'Drawing… Enter to finish' : 'Click on the model… (Esc)') : isPath ? 'Draw it on the model' : 'Place it on the model'}
            </Button>
            <Button size="sm" variant="ghost" icon="plus" disabledReason={blocked ?? undefined} onClick={addFront}>
              Add at the front
            </Button>
          </div>
        </div>
      </div>
    </Panel>
  );
}


function featureSummary(f: Feature, units: UnitPref): string {
  const where = Math.abs(f.azimuthDeg) < 3 ? 'middle' : `${Math.round(Math.abs(f.azimuthDeg))}° ${f.azimuthDeg > 0 ? 'left' : 'right'}`;
  const size = f.sizeMm !== undefined ? `${f.sizeMm} mm` : f.sizeIn !== undefined ? formatLength(f.sizeIn, units) : f.path ? `${f.path.length} points` : '';
  return [size, where, f.mirror ? 'pair' : ''].filter(Boolean).join(' · ');
}

function FeatureEditor({ model, feature: f, units, readOnly }: { model: CrochetModelV1; feature: Feature; units: UnitPref; readOnly: boolean }) {
  const key = (field: string) => `t6-feature-${f.id}-${field}`;
  const end = () => projectStore.getState().endCoalescing();
  const isPath = PATH_FEATURE_KINDS.includes(f.kind);
  return (
    <div className="shape-list__body">
      {f.kind === 'safety_eye' ? (
        <NumberField label="Eye size" size="sm" suffix="mm" value={f.sizeMm ?? 9} min={SAFETY_EYE_MM[0]} max={SAFETY_EYE_MM[1]} step={1} precision={0} disabled={readOnly} onChange={(v) => v !== null && changeFeature(f.id, { sizeMm: v })} hint="The pattern rounds it to a size you can buy." />
      ) : !isPath ? (
        <NumberField label="Size across" size="sm" kind="length" units={units} value={f.sizeIn ?? 0.3} min={0.05} max={10} disabled={readOnly} onChange={(v) => v !== null && changeFeature(f.id, { sizeIn: v })} />
      ) : null}
      {f.kind !== 'safety_eye' ? <ColorSelect model={model} label="Color" value={f.color} allowDefault="Default (dark yarn)" disabled={readOnly} onChange={(c) => changeFeature(f.id, { color: c || null })} /> : null}
      <Slider
        label="Around"
        value={Math.round(f.azimuthDeg)}
        min={-180}
        max={180}
        format={(v) => (v === 0 ? 'front' : `${Math.abs(v)}° to the ${v > 0 ? 'left' : 'right'}`)}
        disabled={readOnly}
        onChange={(v) => changeFeature(f.id, { azimuthDeg: v }, { coalesceKey: key('az') })}
        onCommit={end}
      />
      <Slider
        label="Up or down"
        value={Math.round(f.elevationDeg)}
        min={-90}
        max={90}
        format={(v) => (v === 0 ? 'middle' : `${Math.abs(v)}° ${v > 0 ? 'up' : 'down'}`)}
        disabled={readOnly}
        onChange={(v) => changeFeature(f.id, { elevationDeg: v }, { coalesceKey: key('el') })}
        onCommit={end}
      />
      <Switch label="Also on the other side" description="A matching one at the mirrored spot (a pair of eyes)." checked={!!f.mirror} disabled={readOnly} onChange={(on) => changeFeature(f.id, { mirror: on })} />
      <div className="shape-color-edit__row shape-color-edit__row--tools">
        <span className="shape-actions__spacer" />
        <Button size="sm" variant="ghost" icon="trash" disabledReason={readOnly ? READ_ONLY : undefined} onClick={() => deleteFeature(f.id)}>
          Remove
        </Button>
      </div>
    </div>
  );
}

// ---- photo colors

/** Session memory: the worker said it cannot apply photo colors yet. */
let photoColorsUnavailable = false;

function PhotoColorsPanel({ readOnly }: { readOnly: boolean }) {
  const doc = useProjectStore((s) => s.doc);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(photoColorsUnavailable);
  const views = labelledViews(doc);
  if (views.length === 0) return null;
  const blocked = photoColorsBlockedReason(doc, readOnly);
  const run = async () => {
    setBusy(true);
    try {
      const out = await applyPhotoColors();
      if (out.kind === 'unavailable') {
        photoColorsUnavailable = true;
        setUnavailable(true);
      } else if (out.kind === 'applied') {
        const skipped = out.skipped.length > 0 ? ` ${out.skipped.length === 1 ? 'One photo was' : `${out.skipped.length} photos were`} left out: the model does not line up with ${out.skipped.length === 1 ? 'it' : 'them'}.` : '';
        notify.success(`Applied the photos’ colors (revision ${out.rev}). Undo takes it back.${skipped}`);
      } else if (out.kind === 'failed') notify.error(`The photo colors could not be applied: ${out.message}`);
      else if (out.kind === 'blocked') notify.warn(out.reason);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Photo colors" icon="camera">
      <div className="shape-stack">
        <p className="shape-hint">
          Paints the model with the colors of your {views.length === 1 ? 'photo' : `${views.length} photos`}, as it is now. It replaces the brush strokes and is saved as a new revision.
        </p>
        {unavailable ? (
          <Banner tone="info" icon="info">
            Applying photo colors is not available in this version yet.
          </Banner>
        ) : null}
        <Button size="sm" icon="sparkles" loading={busy} disabledReason={unavailable ? 'Not available in this version yet' : (blocked ?? undefined)} onClick={() => void run()}>
          Apply photo colors
        </Button>
      </div>
    </Panel>
  );
}
