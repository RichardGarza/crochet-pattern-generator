// Track T6.2 — the Yarn & size panel shared by every 3D origin (DESIGN.md §4.5): yarn weight, hook, yarn over /
// under, the finished size with its uncertainty band (and Scale model to height), default stuffing, the optional
// test ball, the 10-stitch yarn calibration, the spiral lean with its test-tube calibration, and the pattern style
// (`threeD.ami.*`). Shown before the build (`pre-model`), after an import (`post-import`), on the Shape tab
// (`shape`) and as the 3D Pattern tab's settings slot (`pattern`). Every field writes through
// `projectStore.update` (`yarnSize.ts`).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { amiHookMm, type AmiCyc } from '../../core/gauge';
import { notify } from '../../app/toasts';
import { useProjectStore } from '../../state/projectStore';
import type { AmiSettings } from '../../types/ami';
import type { GaugeSpec } from '../../types/gauge';
import type { YarnSizePanelProps } from '../../types/ui';
import type { UnitPref } from '../../types/units';
import { Badge, Banner, Button, Dialog, NumberField, Panel, SegmentedControl, Select, Switch, formatLength, formatNumber } from '../common';
import {
  amigurumiGauge,
  applyModelYarn,
  gaugeWarnings,
  HEIGHT_LIMITS_IN,
  hookChoices,
  hookLabel,
  isPristineGauge,
  LEAN_LIMIT,
  LEAN_TUBE_ROUNDS,
  leanFromTube,
  setAmi,
  setGauge,
  setTargetHeight,
  sizeEstimate,
  usesModelYarn,
  weightLabel,
  withHook,
  withTestBall,
  withWeight,
  withYarnPerStitch,
  withYarnUnder,
  yarnFromModel,
  YARN_WEIGHTS,
  type ClearedField,
  type SizeEstimate,
} from './yarnSize';
import './yarnSize.css';

/** Suggestions dismissed in this session ("Keep my yarn") and pre-fills already done, by project and suggestion. */
const dismissedSuggestions = new Set<string>();
const prefillDone = new Set<string>();

type ModelTools = typeof import('./yarnSizeModel');
let toolsPromise: Promise<ModelTools> | null = null;

/** The model-dependent half (`yarnSizeModel.ts`, which needs three.js to measure a model), loaded on first use. */
function useModelTools(): ModelTools | null {
  const [tools, setTools] = useState<ModelTools | null>(null);
  useEffect(() => {
    let live = true;
    toolsPromise ??= import('./yarnSizeModel');
    void toolsPromise.then((m) => {
      if (live) setTools(m);
    });
    return () => {
      live = false;
    };
  }, []);
  return tools;
}

export type { YarnSizePanelProps } from '../../types/ui';

const READ_ONLY = 'This project is read-only';

