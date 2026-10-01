// DEV / TEST ONLY — the design-system gallery: every ui/common component, for the smoke test's component
// screenshots and for tracks looking for the right component. Served by the dev server at /e2e/gallery/ (add
// ?theme=dark to force the dark theme). Not part of the app or its build.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/ui/common/tokens.css';
import '../../src/ui/common/components.css';
import '../../src/ui/shell/shell.css';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHeader,
  Chip,
  Dialog,
  DropZone,
  EmptyState,
  IconButton,
  NumberField,
  Panel,
  ProgressBar,
  SegmentedControl,
  Select,
  Sidebar,
  Slider,
  Spinner,
  Stack,
  Switch,
  Tabs,
  TextField,
  ToastView,
  Toolbar,
  ToolbarDivider,
  Kbd,
} from '../../src/ui/common';

const theme = new URLSearchParams(location.search).get('theme');
if (theme === 'dark' || theme === 'light') document.documentElement.setAttribute('data-theme', theme);

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card padding="md">
      <CardHeader title={title} level={2} />
      {children}
    </Card>
  );
}

export function Gallery() {
  const [units, setUnits] = useState<'in' | 'cm'>('in');
  const [width, setWidth] = useState<number | null>(36);
  const [thick, setThick] = useState(0.9);
  const [border, setBorder] = useState(true);
  const [tab, setTab] = useState('chart');
  const [weight, setWeight] = useState('4');
  const [name, setName] = useState('Sunflower blanket');
  const [open, setOpen] = useState(false);
  return (
    <div style={{ padding: 24, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 16, alignItems: 'start' }}>
      <Section title="Buttons">
        <Stack gap={3}>
          <Stack direction="row" gap={2} wrap>
            <Button variant="primary" icon="share">
              Export
            </Button>
            <Button icon="printer">Print / PDF</Button>
            <Button variant="ghost" icon="grid">
              Projects
            </Button>
            <Button variant="danger" icon="trash">
              Delete
            </Button>
          </Stack>
          <Stack direction="row" gap={2} wrap align="center">
            <Button size="sm">Small</Button>
            <Button size="lg" variant="primary">
              Large
            </Button>
            <Button loading>Building</Button>
            <Button disabledReason="Add a picture first">Not yet</Button>
          </Stack>
          <Toolbar label="Chart tools">
            <IconButton icon="pencil" label="Paint" pressed />
            <IconButton icon="palette" label="Replace color" />
            <IconButton icon="wand" label="Clean up" />
            <ToolbarDivider />
            <IconButton icon="undo" label="Undo" shortcut="⌘Z" />
            <IconButton icon="redo" label="Redo" />
          </Toolbar>
        </Stack>
      </Section>
      <Section title="Fields">
        <Stack gap={4}>
          <TextField label="Project name" value={name} onChange={setName} hint="Shown on the PDF cover" />
          <Stack direction="row" gap={3}>
            <NumberField label="Finished width" kind="length" units={units} value={width} onChange={setWidth} min={1} max={120} stepper />
            <Select
              label="Yarn weight"
              value={weight}
              onChange={setWeight}
              options={[
                { value: '3', label: '3 · DK' },
                { value: '4', label: '4 · Worsted' },
                { value: '5', label: '5 · Bulky' },
              ]}
            />
          </Stack>
          <SegmentedControl label="Units" value={units} onChange={setUnits} options={[{ value: 'in', label: 'Inches' }, { value: 'cm', label: 'Centimeters' }]} fullWidth />
          <Slider label="Thickness" value={thick} onChange={setThick} min={0.3} max={1.5} step={0.05} format={(v) => `${Math.round(v * 100)}%`} endLabels={['Flat', 'Round']} />
          <Switch label="Border" description="One round of single crochet around the chart" checked={border} onChange={setBorder} />
          <NumberField label="Colors" value={40} onChange={() => {}} suffix="colors" error="At most 16 colors" />
        </Stack>
      </Section>
      <Section title="Status">
        <Stack gap={3}>
          <Stack direction="row" gap={2} wrap>
            <Badge>Neutral</Badge>
            <Badge tone="accent" icon="sparkles">
              New
            </Badge>
            <Badge tone="success">Counts OK</Badge>
            <Badge tone="warn">3 warnings</Badge>
            <Badge tone="danger">1 error</Badge>
            <Badge tone="info">Tip</Badge>
          </Stack>
          <Stack direction="row" gap={2} wrap>
            <Chip swatch="#c0392b" onRemove={() => {}} removeLabel="Remove Cherry">
              A · Cherry
            </Chip>
            <Chip swatch="#f4d03f" selected onClick={() => {}}>
              B · Lemon
            </Chip>
            <Chip icon="ruler">12 × 16 in</Chip>
          </Stack>
          <ProgressBar value={0.62} label="Building the 3D model" />
          <ProgressBar value={null} label="Downloading depth model" size="sm" />
          <Stack direction="row" gap={2} align="center">
            <Spinner /> <span>Working…</span> <Kbd>⌘</Kbd>
            <Kbd>Z</Kbd>
          </Stack>
        </Stack>
      </Section>
      <Section title="Banners and toasts">
        <Stack gap={2}>
          <Banner tone="neutral" icon="hourglass" title="Waiting for your Claude Design result" actions={<Button size="sm" variant="primary">Import</Button>} />
          <Banner tone="warn" icon="lock" title="Read-only">
            Open in another tab.
          </Banner>
          <Banner tone="danger" title="Not saved" actions={<Button size="sm">Export a backup</Button>} onDismiss={() => {}} />
          <Banner tone="success" title="Imported">
            17 parts, 2 repairs.
          </Banner>
          <ToastView tone="success" message="Prompt copied" onDismiss={() => {}} action={{ label: 'Undo', run: () => {} }} />
          <ToastView tone="error" message="Could not read that file" onDismiss={() => {}} />
        </Stack>
      </Section>
      <Section title="Tabs, panels, drop zone">
        <Stack gap={4}>
          <Tabs
            idBase="g"
            ariaLabel="Example tabs"
            variant="pill"
            value={tab}
            onChange={setTab}
            items={[
              { id: 'chart', label: 'Chart', icon: 'chart' },
              { id: 'pattern', label: 'Pattern', icon: 'list' },
              { id: 'materials', label: 'Materials', icon: 'yarn' },
            ]}
          />
          <DropZone title="Drop a picture here" hint="JPG, PNG, WebP or HEIC" accept="image/*" onFiles={() => {}} size="sm" />
          <Button onClick={() => setOpen(true)}>Open a dialog</Button>
          <Dialog
            open={open}
            onClose={() => setOpen(false)}
            title="Delete “Sunflower blanket”?"
            description="It moves to the folder backups; this cannot be undone here."
            footer={
              <>
                <Button onClick={() => setOpen(false)}>Cancel</Button>
                <Button variant="danger" onClick={() => setOpen(false)}>
                  Delete
                </Button>
              </>
            }
          />
        </Stack>
      </Section>
      <Card padding="none">
        <Sidebar>
          <Panel title="Size" icon="ruler">
            <NumberField label="Height" kind="length" units={units} value={8} onChange={() => {}} />
          </Panel>
          <Panel title="Colors" icon="palette" collapsible>
            <EmptyState size="sm" icon="palette" title="No colors yet">
              Colors appear once there is a chart.
            </EmptyState>
          </Panel>
        </Sidebar>
      </Card>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
