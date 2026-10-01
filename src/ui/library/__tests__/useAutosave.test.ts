// Step 0 stub test. T8 owns this folder: replace this file with real tests when the hook is implemented.
import { describe, expect, it } from 'vitest';
import { isImplemented, NotImplementedError } from '../../../core/stub';
import { useAutosave } from '../useAutosave';

describe('ui/library/useAutosave Step 0 stub', () => {
  it.runIf(!isImplemented(useAutosave))('useAutosave throws NotImplementedError', () => {
    expect(useAutosave.__stub).toBe(true);
    expect(() => useAutosave()).toThrow(NotImplementedError);
    expect(() => useAutosave()).toThrow('useAutosave not implemented');
  });
});
