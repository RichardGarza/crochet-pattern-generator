// Track T6 — the Shape tab's inspector (DESIGN.md §4.1, §4.2 "Parameters"): the selected part's size fields
// (number + slider; a slider drag is ONE undo step), its position and rotation (attached parts follow, like the
// gizmo), and its base color. Every change goes through `state/slices/model3d.ts`; size edits re-anchor the
// part's children on its new surface (§4.2).
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  beginResizeGesture,
  editModel,
  partName,
  setPartColor,
  setPartDim,
  setPartDims,
  setPartPosition,
  setPartRotation,
  type ResizeGesture,
} from '../../state/slices/model3d';
import { MODEL_LIMITS } from '../../core/model/limits';
import type { Issue } from '../../types/issues';
import type { CrochetModelV1, Part, Vec3 } from '../../types/model';
import type { UnitPref } from '../../types/units';
import { Badge, Banner, Button, EmptyState, IconButton, Kbd, NumberField, Panel, Select, Sidebar, Slider, formatLength } from '../common';
import { dimSpecs, dimValue, prettyName, TYPE_NAMES, type DimSpec } from './dimSpecs';
import { editorStore, transformScope, useEditorStore } from './editorStore';

export interface InspectorProps {
  model: CrochetModelV1;
  units: UnitPref;
  issues: readonly Issue[];
  readOnly: boolean;
}

export function Inspector({ model, units, issues, readOnly }: InspectorProps) {
  const selection = useEditorStore((s) => s.selection);
  const primaryId = selection[selection.length - 1];
  const part = primaryId ? model.parts.find((p) => p.id === primaryId) : undefined;
  if (!part) {
    return (
      <Sidebar>
        <Panel title="Inspector" icon="sliders">
          <EmptyState icon="cube" title="Nothing selected" size="sm" level={4}>
            <p>Click a part in the view or in the Parts list to change its size, position and color.</p>
          </EmptyState>
          <ShortcutList />
        </Panel>
      </Sidebar>
    );
  }
  return <PartInspector key={part.id} model={model} part={part} units={units} issues={issues} readOnly={readOnly} others={selection.length - 1} />;
}

