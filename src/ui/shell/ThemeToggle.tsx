// Theme switch: System · Light · Dark as three icon segments (one tab stop, arrows choose), each named and with
// a tooltip, so every choice is visible and one click always does what it says.
import { useAppStore, type ThemePref } from '../../state/appStore';
import { SegmentedControl } from '../common/SegmentedControl';
import { setTheme } from './theme';

const OPTIONS = [
  { value: 'system', icon: 'monitor', ariaLabel: 'System theme', label: '' },
  { value: 'light', icon: 'sun', ariaLabel: 'Light theme', label: '' },
  { value: 'dark', icon: 'moon', ariaLabel: 'Dark theme', label: '' },
] as const;

export function ThemeToggle() {
  const theme = useAppStore((s) => s.prefs.theme);
  return (
    <SegmentedControl<ThemePref>
      ariaLabel="Theme"
      size="sm"
      value={theme}
      onChange={setTheme}
      options={OPTIONS.map((o) => ({ ...o, tooltip: o.ariaLabel }))}
      className="shell-theme"
    />
  );
}
