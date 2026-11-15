import {
    isGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';

import type { BlackBoxRallarFormationSummary } from './live-rtc-formation-operations.ts';

/** The accepted layout one browser holds: its identity and the whole adjacency it routes over. */
export interface LiveRtcAcceptedLayout {
    readonly identity: GroupLayoutIdentity;
    readonly nextHopsBySessionId: Readonly<Record<string, readonly string[]>>;
}

/** Over three sessions a layout is the complete graph, a tree with one relay, or neither. */
export type LiveRtcLayoutShape =
    | Readonly<{ kind: 'complete'; }>
    | Readonly<{ kind: 'tree'; relaySessionId: string; leafSessionIds: readonly [string, string]; }>
    | Readonly<{ kind: 'other'; }>;

/** Undefined when the browser holds no accepted layout, or one without the whole adjacency. */
export function toLiveRtcAcceptedLayout(
    summary: BlackBoxRallarFormationSummary
): LiveRtcAcceptedLayout | undefined {
    const accepted = summary.accepted;
    const nextHopsBySessionId = accepted?.overlay.nextHopsBySessionId;
    if (accepted === undefined || nextHopsBySessionId === undefined || !isGroupLayoutIdentity(accepted.identity)) {
        return undefined;
    }
    return { identity: accepted.identity, nextHopsBySessionId };
}

/** An edge counts only when both of its ends list each other; a one-sided entry makes the layout `other`. */
export function resolveLiveRtcLayoutShape(
    layout: LiveRtcAcceptedLayout,
    sessionIds: readonly [string, string, string]
): LiveRtcLayoutShape {
    const pairs = [[0, 1, 2], [0, 2, 1], [1, 2, 0]] as const;
    const present: number[] = [];
    for (const [left, right, opposite] of pairs) {
        const forward = listsPeer(layout, sessionIds[left], sessionIds[right]);
        const backward = listsPeer(layout, sessionIds[right], sessionIds[left]);
        if (forward !== backward) {
            return { kind: 'other' };
        }
        if (forward) {
            present.push(opposite);
        }
    }
    if (present.length === 3) {
        return { kind: 'complete' };
    }
    if (present.length !== 2) {
        return { kind: 'other' };
    }
    const missingOpposite = [0, 1, 2].find((index) => !present.includes(index)) ?? 0;
    const leaves = pairs.find(([, , opposite]) => opposite === missingOpposite) ?? pairs[0];
    return {
        kind: 'tree',
        relaySessionId: sessionIds[missingOpposite],
        leafSessionIds: [sessionIds[leaves[0]], sessionIds[leaves[1]]]
    };
}

function listsPeer(layout: LiveRtcAcceptedLayout, sessionId: string, peerId: string): boolean {
    return layout.nextHopsBySessionId[sessionId]?.includes(peerId) ?? false;
}
