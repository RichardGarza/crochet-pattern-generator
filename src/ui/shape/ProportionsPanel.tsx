// Track T6.3 — the inspector's Proportions page (DESIGN.md §4.2 "Proportions", "Scale model to height"): the head :
// body slider (chibi 1 : 1 … realistic 1 : 3) and the limb-length chips, both through the Step 0 kernel
// `applyProportions` (the model keeps its height), showing the kernel's readings (`readProportions`) and its reasons
// when a control cannot work; one slider drag is ONE history step. Below: the toy's height and Scale to height.
import { useEffect, useMemo, useRef, useState } from 'react';
import { readProportions } from '../../core/model/proportions';
import { modelHeight } from '../../core/model/transforms';
import { beginModelGesture, editModel, proportionsBlockedReason, proportionsEdit, type ModelGesture } from '../../state/slices/model3d';
import type { LimbLength } from '../../types/entryPoints';
import type { CrochetModelV1 } from '../../types/model';
import type { UnitPref } from '../../types/units';
import { Banner, Button, Panel, SegmentedControl, Sidebar, Slider, formatLength, formatNumber } from '../common';
import { editorStore } from './editorStore';

const READ_ONLY = 'This project is read-only';

const LIMBS: { value: LimbLength; label: string; tooltip: string }[] = [
  { value: 'nubs', label: 'Nubs', tooltip: 'Tiny stubs (0.6 × the usual length)' },
  { value: 'short', label: 'Short', tooltip: 'The usual length for this kind of toy' },
  { value: 'medium', label: 'Medium', tooltip: '1.5 × the usual length' },
  { value: 'long', label: 'Long', tooltip: '2.2 × the usual length: dangly' },
];

/** The kernel's reason as a sentence. */
function sentence(reason: string): string {
  const t = reason.trim();
  return t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}` : t;
}

export function ProportionsPanel({ model, units, readOnly }: { model: CrochetModelV1; units: UnitPref; readOnly: boolean }) {
  const reading = useMemo(() => readProportions(model), [model]);
  const modelBlocked = proportionsBlockedReason(model);
  const [drag, setDrag] = useState<number | null>(null);
  const gesture = useRef<ModelGesture | null>(null);
  useEffect(
    () => () => {
      gesture.current?.end();
      gesture.current = null;
    },
    [],
  );
  const headReason = readOnly ? READ_ONLY : (modelBlocked ?? (reading.disabled.headBody ? sentence(reading.disabled.headBody) : null));
  const limbReason = readOnly ? READ_ONLY : (modelBlocked ?? (reading.disabled.limbs ? sentence(reading.disabled.limbs) : null));
  const b = drag ?? reading.headBody ?? 1.3;
  const shown = Math.min(3, Math.max(1, b));

  const onDrag = (v: number) => {
    setDrag(v);
    gesture.current ??= beginModelGesture('Head : body', { linked: false });
    gesture.current?.update(proportionsEdit({ headBody: v }));
  };
  const onCommit = () => {
    gesture.current?.end();
    gesture.current = null;
    setDrag(null);
  };
  const height = modelHeight(model);

  return (
    <Sidebar>
      <Panel title="Proportions" icon="sliders">
        <div className="shape-stack">
          <p className="shape-hint">Change the look without changing the toy’s height: everything is rescaled to stay {formatLength(height, units)} tall.</p>
          <Slider
            label="Head : body"
            value={shown}
            min={1}
            max={3}
            step={0.05}
            format={(v) => `1 : ${formatNumber(v, 2)}`}
            endLabels={['Chibi 1 : 1', 'Realistic 1 : 3']}
            disabled={!!headReason}
            onChange={onDrag}
            onCommit={onCommit}
            hint={
              headReason && !readOnly
                ? headReason
                : reading.headBody !== undefined && (reading.headBody < 1 || reading.headBody > 3)
                  ? `Now 1 : ${formatNumber(reading.headBody, 2)}, outside the slider’s range.`
                  : 'The body (and everything below the head) is this many head-heights.'
            }
          />
          <div>
            <SegmentedControl<LimbLength>
              label="Arms and legs"
              size="sm"
              fullWidth
              value={reading.limbs ?? 'short'}
              disabled={!!limbReason}
              onChange={(limbs) => editModel(`Limbs: ${limbs}`, proportionsEdit({ limbs }), { linked: false })}
              options={LIMBS.map((l) => ({ ...l, ariaLabel: l.label }))}
            />
            <p className="shape-hint shape-proportions__hint">
              {limbReason && !readOnly
                ? limbReason
                : reading.limbs
                  ? `Now closest to “${LIMBS.find((l) => l.value === reading.limbs)!.label.toLowerCase()}”. The ends sewn to the body stay put.`
                  : 'Arm and leg length.'}
            </p>
          </div>
          {modelBlocked && !readOnly ? (
            <Banner tone="info" icon="info">
              {modelBlocked}
            </Banner>
          ) : null}
        </div>
      </Panel>
      <Panel title="Height" icon="ruler">
        <div className="shape-stack">
          <p className="shape-height">
            About <strong>{formatLength(height, units)}</strong> tall
          </p>
          <Button size="sm" icon="ruler" disabledReason={readOnly ? READ_ONLY : undefined} onClick={() => editorStore.getState().setScaleDialog(true)}>
            Scale to a height…
          </Button>
          <p className="shape-hint">Makes every part bigger or smaller together. The yarn and hook are in Yarn &amp; size.</p>
        </div>
      </Panel>
    </Sidebar>
  );
}
