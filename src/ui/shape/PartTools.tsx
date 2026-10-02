// Track T6.2 — the inspector's part tools (DESIGN.md §4.2): Duplicate / Mirror / Delete for the selection, the
// mirror link of the part (Select twin, Unlink), and "How it's made": Make as (§2.10.1) and Start / axis / shaping
// (§2.10.2) — for a sculpted part, its start point picked on the model and the seam.
import { useState, type ReactNode } from 'react';
import {
  axisHonored,
  deleteBlockedReason,
  duplicateBlockedReason,
  mirrorBlockedReason,
  mirrorPair,
  partName,
  type MakeChoice,
} from '../../state/slices/model3d';
import type { CrochetModelV1, Part, PartCrochetHints } from '../../types/model';
import { Button, Icon, IconButton, SegmentedControl, Select, Slider, Tooltip } from '../common';
import { MOD } from '../shell/shortcuts';
import { editorStore, useEditorStore } from './editorStore';
import { duplicateSelection, mirrorSelection, requestDeleteSelection, setHints, unlinkPart } from './tools';

const READ_ONLY = 'This project is read-only';

/** The row of actions under the part's name. They act on the whole selection. */
export function PartActions({ model, part, readOnly }: { model: CrochetModelV1; part: Part; readOnly: boolean }) {
  const selection = useEditorStore((s) => s.selection);
  const ids = selection.length > 0 ? selection : [part.id];
  const dup = readOnly ? READ_ONLY : duplicateBlockedReason(model, ids);
  const del = readOnly ? READ_ONLY : deleteBlockedReason(model, ids);
  const mirrorReasons = ids.map((id) => mirrorBlockedReason(model, id));
  const mir = readOnly ? READ_ONLY : mirrorReasons.every((r) => r) ? mirrorReasons[0] : null;
  const linked = ids.every((id) => mirrorPair(model, id));
  return (
    <div className="shape-actions" role="group" aria-label="Part actions">
      <Shortcut keys={`${MOD}D`} what="Duplicate" off={!!dup}>
        <Button size="sm" icon="copy" disabledReason={dup ?? undefined} onClick={() => duplicateSelection()} aria-keyshortcuts="Meta+D Control+D">
          Duplicate
        </Button>
      </Shortcut>
      <Shortcut keys="M" what={linked ? 'Mirror again: copy this side onto its twin' : 'Mirror to the other side'} off={!!mir}>
        <Button size="sm" icon="mirror" disabledReason={mir ?? undefined} onClick={() => mirrorSelection()} aria-keyshortcuts="M">
          Mirror
        </Button>
      </Shortcut>
      <span className="shape-actions__spacer" />
      <IconButton
        icon="trash"
        size="sm"
        label={ids.length > 1 ? `Delete ${ids.length} parts` : 'Delete'}
        shortcut="⌫"
        className="shape-actions__delete"
        disabledReason={del ?? undefined}
        onClick={() => requestDeleteSelection()}
        aria-keyshortcuts="Delete Backspace"
      />
    </div>
  );
}

function Shortcut({ keys, what, off, children }: { keys: string; what: string; off: boolean; children: ReactNode }) {
  // A disabled Button shows its own tooltip (the reason); otherwise this one names the shortcut.
  if (off) return <span className="shape-actions__item">{children}</span>;
  return (
    <Tooltip content={what} shortcut={keys} describe={false}>
      <span className="shape-actions__item">{children}</span>
    </Tooltip>
  );
}

