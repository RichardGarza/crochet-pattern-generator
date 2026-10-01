// Step 0 stub test. T6 owns this folder: replace this file with real tests when the renderer is implemented.
import { describe, expect, it } from 'vitest';
import { isImplemented, NotImplementedError } from '../../../core/stub';
import { renderPlacementImage } from '../placement';

describe('ui/shape/placement Step 0 stub', () => {
  it.runIf(!isImplemented(renderPlacementImage))('renderPlacementImage throws NotImplementedError', () => {
    expect(renderPlacementImage.__stub).toBe(true);
    expect(() => renderPlacementImage({} as never, 'body', [])).toThrow(NotImplementedError);
    expect(() => renderPlacementImage({} as never, 'body', [])).toThrow('renderPlacementImage not implemented');
  });
});
