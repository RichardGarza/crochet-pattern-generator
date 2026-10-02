// Track T7.4 — the import screen (DESIGN.md F4 steps 4–6, §3.7, §3.7.7, §5.7): drop a file or paste text; see what
// was read (carrier, dialect, confidence), every automatic fix as a chip, the units question, the versions picker,
// the changes against the current model; Accept (one undo step, with the paint carry rule and "Carry anyway"); then
// the Yarn & size panel. Used by the Import tab and by the Q&A wizard's import step.
//
// Start → "Import from Claude Design" creates a new project and lands here; when the result belongs to another
// project (its `x-cpg` tag, or the only project waiting for Claude Design), the report offers "Import into
// <project>" and moves the import there (§3.7.7).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { navigate } from '../../app/router';
import { notify } from '../../app/toasts';
import { diffModels } from '../../core/importer/diff';
import { matchReturnProject, type ReturnOffer } from '../../core/importer/returnPath';
import { useAppStore } from '../../state/appStore';
import { useProjectStore } from '../../state/projectStore';
import type { ImportResult } from '../../types/importer';
import type { CrochetModelV1 } from '../../types/model';
import type { ImportRecord, ProjectDoc } from '../../types/project';
import type { UnitPref } from '../../types/units';
import { Badge, Banner, Button, Chip, ConfirmDialog, Dialog, DropZone, Icon, Spinner, Switch, TextField } from '../common';
import { createProject } from '../shell/projectSession';
import { formatRelativeTime } from '../shell/relativeTime';
import { YarnSizePanel } from '../shape/YarnSizePanel';
import {
  acceptPending,
  clearImport,
  diffBaseFor,
  expectedHeightFor,
  importFiles,
  importText,
  keepUnits,
  moveImport,
  rerunImport,
  setCarryAnyway,
  usePendingImport,
  type PendingImport,
} from './importSession';
import { IMPORT_ACCEPT, isFreshImportProject, openJoin } from './actions';
import { ModelPreview } from './ModelPreview';
import {
  carrierText,
  confidenceCopy,
  describeDiff,
  describeFailure,
  describeFixes,
  describeNotes,
  dialectText,
  nameList,
  partDisplayName,
  summarizeModel,
  unitsOptions,
  unitsQuestion,
  versionOptions,
  type FailureCopy,
  type FixChip,
} from './present';
import { candidatesFromLibrary, withDetails } from './returnCandidates';
import './import.css';

const READ_ONLY = 'This project is read-only';

export interface ImportViewProps {
  /** The wizard's import step words its heading differently. */
  variant?: 'tab' | 'wizard';
}

export function ImportView({ variant = 'tab' }: ImportViewProps) {
  const doc = useProjectStore((s) => s.doc);
  const pending = usePendingImport(doc?.id);
  if (!doc) return null;
  if (doc.mode !== '3d' || !doc.threeD) {
    return (
      <div className="imp-page">
        <Banner tone="info">Claude Design results and 3D models go into 3D projects.</Banner>
      </div>
    );
  }
  if (!pending) return <Intake doc={doc} variant={variant} />;
  switch (pending.phase) {
    case 'reading':
      // a re-run (the units answer, another version) keeps the report on screen while it reads again
      return pending.result?.ok ? <Report doc={doc} pending={pending} result={pending.result} /> : <Reading pending={pending} />;
    case 'failed':
      return <Failure doc={doc} pending={pending} />;
    case 'accepted':
      return <Accepted doc={doc} pending={pending} />;
    default:
      return pending.result?.ok ? <Report doc={doc} pending={pending} result={pending.result} /> : <Failure doc={doc} pending={pending} />;
  }
}

// ---- intake: drop or paste

