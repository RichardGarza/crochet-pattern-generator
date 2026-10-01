# Step 0c — app shell and design system

Branch `s0c/shell`, made from `master` after the four 0b merges (state/workers, geometry, gauge, pattern). This
part of Step 0c (`DESIGN.md` §6.2 item 3, §5.3, §5.7) delivers the frame every feature track lives in: the
design system (`src/ui/common`), the app shell (`src/App.tsx`, `src/main.tsx`, `src/app/**`, `src/ui/shell/**`,
`index.html`), the stub tab entry components at their track-owned paths, and the browser smoke test
(`e2e/smoke.spec.ts`).

## What was delivered

| Path | What it is |
|---|---|
| `src/ui/common/tokens.css` | Design tokens (type, space, radii, sizes, motion, layers, colors, shadows), light + dark, base reset, one focus style |
| `src/ui/common/components.css` | Styles of every common component (`ui-` prefix, block__element--modifier) |
| `src/ui/common/*.tsx`, `index.ts` | 25 components + icon set (below); helpers `units.ts`, `fieldIds.ts`, `files.ts`, `focus.ts`, `tabIds.ts`, `cx.ts` |
| `src/app/router.ts` | `startRouter`, `navigate`, `useRoute`, `hrefFor`, `isCurrent` (hash router over appStore's `parseHash`/`formatHash`) |
| `src/app/tabs.ts` | The final tab registry: 2D and 3D tab lists, §5.3 visibility predicates, `defaultRouteTab`, lazy entries (+ the wizard and the start screen) |
| `src/app/ErrorBoundary.tsx` | Per-tab / per-region error boundary with "Try again" and "Copy details" |
| `src/app/toasts.ts` | `notify.*` helpers and `useToastTimers` (pause on hover/focus) |
| `src/App.tsx`, `src/main.tsx`, `index.html` | Root: theme, capability probe (once), route switch, toasts, skip link; pre-paint theme + background |
| `src/ui/shell/` | Start screen frame and cards, project grid, workspace (top bar, banners, tab bar, body, status bar), project session, theme, shortcuts, placeholders |
| stub entries | `ui/library/StartScreen` (delegates, see below) · `ui/twoD/SourceTab`, `ChartTab` · `ui/pattern/PatternTab`, `MaterialsTab` · `ui/photos/PhotosTab` · `ui/import/ImportTab` · `ui/qa/QaWizard` · `ui/shape/ShapeTab`, `YarnSizePanel` · `ui/export/ExportTab` — each `__stub: true`, frozen props |
| `src/state/appStore.ts` | `Prefs.theme: 'system' \| 'light' \| 'dark'` (default `'system'`), sanitized like the other prefs (deviation 1) |
| `e2e/smoke.spec.ts` | 16 browser tests (below); `e2e/workers/*.worker.ts` test-only workers; `e2e/gallery/` dev/test-only component gallery |
| `e2e/screenshots/*.png` | Light + dark: start screen, 2D workspace, 3D workspace (Pattern tab with the Yarn & size slot), component gallery |

Tests added: `src/ui/common/__tests__/{tokens,units,components}`, `src/app/__tests__/{tabs,router}`,
`src/ui/shell/__tests__/{newProject,projectSession,helpers,app,stubs}` and one theme case in
`state/__tests__/appStore.test.ts`.

## How to see it

`CPG_PROJECTS_DIR=$(mktemp -d) CPG_TEST=1 npm run dev` (never port 5180; a worktree picks its own), then the app
at `/` and every component at `/e2e/gallery/` (`?theme=dark` forces dark). The gallery is dev/test only (not in
`index.html`, not in the build).

## Design tokens (`tokens.css`)

Use the tokens, never raw values; a track's own CSS (`*.module.css` or a stylesheet in its folder) reads them with
`var(--…)`. All color pairs below are checked for WCAG AA in both themes by `tokens.test.ts` (4.5:1 for text,
3:1 for control borders, focus, accent and status colors); the system-dark and picked-dark blocks must stay
identical (also tested).

| Group | Tokens |
|---|---|
| Fonts | `--font-sans` (system UI), `--font-display` (Iowan Old Style → Palatino → Georgia: headings only), `--font-mono`. No web fonts: the app works offline. |
| Type scale | `--text-xs` 12 · `--text-sm` 13 · `--text-md` 14 (UI default) · `--text-base` 16 (reading) · `--text-lg` 18 · `--text-xl` 22 · `--text-2xl` 28 · `--text-3xl` 36; `--leading-tight/snug/normal`; `--weight-regular/medium/semibold/bold` |
| Space (4 px grid) | `--space-0 … --space-10` = 0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64 px |
| Radii | `--radius-xs` 4 · `sm` 6 · `md` 10 (controls) · `lg` 14 (cards) · `xl` 20 (dialogs, hero cards) · `pill` |
| Sizes | `--control-h-sm/md/lg` 28/36/44 · `--topbar-h` 56 · `--tabbar-h` 44 · `--statusbar-h` 30 · `--sidebar-w` 300 · `--inspector-w` 300 (264/248 below 1100 px) · `--content-max` 1120 |
| Motion | `--ease-out`, `--duration-fast` 120 ms, `--duration-normal` 200 ms; `prefers-reduced-motion` turns animation off globally |
| Layers | `--z-sticky` 10 · `--z-popover` 50 · `--z-dialog` 100 · `--z-toast` 200 · `--z-tooltip` 300 |
| Surfaces | `--color-bg` (page), `--color-surface` (cards, bars), `--color-surface-raised` (dialogs, selected segment), `--color-surface-sunken` (wells, canvases, tracks), `--color-surface-hover` |
| Lines | `--color-border` (hairlines), `--color-border-strong` (secondary buttons, dividers), `--color-border-control` (form controls: 3:1) |
| Text | `--color-text`, `--color-text-muted` (secondary, AA), `--color-text-subtle` (placeholders, AA), `--color-text-inverse` (tooltips) |
| Accent | `--color-accent` (terracotta; fills), `-hover`, `-active`, `--color-accent-soft` (tints), `-soft-hover`, `--color-accent-text` (accent as text), `--color-on-accent` (text on accent and danger fills) |
| Focus | `--color-focus` (2 px outline, offset 2), `--color-focus-halo` (field glow) |
| Status | `--color-{success,warn,danger,info}` (icons, fills), `…-soft` (backgrounds), `…-text` (text on soft or surface); `--color-danger-hover` |
| Misc | `--color-overlay` (dialog backdrop), `--color-skeleton`, `--color-grid-dot` (graph-paper backdrop) |
| Shadows | `--shadow-1` (resting cards, buttons), `--shadow-2` (hover, raised cards), `--shadow-3` (dialogs, toasts) |

Themes: light by default; dark follows `prefers-color-scheme` unless the user picked one, written as
`<html data-theme="light|dark">`. The choice is `appStore.prefs.theme`; the shell mirrors it to
`localStorage['cpg.theme']` so `index.html` applies it before the first paint (and so it survives a reload until
T8 persists the preferences). Never write `data-theme` yourself; call `setTheme(t)` (`ui/shell/theme.ts`).

## The design system API (`src/ui/common`, import from `'…/ui/common'`)

Rules every component follows: keyboard reachable with the one visible focus style; an accessible name on
everything interactive; color never alone (status tones always have text and an icon); `type="button"` by default.

| Component | Props (besides normal HTML attributes where noted) | Usage |
|---|---|---|
| `Button` | `variant?: 'primary' \| 'secondary' \| 'ghost' \| 'danger'` (default secondary) · `size?: 'sm' \| 'md' \| 'lg'` · `icon?`, `iconEnd?: IconName` · `loading?` (spinner, aria-busy, clicks ignored) · `disabledReason?: string` (stays focusable, aria-disabled, tooltip shows why) · `fullWidth?` · `ref?` · all `<button>` attributes | `<Button variant="primary" icon="share" onClick={…}>Export</Button>` — one primary per view |
| `IconButton` | `icon: IconName` · `label: string` (required: name + tooltip) · `shortcut?` ("⌘Z", shown in the tooltip) · `pressed?` (aria-pressed toggle) · `showTooltip?` (default true) · `tooltipPlacement?` · `variant?` (default ghost) · `size?` · `disabledReason?` | `<IconButton icon="undo" label="Undo" shortcut="⌘Z" onClick={undo} />` |
| `Tooltip` | `content` · `shortcut?` · `placement?: 'top' \| 'bottom'` (flips when no room) · `delay?` (ms, default 350) · `disabled?` · `children`: ONE focusable element | Hover after the delay, keyboard focus at once, Escape hides; portal + fixed position; sets aria-describedby while shown. Never the only copy of needed information |
| `Card` | `padding?: 'none' \| 'sm' \| 'md' \| 'lg'` · `elevation?: 'flat' \| 'raised'` · `as?: 'div' \| 'section' \| 'article' \| 'li'` · div attributes | `<Card padding="lg">…</Card>` |
| `CardHeader` | `title` · `subtitle?` · `icon?` · `actions?` · `level?: 2 \| 3 \| 4` | First child of a Card |
| `CardButton` | `title: string` (accessible name) · `description?` (aria-describedby) · `icon?` · `tone?: 'accent' \| 'neutral' \| 'info' \| 'success'` (icon tile) · `footer?` · `children` (e.g. an illustration) · button attributes | A whole card that is one button (start screen) |
| `Tabs` | `ariaLabel` · `items: { id, label, icon?, badge?, disabled? }[]` · `value: id \| null` · `onChange(id)` · `idBase` · `activation?: 'auto' \| 'manual'` · `variant?: 'line' \| 'pill'` · `size?` | WAI-ARIA tabs: one tab stop, ←/→ Home/End; `manual` = arrows focus, Enter selects |
| `TabPanel` | `idBase` · `id` · `children` · `className?` | Render only the selected panel; linked to its tab (`tabIds(idBase, id)`) |
| `TextField` | `label` · `value` · `onChange(value: string)` · `hint?` · `error?` · `labelHidden?` · `icon?` · `suffix?` · `size?` · `multiline?`, `rows?` · input attributes | `<TextField label="Name" value={v} onChange={setV} />` |
| `NumberField` | `label` · `value: number \| null` · `onChange(v)` · `kind?: 'number' \| 'length'` · `units?: 'in' \| 'cm'` · `suffix?` · `min?`, `max?` (value's unit: inches for lengths) · `step?` (display units; default 1, or 0.25 in / 0.5 cm) · `precision?` · `allowEmpty?` · `stepper?` (− / + buttons) · `hint?`, `error?`, `labelHidden?`, `disabled?`, `size?`, `placeholder?` | Lengths: value in INCHES, shown and typed in `units` (`prefs.units`). Commits on Enter/blur (a half-typed "1." is never a value), ↑/↓ step (Shift ×10, snapped to the step grid), Escape restores, clamps to [min, max], "12,5" accepted; non-numbers show "Enter a number" and change nothing. The unit is in the accessible name ("Width (centimeters)") |
| `Select<T>` | `label` · `value: T` · `onChange(v: T)` · `options: { value, label, disabled? }[]` or `groups: { label, options }[]` · `hint?`, `error?`, `labelHidden?`, `disabled?`, `size?` | Native `<select>` (platform keyboard and screen-reader behavior). `T` is inferred from `value` (`NoInfer` on options and onChange) |
| `Slider` | `label` · `value` · `onChange(v)` (while dragging) · `onCommit?(v)` (on release / key up / blur) · `min`, `max`, `step?` · `format?(v)` (shown value + aria-valuetext) · `endLabels?: [string, string]` · `hint?`, `disabled?`, `labelHidden?` | Use `onCommit` for full-quality recomputes (F2 step 6) |
| `Switch` | `label` · `checked` · `onChange(checked)` · `description?` · `showState?` ("On"/"Off" text) · `disabled?` · `size?` | role="switch", for settings that apply at once |
| `SegmentedControl<T>` | `value: T` · `onChange(v)` · `options: { value, label, icon?, ariaLabel?, disabled? }[]` · `label?` (visible) or `ariaLabel?` · `size?` · `fullWidth?` · `disabled?` | Radio group for 2–5 short choices: one tab stop, arrows move and select |
| `Field` + `useFieldIds(id?)`, `describedBy(ids, hint, error)` | `ids`, `label`, `labelHidden?`, `hint?`, `error?`, `aside?`, `required?` | Wrap a custom control in the standard label/hint/error frame with the aria wiring |
| `Dialog` | `open` · `onClose()` · `title` · `description?` · `children?` · `footer?` (primary action last) · `size?: 'sm' \| 'md' \| 'lg'` · `dismissible?` (Escape + backdrop; default true) · `initialFocus?: RefObject` | Native `<dialog>` modal + Tab wrap; focuses the first field (or `initialFocus`); returns focus on close |
| `ConfirmDialog` | `open` · `title` · `children?` · `confirmLabel` · `cancelLabel?` · `tone?: 'danger' \| 'primary'` · `onConfirm()` · `onCancel()` | Destructive confirms start focused on Cancel |
| `ToastView`, `ToastStack` | `tone`, `message`, `action?`, `onDismiss`, `onPause?` | Views only: show toasts with `notify.*` (`app/toasts.ts`); the shell renders them |
| `Banner` | `tone?: 'info' \| 'success' \| 'warn' \| 'danger' \| 'accent'` · `icon?` · `title?` · `children?` · `actions?` · `onDismiss?`, `dismissLabel?` · `role?` | In-page messages. Project-level banners go through `showProjectBanner` (below) |
| `Badge` | `tone?: 'neutral' \| 'accent' \| 'success' \| 'warn' \| 'danger' \| 'info'` · `icon?: IconName \| null` (status tones default to their icon) · `variant?: 'soft' \| 'solid' \| 'outline'` · `size?: 'sm' \| 'md'` | `<Badge tone="success">Counts OK</Badge>` (validator badges, mode labels) |
| `Chip` | `children` · `tone?` · `icon?` · `swatch?` (color dot, always next to text) · `onClick?` (toggle button, `selected?`) · `onRemove?`, `removeLabel?` · `title?` | Palette entries ("A · Cherry"), auto-repair chips, filters |
| `EmptyState` | `icon?` or `art?` · `title` · `children?` · `actions?` · `variant?: 'plain' \| 'panel'` (dashed frame) · `size?` · `level?: 1–4` | What a view shows before it has content |
| `Spinner` | `size?` · `label?` (role=status when labelled) | Inline busy state next to text |
| `ProgressBar` | `value: number (0..1) \| null` (null = indeterminate) · `label?` · `showValue?` · `size?: 'sm' \| 'md'` · `tone?` | Downloads, builds |
| `TabLayout` | `sidebar?`, `sidebarLabel?` · `inspector?`, `inspectorLabel?` · `toolbar?` · `children` (main) · `mainLabel?` · `mainPadding?: 'none' \| 'md' \| 'lg'` · `mainBackdrop?: 'plain' \| 'canvas'` (dotted graph paper) | The layout of a workspace tab (below) |
| `Panel` | `title` · `icon?` · `actions?` · `collapsible?`, `defaultOpen?` · `children` | A titled settings group inside a sidebar/inspector |
| `Sidebar` | `children` | A side region's stack of Panels |
| `Stack` | `direction?` · `gap?: 0–8` (token steps) · `align?` · `justify?` · `wrap?` · div attributes | Flex rows/columns on the spacing scale |
| `Toolbar`, `ToolbarDivider` | `label` · `children` | role="toolbar" rows of IconButtons |
| `Divider`, `Kbd`, `VisuallyHidden` | — | A rule; a key cap; screen-reader-only text |
| `DropZone` | `onFiles(files)` · `onReject?(files)` · `accept?` (input syntax) · `multiple?` · `title` · `hint?` · `icon?` · `buttonLabel?` · `disabled?` · `size?` · `children?` | Drag-and-drop, click anywhere or the "Choose file" button, or paste; filters by `accept` (`fileMatchesAccept`) |
| `Icon` | `name: IconName` · `size?` (18) · `label?` (then role=img) · `strokeWidth?` · `className?`, `style?` | 24-px grid, 1.75 px strokes, `currentColor`; decorative unless labelled |

Icons (`IconName`): arrow-left, arrow-right, undo, redo, grid, printer, download, upload, share, image, images,
camera, cube, sparkles, message, inbox, import, chart, list, yarn, hook, palette, ruler, plus, minus, x, check,
chevron-down/up/left/right, info, warning, error, success, sun, moon, monitor, pencil, folder, clock, hourglass,
copy, trash, more, search, external, eye, layers, sliders, refresh, file, cloud-off, lock, wand, keyboard, dot.
Drawn for this app; add new ones in `Icon.tsx` (S0 lane) in the same style.

Helpers: `units.ts` — `CM_PER_IN`, `toDisplayLength(in, units)`, `fromDisplayLength(v, units)`,
`formatLength(in, units, precision?)` ("12.5 in"), `formatNumber(v, precision?)`, `parseNumber(text)`;
`files.ts` — `fileMatchesAccept(file, accept)`; `focus.ts` — `focusableIn(root)`; `tabIds(idBase, id)`; `cx(...)`.

## The shell, and how a track fills it

**Routes** (`app/router.ts` over appStore): `#/` start · `#/p/<id>` → redirected (replace) to the project's
default tab · `#/p/<id>/<tab>` · `#/p/<id>/qa` the wizard. Navigate with `navigate(route)` (history entry) or
`navigate(route, { replace: true })`; never write `location.hash` yourself.

**Tab registry** (`app/tabs.ts`, final): 2D = Source · Chart · Pattern · Materials · Export; 3D = Photos (a photo
project — origin `multiview`/`single` — or any project with photo views) · Import (origin `claude-design` or
`describe`, `qa.awaiting`, or imports) · Shape · Pattern (with `<YarnSizePanel context="pattern" />` as
`settingsSlot`) · Materials · Export. `defaultRouteTab(doc)`: the wizard for a "Describe a toy" project with no
model and no prompt out, else the first visible tab. A track implements its tab by replacing its stub file
(same export name, same props, drop `__stub`); the registry never changes.

**Workspace frame** (`ui/shell/Workspace.tsx`, top to bottom): top bar (Projects, editable name — rename is one
undo step "Rename project" —, 2D/3D badge, save chip, undo/redo with the history labels, keyboard shortcuts,
theme, Print / PDF, Export) · project banners · tab bar · the tab (inside its own `ErrorBoundary` and
`Suspense`) · status bar.

**Filling a tab**: render one `TabLayout`:

```tsx
export function ChartTab() {
  return (
    <TabLayout
      sidebar={<Sidebar><Panel title="Size" icon="ruler">…</Panel><Panel title="Colors" icon="palette">…</Panel></Sidebar>}
      toolbar={<Toolbar label="Chart tools"><IconButton icon="pencil" label="Paint" pressed />…</Toolbar>}
      inspector={<Sidebar><Panel title="Selection">…</Panel></Sidebar>}
      mainPadding="none"
      mainBackdrop="canvas"
    >
      <ChartCanvas />
      <StatusItems>
        <Badge tone="success">Stitch counts OK</Badge>
        <span>Workability 82</span>
      </StatusItems>
    </TabLayout>
  );
}
```

- **Status bar**: `<StatusItems>` (from `ui/shell`) portals its children into the left of the status bar while the
  tab is mounted (validation badges, metrics). The right side shows derivedStore jobs by itself: a running job
  with its progress (`setJobProgress`) and a failed one as a danger badge — name jobs with the kinds or a short
  id (`depth`, `import`; labels in `ui/shell/jobs.ts`).
- **Project banners** (above the tab bar): `showProjectBanner({ id, kind, tone, title, message?, actions?,
  dismissible? })`, `dismissProjectBanner(id)` from `ui/shell`. Kinds `read-only`, `conflict-copy`,
  `reload-for-update`, `save-failed`, `info` (§5.5.2). The shell derives two banners itself: "Waiting for your
  Claude Design result · Import Claude Design result · Copy prompt again · Dismiss" while `doc.qa.awaiting` is set
  (Import → the Import tab; Copy prompt again → the wizard route, where T7 offers the copy; Dismiss clears
  `qa.awaiting` as one undo step), and a plain read-only notice while `projectStore.readOnly` — replaced by T8's
  own banner of kind `read-only` (with "Edit here instead" / "Take over") once T8 posts one. Banners clear when
  another project opens.
- **Toasts**: `notify.info|success|warn|error(message, { key?, action?, timeoutMs? })` from `app/toasts.ts`.
- **Errors**: a throw inside a tab shows the error card in that tab only; the project is untouched.
- **Undo/redo**: ⌘Z / Ctrl+Z, ⇧⌘Z / Ctrl+Shift+Z / Ctrl+Y act on `projectStore` history outside text fields (in a
  field the browser's text undo runs); "?" lists the shortcuts. Coalesce drags with `{ coalesceKey }` and call
  `endCoalescing()` on pointer-up so one drag is one undo step.

**Start screen**: `StartLayout` (shell) = header (logo, folder-mirror chip from the §5.5.4 probe, theme) · hero ·
the five cards (`NewProjectCards`: creation is the shell's) · "Your projects" with a `library` slot and
`libraryActions`. `ProjectGrid` renders `ProjectSummary` cards (thumbnail or a mode illustration, name, mode,
"Edited …", the "Waiting for Claude Design" badge, `renderActions` for duplicate/export/delete, `thumbnailUrl`,
`summaries === null` = loading skeletons). **Decision:** the `#/` entry stays T8's `ui/library/StartScreen`; the
Step 0 stub delegates to `StartLayout` + `ProjectGrid` with the summaries of this tab. T8 replaces the stub,
keeps `StartLayout`, and passes its grid (with actions and thumbnails) and "Restore from folder or backup".

**Projects before T8** (`ui/shell/projectSession.ts`): the start cards call `createProject(kind)` →
`newProjectDoc` (2D: CYC 4 sc graphgan, no sources; 3D: CYC 4 `amigurumi_sc`, `threeD.origin` per card, default
`AmiSettings`, no model) → `projectStore.open` → the default route. The backend is a memory one: projects of this
tab only; leaving a project (library, another project) keeps its document AND assets in memory and closes it
(`discardUnsaved` is safe because the backend holds the changes); the library lists them. The save chip says
"Not saved yet" with the reason in its tooltip. When T8's `useAutosave` is implemented the chip switches to it by
itself (`ui/shell/saveStatus.ts`, chosen at module scope).

## The smoke test (`e2e/smoke.spec.ts`)

16 tests, every one failing on any console error or page error: the start screen (five cards, projects section,
"Folder mirror off" from `HEAD /__projects` → 204 + `x-cpg-mirror: off`); each of the five cards opens a workspace
with exactly the expected tabs, its stub, the "Not saved yet" chip, and every tab opens; default-tab redirect and
an unknown project; rename + undo/redo by buttons and keyboard + the library card reopening the project; the
keyboard path (skip link, Tab to the first card with a visible outline, Enter, arrow keys and End on the tabs,
"?" dialog and Escape); the theme cycle surviving a reload; screenshots (light + dark: start, 2D workspace, 3D
workspace, component gallery); **§5.4** a progress callback passed through `workers/client.ts`
(`setWorkerSpawner` + the test-only `e2e/workers/progress.worker.ts`) fires in a real worker — `[0.25, 0.5,
0.75, 1]` — and **a nested worker answers**: the test-only `e2e/workers/nested.worker.ts` spawns the app's real
`mesh.worker` with `new Worker(new URL(…), { type: 'module' })` (as `ami.worker` will) and its `supersede` and
`fit` answer; and the **cold-cache dev smoke**: the spec starts a second Vite dev server (the repo's
`vite.config.ts`, a fresh empty `cacheDir`, a free ephemeral port), opens the app, opens a 3D workspace, spins up
all six workers through `workers/client.ts`, waits 4 s and asserts exactly one document load and no "optimized
dependencies changed" message.

Screenshots are attached to every run and written to `e2e/screenshots/` only when missing or with
`CPG_SCREENSHOTS=1` (so a normal run never dirties the tree; refresh them with `CPG_SCREENSHOTS=1 npm run e2e`).

## Deviations from the spec, with reasons

1. **`Prefs.theme` added to `state/appStore.ts`** (`'system' | 'light' | 'dark'`, default `'system'`, sanitized).
   The brief asks for a manual theme toggle stored in appStore prefs; additive, with a test. T8 persists it with
   the other prefs; until then `localStorage['cpg.theme']` carries it across reloads (and paints the first frame).
2. **Photos tab visibility**: §5.3 says "when the project has photo views". A new "from photos" / "from one
   photo" project has no views yet, and the Photos tab is where they are added, so the predicate is "a photo
   project (origin `multiview` or `single`) or any project with photo views" (a Claude Design project that got
   photos shows it too).
3. **"Copy prompt again"** in the waiting banner goes to the wizard route (`#/p/<id>/qa`, which opens at the
   import step with "Copy prompt again", F4 step 1) instead of copying directly: building the prompt is T7's.
4. **Print / PDF** stays disabled (focusable, with the reason as a tooltip) until `buildPdf` is implemented and the
   project has a pattern without `error` issues; then it builds the PDF and opens it in a new tab (F8 "Print opens
   the same PDF in a new tab").
5. **Projects live in memory** until T8 (brief item 4), behind a `ProjectBackend` seam (below).
6. **e2e helpers outside `smoke.spec.ts`**: `e2e/workers/progress.worker.ts`, `e2e/workers/nested.worker.ts`
   (test-only workers, as the brief allows) and `e2e/gallery/` (a dev/test-only page that renders every common
   component, used for the component screenshots). `e2e/**` is integration-owned; these are clearly marked.
7. **`useAutosave().status` has no "unsaved"** (s0b-state request 11): the shell's chip has its own status
   `'not-saved'` for the memory backend.

## Ambiguities resolved

| Where | Reading |
|---|---|
| §5.3 "Q&A wizard is a project route, not a tab" | The wizard renders in the workspace under the same top bar and banners, with the tab bar showing no selected tab and a "Describe your toy" marker. |
| §5.7 "Restore from folder or backup" | A visible ghost button in the "Your projects" header, disabled with its reason until T8. |
| §5.7 status bar "worker progress" | From `derivedStore.jobs`: running jobs (with progress) and failed ones; "Ready" when none. |
| §5.7 save chip before persistence | "Not saved yet" (cloud-off icon) with the reason in the tooltip; "Read-only" (lock) while read-only. |
| Start screen ownership | Shell owns the frame and creation; T8 owns the library content and actions (see "Start screen"). |
| Default project names | "Untitled chart", "Untitled toy", "Untitled toy idea", "Claude Design import" (renamable in the top bar). |
| New-project defaults | CYC 4 (worsted); 2D `sc_graphgan`; 3D `amigurumi_sc`, `AmiSettings` classic / spiral / invdec / firm stuffing (§2.10.1) / lean 0.25 (§2.11.2), dialect/terms/hand from prefs. `rev: 0` (never saved). |

## Requests for integration

1. **Wire T8 into the shell** when it lands: `setProjectBackend(…)` with a backend on `createProjectRepository`
   (`create` = first save or `saveAsCopy`, `open` = `repo.open(id, 'edit')` + cached assets, `leave` =
   `useAutosave().flush()` semantics) — `ui/shell/projectSession.ts` is the one place; and `appStore.library` from
   `repo.list()`. The save chip switches to `useAutosave` by itself.
2. **T8's StartScreen** keeps `StartLayout` (the five cards create projects through the shell) and passes
   `ProjectGrid` with `renderActions`/`thumbnailUrl` and the restore button.
3. **T8 banners**: post read-only / conflict-copy / reload / save-failed banners with `showProjectBanner` (kinds
   as in §5.5.2); a `read-only` banner replaces the shell's notice.
4. **T7**: the waiting banner's "Copy prompt again" opens the wizard route; the wizard should offer the copy at
   once when `qa.awaiting` is set (F4 step 1).
5. **§5.3 wording**: say "Photos (a photo project, or one with photo views)" (deviation 2).
6. **Cold-cache check sensitivity (§6.2 acceptance)**: with Vite 8.3.2 (installed; the spec measured 8.3.1) I
   could not make the reload of §6.2 item 2 happen any more: with `optimizeDeps.entries` cut to `index.html`
   only, and with a module that pulls three, fflate and json5 in late, the dev server optimized the new
   dependencies ("dependencies optimized: fflate, json5, three") without reloading the page — one document load
   each time. The committed test therefore passes, but its failure mode could not be demonstrated on this Vite;
   keep the `entries` setting anyway (a later dependency whose chunks overlap may still force a reload).
7. **Icon additions** belong to the S0 lane (`ui/common/Icon.tsx`); tracks that need an icon before then can use
   their own inline SVG in the same style (24 grid, 1.75 stroke, currentColor).

## How it was verified

(Filled in at the end of the sprint — see the final section.)
