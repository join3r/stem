import { describe, expect, it } from 'vitest';
import { dropTileLayout, orderDropDirs } from '../../src/renderer/files/drop-layout';

describe('dropTileLayout', () => {
  it('uses one roomy column for a few folders', () => {
    const l = dropTileLayout(3, 700, 900);
    expect(l).toMatchObject({ cols: 1, overflow: false, roomy: true });
  });

  it('adds columns before overflowing', () => {
    const l = dropTileLayout(20, 700, 900);
    expect(l.overflow).toBe(false);
    expect(l.cols).toBeGreaterThan(1);
    expect(l.capacity).toBeGreaterThanOrEqual(20);
  });

  it('overflows when even the widest grid cannot fit them', () => {
    const l = dropTileLayout(200, 700, 900);
    expect(l.overflow).toBe(true);
    expect(l.capacity).toBeLessThan(200);
    expect(l.capacity).toBeGreaterThan(1);
  });

  it('a narrow window caps the columns', () => {
    expect(dropTileLayout(200, 300, 900).cols).toBe(1);
  });
});

describe('orderDropDirs', () => {
  it('puts recent folders that still exist first', () => {
    expect(orderDropDirs(['a', 'b', 'c', 'd'], ['c', 'gone', 'a'])).toEqual(['c', 'a', 'b', 'd']);
  });
});