function Intake({ doc, variant }: { doc: ProjectDoc; variant: 'tab' | 'wizard' }) {
  const readOnly = useProjectStore((s) => s.readOnly);
  const [text, setText] = useState('');
  const last = doc.imports.at(-1);
  const awaiting = !!doc.qa?.awaiting;
  const expected = expectedHeightFor(doc);
  const start = (files: File[]) => void importFiles(doc.id, files, expected !== undefined ? { expectedHeightIn: expected } : {});
  const paste = () => {
    if (text.trim()) void importText(doc.id, text, expected !== undefined ? { expectedHeightIn: expected } : {});
  };
  const title = variant === 'wizard' ? 'Bring back your Claude Design result' : last ? 'Import a newer version' : 'Bring in your Claude Design toy';
  const lead = awaiting
    ? 'When Claude has finished your toy, export it from Claude Design (Share → Export → Project HTML → Project archive) and drop the .zip here — or copy Claude’s last reply and paste it below.'
    : 'Drop the project archive you exported from Claude Design, a 3D model file, or paste Claude’s reply. We check it, fix what we can and show you what changed before anything is replaced.';
  return (
    <div className="imp-page">
      <div className="imp-intake">
        <header className="imp-head">
          <span className="imp-head__tile" aria-hidden="true">
            <Icon name="import" size={24} />
          </span>
          <div>
            <h2 className="imp-head__title">{title}</h2>
            <p className="imp-head__lead">{lead}</p>
          </div>
        </header>
        {readOnly ? (
          <Banner tone="neutral" icon="lock">
            This project is open read-only here, so nothing can be imported into it.
          </Banner>
        ) : null}
        <DropZone
          multiple
          size="lg"
          accept={IMPORT_ACCEPT}
          disabled={readOnly}
          title="Drop your Claude Design export or 3D model here"
          hint=".zip · .html · .glb · .gltf · .obj with its .mtl · .ply · .stl · .json · .tar.gz"
          buttonLabel="Choose files"
          onFiles={start}
          onReject={(files) => notify.warn(`${nameList(files.map((f) => f.name))} ${files.length === 1 ? 'isn’t a file' : 'aren’t files'} we can import. Drop a Claude Design export or a 3D model.`)}
        />
        <div className="imp-paste">
          <TextField
            label="Or paste Claude’s reply"
            hint="Paste the whole reply, or just the code block with the model. Press ⌘ Enter to import."
            multiline
            rows={4}
            value={text}
            disabled={readOnly}
            onChange={setText}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                paste();
              }
            }}
          />
          <div className="imp-paste__actions">
            <Button icon="import" disabledReason={readOnly ? READ_ONLY : !text.trim() ? 'Paste some text first' : undefined} onClick={paste}>
              Import pasted text
            </Button>
          </div>
        </div>
        {last ? <LastImport doc={doc} record={last} /> : null}
      </div>
    </div>
  );
}

function LastImport({ doc, record }: { doc: ProjectDoc; record: ImportRecord }) {
  const [now] = useState(() => new Date());
  const model = doc.threeD?.model;
  const joins = record.repairs.filter((r) => r.code === 'attach-inferred');
  const fixes = useMemo(() => describeFixes({ repairs: joins, model }, doc.units), [joins, model, doc.units]);
  const live = fixes.chips.filter((c) => c.part && model?.parts.some((p) => p.id === c.part));
  return (
    <section className="imp-card imp-last" aria-labelledby="imp-last-title">
      <h3 id="imp-last-title" className="imp-card__title">
        Last import
      </h3>
      <p className="imp-muted">
        {record.fileName} · {carrierText(record.carrier as ImportResult['carrier'])} · {formatRelativeTime(record.at, now)}
      </p>
      {live.length > 0 ? (
        <>
          <p className="imp-card__text">We joined these parts ourselves. Check them in the Attach tool:</p>
          <JoinChips projectId={doc.id} chips={live} />
        </>
      ) : null}
    </section>
  );
}

// ---- reading

function Reading({ pending }: { pending: PendingImport }) {
  return (
    <div className="imp-page">
      <div className="imp-reading" role="status">
        <Spinner size={28} />
        <p className="imp-reading__title">Reading {pending.original.name || 'your file'}…</p>
        <p className="imp-muted">Looking for the model, checking every part and fixing what we can.</p>
      </div>
    </div>
  );
}

// ---- failure

function failureFor(pending: PendingImport): FailureCopy {
  if (pending.error?.startsWith('too-large:')) {
    return { title: 'This file is too big', body: `${pending.error.slice('too-large:'.length)} is over 100 MB. Claude Design exports are much smaller: try the project archive (.zip) instead.`, tips: [], details: [], pictures: false };
  }
  if (pending.error) {
    return { title: 'Something went wrong while reading this', body: 'Nothing was changed in your project. Try again, or try another file.', tips: [], details: [pending.error], pictures: false };
  }
  return describeFailure(pending.result ?? { warnings: [], carrier: 'text' });
}

