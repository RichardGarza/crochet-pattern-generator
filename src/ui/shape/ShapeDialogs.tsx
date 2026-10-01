// Track T6.2 — the Shape tab's dialogs (DESIGN.md §4.2): Add part (choose a shape, then click the spot on the model
// or pick a side of a part — the keyboard path), Attach (a new parent, the open end, the method; loops refused,
// no detach) and the Delete question ("delete asks"; children re-attach). Their open state lives in
// `editorStore`, so the toolbar, the inspector, the shortcuts and other tabs can open them.
import { useEffect, useId, useMemo, useState } from 'react';
import {
  ADDABLE_TYPES,
  addPartBlockedReason,
  attachBlockedReason,
  attachRootId,
  partName,
  type AddableType,
  type AttachMethod,
  type OpenEnd,
} from '../../state/slices/model3d';
import { useProjectStore } from '../../state/projectStore';
import type { CrochetModelV1, Vec3 } from '../../types/model';
import { Banner, Button, ConfirmDialog, Dialog, SegmentedControl, Select } from '../common';
import { TYPE_NAMES } from './dimSpecs';
import { editorStore, useEditorStore } from './editorStore';
import { ShapeGlyph } from './glyphs';
import { addPartAt, attachTo, deleteNow, deleteSummary, startPlacing } from './tools';

/** What each shape is good for, in crocheters' words. */
const SHAPE_USES: Record<AddableType, string> = {
  sphere: 'Heads, noses, pom-poms',
  ellipsoid: 'Snouts, ears, bodies',
  capsule: 'Arms, legs, tails',
  cylinder: 'Necks, stems, horns',
  cone: 'Beaks, horns, hats',
  torus: 'Rings, handles, collars',
  box: 'Blocky bodies, bricks',
  flat: 'Patches, ear linings, wings',
  lathe: 'Domes, hats, bells',
};

type Side = 'top' | 'front' | 'back' | 'left' | 'right' | 'bottom';

/** The toy's own sides (§0.1: front +Z, the toy's own left +X). */
const SIDES: Record<Side, Vec3> = {
  top: [0, 1, 0],
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [1, 0, 0],
  right: [-1, 0, 0],
  bottom: [0, -1, 0],
};

export function ShapeDialogs({ model }: { model: CrochetModelV1 }) {
  return (
    <>
      <AddPartDialog model={model} />
      <AttachDialog model={model} />
      <DeleteDialog model={model} />
    </>
  );
}

