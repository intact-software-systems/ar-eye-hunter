import type { ReconcileGroupTopologyResult } from '@shared-server/rallar-system/topology/planning/group-topology-planning-contracts.ts';

/**
 * Narrows a planning result to its planned arm for tests that assert on the
 * candidate. One shared owner so every runtime's guard moves together when
 * the union grows a new action.
 */
export function requirePlannedTopology(
    result: ReconcileGroupTopologyResult
): Extract<ReconcileGroupTopologyResult, { action: 'planned'; }> {
    if (result.action !== 'planned') {
        throw new Error(`expected a planned topology result, got ${result.action}`);
    }
    return result;
}