function Failure({ doc, pending }: { doc: ProjectDoc; pending: PendingImport }) {
  const copy = failureFor(pending);
  const heading = useFocusOnMount<HTMLHeadingElement>(pending.run);
  return (
    <div className="imp-page">
      <section className="imp-failure" aria-labelledby="imp-failure-title">
        <span className="imp-failure__icon" aria-hidden="true">
          <Icon name="warning" size={26} />
        </span>
        <h2 id="imp-failure-title" className="imp-failure__title" ref={heading} tabIndex={-1}>
          {copy.title}
        </h2>
        <p className="imp-failure__body">{copy.body}</p>
        {copy.tips.length > 0 ? (
          <>
            <h3 className="imp-failure__sub">Try this</h3>
            <ul className="imp-tips">
              {copy.tips.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </>
        ) : null}
        {copy.details.length > 0 ? (
          <details className="imp-details">
            <summary>Details</summary>
            <ul>
              {copy.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <div className="imp-failure__actions">
          {copy.pictures ? (
            <Button
              icon="camera"
              onClick={() => {
                void createProject('one-photo').then((p) => navigate({ screen: 'project', projectId: p.id }));
              }}
            >
              Start a toy from one photo
            </Button>
          ) : null}
          <Button variant="primary" icon="refresh" onClick={() => clearImport(doc.id)}>
            {pending.inputs[0]?.kind === 'text' ? 'Try again' : 'Try another file'}
          </Button>
        </div>
      </section>
    </div>
  );
}

// ---- the report

function useFocusOnMount<T extends HTMLElement>(key: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: false });
  }, [key]);
  return ref;
}

