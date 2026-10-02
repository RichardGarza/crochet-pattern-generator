// Track T6.3 — the selected part's rounds from the live pattern loop (DESIGN.md §4.3): its badge (✓ / ⚠ n / ✕ n),
// what it is made as, and its rounds with their stitch counts. Hovering a round highlights its ring on the model and
// a hovered ring highlights its round here (the shared `LineRef` of §4.3, `editorStore.lineRef`).
import { useMemo } from 'react';
import { useDerivedStore } from '../../state/derivedStore';
import type { MakeAs } from '../../types/ami';
import type { CrochetModelV1, Part } from '../../types/model';
import { Badge, Icon, Panel, Spinner, cx } from '../common';
import { lineRefForRing, partStatuses, ringsForLineRef, roundsOf } from './amiView';
import { editorStore, useEditorStore } from './editorStore';
import { useLoopStatus } from './useLoopStatus';

const MAKE_NAMES: Record<MakeAs, string> = {
  piece: 'a crocheted piece',
  applique: 'a flat appliqué',
  embroidery: 'embroidery',
  safety_eye: 'a safety eye',
  region: 'color on its parent',
  skip: 'nothing (left out)',
};


export function RoundsPanel({ model, part }: { model: CrochetModelV1; part: Part }) {
  const result = useDerivedStore((s) => s.ami?.value ?? null);
  const status = useLoopStatus();
  const lineRef = useEditorStore((s) => s.lineRef);
  const statuses = useMemo(() => (result ? partStatuses(result) : null), [result]);
  const got = result ? roundsOf(result, model, part.id) : null;
  const highlighted = result ? ringsForLineRef(result.pattern, lineRef) : null;
  const make = result && Object.hasOwn(result.plan, part.id) ? result.plan[part.id] : undefined;
  const st = statuses?.get(part.id);

  let body;
  if (status.kind === 'unavailable') {
    body = <p className="shape-hint">The pattern engine is not part of this version yet. Once it is, each part’s rounds show here and as rings on the model.</p>;
  } else if (!result) {
    body =
      status.kind === 'running' ? (
        <p className="shape-hint shape-rounds__busy">
          <Spinner size={14} label="Working out the rounds" /> Working out the rounds…
        </p>
      ) : status.kind === 'error' ? (
        <p className="shape-hint">The pattern could not be made: {status.message}</p>
      ) : (
        <p className="shape-hint">The rounds appear here once the pattern is made.</p>
      );
  } else if (!got) {
    body = <p className="shape-hint">Made as {make ? MAKE_NAMES[make] : 'part of another piece'}: it has no rounds of its own.</p>;
  } else {
    const counts = got.rounds.counts;
    body = (
      <>
        <p className="shape-hint">
          {counts.length} rounds{got.mirrored ? ', the same as its twin' : ''}
          {got.rounds.path === 'B' ? ' (worked from the sculpted shape)' : ''}. Point at a round to find it on the model.
        </p>
        <ol className="shape-rounds" aria-label={`Rounds of ${part.label ?? part.id}`}>
          {counts.map((n, k) => {
            const on = !!highlighted && highlighted.partIds.includes(part.id) && k >= highlighted.from && k <= highlighted.to;
            const ref = lineRefForRing(result.pattern, part.id, k);
            return (
              <li
                key={k}
                className={cx('shape-rounds__item', on && 'shape-rounds__item--on')}
                tabIndex={0}
                onPointerEnter={() => editorStore.getState().setLineRef(ref)}
                onPointerLeave={() => editorStore.getState().setLineRef(null)}
                onFocus={() => editorStore.getState().setLineRef(ref)}
                onBlur={() => editorStore.getState().setLineRef(null)}
              >
                <span className="shape-rounds__n">Rnd {k + 1}</span>
                <span className="shape-rounds__count">{n}</span>
              </li>
            );
          })}
        </ol>
      </>
    );
  }
  return (
    <Panel title="Rounds" icon="list" actions={result && status.kind !== 'unavailable' ? <PartBadge errors={st?.errors ?? 0} warnings={st?.warnings ?? 0} stale={status.kind === 'running'} /> : null}>
      <div className="shape-stack">
        {st?.issues.slice(0, 3).map((i) => (
          <p key={i.code + i.message} className={cx('shape-issue', i.severity === 'error' && 'shape-issue--error')}>
            <Icon name={i.severity === 'error' ? 'error' : 'warning'} size={14} />
            <span>{i.message}</span>
          </p>
        ))}
        {body}
      </div>
    </Panel>
  );
}

/** ✓ / ⚠ n / ✕ n (§4.3). */
export function PartBadge({ errors, warnings, stale }: { errors: number; warnings: number; stale?: boolean }) {
  if (errors > 0)
    return (
      <Badge tone="danger" size="sm" icon="error">
        {errors}
        <span className="ui-visually-hidden"> {errors === 1 ? 'problem' : 'problems'}</span>
      </Badge>
    );
  if (warnings > 0)
    return (
      <Badge tone="warn" size="sm" icon="warning">
        {warnings}
        <span className="ui-visually-hidden"> {warnings === 1 ? 'warning' : 'warnings'}</span>
      </Badge>
    );
  return (
    <Badge tone={stale ? 'neutral' : 'success'} size="sm" icon="check">
      <span className="ui-visually-hidden">No problems</span>
    </Badge>
  );
}
