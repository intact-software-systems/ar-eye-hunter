import { describe, expect, it } from 'vitest';

import type {
    AdminRoomReshapeGate,
    AdminRoomTopologyPlan,
    AdminRoomTopologyPlansResponse
} from '@shared/api/admin-rooms/admin-room-topology-plans.ts';
import { decodeAdminRoomTopologyPlans } from '@shared/api/admin-rooms/decode-admin-room-topology-plans.ts';

const PLAN: AdminRoomTopologyPlan = {
    publicationId: 'publication-1',
    requestedAtEpochMs: 1_700_000_000_000,
    layout: { groupRevision: 4, presenceRevision: 9, version: 2, state: 'active' },
    topology: 'tree',
    memberCount: 8,
    degreeLimit: 3,
    plan: {
        plannedAtEpochMs: 1_700_000_000_010,
        replaced: { layout: { groupRevision: 3, presenceRevision: 8, version: 1, state: 'active' }, ageMs: 4_000 },
        causes: ['join'],
        delta: {
            joinedSessionCount: 1,
            leftSessionCount: 0,
            changedSessionCount: 2,
            reroutedSessionCount: 0,
            acceptingSessionCount: 1,
            maxJoinerEdgesPerSession: 1
        },
        longestPathHops: 3,
        change: { kind: 'attach' },
        heldReshapeReasons: []
    }
};

const RESHAPE_GATE: AdminRoomReshapeGate = {
    gate: { lastPassAtEpochMs: 1_700_000_000_500, consecutiveHeldPasses: 1, heldAtEpochMs: 1_700_000_000_900 },
    wantedReasons: ['kind-change'],
    intervalMs: 30_000,
    opensAtEpochMs: 1_700_000_030_500
};

const PAGE: AdminRoomTopologyPlansResponse = {
    roomRef: { applicationId: 'topology-churn', workspaceId: 'workspace-1', groupId: 'room-1' },
    observedAtEpochMs: 1_700_000_001_000,
    plans: [PLAN, { ...PLAN, publicationId: 'publication-2', plan: null }],
    nextAfterPublicationId: 'publication-2',
    reshapeGate: null
};

describe('decodeAdminRoomTopologyPlans', () => {
    it('decodes a page with a planned record, a removal without one and a cursor', () => {
        expect(decodeAdminRoomTopologyPlans(structuredClone(PAGE)).right).toEqual(PAGE);
    });

    it('decodes the last page, whose cursor is null', () => {
        const lastPage = { ...PAGE, plans: [], nextAfterPublicationId: null };

        expect(decodeAdminRoomTopologyPlans(lastPage).right).toEqual(lastPage);
    });

    it('rejects a page with a missing or an extra field', () => {
        const { nextAfterPublicationId: _cursor, ...withoutCursor } = PAGE;
        const { reshapeGate: _gate, ...withoutReshapeGate } = PAGE;

        expect(decodeAdminRoomTopologyPlans(withoutCursor).left).toBeDefined();
        expect(decodeAdminRoomTopologyPlans(withoutReshapeGate).left).toBeDefined();
        expect(decodeAdminRoomTopologyPlans({ ...PAGE, extra: true }).left).toBeDefined();
    });

    it('rejects an entry whose fields are not what the contract states', () => {
        const invalidEntries: readonly object[] = [
            { ...PLAN, topology: 'ring' },
            { ...PLAN, memberCount: -1 },
            { ...PLAN, publicationId: '' },
            { ...PLAN, layout: { version: 2 } },
            { ...PLAN, plan: { ...PLAN.plan, causes: ['unknown'] } },
            { ...PLAN, plan: { ...PLAN.plan, change: null } }
        ];

        for (const entry of invalidEntries) {
            expect(decodeAdminRoomTopologyPlans({ ...PAGE, plans: [entry] }).left).toBeDefined();
        }
    });

    it('rejects a room reference or cursor that is not a non-empty string', () => {
        expect(decodeAdminRoomTopologyPlans({ ...PAGE, roomRef: { applicationId: 'a', workspaceId: 'b' } }).left)
            .toBeDefined();
        expect(decodeAdminRoomTopologyPlans({ ...PAGE, nextAfterPublicationId: '' }).left).toBeDefined();
    });

    it('decodes the room\'s reshape gate, and a gate before the room\'s first reshape, which opens at no time', () => {
        const held = { ...PAGE, reshapeGate: RESHAPE_GATE };
        const beforeFirstReshape = {
            ...PAGE,
            reshapeGate: {
                gate: { lastPassAtEpochMs: null, consecutiveHeldPasses: 0, heldAtEpochMs: null },
                wantedReasons: [],
                intervalMs: 15_000,
                opensAtEpochMs: null
            }
        };

        expect(decodeAdminRoomTopologyPlans(structuredClone(held)).right).toEqual(held);
        expect(decodeAdminRoomTopologyPlans(beforeFirstReshape).right).toEqual(beforeFirstReshape);
    });

    it('rejects a reshape gate whose opening is not its last reshape plus the wait in force', () => {
        const invalidGates: readonly object[] = [
            { ...RESHAPE_GATE, opensAtEpochMs: RESHAPE_GATE.opensAtEpochMs! + 1 },
            { ...RESHAPE_GATE, opensAtEpochMs: null },
            { ...RESHAPE_GATE, gate: { ...RESHAPE_GATE.gate, lastPassAtEpochMs: null, heldAtEpochMs: null } },
            { ...RESHAPE_GATE, intervalMs: -1 },
            { ...RESHAPE_GATE, wantedReasons: ['join'] },
            { ...RESHAPE_GATE, extra: true },
            { gate: RESHAPE_GATE.gate, wantedReasons: RESHAPE_GATE.wantedReasons }
        ];

        for (const reshapeGate of invalidGates) {
            expect(decodeAdminRoomTopologyPlans({ ...PAGE, reshapeGate }).left).toBeDefined();
        }
    });
});
