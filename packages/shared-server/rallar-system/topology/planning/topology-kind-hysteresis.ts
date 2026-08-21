import type { RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';

export const DEFAULT_MESH_EXIT_WIDTH = 4;
export const DEFAULT_TREE_EXIT_WIDTH = 0;

export interface ResolveTopologyKindInput {
    readonly activeSize: number;
    readonly treeMinSize: number;
    readonly meshMinSize: number;
    readonly meshExitWidth: number;
    readonly treeExitWidth: number;
    readonly previousKind: RallarRtcTopologyKind | undefined;
}

/**
 * Kind selection with hysteresis. Entry thresholds are the group's effective
 * `treeMinSize`/`meshMinSize`; exits sit a configured band WIDTH below their
 * entry (never an absolute size, so per-group config patches cannot invert
 * the band). Upgrades follow the entry thresholds immediately; a kind only
 * downgrades once the size falls below its exit, so a group oscillating
 * around a boundary keeps its kind instead of flapping tree<->mesh.
 */
export function resolveTopologyKindWithHysteresis(
    input: ResolveTopologyKindInput
): RallarRtcTopologyKind {
    const entryKind = input.activeSize >= input.meshMinSize
        ? 'mesh'
        : input.activeSize >= input.treeMinSize
        ? 'tree'
        : 'star';
    if (input.previousKind === undefined || entryKind === input.previousKind) {
        return entryKind;
    }
    if (input.previousKind === 'mesh') {
        const meshExitSize = Math.max(input.treeMinSize, input.meshMinSize - input.meshExitWidth);
        if (input.activeSize >= meshExitSize) {
            return 'mesh';
        }
        return entryKind;
    }
    if (input.previousKind === 'tree' && entryKind === 'star') {
        const treeExitSize = Math.max(2, input.treeMinSize - input.treeExitWidth);
        if (input.activeSize >= treeExitSize) {
            return 'tree';
        }
    }
    return entryKind;
}