function Report({ doc, pending, result }: { doc: ProjectDoc; pending: PendingImport; result: ImportResult }) {
  const readOnly = useProjectStore((s) => s.readOnly);
  const library = useAppStore((s) => s.library);
  const model = result.model as CrochetModelV1;
  const units: UnitPref = doc.units;
  const heading = useFocusOnMount<HTMLHeadingElement>(result);
  const fixes = useMemo(() => describeFixes(result, units), [result, units]);
  const notes = useMemo(() => describeNotes(result, units), [result, units]);
  const summary = useMemo(() => summarizeModel(model, units), [model, units]);
  const confidence = confidenceCopy(result);
  const base = diffBaseFor(doc, result);
  const seedFeatureIds = useMemo(() => (doc.qa?.seed?.features ?? []).map((f) => f.id), [doc.qa?.seed]);
  const diff = useMemo(() => (base ? diffModels(base.model, model, { seedFeatureIds }) : null), [base, model, seedFeatureIds]);
  // the paint carry rule is about the model that is replaced, whatever the diff compares with
  const current = doc.threeD?.model;
  const paint = useMemo(() => (current ? diffModels(current, model, { seedFeatureIds }) : null), [current, model, seedFeatureIds]);
  const diffCopy = useMemo(() => (diff && base ? describeDiff(diff, base.model, model, units) : null), [diff, base, model, units]);
  const highlight = useMemo(() => new Set(diff ? [...diff.added, ...diff.changed.map((c) => c.part)] : []), [diff]);

  // §3.7.7 return path: only for a project the Start card just made
  const fresh = isFreshImportProject(doc);
  const [offer, setOffer] = useState<ReturnOffer | null>(null);
  useEffect(() => {
    if (!fresh) return;
    let live = true;
    void withDetails(candidatesFromLibrary(library, doc.id)).then((list) => {
      if (live) setOffer(matchReturnProject(result, list, { now: new Date(), exclude: doc.id }));
    });
    return () => {
      live = false;
    };
  }, [fresh, library, doc.id, result]);
  const [destination, setDestination] = useState<string | null>(null);
  const target = destination ?? (offer?.preselected ? offer.id : doc.id);
  const elsewhere = offer !== null && target === offer.id;

  const [unitsOpen, setUnitsOpen] = useState(false);
  const askUnits = !!result.units?.confirm && !pending.unitsAnswered;
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [joinAsk, setJoinAsk] = useState<FixChip | null>(null);
  const busy = pending.phase === 'accepting';
  const rerunning = pending.phase === 'reading';

  const accept = async (): Promise<boolean> => {
    try {
      await acceptPending(doc.id);
      return true;
    } catch (error) {
      notify.error(`Couldn’t accept the model: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  const goElsewhere = () => {
    if (!offer) return;
    void moveImport(doc.id, offer.id);
    navigate({ screen: 'project', projectId: offer.id, tab: 'import' });
  };

  const acceptBlocked = readOnly ? READ_ONLY : rerunning ? 'Reading the file again…' : askUnits ? 'Answer the size question first' : undefined;

  return (
    <div className="imp-page">
      <div className="imp-report" aria-busy={rerunning || busy}>
        <header className="imp-report__head">
          <div>
            <h2 className="imp-report__title" ref={heading} tabIndex={-1}>
              {summary.name ? `“${summary.name}” is ready to import` : 'Your model is ready to import'}
            </h2>
            <p className="imp-muted">
              {pending.inputs[0]?.kind === 'text' ? 'From the text you pasted.' : `From ${pending.original.name}.`} Nothing in your project changes until you accept.
            </p>
          </div>
        </header>

        <div className="imp-report__grid">
          <section className="imp-card imp-model" aria-labelledby="imp-model-title">
            <h3 id="imp-model-title" className="imp-card__title">
              The model
            </h3>
            <ModelPreview model={model} meshes={result.meshes} label={`Front view of the imported model: ${summary.line}`} highlight={highlight} />
            <p className="imp-model__line" data-testid="import-summary">
              {summary.line}
            </p>
            <ul className="imp-swatches" aria-label="Colors">
              {summary.colors.map((c) => (
                <li key={c.hex + c.name}>
                  <span className="imp-swatch" style={{ background: c.hex }} aria-hidden="true" />
                  {c.name}
                </li>
              ))}
            </ul>
          </section>

          <div className="imp-report__side">
            {diffCopy && base ? <Changes doc={doc} pending={pending} copy={diffCopy} base={base} paintNotCarried={paint?.paintNotCarried ?? []} paintCarried={paint?.paintCarried ?? []} /> : null}
            <section className="imp-card" aria-labelledby="imp-read-title">
              <h3 id="imp-read-title" className="imp-card__title">
                What we read
              </h3>
              <dl className="imp-facts">
                <div>
                  <dt>From</dt>
                  <dd data-testid="import-carrier">{carrierText(result.carrier)}</dd>
                </div>
                <div>
                  <dt>Written as</dt>
                  <dd data-testid="import-dialect">{dialectText(result.dialect)}</dd>
                </div>
                <div>
                  <dt>How sure</dt>
                  <dd data-testid="import-confidence">
                    <Badge tone={confidence.tone}>{confidence.label}</Badge>
                    <span className="imp-facts__explain">{confidence.explain}</span>
                  </dd>
                </div>
                {result.units ? (
                  <div>
                    <dt>Size</dt>
                    <dd>
                      <span data-testid="import-size">{fixes.chips.find((c) => c.code === 'units')?.text ?? summary.line}</span>
                      <Button size="sm" variant="ghost" icon="ruler" disabledReason={busy ? 'Accepting…' : undefined} onClick={() => setUnitsOpen(true)}>
                        Change size…
                      </Button>
                    </dd>
                  </div>
                ) : null}
                {(result.candidates?.length ?? 0) > 1 ? (
                  <div>
                    <dt>Version</dt>
                    <dd>
                      <span>{versionOptions(result.candidates ?? []).find((v) => v.chosen)?.title ?? 'The newest'}</span>
                      <Button size="sm" variant="ghost" icon="layers" onClick={() => setVersionsOpen(true)}>
                        Choose version…
                      </Button>
                    </dd>
                  </div>
                ) : null}
              </dl>
            </section>

            <Fixes fixes={fixes} canAccept={!elsewhere && !acceptBlocked} onJoin={(chip) => setJoinAsk(chip)} onVersions={() => setVersionsOpen(true)} />

            {notes.length > 0 ? (
              <section className="imp-card" aria-labelledby="imp-notes-title">
                <h3 id="imp-notes-title" className="imp-card__title">
                  Good to know
                </h3>
                <ul className="imp-notes">
                  {notes.map((n) => (
                    <li key={n.text} data-tone={n.tone}>
                      <Icon name={n.tone === 'info' ? 'info' : 'warning'} size={16} />
                      <span>{n.text}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        </div>

        {offer ? (
          <section className="imp-card imp-where" aria-labelledby="imp-where-title">
            <h3 id="imp-where-title" className="imp-card__title">
              Where should it go?
            </h3>
            <div className="imp-radio" role="radiogroup" aria-labelledby="imp-where-title">
              <label className="imp-radio__option">
                <input type="radio" name="imp-where" checked={target === offer.id} onChange={() => setDestination(offer.id)} />
                <span>
                  <strong>Import into “{offer.name}”</strong>
                  <span className="imp-muted">{offer.reason === 'only-waiting' ? 'It’s waiting for a Claude Design result' : 'Where you made the prompt'}</span>
                </span>
              </label>
              <label className="imp-radio__option">
                <input type="radio" name="imp-where" checked={target === doc.id} onChange={() => setDestination(doc.id)} />
                <span>
                  <strong>A new project</strong>
                  <span className="imp-muted">Keep it here, in “{doc.name}”</span>
                </span>
              </label>
            </div>
          </section>
        ) : null}

        <div className="imp-actions" role="group" aria-label="Import actions">
          <p className="imp-muted imp-actions__note" aria-live="polite">
            {rerunning ? (
              <>
                <Spinner size={14} /> Reading the file again…
              </>
            ) : elsewhere
              ? `We’ll open “${offer?.name}” and show what changes there before anything is replaced.`
              : current
                ? 'Your current model stays in the project’s history, so you can always go back to it.'
                : 'You can change everything afterwards in the Shape tab.'}
          </p>
          <Button variant="ghost" icon="x" disabledReason={busy ? 'Accepting…' : undefined} onClick={() => clearImport(doc.id)}>
            Cancel
          </Button>
          {elsewhere ? (
            <Button variant="primary" iconEnd="arrow-right" onClick={goElsewhere}>
              Continue in “{offer?.name}”
            </Button>
          ) : (
            <Button variant="primary" icon="check" loading={busy} disabledReason={acceptBlocked} onClick={() => void accept()} data-testid="import-accept">
              Accept model
            </Button>
          )}
        </div>
      </div>

      <UnitsDialog
        open={unitsOpen || (askUnits && !busy && !rerunning)}
        result={result}
        units={units}
        onPick={(unit) => {
          setUnitsOpen(false);
          if (unit === null || unit === result.units?.chosen || unit === 'normalized') keepUnits(doc.id);
          else void rerunImport(doc.id, { units: unit });
        }}
      />
      <VersionsDialog
        open={versionsOpen}
        result={result}
        onClose={() => setVersionsOpen(false)}
        onPick={(id) => {
          setVersionsOpen(false);
          void rerunImport(doc.id, { pickCandidate: id });
        }}
      />
      <ConfirmDialog
        open={joinAsk !== null}
        title="Accept the model first?"
        confirmLabel="Accept and open Attach"
        tone="primary"
        onCancel={() => setJoinAsk(null)}
        onConfirm={() => {
          const chip = joinAsk;
          setJoinAsk(null);
          if (!chip?.part) return;
          void accept().then((ok) => {
            if (ok && chip.part) openJoin(doc.id, chip.part);
          });
        }}
      >
        To change how {joinAsk?.part ? partDisplayName(joinAsk.part, model) : 'a part'} is joined, the model needs to be in your project. Accept it now and open the Attach tool?
      </ConfirmDialog>
    </div>
  );
}

function Fixes({ fixes, canAccept, onJoin, onVersions }: { fixes: ReturnType<typeof describeFixes>; canAccept: boolean; onJoin(chip: FixChip): void; onVersions(): void }) {
  if (fixes.chips.length === 0) {
    return (
      <section className="imp-card" aria-labelledby="imp-fixes-title">
        <h3 id="imp-fixes-title" className="imp-card__title">
          Nothing needed fixing
        </h3>
        <p className="imp-muted">The model came through exactly as it was written.</p>
      </section>
    );
  }
  return (
    <section className="imp-card" aria-labelledby="imp-fixes-title">
      <h3 id="imp-fixes-title" className="imp-card__title" data-testid="import-fixes">
        {fixes.headline ?? 'Versions'}
      </h3>
      <p className="imp-muted">{fixes.summary}</p>
      <details className="imp-details imp-fixes">
        <summary>Show what we fixed</summary>
        {fixes.sections.map((s) => (
          <div key={s.group} className="imp-fixes__group">
            <h4 className="imp-fixes__title">{s.title}</h4>
            {s.group === 'joins' ? <p className="imp-fixes__explain">The file didn’t say what these parts are sewn to, so we joined each to the part it overlaps. {canAccept ? 'Pick one to change it in the Attach tool.' : 'You can change them after you accept.'}</p> : null}
            {s.group === 'pairs' ? <p className="imp-fixes__explain">These parts are mirror images, so the pattern makes them as pairs.</p> : null}
            {s.group === 'joins' || s.group === 'pairs' ? (
              <ul className="imp-chips" aria-label={s.title}>
                {s.chips.map((c) => (
                  <li key={c.key}>
                    <Chip icon={c.attach ? 'link' : 'mirror'} title={c.detail} onClick={c.attach && canAccept ? () => onJoin(c) : undefined}>
                      {c.text}
                    </Chip>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="imp-fixes__rows">
                {s.chips.map((c) => (
                  <li key={c.key}>
                    <Chip icon={c.code === 'versions' ? 'layers' : 'check'} title={c.detail} onClick={c.code === 'versions' ? onVersions : undefined}>
                      {c.text}
                    </Chip>
                    <span className="imp-fixes__detail">{c.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </details>
    </section>
  );
}

function Changes({
  doc,
  pending,
  copy,
  base,
  paintNotCarried,
  paintCarried,
}: {
  doc: ProjectDoc;
  pending: PendingImport;
  copy: ReturnType<typeof describeDiff>;
  base: { model: CrochetModelV1; what: 'seed' | 'current' };
  paintNotCarried: string[];
  paintCarried: string[];
}) {
  const next = pending.result?.model as CrochetModelV1;
  const picks = new Set(pending.carryAnyway);
  const title = base.what === 'seed' ? 'Changes from the model you sent' : 'Changes from your current model';
  return (
    <section className="imp-card imp-changes" aria-labelledby="imp-changes-title">
      <figure className="imp-changes__before">
        <ModelPreview model={base.model} label={`Front view of ${base.what === 'seed' ? 'the model you sent' : 'your current model'}`} size="sm" />
        <figcaption className="imp-muted">Before</figcaption>
      </figure>
      <h3 id="imp-changes-title" className="imp-card__title">
        {title}
      </h3>
      <p className="imp-muted" data-testid="import-diff-headline">
        {copy.headline}
      </p>
      {copy.same ? null : (
        <div className="imp-changes__body">
          {copy.added.length > 0 ? <ChangeList title="New parts" tone="success" items={copy.added} /> : null}
          {copy.removed.length > 0 ? <ChangeList title="Removed parts" tone="danger" items={copy.removed} /> : null}
          {copy.changed.length > 0 ? (
            <div className="imp-changes__group">
              <h4 className="imp-fixes__title">Changed</h4>
              <ul className="imp-changed">
                {copy.changed.map((row) => (
                  <li key={row.part}>
                    <span className="imp-changed__name">{row.name}</span>
                    <span className="imp-changed__what">
                      {row.changes.map((c) => (
                        <Badge key={c} tone="neutral" icon={null} size="sm">
                          {c}
                        </Badge>
                      ))}
                      {row.color ? (
                        <span className="imp-changed__colors" aria-label={`Color ${row.color.from} to ${row.color.to}`}>
                          <span className="imp-swatch" style={{ background: row.color.from }} />
                          <Icon name="arrow-right" size={12} />
                          <span className="imp-swatch" style={{ background: row.color.to }} />
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {copy.features.removed.length > 0 ? <ChangeList title="Face details Claude removed" tone="neutral" items={copy.features.removed} /> : null}
          {copy.features.kept.length > 0 ? <ChangeList title="Face details you added (kept)" tone="neutral" items={copy.features.kept} /> : null}
          {copy.features.added.length > 0 ? <ChangeList title="New face details" tone="neutral" items={copy.features.added} /> : null}
          {copy.palette.added.length + copy.palette.removed.length > 0 ? (
            <div className="imp-changes__group">
              <h4 className="imp-fixes__title">Yarn colors</h4>
              <p className="imp-changes__palette">
                {copy.palette.added.length > 0 ? (
                  <span>
                    New:{' '}
                    {copy.palette.added.map((h) => (
                      <span key={h} className="imp-swatch" style={{ background: h }} title={h} />
                    ))}
                  </span>
                ) : null}
                {copy.palette.removed.length > 0 ? (
                  <span>
                    No longer used:{' '}
                    {copy.palette.removed.map((h) => (
                      <span key={h} className="imp-swatch" style={{ background: h }} title={h} />
                    ))}
                  </span>
                ) : null}
              </p>
            </div>
          ) : null}
        </div>
      )}
      {paintNotCarried.length > 0 || paintCarried.length > 0 ? (
        <div className="imp-paint">
          <h4 className="imp-fixes__title">Colors you painted</h4>
          {paintCarried.length > 0 ? <p className="imp-muted">Kept on {nameList(paintCarried.map((id) => partDisplayName(id, next)))}: their shape hardly changed.</p> : null}
          {paintNotCarried.length > 0 ? (
            <>
              <p className="imp-changes__text" data-testid="import-paint-not-carried">
                Not carried to {nameList(paintNotCarried.map((id) => partDisplayName(id, next)))}: the new shape is different enough that the colors could land in the wrong place. They stay in the earlier version.
              </p>
              <ul className="imp-paint__list">
                {paintNotCarried.map((id) => (
                  <li key={id}>
                    <Switch
                      label={`Carry anyway: ${partDisplayName(id, next)}`}
                      checked={picks.has(id)}
                      onChange={(on) => setCarryAnyway(doc.id, on ? [...picks, id] : [...picks].filter((x) => x !== id))}
                    />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ChangeList({ title, items, tone }: { title: string; items: string[]; tone: 'success' | 'danger' | 'neutral' }) {
  return (
    <div className="imp-changes__group">
      <h4 className="imp-fixes__title">{title}</h4>
      <ul className="imp-chips" aria-label={title}>
        {items.map((name) => (
          <li key={name}>
            <Chip tone={tone}>{name}</Chip>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UnitsDialog({ open, result, units, onPick }: { open: boolean; result: ImportResult; units: UnitPref; onPick(unit: Parameters<typeof rerunImport>[1]['units'] | 'normalized' | null): void }) {
  const decision = result.units;
  const options = decision ? unitsOptions(decision, result.model?.finishedSize.height, units) : [];
  return (
    <Dialog open={open && !!decision} onClose={() => onPick(null)} title="How tall is this toy?" description="The file doesn’t say which unit it uses, so we have to guess. Pick the size that looks right." size="sm">
      <p className="imp-question" data-testid="units-question">
        {unitsQuestion(options)}
      </p>
      <div className="imp-choices">
        {options.map((o) => (
          <button key={o.unit} type="button" className={o.current ? 'imp-choice imp-choice--current' : 'imp-choice'} onClick={() => onPick(o.unit)}>
            <span className="imp-choice__label">{o.label}</span>
            <span className="imp-choice__hint">{o.hint}</span>
            {o.current ? (
              <Badge tone="accent" icon={null} size="sm">
                Our guess
              </Badge>
            ) : null}
          </button>
        ))}
      </div>
    </Dialog>
  );
}

function VersionsDialog({ open, result, onClose, onPick }: { open: boolean; result: ImportResult; onClose(): void; onPick(id: string): void }) {
  const options = versionOptions(result.candidates ?? []);
  const chosen = options.find((o) => o.chosen)?.id ?? options[0]?.id ?? '';
  // null: the version in use (reset whenever the dialog closes)
  const [picked, setPicked] = useState<string | null>(null);
  const pick = picked ?? chosen;
  const setPick = (id: string) => setPicked(id);
  const close = () => {
    setPicked(null);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Which version?"
      description="This archive holds more than one version of the model. We used the newest; you can pick another."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabledReason={pick === chosen ? 'This version is already in use' : undefined}
            onClick={() => {
              setPicked(null);
              onPick(pick);
            }}
          >
            Use this version
          </Button>
        </>
      }
    >
      <div className="imp-radio" role="radiogroup" aria-label="Versions">
        {options.map((o) => (
          <label key={o.id} className="imp-radio__option">
            <input type="radio" name="imp-version" checked={pick === o.id} onChange={() => setPick(o.id)} />
            <span>
              <strong>{o.title}</strong>
              <span className="imp-muted">
                {o.detail}
                {o.chosen ? ' · in use now' : ''}
              </span>
            </span>
          </label>
        ))}
      </div>
    </Dialog>
  );
}

// ---- accepted: the joins to check, then Yarn & size

function JoinChips({ projectId, chips }: { projectId: string; chips: FixChip[] }) {
  return (
    <ul className="imp-chips" aria-label="Joins to check">
      {chips.map((c) => (
        <li key={c.key}>
          <Chip icon="link" title={`${c.detail} Opens the Attach tool.`} onClick={() => c.part && openJoin(projectId, c.part)}>
            {c.text}
          </Chip>
        </li>
      ))}
    </ul>
  );
}

function Accepted({ doc, pending }: { doc: ProjectDoc; pending: PendingImport }) {
  const result = pending.result;
  const model = doc.threeD?.model;
  const heading = useFocusOnMount<HTMLHeadingElement>(pending.run);
  const joins = useMemo(() => (result ? describeFixes(result, doc.units).chips.filter((c) => c.attach && c.part && model?.parts.some((p) => p.id === c.part)) : []), [result, doc.units, model]);
  const outcome = pending.outcome;
  const done = () => {
    clearImport(doc.id);
    navigate({ screen: 'project', projectId: doc.id, tab: 'shape' });
  };
  const carried: ReactNode[] = [];
  if (outcome && outcome.report.paint.length > 0) carried.push(`painted colors on ${nameList(outcome.report.paint.map((id) => partDisplayName(id, model)))}`);
  if (outcome && outcome.report.features.length > 0) carried.push(`${outcome.report.features.length} face ${outcome.report.features.length === 1 ? 'detail' : 'details'} you added`);
  return (
    <div className="imp-page">
      <div className="imp-done">
        <header className="imp-done__head">
          <span className="imp-done__tile" aria-hidden="true">
            <Icon name="success" size={26} />
          </span>
          <div>
            <h2 className="imp-head__title" ref={heading} tabIndex={-1}>
              {model ? `${summarizeModel(model, doc.units).parts} parts are in your project` : 'Imported'}
            </h2>
            <p className="imp-head__lead">
              Saved as a new version{carried.length > 0 ? `, keeping your ${carried.join(' and ')}` : ''}. Now tell us your yarn, so the pattern comes out the right size.
            </p>
          </div>
        </header>
        <div className="imp-done__grid">
          <div className="imp-done__panel">
            <YarnSizePanel context="post-import" onDone={done} />
          </div>
          <aside className="imp-done__side" aria-label="Next steps">
            {model ? (
              <section className="imp-card" aria-labelledby="imp-yours-title">
                <h3 id="imp-yours-title" className="imp-card__title">
                  In your project now
                </h3>
                <ModelPreview model={model} label="Front view of the model in your project" size="sm" />
              </section>
            ) : null}
            {joins.length > 0 ? (
              <section className="imp-card" aria-labelledby="imp-joins-title">
                <h3 id="imp-joins-title" className="imp-card__title">
                  Check how parts are joined
                </h3>
                <p className="imp-card__text">We decided these joins ourselves. Pick one to open it in the Attach tool.</p>
                <JoinChips projectId={doc.id} chips={joins} />
              </section>
            ) : null}
            <Button variant="ghost" icon="import" onClick={() => clearImport(doc.id)}>
              Import another file
            </Button>
          </aside>
        </div>
      </div>
    </div>
  );
}

