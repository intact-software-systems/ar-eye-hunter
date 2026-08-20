import { describe, expect, it } from 'vitest';
import { resolveTopologyKindWithHysteresis } from '@shared-server/rallar-system/topology/planning/topology-kind-hysteresis.ts';

const DEFAULTS = {
  treeMinSize: 5,
  meshMinSize: 16,
  meshExitWidth: 4,
  treeExitWidth: 0,
};

describe('topology kind hysteresis', () => {
  it('selects entry kinds without a previous kind', () => {
    expect(resolve(4, undefined)).toBe('star');
    expect(resolve(5, undefined)).toBe('tree');
    expect(resolve(15, undefined)).toBe('tree');
    expect(resolve(16, undefined)).toBe('mesh');
  });

  it('upgrades immediately at the entry thresholds', () => {
    expect(resolve(16, 'tree')).toBe('mesh');
    expect(resolve(5, 'star')).toBe('tree');
  });

  it('holds mesh across the band and exits below it', () => {
    expect(resolve(15, 'mesh')).toBe('mesh');
    expect(resolve(12, 'mesh')).toBe('mesh');
    expect(resolve(11, 'mesh')).toBe('tree');
  });

  it('does not oscillate across the boundary under a size flap', () => {
    let kind: 'star' | 'tree' | 'mesh' = 'tree';
    const kinds: string[] = [];
    for (const size of [15, 16, 15, 16, 15, 14, 13, 12, 11, 12, 15, 16]) {
      kind = resolve(size, kind);
      kinds.push(kind);
    }
    // One upgrade at 16, held through the 12..15 band, one downgrade at 11,
    // one re-upgrade at 16 — not a flip per step.
    expect(kinds).toEqual(['tree', 'mesh', 'mesh', 'mesh', 'mesh', 'mesh', 'mesh', 'mesh', 'tree', 'tree', 'tree', 'mesh']);
  });

  it('keeps the mesh exit at or above treeMinSize when the band is wide', () => {
    expect(
      resolveTopologyKindWithHysteresis({
        activeSize: 6,
        treeMinSize: 5,
        meshMinSize: 8,
        meshExitWidth: 50,
        treeExitWidth: 0,
        previousKind: 'mesh',
      }),
    ).toBe('mesh');
    expect(
      resolveTopologyKindWithHysteresis({
        activeSize: 4,
        treeMinSize: 5,
        meshMinSize: 8,
        meshExitWidth: 50,
        treeExitWidth: 0,
        previousKind: 'mesh',
      }),
    ).toBe('star');
  });

  it('applies the tree exit band only against star downgrades', () => {
    expect(
      resolveTopologyKindWithHysteresis({
        ...DEFAULTS,
        activeSize: 4,
        treeExitWidth: 1,
        previousKind: 'tree',
      }),
    ).toBe('tree');
    expect(
      resolveTopologyKindWithHysteresis({
        ...DEFAULTS,
        activeSize: 3,
        treeExitWidth: 1,
        previousKind: 'tree',
      }),
    ).toBe('star');
  });

  it('never returns tree for sizes below two under any band', () => {
    expect(
      resolveTopologyKindWithHysteresis({
        ...DEFAULTS,
        activeSize: 1,
        treeExitWidth: 50,
        previousKind: 'tree',
      }),
    ).toBe('star');
  });
});

function resolve(activeSize: number, previousKind: 'star' | 'tree' | 'mesh' | undefined): 'star' | 'tree' | 'mesh' {
  return resolveTopologyKindWithHysteresis({
    ...DEFAULTS,
    activeSize,
    previousKind,
  });
}