function AddPartDialog({ model }: { model: CrochetModelV1 }) {
  const open = useEditorStore((s) => s.addDialog);
  const selection = useEditorStore((s) => s.selection);
  const [type, setType] = useState<AddableType>('sphere');
  const [mode, setMode] = useState<'click' | 'side'>('click');
  const [parent, setParent] = useState<string>('');
  const [side, setSide] = useState<Side>('front');
  const groupName = useId();

  // Each time it opens: onto the selected part, else the main piece.
  useEffect(() => {
    if (!open) return;
    const primary = selection[selection.length - 1];
    setParent(primary && model.parts.some((p) => p.id === primary) ? primary : (attachRootId(model) ?? model.parts[0]?.id ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => editorStore.getState().setAddDialog(false);
  const blocked = addPartBlockedReason(model, mode === 'side' ? parent : model.parts[0]?.id);
  const name = TYPE_NAMES[type].toLowerCase();
  const go = () => {
    if (blocked) return;
    close();
    if (mode === 'click') startPlacing(type);
    else addPartAt(parent, type, { dir: SIDES[side] });
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      size="md"
      title="Add a part"
      description="Choose a shape. It is attached to the part you put it on and sits just inside its surface, ready to sew."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" icon={mode === 'click' ? 'arrow-right' : 'plus'} disabledReason={blocked ?? undefined} onClick={go}>
            {mode === 'click' ? 'Choose the spot' : `Add the ${name}`}
          </Button>
        </>
      }
    >
      <fieldset className="shape-add">
        <legend className="shape-add__legend">Shape</legend>
        <div className="shape-add__grid">
          {ADDABLE_TYPES.map((t) => (
            <label key={t} className={`shape-add__card${t === type ? ' shape-add__card--on' : ''}`}>
              <input type="radio" name={groupName} value={t} checked={t === type} onChange={() => setType(t)} className="shape-add__radio" />
              <ShapeGlyph type={t} />
              <span className="shape-add__name">{TYPE_NAMES[t]}</span>
              <span className="shape-add__use">{SHAPE_USES[t]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="shape-add__where">
        <SegmentedControl<'click' | 'side'>
          label="Where it goes"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'click', label: 'Click on the model' },
            { value: 'side', label: 'On a side of a part' },
          ]}
        />
        {mode === 'click' ? (
          <p className="shape-hint">After “Choose the spot”, click where the {name} should go. It hangs from the part you click. Esc cancels.</p>
        ) : (
          <div className="shape-add__side">
            <Select label="On" value={parent} onChange={setParent} options={model.parts.map((p) => ({ value: p.id, label: partName(p) }))} />
            <Select
              label="Side"
              value={side}
              onChange={setSide}
              options={[
                { value: 'top', label: 'Top' },
                { value: 'front', label: 'Front' },
                { value: 'back', label: 'Back' },
                { value: 'left', label: 'Left (the toy’s own left)' },
                { value: 'right', label: 'Right (the toy’s own right)' },
                { value: 'bottom', label: 'Bottom' },
              ]}
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}

const OPEN_END_LABEL: Record<OpenEnd | 'auto', string> = { auto: 'Auto', top: 'Top end', bottom: 'Bottom end', none: 'Neither' };

const METHOD_LABEL: Record<AttachMethod, string> = {
  sewn: 'Sewn on',
  'crochet-in-place': 'Crocheted in place',
  'worked-from': 'Worked from the parent',
  glued: 'Glued',
  none: 'Not fixed (loose)',
};

function AttachDialog({ model }: { model: CrochetModelV1 }) {
  const partId = useEditorStore((s) => s.attachFor);
  const readOnly = useProjectStore((s) => s.readOnly);
  const part = partId ? model.parts.find((p) => p.id === partId) : undefined;
  const [to, setTo] = useState('');
  const [openEnd, setOpenEnd] = useState<OpenEnd | 'auto'>('auto');
  const [method, setMethod] = useState<AttachMethod | 'default'>('default');
  useEffect(() => {
    if (!part) return;
    setTo(part.attach?.to ?? '');
    setOpenEnd(part.attach?.openEnd ?? 'auto');
    setMethod(part.attach?.method ?? 'default');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partId]);
  const options = useMemo(
    () =>
      part
        ? model.parts
            .filter((p) => p.id !== part.id)
            .map((p) => {
              const reason = attachBlockedReason(model, part.id, p.id);
              return { value: p.id, label: reason ? `${partName(p)} (hangs from ${partName(part)})` : partName(p), disabled: !!reason };
            })
        : [],
    [model, part],
  );
  const close = () => editorStore.getState().closeAttach();
  if (!part) return <Dialog open={false} onClose={close} title="Attach" />;
  const isRoot = !part.attach;
  const reason = isRoot ? null : to ? attachBlockedReason(model, part.id, to) : 'Choose a part';
  const save = () => {
    if (reason || isRoot) return;
    attachTo(part.id, to, { openEnd: openEnd === 'auto' ? null : openEnd, method: method === 'default' ? null : method });
    close();
  };
  return (
    <Dialog
      open
      onClose={close}
      size="sm"
      title={`Attach ${partName(part)}`}
      description={isRoot ? undefined : 'Which part it is sewn to, and how. Moving it on the model stays up to you.'}
      footer={
        isRoot ? (
          <Button variant="primary" onClick={close}>
            OK
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" disabledReason={readOnly ? 'This project is read-only' : (reason ?? undefined)} onClick={save}>
              Save
            </Button>
          </>
        )
      }
    >
      {isRoot ? (
        <Banner tone="info">{partName(part)} is the main piece: every other part hangs from it, so it is not attached to anything.</Banner>
      ) : (
        <div className="shape-attach">
          <Select label="Attached to" value={to} onChange={setTo} options={options} hint="Parts that hang from this one can’t be chosen: that would make a loop." />
          <div>
            <SegmentedControl<OpenEnd | 'auto'>
              label="Open end"
              size="sm"
              fullWidth
              value={openEnd}
              onChange={setOpenEnd}
              options={(['auto', 'top', 'bottom', 'none'] as const).map((v) => ({ value: v, label: OPEN_END_LABEL[v] }))}
            />
            <p className="shape-hint shape-attach__hint">
              {openEnd === 'auto'
                ? 'The pattern decides: usually the end tucked into the parent stays open.'
                : openEnd === 'none'
                  ? 'Both ends are closed; the piece is stuffed and sewn on whole.'
                  : `The ${openEnd} end stays open and is sewn on; the pattern starts at the other end.`}
            </p>
          </div>
          <Select<AttachMethod | 'default'>
            label="How it is attached"
            value={method}
            onChange={setMethod}
            options={[{ value: 'default', label: 'Sewn on (default)' }, ...(Object.keys(METHOD_LABEL) as AttachMethod[]).filter((m) => m !== 'sewn').map((m) => ({ value: m, label: METHOD_LABEL[m] }))]}
          />
        </div>
      )}
    </Dialog>
  );
}

function DeleteDialog({ model }: { model: CrochetModelV1 }) {
  const ids = useEditorStore((s) => s.deleteRequest);
  const [busy, setBusy] = useState(false);
  const parts = (ids ?? []).map((id) => model.parts.find((p) => p.id === id)).filter((p) => !!p);
  const title = parts.length === 1 ? `Delete ${partName(parts[0])}?` : `Delete ${parts.length} parts?`;
  const lines = ids ? deleteSummary(model, ids) : [];
  const cancel = () => editorStore.getState().requestDelete(null);
  return (
    <ConfirmDialog
      open={parts.length > 0}
      title={title}
      confirmLabel={busy ? 'Deleting…' : 'Delete'}
      tone="danger"
      onCancel={cancel}
      onConfirm={() => {
        if (!ids || busy) return;
        setBusy(true);
        void deleteNow(ids).finally(() => {
          setBusy(false);
          editorStore.getState().requestDelete(null);
        });
      }}
    >
      {parts.length > 1 ? <p className="shape-delete__list">{parts.map((p) => partName(p)).join(', ')}</p> : null}
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
      <p className="shape-hint">You can undo this, and the model as it was is kept as a revision.</p>
    </ConfirmDialog>
  );
}