export function YarnSizePanel({ context, onDone }: YarnSizePanelProps) {
  const doc = useProjectStore((s) => s.doc);
  const readOnly = useProjectStore((s) => s.readOnly);
  const gauge = useMemo(() => amigurumiGauge(doc?.gauge), [doc?.gauge]);
  const threeD = doc?.threeD;
  const model = threeD?.model;
  const units: UnitPref = doc?.units ?? 'in';
  const [cleared, setCleared] = useState<ClearedField[]>([]);
  const tools = useModelTools();

  // §4.5 / §3.7.7: after an import into a project the import created, the panel pre-fills from `model.yarn`
  // (never over a gauge somebody set: otherwise it only offers it).
  const suggestion = yarnFromModel(model?.yarn);
  const suggestionKey = suggestion ? JSON.stringify(suggestion) : '';
  const [prefilled, setPrefilled] = useState(false);
  const [, forceDismiss] = useState(0);
  const dismissKey = `${doc?.id ?? ''}:${suggestionKey}`;
  useEffect(() => {
    // Once per suggestion: also when the model arrives after the panel opened.
    if (context !== 'post-import' || readOnly || !suggestion || prefillDone.has(dismissKey)) return;
    const origin = threeD?.origin;
    if ((origin === 'claude-design' || origin === 'describe') && isPristineGauge(doc?.gauge) && !usesModelYarn(gauge, suggestion)) {
      prefillDone.add(dismissKey);
      if (applyModelYarn()) setPrefilled(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestionKey, context, readOnly]);

  if (!doc || !threeD) {
    return (
      <div className="ysp" data-context={context}>
        <Panel title="Yarn & size" icon="ruler">
          <p className="ysp-muted">Yarn and size apply to 3D projects.</p>
        </Panel>
      </div>
    );
  }

  const disabled = readOnly;
  const cyc = gauge.cyc as AmiCyc;
  // Until the measuring code has loaded, the model's stated height stands in.
  const heightIn = model ? (tools ? tools.modelHeight(model) : model.finishedSize.height) : threeD.recon?.targetHeightIn;
  const estimate = heightIn ? sizeEstimate(gauge, heightIn) : null;
  const ami = threeD.ami;

  const chooseWeight = (next: AmiCyc) => {
    const r = withWeight(gauge, next);
    if (setGauge(`Yarn weight: ${YARN_WEIGHTS[next].name}`, r.gauge)) setCleared(r.cleared);
  };

  return (
    <div className={`ysp ysp--${context}`} data-context={context}>
      {context === 'pre-model' || context === 'post-import' ? (
        <header className="ysp-head">
          <h2 className="ysp-head__title">Yarn &amp; size</h2>
          <p className="ysp-head__lead">Tell us the yarn you'll crochet with. The pattern counts its stitches for it, so the toy comes out the size you see.</p>
        </header>
      ) : null}

      <Panel title="Your yarn" icon="yarn">
        <div className="ysp-stack">
          {suggestion && !usesModelYarn(gauge, suggestion) && !dismissedSuggestions.has(dismissKey) ? (
            <Banner
              tone="info"
              icon="sparkles"
              onDismiss={() => {
                dismissedSuggestions.add(dismissKey);
                forceDismiss((n) => n + 1);
              }}
              dismissLabel="Keep my yarn"
              title="Claude Design suggested a yarn"
              actions={
                <Button size="sm" disabledReason={disabled ? READ_ONLY : undefined} onClick={() => applyModelYarn()}>
                  Use it
                </Button>
              }
            >
              {YARN_WEIGHTS[suggestion.cyc].name} (CYC {suggestion.cyc}) with a {hookLabel(suggestion.hookMm ?? amiHookMm(suggestion.cyc))} hook.
              {suggestion.note ? <span className="ysp-note"> {suggestion.note}</span> : null}
            </Banner>
          ) : null}
          {prefilled && suggestion ? (
            <Banner tone="success" onDismiss={() => setPrefilled(false)}>
              Filled in from Claude Design: {YARN_WEIGHTS[suggestion.cyc].name} yarn, {hookLabel(suggestion.hookMm ?? amiHookMm(suggestion.cyc))} hook.
              {suggestion.note ? <span className="ysp-note"> {suggestion.note}</span> : null}
            </Banner>
          ) : null}
          <Select
            label="Yarn weight"
            value={String(cyc)}
            disabled={disabled}
            options={([1, 2, 3, 4, 5, 6, 7] as AmiCyc[]).map((c) => ({ value: String(c), label: weightLabel(c) }))}
            onChange={(v) => chooseWeight(Number(v) as AmiCyc)}
            hint="The number in the yarn symbol on the label. Most toys use 4 · Medium (worsted)."
          />
          {cleared.length > 0 ? (
            <Banner tone="neutral" icon="info" onDismiss={() => setCleared([])} dismissLabel="Dismiss the note">
              {clearedText(cleared)}
            </Banner>
          ) : null}
          <HookField gauge={gauge} cyc={cyc} disabled={disabled} />
          <SegmentedControl<'over' | 'under'>
            label="How you wrap the yarn"
            size="sm"
            fullWidth
            value={gauge.yarnUnder ? 'under' : 'over'}
            disabled={disabled}
            onChange={(v) => setGauge(v === 'under' ? 'Yarn under' : 'Yarn over', withYarnUnder(gauge, v === 'under'))}
            options={[
              { value: 'over', label: 'Yarn over' },
              { value: 'under', label: 'Yarn under' },
            ]}
          />
          <p className="ysp-hint">{gauge.yarnUnder ? 'Yarn under makes shorter stitches: rounds come out about 5% shorter.' : 'Most crocheters wrap the yarn over. Yarn under makes shorter, tighter stitches.'}</p>
        </div>
      </Panel>

      <Panel title="Finished size" icon="ruler">
        <div className="ysp-stack">
          {estimate ? <SizeSummary estimate={estimate} units={units} /> : null}
          {model ? <ScaleField key={model.revision} heightIn={heightIn ?? 0} units={units} disabled={disabled} tools={tools} /> : <TargetField units={units} disabled={disabled} has={!!threeD.recon} value={threeD.recon?.targetHeightIn} />}
          <SegmentedControl<AmiSettings['defaultStuffing']>
            label="Stuffing"
            size="sm"
            fullWidth
            value={ami.defaultStuffing}
            disabled={disabled}
            onChange={(v) => setAmi(`Stuffing: ${v}`, { defaultStuffing: v })}
            options={[
              { value: 'firm', label: 'Firm' },
              { value: 'medium', label: 'Medium' },
              { value: 'light', label: 'Light' },
            ]}
          />
          <p className="ysp-hint">For parts that don't set their own. Firm and medium stuffing stretch the stitches about 5%; ears and flat pieces are never stuffed.</p>
        </div>
      </Panel>

      <Panel title="Match your tension" icon="hook" collapsible defaultOpen={gauge.testBall !== undefined || gauge.lscCalibratedIn !== undefined}>
        <div className="ysp-stack">
          <p className="ysp-lead">Optional, and worth it: everyone crochets a little differently. Two quick checks with a test ball make the size and the yarn amounts exact.</p>
          <TestBallFields key={JSON.stringify(gauge.testBall ?? null)} gauge={gauge} units={units} disabled={disabled} />
          <YarnPerStitchField gauge={gauge} units={units} disabled={disabled} />
          <LeanField ami={ami} disabled={disabled} />
        </div>
      </Panel>

      <Panel title="Pattern style" icon="list" collapsible defaultOpen={context === 'pattern'}>
        <PatternStyle ami={ami} disabled={disabled} />
      </Panel>

      {onDone ? (
        <div className="ysp-done">
          <Button variant="primary" icon="check" onClick={onDone}>
            {context === 'pre-model' ? 'Continue' : 'Done'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** A number with a real minus sign (−0.125). */
function signed(x: number): string {
  return x < 0 ? `−${formatNumber(-x, 3)}` : formatNumber(x, 3);
}

function clearedText(cleared: ClearedField[]): string {
  const names = cleared.map((c) => (c === 'hook' ? 'the hook size' : c === 'testBall' ? 'the test ball' : 'the yarn per stitch'));
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `New yarn: ${list} ${names.length === 1 ? 'was' : 'were'} reset, because ${names.length === 1 ? 'it belonged' : 'they belonged'} to the old yarn.`;
}

// ---- yarn

function HookField({ gauge, cyc, disabled }: { gauge: GaugeSpec; cyc: AmiCyc; disabled: boolean }) {
  const recommended = amiHookMm(cyc);
  const value = gauge.hookMm === undefined ? 'auto' : String(gauge.hookMm);
  const options = [
    { value: 'auto', label: `${hookLabel(recommended)} · recommended` },
    ...hookChoices(cyc, gauge.hookMm)
      .filter((mm) => Math.abs(mm - recommended) > 1e-9)
      .map((mm) => ({ value: String(mm), label: hookLabel(mm) })),
  ];
  return (
    <Select
      label="Hook"
      value={value}
      disabled={disabled}
      options={options}
      onChange={(v) => setGauge(v === 'auto' ? 'Recommended hook' : `Hook ${v} mm`, withHook(gauge, v === 'auto' ? undefined : Number(v)))}
      hint="Toys use a smaller hook than the yarn label says, so the stuffing doesn't show through."
    />
  );
}

// ---- size

function SizeSummary({ estimate, units }: { estimate: SizeEstimate; units: UnitPref }) {
  const f = (x: number) => formatLength(x, units, 1);
  const band = estimate.minusPct === estimate.plusPct ? `±${estimate.plusPct}%` : `−${estimate.minusPct}% / +${estimate.plusPct}%`;
  return (
    <div className="ysp-size" role="group" aria-label="Expected finished size">
      <div className="ysp-size__top">
        <p className="ysp-size__main">
          About <strong>{f(estimate.nominalIn)}</strong> tall
        </p>
        <Badge tone={estimate.measured ? 'success' : 'neutral'} size="sm" icon={estimate.measured ? 'check' : null}>
          {band}
        </Badge>
      </div>
      <div className="ysp-band" aria-hidden="true">
        <span className="ysp-band__range" />
        <span className="ysp-band__mark" />
      </div>
      <div className="ysp-band__ends" aria-hidden="true">
        <span>{f(estimate.lowIn)}</span>
        <span>{f(estimate.highIn)}</span>
      </div>
      <p className="ui-visually-hidden">
        Likely between {f(estimate.lowIn)} and {f(estimate.highIn)}.
      </p>
      <p className="ysp-hint">
        {estimate.measured ? 'Measured with your test ball. ' : 'Tension differs from person to person; a test ball (below) narrows this to ±4%. '}
        About {formatNumber(estimate.stitchesPerIn, 1)} stitches per inch, stuffed.
      </p>
    </div>
  );
}

function ScaleField({ heightIn, units, disabled, tools }: { heightIn: number; units: UnitPref; disabled: boolean; tools: ModelTools | null }) {
  const model = useProjectStore((s) => s.doc?.threeD?.model);
  // What was typed (null: nothing yet, the field shows the model's height). Keyed by the model revision, so a new
  // model (a scale, an undo) starts the field over.
  const [typed, setTyped] = useState<number | null>(null);
  const want = typed ?? heightIn;
  const [busy, setBusy] = useState(false);
  const changed = Math.abs(want - heightIn) > 0.005;
  const blocked = disabled ? READ_ONLY : !model ? 'No model' : !tools ? 'Loading…' : tools.scaleBlockedReason(model, want);
  const go = async () => {
    setBusy(true);
    try {
      await tools?.scaleModelToHeight(want);
    } catch (e) {
      notify.error(`The toy could not be resized: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ysp-scale">
      <NumberField
        label="Resize the whole toy to"
        kind="length"
        units={units}
        value={want}
        min={HEIGHT_LIMITS_IN[0]}
        max={HEIGHT_LIMITS_IN[1]}
        disabled={disabled}
        onChange={(v) => v !== null && setTyped(v)}
        hint="Every part grows or shrinks together; one undo step."
      />
      <Button size="sm" loading={busy} disabledReason={!changed ? 'Type a new height first' : (blocked ?? undefined)} onClick={() => void go()}>
        Scale to {formatLength(want, units)}
      </Button>
    </div>
  );
}

function TargetField({ units, disabled, has, value }: { units: UnitPref; disabled: boolean; has: boolean; value?: number }) {
  if (!has) return <p className="ysp-hint">The height is set with the photos, before the model is built.</p>;
  return (
    <NumberField
      label="Finished height"
      kind="length"
      units={units}
      value={value ?? null}
      min={HEIGHT_LIMITS_IN[0]}
      max={HEIGHT_LIMITS_IN[1]}
      disabled={disabled}
      onChange={(v) => v !== null && setTargetHeight(v)}
      hint="How tall the finished toy should be."
    />
  );
}

// ---- tension

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <section className="ysp-step" aria-label={title}>
      <h4 className="ysp-step__title">
        <span className="ysp-step__num" aria-hidden="true">
          {n}
        </span>
        {title}
        {done ? (
          <Badge tone="success" size="sm">
            Measured
          </Badge>
        ) : null}
      </h4>
      <div className="ysp-step__body">{children}</div>
    </section>
  );
}

function TestBallFields({ gauge, units, disabled }: { gauge: GaugeSpec; units: UnitPref; disabled: boolean }) {
  const [sts, setSts] = useState<number | null>(gauge.testBall?.maxSts ?? null);
  // Keyed by the stored test ball: a change from elsewhere (a new weight, undo) starts the fields over.
  const [around, setAround] = useState<number | null>(gauge.testBall?.circumferenceIn ?? null);
  const write = (s: number | null, c: number | null) => {
    if (s !== null && c !== null && s > 0 && c > 0) setGauge('Test ball', withTestBall(gauge, { maxSts: s, circumferenceIn: c }));
    else if (gauge.testBall) setGauge('Clear the test ball', withTestBall(gauge, undefined));
  };
  const warnings = gauge.testBall ? gaugeWarnings(gauge).filter((w) => w.code !== 'W_GAUGE_LSC') : [];
  return (
    <Step n={1} title="Test ball" done={!!gauge.testBall}>
      <p className="ysp-hint">
        With this yarn and hook, crochet a ball: 6 sc in a magic ring, increase by 6 each round to about 2 in across, a few plain rounds, then
        decrease. <strong>Stuff it firmly</strong>, like the toy, and close it. Then count and measure its widest round.
      </p>
      <div className="ysp-pair">
        <NumberField
          label="Stitches in the widest round"
          value={sts}
          min={6}
          max={600}
          step={6}
          precision={0}
          allowEmpty
          disabled={disabled}
          onChange={(v) => {
            setSts(v);
            write(v, around);
          }}
        />
        <NumberField
          label="Around the widest round"
          kind="length"
          units={units}
          value={around}
          min={0.25}
          max={100}
          allowEmpty
          disabled={disabled}
          onChange={(v) => {
            setAround(v);
            write(sts, v);
          }}
        />
      </div>
      {gauge.testBall ? (
        <p className="ysp-result">
          Your stitch: {formatLength(gauge.testBall.circumferenceIn / gauge.testBall.maxSts, units, units === 'cm' ? 2 : 3)} wide when stuffed. The size band is now ±4%.
        </p>
      ) : sts !== null || around !== null ? (
        <p className="ysp-hint">Fill in both to use your test ball.</p>
      ) : null}
      {warnings.map((w) => (
        <Banner key={w.code + w.message} tone={w.severity === 'error' ? 'danger' : 'warn'}>
          {w.message}
        </Banner>
      ))}
      {gauge.testBall ? (
        <Button size="sm" variant="ghost" icon="x" disabledReason={disabled ? READ_ONLY : undefined} onClick={() => setGauge('Clear the test ball', withTestBall(gauge, undefined))}>
          Clear the test ball
        </Button>
      ) : null}
    </Step>
  );
}

function YarnPerStitchField({ gauge, units, disabled }: { gauge: GaugeSpec; units: UnitPref; disabled: boolean }) {
  const length = gauge.lscCalibratedIn !== undefined ? gauge.lscCalibratedIn * 10 : null;
  return (
    <Step n={2} title="Yarn per stitch" done={gauge.lscCalibratedIn !== undefined}>
      <p className="ysp-hint">Unravel 10 sc of your test ball and measure the yarn they used.</p>
      <NumberField
        label="Yarn in 10 stitches"
        kind="length"
        units={units}
        value={length}
        min={0.5}
        max={200}
        allowEmpty
        disabled={disabled}
        onChange={(v) => setGauge(v === null ? 'Clear the yarn per stitch' : 'Yarn per stitch', withYarnPerStitch(gauge, v ?? undefined))}
      />
      {gaugeWarnings(gauge)
        .filter((w) => w.code === 'W_GAUGE_LSC')
        .map((w) => (
          <Banner key={w.message} tone="warn">
            {w.message}
          </Banner>
        ))}
      <p className={gauge.lscCalibratedIn !== undefined ? 'ysp-result' : 'ysp-hint'}>
        {gauge.lscCalibratedIn !== undefined
          ? `${formatLength(gauge.lscCalibratedIn, units, 2)} of yarn per stitch: yarn amounts are now within ±5%.`
          : 'Without it, yarn amounts are estimated within ±20% (±10% with a test ball).'}
      </p>
    </Step>
  );
}

function LeanField({ ami, disabled }: { ami: AmiSettings; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Step n={3} title="Spiral lean">
      <p className="ysp-hint">Rounds worked in a spiral drift sideways a little, which moves stripes and spots. The pattern allows for it.</p>
      <div className="ysp-lean">
        <NumberField
          label="Drift per round"
          suffix="st"
          value={ami.leanStPerRnd}
          min={-LEAN_LIMIT}
          max={LEAN_LIMIT}
          step={0.05}
          precision={2}
          stepper
          disabled={disabled}
          onChange={(v) => v !== null && setAmi('Spiral lean', { leanStPerRnd: v })}
          hint="In stitches, from −2 to 2. 0 turns it off; about 0.25 is usual for right-handers who yarn over."
        />
        <Button size="sm" icon="ruler" disabledReason={disabled ? READ_ONLY : undefined} onClick={() => setOpen(true)}>
          Measure it…
        </Button>
      </div>
      {open ? <LeanDialog hand={ami.hand} onClose={() => setOpen(false)} /> : null}
    </Step>
  );
}

/** The test tube of §4.5: lean = count / 12, positive against the working direction. */
function LeanDialog({ hand, onClose }: { hand: AmiSettings['hand']; onClose(): void }) {
  const [count, setCount] = useState<number | null>(null);
  // Seen from the outside: against the working direction is to the right for a right-hander (§2.11.2).
  const usual = hand === 'left' ? 'left' : 'right';
  const [side, setSide] = useState<'left' | 'right'>(usual);
  const lean = count === null ? null : leanFromTube(count, side === usual);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Measure your spiral lean"
      description="A small test tube shows how far your rounds drift. It takes about 15 minutes."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabledReason={lean === null ? 'Count the stitches first' : undefined}
            onClick={() => {
              if (lean === null) return;
              // The same value as before is a success too (0.25, the default, is the usual result).
              setAmi('Spiral lean (measured)', { leanStPerRnd: lean });
              onClose();
            }}
          >
            {lean === null ? 'Use it' : `Use ${signed(lean)}`}
          </Button>
        </>
      }
    >
      <ol className="ysp-steps">
        <li>With your yarn and hook: 6 sc in a magic ring, then increase until you have 24 stitches.</li>
        <li>Work {LEAN_TUBE_ROUNDS} plain rounds, moving your marker up every round as usual.</li>
        <li>Hold a ruler upright through the marked stitch of the first plain round.</li>
        <li>On the last round, count the stitches between the ruler and the marker.</li>
      </ol>
      <div className="ysp-stack">
        <NumberField label="Stitches between the ruler and the marker" value={count} min={0} max={24} step={0.5} precision={1} allowEmpty onChange={setCount} />
        <SegmentedControl<'left' | 'right'>
          label="Looking at the outside of the tube, the marker is"
          size="sm"
          value={side}
          onChange={setSide}
          options={[
            { value: 'left', label: 'Left of the ruler' },
            { value: 'right', label: 'Right of the ruler' },
          ]}
        />
        <p className="ysp-result" aria-live="polite">
          {lean === null ? 'Your lean appears here.' : `Lean: ${formatNumber(count ?? 0, 1)} ÷ ${LEAN_TUBE_ROUNDS} = ${formatNumber(Math.abs(lean), 3)} stitch per round${lean < 0 ? ', with your working direction (unusual, but fine)' : ''}.`}
        </p>
      </div>
    </Dialog>
  );
}

// ---- pattern style

function PatternStyle({ ami, disabled }: { ami: AmiSettings; disabled: boolean }) {
  const seg = <K extends keyof AmiSettings>(key: K, label: string, options: { value: AmiSettings[K] & string; label: string; tooltip?: string }[], hint?: string) => (
    <div className="ysp-field">
      <SegmentedControl<AmiSettings[K] & string>
        label={label}
        size="sm"
        fullWidth
        value={ami[key] as AmiSettings[K] & string}
        disabled={disabled}
        onChange={(v) => setAmi(`${label}: ${options.find((o) => o.value === v)?.label ?? v}`, { [key]: v } as Partial<AmiSettings>)}
        options={options}
      />
      {hint ? <p className="ysp-hint">{hint}</p> : null}
    </div>
  );
  return (
    <div className="ysp-stack">
      {seg(
        'style',
        'Shaping',
        [
          { value: 'classic', label: 'Classic' },
          { value: 'exact', label: 'Exact' },
        ],
        ami.style === 'classic' ? 'Textbook rounds: 6 in the ring, even increases. Easy to follow.' : 'Follows the shape closely: rounds may start with 5–8 stitches.',
      )}
      {seg('decMethod', 'Decreases', [
        { value: 'invdec', label: 'Invisible' },
        { value: 'sc2tog', label: 'sc2tog' },
      ], ami.decMethod === 'invdec' ? 'Invisible decrease: through the front loops only, neater on toys.' : 'Single crochet two together.')}
      {seg(
        'eyes',
        'Eyes',
        [
          { value: 'auto', label: 'Auto' },
          { value: 'safety', label: 'Safety eyes' },
          { value: 'embroidered', label: 'Embroidered' },
        ],
        'Auto uses safety eyes, or embroidered eyes for a toy meant for children under 3.',
      )}
      <Switch
        label="Crisp stripes"
        description="Join the rounds where colors change, so stripes line up with no jog."
        checked={ami.crispStripes}
        disabled={disabled}
        onChange={(on) => setAmi(on ? 'Crisp stripes on' : 'Crisp stripes off', { crispStripes: on })}
      />
      {seg('terms', 'Terms', [
        { value: 'us', label: 'US' },
        { value: 'uk', label: 'UK' },
      ])}
      {seg('hand', 'Hand', [
        { value: 'right', label: 'Right-handed' },
        { value: 'left', label: 'Left-handed' },
      ])}
      {seg(
        'dialect',
        'Instructions',
        [
          { value: 'compact', label: 'Compact' },
          { value: 'verbose', label: 'Written out' },
        ],
        ami.dialect === 'compact' ? 'Short form, for example “(sc 2, inc) x 6 (24)”.' : 'Every repeat spelled out in words.',
      )}
    </div>
  );
}