/** "Mirrored with Right Ear · Select · Unlink", when the part is mirror-linked. */
export function MirrorLink({ model, part, readOnly }: { model: CrochetModelV1; part: Part; readOnly: boolean }) {
  const pair = mirrorPair(model, part.id);
  if (!pair) return null;
  const other = pair.source.id === part.id ? pair.twin : pair.source;
  return (
    <div className="shape-mirror">
      <Icon name="link" size={16} className="shape-mirror__icon" />
      <p className="shape-mirror__text">
        Mirrored with{' '}
        <span className="shape-nowrap">
          <button type="button" className="shape-mirror__twin" onClick={() => editorStore.getState().select(other.id)} aria-label={`Mirrored with ${partName(other)}: select it`}>
            {partName(other)}
          </button>
          .
        </span>{' '}
        Changes to one are copied to the other.
      </p>
      <Button size="sm" variant="ghost" className="shape-mirror__unlink" disabledReason={readOnly ? READ_ONLY : undefined} onClick={() => unlinkPart(part.id)}>
        Unlink
      </Button>
    </div>
  );
}

const MAKE_OPTIONS: { value: MakeChoice; label: string; hint: string }[] = [
  { value: 'auto', label: 'Automatic (recommended)', hint: 'The pattern decides from its size and shape: eyes become safety eyes, tiny parts embroidery, thin parts appliqués.' },
  { value: 'piece', label: 'Crocheted piece', hint: 'Worked in rounds and stuffed (unless it is flat).' },
  { value: 'applique', label: 'Flat appliqué', hint: 'A flat piece crocheted separately and sewn on.' },
  { value: 'embroidery', label: 'Embroidered', hint: 'Stitched on with yarn or floss instead of crocheted.' },
  { value: 'safety_eye', label: 'Safety eye', hint: 'A plastic safety eye pushed through the fabric, sized from the part.' },
  { value: 'region', label: 'Color on its parent', hint: 'No separate piece: its color is worked into the part it sits on.' },
  { value: 'skip', label: 'Leave it out', hint: 'Not part of the pattern (a prop, or something you’ll add your own way).' },
];

/** "How it's made": Make as, and for crocheted pieces where round 1 starts, the axis and the shaping style. */
export function HowItsMade({ part, readOnly }: { part: Part; readOnly: boolean }) {
  const selection = useEditorStore((s) => s.selection);
  const ids = selection.includes(part.id) ? selection : [part.id];
  const c: PartCrochetHints = part.crochet ?? {};
  const make = c.make ?? 'auto';
  const name = partName(part);
  const many = ids.length > 1 ? ` (${ids.length} parts)` : '';
  const crocheted = make === 'auto' || make === 'piece';
  const isRoot = !part.attach;
  const disabled = readOnly;
  return (
    <div className="shape-make">
      <Select<MakeChoice>
        label="Make it as"
        value={make}
        disabled={disabled}
        options={MAKE_OPTIONS.map((o) => ({
          value: o.value,
          label: isRoot && (o.value === 'region' || o.value === 'applique') ? `${o.label} (not for the main piece)` : o.label,
          disabled: isRoot && (o.value === 'region' || o.value === 'applique') && o.value !== make,
        }))}
        onChange={(v) => setHints(ids, { make: v }, `Make ${ids.length > 1 ? `${ids.length} parts` : name} as ${MAKE_OPTIONS.find((o) => o.value === v)?.label.toLowerCase()}`)}
        hint={MAKE_OPTIONS.find((o) => o.value === make)?.hint}
      />
      {crocheted && part.type !== 'mesh' && part.type !== 'flat' && part.type !== 'torus' ? (
        <>
          <Hinted hint={c.start ? 'Round 1 starts at this end; the other end is where it closes or is sewn on.' : 'Auto: an attached part starts at its free tip, the main piece at its bottom.'}>
            <SegmentedControl<'auto' | 'bottom' | 'top'>
              label={`Round 1 starts at${many}`}
              size="sm"
              fullWidth
              disabled={disabled}
              value={c.start ?? 'auto'}
              onChange={(v) => setHints(ids, { start: v }, `Start of ${name}: ${v}`)}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'bottom', label: 'Bottom' },
                { value: 'top', label: 'Top' },
              ]}
            />
          </Hinted>
          {axisHonored(part.type) ? (
            <Hinted hint="Along the part’s own directions (as if it were not turned): X side to side, Y up and down, Z front to back.">
              <SegmentedControl<'auto' | 'x' | 'y' | 'z'>
                label="Rounds stack along"
                size="sm"
                disabled={disabled}
                value={c.axis ?? 'auto'}
                onChange={(v) => setHints(ids, { axis: v }, `Axis of ${name}: ${v}`)}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'x', label: 'X', tooltip: 'Side to side' },
                  { value: 'y', label: 'Y', tooltip: 'Up and down' },
                  { value: 'z', label: 'Z', tooltip: 'Front to back' },
                ]}
              />
            </Hinted>
          ) : (
            <p className="shape-hint">Its rounds stack along its own length.</p>
          )}
          <Hinted hint={c.style === 'exact' ? 'Follows the shape closely.' : c.style === 'classic' ? 'Textbook rounds: 6 in the ring, even increases.' : 'Uses the Pattern style of the whole toy (Yarn & size).'}>
            <SegmentedControl<'default' | 'classic' | 'exact'>
              label="Shaping"
              size="sm"
              fullWidth
              disabled={disabled}
              value={c.style ?? 'default'}
              onChange={(v) => setHints(ids, { style: v === 'default' ? null : v }, `Shaping of ${name}: ${v}`)}
              options={[
                { value: 'default', label: 'Toy’s style' },
                { value: 'classic', label: 'Classic' },
                { value: 'exact', label: 'Exact' },
              ]}
            />
          </Hinted>
        </>
      ) : null}
      {crocheted && part.type === 'mesh' ? <MeshStart key={part.crochet?.seamAzimuthDeg ?? 'auto'} part={part} readOnly={readOnly} /> : null}
    </div>
  );
}

