import { describe, expect, it } from 'vitest';
import { band, num, percentileOf, plural, rankNote, scoreLabel } from '../src/format';

describe('num', () => {
  it('groups thousands in English regardless of the host locale', () => {
    // The bug this guards: toLocaleString() with no argument follows the OS
    // locale, so on an Italian machine 17024 rendered as "17.024" — which in
    // an English UI reads as seventeen.
    expect(num(17024)).toBe('17,024');
    expect(num(1234567)).toBe('1,234,567');
  });

  it('leaves small numbers alone', () => {
    expect(num(0)).toBe('0');
    expect(num(999)).toBe('999');
  });
});

describe('plural', () => {
  it('agrees with the count', () => {
    expect(plural(1, 'file')).toBe('1 file');
    expect(plural(0, 'file')).toBe('0 files');
    expect(plural(2, 'file')).toBe('2 files');
  });

  it('takes an irregular plural', () => {
    expect(plural(2, 'entry', 'entries')).toBe('2 entries');
  });

  it('groups the count too', () => {
    expect(plural(2500, 'line')).toBe('2,500 lines');
  });
});

describe('percentileOf', () => {
  it('reports the share of values below', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentileOf(values, 1)).toBe(0);
    expect(percentileOf(values, 6)).toBeCloseTo(0.5);
    expect(percentileOf(values, 11)).toBe(1);
  });

  it('does not divide by zero on an empty distribution', () => {
    expect(percentileOf([], 5)).toBe(0);
  });
});

describe('rankNote', () => {
  it('says nothing when the sample is too small to be a claim', () => {
    expect(rankNote([1, 2, 3], 3)).toBeNull();
  });

  it('describes where a value sits once there is a distribution', () => {
    const values = Array.from({ length: 100 }, (_, i) => i);
    expect(rankNote(values, 96)).toBe('higher than 96% of files here');
    expect(rankNote(values, 10)).toBe('in the ordinary range here');
  });
});

describe('band and scoreLabel', () => {
  it('bands a 0-100 composite', () => {
    expect(band(0)).toBe('low');
    expect(band(39)).toBe('low');
    expect(band(40)).toBe('elevated');
    expect(band(70)).toBe('high');
    expect(band(85)).toBe('severe');
    expect(band(100)).toBe('severe');
  });

  it('carries the scale and the reading together', () => {
    // a bare "36" is not actionable; "36/100 · low" is
    expect(scoreLabel(36)).toBe('36/100 · low');
    expect(scoreLabel(89)).toBe('89/100 · severe');
  });
});
