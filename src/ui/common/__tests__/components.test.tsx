// @vitest-environment happy-dom
// The design-system components: accessible names and states, keyboard behavior, and the contracts tracks rely on.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Badge, Chip } from '../Badge';
import { Banner } from '../Banner';
import { Button, IconButton } from '../Button';
import { CardButton } from '../Card';
import { Dialog } from '../Dialog';
import { DropZone } from '../DropZone';
import { EmptyState } from '../EmptyState';
import { Icon } from '../Icon';
import { Panel, TabLayout } from '../Layout';
import { NumberField } from '../NumberField';
import { ProgressBar } from '../Progress';
import { SegmentedControl } from '../SegmentedControl';
import { Select } from '../Select';
import { Slider } from '../Slider';
import { Switch } from '../Switch';
import { TabPanel, Tabs } from '../Tabs';
import { TextField } from '../TextField';

describe('Button and IconButton', () => {
  it('a button is type="button" and clicks', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('type')).toBe('button');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('disabledReason keeps the button focusable, marks it aria-disabled and ignores clicks', () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabledReason="Add a picture first">
        Export
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Export' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // The reason is always referenced, before any tooltip shows.
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toBe('Add a picture first');
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('loading shows aria-busy and ignores clicks', () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Build
      </Button>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Build' }));
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Build' }).getAttribute('aria-busy')).toBe('true');
  });

  it('an IconButton is named by its label and can be a toggle', () => {
    render(<IconButton icon="eye" label="Show rings" pressed />);
    const button = screen.getByRole('button', { name: 'Show rings' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    // The icon itself is decorative.
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('the tooltip appears on hover after the delay and on Escape goes away', () => {
    vi.useFakeTimers();
    try {
      render(<IconButton icon="undo" label="Undo" shortcut="⌘Z" />);
      const button = screen.getByRole('button', { name: 'Undo' });
      fireEvent.mouseEnter(button.parentElement!);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      const tip = screen.getByRole('tooltip');
      expect(tip.textContent).toContain('Undo');
      expect(tip.textContent).toContain('⌘Z');
      // The tooltip repeats the label, so it is not added as a description (it would be read twice).
      expect(button.hasAttribute('aria-describedby')).toBe(false);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Icon', () => {
  it('is decorative unless labelled', () => {
    const { container } = render(
      <>
        <Icon name="yarn" />
        <Icon name="warning" label="Warning" />
      </>,
    );
    const [plain, labelled] = container.querySelectorAll('svg');
    expect(plain.getAttribute('aria-hidden')).toBe('true');
    expect(labelled.getAttribute('role')).toBe('img');
    expect(screen.getByRole('img', { name: 'Warning' })).toBeTruthy();
  });

  it('has the Shape tab mirror and link icons (design v1.5), drawn in strokes', () => {
    const { container } = render(
      <>
        <Icon name="mirror" />
        <Icon name="link" />
      </>,
    );
    for (const svg of container.querySelectorAll('svg')) expect(svg.querySelectorAll('path').length).toBeGreaterThanOrEqual(2);
  });
});

describe('CardButton', () => {
  it('is one button named by its title and described by its description', () => {
    render(<CardButton title="New 3D toy from photos" description="Photograph a toy." footer={<Badge>3D</Badge>} />);
    const button = screen.getByRole('button', { name: 'New 3D toy from photos' });
    const describedBy = button.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)?.textContent).toBe('Photograph a toy.');
  });
});

describe('Badge, Chip, Banner, EmptyState, ProgressBar', () => {
  it('status tones carry an icon and text, never color alone', () => {
    const { container } = render(<Badge tone="danger">2 errors</Badge>);
    expect(container.textContent).toBe('2 errors');
    expect(container.querySelector('[data-icon="error"]')).toBeTruthy();
  });

  it('a removable chip has a named remove button', () => {
    const onRemove = vi.fn();
    render(
      <Chip swatch="#c0392b" onRemove={onRemove} removeLabel="Remove Red">
        Red
      </Chip>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove Red' }));
    expect(onRemove).toHaveBeenCalled();
  });

  it('a danger banner is an alert with its actions', () => {
    const onDismiss = vi.fn();
    render(
      <Banner tone="danger" title="Not saved" actions={<Button size="sm">Export a backup</Button>} onDismiss={onDismiss}>
        The last save failed.
      </Banner>,
    );
    expect(screen.getByRole('alert').textContent).toContain('Not saved');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('an empty state has a heading at the asked level', () => {
    render(<EmptyState title="No photos yet" level={2} icon="images" />);
    expect(screen.getByRole('heading', { level: 2, name: 'No photos yet' })).toBeTruthy();
  });

  it('a progress bar reports its value', () => {
    render(<ProgressBar value={0.42} label="Building" />);
    const bar = screen.getByRole('progressbar', { name: 'Building' });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    render(<ProgressBar value={null} label="Waiting" />);
    expect(screen.getByRole('progressbar', { name: 'Waiting' }).hasAttribute('aria-valuenow')).toBe(false);
  });
});

describe('fields', () => {
  it('TextField: label, hint and error are wired', () => {
    render(<TextField label="Name" value="" onChange={() => {}} hint="Shown on the PDF" error="Required" />);
    const input = screen.getByLabelText('Name');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const ids = input.getAttribute('aria-describedby')!.split(' ');
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual(['Required', 'Shown on the PDF']);
  });

  it('NumberField (length): shows cm, reports inches, commits on Enter, clamps, steps with arrows', () => {
    function Harness() {
      const [v, setV] = useState<number | null>(10);
      return (
        <>
          <NumberField label="Width" kind="length" units="cm" value={v} onChange={setV} min={1} max={20} />
          <output data-testid="inches">{v}</output>
        </>
      );
    }
    render(<Harness />);
    const input = screen.getByLabelText('Width (centimeters)') as HTMLInputElement;
    expect(input.value).toBe('25.4');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '50,8' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('inches').textContent).toBe('20');
    fireEvent.change(input, { target: { value: '200' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('inches').textContent).toBe('20'); // clamped to max
    // ↓ steps 0.5 cm and snaps to the step grid: 50.8 → 50.5 cm.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(Number(screen.getByTestId('inches').textContent)).toBeCloseTo(50.5 / 2.54, 10);
    expect(input.value).toBe('50.5');
  });

  it('NumberField: text that is not a number is an error and changes nothing', () => {
    const onChange = vi.fn();
    render(<NumberField label="Colors" value={8} onChange={onChange} suffix="colors" />);
    const input = screen.getByLabelText('Colors (colors)');
    fireEvent.change(input, { target: { value: 'eight' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a number')).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('Select, Slider and Switch report their values', () => {
    const onSelect = vi.fn();
    const onSlide = vi.fn();
    const onSwitch = vi.fn();
    render(
      <>
        <Select<string> label="Yarn weight" value="4" onChange={onSelect} options={[{ value: '3', label: 'DK' }, { value: '4', label: 'Worsted' }]} />
        <Slider label="Thickness" value={0.9} min={0.3} max={1.5} step={0.05} onChange={onSlide} format={(v) => `${Math.round(v * 100)}%`} />
        <Switch label="Border" checked={false} onChange={onSwitch} />
      </>,
    );
    fireEvent.change(screen.getByLabelText('Yarn weight'), { target: { value: '3' } });
    expect(onSelect).toHaveBeenCalledWith('3');
    const slider = screen.getByLabelText('Thickness');
    expect(slider.getAttribute('aria-valuetext')).toBe('90%');
    fireEvent.change(slider, { target: { value: '1.2' } });
    expect(onSlide).toHaveBeenCalledWith(1.2);
    const toggle = screen.getByRole('switch', { name: 'Border' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(onSwitch).toHaveBeenCalledWith(true);
  });
});

describe('SegmentedControl and Tabs (keyboard)', () => {
  it('SegmentedControl is a radio group with one tab stop; arrows move and select', () => {
    function Harness() {
      const [v, setV] = useState<'us' | 'uk'>('us');
      return <SegmentedControl ariaLabel="Terms" value={v} onChange={setV} options={[{ value: 'us', label: 'US' }, { value: 'uk', label: 'UK' }]} />;
    }
    render(<Harness />);
    const us = screen.getByRole('radio', { name: 'US' });
    const uk = screen.getByRole('radio', { name: 'UK' });
    expect([us.tabIndex, uk.tabIndex]).toEqual([0, -1]);
    fireEvent.keyDown(us, { key: 'ArrowRight' });
    expect(uk.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(uk);
    fireEvent.keyDown(uk, { key: 'ArrowRight' }); // wraps
    expect(us.getAttribute('aria-checked')).toBe('true');
  });

  it('Tabs: arrows and Home/End move and select; disabled tabs are skipped; panels are linked', () => {
    function Harness() {
      const [v, setV] = useState('a');
      return (
        <>
          <Tabs
            idBase="t"
            ariaLabel="Views"
            value={v}
            onChange={setV}
            items={[
              { id: 'a', label: 'Alpha' },
              { id: 'b', label: 'Beta', disabled: true },
              { id: 'c', label: 'Gamma' },
            ]}
          />
          <TabPanel idBase="t" id={v}>
            panel {v}
          </TabPanel>
        </>
      );
    }
    render(<Harness />);
    const alpha = screen.getByRole('tab', { name: 'Alpha' });
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    const gamma = screen.getByRole('tab', { name: 'Gamma' });
    expect(gamma.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: 'Gamma' }).textContent).toBe('panel c');
    fireEvent.keyDown(gamma, { key: 'Home' });
    expect(alpha.getAttribute('aria-selected')).toBe('true');
    expect(alpha.getAttribute('aria-controls')).toBe('t-panel-a');
  });
});

describe('Dialog', () => {
  function Harness({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
    const [open, setOpen] = useState(initiallyOpen);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Delete project?" footer={<button type="button">Delete</button>}>
          <input aria-label="Type the name" />
        </Dialog>
      </>
    );
  }

  it('opens with focus on the first field, traps Tab, closes on Escape and returns focus', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    const field = screen.getByLabelText('Type the name');
    expect(document.activeElement).toBe(field);
    const dialog = field.closest('dialog')!;
    const del = screen.getByRole('button', { name: 'Delete' });
    del.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    // Wrapped to the first focusable element (the Close button in the header).
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(del);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByLabelText('Type the name')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('is labelled by its title', () => {
    render(<Harness initiallyOpen />);
    const dialog = document.querySelector('dialog')!;
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Delete project?');
  });
});

describe('DropZone', () => {
  it('passes accepted files on and reports the others', () => {
    const onFiles = vi.fn();
    const onReject = vi.fn();
    const { container } = render(<DropZone title="Drop a picture" accept="image/*" multiple onFiles={onFiles} onReject={onReject} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    const txt = new File(['y'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [png, txt] } });
    expect(onFiles).toHaveBeenCalledWith([png]);
    expect(onReject).toHaveBeenCalledWith([txt]);
    expect(screen.getByRole('button', { name: 'Choose files' })).toBeTruthy();
  });
});

describe('layout', () => {
  it('TabLayout names its regions; a collapsible Panel toggles with aria-expanded', () => {
    render(
      <TabLayout sidebar={<Panel title="Size" collapsible>content</Panel>} inspector={<p>details</p>} mainLabel="Chart">
        main
      </TabLayout>,
    );
    expect(screen.getByRole('complementary', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Chart' })).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'Size' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('content').closest('[hidden]')).toBeTruthy();
  });

  it('a collapsed Panel body is display: none in components.css (its flex rule must not beat the hidden attribute)', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/ui/common/components.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.ui-panel__body\[hidden\]\s*\{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toMatch(/display:\s*none/);
    // and it comes after the flex rule (same specificity would otherwise depend on order; [hidden] adds one)
    expect(css.indexOf('.ui-panel__body[hidden]')).toBeGreaterThan(css.indexOf('.ui-panel__body {'));
  });
});