function Hinted({ hint, children }: { hint: string; children: ReactNode }) {
  return (
    <div className="shape-make__field">
      {children}
      <p className="shape-hint">{hint}</p>
    </div>
  );
}

/** A sculpted part: "pick start point" on the surface, and where each round starts (the seam). */
function MeshStart({ part, readOnly }: { part: Part; readOnly: boolean }) {
  // Keyed by the stored seam (below), so an undo resets the slider.
  const [shown, setShown] = useState(part.crochet?.seamAzimuthDeg ?? 180);
  const picking = useEditorStore((s) => s.surfacePick?.kind === 'seed' && s.surfacePick.partId === part.id);
  const seed = part.crochet?.seed;
  const name = partName(part);
  return (
    <div className="shape-make__field">
      <div className="shape-make__row">
        <span className="shape-make__label">Round 1 starts</span>
        <span className="shape-muted">{seed ? 'at the point you picked' : 'where the pattern chooses'}</span>
      </div>
      <div className="shape-make__row">
        <Button
          size="sm"
          icon="pencil"
          disabledReason={readOnly ? READ_ONLY : undefined}
          onClick={() => editorStore.getState().setSurfacePick(picking ? null : { kind: 'seed', partId: part.id })}
          aria-pressed={picking}
        >
          {picking ? 'Click on the part… (Esc)' : 'Pick on the model'}
        </Button>
        {seed ? (
          <Button size="sm" variant="ghost" disabledReason={readOnly ? READ_ONLY : undefined} onClick={() => setHints([part.id], { seed: null }, `Start point of ${name}: automatic`)}>
            Automatic
          </Button>
        ) : null}
      </div>
      <Slider
        label="Seam (where each round begins)"
        value={shown}
        min={0}
        max={359}
        step={1}
        disabled={readOnly}
        format={(v) => `${Math.round(v)}°`}
        onChange={setShown}
        onCommit={(v) => setHints([part.id], { seamAzimuthDeg: v }, `Seam of ${name}`)}
        hint="Degrees around the part, 0° at the front; 180° is the back, where seams usually hide."
      />
    </div>
  );
}
