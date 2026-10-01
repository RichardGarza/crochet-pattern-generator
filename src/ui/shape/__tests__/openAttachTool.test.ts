// The v1.5 stub of `openAttachTool` (§5.2.1). T6 replaces the stub and this test with its own.
import { describe, expect, it } from 'vitest';
import { NotImplementedError, isImplemented } from '../../../core/stub';
import { openAttachTool } from '../openAttachTool';

describe('openAttachTool (frozen in design v1.5)', () => {
  it.runIf(!isImplemented(openAttachTool))('is a stub that throws NotImplementedError', () => {
    expect(openAttachTool.__stub).toBe(true);
    expect(() => openAttachTool('ear_l')).toThrow(NotImplementedError);
  });
});