function ShortcutList() {
  const rows: [string, string][] = [
    ['Q', 'Select'],
    ['W', 'Move'],
    ['E', 'Rotate'],
    ['R', 'Resize'],
    ['F', 'Frame the selection'],
    ['Esc', 'Clear the selection'],
  ];
  return (
    <div className="shape-shortcuts">
      <h4 className="shape-shortcuts__title">Keys</h4>
      <dl>
        {rows.map(([k, what]) => (
          <div key={k} className="shape-shortcuts__row">
            <dt>
              <Kbd>{k}</Kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
        <div className="shape-shortcuts__row">
          <dt>
            <Kbd>⌥</Kbd>
          </dt>
          <dd>Hold while dragging to move a part without the parts attached to it</dd>
        </div>
        <div className="shape-shortcuts__row">
          <dt>
            <Kbd>⇧</Kbd>
          </dt>
          <dd>Hold while dragging to turn snapping off; ⇧-click adds to the selection</dd>
        </div>
      </dl>
    </div>
  );
}

function PartInspector({ model, part, units, issues, readOnly, others }: { model: CrochetModelV1; part: Part; units: UnitPref; issues: readonly Issue[]; readOnly: boolean; others: number }) {
  const name = partName(part);
  const parent = part.attach?.to ? model.parts.find((p) => p.id === part.attach?.to) : undefined;
  const childCount = model.parts.filter((p) => p.attach?.to === part.id).length;
  const followAttached = useEditorStore((s) => s.followAttached);
  const scope = transformScope(followAttached, false);
  const partIssues = issues.filter((i) => i.where?.part === part.id);
  const swatch = model.palette.find((c) => c.id === part.color)?.hex;

  return (
    <Sidebar>
      <section className="shape-inspector-head" aria-label="Selected part">
        <div className="shape-inspector-head__row">
          <span className="shape-swatch shape-swatch--lg" style={{ background: swatch ?? 'transparent' }} aria-hidden="true" />
          <div className="shape-inspector-head__text">
            <h2 className="shape-inspector-head__title">{name}</h2>
            <p className="shape-inspector-head__meta">
              {TYPE_NAMES[part.type]} · <code>{part.id}</code>
            </p>
          </div>
        </div>
        {others > 0 ? (
          <p className="shape-inspector-head__note">
            <Badge tone="info" size="sm" icon="layers">
              {others + 1} selected
            </Badge>{' '}
            Editing {name}, the last one you picked.
          </p>
        ) : null}
        <dl className="shape-inspector-head__facts">
          <div>
            <dt>Attached to</dt>
            <dd>
              {parent ? (
                <Button size="sm" variant="ghost" onClick={() => editorStore.getState().select(parent.id)} aria-label={`Attached to ${partName(parent)}: select it`}>
                  {partName(parent)}
                </Button>
              ) : (
                <span className="shape-muted">Nothing: this is the main piece</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Carries</dt>
            <dd>{childCount === 0 ? <span className="shape-muted">No attached parts</span> : `${childCount} attached ${childCount === 1 ? 'part' : 'parts'}`}</dd>
          </div>
        </dl>
        {partIssues.map((issue) => (
          <Banner key={issue.code + issue.message} tone="warn" icon="warning">
            {issue.message}
          </Banner>
        ))}
      </section>

      <Panel title="Size" icon="ruler">
        <SizeFields model={model} part={part} units={units} readOnly={readOnly} />
      </Panel>

      <Panel title="Position" icon="arrow-right">
        <TransformFields part={part} units={units} readOnly={readOnly} scope={scope} childCount={childCount} />
      </Panel>

      <Panel title="Color" icon="palette">
        <Select
          label="Base color"
          value={part.color}
          disabled={readOnly}
          options={model.palette.map((c) => ({ value: c.id, label: c.name ? prettyName(c.name) : c.id }))}
          onChange={(color) => editModel(`Color ${name}`, (m) => setPartColor(m, part.id, color))}
          hint="Stripes, spots and painting come with the Paint tool."
        />
      </Panel>
    </Sidebar>
  );
}


// ---- size

function SizeFields({ model, part, units, readOnly }: { model: CrochetModelV1; part: Part; units: UnitPref; readOnly: boolean }) {
  if (part.type === 'mesh') {
    const [x, y, z] = part.dims.bboxIn;
    return (
      <p className="shape-muted">
        A sculpted part, {formatLength(x, units)} × {formatLength(y, units)} × {formatLength(z, units)}. Resizing sculpted parts comes with the sculpt
        tools.
      </p>
    );
  }
  if (part.type === 'lathe') return <ProfileFields part={part} units={units} readOnly={readOnly} />;
  return (
    <div className="shape-dims">
      {part.type === 'flat' ? <FlatShapeField part={part} readOnly={readOnly} /> : null}
      {dimSpecs(part.type).map((spec) => (
        <DimRow key={spec.key} model={model} part={part} spec={spec} units={units} readOnly={readOnly} />
      ))}
      <p className="shape-hint">Attached parts stay on the surface as you resize.</p>
    </div>
  );
}

const FLAT_SHAPES = ['circle', 'oval', 'teardrop', 'triangle', 'rect'] as const;

function FlatShapeField({ part, readOnly }: { part: Extract<Part, { type: 'flat' }>; readOnly: boolean }) {
  type Shape = Extract<Part, { type: 'flat' }>['dims']['shape'];
  const shapes: Shape[] = [...FLAT_SHAPES];
  if (!shapes.includes(part.dims.shape)) shapes.push(part.dims.shape);
  return (
    <Select
      label="Shape"
      value={part.dims.shape}
      disabled={readOnly}
      options={shapes.map((s) => ({ value: s, label: prettyName(s === 'rect' ? 'rectangle' : s) }))}
      onChange={(shape) =>
        editModel(`Shape of ${partName(part)}`, (m) => setPartDims(m, part.id, { ...part.dims, shape }))
      }
    />
  );
}

/** The slider's range: from the smallest size to twice the size the part had when it was selected (at least 2 in). */
function sliderMax(spec: DimSpec, value: number): number {
  if (spec.kind === 'angle') return 360;
  return Math.min(MODEL_LIMITS.maxDimIn * spec.factor, Math.max(2, Math.ceil(value * 2 * 4) / 4));
}

function DimRow({ part, spec, units, readOnly }: { model: CrochetModelV1; part: Part; spec: DimSpec; units: UnitPref; readOnly: boolean }) {
  const value = dimValue(part, spec) ?? 0;
  const gesture = useRef<ResizeGesture | null>(null);
  // The range is fixed while this part stays selected, so a drag never moves the slider under the pointer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const max = useMemo(() => sliderMax(spec, value), [part.id, spec.key]);
  useEffect(() => () => gesture.current?.end(), []);
  const name = partName(part);
  const label = `Resize ${name}`;
  const toStored = (shown: number) => shown / spec.factor;
  const commitSingle = (shown: number | null) => {
    if (shown === null) return;
    editModel(label, (m) => setPartDim(m, part.id, spec.key, toStored(shown)));
  };
  const min = spec.kind === 'angle' ? 1 : MODEL_LIMITS.minDimIn * spec.factor;
  const shownMax = spec.kind === 'angle' ? 360 : MODEL_LIMITS.maxDimIn * spec.factor;
  const format = (v: number) => (spec.kind === 'angle' ? `${Math.round(v)}°` : formatLength(v, units));
  return (
    <div className="shape-dim">
      <div className="shape-dim__label" aria-hidden="true">
        <span>{spec.label}</span>
        {spec.hint ? <span className="shape-dim__hint">{spec.hint}</span> : null}
      </div>
      <div className="shape-dim__controls">
        <Slider
          label={spec.label}
          labelHidden
          value={Math.min(Math.max(value, min), Math.max(max, value))}
          min={min}
          max={Math.max(max, value)}
          step={spec.kind === 'angle' ? 1 : 0.01}
          format={format}
          disabled={readOnly}
          onChange={(shown) => {
            if (!gesture.current) gesture.current = beginResizeGesture(label);
            gesture.current?.update(part.id, (m, o) => setPartDim(m, part.id, spec.key, toStored(shown), o));
          }}
          onCommit={() => {
            gesture.current?.end();
            gesture.current = null;
          }}
        />
        <NumberField
          label={spec.label}
          labelHidden
          size="sm"
          kind={spec.kind === 'length' ? 'length' : 'number'}
          suffix={spec.kind === 'angle' ? '°' : undefined}
          units={units}
          value={value}
          min={min}
          max={shownMax}
          step={spec.kind === 'angle' ? 5 : undefined}
          precision={spec.kind === 'angle' ? 0 : undefined}
          disabled={readOnly}
          onChange={commitSingle}
        />
      </div>
    </div>
  );
}

function ProfileFields({ part, units, readOnly }: { part: Extract<Part, { type: 'lathe' }>; units: UnitPref; readOnly: boolean }) {
  const name = partName(part);
  const profile = part.dims.profile;
  const write = (label: string, next: [number, number][], sharp = part.dims.sharp) => {
    const dims: Extract<Part, { type: 'lathe' }>['dims'] = { ...part.dims, profile: next };
    if (sharp && sharp.length > 0) dims.sharp = sharp;
    else delete dims.sharp;
    editModel(label, (m) => setPartDims(m, part.id, dims));
  };
  const setPoint = (i: number, k: 0 | 1, v: number | null) => {
    if (v === null) return;
    const next = profile.map((p, j): [number, number] => (j === i ? (k === 0 ? [v, p[1]] : [p[0], v]) : p));
    write(`Reshape ${name}`, next);
  };
  const remove = (i: number) => {
    const next = profile.filter((_, j) => j !== i);
    const sharp = part.dims.sharp?.filter((s) => s !== i).map((s) => (s > i ? s - 1 : s));
    write(`Reshape ${name}`, next, sharp);
  };
  const add = () => {
    const last = profile[profile.length - 1];
    const prev = profile[profile.length - 2] ?? last;
    const step = Math.max(0.25, last[1] - prev[1]);
    write(`Reshape ${name}`, [...profile, [Math.max(0, last[0] * 0.8), last[1] + step]]);
  };
  return (
    <div className="shape-profile">
      <p className="shape-hint">The outline turned around the part's axis, from the bottom up: each point is a radius at a height.</p>
      <table className="shape-profile__table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Radius</th>
            <th scope="col">Height</th>
            <th scope="col">
              <span className="ui-visually-hidden">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {profile.map(([r, y], i) => (
            <tr key={`${profile.length}:${i}`}>
              <th scope="row">{i + 1}</th>
              <td>
                <NumberField label={`Point ${i + 1} radius`} labelHidden size="sm" kind="length" units={units} value={r} min={0} max={MODEL_LIMITS.maxDimIn} disabled={readOnly} onChange={(v) => setPoint(i, 0, v)} />
              </td>
              <td>
                <NumberField
                  label={`Point ${i + 1} height`}
                  labelHidden
                  size="sm"
                  kind="length"
                  units={units}
                  value={y}
                  min={i > 0 ? profile[i - 1][1] : -MODEL_LIMITS.maxDimIn}
                  max={i < profile.length - 1 ? profile[i + 1][1] : MODEL_LIMITS.maxDimIn}
                  disabled={readOnly}
                  onChange={(v) => setPoint(i, 1, v)}
                />
              </td>
              <td>
                <IconButton
                  icon="x"
                  size="sm"
                  label={`Remove point ${i + 1}`}
                  disabledReason={readOnly ? 'This project is read-only' : profile.length <= MODEL_LIMITS.minProfilePoints ? `A turned shape needs at least ${MODEL_LIMITS.minProfilePoints} points` : undefined}
                  onClick={() => remove(i)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Button
        size="sm"
        icon="plus"
        disabledReason={readOnly ? 'This project is read-only' : profile.length >= MODEL_LIMITS.maxProfilePoints ? `At most ${MODEL_LIMITS.maxProfilePoints} points` : undefined}
        onClick={add}
      >
        Add a point on top
      </Button>
    </div>
  );
}

// ---- position and rotation

const AXES = ['X', 'Y', 'Z'] as const;
const AXIS_HINTS = ['left to right', 'down to up', 'back to front'];

function TransformFields({ part, units, readOnly, scope, childCount }: { part: Part; units: UnitPref; readOnly: boolean; scope: 'subtree' | 'alone'; childCount: number }) {
  const name = partName(part);
  const rotation: Vec3 = part.rotationDeg ?? [0, 0, 0];
  const setAxis = (which: 'position' | 'rotation', axis: number, v: number | null) => {
    if (v === null) return;
    if (which === 'position') {
      const next: Vec3 = [...part.position];
      next[axis] = v;
      editModel(`Move ${name}`, (m) => setPartPosition(m, part.id, next, scope));
    } else {
      const next: Vec3 = [...rotation];
      next[axis] = v;
      editModel(`Rotate ${name}`, (m) => setPartRotation(m, part.id, next, scope));
    }
  };
  return (
    <div className="shape-transform">
      <Axes legend="Position" hint={part.type === 'lathe' ? 'Where its base sits on the axis.' : 'Where its center sits.'}>
        {AXES.map((a, i) => (
          <NumberField
            key={a}
            label={
              <>
                {a}
                <span className="ui-visually-hidden">{` ${AXIS_HINTS[i]}`}</span>
              </>
            }
            size="sm"
            kind="length"
            units={units}
            value={part.position[i]}
            min={-MODEL_LIMITS.maxHeightIn}
            max={MODEL_LIMITS.maxHeightIn}
            disabled={readOnly}
            onChange={(v) => setAxis('position', i, v)}
          />
        ))}
      </Axes>
      <Axes legend="Rotation" hint="Turns about its center.">
        {AXES.map((a, i) => (
          <NumberField
            key={a}
            label={
              <>
                {a}
                <span className="ui-visually-hidden"> turn</span>
              </>
            }
            size="sm"
            suffix="°"
            step={5}
            precision={1}
            min={-360}
            max={360}
            value={rotation[i]}
            disabled={readOnly}
            onChange={(v) => setAxis('rotation', i, v)}
          />
        ))}
      </Axes>
      <p className="shape-hint">
        {childCount === 0
          ? 'Nothing is attached to this part.'
          : scope === 'subtree'
            ? childCount === 1
              ? 'The part attached to it moves along.'
              : `The ${childCount} parts attached to it move along.`
            : 'Attached parts stay where they are (follow is off).'}
      </p>
    </div>
  );
}

function Axes({ legend, hint, children }: { legend: string; hint: string; children: ReactNode }) {
  return (
    <fieldset className="shape-axes">
      <legend className="shape-axes__legend">
        {legend} <span className="shape-dim__hint">{hint}</span>
      </legend>
      <div className="shape-axes__fields">{children}</div>
    </fieldset>
  );
}
