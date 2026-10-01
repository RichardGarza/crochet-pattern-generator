// Track T6.1 — the Shape tab's pure helpers: the editor store, the size-field specs, the per-part geometry
// cache over the shared builder, and the procedural yarn look.
import { describe, expect, it } from 'vitest';
import type { Part } from '../../../types/model';
import { teddy } from '../../../state/slices/__tests__/teddyProject';
import { movePart, scalePart } from '../../../state/slices/model3d';
import { dimSpecs, dimValue, prettyName, TYPE_NAMES } from '../dimSpecs';
import { createEditorStore, selectPrimary, transformScope } from '../editorStore';
import { buildPartGeometry, geometryKey, PartGeometryCache } from '../partGeometry';
import { stitchHeight, stitchNormalMap, stitchRepeat, yarnMaterial } from '../yarnLook';

describe('editor store', () => {
  it('selection: click replaces, ⇧ toggles and makes the added part primary, null clears, prune drops gone parts', () => {
    const s = createEditorStore();
    s.getState().select('head');
    expect(s.getState().selection).toEqual(['head']);
    s.getState().select('body', { additive: true });
    expect(s.getState().selection).toEqual(['head', 'body']);
    expect(selectPrimary(s.getState())).toBe('body');
    s.getState().select('head', { additive: true });
    expect(s.getState().selection).toEqual(['body']);
    s.getState().select(null, { additive: true }); // ⇧-click on empty space keeps the selection
    expect(s.getState().selection).toEqual(['body']);
    s.getState().setHovered('ear_l');
    s.getState().prune(new Set(['head']));
    expect(s.getState().selection).toEqual([]);
    expect(s.getState().hovered).toBeNull();
    s.getState().setSelection(['a', 'a', 'b']);
    expect(s.getState().selection).toEqual(['a', 'b']);
    s.getState().select(null);
    expect(selectPrimary(s.getState())).toBeNull();
  });

  it('a no-op leaves the state object alone (no re-render)', () => {
    const s = createEditorStore();
    s.getState().select('head');
    const before = s.getState();
    s.getState().select('head');
    s.getState().setTool('select');
    s.getState().setLayer('shadow', true);
    s.getState().toggleCollapsed('x', false);
    s.getState().prune(new Set(['head']));
    expect(s.getState()).toBe(before);
  });

  it('camera requests count up; reset restores the defaults', () => {
    const s = createEditorStore();
    s.getState().requestCamera('front');
    s.getState().requestCamera('front');
    expect(s.getState().camera).toEqual({ view: 'front', nonce: 2 });
    s.getState().setTool('move');
    s.getState().setFollowAttached(false);
    s.getState().toggleCollapsed('head');
    s.getState().reset();
    expect(s.getState()).toMatchObject({ tool: 'select', followAttached: true, selection: [], camera: { view: 'home', nonce: 0 } });
    expect(s.getState().collapsed.size).toBe(0);
  });

  it('transformScope: the toggle, inverted while ⌥ is held', () => {
    expect(transformScope(true, false)).toBe('subtree');
    expect(transformScope(true, true)).toBe('alone');
    expect(transformScope(false, false)).toBe('alone');
    expect(transformScope(false, true)).toBe('subtree');
  });
});

describe('size fields', () => {
  it('every editable primitive has fields; round sizes are diameters', () => {
    for (const type of Object.keys(TYPE_NAMES) as Part['type'][]) {
      const specs = dimSpecs(type);
      if (type === 'lathe' || type === 'mesh') expect(specs).toEqual([]);
      else expect(specs.length).toBeGreaterThan(0);
    }
    const sphere: Part = { id: 's', type: 'sphere', dims: { r: 0.6 }, position: [0, 0, 0], color: 'c' };
    expect(dimValue(sphere, dimSpecs('sphere')[0])).toBeCloseTo(1.2, 12);
    const torus: Part = { id: 't', type: 'torus', dims: { R: 1, r: 0.2 }, position: [0, 0, 0], color: 'c' };
    expect(dimValue(torus, dimSpecs('torus')[2])).toBe(360);
    expect(prettyName('caramel_yarn')).toBe('Caramel yarn');
    expect(prettyName('')).toBe('');
  });
});

describe('part geometry from the shared builder (unitScale = 1)', () => {
  it('a move does not change the geometry key; a resize does; the cache reuses and disposes', () => {
    const m = teddy();
    const head = m.parts.find((p) => p.id === 'head')!;
    const moved = movePart(m, 'head', [1, 0, 0]);
    expect(geometryKey(moved, moved.parts.find((p) => p.id === 'head')!)).toBe(geometryKey(m, head));
    const bigger = scalePart(m, 'head', [1.1, 1, 1]);
    expect(geometryKey(bigger, bigger.parts.find((p) => p.id === 'head')!)).not.toBe(geometryKey(m, head));

    const cache = new PartGeometryCache();
    const first = cache.sync(m);
    expect(first.size).toBe(m.parts.length);
    expect(first.get('eye_l')).toBe(first.get('eye_r')); // identical shapes share one geometry
    const second = cache.sync(moved);
    for (const p of m.parts) expect(second.get(p.id)).toBe(first.get(p.id));
    let disposed = 0;
    first.get('head')!.geometry.addEventListener('dispose', () => disposed++);
    const third = cache.sync(bigger);
    expect(third.get('head')).not.toBe(first.get('head'));
    expect(disposed).toBe(1);
    cache.dispose();
  });

  it('the geometry is the builder’s, in inches, in the part’s own frame', () => {
    const m = teddy();
    const head = m.parts.find((p) => p.id === 'head')!;
    const g = buildPartGeometry(m, head);
    g.geometry.computeBoundingBox();
    const box = g.geometry.boundingBox!;
    expect(box.max.x).toBeCloseTo(2.4, 3);
    expect(box.max.y).toBeCloseTo(2.15, 3);
    expect(g.vertexColors).toBe(false);
  });
});

describe('yarn look', () => {
  it('the stitch height field is bounded and tiles seamlessly', () => {
    for (let i = 0; i < 200; i++) {
      const u = (i * 0.37) % 2;
      const v = (i * 0.61) % 2;
      const h = stitchHeight(u, v);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(1);
    }
    const map = stitchNormalMap();
    expect(map.image.width).toBe(128);
    expect(stitchNormalMap()).toBe(map); // shared
  });

  it('stitch repeat follows the part’s size (one stitch ≈ 0.23 × 0.2 in)', () => {
    const small: Part = { id: 's', type: 'sphere', dims: { r: 0.5 }, position: [0, 0, 0], color: 'c' };
    const big: Part = { id: 'b', type: 'sphere', dims: { r: 2 }, position: [0, 0, 0], color: 'c' };
    const [us, vs] = stitchRepeat(small)!;
    const [ub, vb] = stitchRepeat(big)!;
    expect(ub).toBeGreaterThan(us * 3);
    expect(vb).toBeGreaterThan(vs * 3);
    expect(stitchRepeat({ id: 'm', type: 'mesh', dims: { meshRef: 'x', bboxIn: [1, 1, 1] }, position: [0, 0, 0], color: 'c' })).toBeNull();
    const mat = yarnMaterial({ hex: '#B07A4A', repeat: [10, 8] });
    expect(mat.roughness).toBeGreaterThan(0.9);
    expect(mat.normalMap?.repeat.x).toBe(10);
    expect(yarnMaterial({ hex: '#B07A4A', repeat: [10, 8], wireframe: true }).normalMap).toBeNull();
  });
});
