// Track T2.3 — §5.5.5: a settings change that moves the chart to another size while hand edits exist asks first:
// "N hand edits will move to the new size: Keep / Discard / Cancel". Keep moves them by relative position; the old
// edits stay in the history (Undo brings them back).
import { useRef } from 'react';
import { resolvePendingSize, useTwoDUi } from '../../state/slices/twoD';
import { Button, Dialog } from '../common';

export function SizeChangeDialog() {
  const pending = useTwoDUi((s) => s.pendingSize);
  const keepRef = useRef<HTMLButtonElement>(null);
  if (!pending) return null;
  const n = pending.count;
  return (
    <Dialog
      open
      onClose={() => resolvePendingSize('cancel')}
      title={`${n} hand ${n === 1 ? 'edit' : 'edits'} will move to the new size`}
      description={`The chart goes from ${pending.from.cols} × ${pending.from.rows} to ${pending.to.cols} × ${pending.to.rows} stitches.`}
      initialFocus={keepRef}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => resolvePendingSize('cancel')}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => resolvePendingSize('discard')}>
            Discard edits
          </Button>
          <Button variant="primary" ref={keepRef} onClick={() => resolvePendingSize('keep')}>
            Keep and move
          </Button>
        </>
      }
    >
      <p className="twod-dialog-text">
        Keep moves each painted or locked stitch to the same place in the new chart. Discard returns to the computed chart. Either way, Undo
        brings the old edits back.
      </p>
    </Dialog>
  );
}
