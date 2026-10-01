// Theme toggle: one button that cycles System → Light → Dark; its label says what it is and what comes next.
import { useAppStore, type ThemePref } from '../../state/appStore';
import { IconButton } from '../common/Button';
import type { IconName } from '../common/Icon';
import { nextTheme, setTheme } from './theme';

const ICON: Record<ThemePref, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' };
const NAME: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' };

export function ThemeToggle({ tooltipPlacement }: { tooltipPlacement?: 'top' | 'bottom' }) {
  const theme = useAppStore((s) => s.prefs.theme);
  const next = nextTheme(theme);
  return (
    <IconButton
      icon={ICON[theme]}
      label={`Theme: ${NAME[theme]} (switch to ${NAME[next]})`}
      tooltipPlacement={tooltipPlacement}
      onClick={() => setTheme(next)}
      data-testid="theme-toggle"
    />
  );
}
