// The default test environment (vite.config.ts → test.environment = 'node'). Step 0 owned.
import { describe, expect, it } from 'vitest';

describe('default vitest environment: node', () => {
  it('has no DOM, so src/core code that touches one fails here before it fails in a worker', () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
  });

  it('cannot decode images, which is why src/core takes RgbaImage and tests read PNGs with core/kernel/png', () => {
    expect(typeof (globalThis as { createImageBitmap?: unknown }).createImageBitmap).toBe('undefined');
    expect(typeof (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas).toBe('undefined');
  });

  it('runs on Node >= 22.12', () => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    expect(major > 22 || (major === 22 && minor >= 12)).toBe(true);
  });
});
