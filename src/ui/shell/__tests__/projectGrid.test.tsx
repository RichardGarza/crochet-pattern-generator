// @vitest-environment happy-dom
// The start screen's project grid: the `meta` slot added in design v1.5 (T8 request 15).
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '../../../types/project';
import { ProjectGrid } from '../start/ProjectGrid';

const summary = (id: string, name: string, updatedAt: string): ProjectSummary =>
  ({ id, name, mode: '3d', updatedAt });

describe('ProjectGrid meta slot', () => {
  const list = [summary('a1b2c3', 'Teddy', '2026-10-01T10:00:00Z'), summary('d4e5f6', 'Teddy', '2026-10-01T11:00:00Z')];

  it('renders an extra line per card from meta(summary), leaving the name untouched', () => {
    const onOpen = vi.fn();
    render(<ProjectGrid summaries={list} onOpen={onOpen} meta={(s) => `#${s.id.slice(0, 4)}`} />);
    expect(screen.getByText('#a1b2')).toBeTruthy();
    expect(screen.getByText('#d4e5')).toBeTruthy();
    expect(screen.getAllByText('Teddy')).toHaveLength(2);
    // the line sits inside the card's open button
    fireEvent.click(screen.getByText('#d4e5'));
    expect(onOpen).toHaveBeenCalledWith('d4e5f6');
  });

  it('renders nothing for null, undefined or false, and nothing without the prop', () => {
    const { container, rerender } = render(<ProjectGrid summaries={list} onOpen={() => {}} meta={(s) => (s.id === 'a1b2c3' ? null : false)} />);
    expect(container.querySelectorAll('.shell-project__meta--extra')).toHaveLength(0);
    rerender(<ProjectGrid summaries={list} onOpen={() => {}} meta={() => undefined} />);
    expect(container.querySelectorAll('.shell-project__meta--extra')).toHaveLength(0);
    rerender(<ProjectGrid summaries={list} onOpen={() => {}} />);
    expect(container.querySelectorAll('.shell-project__meta--extra')).toHaveLength(0);
    expect(container.querySelectorAll('.shell-project')).toHaveLength(2);
  });

  it('a 0 is shown (only null, undefined and false hide the line)', () => {
    const { container } = render(<ProjectGrid summaries={list.slice(0, 1)} onOpen={() => {}} meta={() => 0} />);
    expect(container.querySelector('.shell-project__meta--extra')?.textContent).toBe('0');
  });
});
