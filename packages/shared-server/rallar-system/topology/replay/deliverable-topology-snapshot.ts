import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

export interface ToDeliverableTopologySnapshotInput {
    readonly planned: RallarOverlayTopologySnapshot | undefined;
    readonly accepted: RallarOverlayTopologySnapshot | undefined;
    /**
     * When delivery addresses one member, selection is member-aware: a
     * session named only in the held planned candidate still receives its
     * candidate assignment. Absent for broadcast repair, which delivers one
     * row to the members that row names.
     */
    readonly sessionId?: string;
}

/**
 * The delivery-content rule for repair and reconnect hydration (plan slice
 * 4c, product decisions 1/24/30): members converge on the layout carrying
 * traffic — the accepted row once a promotion produced one, the planned row
 * before that. Two qualifiers keep the rule honest. A planned removal
 * tombstone always wins: it is the teardown signal (I15), the accepted slot
 * only ever holds active layouts (a tombstone never promotes), and nothing
 * deletes the accepted row today — without this clause a torn-down overlay
 * would be resurrected from the stale accepted layout forever. And a
 * session named only in the planned candidate receives the candidate: under
 * a hold the candidate is what that member dials, and refusing it would
 * starve the very coverage the activation criterion measures.
 *
 * The replay *decision* deliberately does not use this rule — it compares
 * the log against the planned row, whose same-transaction write is the
 * corruption invariant. Only delivered content resolves here.
 */
export function toDeliverableTopologySnapshot(
    input: ToDeliverableTopologySnapshotInput
): RallarOverlayTopologySnapshot | undefined {
    const { planned, accepted, sessionId } = input;
    if (planned?.state === 'removed') {
        return planned;
    }
    if (
        sessionId !== undefined &&
        accepted !== undefined &&
        !accepted.activeSessionIds.includes(sessionId) &&
        planned !== undefined &&
        planned.activeSessionIds.includes(sessionId)
    ) {
        return planned;
    }
    return accepted ?? planned;
}
