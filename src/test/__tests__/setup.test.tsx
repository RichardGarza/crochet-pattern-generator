// @vitest-environment happy-dom
// UI tests opt into a DOM with the comment above; src/test/setup.ts then wires React Testing Library. Step 0 owned.
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

function Counter() {
  const [n, setN] = useState(0);
  return (
    <button type="button" onClick={() => setN(n + 1)}>
      clicked {n}
    </button>
  );
}

describe('happy-dom environment with src/test/setup.ts', () => {
  it('renders React components and handles events', () => {
    render(<Counter />);
    const button = screen.getByRole('button');
    expect(button.textContent).toBe('clicked 0');
    fireEvent.click(button);
    expect(button.textContent).toBe('clicked 1');
    // setup.ts marks the environment for React's act(), so a state update outside act() warns instead of
    // passing silently.
    expect((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT).toBe(true);
  });

  it('starts every test with an empty document (cleanup ran after the previous test)', () => {
    expect(document.body.innerHTML).toBe('');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('has the limits the UI seams are built around: no 2D canvas context and no lock manager', () => {
    // §6.1 rule 5: chart tools are pure functions, the 3D viewport is injectable, and locks come from fakes.
    expect(document.createElement('canvas').getContext('2d')).toBeNull();
    expect((navigator as { locks?: unknown }).locks ?? null).toBeNull();
  });
});
