// Length display: inches inside, in or cm on screen (§0.1); number parsing and formatting of NumberField.
import { describe, expect, it } from 'vitest';
import { fileMatchesAccept } from '../files';
import { formatLength, formatNumber, fromDisplayLength, parseNumber, toDisplayLength } from '../units';

describe('units', () => {
  it('converts inches and centimeters exactly (1 in = 2.54 cm)', () => {
    expect(toDisplayLength(10, 'cm')).toBeCloseTo(25.4, 12);
    expect(fromDisplayLength(25.4, 'cm')).toBeCloseTo(10, 12);
    expect(toDisplayLength(10, 'in')).toBe(10);
    expect(formatLength(4, 'cm')).toBe('10.2 cm');
    expect(formatLength(12.5, 'in')).toBe('12.5 in');
  });
  it('formats without trailing zeros or a negative zero', () => {
    expect(formatNumber(12.5)).toBe('12.5');
    expect(formatNumber(3)).toBe('3');
    expect(formatNumber(3.14159, 2)).toBe('3.14');
    expect(formatNumber(-0.0001, 2)).toBe('0');
    expect(formatNumber(Number.NaN)).toBe('');
  });
  it('parses what people type', () => {
    expect(parseNumber('12,5')).toBe(12.5);
    expect(parseNumber(' +3 ')).toBe(3);
    expect(parseNumber('.5')).toBe(0.5);
    expect(parseNumber('-2')).toBe(-2);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('12in')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
  });
});

describe('fileMatchesAccept', () => {
  it('matches extensions, wildcards and exact types', () => {
    const png = { name: 'Cat.PNG', type: 'image/png' };
    const glb = { name: 'toy.glb', type: '' };
    expect(fileMatchesAccept(png, 'image/*')).toBe(true);
    expect(fileMatchesAccept(png, '.jpg, .png')).toBe(true);
    expect(fileMatchesAccept(glb, 'image/*')).toBe(false);
    expect(fileMatchesAccept(glb, '.glb,model/gltf-binary')).toBe(true);
    expect(fileMatchesAccept(glb, undefined)).toBe(true);
    expect(fileMatchesAccept({ name: 'a.zip', type: 'application/zip' }, 'application/zip')).toBe(true);
  });
});
